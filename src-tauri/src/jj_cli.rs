//! Mutations go through the user's installed `jj` binary rather than jj-lib,
//! so jj handles snapshotting, the op log, config and git credentials.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;

#[derive(Debug, Serialize)]
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

/// Common install locations, since GUI apps launched from Finder don't get
/// the shell's `PATH`.
fn known_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".nix-profile/bin"));
    }
    dirs.push(PathBuf::from("/usr/bin"));
    dirs
}

/// The user's login shell's `PATH`, which is their real one.
fn login_shell_path() -> Option<OsString> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_owned());
    // `printenv` rather than `$PATH`, which fish keeps as a list. The
    // last line, in case the profile prints something.
    let out = Command::new(shell).args(["-lc", "echo; printenv PATH"]).output().ok()?;
    let line = String::from_utf8_lossy(&out.stdout).lines().last()?.trim().to_owned();
    (!line.is_empty()).then(|| line.into())
}

/// Where to look for programs: the process `PATH`, then common install
/// locations, then the login shell's `PATH`. jj and git are given it as
/// their `PATH` too, so an alias that runs `jj` or another tool through
/// `jj util exec` finds it when the app was launched from Finder.
fn search_path() -> &'static OsStr {
    static SEARCH_PATH: OnceLock<OsString> = OnceLock::new();
    SEARCH_PATH.get_or_init(|| {
        let process = std::env::var_os("PATH");
        let login = login_shell_path();
        let mut seen = HashSet::new();
        let dirs = process
            .iter()
            .flat_map(std::env::split_paths)
            .chain(known_dirs())
            .chain(login.iter().flat_map(std::env::split_paths))
            // A folder with a `:` in it can't be on a `PATH`.
            .filter(|dir| {
                !dir.as_os_str().is_empty() && !dir.to_string_lossy().contains(':') && seen.insert(dir.clone())
            });
        std::env::join_paths(dirs).unwrap_or_default()
    })
}

fn find_binary(name: &str) -> Option<PathBuf> {
    std::env::split_paths(search_path())
        .map(|dir| dir.join(name))
        .find(|p| is_executable_file(p))
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
        .env("PATH", search_path())
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
        .env("PATH", search_path())
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

/// Change ids are jj's reverse hex, the letters `k` to `z`.
pub fn validate_change_id(id: &str) -> Result<()> {
    let ok = (1..=64).contains(&id.len()) && id.bytes().all(|b| (b'k'..=b'z').contains(&b));
    if !ok {
        bail!("change id must be reverse hex: {id:?}");
    }
    Ok(())
}

/// Prints the change id of `revision`, without snapshotting.
pub fn change_id_args(revision: &str) -> Result<Vec<String>> {
    validate_revision(revision)?;
    Ok(strings(&["log", "--no-graph", "--ignore-working-copy", "-r", revision, "-T", "change_id"]))
}

/// Describes the commit `jj split` put the remaining changes in. The first
/// commit keeps the change id, and the remainder is its only child: the
/// split commit's children were rebased onto the remainder.
pub fn describe_split_remainder_args(change_id: &str, message: &str) -> Result<Vec<String>> {
    validate_change_id(change_id)?;
    Ok(vec![
        "describe".to_owned(),
        format!("--message={message}"),
        format!("exactly(children(change_id({change_id})), 1)"),
    ])
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

/// Splits a command line into words as a shell would: whitespace separates
/// them, and quotes and backslashes keep it in one. Nothing is expanded.
pub fn split_words(line: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => words.extend(word.take()),
            '\'' => {
                let w = word.get_or_insert_with(String::new);
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => w.push(c),
                        None => bail!("unclosed ' quote"),
                    }
                }
            }
            '"' => {
                let w = word.get_or_insert_with(String::new);
                loop {
                    match chars.next() {
                        Some('"') => break,
                        // Inside double quotes a backslash only escapes " and \.
                        Some('\\') => match chars.next() {
                            Some(c @ ('"' | '\\')) => w.push(c),
                            Some(c) => {
                                w.push('\\');
                                w.push(c);
                            }
                            None => bail!("unclosed \" quote"),
                        },
                        Some(c) => w.push(c),
                        None => bail!("unclosed \" quote"),
                    }
                }
            }
            '\\' => match chars.next() {
                Some(c) => word.get_or_insert_with(String::new).push(c),
                None => bail!("trailing backslash"),
            },
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    words.extend(word);
    Ok(words)
}

