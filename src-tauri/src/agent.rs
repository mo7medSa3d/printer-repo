use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::Manager;

use crate::paths;
use crate::logging;

const SERVICE_NAME: &str = "OdooPrintAgent";
const BACKGROUND_PID_FILE: &str = "agent.pid";

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

    let path = candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| format!("bundled executable {name} not found; checked resource/current-exe/dev paths"))?;
    logging::info(&format!("resolved executable {name}: {}", path.display()));
    Ok(path)
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
fn background_pid_path() -> Result<PathBuf, String> {
    paths::ensure_agent_data_root()
        .map(|root| root.join(BACKGROUND_PID_FILE))
        .map_err(|e| format!("create agent data dir: {e}"))
}

#[cfg(windows)]
fn read_background_pid() -> Option<u32> {
    let path = background_pid_path().ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    raw.trim().parse::<u32>().ok()
}

#[cfg(windows)]
fn clear_background_pid() {
    if let Ok(path) = background_pid_path() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(windows)]
fn write_background_pid(pid: u32) -> Result<(), String> {
    let path = background_pid_path()?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, pid.to_string())
        .map_err(|e| format!("write background pid: {e}"))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("commit background pid: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn taskkill_pid(pid: u32, force: bool) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let pid_arg = pid.to_string();
    let mut cmd = Command::new("taskkill");
    if force {
        cmd.args(["/PID", &pid_arg, "/T", "/F"]);
    } else {
        cmd.args(["/PID", &pid_arg, "/T"]);
    }
    cmd.creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("taskkill PID {pid} failed: {e}"))
}

#[cfg(windows)]
fn spawn_background(app: &tauri::AppHandle) -> Result<u32, String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let path = agent_path(app)?;
    let root = paths::ensure_agent_data_root()
        .map_err(|e| format!("create agent data dir: {e}"))?;
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
    write_background_pid(pid)?;
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
    if is_running(app) {
        if sc_query().map(|q| q.to_ascii_uppercase().contains("RUNNING")).unwrap_or(false) {
            run_net("stop")?;
        } else {
            #[cfg(windows)]
            {
                let pid = read_background_pid().ok_or_else(|| {
                    "background agent is running but its owned PID record is missing; refusing to kill arbitrary OdooPrintAgent.exe processes".to_string()
                })?;

                let out = taskkill_pid(pid, false)?;
                if !out.status.success() {
                    logging::warn(&format!(
                        "graceful taskkill for owned agent pid={pid} reported: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                } else {
                    logging::info(&format!("graceful shutdown requested for owned agent pid={pid}"));
                }

                for _ in 0..5 {
                    if !is_process_running(app) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }

                if is_process_running(app) {
                    let out = taskkill_pid(pid, true)?;
                    if !out.status.success() {
                        return Err(format!(
                            "force stop of owned agent pid={pid} failed: {}",
                            String::from_utf8_lossy(&out.stderr).trim()
                        ));
                    }
                    logging::warn(&format!("owned agent pid={pid} did not exit within the grace window; forced termination"));
                }
                clear_background_pid();
            }
        }
    }
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
        format!("background process OdooPrintAgent.exe is running (service not detected)")
    } else {
        format!("agent is not running; service/process not detected")
    };
    (service_running || process_running, service_running, note)
}

pub fn control_service(action: &str, app: &tauri::AppHandle) -> Result<String, String> {
    match action {
        "install" | "uninstall" | "start" | "stop" | "restart" => {
            let path = agent_path(app)?;
            let config = paths::agent_config_path();
            let _ = paths::ensure_agent_data_root()
                .map_err(|e| format!("create agent data dir: {e}"))?;
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
                    return Err(format!(
                        "service action {action} failed (administrator may be required): {msg}"
                    ));
                }
                let msg = if !stdout.is_empty() { stdout } else { format!("service action {action} completed") };
                logging::info(&format!("service control {action}: {msg}"));
                return Ok(msg);
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
                    return Err(format!(
                        "service action {action} failed (administrator may be required): {msg}"
                    ));
                }
                let msg = if !stdout.is_empty() { stdout } else { format!("service action {action} completed") };
                logging::info(&format!("service control {action}: {msg}"));
                return Ok(msg);
            }
        }
        _ => Err(format!("invalid service action {:?}", action)),
    }
}
