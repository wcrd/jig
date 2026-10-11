pub mod conflict;
pub mod diff;
pub mod jj_cli;
pub mod layout;
pub mod repo;
pub mod resolve_tool;
pub mod split_tool;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::State;

/// The repo from the most recent log load per workspace, so diffs of any
/// commit in the log can be computed without reloading.
#[derive(Default)]
struct OpenRepos(Mutex<HashMap<PathBuf, Arc<repo::OpenRepo>>>);

/// Rows beyond this are dropped; the frontend says the view is truncated.
const DEFAULT_LIMIT: usize = 20_000;

#[tauri::command]
async fn load_log(
    path: String,
    revset: Option<String>,
    limit: Option<usize>,
    repos: State<'_, OpenRepos>,
) -> Result<repo::LogResponse, String> {
    // jj-lib's futures aren't Send, so run them on a blocking thread.
    let (log, open) = tauri::async_runtime::spawn_blocking(move || {
        repo::load_log(
            &PathBuf::from(path),
            revset.as_deref(),
            limit.unwrap_or(DEFAULT_LIMIT),
        )
        .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    repos
        .0
        .lock()
        .unwrap()
        .insert(open.root.clone(), Arc::new(open));
    Ok(log)
}

/// The cached repo for a workspace, loading it if needed.
async fn open_repo(path: &str, repos: &OpenRepos) -> Result<Arc<repo::OpenRepo>, String> {
    let root = repo::find_workspace_root(&PathBuf::from(&path))
        .ok_or_else(|| format!("{path} is not inside a jj repository"))?;
    let open = repos.0.lock().unwrap().get(&root).cloned();
    let open = match open {
        Some(open) => open,
        None => {
            let (_, open) = tauri::async_runtime::spawn_blocking(move || {
                repo::load_log(&root, Some("none()"), 0).map_err(|e| format!("{e:#}"))
            })
            .await
            .map_err(|e| e.to_string())??;
            let open = Arc::new(open);
            repos
                .0
                .lock()
                .unwrap()
                .insert(open.root.clone(), open.clone());
            open
        }
    };
    Ok(open)
}

/// Runs a jj-lib future on a blocking thread (its futures aren't Send).
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work().map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn commit_diff(
    path: String,
    commit_id: String,
    repos: State<'_, OpenRepos>,
) -> Result<diff::CommitDiff, String> {
    let open = open_repo(&path, &repos).await?;
    blocking(move || {
        pollster::block_on(diff::commit_diff(&open.repo, open.marker_style, &commit_id))
    })
    .await
}

#[tauri::command]
async fn compare_diff(
    path: String,
    from: String,
    to: String,
    repos: State<'_, OpenRepos>,
) -> Result<diff::CompareDiff, String> {
    let open = open_repo(&path, &repos).await?;
    blocking(move || {
        pollster::block_on(diff::compare_diff(&open.repo, open.marker_style, &from, &to))
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn file_diff(
    path: String,
    from: Option<String>,
    to: String,
    file_path: String,
    source_path: Option<String>,
    force: bool,
    repos: State<'_, OpenRepos>,
) -> Result<diff::FileDiff, String> {
    let open = open_repo(&path, &repos).await?;
    blocking(move || {
        pollster::block_on(diff::file_diff(
            &open.repo,
            open.marker_style,
            from.as_deref(),
            &to,
            &file_path,
            source_path.as_deref(),
            force,
        ))
    })
    .await
}

#[tauri::command]
async fn file_text(
    path: String,
    commit_id: String,
    file_path: String,
    repos: State<'_, OpenRepos>,
) -> Result<diff::FileText, String> {
    let open = open_repo(&path, &repos).await?;
    blocking(move || {
        pollster::block_on(diff::file_text(
            &open.repo,
            open.marker_style,
            &commit_id,
            &file_path,
        ))
    })
    .await
}

#[tauri::command]
async fn conflict_hunks(
    path: String,
    commit_id: String,
    file_path: String,
    repos: State<'_, OpenRepos>,
) -> Result<conflict::ConflictFile, String> {
    let open = open_repo(&path, &repos).await?;
    blocking(move || pollster::block_on(conflict::conflict_hunks(&open.repo, &commit_id, &file_path)))
        .await
}

#[tauri::command]
async fn tree_files(
    path: String,
    commit_id: String,
    repos: State<'_, OpenRepos>,
) -> Result<Vec<diff::TreeEntry>, String> {
    let open = open_repo(&path, &repos).await?;
    blocking(move || pollster::block_on(diff::tree_files(&open.repo, &commit_id))).await
}

#[tauri::command]
async fn head_op_id(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        repo::head_op_id(&PathBuf::from(path)).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs a jj CLI command in the workspace containing `path`.
async fn jj_in(
    path: String,
    build: impl FnOnce() -> anyhow::Result<Vec<String>> + Send + 'static,
) -> Result<jj_cli::CommandOutput, String> {
    blocking(move || {
        let root = repo::find_workspace_root(&PathBuf::from(&path))
            .ok_or_else(|| anyhow::anyhow!("{path} is not inside a jj repository"))?;
        let args = build()?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        jj_cli::run(&root, &args)
    })
    .await
}

/// Runs several jj commands in order, stopping at the first failure, and
/// reports them as one result.
async fn jj_in_many(
    path: String,
    build: impl FnOnce() -> anyhow::Result<Vec<Vec<String>>> + Send + 'static,
) -> Result<jj_cli::CommandOutput, String> {
    blocking(move || {
        let root = repo::find_workspace_root(&PathBuf::from(&path))
            .ok_or_else(|| anyhow::anyhow!("{path} is not inside a jj repository"))?;
        let mut combined = jj_cli::CommandOutput {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
            command: String::new(),
        };
        for args in build()? {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            let output = jj_cli::run(&root, &args)?;
            combined.command += &if combined.command.is_empty() { output.command } else { format!(" && {}", output.command) };
            combined.stdout += &output.stdout;
            combined.stderr += &output.stderr;
            if !output.success {
                combined.success = false;
                break;
            }
        }
        Ok(combined)
    })
    .await
}

/// Opens an http(s) URL (a remote's web page) in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(char::is_whitespace) {
        return Err(format!("not a web URL: {url}"));
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn jj_bookmark_create(
    path: String,
    name: String,
    revision: String,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || {
        jj_cli::validate_ref_name(&name)?;
        jj_cli::validate_revision(&revision)?;
        Ok(jj_cli::strings(&["bookmark", "create", &name, "-r", &revision]))
    })
    .await
}

#[tauri::command]
async fn jj_bookmark_set(
    path: String,
    name: String,
    revision: String,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || {
        jj_cli::validate_ref_name(&name)?;
        jj_cli::validate_revision(&revision)?;
        Ok(jj_cli::strings(&[
            "bookmark",
            "set",
            &name,
            "-r",
            &revision,
            "--allow-backwards",
        ]))
    })
    .await
}

#[tauri::command]
async fn jj_bookmark_delete(path: String, name: String) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || {
        jj_cli::validate_ref_name(&name)?;
        Ok(jj_cli::strings(&["bookmark", "delete", &name]))
    })
    .await
}

#[tauri::command]
async fn jj_bookmark_track(
    path: String,
    name: String,
    remote: String,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || {
        jj_cli::validate_ref_name(&name)?;
        jj_cli::validate_ref_name(&remote)?;
        // `name@remote` is deprecated in 0.40 in favour of --remote.
        Ok(jj_cli::strings(&["bookmark", "track", &name, &format!("--remote={remote}")]))
    })
    .await
}

/// Stops syncing a local bookmark with a remote one (nothing is deleted).
#[tauri::command]
async fn jj_bookmark_untrack(
    path: String,
    name: String,
    remote: String,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || {
        jj_cli::validate_ref_name(&name)?;
        jj_cli::validate_ref_name(&remote)?;
        Ok(jj_cli::strings(&["bookmark", "untrack", &name, &format!("--remote={remote}")]))
    })
    .await
}

