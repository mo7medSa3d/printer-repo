import React from "react";
import { Printer } from "lucide-react";

/* ============================================================
   Print Gateway — brand lockup
   Server-safe (no hooks) so it can be rendered by the Next.js
   app shell as well as by the desktop manager.
   ============================================================ */

/**
 * The product lockup. One mark, one geometry, one accent — reused by the
 * web shell, the auth screen and the desktop manager so every surface is
 * recognisably the same product.
 */
export function BrandMark({
  size = "md",
  showWordmark = true,
  title = "Print Gateway",
  subtitle = "Enterprise print operations",
  className = "",
}: {
  size?: "sm" | "md" | "lg";
  showWordmark?: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
}) {
  const tile =
    size === "lg" ? "h-11 w-11 rounded-xl" : size === "sm" ? "h-8 w-8 rounded-md" : "h-9 w-9 rounded-lg";
  const glyph = size === "lg" ? "h-5 w-5" : "h-4 w-4";
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <span
        aria-hidden
        className={`flex flex-shrink-0 items-center justify-center bg-brand text-brand-contrast shadow-xs ring-1 ring-inset ring-white/15 ${tile}`}
      >
        <Printer className={glyph} />
      </span>
      {showWordmark && (
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold tracking-[-0.01em] text-ink">
            {title}
          </span>
          <span className="block truncate text-[11px] font-medium text-ink-3">
            {subtitle}
          </span>
        </span>
      )}
    </span>
  );
}
