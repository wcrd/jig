// Ancestry within the loaded graph, for previewing what a rebase moves.

import type { EdgeLayout } from "./types";

export class Relations {
  private parents: number[][];
  private children: number[][];

  constructor(rowCount: number, edges: EdgeLayout[]) {
    this.parents = Array.from({ length: rowCount }, () => []);
    this.children = Array.from({ length: rowCount }, () => []);
    for (const edge of edges) {
      if (edge.toRow === null || edge.kind === "missing") continue;
      this.parents[edge.fromRow].push(edge.toRow);
      this.children[edge.toRow].push(edge.fromRow);
    }
  }

  private walk(start: number[], next: number[][]): Set<number> {
    const seen = new Set<number>();
    const stack = [...start];
    while (stack.length > 0) {
      const row = stack.pop()!;
      if (seen.has(row)) continue;
      seen.add(row);
      stack.push(...next[row]);
    }
    return seen;
  }

  /** A row's parents shown in the graph, first parent first. */
  parentsOf(row: number): number[] {
    return this.parents[row] ?? [];
  }

  /** The rows and all their descendants shown in the graph. */
  descendants(rows: number[]): Set<number> {
    return this.walk(rows, this.children);
  }

  /** The rows and all their ancestors shown in the graph. */
  ancestors(rows: number[]): Set<number> {
    return this.walk(rows, this.parents);
  }

  /**
   * What `jj rebase -b` moves: the rows' ancestors that aren't ancestors of
   * the destination, plus all their descendants.
   */
  branch(rows: number[], destination: number): Set<number> {
    const base = this.ancestors([destination]);
    const roots = [...this.ancestors(rows)].filter((r) => !base.has(r));
    return this.descendants(roots);
  }
}
