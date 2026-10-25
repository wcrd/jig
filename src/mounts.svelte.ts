// Hosts for components inside RepoView while it's still a class: each mounts
// a component into an element and holds its props as state, so setting a
// field updates the component. Server data is $state.raw: it's replaced
// whole, never changed in place, so it needn't be made deeply reactive.

import { mount } from "svelte";

import OpLog from "./components/OpLog.svelte";
import Sidebar from "./components/Sidebar.svelte";
import type { SidebarCallbacks } from "./sidebar";
import type { CommandOutput, LogResponse, Sidebar as SidebarData } from "./types";

export class SidebarHost {
  data = $state.raw<SidebarData | null>(null);
  name = $state("");
  log = $state.raw<LogResponse | null>(null);
  selectedCommit = $state<string | null>(null);

  constructor(target: HTMLElement, name: string, callbacks: SidebarCallbacks) {
    this.name = name;
    const host = this;
    mount(Sidebar, {
      target,
      props: {
        get data() {
          return host.data;
        },
        get name() {
          return host.name;
        },
        get workspaceName() {
          return host.log?.workspaceName ?? null;
        },
        get workspaceRoot() {
          return host.log?.workspaceRoot ?? null;
        },
        get selectedCommit() {
          return host.selectedCommit;
        },
        ...callbacks,
      },
    });
  }
}

export class OpLogHost {
  private view: { refresh(): Promise<void> };

  constructor(
    private el: HTMLElement,
    path: string,
    act: (label: string, run: () => Promise<CommandOutput>) => Promise<unknown>,
    private onToggle: (visible: boolean) => void,
    /** Jump to a commit in the graph. */
    showCommit: (commitId: string) => void,
  ) {
    this.view = mount(OpLog, { target: el, props: { path, act, showCommit, close: () => this.hide() } });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  async show() {
    this.el.hidden = false;
    this.onToggle(true);
    await this.refresh();
  }

  hide() {
    this.el.hidden = true;
    this.onToggle(false);
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  async refresh() {
    if (this.visible) await this.view.refresh();
  }
}
