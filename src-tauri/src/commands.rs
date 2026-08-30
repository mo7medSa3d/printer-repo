use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

use crate::agent;
use crate::logging;
use crate::paths;

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
pub fn get_agent_status(app: tauri::AppHandle) -> AgentStatus {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into());
    let (running, _service_running, note) = agent::status(&app);
    AgentStatus {
        running,
        service: "OdooPrintAgent".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        hostname,
        last_heartbeat: None,
        ws_connected: running,
        note,
    }
}

#[tauri::command]
pub fn start_agent(app: tauri::AppHandle) -> Result<String, String> {
    agent::start(&app).map(|_| "agent started".into())
}

#[tauri::command]
pub fn stop_agent(app: tauri::AppHandle) -> Result<String, String> {
    agent::stop(&app).map(|_| "agent stopped".into())
}

#[tauri::command]
pub fn restart_agent(app: tauri::AppHandle) -> Result<String, String> {
    agent::restart(&app).map(|_| "agent restarted".into())
}

#[tauri::command]
pub fn control_service(action: String, app: tauri::AppHandle) -> Result<String, String> {
    agent::control_service(&action, &app)
}

#[derive(Deserialize)]
pub struct PairArgs {
    pub code: String,
    pub gateway_url: String,
}

fn is_valid_code(s: &str) -> bool {
    let t = s.trim().to_uppercase();
    t.len() == 6
        && t.chars()
            .all(|c| matches!(c, 'A'..='H' | 'J'..='N' | 'P'..='Z' | '2'..='9'))
}

#[tauri::command]
pub fn pair_agent(args: PairArgs, app: tauri::AppHandle) -> Result<String, String> {
    let code = args.code.trim().to_uppercase();
    if !is_valid_code(&code) {
        return Err("pairing code must be a 6-character code from the dashboard (letters without O/I and digits without 0/1)".into());
    }
    let gateway_url = args.gateway_url.trim().trim_end_matches('/').to_string();
    if !(gateway_url.starts_with("https://") || gateway_url.starts_with("http://")) {
        return Err("gateway_url must be https:// or http://".into());
    }

    let cli = agent::cli_path(&app)?;
    let config = paths::agent_config_path();
    paths::ensure_agent_data_root().map_err(|e| format!("create agent data dir: {e}"))?;

    logging::info(&format!("pairing agent (server={gateway_url})"));
    let out = Command::new(&cli)
        .arg("-pair")
        .arg(&code)
        .arg("-server")
        .arg(&gateway_url)
        .arg("-config")
        .arg(&config)
        .env("ODOO_PRINT_AGENT_DATA_DIR", paths::agent_data_root())
        .output()
        .map_err(|e| format!("failed to run odoo-agent-cli.exe: {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        let msg = if stderr.is_empty() { stdout.clone() } else { stderr.clone() };
        logging::error(&format!("pairing failed: {msg}"));
        return Err(msg);
    }
    // Do not echo anything that could contain the secret. Register only prints
    // the agent id and a success hint; keep that contract on the Rust side.
    logging::info(&format!("pairing succeeded: {stdout}"));
    Ok(stdout)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GatewayConfig {
    pub url: String,
}

fn read_file_or_default(path: &PathBuf) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".into()),
        Err(e) => Err(format!("failed to read settings {}: {e}", path.display())),
    }
}

#[tauri::command]
pub fn get_gateway_config() -> GatewayConfig {
    let path = paths::settings_path();
    let defaults = GatewayConfig { url: String::new() };
    let raw = match read_file_or_default(&path) {
        Ok(r) => r,
        Err(e) => {
            logging::error(&e);
            return defaults;
        }
    };
    match serde_json::from_str::<GatewayConfig>(&raw) {
        Ok(c) => c,
        Err(e) => {
            // A corrupt/old settings file must not prevent the app from starting.
            logging::warn(&format!("settings corrupted, using defaults: {e}; path={}", path.display()));
            defaults
        }
    }
}

#[tauri::command]
pub fn set_gateway_config(url: String) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("url must be https:// or http://".into());
    }
    let path = paths::settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create settings dir: {e}"))?;
    }
    let cfg = GatewayConfig { url };
    let json = serde_json::to_string_pretty(&cfg)
        .map_err(|e| format!("serialize settings: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("write settings {}: {e}", path.display()))?;
    logging::info(&format!("gateway settings saved to {}", path.display()));
    Ok(format!("saved gateway settings to {}", path.display()))
}

#[tauri::command]
pub fn get_runtime_paths() -> (String, String, String, String) {
    (
        paths::manager_data_root().display().to_string(),
        paths::settings_path().display().to_string(),
        paths::agent_config_path().display().to_string(),
        paths::manager_log_path().display().to_string(),
    )
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").into()
}
