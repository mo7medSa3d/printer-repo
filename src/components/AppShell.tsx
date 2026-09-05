"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { HeaderNav } from "./HeaderNav";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAuthScreen = pathname === "/login";

  if (isAuthScreen) {
    return <main className="min-h-screen">{children}</main>;
  }

  return (
    <div className="flex min-h-screen flex-col bg-app text-ink">
      <HeaderNav />
      <main className="flex-1">{children}</main>
      <footer className="border-t border-edge bg-surface py-6 mt-auto">
        <div className="container mx-auto flex flex-col items-center justify-between gap-4 px-4 text-xs text-ink-3 sm:flex-row">
          <p>© 2026 Print Gateway · Enterprise Print Operations</p>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-ok-solid" aria-hidden /> Gateway operational
            </span>
            <span className="font-mono">v1.0.0</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
