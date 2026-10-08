use std::{
    fs::create_dir_all,
    io::{self, BufRead, BufReader, Read},
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
mod data_lease;
mod updater;
use data_lease::{instance_lock, inherit_lock, DataLease};

struct Server {
    child: Arc<Mutex<Child>>,
    closing: Arc<AtomicBool>,
    lock: Mutex<Option<DataLease>>,
}

#[cfg(unix)]
fn private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    create_dir_all(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn private_dir(path: &Path) -> io::Result<()> {
    create_dir_all(path)
}

fn free_loopback_port() -> io::Result<u16> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

fn stop(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() { return; }
    // EOF starts the server's owned shutdown. Accepted SDK credential writes
    // and model synchronization must drain even if they outlast a UI timeout.
    // Keep the native lease and parent alive until the server exits naturally.
    drop(child.stdin.take());
    let _ = child.wait();
}

/// Orderly shutdown shared by RunEvent::Exit and the updater restart (which bypasses RunEvent::Exit):
/// stop the Node server (waits for its drain), then release the data lease.
pub(crate) fn shutdown_server(app: &tauri::AppHandle) {
    if let Some(server) = app.try_state::<Server>() {
        server.closing.store(true, Ordering::Release);
        if let Ok(mut child) = server.child.lock() { stop(&mut child); }
        if let Ok(mut lock) = server.lock.lock() { lock.take(); }
    }
}

fn tail_stderr(stderr: impl Read + Send + 'static) -> Arc<Mutex<String>> {
    let tail = Arc::new(Mutex::new(String::new()));
    let output = Arc::clone(&tail);
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buffer = [0; 2048];
        while let Ok(size) = reader.read(&mut buffer) {
            if size == 0 { break; }
                if let Ok(mut text) = output.lock() {
                    text.push_str(&String::from_utf8_lossy(&buffer[..size]));
                if text.len() > 8192 {
                    let mut cut = text.len() - 8192;
                    while !text.is_char_boundary(cut) { cut += 1; }
                    text.drain(..cut);
                }
            }
        }
    });
    tail
}

fn stdout_lines(stdout: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (send, receive) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = Vec::with_capacity(256);
            let mut too_long = false;
            loop {
                let (amount, complete, chunk) = match reader.fill_buf() {
                    Ok(available) if available.is_empty() => return,
                    Ok(available) => {
                        let amount = available.iter().position(|byte| *byte == b'\n').map_or(available.len(), |index| index + 1);
                        let chunk = (!too_long && line.len() + amount <= 8192).then(|| available[..amount].to_vec());
                        (amount, available.get(amount.wrapping_sub(1)) == Some(&b'\n'), chunk)
                    }
                    Err(_) => return,
                };
                reader.consume(amount);
                if let Some(chunk) = chunk { line.extend_from_slice(&chunk); }
                else { too_long = true; }
                if complete { break; }
            }
            if !too_long {
                while matches!(line.last(), Some(b'\n' | b'\r')) { line.pop(); }
                if line.starts_with(b"Sigma API listening on http://127.0.0.1:") {
                    let _ = send.send(String::from_utf8_lossy(&line).into_owned());
                }
            }
        }
    });
    receive
}

fn wait_ready(child: &mut Child, lines: &mpsc::Receiver<String>, port: u16, stderr: &Arc<Mutex<String>>) -> io::Result<()> {
    let expected = format!("Sigma API listening on http://127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            let detail = stderr.lock().map(|text| text.clone()).unwrap_or_default();
            return Err(io::Error::other(format!("Sigma service exited during startup ({status}): {detail}")));
        }
        match lines.recv_timeout(Duration::from_millis(100)) {
            Ok(line) if line == expected => return Ok(()),
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(io::Error::other("Sigma service closed stdout before readiness")),
        }
    }
    let detail = stderr.lock().map(|text| text.clone()).unwrap_or_default();
    Err(io::Error::new(io::ErrorKind::TimedOut, format!("Sigma service did not announce readiness: {detail}")))
}

fn paths(app: &tauri::AppHandle) -> tauri::Result<(PathBuf, PathBuf, PathBuf)> {
    #[cfg(debug_assertions)]
    let runtime = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    #[cfg(not(debug_assertions))]
    let runtime = app.path().resource_dir()?.join("sigma-runtime");

    let app_data = app.path().app_data_dir()?;
    let data = if std::env::var("SIGMA_QA").as_deref() == Ok("1") {
        if let Some(path) = std::env::var_os("SIGMA_DATA_DIR") {
            let path = PathBuf::from(path);
            if !path.is_absolute() { return Err(io::Error::new(io::ErrorKind::InvalidInput, "SIGMA_DATA_DIR must be absolute in QA mode").into()); }
            path
        } else { app_data }
    } else { app_data };
    let home = app.path().home_dir()?;
    Ok((runtime, data, home))
}

