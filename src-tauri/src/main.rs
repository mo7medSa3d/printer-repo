#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod tray;

use tauri::Manager;

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_store::Builder::default().build())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
    .plugin(tauri_plugin_process::init())
    .setup(|app| {
      tray::setup_tray(app.handle())?;
      // Hide on close: window close => hide, not exit. Tray Exit does real exit.
      if let Some(win) = app.get_webview_window("main") {
        let handle = win.clone();
        win.on_window_event(move |e| {
          if let tauri::WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            let _ = handle.hide();
          }
        });
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::get_agent_status,
      commands::control_service,
      commands::pair_agent,
      commands::get_gateway_config,
      commands::set_gateway_config,
      commands::get_app_version
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri app");
}
