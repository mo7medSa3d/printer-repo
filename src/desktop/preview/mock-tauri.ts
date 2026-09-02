/**
 * BROWSER PREVIEW HARNESS — development only.
 *
 * `npm run desktop:dev` serves the desktop UI in a plain browser, where there
 * is no Rust backend to `invoke`. This shim installs a fake
 * `window.__TAURI_INTERNALS__` with demonstration data so the UI can be
 * reviewed (layout, light theme, empty/loaded states) without packaging the
 * Windows app.
 *
 * It is reachable only through `preview.html`. `vite.desktop.config.ts` pins
 * the production build input to `index.html`, so nothing here ships in the
 * installer.
 */

const demoPrinters = [
  {
    id: "printer_hp_m404",
    name: "HP LaserJet Pro M404",
    displayName: "HP LaserJet Pro M404",
    printerType: "physical",
    deviceClass: "laser",
    connectionType: "spooler",
    protocol: "spooler",
    endpoint: "HP LaserJet Pro M404",
    spoolerName: "HP LaserJet Pro M404",
    status: "online",
    enabled: true,
    capabilities: { port_name: "USB001", driver_name: "HP LaserJet Pro M404 PCL 6" },
  },
  {
    id: "printer_zebra_zd421",
    name: "Zebra ZD421",
    displayName: "Zebra ZD421",
    printerType: "physical",
    deviceClass: "label",
    connectionType: "network",
    protocol: "raw",
    endpoint: "192.168.1.62:9100",
    networkAddress: "192.168.1.62",
    port: 9100,
    status: "online",
    enabled: true,
  },
  {
    id: "printer_epson_tm_t82",
    name: "Epson TM-T82II",
    displayName: "Epson TM-T82II",
    printerType: "physical",
    deviceClass: "thermal",
    connectionType: "usb",
    protocol: "escpos",
    endpoint: "usb://04b8:0202",
    status: "busy",
    enabled: true,
    usbVid: "04b8",
    usbPid: "0202",
  },
  {
    id: "printer_brother_hl",
    name: "Brother HL-L2360D",
    displayName: "Brother HL-L2360D",
    printerType: "physical",
    deviceClass: "laser",
    connectionType: "ipp",
    protocol: "ipp",
    endpoint: "ipp://192.168.1.80/ipp/print",
    status: "offline",
    enabled: true,
  },
  // Deliberately present: proves the UI safety net hides virtual queues even
  // if an older registry file still contains one.
  {
    id: "printer_ms_pdf",
    name: "Microsoft Print to PDF",
    printerType: "virtual",
    connectionType: "spooler",
    protocol: "spooler",
    spoolerName: "Microsoft Print to PDF",
    status: "online",
    enabled: true,
    isVirtual: true,
    capabilities: { virtual: true, port_name: "PORTPROMPT:", driver_name: "Microsoft Print To PDF" },
  },
];

const demoJobs = [
  {
    id: "job_8fa21c0d",
    documentType: "receipt",
    printerId: "printer_epson_tm_t82",
    branchId: "branch_main",
    status: "printing",
    retries: 0,
    createdAt: new Date(Date.now() - 40_000).toISOString(),
    updatedAt: new Date(Date.now() - 8_000).toISOString(),
  },
  {
    id: "job_2b77aa91",
    documentType: "kitchen ticket",
    printerId: "printer_zebra_zd421",
    branchId: "branch_main",
    status: "queued",
    retries: 0,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
  },
  {
    id: "job_c31d4e77",
    documentType: "invoice A4",
    printerId: "printer_hp_m404",
    branchId: "branch_main",
    status: "success",
    retries: 0,
    createdAt: new Date(Date.now() - 900_000).toISOString(),
    updatedAt: new Date(Date.now() - 860_000).toISOString(),
  },
  {
    id: "job_9de10b12",
    documentType: "label 4x6",
    printerId: "printer_zebra_zd421",
    branchId: "branch_main",
    status: "failed",
    retries: 3,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_500_000).toISOString(),
    error: "write tcp 192.168.1.62:9100: i/o timeout",
  },
];

function transformCallback(callback?: (...args: unknown[]) => void, once = false): number {
  const id = Math.floor(Math.random() * 2 ** 31);
  const w = window as unknown as Record<string, unknown>;
  (w as Record<string, unknown>)[`_preview_cb_${id}`] = (...args: unknown[]) => {
    if (once) delete (w as Record<string, unknown>)[`_preview_cb_${id}`];
    (callback as (...a: unknown[]) => void)?.(...args);
  };
  return id;
}

async function mockInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 120));
  switch (cmd) {
    case "plugin:event|listen":
      return 1 as unknown as T;
    case "plugin:event|unlisten":
      return undefined as unknown as T;
    case "get_agent_status":
      return {
        running: true,
        service: "OdooPrintAgent",
        version: "1.0.0",
        hostname: "DESKTOP-RECEPTION",
        note: "OdooPrintAgent.exe is running",
      } as unknown as T;
    case "get_app_version":
      return "1.0.0" as unknown as T;
    case "get_gateway_config":
      // Switch to "" to preview the "Gateway needs configuration" banner.
      return { url: "https://print.example.com" } as unknown as T;
    case "set_gateway_config":
      return "Gateway URL saved" as unknown as T;
    case "get_runtime_paths":
      return {
        manager_data: "C:\\ProgramData\\Odoo Print Manager",
        settings: "C:\\ProgramData\\Odoo Print Manager\\settings.json",
        agent_config: "C:\\ProgramData\\Odoo Print Agent\\config.yaml",
        manager_log: "C:\\ProgramData\\Odoo Print Manager\\manager.log",
        agent_data: "C:\\ProgramData\\Odoo Print Agent",
      } as unknown as T;
    case "get_printers":
      return demoPrinters as unknown as T;
    case "discover_printers":
      return {
        printers: demoPrinters,
        errors: [],
      } as unknown as T;
    case "test_printer":
      return "Test page sent to the printer" as unknown as T;
    case "register_printer":
      return "Printer registered" as unknown as T;
    case "get_autostart":
      return { enabled: true } as unknown as T;
    case "set_autostart":
      return "Autostart updated" as unknown as T;
    case "start_agent":
      return "Agent started" as unknown as T;
    case "stop_agent":
      return "Agent stopped" as unknown as T;
    case "restart_agent":
      return "Agent restarted" as unknown as T;
    case "pair_agent":
      return `Agent paired with ${String((args as Record<string, unknown>)?.args && ((args as Record<string, unknown>).args as Record<string, unknown>)?.gateway_url ? String(((args as Record<string, unknown>).args as Record<string, unknown>).gateway_url) : "gateway")}` as unknown as T;
    default:
      throw new Error(`preview: unhandled command ${cmd}`);
  }
}

export function installPreviewBackend(): void {
  const w = window as unknown as Record<string, unknown>;
  (w as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
    transformCallback,
    unregisterCallback: () => {},
    convertFileSrc: (p: string) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
  (w as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    registerListener: () => {},
    unregisterListener: () => {},
  };

  // Fake the two gateway HTTP calls the manager makes.
  const realFetch = (w as unknown as Window).fetch.bind(window);
  (w as unknown as Window).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/api/health")) {
      return json({ ok: true });
    }
    if (url.includes("/api/jobs")) {
      return json(demoJobs);
    }
    return realFetch(input as RequestInfo, init);
  };
}

installPreviewBackend();
