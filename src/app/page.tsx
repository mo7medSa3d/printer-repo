import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowRight, Printer, ShieldCheck, Zap, Globe, Cpu } from "lucide-react";
import { Button } from "../components/ui";
import { getManagerCookieName, validateManagerClaims, verifyManagerToken } from "../lib/manager-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const token = (await cookies()).get(getManagerCookieName())?.value ?? null;
  const claims = await validateManagerClaims(token ? verifyManagerToken(token) : null);
  if (!claims) redirect("/login");

  return (
    <div className="flex flex-col items-center">
      <section className="w-full border-b border-edge bg-surface">
        <div className="mx-auto max-w-[1440px] px-4 py-16 text-center sm:px-6 md:py-24">
          <h1 className="mx-auto max-w-3xl text-3xl font-extrabold leading-tight tracking-tight text-ink sm:text-4xl md:text-5xl">
            Odoo Print Gateway
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-ink-2 sm:text-lg">
            Centralized print queue, Windows agent routing, and hardware status for enterprise Odoo deployments. Reliable document routing from cloud ERP to physical hardware.
          </p>
          <div className="mt-8 flex justify-center">
            <Button
              variant="primary"
              size="lg"
              href="/dashboard"
              icon={<ArrowRight className="h-4 w-4" aria-hidden />}
            >
              Open console
            </Button>
          </div>
        </div>
      </section>

      <section className="w-full bg-app">
        <div className="mx-auto max-w-[1440px] px-4 py-16 sm:px-6 md:py-20">
          <div className="mb-10 text-center">
            <h2 className="text-2xl font-bold tracking-tight text-ink">Enterprise print architecture</h2>
            <p className="mt-2 text-sm text-ink-3">End-to-end reliability from cloud ERP to physical hardware</p>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              icon={<ShieldCheck className="h-5 w-5" />}
              title="Secure pairing"
              description="One-time pairing codes and installation-scoped API keys ensure only authorized agents and Odoo installations can print."
            />
            <FeatureCard
              icon={<Zap className="h-5 w-5" />}
              title="Low latency"
              description="WebSocket-first delivery with an HTTPS polling fallback for maximum reliability."
            />
            <FeatureCard
              icon={<Globe className="h-5 w-5" />}
              title="Multi-branch routing"
              description="Branch, destination, document type and printer bindings resolved per job — no hardcoded printer IDs."
            />
            <FeatureCard
              icon={<Cpu className="h-5 w-5" />}
              title="Native Windows agent"
              description="A lightweight Go service with a durable local queue and graceful in-flight drain."
            />
            <FeatureCard
              icon={<Printer className="h-5 w-5" />}
              title="Real transports"
              description="RAW TCP, ESC/POS, IPP/IPPS and Windows spooler — success means the bytes reached the printer."
            />
            <FeatureCard
              icon={<ArrowRight className="h-5 w-5" />}
              title="Retry-safe queue"
              description="Idempotency keys, atomic claims and lease reclaim mean a network blip never prints twice."
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="card card-interactive p-6">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
        {icon}
      </div>
      <h3 className="mt-4 text-[16px] font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{description}</p>
    </div>
  );
}
