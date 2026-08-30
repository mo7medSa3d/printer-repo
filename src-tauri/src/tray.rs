use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
  Emitter,
  Manager,
};

/// Menu ids emitted to the frontend as `tray:navigate` payloads. The desktop
/// UI owns the sections with these names; navigation happens inside the WebView
/// (no `eval` permission required).
const NAV_GATEWAY: &str = "#gateway";
const NAV_AGENT: &str = "#agent";
const NAV_PAIR: &str = "#pair";
const NAV_SETTINGS: &str = "#settings";

fn reveal_main_window(app: &tauri::AppHandle) {
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.show();
    let _ = w.set_focus();
  }
}

pub fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
  let open = MenuItem::with_id(app, "open", "Open Manager", true, None::<&str>)?;
  let gateway = MenuItem::with_id(app, NAV_GATEWAY, "Gateway", true, None::<&str>)?;
  let agent = MenuItem::with_id(app, NAV_AGENT, "Local Agent", true, None::<&str>)?;
  let pair = MenuItem::with_id(app, NAV_PAIR, "Pair Agent", true, None::<&str>)?;
  let settings = MenuItem::with_id(app, NAV_SETTINGS, "Settings", true, None::<&str>)?;
  let restart = MenuItem::with_id(app, "restart_agent", "Restart Agent", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;

  let menu = Menu::with_items(
    app,
    &[&open, &gateway, &agent, &pair, &settings, &restart, &quit],
  )?;

  let icon = match app.default_window_icon() {
    Some(icon) => icon.clone(),
    None => {
      return Err(tauri::Error::from(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "default window icon missing from bundled icons",
      )))
    }
  };

  let _tray = TrayIconBuilder::with_id("main-tray")
    .tooltip("Odoo Print Manager — Cloud/Agent status: open for details")
    .icon(icon)
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "open" => reveal_main_window(app),
      "quit" => app.exit(0),
      "restart_agent" => {
        // The frontend owns the busy/feedback state; it invokes the actual
        // restart command when it receives this event.
        reveal_main_window(app);
        if let Some(w) = app.get_webview_window("main") {
          let _ = w.emit("tray:restart_agent", ());
        }
      }
      id if id.starts_with('#') => {
        reveal_main_window(app);
        if let Some(w) = app.get_webview_window("main") {
          let _ = w.emit("tray:navigate", id);
        }
      }
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
        reveal_main_window(tray.app_handle());
      }
    })
    .build(app)?;

  Ok(())
}
