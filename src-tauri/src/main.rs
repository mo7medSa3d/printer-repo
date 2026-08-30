#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod commands;
mod logging;
mod paths;
mod tray;

use tauri::Manager;

fn main() {
    // Initialize file logging before the Tauri builder so startup failures are
    // visible in a writable ProgramData location rather than disappearing.
    if logging::init().is_none() {
        eprintln!("[odoo-print-manager] file logging could not be initialized");
    }
    // Release builds have no console; make panics land in the log file.
    logging::install_panic_hook();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            logging::info("application setup started");

            paths::ensure_runtime_dirs().map_err(|e| {
                let msg = format!("unable to create runtime dirs: {e}");
                logging::error(&msg);
                msg
            })?;
            logging::info(&format!(
                "runtime dirs: manager={}, agent={}",
                paths::manager_data_root().display(),
                paths::agent_data_root().display()
            ));

            // Register the desktop manager to launch on Windows login/reboot.
            // The setup() handler then starts the bundled agent so a normal
            // user gets the full stack again after a reboot.
            #[cfg(windows)]
            {
                use tauri_plugin_autostart::ManagerExt;
                match app.autolaunch().enable() {
                    Ok(_) => logging::info("desktop autostart enabled at Windows login"),
                    Err(e) => logging::warn(&format!("desktop autostart could not be enabled: {e}")),
                }
            }

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

            // Start exactly one agent. A missing/unregistered configuration is
            // not fatal to the desktop app; the agent logs the situation.
            if let Err(e) = agent::ensure_started(app.handle()) {
                logging::warn(&format!("agent could not be started during setup: {e}"));
            } else {
                logging::info("agent process/service started during setup");
            }

            logging::info("application setup completed");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_agent_status,
            commands::start_agent,
            commands::stop_agent,
            commands::restart_agent,
            commands::control_service,
            commands::pair_agent,
            commands::get_gateway_config,
            commands::set_gateway_config,
            commands::get_runtime_paths,
            commands::get_app_version
        ])
        .build(tauri::generate_context!());

    let app = match result {
        Ok(app) => app,
        Err(e) => {
            let msg = format!("error while building tauri app: {e}");
            logging::error(&msg);
            eprintln!("{msg}");
            std::process::exit(1);
        }
    };

    let result = app.run(|_app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => logging::info("application exit requested"),
        tauri::RunEvent::Exit => logging::info("application exited"),
        _ => {}
    });

    if let Err(e) = result {
        let msg = format!("error while running tauri app: {e}");
        logging::error(&msg);
        eprintln!("{msg}");
        std::process::exit(1);
    }
}
