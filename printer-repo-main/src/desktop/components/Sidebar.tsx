import React from "react";
import appIconRaw from "../../../src-tauri/icons/icon.png";
const appIcon = appIconRaw as unknown as string;
import {
  LayoutDashboard,
  Printer,
  ClipboardList,
  Cpu,
  Settings,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { StatusDot } from "@/components/ui";
import type { Page } from "../types";

export interface NavItem {
  id: Page;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  desc: string;
}

function StatusLine({
  tone,
  title,
  detail,
  pulse,
}: {
  tone: "ok" | "bad" | "neutral";
  title: string;
  detail: string;
  pulse?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <StatusDot tone={tone} pulse={pulse} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-tight text-ink">
          {title}
        </div>
        <div className="truncate text-[12px] leading-tight text-ink-3">{detail}</div>
      </div>
    </div>
  );
}

export function Sidebar({
  page,
  navigate,
  items,
  collapsed,
  setCollapsed,
  sidebarOpen,
  setSidebarOpen,
  gatewayConnected,
  gatewayUrl,
  isOnline,
  version,
  lastHeartbeat,
}: {
  page: Page;
  navigate: (p: Page) => void;
  items: NavItem[];
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  gatewayConnected: boolean;
  gatewayUrl: string;
  isOnline: boolean;
  version: string;
  lastHeartbeat: string | null;
}) {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-edge bg-surface transition-all duration-200 ease-out ${
        collapsed ? "w-[72px] lg:w-[72px]" : "w-[248px]"
      } ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}
    >
      {/* Brand */}
      <div
        className={`flex h-[76px] shrink-0 items-center gap-3 border-b border-edge ${
          collapsed ? "justify-center px-0" : "px-5"
        }`}
      >
        <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand shadow-xs">
          {/* Tauri desktop app: next/image is not available; asset is bundled locally */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={appIcon} alt="" className="h-8 w-8 object-contain" />
        </span>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-bold leading-tight tracking-[-0.01em] text-ink">
              Print Gateway
            </div>
            <div className="truncate text-[12px] font-medium leading-tight text-ink-3">
              Odoo Print Manager
            </div>
          </div>
        )}
        <button
          onClick={() => {
            setCollapsed(false);
            setSidebarOpen(false);
          }}
          className="ml-auto rounded-lg p-2 text-ink-3 transition-colors hover:bg-surface-2 lg:hidden"
          aria-label="Close navigation"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Navigation */}
      <nav
        className="flex-1 space-y-1.5 overflow-y-auto px-3 py-5"
        aria-label="Primary"
      >
        {!collapsed && (
          <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">
            Navigation
          </div>
        )}
        {items.map((item) => {
          const active = page === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => {
                navigate(item.id);
                setSidebarOpen(false);
              }}
              aria-current={active ? "page" : undefined}
              aria-label={collapsed ? item.label : undefined}
              title={collapsed ? item.label : undefined}
              className={`relative flex w-full items-center gap-3 rounded-lg text-[15px] transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)] ${
                collapsed ? "justify-center px-2 py-3" : "px-3 py-2.5"
              } ${
                active
                  ? "bg-brand-subtle font-semibold text-brand before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-brand"
                  : "font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <Icon className="h-5 w-5 flex-shrink-0" aria-hidden />
              {!collapsed && <span className="flex-1 text-left">{item.label}</span>}
              {!collapsed && (
                <span
                  className={`text-[12px] tabular-nums ${
                    active ? "text-brand/70" : "text-ink-4"
                  }`}
                >
                  {item.desc}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Status panel */}
      <div className="shrink-0 border-t border-edge p-3">
        {collapsed ? (
          <div className="flex flex-col items-center gap-3 py-2">
            <span title={gatewayConnected ? "Gateway connected" : "Gateway offline"}>
              <StatusDot tone={gatewayConnected ? "ok" : "bad"} pulse={gatewayConnected} />
            </span>
            <span title={isOnline ? "Agent running" : "Agent stopped"}>
              <StatusDot tone={isOnline ? "ok" : "bad"} pulse={isOnline} />
            </span>
          </div>
        ) : (
          <div className="inset-panel space-y-3 p-4">
            <StatusLine
              tone={gatewayConnected ? "ok" : "bad"}
              title={gatewayConnected ? "Gateway connected" : gatewayUrl ? "Gateway offline" : "Gateway not set"}
              detail={gatewayUrl || "Set in Settings"}
              pulse={gatewayConnected}
            />
            <div className="h-px bg-edge" />
            <StatusLine
              tone={isOnline ? "ok" : "bad"}
              title={isOnline ? "Agent running" : "Agent stopped"}
              detail={`v${version || "1.0.0"} · checked ${lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString() : "—"}`}
              pulse={isOnline}
            />
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="mt-2 hidden w-full items-center justify-center rounded-lg px-2 py-2 text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)] lg:inline-flex"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-5 w-5" />
          ) : (
            <PanelLeftClose className="h-5 w-5" />
          )}
        </button>
      </div>
    </aside>
  );
}