/// The args for a command line typed by the user, with a leading `jj`
/// dropped and `$change_id` / `$commit_id` standing for the selected commit.
pub fn exec_args(line: &str, change_id: Option<&str>, commit_id: Option<&str>) -> Result<Vec<String>> {
    let mut words = split_words(line)?;
    if words.first().is_some_and(|w| w == "jj") {
        words.remove(0);
    }
    if words.is_empty() {
        bail!("no command given");
    }
    for word in &mut words {
        for (name, value) in [("$change_id", change_id), ("$commit_id", commit_id)] {
            if word.contains(name) {
                let value = value.ok_or_else(|| anyhow!("{name} needs a selected commit"))?;
                *word = word.replace(name, value);
            }
        }
    }
    Ok(words)
}

/// `jj workspace add --name <name> [-r <revision>] -- <destination>`.
pub fn workspace_add_args(name: &str, destination: &Path, revision: Option<&str>) -> Result<Vec<String>> {
    validate_ref_name(name)?;
    let destination = destination.to_str().ok_or_else(|| anyhow!("non-UTF-8 destination"))?;
    let mut args = vec!["workspace".to_owned(), "add".to_owned(), format!("--name={name}")];
    if let Some(revision) = revision {
        validate_revision(revision)?;
        args.extend(strings(&["-r", revision]));
    }
    args.extend(strings(&["--", destination]));
    Ok(args)
}

/// Where a new workspace goes when no folder is given: beside the repo's
/// folder, named after both, e.g. `~/code/jig-review` for `~/code/jig`.
pub fn default_workspace_dir(root: &Path, name: &str) -> Result<PathBuf> {
    let parent = root.parent().ok_or_else(|| anyhow!("the repo has no parent folder"))?;
    let base = root.file_name().ok_or_else(|| anyhow!("the repo has no folder name"))?;
    Ok(parent.join(format!("{}-{name}", base.to_string_lossy())))
}

/// Forgets workspace `name` and moves its folder to the Trash. Refuses the
/// workspace at `root` (or one containing it), and any folder holding the
/// repo itself rather than pointing at it.
pub fn delete_workspace(root: &Path, name: &str) -> Result<CommandOutput> {
    validate_ref_name(name)?;
    let located = run(root, &["workspace", "root", &format!("--name={name}")])?;
    let folder = located.success.then(|| PathBuf::from(located.stdout.trim()));
    if let Some(folder) = &folder {
        if std::fs::canonicalize(root)?.starts_with(folder) {
            bail!("{} holds this workspace, so it can't be deleted from here", folder.display());
        }
        // A secondary workspace's `.jj/repo` is a file pointing at the repo;
        // a directory there is the repo itself.
        if !folder.join(".jj/repo").is_file() {
            bail!("{} holds the repository itself, so it won't be deleted", folder.display());
        }
    }
    let mut combined = CommandOutput::empty();
    if !combined.append(run(root, &["workspace", "forget", "--", name])?) {
        return Ok(combined);
    }
    match folder {
        Some(folder) => {
            combined.command += &format!(" && move {} to the Trash", folder.display());
            if let Err(e) = move_to_trash(&folder) {
                combined.success = false;
                combined.stderr += &format!("Couldn't move {} to the Trash: {e}\n", folder.display());
            }
        }
        None => combined.stdout += "Its folder wasn't found, so the workspace was only forgotten.\n",
    }
    Ok(combined)
}

