//! Mutations go through the user's installed `jj` binary rather than jj-lib,
//! so jj handles snapshotting, the op log, config and git credentials.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    /// For display, e.g. `jj bookmark create foo -r abc123`.
    pub command: String,
}

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Looks for `jj` on the process `PATH`.
fn find_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("jj"))
        .find(|p| is_executable_file(p))
}

/// Common install locations, since GUI apps launched from Finder don't get
/// the shell's `PATH`.
fn find_in_known_dirs() -> Option<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/jj"),
        PathBuf::from("/usr/local/bin/jj"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".cargo/bin/jj"));
        candidates.push(home.join(".local/bin/jj"));
        candidates.push(home.join(".nix-profile/bin/jj"));
    }
    candidates.into_iter().find(|p| is_executable_file(p))
}

/// Last resort: ask the user's login shell, which has their real `PATH`.
fn find_via_login_shell() -> Option<PathBuf> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_owned());
    let out = Command::new(shell)
        .args(["-lc", "command -v jj"])
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .last()?
        .trim()
        .to_owned();
    let path = PathBuf::from(line);
    (path.is_absolute() && is_executable_file(&path)).then_some(path)
}

/// The `jj` binary, looked up once.
fn jj_binary() -> Result<&'static Path> {
    static JJ: OnceLock<Option<PathBuf>> = OnceLock::new();
    JJ.get_or_init(|| {
        find_on_path()
            .or_else(find_in_known_dirs)
            .or_else(find_via_login_shell)
    })
    .as_deref()
    .ok_or_else(|| anyhow!("could not find the `jj` binary; install jj or add it to your PATH"))
}

/// Runs `jj --no-pager --color never -R <root> <args…>` in `root`. Only a
/// failure to spawn is an `Err`; a non-zero exit is `success: false`.
pub fn run(root: &Path, args: &[&str]) -> Result<CommandOutput> {
    let jj = jj_binary()?;
    let output = Command::new(jj)
        .args(["--no-pager", "--color", "never", "-R"])
        .arg(root)
        .args(args)
        .current_dir(root)
        // There's no terminal to answer prompts, so fail rather than hang.
        .stdin(std::process::Stdio::null())
        .output()
        .with_context(|| format!("failed to run {}", jj.display()))?;
    Ok(CommandOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        command: format!("jj {}", args.join(" ")),
    })
}

/// Owned copies of literal args, for passing across the blocking boundary.
pub fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).to_owned()).collect()
}

/// Bookmark, tag and remote names: no whitespace or control characters, and
/// no leading `-` so they can't be parsed as flags.
pub fn validate_ref_name(name: &str) -> Result<()> {
    if name.is_empty() {
        bail!("name must not be empty");
    }
    if name.starts_with('-') {
        bail!("name must not start with `-`: {name}");
    }
    if name.chars().any(|c| c.is_whitespace() || c.is_control()) {
        bail!("name must not contain whitespace or control characters: {name:?}");
    }
    Ok(())
}

/// Revisions are passed as hex commit ids only, never revset expressions.
pub fn validate_revision(revision: &str) -> Result<()> {
    let ok = (1..=64).contains(&revision.len())
        && revision.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !ok {
        bail!("revision must be a hex commit id: {revision:?}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_names() {
        assert!(validate_ref_name("main").is_ok());
        assert!(validate_ref_name("feature/foo-bar").is_ok());
        assert!(validate_ref_name("origin").is_ok());
        for bad in ["", "-x", "--help", "a b", "a\tb", "a\nb", "a\u{7}b"] {
            assert!(validate_ref_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn revisions() {
        assert!(validate_revision("abc123").is_ok());
        assert!(validate_revision(&"f".repeat(64)).is_ok());
        for bad in ["", "ABC", "xyz", "@", "main", "a-b", "a b", &"f".repeat(65)] {
            assert!(validate_revision(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn runs_jj_in_a_throwaway_repo() {
        let dir = std::env::temp_dir().join(format!("jork-cli-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let init = run(&dir, &["git", "init"]);
        if let Ok(init) = init {
            if init.success {
                let out = run(&dir, &["bookmark", "create", "foo", "-r", "@"]).unwrap();
                assert!(out.success, "{}", out.stderr);
                assert_eq!(out.command, "jj bookmark create foo -r @");
                let bad = run(&dir, &["bookmark", "delete", "nope"]).unwrap();
                assert!(!bad.success);
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
