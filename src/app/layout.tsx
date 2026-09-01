import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { LayoutDashboard, MonitorPlay, Printer } from "lucide-react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Odoo Print Gateway",
  description: "Cloud Print Gateway — Go Agent ↔ Gateway (WS) + Tauri Manager + Odoo (HTTPS)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-app text-ink min-h-screen">
        <nav className="border-b border-edge bg-surface sticky top-0 z-50">
          <div className="container mx-auto px-4 h-16 flex items-center justify-between gap-4">
            <div className="flex items-center gap-8">
              <Link href="/" className="flex items-center gap-2.5 group">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-700 text-white transition-colors group-hover:bg-brand-800">
                  <Printer className="h-4.5 w-4.5" aria-hidden />
                </span>
                <span className="font-bold leading-tight">
                  <span className="block text-sm text-ink">Print Gateway</span>
                  <span className="block text-[11px] font-medium text-ink-3">Odoo Print</span>
                </span>
              </Link>
              <div className="hidden md:flex items-center gap-1 text-sm font-medium">
                <Link href="/dashboard" className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink transition-colors">
                  <LayoutDashboard className="w-4 h-4" aria-hidden />
                  Console
                </Link>
                <Link href="/login" className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink transition-colors">
                  Login
                </Link>
                <Link href="/simulator" className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink transition-colors">
                  <MonitorPlay className="w-4 h-4" aria-hidden />
                  Simulator
                </Link>
              </div>
            </div>
            <span className="rounded-md border border-edge bg-surface-2 px-2 py-1 font-mono text-[11px] font-medium text-ink-3">
              v1.0.0
            </span>
          </div>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
