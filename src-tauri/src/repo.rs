//! Loads a jj workspace read-only and turns a revset into graph rows.
//!
//! This reads the repo at its current operation without snapshotting the
//! working copy, so `@` reflects the state as of the last jj command.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result, anyhow};
use jj_cli::cli_util::default_ignored_remote_name;
use jj_cli::config::{ConfigEnv, config_from_environment, default_config_layers};
use jj_cli::revset_util;
use jj_cli::ui::Ui;
use jj_lib::backend::CommitId;
use jj_lib::config::{ConfigNamePathBuf, StackedConfig};
use jj_lib::conflicts::ConflictMarkerStyle;
use jj_lib::fileset::FilesetAliasesMap;
use jj_lib::git::REMOTE_NAME_FOR_LOCAL_GIT_REPO;
use jj_lib::graph::{GraphEdgeType, TopoGroupedGraphIterator};
use jj_lib::id_prefix::IdPrefixContext;
use jj_lib::object_id::ObjectId;
use jj_lib::op_heads_store;
use jj_lib::operation::Operation;
use jj_lib::repo::{ReadonlyRepo, Repo, RepoLoaderError, StoreFactories};
use jj_lib::repo_path::RepoPathUiConverter;
use jj_lib::revset::{
    self, Revset, RevsetAliasesMap, RevsetDiagnostics, RevsetExtensions, RevsetParseContext,
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

    // Pin trunk() to the left edge when it's in view.
    let trunk = match parse(&parse_context, "present(trunk())")
        .and_then(|e| evaluate(&repo, &resolver, &e))
    {
        Ok(trunk) => trunk.iter().next().transpose()?,
        Err(_) => None,
    };
    let layout = layout::layout(&nodes, trunk.as_ref());

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
            add(
                &mut local.added_ids(),
                RefLabel::Bookmark {
                    name: name.as_str().to_owned(),
                    conflict: local.has_conflict(),
                    tracked: !tracked.is_empty(),
                    synced: tracked.iter().all(|(_, r)| r.target == *local),
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
    use super::coauthors;

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
}