/// Publishes a bookmark the remote doesn't have yet: track it, then push.
#[tauri::command]
async fn jj_push_new_bookmark(
    path: String,
    name: String,
    remote: String,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in_many(path, move || {
        jj_cli::validate_ref_name(&name)?;
        jj_cli::validate_ref_name(&remote)?;
        Ok(vec![
            jj_cli::strings(&["bookmark", "track", &name, &format!("--remote={remote}")]),
            jj_cli::strings(&["git", "push", "--bookmark", &name, &format!("--remote={remote}")]),
        ])
    })
    .await
}

#[tauri::command]
async fn jj_git_fetch(
    path: String,
    remote: Option<String>,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || match remote {
        Some(remote) => {
            jj_cli::validate_ref_name(&remote)?;
            Ok(jj_cli::strings(&["git", "fetch", &format!("--remote={remote}")]))
        }
        None => Ok(jj_cli::strings(&["git", "fetch"])),
    })
    .await
}

#[tauri::command]
async fn jj_git_push(
    path: String,
    bookmark: Option<String>,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || match bookmark {
        Some(name) => {
            jj_cli::validate_ref_name(&name)?;
            Ok(jj_cli::strings(&["git", "push", "-b", &name]))
        }
        None => Ok(jj_cli::strings(&["git", "push"])),
    })
    .await
}

