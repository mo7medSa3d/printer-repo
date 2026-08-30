"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/manager/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "login failed");
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container mx-auto max-w-md py-16 px-4">
      <h1 className="text-2xl font-bold mb-2">Manager Login</h1>
      <p className="text-sm text-zinc-500 mb-6">Sign in with MANAGER_USERNAME / MANAGER_PASSWORD (env). Session is httpOnly cookie (8h, jti revoked on logout). Tauri verifies cookie round-trip.</p>
      <form onSubmit={onSubmit} className="space-y-4 p-6 border rounded-xl bg-white dark:bg-zinc-900">
        <input className="w-full px-3 py-2 border rounded-md text-sm" placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" />
        <input className="w-full px-3 py-2 border rounded-md text-sm" placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button disabled={loading} className="w-full py-2 bg-blue-600 text-white rounded-md text-sm font-medium disabled:opacity-50">{loading ? "Signing in…" : "Sign in"}</button>
        <p className="text-xs text-zinc-400">Set MANAGER_USERNAME, MANAGER_PASSWORD or MANAGER_PASSWORD_HASH (scrypt salt:hex), and GATEWAY_JWT_SECRET (&ge;32 chars) in env.</p>
      </form>
    </div>
  );
}
