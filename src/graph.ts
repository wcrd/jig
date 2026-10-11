// Draws the commit graph: thin lane-coloured lines that leave and
// enter commits horizontally through rounded corners.
//
// Each row carries its own small SVG showing its slice of the graph, so the
// graph scrolls natively with the text and is rendered as vectors at the
// display's full resolution. Edges are built once as whole paths in list
// coordinates; a row's SVG views its 25px band of them, which also keeps dash
// patterns continuous across rows.

import type { EdgeLayout, LogRow } from "./types";

export const ROW_HEIGHT = 25;
export const LANE_WIDTH = 12;
const LANE_X0 = 16;
const LANE_COLORS = 10;

/** Normal corner radius where a line bends between a lane and a commit. */
const CORNER = 11;
/** Line width in CSS pixels, before rounding to whole device pixels. */
const LINE_WIDTH = 1.5;

/**
 * Line width and grid offset for the current display, chosen so lines are a
 * whole number of device pixels wide with edges on pixel boundaries.
 */
class Grid {
  readonly lineWidth: number;
  private readonly offset: number;

  constructor(readonly dpr: number) {
    const device = Math.max(1, Math.round(LINE_WIDTH * dpr));
    this.lineWidth = device / dpr;
    // Odd widths are centred on a pixel centre, even ones on a boundary.
    this.offset = (device % 2) / 2 / dpr;
  }

  laneX(lane: number): number {
    return LANE_X0 + lane * LANE_WIDTH + this.offset;
  }

  rowY(row: number): number {
    return row * ROW_HEIGHT + Math.floor(ROW_HEIGHT / 2) + this.offset;
  }
}

/** Where a row's text starts: just past the last lane in use on that row. */
export function textX(width: number): number {
  return LANE_X0 + width * LANE_WIDTH - 2;
}

export function laneColor(lane: number): string {
  return `var(--lane-${lane % LANE_COLORS})`;
}

const f = (n: number) => +n.toFixed(2);

export class Graph {
  private grid: Grid;
  private edgePaths: string[] = [];
  /** For each row, the edges that pass through it. */
  private rowEdges: number[][] = [];

  constructor(
    private rows: LogRow[],
    private edges: EdgeLayout[],
  ) {
    this.grid = new Grid(window.devicePixelRatio || 1);
    this.build();
  }

  /** Rebuilds for a new device pixel ratio (e.g. moving between displays). */
  setDpr(dpr: number) {
    if (dpr === this.grid.dpr) return;
    this.grid = new Grid(dpr);
    this.build();
  }

  private build() {
    this.edgePaths = this.edges.map((edge) => this.edgePath(edge));
    this.rowEdges = this.rows.map(() => []);
    const lastRow = this.rows.length - 1;
    this.edges.forEach((edge, index) => {
      // A missing-parent stub reaches into the next row.
      const end = edge.kind === "missing" ? edge.fromRow + 1 : (edge.toRow ?? lastRow);
      for (let row = edge.fromRow; row <= Math.min(end, lastRow); row++) {
        this.rowEdges[row].push(index);
      }
    });
  }

