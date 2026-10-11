// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `jj split` runs this binary as its diff editor.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--split-plan") && args.len() >= 5 {
        if let Err(e) = jork_lib::split_tool::run(&args[2], &args[3], &args[4]) {
            eprintln!("jork split tool: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    jork_lib::run()
}
