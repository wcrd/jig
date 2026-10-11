//! The jork binary doubles as a `jj split` diff editor: jj hands it a `$left`
//! and `$right` directory and whatever is left in `$right` becomes the first
//! commit. A plan file says which files and hunks the user selected.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use bstr::ByteSlice;
use jj_lib::diff_presentation::LineCompareMode;
use jj_lib::diff_presentation::unified::{DiffLineType, unified_diff_hunks};
use jj_lib::merge::Diff;
use serde::{Deserialize, Serialize};

use crate::diff::CONTEXT_LINES;

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SplitPlan {
    pub files: HashMap<String, FileSelection>,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileSelection {
    /// Take the whole change to this file.
    #[serde(default)]
    pub all: bool,
    /// Otherwise, just these hunks (indices as the diff view numbers them).
    #[serde(default)]
    pub hunks: Vec<usize>,
    /// And parts of these hunks: hunk index to the indices, within the hunk's
    /// lines, of the added and removed lines to take.
    #[serde(default)]
    pub lines: HashMap<usize, Vec<usize>>,
}

/// What to take from each hunk of a file's change.
#[derive(Default, Debug, Clone)]
pub struct Selection {
    pub hunks: HashSet<usize>,
    pub lines: HashMap<usize, HashSet<usize>>,
}

impl Selection {
    fn is_empty(&self) -> bool {
        self.hunks.is_empty() && self.lines.values().all(HashSet::is_empty)
    }
}

impl From<&FileSelection> for Selection {
    fn from(s: &FileSelection) -> Self {
        Selection {
            hunks: s.hunks.iter().copied().collect(),
            lines: s
                .lines
                .iter()
                .map(|(h, lines)| (*h, lines.iter().copied().collect()))
                .collect(),
        }
    }
}

/// Binary files only support whole-file selection.
fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8192)].contains(&0)
}

/// `left` with only the `selected` hunks and lines of the change to `right`
/// applied. An unselected removed line stays; an unselected added line is
/// left out.
pub fn apply_hunks(left: &[u8], right: &[u8], selected: &Selection) -> Vec<u8> {
    let left_lines: Vec<&[u8]> = left.split_inclusive(|b| *b == b'\n').collect();
    let right_lines: Vec<&[u8]> = right.split_inclusive(|b| *b == b'\n').collect();
    let hunks = unified_diff_hunks(
        Diff::new(left.as_bstr(), right.as_bstr()),
        CONTEXT_LINES,
        LineCompareMode::Exact,
    );
    let mut out = Vec::with_capacity(left.len());
    let mut pos = 0;
    for (i, hunk) in hunks.iter().enumerate() {
        let l = &hunk.left_line_range;
        for line in &left_lines[pos..l.start] {
            out.extend_from_slice(line);
        }
        if selected.hunks.contains(&i) {
            for line in &right_lines[hunk.right_line_range.clone()] {
                out.extend_from_slice(line);
            }
        } else if let Some(picked) = selected.lines.get(&i) {
            let mut li = l.start;
            let mut ri = hunk.right_line_range.start;
            for (j, (kind, _)) in hunk.lines.iter().enumerate() {
                match kind {
                    DiffLineType::Context => {
                        out.extend_from_slice(left_lines[li]);
                        li += 1;
                        ri += 1;
                    }
                    DiffLineType::Removed => {
                        if !picked.contains(&j) {
                            out.extend_from_slice(left_lines[li]);
                        }
                        li += 1;
                    }
                    DiffLineType::Added => {
                        if picked.contains(&j) {
                            out.extend_from_slice(right_lines[ri]);
                        }
                        ri += 1;
                    }
                }
            }
        } else {
            for line in &left_lines[l.clone()] {
                out.extend_from_slice(line);
            }
        }
        pos = l.end;
    }
    for line in &left_lines[pos..] {
        out.extend_from_slice(line);
    }
    out
}

/// What a path holds in one of the trees.
#[derive(PartialEq, Eq)]
enum Entry {
    Absent,
    File(Vec<u8>, bool),
    Symlink(PathBuf),
}

fn read_entry(path: &Path) -> Result<Entry> {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Ok(Entry::Absent);
    };
    if meta.file_type().is_symlink() {
        return Ok(Entry::Symlink(fs::read_link(path)?));
    }
    let exec = meta.permissions().mode() & 0o111 != 0;
    Ok(Entry::File(
        fs::read(path).with_context(|| format!("read {}", path.display()))?,
        exec,
    ))
}

