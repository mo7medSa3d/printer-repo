use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use tauri::Manager;

use crate::logging;
use crate::paths;

const SERVICE_NAME: &str = "OdooPrintAgent";
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(10);
const GRACEFUL_STOP_POLL: Duration = Duration::from_millis(250);

fn resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

pub fn agent_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resolve_executable(app, "OdooPrintAgent.exe")
}

pub fn cli_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resolve_executable(app, "odoo-agent-cli.exe")
}

fn resolve_executable(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir(app) {
        candidates.push(dir.join("resources").join(name));
        candidates.push(dir.join(name));
    }
    if let Some(dir) = current_exe_dir() {
        candidates.push(dir.join("resources").join(name));
        candidates.push(dir.join(name));
    }
    #[cfg(debug_assertions)]
    {
        let dev_base = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("agent");
        candidates.push(dev_base.join(name));
    }

    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| format!("bundled executable {name} not found; checked resource/current-exe/dev paths"))
}

#[cfg(windows)]
fn sc_query() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("sc")
        .args(["query", SERVICE_NAME])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(not(windows))]
fn sc_query() -> Option<String> {
    None
}

#[cfg(windows)]
fn is_running(app: &tauri::AppHandle) -> bool {
    if let Some(q) = sc_query() {
        if q.to_ascii_uppercase().contains("RUNNING") {
            return true;
        }
    }
    is_process_running(app)
}

#[cfg(not(windows))]
fn is_running(_app: &tauri::AppHandle) -> bool {
    false
}

#[cfg(windows)]
fn is_process_running(_app: &tauri::AppHandle) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq OdooPrintAgent.exe", "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains("OdooPrintAgent.exe"),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn is_process_running(_app: &tauri::AppHandle) -> bool {
    false
}

