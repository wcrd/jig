//! Writes `public/fixture.json` plus `public/diffs/<commit>.json`,
//! `public/trees/<commit>.json` and `public/texts/<commit>/<encoded path>.json`
//! for the first rows, so the UI can be previewed in a plain browser with `npm run dev`.
//! `JIG_FIXTURE_DIR` writes them somewhere other than `public/`, as the benchmark does.
//! Usage: cargo run --example fixture -- <repo path> [revset] [diff count]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = std::path::PathBuf::from(args.get(1).expect("repo path"));
    let revset = args.get(2).map(String::as_str).filter(|s| !s.is_empty());
    let count: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(40);

    let public = std::env::var_os("JIG_FIXTURE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public"));
    let diffs = public.join("diffs");
    let trees = public.join("trees");
    let texts = public.join("texts");
    std::fs::create_dir_all(&diffs).unwrap();
    std::fs::create_dir_all(&trees).unwrap();
    std::fs::create_dir_all(&texts).unwrap();

    let (log, open) = jig_lib::repo::load_log(&path, revset, 100_000).unwrap();
    for row in log.rows.iter().take(count) {
        let diff = pollster::block_on(jig_lib::diff::commit_diff(
            &open.repo,
            open.marker_style,
            &row.commit_id,
        ))
        .unwrap();
        let file = diffs.join(format!("{}.json", row.commit_id));
        std::fs::write(file, serde_json::to_string(&diff).unwrap()).unwrap();

        let tree = pollster::block_on(jig_lib::diff::tree_files(&open.repo, &row.commit_id)).unwrap();
        let file = trees.join(format!("{}.json", row.commit_id));
        std::fs::write(file, serde_json::to_string(&tree).unwrap()).unwrap();

        let dir = texts.join(&row.commit_id);
        for path in &diff.conflicts {
            let conflict = pollster::block_on(jig_lib::conflict::conflict_hunks(&open.repo, &row.commit_id, path)).unwrap();
            let dir = public.join("conflicts").join(&row.commit_id);
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join(format!("{}.json", path.replace('/', "__")));
            std::fs::write(file, serde_json::to_string(&conflict).unwrap()).unwrap();
        }
        let changed = diff.files.iter().filter(|f| f.status != jig_lib::diff::FileStatus::Deleted).map(|f| &f.path);
        for path in changed.chain(&diff.conflicts) {
            std::fs::create_dir_all(&dir).unwrap();
            let text = pollster::block_on(jig_lib::diff::file_text(
                &open.repo,
                open.marker_style,
                &row.commit_id,
                path,
            ))
            .unwrap();
            let encoded = path.replace('/', "__");
            std::fs::write(dir.join(format!("{encoded}.json")), serde_json::to_string(&text).unwrap()).unwrap();
        }
    }
    // Comparisons between nearby rows, for previewing compare mode.
    let compare = public.join("compare");
    std::fs::create_dir_all(&compare).unwrap();
    let rows = &log.rows[..count.min(log.rows.len())];
    for (i, to) in rows.iter().enumerate() {
        for from in rows.iter().skip(i + 1).take(4) {
            let diff = pollster::block_on(jig_lib::diff::compare_diff(
                &open.repo,
                open.marker_style,
                &from.commit_id,
                &to.commit_id,
            ))
            .unwrap();
            let file = compare.join(format!("{}..{}.json", from.commit_id, to.commit_id));
            std::fs::write(file, serde_json::to_string(&diff).unwrap()).unwrap();
        }
    }
    let ops = jig_lib::repo::op_log(&path, 200).unwrap();
    std::fs::write(public.join("oplog.json"), serde_json::to_string(&ops).unwrap()).unwrap();
    let op_changes = public.join("opchanges");
    std::fs::create_dir_all(&op_changes).unwrap();
    for op in ops.iter().take(15) {
        if let Ok(changes) = jig_lib::repo::op_changes(&path, &op.id) {
            let file = op_changes.join(format!("{}.json", op.id));
            std::fs::write(file, serde_json::to_string(&changes).unwrap()).unwrap();
        }
    }
    std::fs::write(public.join("fixture.json"), serde_json::to_string(&log).unwrap()).unwrap();
    println!("{} rows, diffs for {}", log.rows.len(), count.min(log.rows.len()));
}
