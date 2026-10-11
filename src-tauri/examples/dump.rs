//! Prints a text rendering of the log, for checking the backend without the UI.
//! Usage: cargo run --example dump -- <repo path> [revset] [limit]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = std::path::PathBuf::from(args.get(1).expect("repo path"));
    let limit = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(40);
    let log = jork_lib::repo::load_log(&path, args.get(2).map(String::as_str), limit).unwrap();
    println!(
        "{} rows, {} edges, max width {}, truncated {}, {} ms, revset {:?}",
        log.rows.len(), log.edges.len(), log.max_width, log.truncated, log.elapsed_ms, log.revset
    );
    for row in log.rows.iter().take(limit) {
        let mut lanes = vec![' '; row.width as usize];
        lanes[row.lane as usize] = if row.is_working_copy { '@' } else if row.immutable { '◆' } else { '○' };
        let refs: Vec<String> = row.refs.iter().map(|r| serde_json::to_value(r).unwrap()["name"].as_str().unwrap().to_owned()).collect();
        println!(
            "{} {} {:<8} {} {}",
            lanes.iter().collect::<String>(),
            &row.change_id[..8],
            refs.join(","),
            if row.in_wc_history { "" } else { "(dim)" },
            row.summary
        );
    }
}
