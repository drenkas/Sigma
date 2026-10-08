use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter, Manager, State, Wry,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::{Update, UpdaterExt};

pub const CHECK_MENU_ID: &str = "sigma-check-updates";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);
const RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

fn disabled() -> bool {
    cfg!(debug_assertions) || std::env::var("SIGMA_DISABLE_UPDATER").as_deref() == Ok("1")
}

/// Background checks: first after ~10s, then every ~6h. Never blocks startup; errors go to stderr.
pub fn spawn_background(app: &AppHandle) {
    if disabled() { return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(FIRST_CHECK_DELAY).await;
        loop {
            if let Err(error) = check(&app, false).await { eprintln!("sigma updater: {error}"); }
            tokio_sleep(RECHECK_INTERVAL).await;
        }
    });
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

/// Manual check from the app menu: also reports "up to date" and errors.
pub fn spawn_manual(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = check(&app, true).await {
            eprintln!("sigma updater: {error}");
            let handle = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                handle.dialog().message(format!("Could not check for updates: {error}")).title("Sigma").blocking_show();
            }).await;
        }
    });
}

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
}

#[derive(Default)]
pub struct UpdateState {
    info: Mutex<Option<UpdateInfo>>,
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn announce(app: &AppHandle, update: Update) {
    let notes = update.body.as_deref().map(str::trim).filter(|notes| !notes.is_empty()).map(str::to_owned);
    let info = UpdateInfo { version: update.version.clone(), current: update.current_version.clone(), notes };
    let state = app.state::<UpdateState>();
    if let Ok(mut slot) = state.info.lock() { *slot = Some(info.clone()); }
    if let Ok(mut slot) = state.pending.lock() { *slot = Some(update); }
    let _ = app.emit_to("main", "sigma-update-available", info);
}

async fn check(app: &AppHandle, manual: bool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if cfg!(debug_assertions) && !manual { return Ok(()); }
    let Some(update) = app.updater()?.check().await? else {
        if manual {
            let handle = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                handle.dialog().message("You're up to date.").title("Sigma").blocking_show();
            }).await;
        }
        return Ok(());
    };
    announce(app, update);
    if manual {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn update_status(state: State<'_, UpdateState>) -> Option<UpdateInfo> {
    state.info.lock().ok().and_then(|info| info.clone())
}

#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    if state.installing.swap(true, Ordering::AcqRel) { return Err("An update is already being installed".into()); }
    let result = install(&app, &state).await;
    if let Err(error) = &result {
        state.installing.store(false, Ordering::Release);
        let _ = app.emit_to("main", "sigma-update-error", error.clone());
    }
    result
}

async fn install(app: &AppHandle, state: &UpdateState) -> Result<(), String> {
    let update = state.pending.lock().map_err(|_| "Update state unavailable".to_string())?.clone()
        .ok_or_else(|| "No update available".to_string())?;
    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    update.download_and_install(
        move |chunk, total| {
            downloaded += chunk as u64;
            let _ = progress_app.emit_to("main", "sigma-update-progress", Progress { downloaded, total });
        },
        || {},
    ).await.map_err(|error| error.to_string())?;
    // Orderly stop of the Node server and release of the data lease first: restart() execs the new
    // process and exits directly, without RunEvent::Exit.
    crate::shutdown_server(app);
    app.restart();
}

/// Adds "Check for Updates…" under the macOS app menu, right after "About".
pub fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let menu: Menu<Wry> = Menu::default(app)?;
        if let Some(submenu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
            let item = MenuItem::with_id(app, CHECK_MENU_ID, "Check for Updates…", true, None::<&str>)?;
            submenu.insert(&item, 1)?;
            submenu.insert(&PredefinedMenuItem::separator(app)?, 2)?;
        }
        app.set_menu(menu)?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id().as_ref() == CHECK_MENU_ID { spawn_manual(app); }
}
