import AgentSimulator from "./agent-simulator";

export default function SimulatorPage() {
  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-[-0.015em] text-ink">Protocol simulator</h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-2">
        Simulates the agent protocol over HTTPS against the real gateway API — pairing, heartbeat,
        job polling and status updates. It does not execute the native Go binaries.
      </p>
      <div className="mt-6">
        <AgentSimulator />
      </div>
    </div>
  );
}