#[cfg(windows)]
fn run_net(action: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("net")
        .args([action, SERVICE_NAME])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to execute net {action} {SERVICE_NAME}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "net {action} {SERVICE_NAME} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(not(windows))]
fn run_net(action: &str) -> Result<String, String> {
    Err(format!("net {action} is only supported on Windows"))
}

#[cfg(windows)]
fn force_kill_agent() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("taskkill")
        .args(["/F", "/IM", "OdooPrintAgent.exe"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("taskkill failed: {e}"))?;
    if !out.status.success() {
        return Err(format!("taskkill failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn force_kill_agent() -> Result<(), String> {
    Err("agent process force-stop is only supported on Windows".into())
}

#[cfg(windows)]
fn stop_background_process_gracefully(app: &tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // taskkill without /F asks Windows to terminate cooperatively first. The
    // agent's signal handler drains in-flight work before exiting.
    let out = Command::new("taskkill")
        .args(["/IM", "OdooPrintAgent.exe"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("graceful taskkill failed: {e}"))?;

    if !out.status.success() && is_process_running(app) {
        return Err(format!(
            "graceful taskkill failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let started = std::time::Instant::now();
    while started.elapsed() < GRACEFUL_STOP_TIMEOUT {
        if !is_process_running(app) {
            return Ok(());
        }
        std::thread::sleep(GRACEFUL_STOP_POLL);
    }

    logging::warn("agent did not stop within graceful timeout; using force termination");
    force_kill_agent()
}

#[cfg(not(windows))]
fn stop_background_process_gracefully(_app: &tauri::AppHandle) -> Result<(), String> {
    Err("background process stop is only supported on Windows".into())
}

#[cfg(windows)]
fn spawn_background(app: &tauri::AppHandle) -> Result<u32, String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let path = agent_path(app)?;
    let root = paths::ensure_agent_data_root().map_err(|e| format!("create agent data dir: {e}"))?;
    let config = root.join("config.yaml");

    let mut cmd = Command::new(&path);
    cmd.arg("-config").arg(&config);
    cmd.env("ODOO_PRINT_AGENT_DATA_DIR", &root);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);

    let child = cmd
        .spawn()
        .map_err(|e| format!("spawn agent {} (config {}) : {e}", path.display(), config.display()))?;
    let pid = child.id();
    logging::info(&format!("started OdooPrintAgent.exe pid={pid} config={}", config.display()));
    Ok(pid)
}

#[cfg(not(windows))]
fn spawn_background(_app: &tauri::AppHandle) -> Result<u32, String> {
    Err("OdooPrintAgent.exe can only be launched on Windows".into())
}

pub fn ensure_started(app: &tauri::AppHandle) -> Result<(), String> {
    if is_running(app) {
        logging::info("agent is already running");
        return Ok(());
    }
    start(app)
}

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    if is_running(app) {
        return Ok(());
    }
    if sc_query().is_some() {
        match run_net("start") {
            Ok(_) => {
                logging::info("agent service started via net start");
                return Ok(());
            }
            Err(e) => logging::warn(&format!("could not start agent service ({e}); falling back to background process")),
        }
    }
    spawn_background(app).map(|_| ())
}

pub fn stop(app: &tauri::AppHandle) -> Result<(), String> {
    if !is_running(app) {
        logging::info("agent already stopped");
        return Ok(());
    }

    if sc_query().map(|q| q.to_ascii_uppercase().contains("RUNNING")).unwrap_or(false) {
        run_net("stop")?;
        logging::info("agent service stop requested");
        return Ok(());
    }

    stop_background_process_gracefully(app)?;
    logging::info("agent stopped");
    Ok(())
}

pub fn restart(app: &tauri::AppHandle) -> Result<(), String> {
    stop(app)?;
    start(app)
}

pub fn status(app: &tauri::AppHandle) -> (bool, bool, String) {
    let service_running = sc_query()
        .map(|q| q.to_ascii_uppercase().contains("RUNNING"))
        .unwrap_or(false);
    let process_running = is_process_running(app);
    let note = if service_running {
        format!("Windows service {SERVICE_NAME} is running")
    } else if process_running {
        "background process OdooPrintAgent.exe is running (service not detected)".to_string()
    } else {
        "agent is not running; service/process not detected".to_string()
    };
    (service_running || process_running, service_running, note)
}

pub fn control_service(action: &str, app: &tauri::AppHandle) -> Result<String, String> {
    match action {
        "install" | "uninstall" | "start" | "stop" | "restart" => {
            let path = agent_path(app)?;
            let config = paths::agent_config_path();
            paths::ensure_agent_data_root().map_err(|e| format!("create agent data dir: {e}"))?;
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let out = Command::new(&path)
                    .args(["-service", action, "-config"])
                    .arg(&config)
                    .env("ODOO_PRINT_AGENT_DATA_DIR", paths::agent_data_root())
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .map_err(|e| format!("failed to run {} -service {action}: {e}", path.display()))?;
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !out.status.success() {
                    let msg = if stderr.is_empty() { stdout.clone() } else { stderr.clone() };
                    return Err(format!("service action {action} failed (administrator may be required): {msg}"));
                }
                let msg = if !stdout.is_empty() { stdout } else { format!("service action {action} completed") };
                logging::info(&format!("service control {action}: {msg}"));
                Ok(msg)
            }
            #[cfg(not(windows))]
            {
                let out = Command::new(&path)
                    .args(["-service", action, "-config"])
                    .arg(&config)
                    .env("ODOO_PRINT_AGENT_DATA_DIR", paths::agent_data_root())
                    .output()
                    .map_err(|e| format!("failed to run {} -service {action}: {e}", path.display()))?;
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !out.status.success() {
                    let msg = if stderr.is_empty() { stdout.clone() } else { stderr.clone() };
                    return Err(format!("service action {action} failed: {msg}"));
                }
                let msg = if !stdout.is_empty() { stdout } else { format!("service action {action} completed") };
                logging::info(&format!("service control {action}: {msg}"));
                Ok(msg)
            }
        }
        _ => Err(format!("invalid service action {:?}", action)),
    }
}
