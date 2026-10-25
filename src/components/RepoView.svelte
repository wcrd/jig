<!--
  One open repository: its toolbar, sidebar, graph and details panel, and
  the operation log and conflict resolver that take over from them. Repo
  holds the state and commands; the graph's rows are drawn by Repo itself,
  only those in view.
-->
<script lang="ts">
  import { jj } from "../api";
  import type { Repo } from "../repo.svelte";
  import { showSettings } from "../settings";
  import { showHelp } from "../ui";
  import Details from "./Details.svelte";
  import Modebar from "./Modebar.svelte";
  import OpLog from "./OpLog.svelte";
  import Resolve from "./Resolve.svelte";
  import Sidebar from "./Sidebar.svelte";

  let { repo }: { repo: Repo } = $props();

  const PRESETS: [string, string][] = [
    ["", "Default"],
    ["all()", "All"],
    ["trunk() | bookmarks() | remote_bookmarks() | tags() | @ | ::@ ~ ::trunk()", "Bookmarks"],
    ["mine()", "Mine"],
  ];
  const preset = $derived(PRESETS.some(([value]) => value === repo.revset) ? repo.revset : "custom");

  function revsetKey(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (event.key === "Enter") {
      repo.applyRevset(event.currentTarget.value);
      event.currentTarget.value = repo.revset;
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.currentTarget.value = repo.revset;
      event.currentTarget.blur();
    }
  }
</script>

<header class="toolbar">
  <button data-ref="fetch" class="tool-button" title="Fetch from remotes (jj git fetch)" onclick={() => repo.fetch()}>
    <svg viewBox="0 0 16 16" width="14" height="14"
      ><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg
    >
    <span>Fetch</span>
  </button>
  <button data-ref="push" class="tool-button" title="Push bookmarks (jj git push)" onclick={(event) => repo.push(event.currentTarget)}>
    <svg viewBox="0 0 16 16" width="14" height="14"
      ><path d="M8 13.5v-8M4.5 8.5L8 5l3.5 3.5M3 2.5h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg
    >
    <span>Push</span>
  </button>
  <div class="toolbar-gap"></div>
  <div class="revset">
    <select data-ref="revset-preset" title="Revset presets" value={preset} onchange={(event) => event.currentTarget.value !== "custom" && repo.applyRevset(event.currentTarget.value)}>
      {#each PRESETS as [value, label] (value)}
        <option {value}>{label}</option>
      {/each}
      <option value="custom" hidden>Custom</option>
    </select>
    <input
      data-ref="revset-input"
      spellcheck="false"
      autocapitalize="off"
      autocorrect="off"
      autocomplete="off"
      placeholder={repo.defaultRevset || "revset"}
      title="Revset (⌘L)"
      value={repo.revset}
      onkeydown={revsetKey}
    />
  </div>
  <button data-ref="refresh" class="icon-button" title="Reload (⌘R)" onclick={() => repo.refresh()}>
    <svg viewBox="0 0 16 16" width="14" height="14"
      ><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg
    >
  </button>
  <div class="history-group" title="History">
    <button data-ref="undo" class="icon-button" title="Undo the last jj operation (jj undo)" onclick={() => repo.act("Undo", () => jj.undo(repo.path))}>
      <svg viewBox="0 0 16 16" width="14" height="14"
        ><path d="M5.5 3.5L2.5 6.5l3 3M2.5 6.5h7a4 4 0 0 1 0 8H7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg
      >
    </button>
    <button data-ref="redo" class="icon-button" title="Redo (jj redo)" onclick={() => repo.act("Redo", () => jj.redo(repo.path))}>
      <svg viewBox="0 0 16 16" width="14" height="14"
        ><path d="M10.5 3.5l3 3-3 3M13.5 6.5h-7a4 4 0 0 0 0 8H9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg
      >
    </button>
    <button data-ref="oplog-button" class={["icon-button", repo.oplogVisible && "active"]} title="Operation log" onclick={() => repo.toggleOpLog()}>
      <svg viewBox="0 0 16 16" width="14" height="14"
        ><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.5" /><path
          d="M8 4.75V8l2.25 1.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        /></svg
      >
    </button>
  </div>
  <button data-ref="help" class="icon-button help-button toolbar-end" title="Keyboard shortcuts (?)" onclick={() => showHelp()}>?</button>
  <button data-ref="settings" class="icon-button" title="Settings (⌘,)" onclick={() => showSettings()}>
    <svg viewBox="0 0 16 16" width="14" height="14"
      ><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /><circle
        cx="10"
        cy="4.5"
        r="1.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      /><circle cx="6" cy="11.5" r="1.5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg
    >
  </button>
  <div data-ref="status" class="toolbar-status" title={repo.statusTitle}>{repo.status}</div>
</header>
<div data-ref="error" class="error" hidden={repo.error === null}>{repo.error}</div>
<Modebar {repo} />
<div class="repo-body">
  <aside data-ref="sidebar" class="sidebar">
    <Sidebar
      data={repo.log?.sidebar ?? null}
      name={repo.name}
      workspaceName={repo.log?.workspaceName ?? null}
      workspaceRoot={repo.log?.workspaceRoot ?? null}
      selectedCommit={repo.selectedCommit}
      select={(item) => repo.selectCommit(item.commitId, item.name)}
      contextMenu={(item) => repo.sidebarMenu(item)}
      addWorkspace={() => repo.addWorkspace(null)}
    />
  </aside>
  <div data-ref="split-sidebar" class="splitter columns" title="Drag to resize"></div>
  <div class="workspace">
    <main data-ref="list" class="list">
      <div data-ref="scroller" class="scroller">
        <div data-ref="spacer" class="spacer"></div>
      </div>
    </main>
    <div data-ref="split-details" class="splitter rows" title="Drag to resize"></div>
    <section data-ref="details" class="details"><Details panel={repo.details} /></section>
  </div>
  <aside data-ref="oplog" class="oplog" hidden={!repo.oplogVisible}>
    <OpLog
      bind:this={repo.oplog}
      path={repo.path}
      act={(label, run) => repo.act(label, run)}
      showCommit={(commitId) => {
        repo.hideOpLog();
        repo.selectCommit(commitId, "That commit");
      }}
      close={() => repo.hideOpLog()}
    />
  </aside>
  <section data-ref="resolve" class="takeover" hidden={!repo.resolveVisible}>
    <Resolve
      bind:this={repo.resolver}
      loadConflict={(commitId, filePath) => repo.loadConflict(commitId, filePath)}
      resolve={(filePath, content) => repo.resolveFile(filePath, content)}
      takeSide={(filePath, side) => repo.takeSide(filePath, side)}
      close={() => repo.closeResolve()}
    />
  </section>
</div>
