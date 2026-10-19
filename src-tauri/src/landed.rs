//! Local commits that already landed on a remote as other commits. A forge's
//! rebase-and-merge (GitLab's, GitHub's) rewrites commits without jj's
//! change-id header, so after a fetch jj can't tell the landed copies are
//! the same changes, and the local ones stay wherever a bookmark or a child
//! holds them. They match their copies by description and `git patch-id`.
//!
//! Replacing a leftover with its copy moves its bookmarks onto the copy,
//! rebases its children that haven't landed onto the copy, and abandons it.
//! Rebasing the leftovers onto the remote instead would conflict wherever
//! later work changed the same lines.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use serde::Serialize;

use crate::jj_cli::{self, strings};

/// Local commits that may have landed: on no remote, and neither empty nor
/// merges. Not `trunk()`-based, as some repos point trunk at a release
/// branch rather than where merges land.
const LOCAL: &str = "latest(mutable() ~ ::remote_bookmarks() ~ empty() ~ merges(), 500)";

/// Where their copies would be: on a remote, but not under the local work.
fn remote_revset() -> String {
    format!("latest(::remote_bookmarks() ~ ::({LOCAL}) ~ merges(), 5000)")
}

const COMMIT_TEMPLATE: &str = r#"commit_id ++ "\t" ++ change_id ++ "\t" ++ current_working_copy ++ "\t" ++ local_bookmarks.map(|b| b.name()).join(" ") ++ "\t" ++ description.escape_json() ++ "\n""#;

/// Each child as its change id, then each parent as `commit_id:change_id`.
const CHILD_TEMPLATE: &str =
    r#"change_id ++ "\t" ++ parents.map(|p| p.commit_id() ++ ":" ++ p.change_id()).join(" ") ++ "\n""#;

struct Commit {
    commit_id: String,
    change_id: String,
    working_copy: bool,
    bookmarks: Vec<String>,
    description: String,
}

/// A local commit, and the commit on a remote making the same change.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leftover {
    pub commit_id: String,
    pub change_id: String,
    pub summary: String,
    pub bookmarks: Vec<String>,
    pub landed_commit_id: String,
    pub landed_change_id: String,
    #[serde(skip)]
    working_copy: bool,
}

fn log(root: &Path, revset: &str, template: &str) -> Result<String> {
    let out = jj_cli::run(root, &["log", "--no-graph", "-r", revset, "-T", template])?;
    if !out.success {
        bail!("{}", out.stderr.trim());
    }
    Ok(out.stdout)
}

fn commits(root: &Path, revset: &str) -> Result<Vec<Commit>> {
    log(root, revset, COMMIT_TEMPLATE)?
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let fields: Vec<&str> = line.splitn(5, '\t').collect();
            let [commit_id, change_id, working_copy, bookmarks, description] = fields[..] else {
                bail!("unexpected jj log output: {line:?}");
            };
            Ok(Commit {
                commit_id: commit_id.to_owned(),
                change_id: change_id.to_owned(),
                working_copy: working_copy == "true",
                bookmarks: bookmarks.split_whitespace().map(str::to_owned).collect(),
                description: serde_json::from_str(description)?,
            })
        })
        .collect()
}

fn git_dir(root: &Path) -> Result<PathBuf> {
    let out = jj_cli::run(root, &["git", "root"])?;
    if !out.success {
        bail!("{}", out.stderr.trim());
    }
    Ok(PathBuf::from(out.stdout.trim()))
}

/// Local commits that already landed on a remote, newest first.
pub fn find(root: &Path) -> Result<Vec<Leftover>> {
    let local = commits(root, LOCAL)?;
    if local.is_empty() {
        return Ok(Vec::new());
    }
    let mut remote: HashMap<String, Vec<Commit>> = HashMap::new();
    for commit in commits(root, &remote_revset())? {
        if !commit.description.trim().is_empty() {
            remote.entry(commit.description.clone()).or_default().push(commit);
        }
    }
    let git_dir = git_dir(root)?;
    let mut patch_ids: HashMap<String, Option<String>> = HashMap::new();
    let mut patch_id = |commit: &str| -> Result<Option<String>> {
        if let Some(id) = patch_ids.get(commit) {
            return Ok(id.clone());
        }
        let id = jj_cli::git_patch_id(&git_dir, commit)?;
        patch_ids.insert(commit.to_owned(), id.clone());
        Ok(id)
    };
    let mut leftovers = Vec::new();
    for commit in local {
        // Only commits sharing a description are worth diffing.
        let Some(candidates) = remote.get(&commit.description) else { continue };
        let Some(id) = patch_id(&commit.commit_id)? else { continue };
        for candidate in candidates {
            if patch_id(&candidate.commit_id)?.as_ref() == Some(&id) {
                leftovers.push(Leftover {
                    summary: commit.description.lines().next().unwrap_or_default().to_owned(),
                    commit_id: commit.commit_id,
                    change_id: commit.change_id,
                    bookmarks: commit.bookmarks,
                    landed_commit_id: candidate.commit_id.clone(),
                    landed_change_id: candidate.change_id.clone(),
                    working_copy: commit.working_copy,
                });
                break;
            }
        }
    }
    Ok(leftovers)
}

/// The jj commands that replace each leftover with its landed copy, in order.
pub fn replace_commands(root: &Path, leftovers: &[Leftover]) -> Result<Vec<Vec<String>>> {
    if leftovers.is_empty() {
        return Ok(Vec::new());
    }
    let landed: HashMap<&str, &str> =
        leftovers.iter().map(|l| (l.commit_id.as_str(), l.landed_commit_id.as_str())).collect();
    let mut commands = Vec::new();

    for leftover in leftovers {
        for name in &leftover.bookmarks {
            jj_cli::validate_ref_name(name)?;
            commands.push(strings(&["bookmark", "set", "--allow-backwards", "-r", &leftover.landed_commit_id, "--", name]));
        }
    }

    // Children that haven't landed move onto their parents' copies. Their
    // other parents, and the children themselves, go by change id, since
    // rebasing one child can rewrite another below it.
    let ids = leftovers.iter().map(|l| l.commit_id.as_str()).collect::<Vec<_>>().join(" | ");
    let children = log(root, &format!("children({ids}) ~ ({ids})"), CHILD_TEMPLATE)?;
    for line in children.lines().filter(|line| !line.is_empty()) {
        let Some((child, parents)) = line.split_once('\t') else { bail!("unexpected jj log output: {line:?}") };
        jj_cli::validate_change_id(child)?;
        let mut args = strings(&["rebase", "--source", child]);
        for parent in parents.split_whitespace() {
            let Some((commit_id, change_id)) = parent.split_once(':') else { bail!("unexpected parent: {parent:?}") };
            let onto = match landed.get(commit_id) {
                Some(copy) => copy.to_string(),
                None => {
                    jj_cli::validate_change_id(change_id)?;
                    change_id.to_owned()
                }
            };
            if !args.contains(&onto) {
                args.extend(["--onto".to_owned(), onto]);
            }
        }
        commands.push(args);
    }

    // A working copy that landed starts again on top of its copy.
    if let Some(leftover) = leftovers.iter().find(|l| l.working_copy) {
        commands.push(strings(&["new", &leftover.landed_commit_id]));
    }

    let mut abandon = strings(&["abandon"]);
    for leftover in leftovers {
        jj_cli::validate_change_id(&leftover.change_id)?;
        abandon.push(leftover.change_id.clone());
    }
    commands.push(abandon);
    Ok(commands)
}
