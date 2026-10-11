//! Writes `public/fixture.json` plus `public/diffs/<commit>.json` for the first
//! rows, so the UI can be previewed in a plain browser with `npm run dev`.
//! Usage: cargo run --example fixture -- <repo path> [revset] [diff count]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = std::path::PathBuf::from(args.get(1).expect("repo path"));
    let revset = args.get(2).map(String::as_str).filter(|s| !s.is_empty());
    let count: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(40);

    let public = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public");
    let diffs = public.join("diffs");
    std::fs::create_dir_all(&diffs).unwrap();

    let (log, open) = jork_lib::repo::load_log(&path, revset, 100_000).unwrap();
    for row in log.rows.iter().take(count) {
        let diff = pollster::block_on(jork_lib::diff::commit_diff(
            &open.repo,
            open.marker_style,
            &row.commit_id,
        ))
        .unwrap();
        let file = diffs.join(format!("{}.json", row.commit_id));
        std::fs::write(file, serde_json::to_string(&diff).unwrap()).unwrap();
    }
    std::fs::write(public.join("fixture.json"), serde_json::to_string(&log).unwrap()).unwrap();
    println!("{} rows, diffs for {}", log.rows.len(), count.min(log.rows.len()));
}
