use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::collections::HashMap;

use crate::agent;
use crate::logging;
use crate::paths;

/// Execute a blocking operation (process spawn, sc.exe/tasklist, or the
/// pairing CLI's HTTP round-trip) on Tauri's blocking thread pool. Tauri runs
/// synchronous commands on the main thread, so without this every long action
/// would freeze the WebView2 UI for its entire duration.
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

#[derive(Serialize)]
pub struct AgentStatus {
    pub running: bool,
    pub service: String,
    pub version: String,
    pub hostname: String,
    pub note: String,
}

#[tauri::command]
pub fn is_running_as_admin() -> bool {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        type HANDLE = *mut c_void;
        type BOOL = i32;
        type DWORD = u32;

        #[repr(C)]
        struct TOKEN_ELEVATION {
            token_is_elevated: DWORD,
        }

        const TOKEN_QUERY: DWORD = 0x0008;
        const TOKEN_ELEVATION_TYPE: DWORD = 20;

        extern "system" {
            fn GetCurrentProcess() -> HANDLE;
            fn OpenProcessToken(process: HANDLE, desired_access: DWORD, token: *mut HANDLE) -> BOOL;
            fn GetTokenInformation(
                token: HANDLE,
                class: DWORD,
                info: *mut c_void,
                len: DWORD,
                ret_len: *mut DWORD,
            ) -> BOOL;
            fn CloseHandle(handle: HANDLE) -> BOOL;
        }

        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION { token_is_elevated: 0 };
            let mut ret_len: DWORD = 0;
            let ok = GetTokenInformation(
                token,
                TOKEN_ELEVATION_TYPE,
                &mut elevation as *mut _ as *mut c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as DWORD,
                &mut ret_len,
            );
            CloseHandle(token);
            ok != 0 && elevation.token_is_elevated != 0
        }
    }
    #[cfg(not(windows))]
    {
        true
    }
}

#[tauri::command]
pub async fn get_agent_status(app: tauri::AppHandle) -> AgentStatus {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into());
    let base = AgentStatus {
        running: false,
        service: "OdooPrintAgent".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        hostname,
        note: String::new(),
    };
    // `sc query` + `tasklist` are fast but still subprocess I/O; keep them off
    // the UI thread for consistency with the rest of the command surface.
    //
    // Only LOCAL process/service state is reported here. The agent's gateway
    // WS-connection state and last heartbeat live on the Gateway (the desktop
    // has no manager credential to query them), so they are deliberately NOT
    // included — no invented values.
    match tauri::async_runtime::spawn_blocking(move || agent::status(&app)).await {
        Ok((running, _service_running, note)) => AgentStatus {
            running,
            note,
            ..base
        },
        Err(e) => AgentStatus {
            note: format!("status check failed: {e}"),
            ..base
        },
    }
}

#[tauri::command]
pub async fn start_agent(app: tauri::AppHandle) -> Result<String, String> {
    run_blocking(move || agent::start(&app)).await.map(|_| "agent started".into())
}

#[tauri::command]
pub async fn stop_agent(app: tauri::AppHandle) -> Result<String, String> {
    run_blocking(move || agent::stop(&app)).await.map(|_| "agent stopped".into())
}

#[tauri::command]
pub async fn restart_agent(app: tauri::AppHandle) -> Result<String, String> {
    run_blocking(move || agent::restart(&app)).await.map(|_| "agent restarted".into())
}

#[tauri::command]
pub async fn control_service(action: String, app: tauri::AppHandle) -> Result<String, String> {
    run_blocking(move || agent::control_service(&action, &app)).await
}

#[derive(Deserialize)]
pub struct PairArgs {
    pub code: String,
    pub gateway_url: String,
}

