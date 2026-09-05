"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Lock } from "lucide-react";
import { BrandMark, Button, Field, Input, ErrorState } from "../../components/ui";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/manager/me", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) router.replace("/");
      })
      .catch(() => {
        // Treat an unavailable auth probe as unauthenticated and keep the form usable.
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false);
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/manager/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "login failed");

      // `/` is the authenticated home. Its server-side guard guarantees that
      // unauthenticated visitors can never see the internal home content.
      router.replace("/");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "login failed");
    } finally {
      setLoading(false);
    }
  }

  if (checkingSession) {
    return (
      <div className="canvas-wash min-h-screen flex items-center justify-center px-4">
        <div className="flex flex-col items-center gap-4 text-center">
          <BrandMark size="lg" title="Print Gateway" subtitle="Management console" />
          <span className="text-sm text-ink-3">Checking session…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="canvas-wash min-h-screen flex items-center justify-center py-12">
      <div className="container mx-auto flex max-w-md flex-col px-4">
        <div className="flex flex-col items-start gap-3">
          <BrandMark size="lg" title="Print Gateway" subtitle="Management console" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink">Sign in to continue</h1>
            <p className="mt-1 text-sm text-ink-3">
              Manager access to agents, printers and the live print queue.
            </p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="card brand-hairline mt-6 space-y-5 p-6 shadow-md"
          aria-describedby="login-help"
        >
          <Field label="Username" htmlFor="username">
            <Input
              id="username"
              placeholder="Enter manager username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </Field>

          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>

          {err && <ErrorState title="Authentication error" message={err} />}

          <Button
            variant="primary"
            type="submit"
            loading={loading}
            className="w-full"
            icon={<Lock className="h-4 w-4" />}
          >
            {loading ? "Signing in…" : "Sign in"}
          </Button>

          <div id="login-help" className="surface-accent flex items-start gap-2.5 rounded-xl border border-edge-accent p-3.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" aria-hidden />
            <p className="text-xs leading-relaxed text-ink-2">
              Your session is a short-lived, revocable cookie. Credentials come from the gateway environment (
              <code className="font-mono text-ink">MANAGER_USERNAME</code> /{" "}
              <code className="font-mono text-ink">MANAGER_PASSWORD_HASH</code>).
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}
