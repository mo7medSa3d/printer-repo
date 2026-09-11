// @vitest-environment jsdom
/**
 * Modal/Drawer backdrop isolation (no testing library on purpose):
 * while a dialog is open the background must be inert (neither keyboard
 * nor screen-reader reachable), Tab must cycle inside the panel, Escape
 * must close, and closing must restore the background exactly.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Modal, Drawer } from "../src/components/ui";

// Silence React 19's act-environment warning in this dependency-free test.
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

function renderModal(props: {
  open: boolean;
  onClose?: () => void;
  description?: string;
}) {
  const bgWrap = document.createElement("div");
  bgWrap.innerHTML = '<button id="bg-btn">background action</button>';
  document.body.appendChild(bgWrap);
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  const onClose = props.onClose ?? (() => {});
  act(() => {
    root.render(
      h(Modal, {
        open: props.open,
        onClose,
        title: "Test dialog",
        description: props.description,
        footer: h("button", { id: "foot-btn" }, "Confirm"),
        children: h("button", { id: "body-btn" }, "Body action"),
      })
    );
  });
  return { bgWrap, host, onClose };
}

describe("dialog backdrop isolation", () => {
  it("inerts the background while open and restores it on close", () => {
    const onClose = vi.fn();
    const { bgWrap } = renderModal({ open: true, onClose });
    expect(bgWrap.inert).toBe(true);
    // Panel takes focus on open.
    const panel = document.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    expect(panel!.contains(document.activeElement)).toBe(true);
    // Background action is neither reachable nor announced.
    expect(bgWrap.querySelector("#bg-btn")).not.toBeNull();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderModal({ open: true, onClose });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab inside the panel", () => {
    renderModal({ open: true });
    const foot = document.getElementById("foot-btn") as HTMLElement;
    const closeBtn = document.querySelector(
      '[role="dialog"] button'
    ) as HTMLElement;
    expect(foot).not.toBeNull();
    // Focus the last tabbable element, Tab must wrap to the first.
    act(() => {
      foot.focus();
    });
    expect(document.activeElement).toBe(foot);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      );
    });
    expect(document.activeElement).toBe(closeBtn);
  });

  it("exposes description via aria-describedby", () => {
    renderModal({ open: true, description: "Helper text" });
    const panel = document.querySelector('[role="dialog"]');
    const describedBy = panel!.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    const desc = document.getElementById(describedBy!);
    expect(desc?.textContent).toBe("Helper text");
  });

  it("restores background access after unmount", () => {
    const { bgWrap, host } = renderModal({ open: true });
    expect(bgWrap.inert).toBe(true);
    const root = roots[roots.length - 1];
    act(() => {
      root.unmount();
    });
    roots.pop();
    host.remove();
    expect(bgWrap.inert).toBe(false);
  });

  it("inerts the background for drawers too", () => {
    const bgWrap = document.createElement("div");
    bgWrap.innerHTML = "<button>bg</button>";
    document.body.appendChild(bgWrap);
    const host = document.createElement("div");
    document.body.appendChild(host);
    hosts.push(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => {
      root.render(
        h(Drawer, {
          open: true,
          onClose: () => {},
          title: "Test drawer",
          children: h("button", { id: "drawer-btn" }, "Do it"),
        })
      );
    });
    expect(bgWrap.inert).toBe(true);
    expect(
      document.querySelector('[role="dialog"]')!.contains(document.activeElement)
    ).toBe(true);
  });
});
