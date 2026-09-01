"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui";

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
    <div className="container mx-auto flex max-w-md flex-col px-4 py-16 sm:py-24">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-700 text-white">
          <Printer className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold text-ink">Manager sign in</h1>
          <p className="text-xs text-ink-3">Odoo Print Gateway — management console</p>
        </div>
      </div>
      <form
        onSubmit={onSubmit}
        className="card mt-6 space-y-4 p-6"
        aria-describedby="login-help"
      >
        <div>
          <label htmlFor="username" className="block text-xs font-semibold uppercase tracking-wide text-ink-2">
            Username
          </label>
          <input
            id="username"
            className="mt-1.5 h-9 w-full rounded-lg border border-edge bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wide text-ink-2">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="mt-1.5 h-9 w-full rounded-lg border border-edge bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {err && (
          <div role="alert" className="rounded-lg border border-bad-edge bg-bad-bg px-3 py-2.5 text-sm text-bad">
            {err}
          </div>
        )}
        <Button variant="primary" type="submit" loading={loading} className="w-full">
          {loading ? "Signing in…" : "Sign in"}
        </Button>
        <p id="login-help" className="text-xs leading-relaxed text-ink-3">
          Your session is a short-lived, revocable cookie. Credentials come from the gateway environment
          (<code className="font-mono">MANAGER_USERNAME</code> / <code className="font-mono">MANAGER_PASSWORD_HASH</code>).
        </p>
      </form>
    </div>
  );
}
