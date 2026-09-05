import Link from "next/link";
import { Compass, LayoutDashboard, Home } from "lucide-react";
import { BrandMark, Button } from "../components/ui";

export default function NotFound() {
  return (
    <div className="canvas-wash min-h-[calc(100vh-8rem)] flex items-center justify-center py-12">
      <div className="container mx-auto flex max-w-xl flex-col items-start px-4">
        <BrandMark size="lg" title="Print Gateway" subtitle="Enterprise print operations" />
        <div className="card brand-hairline mt-8 w-full p-8 shadow-md">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
            <Compass className="h-6 w-6" aria-hidden />
          </div>
          <p className="label-caps mt-5">Error 404</p>
          <h1 className="mt-1 text-2xl font-bold tracking-[-0.015em] text-ink">
            This page isn’t part of the gateway
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            The address you followed doesn’t match any console route. Nothing was changed and no
            print job was affected.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              variant="primary"
              href="/dashboard"
              icon={<LayoutDashboard className="h-4 w-4" aria-hidden />}
            >
              Open console
            </Button>
            <Button
              variant="secondary"
              href="/"
              icon={<Home className="h-4 w-4" aria-hidden />}
            >
              Back to home
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
