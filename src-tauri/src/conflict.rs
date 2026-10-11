//! Conflicted files split into alternating resolved and conflicting hunks,
//! exactly as jj's file merge sees them, for the conflict editor.

use std::sync::Arc;

use anyhow::{Result, anyhow};
use bstr::{BString, ByteSlice};
use jj_lib::backend::CommitId;
use jj_lib::conflicts::{MaterializedFileConflictValue, try_materialize_file_conflict_value};
use jj_lib::files::{self, MergeResult};
use jj_lib::merge::Merge;
use jj_lib::repo::{ReadonlyRepo, Repo};
use jj_lib::repo_path::RepoPathBuf;
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    /// An ordinary two-sided text-file conflict, the only kind the editor handles.
    pub supported: bool,
    pub labels: Vec<String>,
    pub base_label: String,
    pub hunks: Vec<ConflictHunk>,
    pub executable: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConflictHunk {
    Resolved {
        text: String,
    },
    Conflict {
        /// One per base.
        base: Vec<String>,
        /// One per side.
        sides: Vec<String>,
    },
}

impl ConflictFile {
    fn unsupported() -> ConflictFile {
        ConflictFile {
            supported: false,
            labels: vec![],
            base_label: "Base".to_owned(),
            hunks: vec![],
            executable: false,
        }
    }
}

fn text(bytes: &BString) -> String {
    bytes.to_str_lossy().into_owned()
}

/// Hunks of a two-sided merge, resolved and conflicting regions alternating.
fn hunks_of(result: MergeResult) -> Vec<ConflictHunk> {
    match result {
        MergeResult::Resolved(content) => vec![ConflictHunk::Resolved { text: text(&content) }],
        MergeResult::Conflict(hunks) => hunks
            .into_iter()
            .map(|hunk| match hunk.as_resolved() {
                Some(content) => ConflictHunk::Resolved { text: text(content) },
                None => ConflictHunk::Conflict {
                    base: hunk.removes().map(text).collect(),
                    sides: hunk.adds().map(text).collect(),
                },
            })
            .collect(),
    }
}

fn conflict_file(
    file: &MaterializedFileConflictValue,
    options: &jj_lib::tree_merge::MergeOptions,
) -> ConflictFile {
    let contents: &Merge<BString> = &file.contents;
    if contents.num_sides() != 2 {
        return ConflictFile::unsupported();
    }
    // Binary content can't be edited as text.
    if contents.iter().any(|c| c.contains(&0)) {
        return ConflictFile::unsupported();
    }
    let labels = (0..2)
        .map(|i| {
            file.labels
                .get_add(i)
                .filter(|l| !l.is_empty())
                .map_or_else(|| format!("Side {}", i + 1), str::to_owned)
        })
        .collect();
    let base_label = file
        .labels
        .get_remove(0)
        .filter(|l| !l.is_empty())
        .unwrap_or("Base")
        .to_owned();
    ConflictFile {
        supported: true,
        labels,
        base_label,
        hunks: hunks_of(files::merge_hunks(contents, options)),
        executable: file.executable.unwrap_or(false),
    }
}

