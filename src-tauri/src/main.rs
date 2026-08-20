// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The desktop shell.
//!
//! There is no second implementation of anything here. The app starts the same
//! server `bun run start` would, on a port nobody else is using, and opens a
//! window onto it. Everything the window shows is the management UI already in
//! `src/ui`, so the two ways of running this tool cannot drift apart.
//!
//! Four things are handed to the server that the command line would otherwise
//! have to provide:
//!
//! - `DATA_DIR` — a real directory to write to. The bundled server is a single
//!   file, and the path inside it is read-only.
//! - `UI_PORT` — chosen at launch, so the app never collides with a server the
//!   user is already running.
//! - `UI_TOKEN` — a fresh secret each launch, so nothing else on the machine
//!   can drive a server that can start processes.
//! - the window, which is the only thing holding that token.
//!
//! The tray menu and the page's own menu are two faces of the same switches:
//! both write to the server, and this side reads them back on a timer rather
//! than keeping its own copy. That is why closing the window can change what
//! the tray shows without either one telling the other.

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;
use uuid::Uuid;

const WINDOW: &str = "main";

/// How often a tray app that runs for weeks looks for a new release, on top
/// of the check at launch.
const UPDATE_CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// The folder this app owns under the platform's data directory. Deliberately
/// the project name rather than the bundle identifier, which is what
/// `app_data_dir()` would have given.
const DATA_FOLDER: &str = "desktop-comfyui-server";

/// How the server is reached. Cloned into the tray handlers, which outlive any
/// borrow of the app.
#[derive(Clone)]
struct Api {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl Api {
    async fn state(&self) -> Option<serde_json::Value> {
        self.client
            .get(format!("{}/api/state", self.base))
            .bearer_auth(&self.token)
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()
    }

    /// Fire and forget. Whatever it changed comes back on the next poll, so
    /// there is nothing here to keep in step by hand.
    async fn post(&self, path: &str, body: serde_json::Value) {
        let sent = self
            .client
            .post(format!("{}{}", self.base, path))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await;
        if let Err(err) = sent {
            eprintln!("[app] {path} failed: {err}");
        }
    }
}

/// The three tray entries that stand for the run mode. Only one is ever
/// ticked, which is what makes them read as a choice rather than as switches.
#[derive(Clone)]
struct ModeItems {
    accepting: CheckMenuItem<Wry>,
    local: CheckMenuItem<Wry>,
    paused: CheckMenuItem<Wry>,
}

impl ModeItems {
    fn show(&self, mode: &str) {
        let _ = self.accepting.set_checked(mode == "accepting");
        let _ = self.local.set_checked(mode == "local");
        let _ = self.paused.set_checked(mode == "paused");
    }

    /// Greyed out while no ComfyUI answers, which is the same thing the page
    /// does to its own picker: all three say what ComfyUI is to do.
    fn enable(&self, on: bool) {
        let _ = self.accepting.set_enabled(on);
        let _ = self.local.set_enabled(on);
        let _ = self.paused.set_enabled(on);
    }
}

/// The parts of the shell that outlive a single handler.
struct Shell {
    server: Mutex<Option<CommandChild>>,
    /// Mirrors the stored setting, read when the window is closed.
    close_action: Mutex<String>,
    /// Set by the tray's Quit, so the close handler stops intercepting.
    quitting: AtomicBool,
}

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
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
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

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Look for a newer release and offer it. `quiet` is the automatic path:
/// nothing new means nothing said, and a failed check is a log line — the app
/// must not greet every launch with an error about being offline. The tray
/// item passes `false` and gets both answered in dialogs.
fn check_for_update(app: AppHandle, quiet: bool) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(err) => {
                eprintln!("[update] updater unavailable: {err}");
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => offer_update(&app, update),
            Ok(None) => {
                if !quiet {
                    app.dialog()
                        .message("You are on the latest version.")
                        .title("No update available")
                        .show(|_| {});
                }
            }
            Err(err) => {
                eprintln!("[update] check failed: {err}");
                if !quiet {
                    app.dialog()
                        .message(format!("Could not check for updates: {err}"))
                        .title("Update check failed")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
        }
    });
}

