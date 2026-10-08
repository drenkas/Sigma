// Compile with rustc (no Tauri/cache dependency) to exercise the same native
// owner and handoff code used by the desktop shell against actual Node main.
#[path = "data_lease.rs"]
mod data_lease;
use std::{io::{self, Read}, path::PathBuf, process::{Command, Stdio}};

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let lock = data_lease::instance_lock(&PathBuf::from(&args[1]))?;
    if args.len() == 2 { return Ok(()); }
    let mut command = Command::new(&args[3]);
    command.args(["--import", "tsx"]);
    if args.len() > 5 { command.args(["--import", &args[5]]); }
    command.arg("apps/server/main.ts").current_dir(&args[2])
        .env("SIGMA_PORT", &args[4]).env("SIGMA_DATA_DIR", &args[1]).env("SIGMA_PARENT_WATCH", "1")
        .stdin(Stdio::piped()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    data_lease::inherit_lock(&mut command, &lock);
    let mut child = command.spawn()?;
    println!("native-child:{}", child.id());
    io::stdin().read_to_end(&mut Vec::new())?;
    drop(child.stdin.take());
    if !child.wait()?.success() { return Err(io::Error::other("Node child failed")); }
    Ok(())
}
