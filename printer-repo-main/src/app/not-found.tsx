import Link from "next/link";
import { Compass, LayoutDashboard } from "lucide-react";
import { BrandMark } from "@/components/brand";

export default function NotFound() {
  return (
    <div className="canvas-wash min-h-[calc(100vh-4rem)]">
      <div className="container mx-auto flex max-w-xl flex-col items-start px-4 py-20 sm:py-28">
        <BrandMark size="lg" title="Print Gateway" subtitle="Enterprise print operations" />
        <div className="card brand-hairline mt-8 w-full p-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
            <Compass className="h-5 w-5" aria-hidden />
          </div>
          <p className="label-caps mt-5">Error 404</p>
          <h1 className="mt-1 text-xl font-semibold tracking-[-0.015em] text-ink">
            This page isn’t part of the gateway
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            The address you followed doesn’t match any console route. Nothing was changed and no
            print job was affected.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link
              href="/dashboard"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-brand-contrast shadow-xs transition-colors duration-150 hover:bg-brand-hover active:bg-brand-active focusable"
            >
              <LayoutDashboard className="h-4 w-4" aria-hidden />
              Open console
            </Link>
            <Link
              href="/"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-edge bg-surface px-4 text-sm font-semibold text-ink shadow-xs transition-colors duration-150 hover:border-edge-strong hover:bg-surface-2 focusable"
            >
              Back to home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