#[tauri::command]
async fn jj_rebase(
    path: String,
    revisions: Vec<String>,
    mode: String,
    target: String,
    placement: String,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || {
        jj_cli::rebase_args(&revisions, &mode, &target, &placement)
    })
    .await
}

#[tauri::command]
async fn jj_undo(path: String) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, || Ok(jj_cli::strings(&["undo"]))).await
}

#[tauri::command]
async fn jj_redo(path: String) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, || Ok(jj_cli::strings(&["redo"]))).await
}

#[tauri::command]
async fn jj_new(path: String, parents: Vec<String>) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::revisions_args("new", &parents)).await
}

#[tauri::command]
async fn jj_edit(path: String, revision: String) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::edit_args(&revision)).await
}

#[tauri::command]
async fn jj_abandon(path: String, revisions: Vec<String>) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::revisions_args("abandon", &revisions)).await
}

#[tauri::command]
async fn jj_describe(
    path: String,
    revision: String,
    message: String,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::describe_args(&revision, &message)).await
}

#[tauri::command]
async fn jj_duplicate(
    path: String,
    revisions: Vec<String>,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::revisions_args("duplicate", &revisions)).await
}

/// Cherry-pick: copy commits onto, after or before another.
#[tauri::command]
async fn jj_duplicate_to(
    path: String,
    revisions: Vec<String>,
    target: String,
    placement: String,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::placed_args("duplicate", &revisions, &target, &placement)).await
}

/// A new commit undoing others' changes, placed onto, after or before a commit.
#[tauri::command]
async fn jj_revert(
    path: String,
    revisions: Vec<String>,
    target: String,
    placement: String,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::placed_args("revert", &revisions, &target, &placement)).await
}

#[tauri::command]
async fn jj_absorb(path: String, revision: String) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::absorb_args(&revision)).await
}

#[tauri::command]
async fn jj_squash(
    path: String,
    revision: String,
    into: String,
    paths: Vec<String>,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::squash_args(&revision, &into, &paths)).await
}

#[tauri::command]
async fn op_log(path: String, limit: Option<usize>) -> Result<Vec<repo::OpEntry>, String> {
    blocking(move || repo::op_log(&PathBuf::from(path), limit.unwrap_or(200))).await
}

#[tauri::command]
async fn op_changes(path: String, op_id: String) -> Result<repo::OpChanges, String> {
    blocking(move || repo::op_changes(&PathBuf::from(path), &op_id)).await
}

#[tauri::command]
async fn jj_op_restore(path: String, op_id: String) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::op_args("restore", &op_id)).await
}