fn normalize_gateway_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("gateway URL cannot be empty".into());
    }
    if url.contains(char::is_whitespace) {
        return Err("gateway URL cannot contain whitespace".into());
    }
    let parsed = url.parse::<url::Url>().map_err(|e| format!("invalid gateway URL: {e}"))?;
    let scheme = parsed.scheme();
    // Zero-configuration: both http and https are accepted for any valid
    // hostname or IP (LAN, public, loopback) with no environment opt-in.
    if scheme != "https" && scheme != "http" {
        return Err("gateway URL must use http:// or https://".into());
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("gateway URL cannot include embedded credentials".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("gateway URL cannot include query strings or fragments".into());
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

/// Pairing codes are generated by the gateway as 6 characters from an
/// unambiguous alphabet (no O/I, no 0/1) — mirror of the gateway contract.
fn is_valid_code(s: &str) -> bool {
    let t = s.trim().to_uppercase();
    t.len() == 6
        && t.chars()
            .all(|c| matches!(c, 'A'..='H' | 'J'..='N' | 'P'..='Z' | '2'..='9'))
}

#[tauri::command]
pub async fn pair_agent(args: PairArgs, app: tauri::AppHandle) -> Result<String, String> {
    // Cheap validation happens before dispatching to the blocking pool so the
    // UI gets immediate feedback on malformed input.
    let code = args.code.trim().to_uppercase();
    if !is_valid_code(&code) {
        return Err("pairing code must be a 6-character code from the dashboard (letters without O/I and digits without 0/1)".into());
    }
    let gateway_url = normalize_gateway_url(&args.gateway_url)?;
    run_blocking(move || run_pairing(app, &code, &gateway_url)).await
}

/// The actual pairing: invokes the bundled CLI, which performs the HTTPS
/// register call and writes the credentials to the agent config. The returned
/// stdout only contains the agent id by CLI contract — never the secret.
fn run_pairing(app: tauri::AppHandle, code: &str, gateway_url: &str) -> Result<String, String> {
    let cli = agent::cli_path(&app)?;
    let config = paths::agent_config_path();
    paths::ensure_agent_data_root()
        .map_err(|e| format!("create agent data dir: {e}"))?;

    logging::info(&format!("pairing agent (server={gateway_url})"));
    let mut cmd = Command::new(&cli);
    cmd.arg("-pair")
        .arg(code)
        .arg("-server")
        .arg(gateway_url)
        .arg("-config")
        .arg(&config)
        .env("ODOO_PRINT_AGENT_DATA_DIR", paths::agent_data_root());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("failed to run odoo-agent-cli.exe: {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        let msg = if stderr.is_empty() { stdout } else { stderr };
        logging::error(&format!("pairing failed: {msg}"));
        return Err(msg);
    }
    // Do not echo anything that could contain the secret. Register only prints
    // the agent id and a success hint; keep that contract on the Rust side.
    logging::info(&format!("pairing succeeded: {stdout}"));
    Ok(stdout)
}

#[derive(Deserialize)]
pub struct GatewayRequestArgs {
    pub path: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Serialize)]
pub struct GatewayResponse {
    pub status: u16,
    pub body: String,
}

fn method_from_str(value: &str) -> Result<reqwest::Method, String> {
    value.parse::<reqwest::Method>().map_err(|_| "unsupported HTTP method".into())
}

fn configured_gateway_origin() -> Result<url::Url, String> {
    let cfg = get_gateway_config();
    if cfg.url.is_empty() {
        return Err("Gateway URL is not configured".into());
    }
    normalize_gateway_url(&cfg.url)?.parse::<url::Url>().map_err(|e| format!("invalid configured gateway URL: {e}"))
}

#[tauri::command]
pub async fn gateway_request(args: GatewayRequestArgs) -> Result<GatewayResponse, String> {
    let origin = configured_gateway_origin()?;
    let path = args.path.trim();
    if !path.starts_with("/api/") || path.contains("..") || path.contains('\\') {
        return Err("gateway request path must be an API-relative path".into());
    }
    let target = origin.join(path.trim_start_matches('/')).map_err(|e| format!("invalid gateway request path: {e}"))?;
    if target.scheme() != origin.scheme() || target.host_str() != origin.host_str() || target.port_or_known_default() != origin.port_or_known_default() {
        return Err("gateway request must stay on the configured Gateway origin".into());
    }
    let method = method_from_str(&args.method)?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("build HTTP client: {e}"))?;
    let mut request = client.request(method, target);
    for (name, value) in args.headers {
        if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("cookie") {
            continue;
        }
        request = request.header(name, value);
    }
    if let Some(body) = args.body {
        if body.len() > 8 * 1024 * 1024 {
            return Err("gateway request body exceeds 8 MiB".into());
        }
        request = request.body(body);
    }
    let response = request.send().await.map_err(|e| format!("Gateway request failed: {e}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| format!("read Gateway response: {e}"))?;
    if body.len() > 8 * 1024 * 1024 {
        return Err("Gateway response exceeds 8 MiB".into());
    }
    Ok(GatewayResponse { status, body })
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GatewayConfig {
    pub url: String,
}

fn read_file_or_default(path: &Path) -> Result<String, String> {
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
    let url = normalize_gateway_url(&url)?;
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

#[derive(Serialize)]
pub struct RuntimePaths {
    pub manager_data: String,
    pub settings: String,
    pub agent_config: String,
    pub manager_log: String,
    pub agent_data: String,
}

#[tauri::command]
pub fn get_runtime_paths() -> RuntimePaths {
    RuntimePaths {
        manager_data: paths::manager_data_root().display().to_string(),
        settings: paths::settings_path().display().to_string(),
        agent_config: paths::agent_config_path().display().to_string(),
        manager_log: paths::manager_log_path().display().to_string(),
        agent_data: paths::agent_data_root().display().to_string(),
    }
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PrinterInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "displayName", alias = "display_name")]
    pub display_name: Option<String>,
    #[serde(rename = "printerType", alias = "printer_type")]
    pub printer_type: Option<String>,
    #[serde(rename = "connectionType", alias = "connection_type")]
    pub connection_type: Option<String>,
    pub protocol: Option<String>,
    pub endpoint: Option<String>,
    #[serde(rename = "spoolerName", alias = "spooler_name")]
    pub spooler_name: Option<String>,
    #[serde(rename = "networkAddress", alias = "network_address")]
    pub network_address: Option<String>,
    pub port: Option<i32>,
    pub status: String,
    pub enabled: bool,
    #[serde(rename = "isVirtual", alias = "is_virtual")]
    pub isVirtual: Option<bool>,
    #[serde(rename = "usbVid")]
    pub usb_vid: Option<String>,
    #[serde(rename = "usbPid")]
    pub usb_pid: Option<String>,
    #[serde(rename = "usbSerial")]
    pub usb_serial: Option<String>,
    pub capabilities: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct DiscoverResult {
    pub printers: Vec<PrinterInfo>,
    pub errors: Vec<String>,
}

/// Virtual / software / RDP-redirected queue detection — desktop safety net.
///
/// The authoritative filter is the Windows agent, which classifies every queue
/// during discovery (port monitor, driver, PnP ids, transport) and never
/// registers a non-physical printer. This only guards the UI against a record
/// that an older version already persisted.
/// Windows port monitors whose output never reaches hardware: they write a
/// file, discard the job or dial a modem. This is device metadata (like the
/// agent's `virtualPortMonitors`), not a printer name.
const VIRTUAL_PORT_MONITORS: &[&str] = &[
    "portprompt:", // Microsoft Print to PDF / print-to-file prompt
    "xpsport:",    // Microsoft XPS Document Writer
    "file:",       // print to file
    "nul:",
    "null:",
    "shrfax:", // Windows Shared Fax
    "fax:",
];

/// Driver / PnP families that only ever produce a file or hand the job to an
/// application. Mirrors the Windows agent's `softwareWriterTokens`.
const SOFTWARE_WRITER_TOKENS: &[&str] = &[
    // Microsoft in-box software writers
    "microsoft print to pdf",
    "microsoft xps document writer",
    "microsoft shared fax",
    "microsoft enhanced point and print compatibility driver",
    "send to onenote",
    "onenote",
    // Semantic families (language independent)
    "document writer",
    "documentwriter",
    "print to pdf",
    "topdf",
    "pdf writer",
    "pdfwriter",
    "pdf printer",
    "pdf creator",
    "pdf converter",
    "pdf architect",
    "virtual printer",
    "software printer",
    "image printer",
    // Widely deployed third-party software writers
    "foxit",
    "anydesk",
    "cutepdf",
    "pdf995",
    "novapdf",
    "bullzip",
    "pdfcreator",
    "pdfforge",
    "doro pdf",
    "biopdf",
    "nitro pdf",
    "adobe pdf",
    "bluebeam",
    "tinypdf",
    "7-pdf",
    "icecream pdf",
    "pdf24",
];

/// Queues tunnelled from another desktop session. Mirrors the agent's
/// `sessionRedirectTokens`.
const SESSION_REDIRECT_TOKENS: &[&str] = &[
    "remote desktop easy print",
    "terminal services easy print",
    "ts easy print",
    "easy print",
    "citrix",
    "vmware virtual print",
    "thinprint",
    "safeguard print",
];

fn is_virtual_printer_for_ui(p: &PrinterInfo) -> bool {
    if p.isVirtual.unwrap_or(false) {
        return true;
    }
    if let Some(t) = p.printer_type.as_ref() {
        if t.trim().to_lowercase() == "virtual" {
            return true;
        }
    }
    if let Some(c) = p.connection_type.as_ref() {
        if c.trim().to_lowercase() == "virtual" {
            return true;
        }
    }
    if let Some(proto) = p.protocol.as_ref() {
        if proto.trim().to_lowercase() == "virtual" {
            return true;
        }
    }

    let caps = p.capabilities.as_ref();
    if let Some(caps) = caps {
        for key in ["virtual", "is_virtual"].iter() {
            if caps.get(*key).and_then(|v| v.as_bool()) == Some(true) {
                return true;
            }
        }
        let class = caps
            .get("printer_class")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        if class == "virtual" || class == "redirected" {
            return true;
        }
        // Port monitor. "IP_192.168.1.50,SNMP" -> "ip_192.168.1.50".
        if let Some(port) = caps.get("port_name").and_then(|v| v.as_str()) {
            let lowered = port.to_lowercase();
            let head = lowered.split(',').next().unwrap_or("").trim();
            if VIRTUAL_PORT_MONITORS
                .iter()
                .any(|m| head == *m || head.starts_with(m))
            {
                return true;
            }
        }
    }

    let name_lower = p.name.to_lowercase();
    // Windows: "HP LaserJet (redirected 3)". Citrix: "… (from WKS12) in session 4".
    if name_lower.contains("(redirected") || name_lower.contains(" in session ") {
        return true;
    }

    // The driver, the comment and the PnP ids identify a software writer or a
    // session tunnel far more reliably than the display name does.
    let mut hay = String::new();
    if let Some(caps) = caps {
        for key in ["driver_name", "comment", "device_id"].iter() {
            if let Some(v) = caps.get(*key).and_then(|v| v.as_str()) {
                hay.push(' ');
                hay.push_str(&v.to_lowercase());
            }
        }
        for key in ["hardware_ids", "compatible_ids"].iter() {
            if let Some(list) = caps.get(*key).and_then(|v| v.as_array()) {
                for item in list {
                    if let Some(v) = item.as_str() {
                        hay.push(' ');
                        hay.push_str(&v.to_lowercase());
                    }
                }
            }
        }
    }
    hay.push(' ');
    hay.push_str(&name_lower);

    if SOFTWARE_WRITER_TOKENS.iter().any(|t| hay.contains(t)) {
        return true;
    }
    SESSION_REDIRECT_TOKENS.iter().any(|t| hay.contains(t))
}

fn is_valid_printer_for_ui(p: &PrinterInfo) -> bool {
    // Virtual, software and redirected queues are never production printers.
    if is_virtual_printer_for_ui(p) {
        return false;
    }
    let name_lower = p.name.to_lowercase();
    let driver_lower = p.capabilities.as_ref()
        .and_then(|v| v.get("driver_name").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_lowercase();
    let combined = format!("{} {}", name_lower, driver_lower);
    let generic = [
        "usb input device",
        "usb composite device",
        "hid-compliant",
        "hid compliant",
        "standard system devices",
        "standard usb host controller",
        "intel(r) wireless bluetooth",
        "wireless bluetooth",
        "bluetooth adapter",
        "fingerprint sensor",
        "touch fingerprint",
        "synaptics",
        "vfs7552",
        "hd camera",
        "hp hd camera",
        "camera",
        "usb hub",
        "generic usb hub",
    ];
    for g in generic {
        if combined.contains(g) {
            // Allow if driver explicitly says printer (check "printer" not "print" to avoid fingerprint)
            if driver_lower.contains("printer") || driver_lower.contains("laser") || driver_lower.contains("inkjet") || driver_lower.contains("thermal") || driver_lower.contains("label") || driver_lower.contains("zebra") {
                continue;
            }
            return false;
        }
    }
    true
}

#[tauri::command]
pub async fn get_printers(app: tauri::AppHandle) -> Result<Vec<PrinterInfo>, String> {
    run_blocking(move || {
        let path = paths::agent_data_root().join("printers.json");
        if !path.exists() {
            return Ok(vec![]);
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
        if raw.trim().is_empty() {
            return Ok(vec![]);
        }
        let v: Vec<PrinterInfo> = serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", path.display(), e))?;
        let filtered: Vec<PrinterInfo> = v.into_iter().filter(|p| is_valid_printer_for_ui(p)).collect();
        Ok(filtered)
    })
    .await
}

#[tauri::command]
pub async fn discover_printers(app: tauri::AppHandle) -> Result<DiscoverResult, String> {
    run_blocking(move || {
        let cli = agent::cli_path(&app)?;
        let config = paths::agent_config_path();
        let root = paths::agent_data_root();
        let _ = paths::ensure_agent_data_root().map_err(|e| format!("create agent data dir: {}", e))?;
        let mut discover_cmd = std::process::Command::new(&cli);
        discover_cmd
            .arg("printers")
            .arg("discover")
            .arg("--json")
            .arg("-config")
            .arg(&config)
            .env("ODOO_PRINT_AGENT_DATA_DIR", &root);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            discover_cmd.creation_flags(0x0800_0000);
        }
        let out = discover_cmd
            .output()
            .map_err(|e| format!("failed to run discover: {}", e))?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        if !out.status.success() {
            let msg = if stderr.trim().is_empty() { stdout.clone() } else { stderr.clone() };
            return Err(format!("discover failed: {}", msg));
        }
        // CLI prints table; also try to read printers.json for structured result
        let mut errors = if stderr.is_empty() { vec![] } else { vec![stderr] };
        let printers = {
            let p = root.join("printers.json");
            if p.exists() {
                let raw = std::fs::read_to_string(&p).unwrap_or_default();
                match serde_json::from_str::<Vec<PrinterInfo>>(&raw) {
                    Ok(v) => v.into_iter().filter(|x| is_valid_printer_for_ui(x)).collect::<Vec<_>>(),
                    Err(e) => {
                        // A corrupt registry file must not silently look like
                        // "no printers discovered"; surface it to the UI.
                        errors.push(format!("parse {}: {}", p.display(), e));
                        vec![]
                    }
                }
            } else {
                vec![]
            }
        };
        Ok(DiscoverResult { printers, errors })
    })
    .await
}

#[tauri::command]
pub async fn test_printer(printer_id: String, app: tauri::AppHandle) -> Result<String, String> {
    // Same trust boundary as register_printer's arg_value: the id is passed
    // positionally to the Go CLI, whose parser treats a leading-dash value
    // as a flag (e.g. "-config" would be swallowed as a flag name). Printer
    // ids never legitimately start with '-'.
    let pid = printer_id.trim().to_string();
    if pid.is_empty() {
        return Err("printer id is required".into());
    }
    if pid.starts_with('-') {
        return Err("printer id must not start with '-'".into());
    }
    run_blocking(move || {
        let cli = agent::cli_path(&app)?;
        let config = paths::agent_config_path();
        let root = paths::agent_data_root();
        let mut test_cmd = std::process::Command::new(&cli);
        test_cmd
            .arg("printers")
            .arg("test")
            .arg(&pid)
            .arg("-config")
            .arg(&config)
            .env("ODOO_PRINT_AGENT_DATA_DIR", &root);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            test_cmd.creation_flags(0x0800_0000);
        }
        let out = test_cmd
            .output()
            .map_err(|e| format!("failed to run test: {}", e))?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !out.status.success() {
            let msg = if stderr.is_empty() { stdout } else { stderr };
            return Err(msg);
        }
        Ok(stdout)
    })
    .await
}

#[derive(Deserialize, Debug)]
pub struct RegisterPrinterRequest {
    pub name: String,
    #[serde(rename = "connectionType")]
    pub connection_type: String,
    #[serde(rename = "connection_type")]
    pub connection_type_alt: Option<String>,
    pub endpoint: Option<String>,
    #[serde(rename = "spoolerName")]
    pub spooler_name: Option<String>,
    pub protocol: Option<String>,
    #[serde(rename = "printerType")]
    pub printer_type: Option<String>,
    #[serde(rename = "usbVid")]
    pub usb_vid: Option<String>,
    #[serde(rename = "usbPid")]
    pub usb_pid: Option<String>,
    #[serde(rename = "usbSerial")]
    pub usb_serial: Option<String>,
}

#[tauri::command]
pub async fn register_printer(request: RegisterPrinterRequest, app: tauri::AppHandle) -> Result<String, String> {
    // A value starting with `-` would be parsed by the Go CLI as a FLAG, not
    // a value (no shell is involved, so this is argument smuggling, not
    // injection): reject leading-dash values at the trust boundary.
    fn arg_value(name: &str, raw: &str) -> Result<String, String> {
        let v = raw.trim().to_string();
        if v.is_empty() {
            return Err(format!("{name} must not be empty"));
        }
        if v.starts_with('-') {
            return Err(format!("{name} must not start with '-'"));
        }
        Ok(v)
    }
    let name = arg_value("printer name", &request.name)?;
    let conn = request.connection_type_alt.clone().unwrap_or(request.connection_type.clone());
    let conn_lower = conn.trim().to_lowercase();
    let valid_conns = ["spooler", "network", "tcp", "usb", "ipp", "ipps"];
    if !valid_conns.contains(&conn_lower.as_str()) {
        // List the ACTUALLY accepted types — the old message dropped the
        // valid tcp/ipps options (audit #21).
        return Err("connection type must be spooler, network, tcp, usb, ipp, or ipps".into());
    }
    run_blocking(move || {
        let cli = agent::cli_path(&app)?;
        let config = paths::agent_config_path();
        let root = paths::agent_data_root();
        let mut cmd = std::process::Command::new(&cli);
        cmd.arg("printers").arg("add").arg("--name").arg(&name).arg("--type").arg(&conn_lower);
        if let Some(ep) = request.endpoint.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--endpoint").arg(arg_value("endpoint", ep)?);
        }
        if let Some(sn) = request.spooler_name.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--spooler-name").arg(arg_value("spooler name", sn)?);
        }
        if let Some(proto) = request.protocol.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--protocol").arg(arg_value("protocol", proto)?.to_lowercase());
        }
        if let Some(pt) = request.printer_type.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--printer-type").arg(arg_value("printer type", pt)?.to_lowercase());
        }
        if let Some(vid) = request.usb_vid.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--vid").arg(arg_value("USB VID", vid)?);
        }
        if let Some(pid) = request.usb_pid.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--pid").arg(arg_value("USB PID", pid)?);
        }
        if let Some(serial) = request.usb_serial.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg("--serial").arg(arg_value("USB serial", serial)?);
        }
        cmd.arg("-config").arg(&config);
        cmd.env("ODOO_PRINT_AGENT_DATA_DIR", &root);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().map_err(|e| format!("failed to run register: {}", e))?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !out.status.success() {
            let msg = if stderr.is_empty() { stdout } else { stderr };
            return Err(msg);
        }
        if stdout.is_empty() {
            Ok(format!("Printer '{}' added", name))
        } else {
            Ok(stdout)
        }
    })
    .await
}

