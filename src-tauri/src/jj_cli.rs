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

/// Looks for `name` on the process `PATH`.
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| is_executable_file(p))
}

/// Common install locations, since GUI apps launched from Finder don't get
/// the shell's `PATH`.
fn find_in_known_dirs(name: &str) -> Option<PathBuf> {
    let mut dirs = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".nix-profile/bin"));
    }
    dirs.push(PathBuf::from("/usr/bin"));
    dirs.into_iter().map(|dir| dir.join(name)).find(|p| is_executable_file(p))
}

/// Last resort: ask the user's login shell, which has their real `PATH`.
fn find_via_login_shell(name: &str) -> Option<PathBuf> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_owned());
    let out = Command::new(shell)
        .args(["-lc", &format!("command -v {name}")])
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

fn find_binary(name: &str) -> Option<PathBuf> {
    find_on_path(name)
        .or_else(|| find_in_known_dirs(name))
        .or_else(|| find_via_login_shell(name))
}

/// The `jj` binary, looked up once.
fn jj_binary() -> Result<&'static Path> {
    static JJ: OnceLock<Option<PathBuf>> = OnceLock::new();
    JJ.get_or_init(|| find_binary("jj"))
        .as_deref()
        .ok_or_else(|| anyhow!("could not find the `jj` binary; install jj or add it to your PATH"))
}

/// The `git` binary, looked up once.
fn git_binary() -> Result<&'static Path> {
    static GIT: OnceLock<Option<PathBuf>> = OnceLock::new();
    GIT.get_or_init(|| find_binary("git"))
        .as_deref()
        .ok_or_else(|| anyhow!("could not find the `git` binary; install git or add it to your PATH"))
}

/// Runs `jj --no-pager --color never -R <root> <args…>` in `root`. Only a
/// failure to spawn is an `Err`; a non-zero exit is `success: false`.
pub fn run(root: &Path, args: &[&str]) -> Result<CommandOutput> {
    run_with_config(root, &[], args)
}

/// Like [`run`], with `--config <NAME=VALUE>` for each of `configs`.
pub fn run_with_config(root: &Path, configs: &[String], args: &[&str]) -> Result<CommandOutput> {
    let jj = jj_binary()?;
    let output = Command::new(jj)
        .args(["--no-pager", "--color", "never"])
        .args(configs.iter().flat_map(|c| ["--config", c.as_str()]))
        .arg("-R")
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

/// Runs `git --git-dir=<git_dir> <args…>` in `root`, for what jj can't do
/// yet. Like [`run`], a non-zero exit is `success: false`.
pub fn run_git(root: &Path, git_dir: &Path, args: &[&str]) -> Result<CommandOutput> {
    let git = git_binary()?;
    let output = Command::new(git)
        .arg(format!("--git-dir={}", git_dir.display()))
        .args(args)
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        // Fail rather than wait for a username or password nobody can type.
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .with_context(|| format!("failed to run {}", git.display()))?;
    Ok(CommandOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        command: format!("git {}", args.join(" ")),
    })
}

impl CommandOutput {
    /// An empty, successful result to append commands to.
    pub fn empty() -> Self {
        CommandOutput { success: true, stdout: String::new(), stderr: String::new(), command: String::new() }
    }

    /// Appends `next` as a following command; false if it failed.
    pub fn append(&mut self, next: CommandOutput) -> bool {
        self.command += &if self.command.is_empty() { next.command } else { format!(" && {}", next.command) };
        self.stdout += &next.stdout;
        self.stderr += &next.stderr;
        self.success &= next.success;
        next.success
    }
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

/// `jj rebase --source revision --onto p1 --onto p2 ...`: replaces the
/// commit's parents, its descendants coming along.
pub fn set_parents_args(revision: &str, parents: &[String]) -> Result<Vec<String>> {
    validate_revision(revision)?;
    validate_revisions(parents)?;
    let mut args = strings(&["rebase", "--source", revision]);
    push_flagged(&mut args, "--onto", parents);
    Ok(args)
}

fn placement_flag(placement: &str) -> Result<&'static str> {
    Ok(match placement {
        "onto" => "--onto",
        "after" => "--insert-after",
        "before" => "--insert-before",
        _ => bail!("unknown placement: {placement:?}"),
    })
}