/// Relative paths (`/`-separated) of all files and symlinks under `dir`.
fn collect(root: &Path, dir: &Path, out: &mut BTreeSet<String>) -> Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect(root, &path, out)?;
        } else {
            let rel = path.strip_prefix(root)?;
            let parts: Vec<_> = rel.iter().map(|c| c.to_string_lossy()).collect();
            out.insert(parts.join("/"));
        }
    }
    Ok(())
}

fn remove_path(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path).is_ok() {
        fs::remove_file(path).with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}

fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

/// Makes `right_path` identical to the left entry.
fn restore(left: &Entry, left_path: &Path, right_path: &Path) -> Result<()> {
    remove_path(right_path)?;
    match left {
        Entry::Absent => {}
        Entry::Symlink(target) => {
            ensure_parent(right_path)?;
            std::os::unix::fs::symlink(target, right_path)?;
        }
        Entry::File(..) => {
            ensure_parent(right_path)?;
            // `fs::copy` preserves the permission bits.
            fs::copy(left_path, right_path)?;
        }
    }
    Ok(())
}

/// Removes directories under `dir` (not `dir` itself) that are empty.
fn prune_empty_dirs(dir: &Path) -> Result<bool> {
    let mut empty = true;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            if prune_empty_dirs(&entry.path())? {
                fs::remove_dir(entry.path())?;
            } else {
                empty = false;
            }
        } else {
            empty = false;
        }
    }
    Ok(empty)
}

/// Edits `right` so that it holds exactly the planned selection.
pub fn apply_plan(plan: &SplitPlan, left: &Path, right: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut paths = BTreeSet::new();
    collect(left, left, &mut paths)?;
    collect(right, right, &mut paths)?;
    paths.remove("JJ-INSTRUCTIONS");
    for rel in paths {
        let left_path = left.join(&rel);
        let right_path = right.join(&rel);
        let left_entry = read_entry(&left_path)?;
        let right_entry = read_entry(&right_path)?;
        if left_entry == right_entry {
            continue;
        }
        let selection = plan.files.get(&rel);
        if selection.is_some_and(|s| s.all) {
            continue;
        }
        let selected: Selection = selection.map(Selection::from).unwrap_or_default();
        // Partial selection needs text on both sides (or absent).
        let text_side = |e: &Entry| match e {
            Entry::Absent => true,
            Entry::File(bytes, _) => !is_binary(bytes),
            Entry::Symlink(_) => false,
        };
        if selected.is_empty() || !text_side(&left_entry) || !text_side(&right_entry) {
            restore(&left_entry, &left_path, &right_path)?;
            continue;
        }
        let empty = Vec::new();
        let bytes = |e: &'_ Entry| -> Vec<u8> {
            match e {
                Entry::File(b, _) => b.clone(),
                _ => empty.clone(),
            }
        };
        let result = apply_hunks(&bytes(&left_entry), &bytes(&right_entry), &selected);
        let one_side_absent = left_entry == Entry::Absent || right_entry == Entry::Absent;
        if result.is_empty() && one_side_absent {
            remove_path(&right_path)?;
        } else if right_entry == Entry::Absent {
            // A deletion that's only partly selected: recreate the file with
            // the left side's mode.
            ensure_parent(&right_path)?;
            fs::write(&right_path, &result)?;
            if let Entry::File(_, exec) = &left_entry {
                let mode = if *exec { 0o755 } else { 0o644 };
                fs::set_permissions(&right_path, fs::Permissions::from_mode(mode))?;
            }
        } else {
            fs::write(&right_path, &result)?;
        }
    }
    prune_empty_dirs(right)?;
    Ok(())
}

