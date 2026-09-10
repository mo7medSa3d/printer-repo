// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../src/lib/clipboard";

describe("copyTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // jsdom has no execCommand; remove the stub each test defines below.
    delete (document as { execCommand?: unknown }).execCommand;
  });

  const stubExecCommand = (result: boolean) => {
    Object.defineProperty(document, "execCommand", {
      value: vi.fn().mockReturnValue(result),
      configurable: true,
      writable: true,
    });
  };

  it("uses the async clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyTextToClipboard("odoo_secret")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("odoo_secret");
  });

  it("falls back to execCommand when the async API rejects", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    stubExecCommand(true);
    await expect(copyTextToClipboard("code123")).resolves.toBe(true);
  });

  it("falls back to execCommand when navigator.clipboard is missing (plain HTTP)", async () => {
    // Secure-context-only API: undefined over http://LAN — the reported bug.
    vi.stubGlobal("navigator", {});
    stubExecCommand(true);
    await expect(copyTextToClipboard("code123")).resolves.toBe(true);
  });

  it("returns false instead of throwing when every path fails", async () => {
    vi.stubGlobal("navigator", {});
    stubExecCommand(false);
    await expect(copyTextToClipboard("code123")).resolves.toBe(false);
  });
});
