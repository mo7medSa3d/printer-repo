use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static MANAGER_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();
static AGENT_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Root for writable Odoo Print Manager state.
///
/// STRICTLY `%PROGRAMDATA%\OdooPrintManager` on Windows: the desktop app and
/// the Windows Service (LocalSystem) must read and write the SAME location,
/// so no per-user fallback exists by design. If this process cannot write
/// there, every mutating operation fails closed with an Administrator
/// message and the UI shows an elevation banner (see is_running_as_admin).
pub fn manager_data_root() -> PathBuf {
    if let Some(p) = MANAGER_DATA_ROOT.get() {
        return p.clone();
    }
    manager_data_root_candidate()
}

pub fn ensure_manager_data_root() -> std::io::Result<PathBuf> {
    if let Some(p) = MANAGER_DATA_ROOT.get() {
        return Ok(p.clone());
    }
    let primary = manager_data_root_candidate();
    if let Err(e) = ensure_dir(&primary) {
        return Err(admin_required_error("manager data dir", &primary, &e));
    }
    let _ = MANAGER_DATA_ROOT.set(primary.clone());
    Ok(primary)
}

fn manager_data_root_candidate() -> PathBuf {
    if let Ok(override_dir) = std::env::var("ODOO_PRINT_MANAGER_DATA_DIR") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    if let Ok(pd) = std::env::var("PROGRAMDATA") {
        if !pd.trim().is_empty() {
            return PathBuf::from(pd).join("OdooPrintManager");
        }
    }
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\ProgramData\OdooPrintManager")
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(".config").join("odoo-print-manager")
        } else {
            PathBuf::from("/tmp/odoo-print-manager")
        }
    }
}

/// Root for the Go agent's writable runtime data.
///
/// STRICTLY `%PROGRAMDATA%\OdooPrintAgent` on Windows, for the same
/// no-split-brain reason as the manager root: the desktop-spawned agent
/// (pid file, config, queue) and the Windows Service must share one home.
pub fn agent_data_root() -> PathBuf {
    if let Some(p) = AGENT_DATA_ROOT.get() {
        return p.clone();
    }
    agent_data_root_candidate()
}

pub fn ensure_agent_data_root() -> std::io::Result<PathBuf> {
    if let Some(p) = AGENT_DATA_ROOT.get() {
        return Ok(p.clone());
    }
    let primary = agent_data_root_candidate();
    if let Err(e) = ensure_dir(&primary) {
        return Err(admin_required_error("agent data dir", &primary, &e));
    }
    let _ = AGENT_DATA_ROOT.set(primary.clone());
    Ok(primary)
}

fn agent_data_root_candidate() -> PathBuf {
    if let Ok(override_dir) = std::env::var("ODOO_PRINT_AGENT_DATA_DIR") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    if let Ok(pd) = std::env::var("PROGRAMDATA") {
        if !pd.trim().is_empty() {
            return PathBuf::from(pd).join("OdooPrintAgent");
        }
    }
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\ProgramData\OdooPrintAgent")
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(".config").join("odoo-print-agent")
        } else {
            PathBuf::from("/tmp/odoo-print-agent")
        }
    }
}

pub fn settings_path() -> PathBuf {
    manager_data_root().join("settings.json")
}

pub fn agent_config_path() -> PathBuf {
    agent_data_root().join("config.yaml")
}

pub fn manager_log_dir() -> PathBuf {
    manager_data_root().join("logs")
}

pub fn manager_log_path() -> PathBuf {
    manager_log_dir().join("odoo-print-manager.log")
}

pub fn ensure_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

/// Fail-closed directory error: directory creation is where a missing
/// Administrator privilege surfaces first. State it explicitly so callers
/// (and the UI banner) can tell the operator to relaunch elevated instead
/// of showing a raw os error.
fn admin_required_error(what: &str, path: &Path, e: &std::io::Error) -> std::io::Error {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        std::io::Error::new(
            e.kind(),
            format!(
                "cannot create {what} ({}): access denied. Run the app as administrator",
                path.display()
            ),
        )
    } else {
        std::io::Error::new(
            e.kind(),
            format!("cannot create {what} ({}): {e}", path.display()),
        )
    }
}

pub fn ensure_runtime_dirs() -> std::io::Result<()> {
    ensure_manager_data_root()?;
    ensure_dir(&manager_log_dir())?;
    ensure_agent_data_root()?;
    Ok(())
}