pub async fn conflict_hunks(
    repo: &Arc<ReadonlyRepo>,
    commit_hex: &str,
    file_path: &str,
) -> Result<ConflictFile> {
    let id = CommitId::try_from_hex(commit_hex).ok_or_else(|| anyhow!("bad commit id"))?;
    let commit = repo.store().get_commit_async(&id).await?;
    let path = RepoPathBuf::from_internal_string(file_path)?;
    let tree = commit.tree();
    let value = tree.path_value(&path).await?;
    let Some(file) =
        try_materialize_file_conflict_value(repo.store(), &path, &value, tree.labels()).await?
    else {
        return Ok(ConflictFile::unsupported());
    };
    Ok(conflict_file(&file, repo.store().merge_options()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jj_lib::files::FileMergeHunkLevel;
    use jj_lib::merge::SameChange;
    use jj_lib::tree_merge::MergeOptions;

    #[test]
    fn splits_into_hunks() {
        let options = MergeOptions { hunk_level: FileMergeHunkLevel::Line, same_change: SameChange::Accept };
        let merge = Merge::from_vec(vec![
            BString::from("1\nA\n3\n4\nX\n"),
            BString::from("1\n2\n3\n4\n5\n"),
            BString::from("1\nB\n3\n4\nX\n"),
        ]);
        let hunks = hunks_of(files::merge_hunks(&merge, &options));
        assert_eq!(
            hunks,
            vec![
                ConflictHunk::Resolved { text: "1\n".into() },
                ConflictHunk::Conflict {
                    base: vec!["2\n".into()],
                    sides: vec!["A\n".into(), "B\n".into()]
                },
                ConflictHunk::Resolved { text: "3\n4\nX\n".into() },
            ]
        );
        let json = serde_json::to_string(&hunks[0]).unwrap();
        assert_eq!(json, r#"{"kind":"resolved","text":"1\n"}"#);
    }

    /// End to end against a throwaway repo: a merge of two siblings that edit
    /// the same line, resolved through the same invocation `jj_resolve` uses.
    #[test]
    fn hunks_and_resolve_in_a_throwaway_repo() {
        use crate::jj_cli;
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("jig-conflict-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if !matches!(jj_cli::run(&dir, &["git", "init"]), Ok(o) if o.success) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let go = |args: &[&str]| {
            let o = jj_cli::run(&dir, args).unwrap();
            assert!(o.success, "{}: {}", o.command, o.stderr);
            o.stdout
        };
        let id = |rev: &str| go(&["log", "--no-graph", "-r", rev, "-T", "commit_id"]).trim().to_owned();
        let file = dir.join("f.txt");
        let base = "1\nsame\n3\n4\n5\n6\n7\n8\nend\n";
        std::fs::write(&file, base).unwrap();
        go(&["describe", "-m", "base"]);
        go(&["new", "-m", "side a"]);
        std::fs::write(&file, base.replace("same\n", "from a\n").replace("end", "end a")).unwrap();
        let a = id("@");
        go(&["new", &id("@-"), "-m", "side b"]);
        std::fs::write(&file, base.replace("same\n", "from b\n")).unwrap();
        let b = id("@");
        go(&["new", &a, &b, "-m", "merge"]);
        let merge = id("@");

        let (_, open) = crate::repo::load_log(&dir, Some("none()"), 0).unwrap();
        let got = pollster::block_on(conflict_hunks(&open.repo, &merge, "f.txt")).unwrap();
        assert!(got.supported);
        assert!(!got.executable);
        assert_eq!(got.labels.len(), 2);
        assert_eq!(got.hunks.len(), 3, "{:?}", got.hunks);
        assert_eq!(got.hunks[0], ConflictHunk::Resolved { text: "1\n".into() });
        let ConflictHunk::Conflict { base: hb, sides } = &got.hunks[1] else {
            panic!("expected a conflict: {:?}", got.hunks[1]);
        };
        assert_eq!(hb, &vec!["same\n".to_owned()]);
        assert_eq!(sides.len(), 2);
        assert!(sides.contains(&"from a\n".to_owned()) && sides.contains(&"from b\n".to_owned()));
        let ConflictHunk::Resolved { text: tail } = &got.hunks[2] else { panic!() };
        assert!(tail.ends_with("end a"), "{tail:?}");
        let missing = pollster::block_on(conflict_hunks(&open.repo, &merge, "nope.txt")).unwrap();
        assert!(!missing.supported && missing.hunks.is_empty());

        // A tiny script stands in for the jig binary in `--resolve-output` mode.
        let script = dir.join("fake-jig.sh");
        std::fs::write(&script, "#!/bin/sh\ncp \"$2\" \"$3\"\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let content = dir.join("content.tmp");
        let resolved = "1\nchosen\n3\n4\n5\n6\n7\n8\nend a";
        std::fs::write(&content, resolved).unwrap();
        let (configs, args) = jj_cli::resolve_args(&merge, "f.txt", &script, &content).unwrap();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = jj_cli::run_with_config(&dir, &configs, &args).unwrap();
        assert!(out.success, "{}", out.stderr);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), resolved);
        let list = jj_cli::run(&dir, &["resolve", "--list", "-r", "@"]).unwrap();
        assert!(!list.success && list.stderr.contains("No conflicts"), "{}", list.stderr);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
