// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AdminPrivilegeDialog } from "../src/desktop/components/AdminPrivilegeDialog";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let hosts: HTMLElement[] = [];
let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) {
    act(() => {
      root.unmount();
    });
  }
  roots = [];
  for (const host of hosts) host.remove();
  hosts = [];
  document.body.innerHTML = "";
});

function renderDialog(props: {
  open: boolean;
  onClose?: () => void;
  onRelaunch?: () => void;
}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  const onClose = props.onClose ?? (() => {});
  act(() => {
    root.render(
      h(AdminPrivilegeDialog, {
        open: props.open,
        onClose,
        onRelaunch: props.onRelaunch,
      })
    );
  });
  return { host, onClose };
}

describe("AdminPrivilegeDialog", () => {
  it("renders when open with required title, copy, and action buttons", () => {
    renderDialog({ open: true });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Administrator privileges required");
    expect(text).toContain(
      "Desktop Agent Manager must be running as Administrator to manage the Agent service. Close this window and reopen Desktop Agent Manager as Administrator."
    );
    expect(text).toContain("Close & Reopen as Administrator");
    expect(text).toContain("Continue in Read-Only Mode");
    expect(text).toContain("Run as administrator");

    // Modal is rendered in a fixed z-50 overlay container above the whole UI
    const modalRoot = document.querySelector("[data-dialog-root]");
    expect(modalRoot).not.toBeNull();
    expect(modalRoot?.className).toContain("z-50");
  });

  it("does not render when open is false", () => {
    renderDialog({ open: false });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeNull();
  });

  it("triggers onClose when 'Continue in Read-Only Mode' is clicked", () => {
    const onClose = vi.fn();
    renderDialog({ open: true, onClose });

    const buttons = Array.from(document.querySelectorAll("button"));
    const secondaryBtn = buttons.find((b) =>
      b.textContent?.includes("Continue in Read-Only Mode")
    );
    expect(secondaryBtn).toBeDefined();

    act(() => {
      secondaryBtn?.click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("triggers onRelaunch when 'Close & Reopen as Administrator' is clicked", async () => {
    const onRelaunch = vi.fn();
    renderDialog({ open: true, onRelaunch });

    const buttons = Array.from(document.querySelectorAll("button"));
    const primaryBtn = buttons.find((b) =>
      b.textContent?.includes("Close & Reopen as Administrator")
    );
    expect(primaryBtn).toBeDefined();

    await act(async () => {
      primaryBtn?.click();
    });

    expect(onRelaunch).toHaveBeenCalledTimes(1);
  });
});
