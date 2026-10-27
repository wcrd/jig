// A small find bar (⌘F) that floats over the area being searched.

import { mount, unmount } from "svelte";

import SearchBarView from "./components/SearchBar.svelte";

export interface SearchTarget {
  /** Applies a query; returns how many matches there are. */
  setQuery(query: string): number;
  /** Moves to the next or previous match; returns its 1-based position. */
  step(delta: 1 | -1): number;
  clear(): void;
}

export class SearchBar {
  private view: ReturnType<typeof SearchBarView> | null = null;
  private target: SearchTarget | null = null;
  private state = $state({ query: "" });

  /** Opens the bar over `host`, searching `target`. */
  open(host: HTMLElement, target: SearchTarget) {
    if (this.target && this.target !== target) this.target.clear();
    if (this.view) unmount(this.view);
    this.target = target;
    const state = this.state;
    this.view = mount(SearchBarView, {
      target: host,
      props: {
        target,
        get query() {
          return state.query;
        },
        set query(value) {
          state.query = value;
        },
        close: () => this.close(),
      },
    });
  }

  close() {
    this.target?.clear();
    this.target = null;
    if (this.view) unmount(this.view);
    this.view = null;
  }

  get isOpen(): boolean {
    return this.view !== null;
  }
}
