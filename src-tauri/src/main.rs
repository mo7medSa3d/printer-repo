#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod cleanup;
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

            // Runtime dirs are strictly %PROGRAMDATA% (no per-user fallback,
            // so desktop and service share one home). A non-elevated launch
            // cannot create them — warn and continue so the app still opens
            // and the elevation banner + per-operation admin errors guide
            // the operator to relaunch as administrator.
            if let Err(e) = paths::ensure_runtime_dirs() {
                logging::error(&format!(
                    "unable to create runtime dirs (run as administrator): {e}"
                ));
            }

            logging::info(&format!(
                "runtime dirs: manager={}, agent={}",
                paths::manager_data_root().display(),
                paths::agent_data_root().display()
            ));

            #[cfg(windows)]
            {
                use tauri_plugin_autostart::ManagerExt;
                apply_first_launch_autostart(
                    &paths::manager_data_root().join("autostart-user-choice"),
                    || app.autolaunch().enable().map_err(|e| e.to_string()),
                    |path| std::fs::write(path, "1").map_err(|e| e.to_string()),
                );
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
                logging::warn(&format!(
                    "agent could not be started during setup: {e}"
                ));
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
            commands::get_app_version,
            commands::get_printers,
            commands::discover_printers,
            commands::test_printer,
            cleanup::cleanup_local_jobs,
            commands::register_printer,
            commands::get_autostart,
            commands::set_autostart,
            commands::is_running_as_admin
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

    app.run(|_app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            logging::info("application exit requested")
        }
        tauri::RunEvent::Exit => {
            logging::info("application exited")
        }
        _ => {}
    });
}

/// Autostart defaults to ON only on the FIRST launch. Once the user has made
/// a choice (`set_autostart` writes the marker file) this must not override
/// it — the old unconditional `enable()` silently re-enabled autostart on
/// every app start, breaking the user's "off" choice (audit #21).
///
/// The marker means "a default-enable SUCCEEDED or the user chose", never
/// "we tried": when `enable()` fails the marker must NOT be written, so the
/// next launch retries instead of being permanently suppressed by a false
/// success record.
#[cfg(windows)]
fn apply_first_launch_autostart(
    marker: &std::path::Path,
    enable: impl FnOnce() -> Result<(), String>,
    write_marker: impl FnOnce(&std::path::Path) -> Result<(), String>,
) {
    if marker.exists() {
        logging::info("desktop autostart left as configured by the user");
        return;
    }
    match enable() {
        Ok(()) => {
            logging::info("desktop autostart enabled by default on first launch");
            if let Err(e) = write_marker(marker) {
                logging::warn(&format!("could not persist autostart marker: {e}"));
            }
        }
        Err(e) => {
            // No marker: a failed first attempt must remain RETRYABLE on the
            // next launch. This is the defect this function now proves.
            logging::warn(&format!(
                "desktop autostart could not be enabled by default (will retry on next launch): {e}"
            ));
        }
    }
}

#[cfg(all(test, windows))]
mod autostart_tests {
    use super::apply_first_launch_autostart;

    fn temp_marker(test: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("odoo-autostart-{test}-{:?}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("autostart-user-choice")
    }

    #[test]
    fn first_launch_enable_success_persists_the_marker() {
        let marker = temp_marker("ok");
        let _ = std::fs::remove_file(&marker);
        apply_first_launch_autostart(&marker, || Ok(()), |p| std::fs::write(p, "1").map_err(|e| e.to_string()));
        assert!(marker.exists(), "successful default-enable must record the marker");
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn first_launch_enable_failure_must_not_persist_a_false_marker() {
        // THE regression: previously the marker was written even when
        // enable() failed, permanently suppressing the retry.
        let marker = temp_marker("fail");
        let _ = std::fs::remove_file(&marker);
        let marker_written = std::cell::Cell::new(false);
        apply_first_launch_autostart(
            &marker,
            || Err("registry denied".to_string()),
            |_p| {
                marker_written.set(true);
                Ok(())
            },
        );
        assert!(!marker_written.get(), "failed enable must not invoke the marker write at all");
        assert!(!marker.exists(), "failed enable must leave the state retryable (no marker)");
    }

    #[test]
    fn marker_present_never_re_enables_on_subsequent_launches() {
        // Covers both the post-default-enable relaunch and the explicit user
        // choice (set_autostart writes the same marker): enable() must not run.
        let marker = temp_marker("present");
        std::fs::write(&marker, "1").unwrap();
        let mut enable_called = false;
        apply_first_launch_autostart(
            &marker,
            || {
                enable_called = true;
                Ok(())
            },
            |_p| Ok(()),
        );
        assert!(!enable_called, "an existing marker means the decision is already recorded");
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn marker_write_failure_on_success_is_logged_not_fatal() {
        let marker = temp_marker("writefail");
        let _ = std::fs::remove_file(&marker);
        apply_first_launch_autostart(&marker, || Ok(()), |_p| Err("disk full".to_string()));
        assert!(!marker.exists());
    }
}
