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
        // If jj ever tries to launch an editor, give it a no-op instead of
        // hanging the app waiting on one.
        .env("JJ_EDITOR", "true")
        .env("EDITOR", "true")
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

fn validate_revisions(revisions: &[String]) -> Result<()> {
    if revisions.is_empty() {
        bail!("at least one revision is required");
    }
    revisions.iter().try_for_each(|r| validate_revision(r))
}

/// Pushes `flag value` for each revision.
fn push_flagged(args: &mut Vec<String>, flag: &str, revisions: &[String]) {
    for r in revisions {
        args.push(flag.to_owned());
        args.push(r.clone());
    }
}

pub fn rebase_args(
    revisions: &[String],
    mode: &str,
    target: &str,
    placement: &str,
) -> Result<Vec<String>> {
    validate_revisions(revisions)?;
    validate_revision(target)?;
    let mode_flag = match mode {
        "revision" => "--revision",
        "source" => "--source",
        "branch" => "--branch",
        _ => bail!("unknown rebase mode: {mode:?}"),
    };
    let placement_flag = match placement {
        "onto" => "--onto",
        "after" => "--insert-after",
        "before" => "--insert-before",
        _ => bail!("unknown rebase placement: {placement:?}"),
    };
    let mut args = strings(&["rebase"]);
    push_flagged(&mut args, mode_flag, revisions);
    args.push(placement_flag.to_owned());
    args.push(target.to_owned());
    Ok(args)
}

/// `jj <command> <revisions…>`, for commands taking revsets positionally.
pub fn revisions_args(command: &str, revisions: &[String]) -> Result<Vec<String>> {
    validate_revisions(revisions)?;
    let mut args = strings(&[command]);
    args.extend(revisions.iter().cloned());
    Ok(args)
}

pub fn edit_args(revision: &str) -> Result<Vec<String>> {
    validate_revision(revision)?;
    Ok(strings(&["edit", revision]))
}

pub fn describe_args(revision: &str, message: &str) -> Result<Vec<String>> {
    validate_revision(revision)?;
    // `--message=<text>` so text starting with `-` isn't read as a flag.
    Ok(vec![
        "describe".to_owned(),
        format!("--message={message}"),
        revision.to_owned(),
    ])
}

pub fn absorb_args(revision: &str) -> Result<Vec<String>> {
    validate_revision(revision)?;
    Ok(strings(&["absorb", "--from", revision]))
}

