"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, MonitorPlay, LogIn, Menu, X, Home } from "lucide-react";
import { BrandMark } from "@/components/brand";

const navLinks = [
  { href: "/", label: "Home", icon: Home },
  { href: "/dashboard", label: "Console", icon: LayoutDashboard },
  { href: "/simulator", label: "Simulator", icon: MonitorPlay },
  { href: "/login", label: "Sign in", icon: LogIn },
];

export function HeaderNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 border-b border-edge bg-surface/85 backdrop-blur-md">
      <div className="container mx-auto flex h-16 items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="rounded-lg focusable transition-opacity hover:opacity-90"
            aria-label="Print Gateway home"
          >
            <BrandMark title="Print Gateway" subtitle="Enterprise print operations" />
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden items-center gap-1 text-sm font-medium md:flex" role="navigation" aria-label="Main Navigation">
            {navLinks.map(({ href, label, icon: Icon }) => {
              const isActive = pathname === href || (href !== "/" && pathname.startsWith(href));
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex items-center gap-2 rounded-lg px-3 py-1.5 transition-colors duration-150 focusable ${
                    isActive
                      ? "bg-brand-subtle font-semibold text-brand-subtle-text"
                      : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${isActive ? "text-brand" : "text-ink-3"}`} aria-hidden />
                  {label}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden sm:inline-flex items-center rounded-md border border-edge bg-surface-2 px-2.5 py-1 font-mono text-[11px] font-medium text-ink-3">
            v1.0.0
          </span>

          {/* Mobile Navigation Toggle */}
          <button
            type="button"
            onClick={() => setMobileOpen(!mobileOpen)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-edge bg-surface text-ink-2 hover:bg-surface-2 focusable md:hidden"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer Menu */}
      {mobileOpen && (
        <div className="border-b border-edge bg-surface px-4 py-3 md:hidden pg-fade-in">
          <div className="flex flex-col space-y-1">
            {navLinks.map(({ href, label, icon: Icon }) => {
              const isActive = pathname === href || (href !== "/" && pathname.startsWith(href));
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMobileOpen(false)}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-brand-subtle font-semibold text-brand-subtle-text"
                      : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${isActive ? "text-brand" : "text-ink-3"}`} aria-hidden />
                  {label}
                </Link>
              );
            })}
          </div>
          <div className="mt-3 border-t border-edge pt-3 flex items-center justify-between text-xs text-ink-3">
            <span>Odoo Print Gateway</span>
            <span className="font-mono">v1.0.0</span>
          </div>
        </div>
      )}
    </nav>
  );
}
