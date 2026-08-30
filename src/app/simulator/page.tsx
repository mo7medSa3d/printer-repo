import AgentSimulator from "./agent-simulator";

export default function SimulatorPage() {
  return (
    <div className="container mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold mb-4">Protocol Simulator</h1>
      <p className="text-zinc-500 mb-8 max-w-2xl">
        This TypeScript component simulates the Agent communication protocol over HTTPS.
        It does <strong>not</strong> execute the native Go binaries. 
        Use this to test server-side logic and pairing flows.
      </p>
      <AgentSimulator />
    </div>
  );
}
