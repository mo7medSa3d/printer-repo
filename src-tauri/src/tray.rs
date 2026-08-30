use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
  Emitter,
  Manager,
};

pub fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
  let open = MenuItem::with_id(app, "open", "Open Manager", true, None::<&str>)?;
  let printers = MenuItem::with_id(app, "printers", "Printers", true, None::<&str>)?;
  let jobs = MenuItem::with_id(app, "jobs", "Jobs", true, None::<&str>)?;
  let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
  let restart = MenuItem::with_id(app, "restart_agent", "Restart Agent", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;

  let menu = Menu::with_items(app, &[&open, &printers, &jobs, &settings, &restart, &quit])?;

  let _tray = TrayIconBuilder::with_id("main-tray")
    .tooltip("Odoo Print Manager\n● Cloud Online (poll) \n● Agent via Gateway\n● Printers via Agent → LAN")
    .icon(app.default_window_icon().unwrap().clone())
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "open" => {
        if let Some(w) = app.get_webview_window("main") {
          let _ = w.show();
          let _ = w.set_focus();
        }
      }
      "printers" | "jobs" | "settings" => {
        if let Some(w) = app.get_webview_window("main") {
          let _ = w.show();
          let _ = w.set_focus();
          let _ = w.eval(format!("window.location.hash='#{}'", event.id.as_ref()));
        }
      }
      "restart_agent" => {
        // Thin: frontend will invoke control_service("restart") via allowlisted shell
        if let Some(w) = app.get_webview_window("main") {
          let _ = w.emit("tray:restart_agent", ());
        }
      }
      "quit" => {
        app.exit(0);
      }
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
        let app = tray.app_handle();
        if let Some(w) = app.get_webview_window("main") {
          let _ = w.show();
          let _ = w.set_focus();
        }
      }
    })
    .build(app)?;

  Ok(())
}
