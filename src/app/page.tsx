import Link from "next/link";
import { ArrowRight, Printer, Shield, Zap, Globe, Cpu } from "lucide-react";

export default function Home() {
  return (
    <div className="flex flex-col items-center">
      {/* Hero Section */}
      <section className="w-full py-20 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight mb-6">
            Odoo Print Gateway <span className="text-blue-600">Production</span>
          </h1>
          <p className="text-xl text-zinc-500 max-w-2xl mx-auto mb-10">
            Cloud Print Gateway (Next.js + PG) — Go Agent (Service) — Tauri Manager (lightweight). See Gateway <code>queued→claimed→printing→success/failed/expired</code> vs Agent <code>queued→printing→success/failed</code>.
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <Link 
              href="/dashboard" 
              className="bg-blue-600 text-white px-8 py-4 rounded-lg font-bold text-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
            >
              Get Started <ArrowRight className="w-5 h-5" />
            </Link>
            <Link 
              href="/simulator" 
              className="bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 px-8 py-4 rounded-lg font-bold text-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            >
              Try Simulator
            </Link>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="w-full py-20 bg-zinc-50 dark:bg-zinc-950">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
            <FeatureCard 
              icon={<Shield className="w-8 h-8 text-blue-500" />}
              title="Secure Pairing"
              description="One-time pairing codes and encrypted credentials ensure only authorized agents can print."
            />
            <FeatureCard 
              icon={<Zap className="w-8 h-8 text-yellow-500" />}
              title="Low Latency"
              description="WebSocket-first communication with HTTPS polling fallback for maximum reliability."
            />
            <FeatureCard 
              icon={<Globe className="w-8 h-8 text-green-500" />}
              title="Multi-Branch"
              description="Centralized management for hundreds of branches and thousands of printers."
            />
            <FeatureCard 
              icon={<Cpu className="w-8 h-8 text-purple-500" />}
              title="Go Powered"
              description="Native Windows service written in Go for performance, stability, and low resource usage."
            />
            <FeatureCard 
              icon={<Printer className="w-8 h-8 text-pink-500" />}
              title="RAW TCP / ESC/POS"
              description="Real socket write with deadline + short-write loop. success = bytes on wire, not paper-out. USB stub, IPP rejected."
            />
            <FeatureCard 
              icon={<ArrowRight className="w-8 h-8 text-zinc-500" />}
              title="Durable Queue"
              description="SQLite-backed local queue ensures no print job is lost during network outages."
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode, title: string, description: string }) {
  return (
    <div className="p-8 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-sm hover:shadow-md transition-shadow">
      <div className="mb-4">{icon}</div>
      <h3 className="text-xl font-bold mb-2">{title}</h3>
      <p className="text-zinc-500 text-sm leading-relaxed">{description}</p>
    </div>
  );
}
