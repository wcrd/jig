//! Lane layout for the commit graph:
//!
//! - Every edge owns a single lane from its child's row down to its parent's
//!   row. Lanes never shift sideways mid-edge, so lines stay straight and only
//!   bend at the commits they connect.
//! - A commit continues its first parent in its own lane; other parents get a
//!   fresh lane. Lines from several children converge on a commit at its row.
//! - Freed lanes are reused leftmost-first, keeping the graph compact. That
//!   includes lanes that end at a commit being reused by its other parents in
//!   the same row, so merges don't loop out to the far right.
//! - When a trunk is given, lane 0 is reserved for its first-parent chain so
//!   trunk is always a straight line down the left edge.
//!
//! Colours are not assigned here: the renderer colours by lane index.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    /// The parent is shown in the graph.
    Direct,
    /// An ancestor is shown, with commits elided in between.
    Indirect,
    /// No ancestor along this edge is shown.
    Missing,
}

pub struct NodeInput<K> {
    pub id: K,
    /// Parents in order (first parent first).
    pub edges: Vec<(K, EdgeKind)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RowLayout {
    /// Lane of the commit's node.
    pub lane: u32,
    /// Number of lanes occupied in this row, used to place the text after the
    /// graph.
    pub width: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeLayout {
    pub from_row: u32,
    /// Lane of the child node.
    pub from_lane: u32,
    /// Lane the edge runs down between its rows.
    pub lane: u32,
    /// Row of the parent node. `None` if the parent is not in the graph: a
    /// `Missing` edge is drawn as a short stub, anything else runs off the
    /// bottom (the list was truncated).
    pub to_row: Option<u32>,
    /// Lane of the parent node.
    pub to_lane: u32,
    pub kind: EdgeKind,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub rows: Vec<RowLayout>,
    pub edges: Vec<EdgeLayout>,
    pub max_width: u32,
}

struct Lanes {
    slots: Vec<bool>,
}

impl Lanes {
    fn alloc(&mut self, min: usize) -> usize {
        let index = (min..self.slots.len())
            .find(|&i| !self.slots[i])
            .unwrap_or_else(|| self.slots.len().max(min));
        if index >= self.slots.len() {
            self.slots.resize(index + 1, false);
        }
        self.slots[index] = true;
        index
    }

    fn take(&mut self, index: usize) {
        if index >= self.slots.len() {
            self.slots.resize(index + 1, false);
        }
        self.slots[index] = true;
    }

    fn free(&mut self, index: usize) {
        self.slots[index] = false;
        while self.slots.last() == Some(&false) {
            self.slots.pop();
        }
    }

    fn width(&self) -> usize {
        self.slots.iter().rposition(|&used| used).map_or(0, |i| i + 1)
    }
}

/// Whether following first parents from `from` through the graph reaches
/// `to` (both must be shown; elided stretches count as first parents).
pub fn first_parent_line_reaches<K: Eq + Hash + Clone>(nodes: &[NodeInput<K>], from: &K, to: &K) -> bool {
    let row_of: HashMap<&K, usize> = nodes.iter().enumerate().map(|(i, n)| (&n.id, i)).collect();
    let mut cursor = row_of.get(from).copied();
    while let Some(row) = cursor {
        if &nodes[row].id == to {
            return true;
        }
        cursor = nodes[row]
            .edges
            .first()
            .filter(|(_, kind)| *kind != EdgeKind::Missing)
            .and_then(|(target, _)| row_of.get(target).copied())
            .filter(|&target| target > row);
    }
    false
}

/// Lays out `nodes`, which must be in topological order (children first).
/// `trunk` is the head of the chain to pin to lane 0, if any.
pub fn layout<K: Eq + Hash + Clone>(nodes: &[NodeInput<K>], trunk: Option<&K>) -> Layout {
    let row_of: HashMap<&K, usize> = nodes.iter().enumerate().map(|(i, n)| (&n.id, i)).collect();

    let mut spine = HashSet::new();
    let mut cursor = trunk.and_then(|id| row_of.get(id).copied());
    while let Some(row) = cursor {
        if !spine.insert(row) {
            break;
        }
        cursor = nodes[row]
            .edges
            .first()
            .filter(|(_, kind)| *kind != EdgeKind::Missing)
            .and_then(|(target, _)| row_of.get(target).copied())
            .filter(|&target| target > row);
    }
    let min_lane = if spine.is_empty() { 0 } else { 1 };

    let mut lanes = Lanes { slots: vec![] };
    let mut layout = Layout::default();
    // Edges waiting for their parent row, with whether each is its child's
    // first parent.
    let mut pending: HashMap<usize, Vec<(usize, bool)>> = HashMap::new();

    for (row, node) in nodes.iter().enumerate() {
        let incoming = pending.remove(&row).unwrap_or_default();

        let lane = if spine.contains(&row) {
            lanes.take(0);
            0
        } else {
            let first_parent = incoming
                .iter()
                .filter(|(_, first)| *first)
                .map(|&(edge, _)| layout.edges[edge].lane as usize)
                .min();
            let any = incoming
                .iter()
                .map(|&(edge, _)| layout.edges[edge].lane as usize)
                .min();
            match first_parent.or(any) {
                Some(lane) => lane,
                None => lanes.alloc(min_lane),
            }
        };

        for &(edge, _) in &incoming {
            let edge = &mut layout.edges[edge];
            edge.to_row = Some(row as u32);
            edge.to_lane = lane as u32;
        }

        // Lanes in use on this row include the incoming ones about to end.
        let incoming_width = lanes.width();
        for &(edge, _) in &incoming {
            let edge_lane = layout.edges[edge].lane as usize;
            if edge_lane != lane {
                lanes.free(edge_lane);
            }
        }

        let mut continues = false;
        let mut seen = HashSet::new();
        for (target, kind) in &node.edges {
            if !seen.insert(target) {
                continue;
            }
            let target_row = row_of.get(target).copied().filter(|&t| t > row);
            let kind = *kind;

            if kind == EdgeKind::Missing {
                layout.edges.push(EdgeLayout {
                    from_row: row as u32,
                    from_lane: lane as u32,
                    lane: lane as u32,
                    to_row: None,
                    to_lane: lane as u32,
                    kind,
                });
                continue;
            }

            let edge_lane = if !continues {
                continues = true;
                lane
            } else {
                lanes.alloc(min_lane)
            };
            let index = layout.edges.len();
            layout.edges.push(EdgeLayout {
                from_row: row as u32,
                from_lane: lane as u32,
                lane: edge_lane as u32,
                to_row: None,
                to_lane: edge_lane as u32,
                kind,
            });
            if let Some(target_row) = target_row {
                pending
                    .entry(target_row)
                    .or_default()
                    .push((index, edge_lane == lane));
            }
        }

        let width = lanes.width().max(incoming_width).max(lane + 1);

        if !continues && lanes.slots.get(lane) == Some(&true) {
            lanes.free(lane);
        }

        layout.rows.push(RowLayout {
            lane: lane as u32,
            width: width as u32,
        });
        layout.max_width = layout.max_width.max(width as u32);
    }

    layout
}

#[cfg(test)]
mod tests {
    use super::*;
    use EdgeKind::*;

    fn node(id: &'static str, parents: &[&'static str]) -> NodeInput<&'static str> {
        NodeInput {
            id,
            edges: parents.iter().map(|p| (*p, Direct)).collect(),
        }
    }

