import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Odoo Print Gateway",
  description: "Cloud Print Gateway — Go Agent ↔ Gateway (WS) + Tauri Manager + Odoo (HTTPS)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-app text-ink min-h-screen">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