/// `jj duplicate` (cherry-pick) or `jj revert` of `revisions`, placed onto,
/// after or before `target`.
pub fn placed_args(
    command: &str,
    revisions: &[String],
    target: &str,
    placement: &str,
) -> Result<Vec<String>> {
    validate_revisions(revisions)?;
    validate_revision(target)?;
    let flag = placement_flag(placement)?;
    let mut args = strings(&[command]);
    match command {
        // revert takes its revisions with -r; duplicate takes them positionally.
        "revert" => push_flagged(&mut args, "--revision", revisions),
        "duplicate" => args.extend(revisions.iter().cloned()),
        _ => bail!("unsupported command: {command}"),
    }
    args.push(flag.to_owned());
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

/// Hex operation ids only (`@`, `-` and other op-set syntax are rejected).
pub fn validate_op_id(id: &str) -> Result<()> {
    // Full operation ids are 128 hex digits.
    let ok = (1..=128).contains(&id.len()) && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !ok {
        bail!("operation id must be hex: {id:?}");
    }
    Ok(())
}

/// `jj operation restore|revert <op>`.
pub fn op_args(subcommand: &str, op_id: &str) -> Result<Vec<String>> {
    validate_op_id(op_id)?;
    Ok(strings(&["operation", subcommand, op_id]))
}

/// The `--config` values that make `program` act as the `jig-split` diff
/// editor, plus the args for `jj split`.
pub fn split_args(
    revision: &str,
    message: Option<&str>,
    program: &Path,
    plan: &Path,
) -> Result<(Vec<String>, Vec<String>)> {
    validate_revision(revision)?;
    let quote = |s: &str| serde_json::to_string(s).expect("string serializes");
    let program = program.to_str().ok_or_else(|| anyhow!("non-UTF-8 program path"))?;
    let plan = plan.to_str().ok_or_else(|| anyhow!("non-UTF-8 plan path"))?;
    // TOML values: a JSON string / array of strings is valid TOML.
    let configs = vec![
        format!("merge-tools.jig-split.program={}", quote(program)),
        format!(
            "merge-tools.jig-split.edit-args=[{}, {}, \"$left\", \"$right\"]",
            quote("--split-plan"),
            quote(plan)
        ),
    ];
    let mut args = strings(&["split", "--revision", revision, "--tool", "jig-split"]);
    if let Some(m) = message {
        args.push(format!("--message={m}"));
    }
    Ok((configs, args))
}

/// A fileset matching exactly the file at `path` (relative to the repo root).
fn root_file_fileset(path: &str) -> Result<String> {
    if path.is_empty() || path.starts_with('-') || path.contains('\0') {
        bail!("invalid path: {path:?}");
    }
    // Fileset string literals take JSON-style escapes.
    Ok(format!(
        "root-file:{}",
        serde_json::to_string(path).expect("string serializes")
    ))
}

/// The `--config` values that make `program` act as the `jig-resolve` merge
/// tool (writing `content` into `$output`), plus the args for `jj resolve`.
pub fn resolve_args(
    revision: &str,
    file_path: &str,
    program: &Path,
    content: &Path,
) -> Result<(Vec<String>, Vec<String>)> {
    validate_revision(revision)?;
    let fileset = root_file_fileset(file_path)?;
    let quote = |s: &str| serde_json::to_string(s).expect("string serializes");
    let program = program.to_str().ok_or_else(|| anyhow!("non-UTF-8 program path"))?;
    let content = content.to_str().ok_or_else(|| anyhow!("non-UTF-8 content path"))?;
    let configs = vec![
        format!("merge-tools.jig-resolve.program={}", quote(program)),
        format!(
            "merge-tools.jig-resolve.merge-args=[{}, {}, \"$output\"]",
            quote("--resolve-output"),
            quote(content)
        ),
        "merge-tools.jig-resolve.merge-tool-edits-conflict-markers=false".to_owned(),
    ];
    let args = vec![
        "resolve".to_owned(),
        "--revision".to_owned(),
        revision.to_owned(),
        "--tool".to_owned(),
        "jig-resolve".to_owned(),
        "--".to_owned(),
        fileset,
    ];
    Ok((configs, args))
}

/// `jj resolve` taking one whole side (`ours` is side #1, `theirs` side #2).
pub fn resolve_side_args(revision: &str, file_path: &str, side: &str) -> Result<Vec<String>> {
    validate_revision(revision)?;
    let tool = match side {
        "ours" => ":ours",
        "theirs" => ":theirs",
        _ => bail!("unknown side: {side:?}"),
    };
    Ok(vec![
        "resolve".to_owned(),
        "--revision".to_owned(),
        revision.to_owned(),
        "--tool".to_owned(),
        tool.to_owned(),
        "--".to_owned(),
        root_file_fileset(file_path)?,
    ])
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
    fn placed_arg_building() {
        let revs = vec!["a1".to_owned()];
        assert_eq!(
            placed_args("revert", &revs, "c3", "onto").unwrap(),
            strings(&["revert", "--revision", "a1", "--onto", "c3"])
        );
        assert_eq!(
            placed_args("duplicate", &revs, "c3", "before").unwrap(),
            strings(&["duplicate", "a1", "--insert-before", "c3"])
        );
        assert!(placed_args("revert", &revs, "c3", "sideways").is_err());
        assert!(placed_args("abandon", &revs, "c3", "onto").is_err());
        assert!(placed_args("revert", &[], "c3", "onto").is_err());
    }

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
        let dir = std::env::temp_dir().join(format!("jig-cli-test-{}", std::process::id()));
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
        assert_eq!(
            set_parents_args("a1", &v(&["b2", "c3"])).unwrap(),
            v(&["rebase", "--source", "a1", "--onto", "b2", "--onto", "c3"])
        );
        assert!(set_parents_args("a1", &[]).is_err());
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
    fn op_and_split_arg_building() {
        assert_eq!(
            op_args("restore", "abc123").unwrap(),
            v(&["operation", "restore", "abc123"])
        );
        assert!(op_args("revert", "@").is_err());
        assert!(op_args("revert", "").is_err());
        assert!(op_args("revert", &"a".repeat(129)).is_err());
        let (configs, args) =
            split_args("a1", Some("-m"), Path::new("/x y/jig"), Path::new("/tmp/p.json")).unwrap();
        assert_eq!(
            configs,
            v(&[
                r#"merge-tools.jig-split.program="/x y/jig""#,
                r#"merge-tools.jig-split.edit-args=["--split-plan", "/tmp/p.json", "$left", "$right"]"#,
            ])
        );
        assert_eq!(
            args,
            v(&["split", "--revision", "a1", "--tool", "jig-split", "--message=-m"])
        );
        assert!(split_args("main", None, Path::new("/j"), Path::new("/p")).is_err());
    }

    #[test]
    fn resolve_arg_building() {
        let (configs, args) =
            resolve_args("a1", "dir/x \"y\".txt", Path::new("/x y/jig"), Path::new("/tmp/c")).unwrap();
        assert_eq!(
            configs,
            v(&[
                r#"merge-tools.jig-resolve.program="/x y/jig""#,
                r#"merge-tools.jig-resolve.merge-args=["--resolve-output", "/tmp/c", "$output"]"#,
                "merge-tools.jig-resolve.merge-tool-edits-conflict-markers=false",
            ])
        );
        assert_eq!(
            args,
            v(&[
                "resolve", "--revision", "a1", "--tool", "jig-resolve", "--",
                r#"root-file:"dir/x \"y\".txt""#,
            ])
        );
        for bad in ["", "-x", "a\0b"] {
            assert!(resolve_args("a1", bad, Path::new("/j"), Path::new("/c")).is_err());
        }
        assert!(resolve_args("main", "x", Path::new("/j"), Path::new("/c")).is_err());
        assert_eq!(
            resolve_side_args("a1", "x.txt", "ours").unwrap(),
            v(&["resolve", "--revision", "a1", "--tool", ":ours", "--", r#"root-file:"x.txt""#])
        );
        assert_eq!(resolve_side_args("a1", "x.txt", "theirs").unwrap()[4], ":theirs");
        assert!(resolve_side_args("a1", "x.txt", "mine").is_err());
        assert!(resolve_side_args("a1", "", "ours").is_err());
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
        let dir = std::env::temp_dir().join(format!("jig-cli-rebase-{}", std::process::id()));
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
