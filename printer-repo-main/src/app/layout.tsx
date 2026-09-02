import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { LayoutDashboard, MonitorPlay, LogIn } from "lucide-react";
import { BrandMark } from "@/components/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: "Odoo Print Gateway",
  description: "Cloud Print Gateway — Go Agent ↔ Gateway (WS) + Tauri Manager + Odoo (HTTPS)",
};

const navLinks = [
  { href: "/dashboard", label: "Console", icon: LayoutDashboard },
  { href: "/simulator", label: "Simulator", icon: MonitorPlay },
  { href: "/login", label: "Sign in", icon: LogIn },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-app text-ink min-h-screen">
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
              <div className="hidden items-center gap-1 text-sm font-medium md:flex">
                {navLinks.map(({ href, label, icon: Icon }) => (
                  <Link
                    key={href}
                    href={href}
                    className="flex items-center gap-2 rounded-md px-3 py-1.5 text-ink-2 transition-colors duration-150 hover:bg-brand-subtle hover:text-brand-subtle-text"
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {label}
                  </Link>
                ))}
              </div>
            </div>
            <span className="rounded-sm border border-edge bg-surface-2 px-2 py-1 font-mono text-[11px] font-medium text-ink-3">
              v1.0.0
            </span>
          </div>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
