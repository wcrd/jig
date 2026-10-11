//! Loads a jj workspace read-only and turns a revset into graph rows.
//!
//! This reads the repo at its current operation without snapshotting the
//! working copy, so `@` reflects the state as of the last jj command.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result, anyhow};
use jj_cli::cli_util::default_ignored_remote_name;
use jj_cli::config::{ConfigEnv, config_from_environment, default_config_layers};
use jj_cli::revset_util;
use jj_cli::ui::Ui;
use jj_lib::backend::CommitId;
use jj_lib::commit::Commit;
use jj_lib::config::{ConfigNamePathBuf, StackedConfig};
use jj_lib::conflicts::ConflictMarkerStyle;
use jj_lib::fileset::FilesetAliasesMap;
use jj_lib::git::REMOTE_NAME_FOR_LOCAL_GIT_REPO;
use jj_lib::graph::{GraphEdgeType, TopoGroupedGraphIterator};
use jj_lib::id_prefix::IdPrefixContext;
use jj_lib::object_id::ObjectId;
use jj_lib::op_heads_store;
use jj_lib::operation::Operation;
use jj_lib::op_store::RemoteRef;
use jj_lib::op_store::RefTarget;
use jj_lib::repo::{ReadonlyRepo, Repo, RepoLoaderError, StoreFactories};
use jj_lib::repo_path::RepoPathUiConverter;
use jj_lib::revset::{
    self, ResolvedRevsetExpression, Revset, RevsetAliasesMap, RevsetExpression, RevsetDiagnostics, RevsetExtensions, RevsetParseContext,
    RevsetWorkspaceContext, SymbolResolver, SymbolResolverExtension, UserRevsetExpression,
};
use jj_lib::settings::UserSettings;
use jj_lib::workspace::{
    DefaultWorkspaceLoaderFactory, Workspace, WorkspaceLoaderFactory,
    default_working_copy_factories,
};
use serde::Serialize;

