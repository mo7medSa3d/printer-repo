import React, { useEffect, useRef } from "react";
import { X, Check, Loader2, Copy, AlertTriangle } from "lucide-react";

/* ============================================================
   Odoo Print Gateway — shared UI primitives
   One source for Button / Badge / Status / Card / Empty &
   error states / Modal / Drawer / Field. Used by the Desktop
   Manager (vite) and the Web dashboard (Next), so the two
   surfaces stay visually and semantically consistent.
   ============================================================ */

export { BrandMark } from "./brand";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral" | "brand";

export const toneBg: Record<Tone, string> = {
  ok: "bg-ok-bg text-ok border-ok-edge",
  warn: "bg-warn-bg text-warn border-warn-edge",
  bad: "bg-bad-bg text-bad border-bad-edge",
  info: "bg-info-bg text-info border-info-edge",
  neutral: "bg-surface-2 text-ink-2 border-edge",
  brand: "bg-brand-subtle text-brand-subtle-text border-edge-accent",
};

/* Dots use the `-solid` fills: saturated enough to read at 8px,
   while the text tokens above stay AA-legible on tinted surfaces. */
export const toneDot: Record<Tone, string> = {
  ok: "bg-ok-solid",
  warn: "bg-warn-solid",
  bad: "bg-bad-solid",
  info: "bg-info-solid",
  neutral: "bg-ink-4",
  brand: "bg-brand",
};

/* ---------- Buttons ---------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-brand-contrast border border-transparent shadow-xs hover:bg-brand-hover active:bg-brand-active",
  secondary:
    "bg-surface text-ink border border-edge shadow-xs hover:bg-surface-2 hover:border-edge-strong active:bg-surface-3",
  ghost:
    "bg-transparent text-ink-2 border border-transparent hover:bg-brand-subtle hover:text-brand-subtle-text",
  danger:
    "bg-bad-solid text-white border border-transparent shadow-xs hover:brightness-95 active:brightness-90",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: React.ReactNode;
}) {
  const sizes =
    size === "sm"
      ? "h-10 px-3.5 text-[13px] gap-1.5"
      : size === "lg"
      ? "h-12 px-5 text-[15px] gap-2.5"
      : "h-11 px-4 text-sm gap-2";
  return (
    <button
      className={`inline-flex items-center justify-center rounded-lg font-semibold transition-[background-color,border-color,color,box-shadow,filter] duration-150 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)] ${buttonVariants[variant]} ${sizes} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center h-10 w-10 rounded-lg text-ink-3 transition-colors duration-150 hover:bg-brand-subtle hover:text-brand-subtle-text focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)] disabled:opacity-50 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/* ---------- Status ---------- */

export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 rounded-full ${toneDot[tone]} ${
        pulse ? "animate-pulse" : ""
      }`}
    />
  );
}

export function StatusBadge({
  tone = "neutral",
  label,
  icon,
  className = "",
}: {
  tone?: Tone;
  label: string;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] font-semibold whitespace-nowrap ${toneBg[tone]} ${className}`}
    >
      {icon ?? <StatusDot tone={tone} />}
      {label}
    </span>
  );
}

/* ---------- Surface ---------- */

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function CardHeader({
  title,
  subtitle,
  actions,
  icon,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2.5 text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">
          {icon}
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-[13px] text-ink-3">{subtitle}</p>}
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">{actions}</div>
      )}
    </div>
  );
}

/* ---------- States ---------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center px-8 py-20 ${className}`}
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-edge-accent bg-surface-accent text-brand">
        {icon}
      </div>
      <h3 className="mt-5 text-[18px] font-semibold text-ink">{title}</h3>
      {description && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-3">
          {description}
        </p>
      )}
      {action && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {action}
        </div>
      )}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  retry,
  className = "",
}: {
  title?: string;
  message: string;
  retry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-3.5 rounded-xl border border-bad-edge bg-bad-bg px-5 py-4 text-sm ${className}`}
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-bad" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold text-bad">{title}</div>
        <p className="mt-1 break-words leading-relaxed text-ink-2">{message}</p>
      </div>
      {retry && (
        <Button size="sm" variant="secondary" onClick={retry} className="shrink-0">
          Retry
        </Button>
      )}
    </div>
  );
}

export function LoadingState({
  rows = 3,
  className = "",
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-label="Loading" className={`space-y-3 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="skeleton h-9"
          style={{ width: `${100 - i * 12}%` }}
        />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/* ---------- Forms ---------- */

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label
        htmlFor={htmlFor}
        className="block text-[13px] font-semibold text-ink"
      >
        {label}
      </label>
      <div className="mt-2">{children}</div>
      {hint && (
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{hint}</p>
      )}
    </div>
  );
}

