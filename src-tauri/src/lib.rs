pub mod diff;
pub mod jj_cli;
pub mod layout;
pub mod repo;

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
        Ok(jj_cli::strings(&["bookmark", "track", &format!("{name}@{remote}")]))
    })
    .await
}

#[tauri::command]
async fn jj_git_fetch(path: String) -> Result<jj_cli::CommandOutput, String> {
    jj_in(path, || Ok(jj_cli::strings(&["git", "fetch"]))).await
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

#[derive(serde::Serialize)]
struct InitialRepo {
    path: String,
    /// Given on the command line or in `JORK_REPO`, rather than the current
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
        .or_else(|| std::env::var_os("JORK_REPO").map(PathBuf::from));
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
            file_text,
            tree_files,
            head_op_id,
            initial_repo,
            jj_bookmark_create,
            jj_bookmark_set,
            jj_bookmark_delete,
            jj_bookmark_track,
            jj_git_fetch,
            jj_git_push
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
