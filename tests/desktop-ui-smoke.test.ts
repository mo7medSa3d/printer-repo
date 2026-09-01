// @vitest-environment jsdom
/**
 * Desktop Manager UI smoke test (no Tauri, no Gateway).
 *
 * The desktop shell is a single-page React app whose routes are hash-driven.
 * This test boots it against a stubbed IPC backend and walks every page, so a
 * crash in any screen — or a route that renders nothing — fails the build
 * instead of reaching a Windows installer.
 *
 * It also locks in the virtual-printer UI safety net: even if the IPC layer
 * hands the UI a virtual queue, it must never be rendered as a printer.
 */
import { describe, it, expect, beforeAll } from "vitest";

const printers = [
  {
    id: "p1",
    name: "HP LaserJet Pro M404",
    printerType: "laser",
    connectionType: "spooler",
    protocol: "spooler",
    status: "online",
    enabled: true,
    spoolerName: "HP LaserJet Pro M404",
    endpoint: "HP LaserJet Pro M404",
  },
  {
    id: "p2",
    name: "Zebra ZD421",
    printerType: "label",
    connectionType: "network",
    protocol: "raw",
    status: "online",
    enabled: true,
    endpoint: "192.168.1.62:9100",
    networkAddress: "192.168.1.62",
    port: 9100,
  },
  {
    id: "p3",
    name: "Microsoft Print to PDF",
    printerType: "virtual",
    connectionType: "spooler",
    protocol: "spooler",
    status: "online",
    enabled: true,
    isVirtual: true,
    spoolerName: "Microsoft Print to PDF",
  },
];

const jobs = [
  {
    id: "job_1",
    documentType: "receipt",
    printerId: "p2",
    branchId: "b1",
    status: "printing",
    retries: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "job_2",
    documentType: "invoice",
    printerId: "p1",
    branchId: "b1",
    status: "failed",
    retries: 2,
    error: "i/o timeout",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

async function invoke<T>(cmd: string): Promise<T> {
  switch (cmd) {
    case "plugin:event|listen":
      return 1 as unknown as T;
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
      return { url: "https://gw.example.com" } as unknown as T;
    case "get_runtime_paths":
      return {
        manager_data: "a",
        settings: "b",
        agent_config: "c",
        manager_log: "d",
        agent_data: "e",
      } as unknown as T;
    case "get_printers":
      return printers as unknown as T;
    case "discover_printers":
      return { printers, errors: [] } as unknown as T;
    case "get_autostart":
      return { enabled: true } as unknown as T;
    default:
      throw new Error(`stub: unhandled command ${cmd}`);
  }
}

describe("desktop manager", () => {
  beforeAll(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: () => 1,
      unregisterCallback: () => {},
      convertFileSrc: (p: string) => p,
      metadata: {},
    };
    (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      registerListener: () => {},
      unregisterListener: () => {},
    };
    (globalThis as unknown as Record<string, unknown>).fetch = async (url: string) => {
      const body = url.includes("/api/health")
        ? {
            ok: true,
            agents: { total: 4, online: 3 },
            printers: { total: 7, online: 6 },
            jobs: { queued: 2, failed: 1 },
          }
        : jobs;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  });

  it("boots every page without console errors and hides virtual printers", async () => {
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => {
      errors.push(a);
      origError(...a);
    };

    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);

    await import("@/desktop/main");
    await new Promise((r) => setTimeout(r, 300));

    const text = () => document.body.textContent ?? "";

    expect(text()).toContain("Print Gateway");
    expect(text()).toContain("Odoo Print Manager");
    for (const label of ["Overview", "Printers", "Print Jobs", "Agents", "Settings"]) {
      expect(text()).toContain(label);
    }
    expect(text()).toContain("HP LaserJet Pro M404");
    expect(text()).toContain("Zebra ZD421");
    // The virtual queue survives the IPC stub but must never reach the screen.
    expect(text()).not.toContain("Microsoft Print to PDF");

    for (const page of ["printers", "jobs", "agents", "settings"] as const) {
      window.location.hash = page;
      window.dispatchEvent(new Event("hashchange"));
      await new Promise((r) => setTimeout(r, 80));
      expect(text().length).toBeGreaterThan(50);
    }

    expect(text()).toContain("Gateway connection");
    expect(text()).toContain("Pair agent");

    console.error = origError;
    expect(errors.filter((e) => !String(e).includes("not wrapped in act"))).toEqual([]);
  });
});
