//! Commit details and file diffs, computed the way `jj diff` does: against
//! the auto-merged parents, with rename detection and word-level changes.

use std::sync::Arc;

use anyhow::{Result, anyhow};
use bstr::{BStr, ByteSlice};
use futures::StreamExt;
use jj_lib::backend::{CommitId, Signature, TreeValue};
use jj_lib::conflicts::{
    ConflictMarkerStyle, ConflictMaterializeOptions, MaterializedTreeDiffEntry,
    MaterializedTreeValue, materialize_tree_value, materialized_diff_stream,
};
use jj_lib::copies::{CopyOperation, CopyRecords};
use jj_lib::diff_presentation::unified::{DiffLineType, git_diff_part, unified_diff_hunks};
use jj_lib::diff_presentation::{DiffTokenType, LineCompareMode};
use jj_lib::matchers::EverythingMatcher;
use jj_lib::merge::Diff;
use jj_lib::object_id::ObjectId;
use jj_lib::merged_tree::MergedTree;
use jj_lib::repo::{ReadonlyRepo, Repo};
use jj_lib::store::Store;
use jj_lib::repo_path::RepoPathBuf;
use serde::Serialize;

const CONTEXT_LINES: usize = 3;
/// Files bigger than this aren't diffed.
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
/// Once a commit's diff reaches this many lines, remaining files are listed
/// without their diffs.
const MAX_TOTAL_LINES: usize = 40_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDiff {
    pub commit_id: String,
    pub change_id: String,
    pub description: String,
    pub author: Person,
    pub committer: Person,
    pub parents: Vec<ParentInfo>,
    pub files: Vec<FileDiff>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub email: String,
    pub timestamp: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentInfo {
    pub commit_id: String,
    pub change_id: String,
    pub summary: String,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// Where a renamed or copied file came from.
    pub source_path: Option<String>,
    pub status: FileStatus,
    pub conflict: bool,
    pub binary: bool,
    /// The diff wasn't computed: the file is too big, or the commit's diff
    /// already hit the size budget.
    pub omitted: bool,
    pub additions: usize,
    pub deletions: usize,
    /// Lines in the old and new file, so the UI knows how much unchanged text
    /// lies around the hunks.
    pub old_line_count: usize,
    pub new_line_count: usize,
    pub hunks: Vec<Hunk>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<Line>,
}

#[derive(Serialize)]
pub struct Line {
    /// ' ', '+' or '-'.
    pub kind: char,
    /// Text segments; `true` marks a changed word within a changed line.
    pub tokens: Vec<(bool, String)>,
}

fn line_count(contents: &[u8]) -> usize {
    if contents.is_empty() {
        return 0;
    }
    let newlines = contents.iter().filter(|&&b| b == b'\n').count();
    newlines + usize::from(!contents.ends_with(b"\n"))
}

fn person(signature: &Signature) -> Person {
    Person {
        name: signature.name.clone(),
        email: signature.email.clone(),
        timestamp: signature.timestamp.timestamp.0,
    }
}

fn summary(description: &str) -> String {
    description.lines().next().unwrap_or("").to_owned()
}

pub async fn commit_diff(
    repo: &Arc<ReadonlyRepo>,
    marker_style: ConflictMarkerStyle,
    commit_hex: &str,
) -> Result<CommitDiff> {
    let store = repo.store();
    let id = CommitId::try_from_hex(commit_hex).ok_or_else(|| anyhow!("bad commit id"))?;
    let commit = store.get_commit_async(&id).await?;

    let mut parents = vec![];
    for parent in commit.parents().await? {
        parents.push(ParentInfo {
            commit_id: parent.id().hex(),
            change_id: parent.change_id().reverse_hex(),
            summary: summary(parent.description()),
        });
    }

    let from_tree = commit.parent_tree(repo.as_ref()).await?;
    let mut copy_records = CopyRecords::default();
    for parent_id in commit.parent_ids() {
        copy_records.add_records(copy_records_between(store, parent_id, commit.id()).await?);
    }
    let files = diff_trees(store, marker_style, &from_tree, &commit.tree(), &copy_records).await?;

    Ok(CommitDiff {
        commit_id: commit.id().hex(),
        change_id: commit.change_id().reverse_hex(),
        description: commit.description().trim_end().to_owned(),
        author: person(commit.author()),
        committer: person(commit.committer()),
        parents,
        files,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    /// `None` when the file is absent, binary or too large.
    pub text: Option<String>,
    pub binary: bool,
    pub too_large: bool,
    pub conflict: bool,
}

/// A file's contents at a commit, with conflicts materialized as markers.
pub async fn file_text(
    repo: &Arc<ReadonlyRepo>,
    marker_style: ConflictMarkerStyle,
    commit_hex: &str,
    file_path: &str,
) -> Result<FileText> {
    let id = CommitId::try_from_hex(commit_hex).ok_or_else(|| anyhow!("bad commit id"))?;
    let commit = repo.store().get_commit_async(&id).await?;
    let path = RepoPathBuf::from_internal_string(file_path)?;
    let tree = commit.tree();
    let value = tree.path_value(&path).await?;
    let conflict = !value.is_resolved();
    let materialized = materialize_tree_value(repo.store(), &path, value, tree.labels()).await?;
    if matches!(materialized, MaterializedTreeValue::Absent | MaterializedTreeValue::Tree(_)) {
        return Ok(FileText { text: None, binary: false, too_large: false, conflict });
    }
    let options = ConflictMaterializeOptions {
        marker_style,
        marker_len: None,
        merge: repo.store().merge_options().clone(),
    };
    let part = git_diff_part(&path, materialized, &options).await?;
    if part.content.is_binary {
        return Ok(FileText { text: None, binary: true, too_large: false, conflict });
    }
    if part.content.contents.len() > MAX_FILE_BYTES {
        return Ok(FileText { text: None, binary: false, too_large: true, conflict });
    }
    Ok(FileText {
        text: Some(part.content.contents.to_str_lossy().into_owned()),
        binary: false,
        too_large: false,
        conflict,
    })
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Executable,
    Symlink,
    Submodule,
    Conflict,
}

#[derive(Serialize)]
pub struct TreeEntry {
    pub path: String,
    pub kind: EntryKind,
}

/// Every file in the commit's tree, for the file browser.
pub async fn tree_files(repo: &Arc<ReadonlyRepo>, commit_hex: &str) -> Result<Vec<TreeEntry>> {
    let id = CommitId::try_from_hex(commit_hex).ok_or_else(|| anyhow!("bad commit id"))?;
    let commit = repo.store().get_commit_async(&id).await?;
    let mut entries = vec![];
    for (path, value) in commit.tree().entries() {
        let value = value?;
        let kind = match value.as_resolved() {
            Some(Some(TreeValue::File { executable: true, .. })) => EntryKind::Executable,
            Some(Some(TreeValue::File { .. })) => EntryKind::File,
            Some(Some(TreeValue::Symlink(_))) => EntryKind::Symlink,
            Some(Some(TreeValue::GitSubmodule(_))) => EntryKind::Submodule,
            Some(Some(TreeValue::Tree(_))) | Some(None) => continue,
            None => EntryKind::Conflict,
        };
        entries.push(TreeEntry {
            path: path.as_internal_file_string().to_owned(),
            kind,
        });
    }
    Ok(entries)
}


async fn copy_records_between(
    store: &Arc<Store>,
    from: &CommitId,
    to: &CommitId,
) -> Result<Vec<jj_lib::backend::CopyRecord>> {
    Ok(store
        .get_copy_records(None, from, to)?
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<_, _>>()?)
}

/// File diffs from one tree to another, with renames from `copy_records`.
async fn diff_trees(
    store: &Arc<Store>,
    marker_style: ConflictMarkerStyle,
    from_tree: &MergedTree,
    to_tree: &MergedTree,
    copy_records: &CopyRecords,
) -> Result<Vec<FileDiff>> {
    let materialize_options = ConflictMaterializeOptions {
        marker_style,
        marker_len: None,
        merge: store.merge_options().clone(),
    };
    let tree_diff = from_tree.diff_stream_with_copies(to_tree, &EverythingMatcher, copy_records);
    let mut stream = materialized_diff_stream(
        store,
        tree_diff,
        Diff::new(from_tree.labels(), to_tree.labels()),
    );

    let mut files = vec![];
    let mut total_lines = 0;
    while let Some(MaterializedTreeDiffEntry { path, values }) = stream.next().await {
        let values = values?;
        let status = match &path.source {
            Some((_, CopyOperation::Rename)) => FileStatus::Renamed,
            Some((_, CopyOperation::Copy)) => FileStatus::Copied,
            None if matches!(values.before, MaterializedTreeValue::Absent) => FileStatus::Added,
            None if matches!(values.after, MaterializedTreeValue::Absent) => FileStatus::Deleted,
            None => FileStatus::Modified,
        };
        let is_conflict = |v: &MaterializedTreeValue| {
            matches!(
                v,
                MaterializedTreeValue::FileConflict(_) | MaterializedTreeValue::OtherConflict { .. }
            )
        };
        let conflict = is_conflict(&values.before) || is_conflict(&values.after);

        let left = git_diff_part(path.source(), values.before, &materialize_options).await?;
        let right = git_diff_part(path.target(), values.after, &materialize_options).await?;

        let mut file = FileDiff {
            path: path.target().as_internal_file_string().to_owned(),
            source_path: path
                .source
                .as_ref()
                .map(|(source, _)| source.as_internal_file_string().to_owned()),
            status,
            conflict,
            binary: left.content.is_binary || right.content.is_binary,
            omitted: false,
            additions: 0,
            deletions: 0,
            old_line_count: line_count(&left.content.contents),
            new_line_count: line_count(&right.content.contents),
            hunks: vec![],
        };
        if file.binary {
            files.push(file);
            continue;
        }
        if total_lines >= MAX_TOTAL_LINES
            || left.content.contents.len() > MAX_FILE_BYTES
            || right.content.contents.len() > MAX_FILE_BYTES
        {
            file.omitted = true;
            files.push(file);
            continue;
        }

        let contents: Diff<&BStr> = Diff::new(
            left.content.contents.as_bstr(),
            right.content.contents.as_bstr(),
        );
        for hunk in unified_diff_hunks(contents, CONTEXT_LINES, LineCompareMode::Exact) {
            let lines: Vec<Line> = hunk
                .lines
                .iter()
                .map(|(kind, tokens)| {
                    let kind = match kind {
                        DiffLineType::Context => ' ',
                        DiffLineType::Added => '+',
                        DiffLineType::Removed => '-',
                    };
                    let mut tokens: Vec<(bool, String)> = tokens
                        .iter()
                        .map(|(token_type, bytes)| {
                            (
                                *token_type == DiffTokenType::Different,
                                bytes.to_str_lossy().into_owned(),
                            )
                        })
                        .collect();
                    if let Some((_, last)) = tokens.last_mut()
                        && last.ends_with('\n')
                    {
                        last.pop();
                        if last.ends_with('\r') {
                            last.pop();
                        }
                    }
                    Line { kind, tokens }
                })
                .collect();
            file.additions += lines.iter().filter(|l| l.kind == '+').count();
            file.deletions += lines.iter().filter(|l| l.kind == '-').count();
            total_lines += lines.len();
            file.hunks.push(Hunk {
                old_start: hunk.left_line_range.start + 1,
                old_count: hunk.left_line_range.len(),
                new_start: hunk.right_line_range.start + 1,
                new_count: hunk.right_line_range.len(),
                lines,
            });
        }
        files.push(file);
    }

    Ok(files)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareDiff {
    pub from: String,
    pub to: String,
    pub files: Vec<FileDiff>,
}

/// The changes between two commits' snapshots.
pub async fn compare_diff(
    repo: &Arc<ReadonlyRepo>,
    marker_style: ConflictMarkerStyle,
    from_hex: &str,
    to_hex: &str,
) -> Result<CompareDiff> {
    let store = repo.store();
    let parse = |hex: &str| CommitId::try_from_hex(hex).ok_or_else(|| anyhow!("bad commit id"));
    let from = store.get_commit_async(&parse(from_hex)?).await?;
    let to = store.get_commit_async(&parse(to_hex)?).await?;
    let mut copy_records = CopyRecords::default();
    copy_records.add_records(copy_records_between(store, from.id(), to.id()).await?);
    let files = diff_trees(store, marker_style, &from.tree(), &to.tree(), &copy_records).await?;
    Ok(CompareDiff {
        from: from.id().hex(),
        to: to.id().hex(),
        files,
    })
}
