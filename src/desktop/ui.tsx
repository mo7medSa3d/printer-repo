import React from "react";
import { ChevronRight } from "lucide-react";
import { StatusDot, type Tone } from "@/components/ui";

/* ============================================================
   DESKTOP MANAGER — design system layout primitives
   ------------------------------------------------------------
   Shared layout primitives for desktop pages, sitting ON TOP
   of product-wide primitives in `src/components/ui` (Card,
   Button, StatusBadge, EmptyState …) and encoding standard layout rhythm:

     page padding   28px (32px ≥ lg)
     section gap    28px
     card padding   24px
     grid gap       20px
     card radius    14px
     control height 44px
   ============================================================ */

/* ---------- Page header ---------- */

export function PageHeader({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-ink">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1.5 text-[15px] leading-relaxed text-ink-3">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>
      )}
      {children}
    </div>
  );
}

/* ---------- Section header (inside a card) ---------- */

export function SectionHeader({
  title,
  subtitle,
  icon,
  actions,
  className = "",
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2.5 text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">
          {icon}
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-[13px] text-ink-3">{subtitle}</p>}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/* ---------- Metric / status card ---------- */

export function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
  footer,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  icon: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          {label}
        </span>
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
          {icon}
        </span>
      </div>
      <div className="mt-4 flex items-center gap-2.5">
        <StatusDot tone={tone} pulse={tone === "ok"} />
        <span className="truncate text-[26px] font-bold leading-tight tracking-[-0.02em] text-ink">
          {value}
        </span>
      </div>
      {sub && (
        <p className="mt-2 truncate text-[13px] leading-relaxed text-ink-3">{sub}</p>
      )}
      {footer && <div className="mt-4">{footer}</div>}
    </div>
  );
}

/* ---------- Attention banner ---------- */

export type NoticeTone = "warn" | "ok" | "bad" | "info";

const noticeStyles: Record<NoticeTone, string> = {
  warn: "border-notice-border bg-notice-bg text-notice-text",
  ok: "border-ok-edge bg-ok-bg text-ok",
  bad: "border-bad-edge bg-bad-bg text-bad",
  info: "border-info-edge bg-info-bg text-info",
};

const noticeIconStyles: Record<NoticeTone, string> = {
  warn: "text-notice-icon",
  ok: "text-ok-solid",
  bad: "text-bad-solid",
  info: "text-info-solid",
};

export function StatusNotice({
  tone = "warn",
  icon,
  title,
  children,
  action,
  className = "",
}: {
  tone?: NoticeTone;
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={`flex flex-col gap-4 rounded-xl border p-5 sm:flex-row sm:items-start sm:gap-4 ${noticeStyles[tone]} ${className}`}
    >
      <span className={`mt-0.5 flex-shrink-0 ${noticeIconStyles[tone]}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-snug">{title}</div>
        {children && (
          <div className="mt-1 text-[14px] leading-relaxed text-notice-text/85 [&_strong]:font-semibold">
            {children}
          </div>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/* ---------- Printer identity tile ---------- */

export function PrinterAvatar({
  name,
  size = "md",
  tone = "brand",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  tone?: Tone;
}) {
  const dims =
    size === "lg" ? "h-11 w-11 text-sm" : size === "sm" ? "h-9 w-9 text-[11px]" : "h-10 w-10 text-[13px]";
  const toneClass =
    tone === "ok"
      ? "border-ok-edge bg-ok-bg text-ok"
      : tone === "bad"
      ? "border-bad-edge bg-bad-bg text-bad"
      : tone === "warn"
      ? "border-warn-edge bg-warn-bg text-warn"
      : "border-edge-accent bg-brand-subtle text-brand";
  const initials = name
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0))
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={`flex flex-shrink-0 items-center justify-center rounded-xl border font-bold ${dims} ${toneClass}`}
    >
      {initials || "PR"}
    </span>
  );
}

/* ---------- Toolbar (filters + actions row) ---------- */

export function Toolbar({ children }: { children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">{children}</div>
    </div>
  );
}

/* ---------- Settings panel section ---------- */

export function SettingsSection({
  title,
  description,
  icon,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      <div className="border-b border-edge bg-surface px-6 py-5">
        <div className="flex items-start gap-3.5">
          <span className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{description}</p>
            )}
          </div>
        </div>
      </div>
      <div className="space-y-5 px-6 py-6">{children}</div>
    </section>
  );
}

/* ---------- Detail list ---------- */

export function DetailList({
  rows,
  className = "",
}: {
  rows: { label: string; value: React.ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={`divide-y divide-edge ${className}`}>
      {rows.map((r) => (
        <div key={r.label} className="flex items-start justify-between gap-6 py-3">
          <dt className="shrink-0 text-[13px] text-ink-3">{r.label}</dt>
          <dd className="min-w-0 text-right text-[14px] font-semibold text-ink">
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------- "View all" footer link ---------- */

export function ViewAllButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg py-2.5 text-[13px] font-semibold text-ink-3 transition-colors hover:bg-surface-2 hover:text-brand focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)]"
    >
      {label}
      <ChevronRight className="h-4 w-4" aria-hidden />
    </button>
  );
}
