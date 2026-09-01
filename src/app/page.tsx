import Link from "next/link";
import { ArrowRight, MonitorPlay, Printer, ShieldCheck, Zap, Globe, Cpu } from "lucide-react";

export default function Home() {
  return (
    <div className="flex flex-col items-center">
      <section className="w-full border-b border-edge bg-surface">
        <div className="container mx-auto px-4 py-20 md:py-28 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface-2 px-3 py-1 text-xs font-medium text-ink-2">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden /> Production print infrastructure
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl md:text-5xl font-extrabold tracking-tight text-ink">
            Printing infrastructure that just works
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-ink-2">
            Odoo Print Gateway routes every document from Odoo to the right printer — through a
            durable cloud queue, a Windows print agent, and a desktop manager built for the brand.
          </p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              href="/dashboard"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-brand-700 px-6 text-sm font-semibold text-white transition-colors hover:bg-brand-800"
            >
              Open console <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/simulator"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-edge bg-surface px-6 text-sm font-semibold text-ink transition-colors hover:bg-surface-2"
            >
              <MonitorPlay className="h-4 w-4" aria-hidden /> Try the simulator
            </Link>
          </div>
        </div>
      </section>

      <section className="w-full bg-app">
        <div className="container mx-auto px-4 py-20">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <FeatureCard
              icon={<ShieldCheck className="h-5 w-5" />}
              title="Secure pairing"
              description="One-time pairing codes and scoped credentials ensure only authorized agents can print."
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

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="card p-6 transition-shadow hover:shadow-md">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-900/60 dark:text-brand-300">
        {icon}
      </div>
      <h3 className="mt-4 font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{description}</p>
    </div>
  );
}
