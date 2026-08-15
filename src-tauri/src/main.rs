// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The desktop shell.
//!
//! There is no second implementation of anything here. The app starts the same
//! server `bun run start` would, on a port nobody else is using, and opens a
//! window onto it. Everything the window shows is the management UI already in
//! `src/ui`, so the two ways of running this tool cannot drift apart.
//!
//! Three things are handed to the server that the command line would otherwise
//! have to provide:
//!
//! - `DATA_DIR` — a real directory to write to. The bundled server is a single
//!   file, and the path inside it is read-only.
//! - `UI_PORT` — chosen at launch, so the app never collides with a server the
//!   user is already running.
//! - `UI_TOKEN` — a fresh secret each launch, so nothing else on the machine
//!   can drive a server that can start processes.

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

/// The server process this window is a window onto.
struct Server(Mutex<Option<CommandChild>>);

/// A port the OS has just told us is free. Something else could take it in the
/// moment between here and the server binding it; that shows up as a server
/// that fails to start, which is visible rather than silent.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// Fresh every launch. It never has to outlive the window, so it is never
/// stored anywhere.
fn new_token() -> String {
    format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

/// Block until the server is listening. It starts in well under a second, so
/// the wait is normally invisible; the timeout is for the case where it never
/// starts at all and the log is the thing worth reading.
fn wait_until_listening(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = free_port()?;
            let token = new_token();

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let (mut rx, child) = app
                .shell()
                // Not `desktop-comfyui-server`: that is this app's own
                // executable, and the sidecar sits in the same directory.
                .sidecar("comfyui-server")?
                .envs(HashMap::from([
                    ("UI_HOSTNAME".to_string(), "127.0.0.1".to_string()),
                    ("UI_PORT".to_string(), port.to_string()),
                    ("UI_TOKEN".to_string(), token.clone()),
                    (
                        "DATA_DIR".to_string(),
                        data_dir.to_string_lossy().into_owned(),
                    ),
                ]))
                .spawn()?;

            app.manage(Server(Mutex::new(Some(child))));

            // The server's own output, so a bad workflow directory or a port
            // clash explains itself instead of showing up as a blank window.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            print!("{}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[app] the server exited: {:?}", payload.code);
                        }
                        _ => {}
                    }
                }
            });

            if !wait_until_listening(port, Duration::from_secs(20)) {
                return Err("the server did not start listening".into());
            }

            // The token rides in on the address once. The page stores it and
            // clears it from the bar, so it is not left sitting in history.
            let url = format!("http://127.0.0.1:{port}/?token={token}");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Desktop ComfyUI Server")
                .inner_size(1000.0, 760.0)
                .min_inner_size(480.0, 420.0)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not start the desktop app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Server>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        // This is a hard kill, so the server does not get to run
                        // its own shutdown. A ComfyUI started from the Process
                        // panel therefore outlives the window — stop it there
                        // before quitting. Sending SIGTERM by pid would fix it.
                        let _ = child.kill();
                    }
                }
            }
        });
}