    fn lanes(layout: &Layout) -> Vec<u32> {
        layout.rows.iter().map(|r| r.lane).collect()
    }

    #[test]
    fn linear_history_is_one_straight_lane() {
        let nodes = [node("c", &["b"]), node("b", &["a"]), node("a", &[])];
        let layout = layout(&nodes, None);
        assert_eq!(lanes(&layout), [0, 0, 0]);
        assert_eq!(layout.max_width, 1);
        assert!(layout.edges.iter().all(|e| e.lane == 0));
    }

    #[test]
    fn sibling_branches_converge_on_their_fork_point() {
        // b and c both branch from a.
        let nodes = [node("c", &["a"]), node("b", &["a"]), node("a", &[])];
        let layout = layout(&nodes, None);
        assert_eq!(lanes(&layout), [0, 1, 0]);
        // b's line stays in lane 1 until a's row, then bends into lane 0.
        let b_edge = &layout.edges[1];
        assert_eq!((b_edge.lane, b_edge.to_row, b_edge.to_lane), (1, Some(2), 0));
        assert_eq!(layout.rows[2].width, 2);
    }

    #[test]
    fn merge_gets_a_new_lane_for_its_second_parent() {
        // m merges x into main; x branched from a.
        let nodes = [
            node("m", &["b", "x"]),
            node("x", &["a"]),
            node("b", &["a"]),
            node("a", &[]),
        ];
        let layout = layout(&nodes, None);
        assert_eq!(lanes(&layout), [0, 1, 0, 0]);
        assert_eq!(layout.edges[1].lane, 1);
        assert_eq!(layout.rows.iter().map(|r| r.width).collect::<Vec<_>>(), [2, 2, 2, 2]);
    }

