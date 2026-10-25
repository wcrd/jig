<!-- The sidebar: workspaces, bookmarks, remotes and tags. -->
<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";

  import { storage } from "../api";
  import { remoteLabel } from "../format";
  import { CHEVRON, FOLDER, LINK, LIST, PLUS, SIDEBAR, TREE } from "../icons";
  import { type Section, type SidebarCallbacks, type SidebarItem, sidebarSections } from "../sidebar";
  import type { Sidebar as SidebarData } from "../types";

  let {
    data,
    name,
    workspaceName = null,
    workspaceRoot = null,
    selectedCommit = null,
    select,
    contextMenu,
    addWorkspace,
  }: {
    data: SidebarData | null;
    /** The repo's folder name, shown atop the list. */
    name: string;
    workspaceName?: string | null;
    workspaceRoot?: string | null;
    /** Entries pointing at this commit are highlighted. */
    selectedCommit?: string | null;
  } & SidebarCallbacks = $props();

  let flat = $state(storage("sidebarFlat") === "1");
  let filter = $state("");
  const collapsedSections = new SvelteSet<string>(JSON.parse(storage("sidebarCollapsed") ?? '["tags"]'));
  const collapsedFolders = new SvelteSet<string>();

  const sections = $derived(data ? sidebarSections(data, { filter, flat, collapsedSections, collapsedFolders }) : []);

  function setFlat(value: boolean) {
    flat = value;
    storage("sidebarFlat", flat ? "1" : "0");
  }

  function toggleSection(event: MouseEvent, section: Section) {
    if (event.button !== 0) return;
    if (collapsedSections.has(section)) collapsedSections.delete(section);
    else collapsedSections.add(section);
    storage("sidebarCollapsed", JSON.stringify([...collapsedSections]));
  }

  function toggleFolder(event: MouseEvent, key: string) {
    if (event.button !== 0) return;
    if (collapsedFolders.has(key)) collapsedFolders.delete(key);
    else collapsedFolders.add(key);
  }

  function menu(event: MouseEvent, item: SidebarItem) {
    event.preventDefault();
    contextMenu(item);
  }

  const selected = (item: SidebarItem) => !!selectedCommit && item.commitId === selectedCommit;
</script>

{#snippet itemContent(item: SidebarItem, label: string)}
  {@html SIDEBAR[item.kind === "remoteRoot" ? "remote" : item.kind]}<span class={["path", item.kind === "workspace" && item.tracked && "current"]}
    ><span class="name">{label}</span></span
  >{#if item.kind === "bookmark" && item.bookmark}
    {@const differing = item.bookmark.remotes.find((r) => r.tracked && (r.ahead || r.behind))}
    {#if item.bookmark.conflict}<span class="flag conflict" title="Conflicted">??</span
      >{:else if differing}<span
        class="flag"
        title={[differing.ahead && `${differing.ahead} ahead of ${differing.remote}`, differing.behind && `${differing.behind} behind ${differing.remote}`]
          .filter(Boolean)
          .join(", ")}>{differing.ahead ? `↑${differing.ahead}` : ""}{differing.behind ? `↓${differing.behind}` : ""}</span
      >{:else if item.bookmark.tracked && !item.bookmark.synced}<span class="flag" title="Differs from its remote">*</span>{/if}
  {/if}{#if item.kind === "remote"}
    {#if item.tracked}<span class="flag tracked" title="Tracked: the local bookmark follows this on fetch, and pushes update it. Right-click to untrack."
        >{@html LINK}</span
      >{:else}<span class="flag muted" title="Not tracked: fetching won't create or move a local bookmark. Right-click to track it.">untracked</span>{/if}
  {/if}
{/snippet}

<div class="sidebar-title" data-ref="repo-name" title={workspaceRoot}>
  {name}{#if workspaceName && workspaceName !== "default"}{" "}<span class="workspace-name">· {workspaceName}</span>{/if}
</div>
<div class="sidebar-header">
  <input
    class="sidebar-filter"
    placeholder="Filter"
    spellcheck="false"
    autocapitalize="off"
    autocorrect="off"
    autocomplete="off"
    oninput={(event) => (filter = event.currentTarget.value.trim().toLowerCase())}
  />
  <button class={["header-button", !flat && "active"]} data-view="tree" title="Group bookmarks into folders" onclick={() => setFlat(false)}>{@html TREE}</button>
  <button class={["header-button", flat && "active"]} data-view="flat" title="Show bookmarks as a flat list" onclick={() => setFlat(true)}>{@html LIST}</button>
</div>
<div class="sidebar-list">
  {#each sections as section (section.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class={["sidebar-section", section.open && "open"]} data-section-toggle={section.id} onmousedown={(event) => toggleSection(event, section.id)}>
      {@html CHEVRON}<span>{section.title}</span><span class="count">{section.count}</span>{#if section.id === "workspaces"}<button
          class="section-add"
          data-add-workspace
          title="Add Workspace…"
          onmousedown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            addWorkspace();
          }}>{@html PLUS}</button
        >{/if}
    </div>
    {#each section.rows as row (row.kind === "item" ? `i${row.index}` : row.key)}
      {#if row.kind === "folder"}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class={["tree-row", "folder", row.open && "open"]} data-folder={row.key} style="padding-left:{row.padding}px" onmousedown={(event) => toggleFolder(event, row.key)}>
          {@html CHEVRON}{@html FOLDER}<span class="name">{row.name}</span>
        </div>
      {:else if row.kind === "remote"}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class={["tree-row", "folder", "remote-root", row.open && "open"]}
          data-folder={row.key}
          data-item-menu={row.index}
          style="padding-left:10px"
          title={row.item.url ?? row.item.name}
          onmousedown={(event) => toggleFolder(event, row.key)}
          oncontextmenu={(event) => menu(event, row.item)}
        >
          {@html CHEVRON}{@html SIDEBAR.remote}<span class="name">{row.item.name}</span><span class="remote-host">{remoteLabel(row.item.url ?? null)}</span>
        </div>
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class={["tree-row", "file", "sidebar-item", selected(row.item) && "selected"]}
          data-item={row.index}
          style="padding-left:{row.padding}px"
          title={row.tree ? undefined : (row.item.path ?? undefined)}
          onmousedown={(event) => event.button === 0 && select(row.item)}
          oncontextmenu={(event) => menu(event, row.item)}
        >
          {#if row.tree}<span class="chevron-space"></span>{/if}{@render itemContent(row.item, row.label)}
        </div>
      {/if}
    {/each}
  {/each}
</div>