pub fn squash_args(revision: &str, into: &str, paths: &[String]) -> Result<Vec<String>> {
    validate_revision(revision)?;
    validate_revision(into)?;
    for p in paths {
        if p.is_empty() || p.starts_with('-') {
            bail!("invalid path: {p:?}");
        }
    }
    let mut args = strings(&[
        "squash",
        "--from",
        revision,
        "--into",
        into,
        "--use-destination-message",
    ]);
    if !paths.is_empty() {
        args.push("--".to_owned());
        args.extend(paths.iter().cloned());
    }
    Ok(args)
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

    fn v(xs: &[&str]) -> Vec<String> {
        strings(xs)
    }

    #[test]
    fn rebase_arg_building() {
        assert_eq!(
            rebase_args(&v(&["a1", "b2"]), "revision", "c3", "onto").unwrap(),
            v(&["rebase", "--revision", "a1", "--revision", "b2", "--onto", "c3"])
        );
        assert_eq!(
            rebase_args(&v(&["a1"]), "source", "c3", "after").unwrap(),
            v(&["rebase", "--source", "a1", "--insert-after", "c3"])
        );
        assert_eq!(
            rebase_args(&v(&["a1"]), "branch", "c3", "before").unwrap(),
            v(&["rebase", "--branch", "a1", "--insert-before", "c3"])
        );
        assert!(rebase_args(&[], "revision", "c3", "onto").is_err());
        assert!(rebase_args(&v(&["a1"]), "x", "c3", "onto").is_err());
        assert!(rebase_args(&v(&["a1"]), "revision", "c3", "x").is_err());
        assert!(rebase_args(&v(&["@"]), "revision", "c3", "onto").is_err());
        assert!(rebase_args(&v(&["a1"]), "revision", "main", "onto").is_err());
    }

    #[test]
    fn simple_arg_building() {
        assert_eq!(revisions_args("new", &v(&["a1", "b2"])).unwrap(), v(&["new", "a1", "b2"]));
        assert!(revisions_args("abandon", &[]).is_err());
        assert!(revisions_args("duplicate", &v(&["zz"])).is_err());
        assert_eq!(edit_args("a1").unwrap(), v(&["edit", "a1"]));
        assert!(edit_args("@").is_err());
        assert_eq!(absorb_args("a1").unwrap(), v(&["absorb", "--from", "a1"]));
        assert!(absorb_args("").is_err());
    }

    #[test]
    fn describe_arg_building() {
        assert_eq!(
            describe_args("a1", "-x\nline 2 \"q\" $HOME").unwrap(),
            vec!["describe".to_owned(), "--message=-x\nline 2 \"q\" $HOME".to_owned(), "a1".to_owned()]
        );
        assert_eq!(describe_args("a1", "").unwrap()[1], "--message=");
        assert!(describe_args("nope", "m").is_err());
    }

    #[test]
    fn squash_arg_building() {
        assert_eq!(
            squash_args("a1", "b2", &[]).unwrap(),
            v(&["squash", "--from", "a1", "--into", "b2", "--use-destination-message"])
        );
        assert_eq!(
            squash_args("a1", "b2", &v(&["src/x.rs"])).unwrap(),
            v(&["squash", "--from", "a1", "--into", "b2", "--use-destination-message", "--", "src/x.rs"])
        );
        assert!(squash_args("a1", "b2", &v(&["-x"])).is_err());
        assert!(squash_args("a1", "b2", &v(&[""])).is_err());
        assert!(squash_args("a1", "main", &[]).is_err());
    }

    #[test]
    fn rebase_and_undo_in_a_throwaway_repo() {
        let dir = std::env::temp_dir().join(format!("jork-cli-rebase-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = matches!(run(&dir, &["git", "init"]), Ok(o) if o.success);
        if ok {
            let commit_id = |rev: &str| {
                let o = run(&dir, &["log", "--no-graph", "-r", rev, "-T", "commit_id"]).unwrap();
                assert!(o.success, "{}", o.stderr);
                o.stdout.trim().to_owned()
            };
            let go = |args: Vec<String>| {
                let a: Vec<&str> = args.iter().map(String::as_str).collect();
                let o = run(&dir, &a).unwrap();
                assert!(o.success, "{}: {}", o.command, o.stderr);
            };
            go(describe_args(&commit_id("@"), "first").unwrap());
            go(revisions_args("new", &[commit_id("@")]).unwrap());
            go(describe_args(&commit_id("@"), "second\nbody").unwrap());
            let second = commit_id("@");
            let first = commit_id("@-");
            // Rebase `second` onto the root's child sibling: make a sibling of `first`.
            go(revisions_args("new", &[commit_id("root()")]).unwrap());
            go(describe_args(&commit_id("@"), "third").unwrap());
            let third = commit_id("@");
            let before = commit_id(&format!("parents({second})"));
            assert_eq!(before, first);
            go(rebase_args(&[second.clone()], "source", &third, "onto").unwrap());
            let after = run(&dir, &["log", "--no-graph", "-r", "description(substring:'second')", "-T", "parents.map(|p| p.description().first_line())"]).unwrap();
            assert_eq!(after.stdout.trim(), "third");
            go(strings(&["undo"]));
            let undone = run(&dir, &["log", "--no-graph", "-r", "description(substring:'second')", "-T", "parents.map(|p| p.description().first_line())"]).unwrap();
            assert_eq!(undone.stdout.trim(), "first");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