fn move_to_trash(path: &Path) -> Result<(), trash::Error> {
    #[allow(unused_mut)]
    let mut trash = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        // Finder would need permission to be scripted.
        trash.set_delete_method(DeleteMethod::NsFileManager);
    }
    trash.delete(path)
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

    /// `jj git init` in `dir`; false when jj isn't installed. Not [`run`],
    /// whose `-R` needs a repo to exist already.
    fn init_repo(dir: &Path) -> bool {
        let Ok(jj) = jj_binary() else { return false };
        let out = Command::new(jj).args(["git", "init"]).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        true
    }

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
        if init_repo(&dir) {
            let out = run(&dir, &["bookmark", "create", "foo", "-r", "@"]).unwrap();
            assert!(out.success, "{}", out.stderr);
            assert_eq!(out.command, "jj bookmark create foo -r @");
            // It exists now, so creating it again fails.
            let bad = run(&dir, &["bookmark", "create", "foo", "-r", "@"]).unwrap();
            assert!(!bad.success);
            // An alias that shells out can run jj, whatever PATH the app got.
            let nested = run(&dir, &["util", "exec", "--", "sh", "-c", "jj --version"]).unwrap();
            assert!(nested.success, "{}", nested.stderr);
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
        assert_eq!(
            describe_split_remainder_args("uyopuukr", "-second").unwrap(),
            v(&["describe", "--message=-second", "exactly(children(change_id(uyopuukr)), 1)"])
        );
        assert!(describe_split_remainder_args("abc", "m").is_err());
        assert!(describe_split_remainder_args("k)|all(", "m").is_err());
        assert!(change_id_args("@").is_err());
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
    fn word_splitting() {
        assert_eq!(split_words("  log -r  'a | b' ").unwrap(), v(&["log", "-r", "a | b"]));
        assert_eq!(split_words(r#"describe -m "say \"hi\" \n""#).unwrap(), v(&["describe", "-m", r#"say "hi" \n"#]));
        assert_eq!(split_words(r"a\ b c''d '' ").unwrap(), v(&["a b", "cd", ""]));
        assert_eq!(split_words("").unwrap(), Vec::<String>::new());
        for bad in ["'open", "\"open", "end\\"] {
            assert!(split_words(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn exec_arg_building() {
        assert_eq!(exec_args("jj my-alias", None, None).unwrap(), v(&["my-alias"]));
        assert_eq!(
            exec_args("new $change_id -m 'on $commit_id'", Some("kxyz"), Some("ab12")).unwrap(),
            v(&["new", "kxyz", "-m", "on ab12"])
        );
        assert!(exec_args("jj", None, None).is_err());
        assert!(exec_args("  ", None, None).is_err());
        assert!(exec_args("edit $change_id", None, None).is_err());
    }

    #[test]
    fn workspace_arg_building() {
        assert_eq!(
            workspace_add_args("review", Path::new("/x/jig-review"), Some("a1")).unwrap(),
            v(&["workspace", "add", "--name=review", "-r", "a1", "--", "/x/jig-review"])
        );
        assert_eq!(workspace_add_args("w", Path::new("-w"), None).unwrap(), v(&["workspace", "add", "--name=w", "--", "-w"]));
        assert!(workspace_add_args("-w", Path::new("/x"), None).is_err());
        assert!(workspace_add_args("w", Path::new("/x"), Some("@")).is_err());
        assert_eq!(default_workspace_dir(Path::new("/code/jig"), "review").unwrap(), PathBuf::from("/code/jig-review"));
    }

    #[test]
    fn workspace_delete_refusals_in_a_throwaway_repo() {
        let base = std::env::temp_dir().join(format!("jig-cli-ws-{}", std::process::id()));
        let dir = base.join("repo");
        std::fs::create_dir_all(&dir).unwrap();
        if init_repo(&dir) {
            let add = workspace_add_args("second", &base.join("second"), None).unwrap();
            let add: Vec<&str> = add.iter().map(String::as_str).collect();
            assert!(run(&dir, &add).unwrap().success);
            // The default workspace holds the repo; the second can't delete itself.
            let err = delete_workspace(&base.join("second"), "default").unwrap_err();
            assert!(err.to_string().contains("holds the repository itself"), "{err}");
            let err = delete_workspace(&base.join("second"), "second").unwrap_err();
            assert!(err.to_string().contains("holds this workspace"), "{err}");
            // A folder that's gone is only forgotten.
            std::fs::remove_dir_all(base.join("second")).unwrap();
            let out = delete_workspace(&dir, "second").unwrap();
            assert!(out.success, "{}", out.stderr);
            assert!(out.stdout.contains("only forgotten"));
            let list = run(&dir, &["workspace", "list", "-T", "name ++ \"\\n\""]).unwrap();
            assert_eq!(list.stdout.trim(), "default");
        }
        let _ = std::fs::remove_dir_all(&base);
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
        if init_repo(&dir) {
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
