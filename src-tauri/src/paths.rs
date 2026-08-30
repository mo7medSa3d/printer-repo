use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static MANAGER_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();
static AGENT_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Root for writable Odoo Print Manager state.
///
/// Production Windows preference: `%PROGRAMDATA%\OdooPrintManager`.
/// This is strictly separated from read-only `C:\Program Files\Odoo Print Manager`.
/// If ProgramData is not writable for the current user, a per-user AppData path
/// is used so the desktop can still start on a clean, non-elevated install.
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
    if ensure_dir(&primary).is_ok() {
        let _ = MANAGER_DATA_ROOT.set(primary.clone());
        return Ok(primary);
    }
    let fallback = local_manager_data_root();
    ensure_dir(&fallback)?;
    let _ = MANAGER_DATA_ROOT.set(fallback.clone());
    Ok(fallback)
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

fn local_manager_data_root() -> PathBuf {
    if let Ok(dir) = std::env::var("LOCALAPPDATA") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir).join("OdooPrintManager");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config").join("odoo-print-manager");
    }
    manager_data_root_candidate()
}

/// Root for the Go agent's writable runtime data.
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
    if ensure_dir(&primary).is_ok() {
        let _ = AGENT_DATA_ROOT.set(primary.clone());
        return Ok(primary);
    }
    let fallback = local_agent_data_root();
    ensure_dir(&fallback)?;
    let _ = AGENT_DATA_ROOT.set(fallback.clone());
    Ok(fallback)
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

fn local_agent_data_root() -> PathBuf {
    if let Ok(dir) = std::env::var("LOCALAPPDATA") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir).join("OdooPrintAgent");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config").join("odoo-print-agent");
    }
    agent_data_root_candidate()
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

pub fn ensure_runtime_dirs() -> std::io::Result<()> {
    ensure_manager_data_root()?;
    ensure_dir(&manager_log_dir())?;
    ensure_agent_data_root()?;
    Ok(())
}