fn show_service_stopped(window: &tauri::WebviewWindow) {
    let _ = window.eval("document.body.replaceChildren();document.body.style.cssText='margin:0;background:#171717;color:#f4f4f4;font:16px system-ui';const panel=document.createElement('main');panel.style.cssText='max-width:640px;margin:15vh auto;padding:32px';const title=document.createElement('h1');title.textContent='Sigma service stopped';const text=document.createElement('p');text.textContent='The local service ended unexpectedly. Close and reopen Sigma. No request was replayed.';panel.append(title,text);document.body.append(panel);");
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::UpdateState::default())
        .invoke_handler(tauri::generate_handler![updater::update_status, updater::install_update])
        .on_menu_event(|app, event| updater::on_menu_event(app, event))
        .setup(|app| {
            let (runtime, data_dir, home) = paths(app.handle())?;
            private_dir(&data_dir)?;
            let lock = instance_lock(&data_dir)?;
            let port = free_loopback_port()?;

            #[cfg(debug_assertions)]
            let node = std::env::var_os("SIGMA_NODE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("node"));
            #[cfg(not(debug_assertions))]
            let node = runtime.join("bin/node");

            #[cfg(debug_assertions)]
            let args = vec!["--import".to_owned(), "tsx".to_owned(), "apps/server/main.ts".to_owned()];
            #[cfg(not(debug_assertions))]
            let args = vec!["apps/server/main.js".to_owned()];

            let mut command = Command::new(node);
            command.args(args).current_dir(&runtime)
                .env("SIGMA_PORT", port.to_string())
                .env("SIGMA_DATA_DIR", &data_dir)
                .env("SIGMA_DEFAULT_WORKSPACE", &home)
                .env("SIGMA_PARENT_WATCH", "1")
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            if std::env::var("SIGMA_QA").as_deref() == Ok("1") {
                command.env("SIGMA_QA", "1");
                for key in ["SIGMA_DEMO", "PI_OFFLINE", "PI_CODING_AGENT_DIR"] {
                    if let Some(value) = std::env::var_os(key) { command.env(key, value); }
                }
            }
            inherit_lock(&mut command, &lock);
            let mut child = command.spawn()?;
            let lines = stdout_lines(child.stdout.take().ok_or_else(|| io::Error::other("Sigma stdout pipe unavailable"))?);
            let stderr = tail_stderr(child.stderr.take().ok_or_else(|| io::Error::other("Sigma stderr pipe unavailable"))?);
            if let Err(error) = wait_ready(&mut child, &lines, port, &stderr) {
                stop(&mut child);
                return Err(error.into());
            }

            let url = format!("http://127.0.0.1:{port}").parse().map_err(|error| io::Error::other(format!("Invalid local service URL: {error}")))?;
            let window = match WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::External(url))
                .title("Sigma").inner_size(1280.0, 800.0).build()
            {
                Ok(window) => window,
                Err(error) => { stop(&mut child); return Err(error.into()); }
            };

            let child = Arc::new(Mutex::new(child));
            let closing = Arc::new(AtomicBool::new(false));
            app.manage(Server { child: Arc::clone(&child), closing: Arc::clone(&closing), lock: Mutex::new(Some(lock)) });
            let monitored_child = Arc::clone(&child);
            let monitored_closing = Arc::clone(&closing);
            thread::spawn(move || loop {
                if monitored_closing.load(Ordering::Acquire) { return; }
                let exited = monitored_child.lock().ok().and_then(|mut child| child.try_wait().ok()).flatten().is_some();
                if exited {
                    if !monitored_closing.load(Ordering::Acquire) { show_service_stopped(&window); }
                    return;
                }
                thread::sleep(Duration::from_millis(250));
            });
            let _ = updater::install_menu(app.handle());
            updater::spawn_background(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri shell build failed")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                shutdown_server(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::stop;
    use std::io::Read;
    use std::process::{Command, Stdio};

    #[test]
    fn quit_waits_for_accepted_child_finalizer() {
        // A save/sync already admitted by the SDK can outlast the old 8s
        // native shutdown limit. EOF starts drain; it must finish naturally.
        let mut child = Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; read -r request; sleep 9; printf finalized"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("finalizer fixture starts");
        stop(&mut child);
        let status = child.wait().expect("finalizer fixture exits");
        let mut output = String::new();
        child.stdout.take().unwrap().read_to_string(&mut output).unwrap();
        assert!(status.success(), "Quit must not kill an admitted finalizer: {status}");
        assert_eq!(output, "finalized");
    }
}