  /** The SVG for one row's slice of the graph. */
  rowSvg(index: number): string {
    const row = this.rows[index];
    const width = textX(row.width);
    const top = index * ROW_HEIGHT;
    let body = "";
    for (const edgeIndex of this.rowEdges[index]) {
      const edge = this.edges[edgeIndex];
      const dash = edge.kind === "direct" ? "" : ` stroke-dasharray="2 3"`;
      const fade = edge.kind === "missing" ? ` stroke-opacity="0.45"` : "";
      body += `<path d="${this.edgePaths[edgeIndex]}" style="stroke:${laneColor(edge.lane)}"${dash}${fade}/>`;
    }
    body += this.nodeSvg(row, index);
    return (
      `<svg class="row-graph" width="${width}" height="${ROW_HEIGHT}" viewBox="0 ${top} ${width} ${ROW_HEIGHT}" ` +
      `fill="none" stroke-width="${f(this.grid.lineWidth)}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
    );
  }

  private edgePath(edge: EdgeLayout): string {
    const g = this.grid;
    const x0 = g.laneX(edge.fromLane);
    const xe = g.laneX(edge.lane);
    const y0 = g.rowY(edge.fromRow);

    if (edge.kind === "missing") {
      // A short stub below the commit: its ancestors aren't shown.
      return `M${f(x0)} ${f(y0)}V${f(y0 + ROW_HEIGHT * 0.7)}`;
    }

    const toRow = edge.toRow;
    const xt = g.laneX(edge.toLane);
    const y1 = toRow === null ? this.rows.length * ROW_HEIGHT : g.rowY(toRow);
    const bendsOut = xe !== x0;
    const bendsIn = toRow !== null && xt !== xe;

    // Every bend uses the same tight corner, so lines converging on a commit
    // look alike however far they've come.
    let rOut = bendsOut ? Math.min(Math.abs(xe - x0), CORNER) : 0;
    let rIn = bendsIn ? Math.min(Math.abs(xt - xe), CORNER) : 0;
    const span = y1 - y0;
    if (rOut + rIn > span) {
      const scale = span / (rOut + rIn);
      rOut *= scale;
      rIn *= scale;
    }

    let d = `M${f(x0)} ${f(y0)}`;
    if (bendsOut) {
      // Horizontal out of the commit, then a quarter turn down into the lane.
      const right = xe > x0;
      d += `H${f(xe - (right ? rOut : -rOut))}A${f(rOut)} ${f(rOut)} 0 0 ${right ? 1 : 0} ${f(xe)} ${f(y0 + rOut)}`;
    }
    if (bendsIn) {
      // Down the lane, then a quarter turn into the parent horizontally.
      const left = xt < xe;
      d += `V${f(y1 - rIn)}A${f(rIn)} ${f(rIn)} 0 0 ${left ? 1 : 0} ${f(xe + (left ? -rIn : rIn))} ${f(y1)}H${f(xt)}`;
    } else {
      d += `V${f(y1)}`;
    }
    return d;
  }

  private nodeSvg(row: LogRow, index: number): string {
    const x = f(this.grid.laneX(row.lane));
    const y = f(this.grid.rowY(index));
    const color = laneColor(row.lane);
    const bg = "var(--node-bg)";

    if (row.conflict) {
      const k = 2.2;
      return (
        `<circle cx="${x}" cy="${y}" r="5.5" style="fill:${bg};stroke:var(--conflict)"/>` +
        `<path d="M${f(x - k)} ${f(y - k)}l${2 * k} ${2 * k}m0 ${-2 * k}l${-2 * k} ${2 * k}" style="stroke:var(--conflict)"/>`
      );
    }
    if (row.isWorkingCopy) {
      // A target: ring plus centre dot.
      return (
        `<circle cx="${x}" cy="${y}" r="5.75" stroke-width="2" style="fill:${bg};stroke:${color}"/>` +
        `<circle cx="${x}" cy="${y}" r="2.5" style="fill:${color}" stroke="none"/>`
      );
    }
    if (row.parentCount > 1) {
      // Merges: a ring with a six-pointed star, hollow when mutable and filled
      // (with the star cut out) when immutable, like other commits.
      const [ring, star] = row.immutable ? [color, bg] : [bg, color];
      const r = 2.6;
      let d = "";
      for (let i = 0; i < 3; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 2;
        const dx = r * Math.cos(a);
        const dy = r * Math.sin(a);
        d += `M${f(+x + dx)} ${f(+y + dy)}L${f(+x - dx)} ${f(+y - dy)}`;
      }
      return (
        `<circle cx="${x}" cy="${y}" r="6" style="fill:${ring};stroke:${color}"/>` +
        `<path d="${d}" stroke-width="1.2" style="stroke:${star}"/>`
      );
    }
    if (row.immutable) {
      return `<circle cx="${x}" cy="${y}" r="3.25" style="fill:${color}" stroke="none"/>`;
    }
    // Mutable commits are hollow, like jj's ○.
    return `<circle cx="${x}" cy="${y}" r="3.5" style="fill:${bg};stroke:${color}"/>`;
  }
}