/// Ask before touching anything: installing restarts the app, and the person
/// may be halfway through a run they care about.
fn offer_update(app: &AppHandle, update: tauri_plugin_updater::Update) {
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "Version {} is available (you have {}).\n\nInstall it now? The app restarts when it finishes.",
            update.version, update.current_version,
        ))
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install".to_string(),
            "Later".to_string(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            tauri::async_runtime::spawn(async move {
                // On Windows the installer takes over and this process exits on
                // its own — the exit handler below kills the sidecar with it.
                // restart() is for the platforms where it does not.
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => handle.restart(),
                    Err(err) => {
                        eprintln!("[update] install failed: {err}");
                        handle
                            .dialog()
                            .message(format!("Installing the update failed: {err}"))
                            .title("Update failed")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                }
            });
        });
}

/// Take what the server says and make the shell match it. Called on a timer,
/// so a switch flipped in the page shows up in the tray a moment later.
fn apply_state(app: &AppHandle, modes: &ModeItems, state: &serde_json::Value) {
    if let Some(mode) = state.get("mode").and_then(serde_json::Value::as_str) {
        modes.show(mode);
    }

    modes.enable(
        state
            .get("comfy")
            .and_then(|comfy| comfy.get("comfyStatus"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|status| status != "unavailable"),
    );

    let desktop = state.get("desktop");

    if let Some(action) = desktop
        .and_then(|d| d.get("closeAction"))
        .and_then(serde_json::Value::as_str)
    {
        if let Ok(mut stored) = app.state::<Shell>().close_action.lock() {
            *stored = action.to_string();
        }
    }

    // Only touched when it disagrees, so the registry entry is not rewritten
    // every couple of seconds.
    if let Some(wanted) = desktop
        .and_then(|d| d.get("autostart"))
        .and_then(serde_json::Value::as_bool)
    {
        let manager = app.autolaunch();
        if manager.is_enabled().unwrap_or(false) != wanted {
            let changed = if wanted {
                manager.enable()
            } else {
                manager.disable()
            };
            if let Err(err) = changed {
                eprintln!("[app] could not set start-at-login: {err}");
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let port = free_port()?;
            let token = new_token();

            let data_dir = app.path().data_dir()?.join(DATA_FOLDER);
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

            app.manage(Shell {
                server: Mutex::new(Some(child)),
                close_action: Mutex::new("tray".to_string()),
                quitting: AtomicBool::new(false),
            });

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

            let api = Api {
                client: reqwest::Client::new(),
                base: format!("http://127.0.0.1:{port}"),
                token: token.clone(),
            };

            // The tray. Its labels are English only: the page's language lives
            // in the browser, which this side cannot read.
            let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            // Disabled, so it reads as the heading for the three under it.
            let heading = MenuItem::with_id(app, "heading", "Generation", false, None::<&str>)?;
            // All three start greyed out. ComfyUI is not running this early, and
            // the first poll enables them if it turns out to be.
            let modes = ModeItems {
                accepting: CheckMenuItem::with_id(
                    app,
                    "mode-accepting",
                    "Accepting",
                    false,
                    true,
                    None::<&str>,
                )?,
                local: CheckMenuItem::with_id(
                    app,
                    "mode-local",
                    "Not accepting",
                    false,
                    false,
                    None::<&str>,
                )?,
                paused: CheckMenuItem::with_id(
                    app,
                    "mode-paused",
                    "Stopped",
                    false,
                    false,
                    None::<&str>,
                )?,
            };
            let stop_comfy = MenuItem::with_id(app, "stop-comfy", "Stop ComfyUI", true, None::<&str>)?;
            let check_updates =
                MenuItem::with_id(app, "check-updates", "Check for updates", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = MenuBuilder::new(app)
                .items(&[&open])
                .separator()
                .items(&[&heading, &modes.accepting, &modes.local, &modes.paused])
                .separator()
                .items(&[&stop_comfy])
                .separator()
                .items(&[&check_updates])
                .items(&[&quit])
                .build()?;

            let menu_api = api.clone();
            let menu_modes = modes.clone();

            TrayIconBuilder::with_id("main")
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("the app has no icon to put in the tray")?,
                )
                .tooltip("Desktop ComfyUI Server")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    id @ ("mode-accepting" | "mode-local") => {
                        // Clicking ticked whichever was pressed; untick the
                        // others now rather than waiting for the next poll.
                        let mode = id.trim_start_matches("mode-").to_string();
                        menu_modes.show(&mode);

                        let api = menu_api.clone();
                        tauri::async_runtime::spawn(async move {
                            api.post("/api/mode", serde_json::json!({ "mode": mode })).await;
                        });
                    }
                    // The one entry that loses work: the server shuts ComfyUI
                    // down for this mode, so a generation in flight dies with
                    // it. Asked here as well as in the page. The click has
                    // already ticked the item; nothing is undone on a refusal
                    // because the menu is shut and the poll corrects it before
                    // it can be opened again.
                    "mode-paused" => {
                        let api = menu_api.clone();
                        let modes = menu_modes.clone();

                        app.dialog()
                            .message(
                                "ComfyUI will be shut down, and anything still generating is lost.",
                            )
                            .title("Stop generation on this machine?")
                            .kind(MessageDialogKind::Warning)
                            .buttons(MessageDialogButtons::OkCancelCustom(
                                "Stop".to_string(),
                                "Cancel".to_string(),
                            ))
                            .show(move |confirmed| {
                                if !confirmed {
                                    return;
                                }
                                modes.show("paused");
                                tauri::async_runtime::spawn(async move {
                                    api.post("/api/mode", serde_json::json!({ "mode": "paused" }))
                                        .await;
                                });
                            });
                    }
                    "stop-comfy" => {
                        let api = menu_api.clone();
                        tauri::async_runtime::spawn(async move {
                            api.post("/api/comfy/stop", serde_json::json!({})).await;
                        });
                    }
                    "check-updates" => check_for_update(app.clone(), false),
                    "quit" => {
                        app.state::<Shell>().quitting.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // The token rides in on the address once. The page stores it and
            // clears it from the bar, so it is not left sitting in history.
            let url = format!("http://127.0.0.1:{port}/?token={token}");

            let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url.parse()?))
                .title("Desktop ComfyUI Server")
                .inner_size(1000.0, 760.0)
                .min_inner_size(480.0, 420.0)
                .build()?;

            let close_handle = app.handle().clone();
            window.on_window_event(move |event| {
                let WindowEvent::CloseRequested { api, .. } = event else {
                    return;
                };

                let shell = close_handle.state::<Shell>();
                if shell.quitting.load(Ordering::SeqCst) {
                    return;
                }
                let to_tray = shell
                    .close_action
                    .lock()
                    .map(|action| *action == "tray")
                    .unwrap_or(true);

                if to_tray {
                    api.prevent_close();
                    if let Some(window) = close_handle.get_webview_window(WINDOW) {
                        let _ = window.hide();
                    }
                }
            });

            // One poll keeps the tray, the close behaviour and start-at-login
            // in step with whatever the page last saved.
            let sync_handle = app.handle().clone();
            let sync_api = api;
            tauri::async_runtime::spawn(async move {
                loop {
                    if let Some(state) = sync_api.state().await {
                        apply_state(&sync_handle, &modes, &state);
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            });

            // Once now and then daily: a tray app runs for weeks, and an app
            // that only ever checked at launch would quietly fall behind.
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    check_for_update(update_handle.clone(), true);
                    tokio::time::sleep(UPDATE_CHECK_EVERY).await;
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not start the desktop app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(shell) = app.try_state::<Shell>() {
                    if let Some(child) = shell.server.lock().ok().and_then(|mut c| c.take()) {
                        // A hard kill, so the server does not get to run its own
                        // shutdown. A ComfyUI started from the Process panel
                        // therefore outlives the app — stop it from the tray or
                        // the page first. Sending SIGTERM by pid would fix it.
                        let _ = child.kill();
                    }
                }
            }
        });
}