/// Entry point for `jork --split-plan <plan.json> <left> <right>`.
pub fn run(plan: &str, left: &str, right: &str) -> Result<()> {
    let text = fs::read_to_string(plan).with_context(|| format!("read {plan}"))?;
    let plan: SplitPlan = serde_json::from_str(&text).context("parse split plan")?;
    apply_plan(&plan, Path::new(left), Path::new(right))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sel(ids: &[usize]) -> Selection {
        Selection {
            hunks: ids.iter().copied().collect(),
            lines: HashMap::new(),
        }
    }

    fn sel_lines(hunk: usize, lines: &[usize]) -> Selection {
        Selection {
            hunks: HashSet::new(),
            lines: HashMap::from([(hunk, lines.iter().copied().collect())]),
        }
    }

    fn numbered(n: usize) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    /// Two changes far enough apart to be separate hunks.
    fn two_hunks() -> (String, String) {
        let left = numbered(30);
        let right = left
            .replace("line 3\n", "line 3 changed\n")
            .replace("line 27\n", "line 27 changed\n");
        (left, right)
    }

    #[test]
    fn none_and_all() {
        let (l, r) = two_hunks();
        assert_eq!(apply_hunks(l.as_bytes(), r.as_bytes(), &sel(&[])), l.as_bytes());
        assert_eq!(apply_hunks(l.as_bytes(), r.as_bytes(), &sel(&[0, 1])), r.as_bytes());
    }

    #[test]
    fn one_of_two() {
        let (l, r) = two_hunks();
        let first = apply_hunks(l.as_bytes(), r.as_bytes(), &sel(&[0]));
        assert_eq!(
            String::from_utf8(first).unwrap(),
            l.replace("line 3\n", "line 3 changed\n")
        );
        let second = apply_hunks(l.as_bytes(), r.as_bytes(), &sel(&[1]));
        assert_eq!(
            String::from_utf8(second).unwrap(),
            l.replace("line 27\n", "line 27 changed\n")
        );
    }

    #[test]
    fn insertions_and_deletions_shift_lines() {
        let left = numbered(30);
        let right = left
            .replace("line 2\n", "line 2\nnew a\nnew b\n")
            .replace("line 25\n", "");
        let only_second = apply_hunks(left.as_bytes(), right.as_bytes(), &sel(&[1]));
        assert_eq!(
            String::from_utf8(only_second).unwrap(),
            left.replace("line 25\n", "")
        );
        let only_first = apply_hunks(left.as_bytes(), right.as_bytes(), &sel(&[0]));
        assert_eq!(
            String::from_utf8(only_first).unwrap(),
            left.replace("line 2\n", "line 2\nnew a\nnew b\n")
        );
    }

    #[test]
    fn no_trailing_newline() {
        let mut left = numbered(30);
        left.pop();
        let mut right = left.replace("line 3\n", "line 3 changed\n");
        right.push_str(" edited");
        let first = apply_hunks(left.as_bytes(), right.as_bytes(), &sel(&[0]));
        assert_eq!(
            String::from_utf8(first).unwrap(),
            left.replace("line 3\n", "line 3 changed\n")
        );
        assert_eq!(
            apply_hunks(left.as_bytes(), right.as_bytes(), &sel(&[0, 1])),
            right.as_bytes()
        );
        assert_eq!(
            apply_hunks(left.as_bytes(), right.as_bytes(), &sel(&[])),
            left.as_bytes()
        );
    }

    /// One hunk replacing lines 4 and 5. Its lines are context 1–3 (0–2),
    /// `-line 4` (3), `-line 5` (4), `+four` (5), `+five` (6), context 6–8.
    fn replace_two() -> (String, String) {
        let left = numbered(10);
        let right = left.replace("line 4\nline 5\n", "four\nfive\n");
        (left, right)
    }

    #[test]
    fn single_lines() {
        let (l, r) = replace_two();
        let apply = |lines: &[usize]| {
            String::from_utf8(apply_hunks(l.as_bytes(), r.as_bytes(), &sel_lines(0, lines))).unwrap()
        };
        assert_eq!(apply(&[]), l);
        assert_eq!(apply(&[3, 4, 5, 6]), r);
        // Only the removal of line 4.
        assert_eq!(apply(&[3]), l.replace("line 4\n", ""));
        // Only the addition of "five".
        assert_eq!(apply(&[6]), l.replace("line 5\n", "line 5\nfive\n"));
        // Drop line 4 and add "four": additions follow the kept lines of
        // the block, as with `git add -p`.
        assert_eq!(apply(&[3, 5]), l.replace("line 4\nline 5\n", "line 5\nfour\n"));
    }

    #[test]
    fn lines_in_one_hunk_whole_other() {
        let (l, r) = two_hunks();
        // Hunk 0's lines: context 1–2 (0–1), `-line 3` (2), `+line 3 changed` (3).
        let selection = Selection {
            hunks: HashSet::from([1]),
            lines: HashMap::from([(0, HashSet::from([3]))]),
        };
        let out = String::from_utf8(apply_hunks(l.as_bytes(), r.as_bytes(), &selection)).unwrap();
        assert_eq!(
            out,
            l.replace("line 3\n", "line 3\nline 3 changed\n")
                .replace("line 27\n", "line 27 changed\n")
        );
    }

    #[test]
    fn added_and_removed_files() {
        assert_eq!(apply_hunks(b"", b"a\nb\n", &sel(&[0])), b"a\nb\n");
        assert_eq!(apply_hunks(b"", b"a\nb\n", &sel(&[])), b"");
        assert_eq!(apply_hunks(b"a\nb\n", b"", &sel(&[0])), b"");
        assert_eq!(apply_hunks(b"a\nb\n", b"", &sel(&[])), b"a\nb\n");
    }

    struct Dirs(PathBuf);
    impl Dirs {
        fn new(name: &str) -> Dirs {
            let d = std::env::temp_dir().join(format!("jork-split-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&d);
            fs::create_dir_all(d.join("left")).unwrap();
            fs::create_dir_all(d.join("right")).unwrap();
            Dirs(d)
        }
        fn put(&self, side: &str, rel: &str, content: &[u8]) {
            let p = self.0.join(side).join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, content).unwrap();
        }
        fn get(&self, side: &str, rel: &str) -> Option<Vec<u8>> {
            fs::read(self.0.join(side).join(rel)).ok()
        }
        fn apply(&self, plan: &str) {
            let plan: SplitPlan = serde_json::from_str(plan).unwrap();
            apply_plan(&plan, &self.0.join("left"), &self.0.join("right")).unwrap();
        }
    }
    impl Drop for Dirs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn directory_level() {
        use std::os::unix::fs::PermissionsExt;
        let d = Dirs::new("dir");
        let (l, r) = two_hunks();
        d.put("left", "keep.txt", b"same\n");
        d.put("right", "keep.txt", b"same\n");
        d.put("left", "partial.txt", l.as_bytes());
        d.put("right", "partial.txt", r.as_bytes());
        d.put("left", "all.txt", b"old\n");
        d.put("right", "all.txt", b"new\n");
        d.put("left", "unplanned.txt", b"old\n");
        d.put("right", "unplanned.txt", b"new\n");
        d.put("right", "sub/dir/added.txt", b"added\n");
        d.put("left", "gone.txt", b"gone\n");
        d.put("right", "added_partial.txt", b"x\ny\n");
        d.put("right", "JJ-INSTRUCTIONS", b"edit me\n");
        d.put("left", "bin.dat", b"a\0b");
        d.put("right", "bin.dat", b"a\0c");
        d.put("left", "tool.sh", b"#!/bin/sh\n");
        fs::set_permissions(d.0.join("left/tool.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        d.apply(
            r#"{"files":{
                "partial.txt":{"all":false,"hunks":[1]},
                "all.txt":{"all":true,"hunks":[]},
                "added_partial.txt":{"all":false,"hunks":[]},
                "bin.dat":{"all":false,"hunks":[0]}
            }}"#,
        );
        assert_eq!(d.get("right", "keep.txt").unwrap(), b"same\n");
        assert_eq!(
            String::from_utf8(d.get("right", "partial.txt").unwrap()).unwrap(),
            l.replace("line 27\n", "line 27 changed\n")
        );
        assert_eq!(d.get("right", "all.txt").unwrap(), b"new\n");
        assert_eq!(d.get("right", "unplanned.txt").unwrap(), b"old\n");
        assert!(d.get("right", "sub/dir/added.txt").is_none());
        assert!(!d.0.join("right/sub").exists(), "empty dirs are pruned");
        assert_eq!(d.get("right", "gone.txt").unwrap(), b"gone\n");
        assert!(d.get("right", "added_partial.txt").is_none());
        assert_eq!(d.get("right", "JJ-INSTRUCTIONS").unwrap(), b"edit me\n");
        assert_eq!(d.get("right", "bin.dat").unwrap(), b"a\0b");
        assert_eq!(d.get("right", "tool.sh").unwrap(), b"#!/bin/sh\n");
        let mode = fs::metadata(d.0.join("right/tool.sh")).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111);
    }

    #[test]
    fn line_plan_from_json() {
        let d = Dirs::new("lines");
        let (l, r) = replace_two();
        d.put("left", "f.txt", l.as_bytes());
        d.put("right", "f.txt", r.as_bytes());
        d.put("right", "new.txt", b"a\nb\nc\n");
        d.apply(r#"{"files":{"f.txt":{"all":false,"lines":{"0":[3,5]}},"new.txt":{"all":false,"lines":{"0":[0,2]}}}}"#);
        assert_eq!(
            String::from_utf8(d.get("right", "f.txt").unwrap()).unwrap(),
            l.replace("line 4\nline 5\n", "line 5\nfour\n")
        );
        assert_eq!(d.get("right", "new.txt").unwrap(), b"a\nc\n");
    }

    #[test]
    fn partial_added_file_and_symlink_restore() {
        let d = Dirs::new("added");
        d.put("right", "new.txt", b"x\ny\n");
        std::os::unix::fs::symlink("target", d.0.join("left/link")).unwrap();
        d.put("right", "link", b"now a file\n");
        d.apply(r#"{"files":{"new.txt":{"all":false,"hunks":[0]}}}"#);
        assert_eq!(d.get("right", "new.txt").unwrap(), b"x\ny\n");
        assert_eq!(
            fs::read_link(d.0.join("right/link")).unwrap(),
            PathBuf::from("target")
        );
    }
}
