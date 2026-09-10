use std::process::Command;

use crate::{agent, logging, paths};

/// Remove only completed/failed records from the Agent's local SQLite queue.
/// Queued and printing jobs are never targeted by the maintenance command.
#[tauri::command]
pub async fn cleanup_local_jobs(app: tauri::AppHandle) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cli = agent::cli_path(&app)?;
        let config = paths::agent_config_path();
        // The CLI resolves its data dir from this env var (same propagation
        // as every other spawn site): without it the cleanup command could
        // open a DIFFERENT queue database than the running agent when a
        // custom data root is configured.
        let mut cmd = Command::new(&cli);
        cmd.arg("jobs")
            .arg("cleanup")
            .arg("-config")
            .arg(&config)
            .arg("--json")
            .env("ODOO_PRINT_AGENT_DATA_DIR", paths::agent_data_root());
        // Suppress the console window that would otherwise flash for each
        // cleanup invocation from the GUI app (Windows only).
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("failed to run odoo-agent-cli.exe: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !output.status.success() {
            let message = if stderr.is_empty() { stdout } else { stderr };
            logging::error(&format!("local print-job cleanup failed: {message}"));
            return Err(message);
        }

        #[derive(serde::Deserialize)]
        struct CleanupResult {
            deleted: u64,
        }

        let result: CleanupResult = serde_json::from_str(&stdout)
            .map_err(|e| format!("invalid cleanup response: {e}"))?;
        logging::info(&format!("local print-job cleanup removed {} terminal jobs", result.deleted));
        Ok(result.deleted)
    })
    .await
    .map_err(|e| format!("cleanup background task failed: {e}"))?
}