#[derive(Serialize, Clone)]
pub struct AutostartStatus {
    pub enabled: bool,
}

#[tauri::command]
pub async fn get_autostart(app: tauri::AppHandle) -> Result<AutostartStatus, String> {
    run_blocking(move || {
        #[cfg(windows)]
        {
            use tauri_plugin_autostart::ManagerExt;
            let enabled = app.autolaunch().is_enabled().unwrap_or(false);
            Ok(AutostartStatus { enabled })
        }
        #[cfg(not(windows))]
        {
            let _ = &app;
            Ok(AutostartStatus { enabled: false })
        }
    })
    .await
}

/// Record that the user has explicitly chosen an autostart state, so the
/// first-launch default (main.rs) never overrides it again. MUST fail loudly
/// when the record cannot be persisted: a silently swallowed write failure
/// would make the next launch treat the user as "never chose" and re-apply
/// the default-enable - silently reversing an explicit DISABLE.
fn record_autostart_choice(marker: &Path) -> Result<(), String> {
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create marker dir {}: {e}", parent.display()))?;
    }
    std::fs::write(marker, "1").map_err(|e| format!("write marker {}: {e}", marker.display()))
}

/// Apply an explicit user autostart choice so the OS registry state and the
/// durable choice marker can never silently diverge: without the marker, the
/// next launch treats this machine as "never chose" and re-applies the
/// first-launch default-enable — silently reversing an explicit DISABLE.
///
/// Order: OS change first, marker second; if persisting the marker fails,
/// the OS change is rolled back to the pre-attempt state before the error
/// surfaces. No silent divergence, no false success, and no claim of true
/// atomicity: a rollback that itself fails is reported with both errors so
/// the operator knows the machine needs manual reconciliation.
fn apply_autostart_choice(
    enabled: bool,
    mut set_os: impl FnMut(bool) -> Result<(), String>,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<String, String> {
    set_os(enabled)?;
    let state = if enabled {
        "autostart enabled"
    } else {
        "autostart disabled"
    };
    if let Err(persist_err) = persist() {
        return Err(match set_os(!enabled) {
            Ok(()) => format!(
                "{state} applied, but the user-choice record could not be persisted ({persist_err}); \
                 the OS change was reverted so a later start cannot silently override it - retry from Settings"
            ),
            Err(rollback_err) => format!(
                "{state} applied, but the user-choice record could not be persisted ({persist_err}) \
                 and reverting the OS change also failed ({rollback_err}); restart the app and retry from Settings"
            ),
        });
    }
    Ok(state.to_string())
}

#[tauri::command]
pub async fn set_autostart(enabled: bool, app: tauri::AppHandle) -> Result<String, String> {
    run_blocking(move || {
        #[cfg(windows)]
        {
            use tauri_plugin_autostart::ManagerExt;
            // Record that the user has explicitly chosen autostart so the
            // app never re-enables it on a later start (see setup in main.rs).
            let touched = paths::manager_data_root().join("autostart-user-choice");
            apply_autostart_choice(
                enabled,
                |on| {
                    if on {
                        app.autolaunch().enable().map_err(|e| format!("enable autostart: {}", e))
                    } else {
                        app.autolaunch().disable().map_err(|e| format!("disable autostart: {}", e))
                    }
                },
                || record_autostart_choice(&touched),
            )
        }
        #[cfg(not(windows))]
        {
            let _ = (&app, enabled);
            Err("autostart only available on Windows".into())
        }
    })
    .await
}

#[cfg(test)]
mod autostart_choice_tests {
    use super::{apply_autostart_choice, record_autostart_choice};

    #[test]
    fn apply_enable_success_persists_and_reports_enabled() {
        let mut os_calls: Vec<bool> = Vec::new();
        let res = apply_autostart_choice(
            true,
            |on| {
                os_calls.push(on);
                Ok(())
            },
            || Ok(()),
        );
        assert_eq!(res, Ok("autostart enabled".to_string()));
        assert_eq!(os_calls, vec![true]);
    }

    #[test]
    fn apply_disable_success_persists_and_reports_disabled() {
        let mut os_calls: Vec<bool> = Vec::new();
        let res = apply_autostart_choice(
            false,
            |on| {
                os_calls.push(on);
                Ok(())
            },
            || Ok(()),
        );
        assert_eq!(res, Ok("autostart disabled".to_string()));
        assert_eq!(os_calls, vec![false]);
    }

    #[test]
    fn os_failure_aborts_before_any_persistence() {
        let mut persist_called = false;
        let res = apply_autostart_choice(
            true,
            |_| Err("registry denied".to_string()),
            || {
                persist_called = true;
                Ok(())
            },
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("registry denied"));
        assert!(!persist_called, "a failed OS change must not attempt marker persistence");
    }

    #[test]
    fn marker_failure_rolls_back_the_os_change_and_errors() {
        // THE invariant: an explicit DISABLE whose marker cannot be recorded
        // must revert the OS change, otherwise the next launch (no marker)
        // would silently re-apply the first-launch default-enable.
        let mut os_calls: Vec<bool> = Vec::new();
        let res = apply_autostart_choice(
            false,
            |on| {
                os_calls.push(on);
                Ok(())
            },
            || Err("disk full writing marker".to_string()),
        );
        let err = res.expect_err("divergence must surface, never succeed silently");
        assert!(err.contains("disk full writing marker"), "original persistence error must survive: {err}");
        assert!(err.contains("reverted"), "message must state the rollback: {err}");
        assert_eq!(os_calls, vec![false, true], "OS change must be rolled back exactly once");
    }

    #[test]
    fn rollback_failure_reports_both_errors() {
        // Best-effort rollback that itself fails: both failures must be
        // visible so the divergence can be reconciled manually.
        let mut calls = 0;
        let res = apply_autostart_choice(
            true,
            |_| {
                calls += 1;
                if calls == 1 {
                    Ok(())
                } else {
                    Err("rollback denied".to_string())
                }
            },
            || Err("disk full writing marker".to_string()),
        );
        let err = res.expect_err("must still report failure");
        assert!(err.contains("disk full writing marker"), "persist error: {err}");
        assert!(err.contains("rollback denied"), "rollback error: {err}");
    }


    #[test]
    fn successful_choice_record_persists_the_marker() {
        let dir = std::env::temp_dir().join(format!("odoo-choice-ok-{}", std::process::id()));
        let marker = dir.join("nested").join("autostart-user-choice");
        let _ = std::fs::remove_dir_all(&dir);
        record_autostart_choice(&marker).expect("marker must persist");
        assert!(marker.exists(), "explicit user choice must be durably recorded");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persistence_failure_is_propagated_not_swallowed() {
        // THE regression: the command previously did `let _ = fs::write(...)`
        // - a failed choice record silently left the next launch to re-apply
        // the default-enable, reversing an explicit user DISABLE. Here the
        // marker path is a DIRECTORY, so any write to it must fail loudly.
        let dir = std::env::temp_dir().join(format!("odoo-choice-fail-{}", std::process::id()));
        let marker = dir.join("autostart-user-choice");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&marker).unwrap();
        let err = record_autostart_choice(&marker).expect_err("write onto a directory must surface an error");
        assert!(err.contains("write marker"), "error must identify the failed persistence: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
