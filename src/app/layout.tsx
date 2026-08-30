import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Odoo Print Gateway",
  description: "Cloud Print Gateway — Go Agent ↔ Gateway (WS) + Tauri Manager + Odoo (HTTPS)",
};

import { LayoutDashboard, MonitorPlay, Printer } from "lucide-react";
import Link from "next/link";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 min-h-screen">
        <nav className="border-b bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 sticky top-0 z-50">
          <div className="container mx-auto px-4 h-16 flex items-center justify-between">
            <div className="flex items-center gap-8">
              <Link href="/" className="flex items-center gap-2 font-bold text-lg">
                <Printer className="w-6 h-6 text-blue-600" />
                Odoo Print Gateway
              </Link>
              <div className="hidden md:flex items-center gap-6 text-sm font-medium">
                <Link href="/dashboard" className="flex items-center gap-2 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
                  <LayoutDashboard className="w-4 h-4" />
                  Console
                </Link>
                <Link href="/login" className="flex items-center gap-2 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
                  Login
                </Link>
                <Link href="/simulator" className="flex items-center gap-2 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
                  Simulator
                </Link>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-xs px-2 py-1 bg-zinc-100 dark:bg-zinc-800 rounded text-zinc-500 uppercase font-bold tracking-tighter">
                v1.0.0
              </span>
            </div>
          </div>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