    #[test]
    fn trunk_is_pinned_to_lane_zero() {
        // Working-copy stack w2 -> w1 sits on top of trunk t2 -> t1.
        let nodes = [
            node("w2", &["w1"]),
            node("w1", &["t2"]),
            node("t2", &["t1"]),
            node("t1", &[]),
        ];
        let layout = layout(&nodes, Some(&"t2"));
        assert_eq!(lanes(&layout), [1, 1, 0, 0]);
        let unpinned = super::layout(&nodes, None);
        assert_eq!(lanes(&unpinned), [0, 0, 0, 0]);
    }

    #[test]
    fn lanes_ending_at_a_merge_are_reused_by_its_other_parents() {
        // b's lane ends at a, and a's second parent takes it over.
        let nodes = [
            node("c", &["a"]),
            node("b", &["a"]),
            node("a", &["p", "q"]),
            node("q", &["p"]),
            node("p", &[]),
        ];
        let layout = layout(&nodes, None);
        assert_eq!(lanes(&layout), [0, 1, 0, 1, 0]);
        assert_eq!(layout.rows[2].width, 2);
        // Lanes freed earlier are reused by new heads too.
        let nodes = [
            node("c", &["a"]),
            node("b", &["a"]),
            node("a", &["p"]),
            node("d", &["p"]),
            node("p", &[]),
        ];
        assert_eq!(lanes(&super::layout(&nodes, None)), [0, 1, 0, 1, 0]);
    }

    #[test]
    fn working_copy_line_through_trunk() {
        // @ -> w1 -> t2 (trunk) -> t1, plus a side branch s on t2.
        let nodes = [
            node("@", &["w1"]),
            node("s", &["t2"]),
            node("w1", &["t2"]),
            node("t2", &["t1"]),
            node("t1", &[]),
        ];
        assert!(first_parent_line_reaches(&nodes, &"@", &"t2"));
        assert!(!first_parent_line_reaches(&nodes, &"t1", &"t2"));
        // Pinning from @ keeps @, w1 and trunk in one straight column.
        let layout = layout(&nodes, Some(&"@"));
        assert_eq!(lanes(&layout), [0, 1, 0, 0, 0]);
    }

    #[test]
    fn missing_and_truncated_edges() {
        let nodes = [
            NodeInput { id: "b", edges: vec![("a", Indirect)] },
            NodeInput { id: "a", edges: vec![("root", Missing)] },
            NodeInput { id: "z", edges: vec![("beyond", Direct)] },
        ];
        let layout = layout(&nodes, None);
        assert_eq!(layout.edges[0].kind, Indirect);
        assert_eq!(layout.edges[0].to_row, Some(1));
        assert_eq!((layout.edges[1].kind, layout.edges[1].to_row), (Missing, None));
        // The truncated edge keeps its lane and has no end row.
        assert_eq!((layout.edges[2].kind, layout.edges[2].to_row), (Direct, None));
    }
}
