use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::paths;

static LOG_FILE: OnceLock<Mutex<File>> = OnceLock::new();

/// Initialize the production file logger. Logs are written to a writable
/// ProgramData directory, never to `C:\Program Files\Odoo Print Manager`.
/// Returns the log path on success.
pub fn init() -> Option<PathBuf> {
    let root = paths::ensure_manager_data_root().ok()?;
    let dir = root.join("logs");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[odoo-print-manager] unable to create log dir {}: {e}", dir.display());
        return None;
    }
    let path = dir.join("odoo-print-manager.log");
    let file = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[odoo-print-manager] unable to open log {}: {e}", path.display());
            return None;
        }
    };
    let _ = LOG_FILE.set(Mutex::new(file)).map_err(|_| ());
    info("application logger initialized");
    Some(path)
}

pub fn init_with_path(path: &Path) {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let _ = std::fs::create_dir_all(dir);
    if let Ok(file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = LOG_FILE.set(Mutex::new(file)).map_err(|_| ());
    }
}

pub fn info(msg: &str) {
    write_line("INFO", msg);
}

pub fn warn(msg: &str) {
    write_line("WARN", msg);
}

pub fn error(msg: &str) {
    write_line("ERROR", msg);
}

fn timestamp() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => format!("{}.{:03}", d.as_secs(), d.subsec_millis()),
        Err(_) => "0".to_string(),
    }
}

fn write_line(level: &str, msg: &str) {
    let line = format!("[{}] [{}] {}\n", timestamp(), level, msg);
    {
        if let Some(m) = LOG_FILE.get() {
            if let Ok(mut file) = m.lock() {
                let _ = file.write_all(line.as_bytes());
                let _ = file.flush();
                return;
            }
        }
    }
    // Fallback only for startup failures before the logger is initialized.
    let _ = std::io::stderr().write_all(line.as_bytes());
}
