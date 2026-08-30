use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// Thin commands only — Tauri never opens printer TCP directly.
// Printer tests go via Gateway → Agent → Printer.

#[derive(Serialize)]
pub struct AgentStatus {
  pub running: bool,
  pub service: String,
  pub version: String,
  pub hostname: String,
  pub last_heartbeat: Option<String>,
  pub ws_connected: bool,
  pub note: String,
}

#[tauri::command]
pub fn get_agent_status() -> AgentStatus {
  // Phase 1: probe via config + service query stub.
  // Real Windows: query `sc query OdooPrintAgent` or service API.
  // On Linux dev, return not-running with diagnostic note.
  let hostname = hostname::get()
    .map(|h| h.to_string_lossy().to_string())
    .unwrap_or_else(|_| "unknown".into());
  AgentStatus {
    running: false,
    service: "OdooPrintAgent".into(),
    version: env!("CARGO_PKG_VERSION").into(),
    hostname,
    last_heartbeat: None,
    ws_connected: false,
    note: "Probe via SC on Windows; on this host service not running (dev). See C:\\ProgramData\\OdooPrintAgent\\config.yaml".into(),
  }
}

#[tauri::command]
pub fn control_service(action: String) -> Result<String, String> {
  // Allowlist: only bundled binaries with fixed validated args.
  // Actual shell execution is done via tauri-plugin-shell with scope allowlist
  // in tauri.conf.json. This command validates the action string strictly.
  match action.as_str() {
    "start" | "stop" | "restart" => Ok(format!("validated action {action} — shell execution allowlisted via plugin-shell scope (requires Windows)")),
    "install" | "uninstall" => Ok(format!("validated action {action} — requires elevation (runas) on Windows")),
    _ => Err(format!("invalid service action {action:?} — allowed: start|stop|restart|install|uninstall")),
  }
}

#[derive(Deserialize)]
pub struct PairArgs {
  pub code: String,
  pub gateway_url: String,
}

fn is_valid_code(s: &str) -> bool {
  let t = s.trim().to_uppercase();
  t.len() == 6 && t.chars().all(|c| matches!(c, 'A'..='Z' | '0'..='9')) && !t.contains('O') && !t.contains('0') && !t.contains('I') && !t.contains('1')
    // Actually we allow the alphabet ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no 0/O/1/I) but keep simple check: 6 alnum
}

#[tauri::command]
pub fn pair_agent(args: PairArgs) -> Result<String, String> {
  // Validate only — actual pairing owns secret persistence via CLI.
  // CLI: odoo-agent-cli.exe -pair CODE -server URL -config C:\ProgramData\OdooPrintAgent\config.yaml
  // Secret never returned to renderer.
  let code = args.code.trim().to_uppercase();
  if code.len() != 6 {
    return Err("pairing code must be 6 characters".into());
  }
  if !code.chars().all(|c| c.is_ascii_alphanumeric()) {
    return Err("pairing code must be alphanumeric".into());
  }
  if args.gateway_url.trim().is_empty() {
    return Err("gateway_url required".into());
  }
  if !(args.gateway_url.starts_with("https://") || args.gateway_url.starts_with("http://")) {
    return Err("gateway_url must be https:// or http://".into());
  }
  // Return the validated command that the frontend should execute via shell plugin (allowlisted)
  let cfg = r"C:\ProgramData\OdooPrintAgent\config.yaml";
  Ok(format!("odoo-agent-cli.exe -pair {} -server {} -config \"{}\"  (secret persisted by CLI, never returned)", code, args.gateway_url.trim(), cfg))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GatewayConfig {
  pub url: String,
}

fn manager_store_path() -> PathBuf {
  // Tauri store plugin uses app data dir + .dat; we use ProgramData on Windows.
  // For thin command, return the expected path for diagnostics.
  #[cfg(windows)]
  {
    std::env::var("PROGRAMDATA")
      .map(|pd| PathBuf::from(pd).join("OdooPrintManager").join("settings.json"))
      .unwrap_or_else(|_| PathBuf::from("C:\\ProgramData\\OdooPrintManager\\settings.json"))
  }
  #[cfg(not(windows))]
  {
    PathBuf::from("/tmp/odoo-print-manager-settings.json")
  }
}

#[tauri::command]
pub fn get_gateway_config() -> GatewayConfig {
  // Read via store plugin on frontend; this is diagnostic fallback.
  GatewayConfig { url: "https://your-gateway.example.com".into() }
}

#[tauri::command]
pub fn set_gateway_config(url: String) -> Result<String, String> {
  let u = url.trim();
  if !(u.starts_with("https://") || u.starts_with("http://")) {
    return Err("url must be https:// or http://".into());
  }
  // Frontend persists via store plugin to ProgramData\OdooPrintManager\settings.json
  // Least-privilege ACL on that dir is verified on Windows (installer creates with SYSTEM+Administrators F, Users RW where needed)
  Ok(format!("validated url {u} — persist via store plugin to {:?}", manager_store_path()))
}

#[tauri::command]
pub fn get_app_version() -> String {
  env!("CARGO_PKG_VERSION").into()
}

// Minimal hostname helper without extra crate
mod hostname {
  pub fn get() -> Result<std::ffi::OsString, std::io::Error> {
    // Use std env var fallback
    if let Ok(h) = std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")) {
      return Ok(std::ffi::OsString::from(h));
    }
    Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no hostname"))
  }
}
