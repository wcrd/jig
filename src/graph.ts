// Draws the commit graph onto a canvas: thin lane-coloured lines
// that leave and enter commits horizontally through rounded corners.

import type { EdgeLayout, LogRow } from "./types";

export const ROW_HEIGHT = 25;
export const LANE_WIDTH = 12;
/** x of lane 0's centre. */
export const LANE_X0 = 16;

/** Normal corner radius where a line bends between a lane and a commit. */
const CORNER = 11;
const LINE_WIDTH = 1.6;

export function laneX(lane: number): number {
  return LANE_X0 + lane * LANE_WIDTH;
}

/** Where a row's text starts: just past the last lane in use on that row. */
export function textX(width: number): number {
  return LANE_X0 + width * LANE_WIDTH - 2;
}

function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

export interface Palette {
  lanes: string[];
  background: string;
  conflict: string;
}

export function laneColor(palette: Palette, lane: number): string {
  return palette.lanes[lane % palette.lanes.length];
}

export function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const lanes: string[] = [];
  for (let i = 0; ; i++) {
    const value = style.getPropertyValue(`--lane-${i}`).trim();
    if (!value) break;
    lanes.push(value);
  }
  return {
    lanes,
    background: style.getPropertyValue("--bg").trim(),
    conflict: style.getPropertyValue("--conflict").trim(),
  };
}

export interface Viewport {
  scrollTop: number;
  width: number;
  height: number;
}

/**
 * Snaps graph coordinates to the device pixel grid. Lines are a whole number
 * of device pixels wide, and centred so their edges fall on pixel boundaries,
 * which keeps them sharp on Retina displays instead of smeared across two
 * pixels.
 */
class Pixels {
  readonly lineWidth: number;
  readonly nodeStroke: number;
  private offset: number;

  constructor(readonly dpr: number) {
    const device = Math.max(1, Math.round(LINE_WIDTH * dpr));
    this.lineWidth = device / dpr;
    this.nodeStroke = device / dpr;
    // Odd widths need centres on pixel centres; even ones on boundaries.
    this.offset = (device % 2) / 2;
  }

  snap(value: number): number {
    return (Math.round(value * this.dpr - this.offset) + this.offset) / this.dpr;
  }

  x(lane: number): number {
    return this.snap(laneX(lane));
  }

  y(row: number): number {
    return this.snap(rowY(row));
  }
}

export function drawGraph(
  canvas: HTMLCanvasElement,
  rows: LogRow[],
  edges: EdgeLayout[],
  palette: Palette,
  view: Viewport,
) {
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(view.width * dpr);
  const pixelHeight = Math.round(view.height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${view.width}px`;
    canvas.style.height = `${view.height}px`;
  }

  const ctx = canvas.getContext("2d")!;
  // Scroll by whole device pixels so snapped coordinates stay snapped.
  const scrollPixels = Math.round(view.scrollTop * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, -scrollPixels);
  ctx.clearRect(0, scrollPixels / dpr, view.width, view.height);
  const px = new Pixels(dpr);

  const first = Math.floor(view.scrollTop / ROW_HEIGHT) - 1;
  const last = Math.ceil((view.scrollTop + view.height) / ROW_HEIGHT) + 1;
  const bottom = rows.length * ROW_HEIGHT;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const edge of edges) {
    if (edge.fromRow > last) continue;
    if (edge.toRow !== null && edge.toRow < first) continue;
    if (edge.toRow === null && edge.kind === "missing" && edge.fromRow < first) continue;
    drawEdge(ctx, px, edge, laneColor(palette, edge.lane), bottom);
  }

  const end = Math.min(last, rows.length - 1);
  for (let i = Math.max(first, 0); i <= end; i++) {
    drawNode(ctx, px, rows[i], i, palette);
  }
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  px: Pixels,
  edge: EdgeLayout,
  color: string,
  bottom: number,
) {
  const x0 = px.x(edge.fromLane);
  const xe = px.x(edge.lane);
  const y0 = px.y(edge.fromRow);

  ctx.lineWidth = px.lineWidth;

  ctx.strokeStyle = color;
  ctx.setLineDash(edge.kind === "direct" ? [] : [2, 3]);

  if (edge.kind === "missing") {
    // A short stub fading out below the commit: its ancestors aren't shown.
    const gradient = ctx.createLinearGradient(0, y0, 0, y0 + ROW_HEIGHT * 0.7);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, "transparent");
    ctx.strokeStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y0 + ROW_HEIGHT * 0.7);
    ctx.stroke();
    return;
  }

  const toRow = edge.toRow;
  const xt = px.x(edge.toLane);
  const y1 = toRow === null ? bottom : px.y(toRow);
  const adjacent = toRow !== null && toRow === edge.fromRow + 1;

  const bendsOut = xe !== x0;
  const bendsIn = toRow !== null && xt !== xe;

  // Corners are tight, except a single bend between adjacent rows sweeps the
  // whole row, like a line from a branch's first commit to its base.
  let rOut = bendsOut ? Math.min(Math.abs(xe - x0), adjacent && !bendsIn ? ROW_HEIGHT : CORNER) : 0;
  let rIn = bendsIn ? Math.min(Math.abs(xt - xe), adjacent && !bendsOut ? ROW_HEIGHT : CORNER) : 0;
  const span = y1 - y0;
  if (rOut + rIn > span) {
    const scale = span / (rOut + rIn);
    rOut *= scale;
    rIn *= scale;
  }

  ctx.beginPath();
  ctx.moveTo(x0, y0);
  if (bendsOut) {
    ctx.arcTo(xe, y0, xe, y0 + rOut, rOut);
  }
  if (bendsIn) {
    ctx.lineTo(xe, y1 - rIn);
    ctx.arcTo(xe, y1, xt, y1, rIn);
    ctx.lineTo(xt, y1);
  } else {
    ctx.lineTo(xe, y1);
  }
  ctx.stroke();
}

function drawNode(ctx: CanvasRenderingContext2D, px: Pixels, row: LogRow, index: number, palette: Palette) {
  const x = px.x(row.lane);
  const y = px.y(index);
  const color = laneColor(palette, row.lane);
  ctx.setLineDash([]);
  ctx.lineWidth = px.nodeStroke;

  const circle = (r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  };

  if (row.conflict) {
    circle(5.5);
    ctx.fillStyle = palette.background;
    ctx.fill();
    ctx.strokeStyle = palette.conflict;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 2.2, y - 2.2);
    ctx.lineTo(x + 2.2, y + 2.2);
    ctx.moveTo(x + 2.2, y - 2.2);
    ctx.lineTo(x - 2.2, y + 2.2);
    ctx.stroke();
  } else if (row.isWorkingCopy) {
    // A target: ring plus centre dot.
    circle(5.75);
    ctx.fillStyle = palette.background;
    ctx.fill();
    ctx.lineWidth = Math.round(2 * px.dpr) / px.dpr;
    ctx.strokeStyle = color;
    ctx.stroke();
    circle(2.5);
    ctx.fillStyle = color;
    ctx.fill();
  } else if (row.parentCount > 1) {
    // Merges: a ring with a chevron.
    circle(6);
    ctx.fillStyle = palette.background;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 2.4, y - 1);
    ctx.lineTo(x, y + 1.4);
    ctx.lineTo(x + 2.4, y - 1);
    ctx.stroke();
  } else if (row.immutable) {
    circle(3.25);
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    // Mutable commits are hollow, like jj's ○.
    circle(3.5);
    ctx.fillStyle = palette.background;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}
