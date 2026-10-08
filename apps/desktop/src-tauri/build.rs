fn main() {
    // Only the updater commands are exposed to the (remote-origin) webview; see capabilities/main.json.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["update_status", "install_update"]),
        ),
    )
    .expect("failed to run tauri-build");
}
