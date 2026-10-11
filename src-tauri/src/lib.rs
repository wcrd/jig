pub mod layout;
pub mod repo;

use std::path::PathBuf;

/// Rows beyond this are dropped; the frontend says the view is truncated.
const DEFAULT_LIMIT: usize = 20_000;

#[tauri::command]
async fn load_log(
    path: String,
    revset: Option<String>,
    limit: Option<usize>,
) -> Result<repo::LogResponse, String> {
    // jj-lib's futures aren't Send, so run them on a blocking thread.
    tauri::async_runtime::spawn_blocking(move || {
        repo::load_log(
            &PathBuf::from(path),
            revset.as_deref(),
            limit.unwrap_or(DEFAULT_LIMIT),
        )
        .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn head_op_id(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        repo::head_op_id(&PathBuf::from(path)).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
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
        .invoke_handler(tauri::generate_handler![load_log, head_op_id, initial_repo])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