#[tauri::command]
async fn jj_op_revert(path: String, op_id: String) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::op_args("revert", &op_id)).await
}

/// Splits `revision` into two commits; the first gets the changes selected in
/// `plan`. jj runs this very binary as its diff editor (see `split_tool`).
#[tauri::command]
async fn jj_split(
    path: String,
    revision: String,
    plan: split_tool::SplitPlan,
    message: Option<String>,
) -> Result<jj_cli::CommandOutput, String> {
    blocking(move || {
        let root = repo::find_workspace_root(&PathBuf::from(&path))
            .ok_or_else(|| anyhow::anyhow!("{path} is not inside a jj repository"))?;
        let program = std::env::current_exe()?;
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let plan_path = std::env::temp_dir().join(format!(
            "jig-split-plan-{}-{}.json",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let (configs, args) =
            jj_cli::split_args(&revision, message.as_deref(), &program, &plan_path)?;
        std::fs::write(&plan_path, serde_json::to_vec(&plan)?)?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = jj_cli::run_with_config(&root, &configs, &args);
        let _ = std::fs::remove_file(&plan_path);
        result
    })
    .await
}

/// Resolves `file_path` in `revision` to `content`. jj runs this very binary as
/// its merge tool (see `resolve_tool`), which copies the content into place.
#[tauri::command]
async fn jj_resolve(
    path: String,
    revision: String,
    file_path: String,
    content: String,
) -> Result<jj_cli::CommandOutput, String> {
    blocking(move || {
        let root = repo::find_workspace_root(&PathBuf::from(&path))
            .ok_or_else(|| anyhow::anyhow!("{path} is not inside a jj repository"))?;
        let program = std::env::current_exe()?;
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let content_path = std::env::temp_dir().join(format!(
            "jig-resolve-content-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let (configs, args) =
            jj_cli::resolve_args(&revision, &file_path, &program, &content_path)?;
        std::fs::write(&content_path, content.as_bytes())?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = jj_cli::run_with_config(&root, &configs, &args);
        let _ = std::fs::remove_file(&content_path);
        result
    })
    .await
}

/// Resolves `file_path` in `revision` by taking one whole side.
#[tauri::command]
async fn jj_resolve_side(
    path: String,
    revision: String,
    file_path: String,
    side: String,
) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, move || jj_cli::resolve_side_args(&revision, &file_path, &side)).await
}

#[derive(serde::Serialize)]
struct InitialRepo {
    path: String,
    /// Given on the command line or in `JIG_REPO`, rather than the current
    /// directory, so it wins over the last-opened repo.
    explicit: bool,
}

/// The repo to open at startup, if any.
#[tauri::command]
fn initial_repo() -> Option<InitialRepo> {
    let explicit = std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("JIG_REPO").map(PathBuf::from));
    let (candidate, is_explicit) = match explicit {
        Some(path) => (path, true),
        None => (std::env::current_dir().ok()?, false),
    };
    let candidate = std::fs::canonicalize(candidate).ok()?;
    repo::find_workspace_root(&candidate).map(|p| InitialRepo {
        path: p.display().to_string(),
        explicit: is_explicit,
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenRepos::default())
        .invoke_handler(tauri::generate_handler![
            load_log,
            commit_diff,
            compare_diff,
            jj_duplicate_to,
            jj_revert,
            file_diff,
            file_text,
            conflict_hunks,
            tree_files,
            head_op_id,
            initial_repo,
            jj_bookmark_create,
            jj_bookmark_set,
            jj_bookmark_delete,
            jj_bookmark_track,
            jj_bookmark_untrack,
            jj_push_new_bookmark,
            jj_git_fetch,
            open_url,
            jj_git_push,
            jj_rebase,
            jj_undo,
            jj_redo,
            jj_new,
            jj_edit,
            jj_abandon,
            jj_describe,
            jj_duplicate,
            jj_absorb,
            jj_squash,
            jj_split,
            jj_resolve,
            jj_resolve_side,
            op_log,
            op_changes,
            jj_op_restore,
            jj_op_revert
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