use crate::layout::{self, EdgeKind, EdgeLayout, NodeInput};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogResponse {
    pub workspace_root: String,
    pub workspace_name: String,
    pub op_id: String,
    pub op_description: String,
    pub revset: String,
    pub default_revset: String,
    pub rows: Vec<LogRow>,
    pub edges: Vec<EdgeLayout>,
    pub max_width: u32,
    pub truncated: bool,
    pub elapsed_ms: u64,
    /// Bookmarks, tags and workspaces for the sidebar; independent of the revset.
    pub sidebar: Sidebar,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sidebar {
    pub bookmarks: Vec<SidebarBookmark>,
    pub tags: Vec<SidebarTag>,
    pub workspaces: Vec<SidebarWorkspace>,
    /// Every git remote (except jj's internal "git" one), "origin" first.
    pub remotes: Vec<SidebarRemote>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarRemote {
    pub name: String,
    /// Fetch URL.
    pub url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarBookmark {
    pub name: String,
    /// Local target, if the bookmark exists locally.
    pub commit_id: Option<String>,
    pub conflict: bool,
    /// Tracks at least one remote.
    pub tracked: bool,
    /// Every tracked remote points at the local target.
    pub synced: bool,
    pub remotes: Vec<SidebarRemoteRef>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarRemoteRef {
    pub remote: String,
    pub commit_id: Option<String>,
    pub tracked: bool,
    /// Commits in local but not in this remote ref (capped; 0 unless tracked and differing).
    pub ahead: u32,
    /// Commits in this remote ref but not in local (capped; 0 unless tracked and differing).
    pub behind: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarTag {
    pub name: String,
    pub commit_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarWorkspace {
    pub name: String,
    pub commit_id: String,
    pub current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRow {
    pub commit_id: String,
    pub commit_prefix_len: usize,
    pub change_id: String,
    pub change_prefix_len: usize,
    pub summary: String,
    pub has_body: bool,
    pub author_name: String,
    pub author_email: String,
    /// From `Co-Authored-By:` trailers.
    pub coauthors: Vec<Coauthor>,
    /// Committer timestamp in milliseconds, which is what `jj log` shows.
    pub timestamp: i64,
    pub parent_count: usize,
    pub is_working_copy: bool,
    /// Other workspaces whose working copy is this commit.
    pub workspaces: Vec<String>,
    pub immutable: bool,
    pub conflict: bool,
    pub empty: bool,
    pub divergent: bool,
    /// Whether this commit is an ancestor of `@`. Others are drawn dimmed.
    pub in_wc_history: bool,
    pub refs: Vec<RefLabel>,
    pub lane: u32,
    pub width: u32,
}

#[derive(Serialize, Clone)]
pub struct Coauthor {
    pub name: String,
    pub email: String,
}

/// Co-authors from the description's `Co-Authored-By: Name <email>` trailers.
pub fn coauthors(description: &str) -> Vec<Coauthor> {
    jj_lib::trailer::parse_description_trailers(description)
        .into_iter()
        .filter(|t| t.key.eq_ignore_ascii_case("co-authored-by"))
        .map(|t| {
            let value = t.value.trim();
            match value.rsplit_once('<') {
                Some((name, email)) => Coauthor {
                    name: name.trim().to_owned(),
                    email: email.trim_end_matches('>').trim().to_owned(),
                },
                None => Coauthor {
                    name: value.to_owned(),
                    email: String::new(),
                },
            }
        })
        .collect()
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RefLabel {
    #[serde(rename_all = "camelCase")]
    Bookmark {
        name: String,
        conflict: bool,
        /// Tracks at least one remote.
        tracked: bool,
        /// Every tracked remote points at the same commit.
        synced: bool,
        /// Commits in local but not in `remote` (capped).
        ahead: u32,
        /// Commits in `remote` but not in local (capped).
        behind: u32,
        /// The tracked remote that differs from local (preferring "origin").
        remote: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RemoteBookmark {
        name: String,
        remote: String,
        tracked: bool,
    },
    Tag { name: String },
}

pub fn find_workspace_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|p| p.join(".jj").is_dir())
        .map(Path::to_owned)
}

struct Settings {
    settings: UserSettings,
    aliases: RevsetAliasesMap,
    fileset_aliases: FilesetAliasesMap,
}

fn read_settings(repo_path: &Path, workspace_root: &Path) -> Result<Settings> {
    let mut config_env = ConfigEnv::from_environment();
    let mut raw_config = config_from_environment(default_config_layers());
    config_env.reload_user_config(&mut raw_config)?;
    config_env.reset_repo_path(repo_path);
    config_env
        .reload_repo_config(&Ui::null(), &mut raw_config)
        .map_err(|e| anyhow!("{e:?}"))?;
    config_env.reset_workspace_path(workspace_root);
    config_env
        .reload_workspace_config(&Ui::null(), &mut raw_config)
        .map_err(|e| anyhow!("{e:?}"))?;
    let config = config_env.resolve_config(&raw_config)?;
    let aliases = load_aliases(&config, "revset-aliases", RevsetAliasesMap::new(), |m, k, v| {
        m.insert(k, v).map_err(|e| e.to_string())
    })?;
    let fileset_aliases =
        load_aliases(&config, "fileset-aliases", FilesetAliasesMap::new(), |m, k, v| {
            m.insert(k, v).map_err(|e| e.to_string())
        })?;
    Ok(Settings {
        settings: UserSettings::from_config(config)?,
        aliases,
        fileset_aliases,
    })
}

/// Collects an alias table across all config layers, later layers winning.
fn load_aliases<M>(
    config: &StackedConfig,
    table: &str,
    mut map: M,
    insert: impl Fn(&mut M, &str, &str) -> Result<(), String>,
) -> Result<M> {
    let table_name = ConfigNamePathBuf::from_iter([table]);
    for layer in config.layers() {
        let Ok(Some(entries)) = layer.look_up_table(&table_name) else {
            continue;
        };
        for (decl, item) in entries.iter() {
            let value = item
                .as_str()
                .ok_or_else(|| anyhow!("{table}.{decl}: expected a string"))?;
            insert(&mut map, decl, value).map_err(|e| anyhow!("{table}.{decl}: {e}"))?;
        }
    }
    Ok(map)
}

async fn load_at_head(workspace: &Workspace) -> Result<Arc<ReadonlyRepo>> {
    let loader = workspace.repo_loader();
    let op = op_heads_store::resolve_op_heads(
        loader.op_heads_store().as_ref(),
        loader.op_store(),
        async |op_heads| {
            // Merge concurrent operations in memory only; jj will do it for
            // real the next time it runs.
            let base_repo = loader.load_at(&op_heads[0]).await?;
            let mut tx = base_repo.start_transaction();
            for other_op_head in op_heads.into_iter().skip(1) {
                tx.merge_operation(other_op_head).await?;
                tx.repo_mut().rebase_descendants().await?;
            }
            Ok::<Operation, RepoLoaderError>(
                tx.write("resolve concurrent operations")
                    .await?
                    .leave_unpublished()
                    .operation()
                    .clone(),
            )
        },
    )
    .await?;
    Ok(loader.load_at(&op).await.context("load operation")?)
}

struct Ctx {
    settings: Settings,
    path_converter: RepoPathUiConverter,
    extensions: RevsetExtensions,
}

impl Ctx {
    fn parse_context<'a>(
        &'a self,
        workspace: &'a Workspace,
        repo: &'a ReadonlyRepo,
    ) -> RevsetParseContext<'a> {
        RevsetParseContext {
            aliases_map: &self.settings.aliases,
            local_variables: HashMap::new(),
            user_email: self.settings.settings.user_email(),
            date_pattern_context: chrono::Local::now().into(),
            default_ignored_remote: default_ignored_remote_name(repo.store()),
            fileset_aliases_map: &self.settings.fileset_aliases,
            use_glob_by_default: false,
            extensions: &self.extensions,
            workspace: Some(RevsetWorkspaceContext {
                path_converter: &self.path_converter,
                workspace_name: workspace.workspace_name(),
            }),
        }
    }
}

fn parse(context: &RevsetParseContext, text: &str) -> Result<Arc<UserRevsetExpression>> {
    let mut diagnostics = RevsetDiagnostics::new();
    let expression = revset::parse(&mut diagnostics, text, context)
        .map_err(|e| anyhow!("{}", revset_error_chain(&e)))?;
    Ok(expression)
}

fn revset_error_chain(err: &dyn std::error::Error) -> String {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(err) = source {
        message.push_str(": ");
        message.push_str(&err.to_string());
        source = err.source();
    }
    message
}

fn evaluate<'r>(
    repo: &'r ReadonlyRepo,
    resolver: &SymbolResolver,
    expression: &Arc<UserRevsetExpression>,
) -> Result<Box<dyn Revset + 'r>> {
    let resolved = expression
        .resolve_user_expression(repo, resolver)
        .map_err(|e| anyhow!("{}", revset_error_chain(&e)))?;
    Ok(resolved.evaluate(repo)?)
}

/// A repo loaded at some operation, kept around for computing diffs.
pub struct OpenRepo {
    pub root: PathBuf,
    pub repo: Arc<ReadonlyRepo>,
    pub marker_style: ConflictMarkerStyle,
}

pub fn load_log(
    path: &Path,
    revset_text: Option<&str>,
    limit: usize,
) -> Result<(LogResponse, OpenRepo)> {
    pollster::block_on(load_log_async(path, revset_text, limit))
}

async fn load_log_async(
    path: &Path,
    revset_text: Option<&str>,
    limit: usize,
) -> Result<(LogResponse, OpenRepo)> {
    let started = Instant::now();
    let root = find_workspace_root(path)
        .ok_or_else(|| anyhow!("{} is not inside a jj repository", path.display()))?;
    let loader = DefaultWorkspaceLoaderFactory.create(&root)?;
    let settings = read_settings(loader.repo_path(), &root)?;
    let workspace = loader.load(
        &settings.settings,
        &StoreFactories::default(),
        &default_working_copy_factories(),
    )?;
    let repo = load_at_head(&workspace).await?;

    let ctx = Ctx {
        path_converter: RepoPathUiConverter::Fs {
            cwd: root.clone(),
            base: root.clone(),
        },
        settings,
        extensions: RevsetExtensions::default(),
    };
    let parse_context = ctx.parse_context(&workspace, &repo);
    let settings = &ctx.settings.settings;

    let default_revset = settings.get_string("revsets.log").unwrap_or_default();
    let revset_text = revset_text
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&default_revset)
        .to_owned();

    let prefix_revset = settings
        .get_string("revsets.short-prefixes")
        .unwrap_or_else(|_| default_revset.clone());
    let prefix_context = IdPrefixContext::new(Arc::new(RevsetExtensions::default()))
        .disambiguate_within(if prefix_revset.is_empty() {
            revset::RevsetExpression::all()
        } else {
            parse(&parse_context, &prefix_revset)?
        });
    let resolver = SymbolResolver::new(
        repo.as_ref(),
        &([] as [Box<dyn SymbolResolverExtension>; 0]),
    )
    .with_id_prefix_context(&prefix_context);
    let prefix_index = prefix_context.populate(repo.as_ref())?;

    let expression = parse(&parse_context, &revset_text)?;
    let revset = evaluate(&repo, &resolver, &expression)?;

    let mut diagnostics = RevsetDiagnostics::new();
    let immutable_expression =
        revset_util::parse_immutable_heads_expression(&mut diagnostics, &parse_context)
            .map_err(|e| anyhow!("{}", revset_error_chain(&e)))?
            .ancestors();
    let immutable = evaluate(&repo, &resolver, &immutable_expression)?;
    let is_immutable = immutable.containing_fn();

    let wc_id = repo.view().get_wc_commit_id(workspace.workspace_name()).cloned();
    let wc_history = match &wc_id {
        Some(id) => Some(evaluate(
            &repo,
            &resolver,
            &revset::RevsetExpression::commit(id.clone()).ancestors(),
        )?),
        None => None,
    };
    let in_wc_history = wc_history.as_ref().map(|r| r.containing_fn());

    // Order like `jj log`: topologically grouped, with the configured
    // branches (normally @'s) first.
    let mut graph = TopoGroupedGraphIterator::new(revset.iter_graph(), |id| id);
    let has_commit = revset.containing_fn();
    let prioritize = settings
        .get_string("revsets.log-graph-prioritize")
        .unwrap_or_else(|_| "present(@)".into());
    let prioritize = evaluate(&repo, &resolver, &parse(&parse_context, &prioritize)?)?;
    for id in prioritize.iter() {
        let id = id?;
        if has_commit(&id)? {
            graph.prioritize_branch(id);
        }
    }

    let mut nodes = Vec::new();
    let mut truncated = false;
    for node in graph {
        if nodes.len() >= limit {
            truncated = true;
            break;
        }
        let (id, edges) = node?;
        nodes.push(NodeInput {
            id,
            edges: edges
                .into_iter()
                .map(|edge| {
                    let kind = match edge.edge_type {
                        GraphEdgeType::Direct => EdgeKind::Direct,
                        GraphEdgeType::Indirect => EdgeKind::Indirect,
                        GraphEdgeType::Missing => EdgeKind::Missing,
                    };
                    (edge.target, kind)
                })
                .collect(),
        });
    }

    // Pin a straight line down the left edge: from @ through trunk when @'s
    // first-parent line reaches trunk (as jj log draws your work on top of
    // main), otherwise trunk alone.
    let trunk = match parse(&parse_context, "present(trunk())")
        .and_then(|e| evaluate(&repo, &resolver, &e))
    {
        Ok(trunk) => trunk.iter().next().transpose()?,
        Err(_) => None,
    };
    let spine_head = match (&wc_id, &trunk) {
        (Some(wc), Some(trunk)) if layout::first_parent_line_reaches(&nodes, wc, trunk) => Some(wc.clone()),
        _ => trunk.clone(),
    };
    let layout = layout::layout(&nodes, spine_head.as_ref());

    let refs = ref_index(&repo);
    let mut other_workspaces: HashMap<CommitId, Vec<String>> = HashMap::new();
    for (name, id) in repo.view().wc_commit_ids() {
        if **name != *workspace.workspace_name() {
            other_workspaces
                .entry(id.clone())
                .or_default()
                .push(name.as_symbol().to_string());
        }
    }

    let store = repo.store();
    let mut rows = Vec::with_capacity(nodes.len());
    for (node, row_layout) in nodes.iter().zip(&layout.rows) {
        let commit = store.get_commit_async(&node.id).await?;
        let description = commit.description().trim_end();
        let (summary, body) = description.split_once('\n').unwrap_or((description, ""));
        let change_id = commit.change_id();
        let divergent = repo
            .resolve_change_id(change_id)
            .ok()
            .flatten()
            .is_some_and(|targets| targets.is_divergent());
        let commit_hex = commit.id().hex();
        let change_hex = change_id.reverse_hex();
        rows.push(LogRow {
            commit_prefix_len: prefix_index
                .shortest_commit_prefix_len(repo.as_ref(), commit.id())
                .unwrap_or(commit_hex.len()),
            change_prefix_len: prefix_index
                .shortest_change_prefix_len(repo.as_ref(), change_id)
                .unwrap_or(change_hex.len()),
            commit_id: commit_hex,
            change_id: change_hex,
            summary: summary.to_owned(),
            has_body: !body.trim().is_empty(),
            author_name: commit.author().name.clone(),
            author_email: commit.author().email.clone(),
            coauthors: coauthors(commit.description()),
            timestamp: commit.committer().timestamp.timestamp.0,
            parent_count: commit.parent_ids().len(),
            is_working_copy: wc_id.as_ref() == Some(commit.id()),
            workspaces: other_workspaces.remove(commit.id()).unwrap_or_default(),
            immutable: is_immutable(commit.id())?,
            conflict: commit.has_conflict(),
            empty: commit.is_empty(repo.as_ref()).await?,
            divergent,
            in_wc_history: match &in_wc_history {
                Some(f) => f(commit.id())?,
                None => true,
            },
            refs: refs.get(commit.id()).cloned().unwrap_or_default(),
            lane: row_layout.lane,
            width: row_layout.width,
        });
    }

    let marker_style = settings
        .get("ui.conflict-marker-style")
        .unwrap_or(ConflictMarkerStyle::Diff);
    let operation = repo.operation();
    let response = LogResponse {
        workspace_root: root.display().to_string(),
        workspace_name: workspace.workspace_name().as_symbol().to_string(),
        op_id: operation.id().hex()[..12].to_owned(),
        op_description: operation.metadata().description.clone(),
        revset: revset_text,
        default_revset,
        rows,
        edges: layout.edges,
        max_width: layout.max_width,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
        sidebar: build_sidebar(&repo, &workspace.workspace_name().as_symbol().to_string()),
    };
    Ok((
        response,
        OpenRepo {
            root,
            repo: repo.clone(),
            marker_style,
        },
    ))
}

/// Current operation id, used to detect changes made by jj elsewhere.
pub fn head_op_id(path: &Path) -> Result<String> {
    pollster::block_on(async {
        let root = find_workspace_root(path)
            .ok_or_else(|| anyhow!("{} is not inside a jj repository", path.display()))?;
        let loader = DefaultWorkspaceLoaderFactory.create(&root)?;
        let settings = read_settings(loader.repo_path(), &root)?;
        let workspace = loader.load(
            &settings.settings,
            &StoreFactories::default(),
            &default_working_copy_factories(),
        )?;
        let repo = load_at_head(&workspace).await?;
        Ok(repo.operation().id().hex()[..12].to_owned())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpEntry {
    pub id: String,
    pub short_id: String,
    pub description: String,
    /// End time, milliseconds since the epoch.
    pub time: i64,
    /// `user@host`.
    pub user: String,
    /// The head operation.
    pub current: bool,
    /// A pure working-copy snapshot.
    pub snapshot: bool,
    /// The command line jj recorded, e.g. `jj rebase -r abc -o main`.
    pub args: Option<String>,
}

/// The recorded command line with any leading path to the jj binary removed.
fn op_args(tags: &HashMap<String, String>) -> Option<String> {
    let args = tags.get("args")?.trim();
    if args.is_empty() {
        return None;
    }
    let (first, rest) = args.split_once(' ').unwrap_or((args, ""));
    let name = first.rsplit(['/', '\\']).next().unwrap_or(first);
    Some(if rest.is_empty() { name.to_owned() } else { format!("{name} {rest}") })
}

/// The operation log, newest first, following first parents from the head.
pub fn op_log(path: &Path, limit: usize) -> Result<Vec<OpEntry>> {
    pollster::block_on(async {
        let root = find_workspace_root(path)
            .ok_or_else(|| anyhow!("{} is not inside a jj repository", path.display()))?;
        let loader = DefaultWorkspaceLoaderFactory.create(&root)?;
        let settings = read_settings(loader.repo_path(), &root)?;
        let workspace = loader.load(
            &settings.settings,
            &StoreFactories::default(),
            &default_working_copy_factories(),
        )?;
        let repo = load_at_head(&workspace).await?;
        let head = repo.operation().clone();
        let mut entries = Vec::new();
        let mut op = head.clone();
        while entries.len() < limit {
            let meta = op.metadata();
            let id = op.id().hex();
            entries.push(OpEntry {
                short_id: id[..12.min(id.len())].to_owned(),
                current: op.id() == head.id(),
                description: meta.description.clone(),
                time: meta.time.end.timestamp.0,
                user: format!("{}@{}", meta.username, meta.hostname),
                snapshot: meta.is_snapshot,
                args: op_args(&meta.tags),
                id,
            });
            let Some(parent) = op.parents().await?.into_iter().next() else {
                break;
            };
            op = parent;
        }
        Ok(entries)
    })
}

const MAX_OP_CHANGES: usize = 300;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpChange {
    /// "added" | "removed" | "rewritten".
    pub kind: &'static str,
    pub change_id: String,
    /// The new commit (the removed one for "removed").
    pub commit_id: String,
    pub old_commit_id: Option<String>,
    pub summary: String,
    pub empty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkMove {
    pub name: String,
    /// None for a local bookmark.
    pub remote: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WcMove {
    pub workspace: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpChanges {
    pub changes: Vec<OpChange>,
    pub bookmarks: Vec<BookmarkMove>,
    pub working_copies: Vec<WcMove>,
    pub truncated: bool,
}

/// Bookmark targets keyed by (name, remote); `None` remote is the local ref.
fn bookmark_targets(repo: &ReadonlyRepo) -> BTreeMap<(String, Option<String>), String> {
    let mut map = BTreeMap::new();
    for (name, target) in repo.view().bookmarks() {
        if let Some(id) = target.local_target.added_ids().next() {
            map.insert((name.as_str().to_owned(), None), id.hex());
        }
        for (remote, r) in target.remote_refs {
            if remote == REMOTE_NAME_FOR_LOCAL_GIT_REPO {
                continue;
            }
            if let Some(id) = r.target.added_ids().next() {
                map.insert((name.as_str().to_owned(), Some(remote.as_str().to_owned())), id.hex());
            }
        }
    }
    map
}

/// What an operation changed: the diff between the repo at the operation and
/// at its first parent. The root operation has no changes.
pub fn op_changes(path: &Path, op_id: &str) -> Result<OpChanges> {
    crate::jj_cli::validate_op_id(op_id)?;
    pollster::block_on(async {
        let root = find_workspace_root(path)
            .ok_or_else(|| anyhow!("{} is not inside a jj repository", path.display()))?;
        let loader = DefaultWorkspaceLoaderFactory.create(&root)?;
        let settings = read_settings(loader.repo_path(), &root)?;
        let workspace = loader.load(
            &settings.settings,
            &StoreFactories::default(),
            &default_working_copy_factories(),
        )?;
        let repo_loader = workspace.repo_loader();
        let op = jj_lib::op_walk::resolve_op_for_load(repo_loader, op_id)
            .await
            .map_err(|e| anyhow!("{}", revset_error_chain(&e)))?;
        let mut result = OpChanges {
            changes: Vec::new(),
            bookmarks: Vec::new(),
            working_copies: Vec::new(),
            truncated: false,
        };
        let Some(parent) = op.parents().await?.into_iter().next() else {
            return Ok(result);
        };
        let new = repo_loader.load_at(&op).await.context("load operation")?;
        let old = repo_loader.load_at(&parent).await.context("load parent operation")?;

        // The newer repo's index also contains the older commits.
        let heads = |r: &ReadonlyRepo| {
            RevsetExpression::commits(r.view().heads().iter().cloned().collect()).ancestors()
        };
        let (new_set, old_set) = (heads(&new), heads(&old));
        let list = |expr: Arc<ResolvedRevsetExpression>| -> Result<Vec<CommitId>> {
            expr.evaluate(new.as_ref())?
                .iter()
                .collect::<Result<_, _>>()
                .map_err(Into::into)
        };
        let added = list(new_set.minus(&old_set))?;
        let removed = list(old_set.minus(&new_set))?;

        let store = new.store();
        let mut removed_by_change: HashMap<_, Vec<_>> = HashMap::new();
        for id in &removed {
            let commit = store.get_commit_async(id).await?;
            removed_by_change.entry(commit.change_id().clone()).or_default().push(commit);
        }
        let describe = |kind: &'static str, commit: &Commit, old: Option<&Commit>| -> Result<OpChange> {
            Ok(OpChange {
                kind,
                change_id: commit.change_id().reverse_hex(),
                commit_id: commit.id().hex(),
                old_commit_id: old.map(|c| c.id().hex()),
                summary: commit.description().lines().next().unwrap_or("").to_owned(),
                empty: pollster::block_on(commit.is_empty(new.as_ref()))?,
            })
        };
        let mut rewritten = Vec::new();
        let mut plain_added = Vec::new();
        for id in &added {
            let commit = store.get_commit_async(id).await?;
            let old_commit = removed_by_change
                .get_mut(commit.change_id())
                .filter(|v| !v.is_empty())
                .map(|v| v.remove(0));
            match old_commit {
                Some(old_commit) => rewritten.push(describe("rewritten", &commit, Some(&old_commit))?),
                None => plain_added.push(describe("added", &commit, None)?),
            }
        }
        let mut plain_removed = Vec::new();
        for id in &removed {
            let commit = store.get_commit_async(id).await?;
            // Skip the ones that were paired into a rewrite.
            if removed_by_change
                .get(commit.change_id())
                .is_some_and(|v| v.iter().any(|c| c.id() == commit.id()))
            {
                plain_removed.push(describe("removed", &commit, None)?);
            }
        }
        let mut changes = rewritten;
        changes.extend(plain_added);
        changes.extend(plain_removed);
        if changes.len() > MAX_OP_CHANGES {
            changes.truncate(MAX_OP_CHANGES);
            result.truncated = true;
        }
        result.changes = changes;

        let (before, after) = (bookmark_targets(&old), bookmark_targets(&new));
        let keys: BTreeSet<_> = before.keys().chain(after.keys()).cloned().collect();
        for key in keys {
            let (from, to) = (before.get(&key), after.get(&key));
            if from != to {
                result.bookmarks.push(BookmarkMove {
                    name: key.0,
                    remote: key.1,
                    from: from.cloned(),
                    to: to.cloned(),
                });
            }
        }

        let (before, after) = (old.view().wc_commit_ids(), new.view().wc_commit_ids());
        let mut names: Vec<_> = before.keys().chain(after.keys()).collect();
        names.sort();
        names.dedup();
        for name in names {
            let (from, to) = (before.get(name), after.get(name));
            if from != to {
                result.working_copies.push(WcMove {
                    workspace: name.as_symbol().to_string(),
                    from: from.map(|id| id.hex()),
                    to: to.map(|id| id.hex()),
                });
            }
        }
        Ok(result)
    })
}

/// Everything the sidebar lists, read straight from the view so it doesn't
/// depend on which commits the revset happens to show.
fn build_sidebar(repo: &ReadonlyRepo, current_workspace: &str) -> Sidebar {
    let view = repo.view();
    let mut bookmarks: Vec<SidebarBookmark> = view
        .bookmarks()
        .map(|(name, target)| {
            let local = target.local_target;
            let remotes: Vec<_> = target
                .remote_refs
                .iter()
                .filter(|(remote, _)| *remote != REMOTE_NAME_FOR_LOCAL_GIT_REPO)
                .collect();
            let tracked: Vec<_> = remotes.iter().filter(|(_, r)| r.is_tracked()).collect();
            let counts = |r: &RemoteRef| {
                if r.is_tracked() && r.target != *local {
                    ahead_behind(repo, local, &r.target)
                } else {
                    (0, 0)
                }
            };
            SidebarBookmark {
                name: name.as_str().to_owned(),
                commit_id: local.added_ids().next().map(|id| id.hex()),
                conflict: local.has_conflict(),
                tracked: !tracked.is_empty(),
                synced: tracked.iter().all(|(_, r)| r.target == *local),
                remotes: remotes
                    .iter()
                    .map(|(remote, r)| SidebarRemoteRef {
                        remote: remote.as_str().to_owned(),
                        commit_id: r.target.added_ids().next().map(|id| id.hex()),
                        tracked: r.is_tracked(),
                        ahead: counts(r).0,
                        behind: counts(r).1,
                    })
                    .collect(),
            }
        })
        .collect();
    bookmarks.sort_by(|a, b| a.name.cmp(&b.name));

    let mut tags: Vec<SidebarTag> = view
        .local_tags()
        .map(|(name, target)| SidebarTag {
            name: name.as_str().to_owned(),
            commit_id: target.added_ids().next().map(|id| id.hex()),
        })
        .collect();
    tags.sort_by(|a, b| a.name.cmp(&b.name));

    let mut workspaces: Vec<SidebarWorkspace> = view
        .wc_commit_ids()
        .iter()
        .map(|(name, id)| SidebarWorkspace {
            name: name.as_symbol().to_string(),
            commit_id: id.hex(),
            current: name.as_symbol().to_string() == current_workspace,
        })
        .collect();
    workspaces.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| a.name.cmp(&b.name)));

    Sidebar { bookmarks, tags, workspaces, remotes: git_remotes(repo) }
}

const AHEAD_BEHIND_CAP: usize = 100;

/// (ahead, behind) of `local` relative to `remote`: `::local ~ ::remote` and
/// `::remote ~ ::local`, each capped. 0/0 if either side is absent or conflicted.
fn ahead_behind(repo: &ReadonlyRepo, local: &RefTarget, remote: &RefTarget) -> (u32, u32) {
    let (Some(local), Some(remote)) = (local.as_normal(), remote.as_normal()) else {
        return (0, 0);
    };
    let count = |from: &CommitId, excluding: &CommitId| -> u32 {
        let expression = RevsetExpression::commits(vec![from.clone()])
            .ancestors()
            .minus(&RevsetExpression::commits(vec![excluding.clone()]).ancestors());
        expression
            .evaluate(repo)
            .map(|revset| revset.iter().take(AHEAD_BEHIND_CAP).count() as u32)
            .unwrap_or(0)
    };
    (count(local, remote), count(remote, local))
}

/// Git remotes with fetch URLs, "origin" first. Empty for non-git backends.
fn git_remotes(repo: &ReadonlyRepo) -> Vec<SidebarRemote> {
    let Ok(backend) = jj_lib::git::get_git_backend(repo.store()) else {
        return Vec::new();
    };
    let git_repo = backend.git_repo();
    let config = git_repo.config_snapshot();
    let mut remotes: Vec<SidebarRemote> = jj_lib::git::get_all_remote_names(repo.store())
        .unwrap_or_default()
        .into_iter()
        .filter(|name| *name != REMOTE_NAME_FOR_LOCAL_GIT_REPO)
        .map(|name| SidebarRemote {
            url: config
                .string(format!("remote.{}.url", name.as_str()))
                .map(|u| u.to_string()),
            name: name.as_str().to_owned(),
        })
        .collect();
    remotes.sort_by(|a, b| (a.name != "origin").cmp(&(b.name != "origin")).then_with(|| a.name.cmp(&b.name)));
    remotes
}

fn ref_index(repo: &ReadonlyRepo) -> HashMap<CommitId, Vec<RefLabel>> {
    let mut index: HashMap<CommitId, Vec<RefLabel>> = HashMap::new();
    let mut add = |ids: &mut dyn Iterator<Item = &CommitId>, label: RefLabel| {
        for id in ids {
            index.entry(id.clone()).or_default().push(label.clone());
        }
    };

    for (name, target) in repo.view().bookmarks() {
        let local = target.local_target;
        let remotes: Vec<_> = target
            .remote_refs
            .iter()
            .filter(|(remote, _)| *remote != REMOTE_NAME_FOR_LOCAL_GIT_REPO)
            .collect();
        if local.is_present() {
            let tracked: Vec<_> = remotes.iter().filter(|(_, r)| r.is_tracked()).collect();
            let differing = |name: &str| {
                tracked
                    .iter()
                    .find(|(remote, r)| remote.as_str() == name && r.target != *local)
            };
            let behind_remote = differing("origin")
                .or_else(|| tracked.iter().find(|(_, r)| r.target != *local));
            let (ahead, behind) = behind_remote
                .map(|(_, r)| ahead_behind(repo, local, &r.target))
                .unwrap_or((0, 0));
            add(
                &mut local.added_ids(),
                RefLabel::Bookmark {
                    name: name.as_str().to_owned(),
                    conflict: local.has_conflict(),
                    tracked: !tracked.is_empty(),
                    synced: tracked.iter().all(|(_, r)| r.target == *local),
                    ahead,
                    behind,
                    remote: behind_remote.map(|(remote, _)| remote.as_str().to_owned()),
                },
            );
        }
        // Like `jj log`, only show remote bookmarks that differ from local.
        for (remote, remote_ref) in remotes {
            if local.is_present() && remote_ref.target == *local {
                continue;
            }
            add(
                &mut remote_ref.target.added_ids(),
                RefLabel::RemoteBookmark {
                    name: name.as_str().to_owned(),
                    remote: remote.as_str().to_owned(),
                    tracked: remote_ref.is_tracked(),
                },
            );
        }
    }

    for (name, target) in repo.view().local_tags() {
        add(
            &mut target.added_ids(),
            RefLabel::Tag {
                name: name.as_str().to_owned(),
            },
        );
    }

    index
}

#[cfg(test)]
mod tests {
    use super::{coauthors, op_changes, op_log};
    use std::path::Path;
    use std::process::Command;

    fn jj(dir: &Path, args: &[&str]) -> bool {
        Command::new("jj")
            .args(args)
            .current_dir(dir)
            .env("JJ_USER", "t")
            .env("JJ_EMAIL", "t@example.com")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[test]
    fn op_changes_reports_rewrite_and_bookmark() {
        let dir = std::env::temp_dir().join(format!("jork-opchanges-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if !jj(&dir, &["git", "init"]) {
            eprintln!("jj unavailable; skipping");
            return;
        }
        assert!(jj(&dir, &["describe", "-m", "first"]));
        assert!(jj(&dir, &["describe", "-m", "second"]));
        assert!(jj(&dir, &["bookmark", "create", "topic", "-r", "@"]));
        let ops = op_log(&dir, 50).unwrap();
        let find = |needle: &str| ops.iter().find(|o| o.args.as_deref().is_some_and(|a| a.contains(needle))).unwrap();
        let describe = find("describe -m second");
        assert!(describe.args.as_deref().unwrap().starts_with("jj describe"));
        let changes = op_changes(&dir, &describe.id).unwrap();
        assert!(changes.changes.iter().any(|c| c.kind == "rewritten" && c.summary == "second" && c.old_commit_id.is_some()));
        let bm = op_changes(&dir, &find("bookmark create").id).unwrap();
        assert!(bm.bookmarks.iter().any(|b| b.name == "topic" && b.remote.is_none() && b.from.is_none() && b.to.is_some()));
        assert!(op_changes(&dir, &ops.last().unwrap().id).unwrap().changes.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_co_authored_by_trailers() {
        let found = coauthors(
            "Fix it\n\nBody text.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nco-authored-by: Sam <sam@example.com>\n",
        );
        let pairs: Vec<_> = found.iter().map(|c| (c.name.as_str(), c.email.as_str())).collect();
        assert_eq!(
            pairs,
            [("Claude Opus 5.5", "noreply@anthropic.com"), ("Sam", "sam@example.com")]
        );
        assert!(coauthors("Just a summary").is_empty());
    }

    #[test]
    fn reports_ahead_and_remote_url() {
        let dir = std::env::temp_dir().join(format!("jork-ahead-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bare = dir.join("origin.git");
        let work = dir.join("work");
        let git_ok = Command::new("git")
            .args(["init", "--bare", "-q"])
            .arg(&bare)
            .output()
            .is_ok_and(|o| o.status.success());
        if !git_ok || !jj(&dir, &["git", "clone", bare.to_str().unwrap(), "work"]) {
            eprintln!("jj/git unavailable; skipping");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        assert!(jj(&work, &["describe", "-m", "base"]));
        assert!(jj(&work, &["bookmark", "create", "main", "-r", "@"]));
        assert!(jj(&work, &["git", "push", "--bookmark", "main", "--allow-new"]));
        assert!(jj(&work, &["new", "main", "-m", "one"]));
        assert!(jj(&work, &["new", "-m", "two"]));
        assert!(jj(&work, &["bookmark", "set", "main", "-r", "@"]));
        let (resp, _) = super::load_log(&work, None, 50).unwrap();
        let main = resp.sidebar.bookmarks.iter().find(|b| b.name == "main").unwrap();
        let origin = main.remotes.iter().find(|r| r.remote == "origin").unwrap();
        assert_eq!((origin.ahead, origin.behind), (2, 0));
        let label = resp.rows.iter().flat_map(|r| r.refs.iter()).find_map(|l| match l {
            super::RefLabel::Bookmark { name, ahead, behind, remote, .. } if name == "main" => {
                Some((*ahead, *behind, remote.clone()))
            }
            _ => None,
        });
        assert_eq!(label, Some((2, 0, Some("origin".to_owned()))));
        assert_eq!(resp.sidebar.remotes.len(), 1);
        assert_eq!(resp.sidebar.remotes[0].name, "origin");
        assert!(resp.sidebar.remotes[0].url.as_deref().is_some_and(|u| u.ends_with("origin.git")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