export const inputClass =
  "w-full h-11 rounded-lg border border-edge bg-surface px-3.5 text-sm text-ink placeholder:text-ink-4 shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-edge-strong focus:border-brand focus:outline-none focus:shadow-[var(--focus-ring-shadow)] disabled:opacity-50 disabled:bg-surface-2";

export function Input({
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputClass} ${className}`} {...props} />;
}

export function Select({
  className = "",
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${inputClass} appearance-none pr-8 ${className}`} {...props}>
      {children}
    </select>
  );
}

/* ---------- Modal / Drawer ---------- */

function useDialog(
  open: boolean,
  onClose: () => void,
  panelRef: React.RefObject<HTMLDivElement | null>
) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onClose, panelRef]);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(open, onClose, panelRef);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="pg-fade-in absolute inset-0 backdrop-blur-[2px]"
        style={{ backgroundColor: "var(--overlay)" }}
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`pg-rise-in relative w-full ${
          wide ? "sm:max-w-3xl" : "sm:max-w-xl"
        } max-h-[92vh] overflow-auto rounded-t-2xl sm:rounded-panel border border-edge bg-surface shadow-xl outline-none`}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-edge bg-surface px-6 py-5">
          <div className="min-w-0">
            <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
            {description && (
              <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{description}</p>
            )}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X className="h-5 w-5" />
          </IconButton>
        </div>
        <div className="px-6 py-6">{children}</div>
        {footer && (
          <div className="sticky bottom-0 flex justify-end gap-3 border-t border-edge bg-surface px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(open, onClose, panelRef);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="pg-fade-in absolute inset-0"
        style={{ backgroundColor: "var(--overlay)" }}
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="pg-slide-in-right relative flex h-full w-full max-w-lg flex-col border-l border-edge bg-surface shadow-xl outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b border-edge px-6 py-5">
          <div className="min-w-0">
            <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
            {description && (
              <p className="mt-1 truncate text-[13px] text-ink-3">{description}</p>
            )}
          </div>
          <IconButton label="Close panel" onClick={onClose}>
            <X className="h-5 w-5" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-auto px-6 py-6">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Tabs ---------- */

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  counts,
  className = "",
}: {
  tabs: readonly T[];
  active: T;
  onChange: (t: T) => void;
  counts?: Partial<Record<T, number>>;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`flex items-center gap-1 overflow-x-auto border-b border-edge ${className}`}
    >
      {tabs.map((t) => {
        const selected = t === active;
        const count = counts?.[t];
        return (
          <button
            key={t}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t)}
            className={`relative flex items-center gap-2 whitespace-nowrap px-4 py-3 text-sm font-semibold transition-colors ${
              selected ? "text-ink" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            <span className="capitalize">{t}</span>
            {count !== undefined && (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
                  selected
                    ? "bg-brand-subtle text-brand-subtle-text"
                    : "bg-surface-2 text-ink-3"
                }`}
              >
                {count}
              </span>
            )}
            {selected && (
              <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Misc ---------- */

export function CopyButton({
  value,
  onCopied,
  label = "Copy",
  className = "",
}: {
  value: string;
  onCopied?: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={`${label} ${value}`}
      title={label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          onCopied?.();
        } catch {
          /* clipboard unavailable inside WebView without focus; ignore */
        }
      }}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border border-edge bg-surface px-2.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:border-edge-accent hover:bg-brand-subtle hover:text-brand-subtle-text focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-shadow)] ${className}`}
    >
      <Copy className="h-3 w-3" aria-hidden />
      {label}
    </button>
  );
}

export function Toast({
  toast,
  onDismiss,
}: {
  toast: { text: string; type: "success" | "error" | "info" } | null;
  onDismiss: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!toast) return;
    timer.current = setTimeout(onDismiss, 5000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast, onDismiss]);
  if (!toast) return null;
  const tone = toast.type === "success" ? "ok" : toast.type === "error" ? "bad" : "info";
  return (
    <div
      role="status"
      className={`pg-toast-in fixed bottom-6 right-6 z-[60] flex max-w-md items-start gap-3 rounded-xl border px-5 py-4 text-sm shadow-lg ${toneBg[tone]}`}
    >
      {toast.type === "success" ? (
        <Check className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 break-words">{toast.text}</span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="ml-auto flex-shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* ---------- Monospace data / metadata ---------- */

export function Mono({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <code className={`font-mono text-[12px] text-ink-2 ${className}`}>
      {children}
    </code>
  );
}

export function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-2.5 text-sm">
      <span className="shrink-0 text-[13px] text-ink-3">{label}</span>
      <span className="min-w-0 text-right text-[14px] font-semibold text-ink">{children}</span>
    </div>
  );
}
