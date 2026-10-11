// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `jj split` runs this binary as its diff editor.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--split-plan") && args.len() >= 5 {
        if let Err(e) = jig_lib::split_tool::run(&args[2], &args[3], &args[4]) {
            eprintln!("jig split tool: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    // `jj resolve` runs it as its merge tool, too.
    if args.get(1).map(String::as_str) == Some("--resolve-output") && args.len() >= 4 {
        if let Err(e) = jig_lib::resolve_tool::run(&args[2], &args[3]) {
            eprintln!("jig resolve tool: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    jig_lib::run()
}
