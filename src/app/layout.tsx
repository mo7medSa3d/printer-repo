import type { Metadata } from "next";
import type { ReactNode } from "react";
import { HeaderNav } from "@/components/HeaderNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Odoo Print Gateway",
  description: "Cloud Print Gateway — Go Agent ↔ Gateway (WS) + Tauri Manager + Odoo (HTTPS)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-app text-ink min-h-screen flex flex-col">
        <HeaderNav />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-edge bg-surface py-6 mt-auto">
          <div className="container mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-ink-3">
            <p>© 2026 Print Gateway · Enterprise Print Operations</p>
            <div className="flex items-center gap-4">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-ok-solid" aria-hidden /> Gateway operational
              </span>
              <span className="font-mono">v1.0.0</span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
