use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::paths;

static LOG_FILE: OnceLock<Mutex<File>> = OnceLock::new();

/// Rotate the log once it grows past this size; rotated copies are kept under
/// `name.1` … `name.3` next to the live file.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB
const MAX_ROTATED_FILES: u32 = 3;

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
    rotate_if_full(&path);
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
    let _ = LOG_FILE.set(Mutex::new(file));
    info("application logger initialized");
    Some(path)
}

/// If `path` exceeds MAX_LOG_BYTES, shift `path.1..MAX` up by one and rename
/// `path` to `path.1`, so the current file starts empty. All failures are
/// ignored on purpose: logging must never prevent the app from starting.
fn rotate_if_full(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() <= MAX_LOG_BYTES {
        return;
    }
    let _ = std::fs::remove_file(rotated_path(path, MAX_ROTATED_FILES));
    for i in (1..MAX_ROTATED_FILES).rev() {
        let from = rotated_path(path, i);
        if from.exists() {
            let _ = std::fs::rename(&from, rotated_path(path, i + 1));
        }
    }
    let _ = std::fs::rename(path, rotated_path(path, 1));
}

fn rotated_path(path: &Path, index: u32) -> PathBuf {
    PathBuf::from(format!("{}.{index}", path.display()))
}

/// Route Rust panics into the log file. Release builds use the Windows GUI
/// subsystem (no console), so an unhandled panic would otherwise abort the
/// process without any trace. The hook writes a PANIC line with location and
/// payload before the default unwinding continues.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        write_line("PANIC", &format!("panic at {location}: {payload}"));
    }));
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
