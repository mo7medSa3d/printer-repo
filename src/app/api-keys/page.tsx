"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Copy, KeyRound, RefreshCw, Shield, Trash2 } from "lucide-react";
import { Button, Card, CardHeader, Input, Field, StatusBadge } from "../../components/ui";

type ApiKey = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("Odoo");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    const response = await fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" });
    if (!response.ok) throw new Error("Unable to load API keys.");
    setKeys(await response.json());
  }

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    setRawKey(null);
    setCopied(false);
    try {
      const response = await fetch("/api/odoo/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim() || "Odoo" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to generate API key.");
      setRawKey(body.apiKey);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this API key? Odoo will immediately lose access.")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/odoo/keys", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to revoke API key.");
      setRawKey(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyRawKey() {
    if (!rawKey) return;
    await navigator.clipboard.writeText(rawKey);
    setCopied(true);
  }

  return (
    <main className="mx-auto max-w-[1100px] px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-brand"><KeyRound className="h-4 w-4" /> Gateway API Keys</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Generate and revoke Odoo access</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-3">Keys are shown only once. The Gateway stores only a cryptographic hash; there is no branch or document-type scope here.</p>
        </div>
        <Link href="/dashboard" className="text-sm font-semibold text-brand hover:underline">Back to Console</Link>
      </div>

      {error && <div className="mb-5 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>}

      {rawKey && (
        <Card className="mb-6 border-brand/30 bg-brand/5">
          <CardHeader title="New API Key" subtitle="Copy it now. It will not be displayed again." icon={<Shield className="h-5 w-5 text-brand" />} />
          <div className="px-6 pb-6">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input readOnly value={rawKey} className="font-mono text-xs" aria-label="New raw API key" />
              <Button type="button" variant="primary" onClick={copyRawKey} icon={<Copy className="h-4 w-4" />}>{copied ? "Copied" : "Copy"}</Button>
            </div>
          </div>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader title="Generate API Key" subtitle="Use this key in Odoo Gateway Configuration." icon={<KeyRound className="h-5 w-5 text-brand" />} />
        <div className="grid gap-4 px-6 pb-6 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Key name">
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </Field>
          <Button type="button" variant="primary" onClick={generate} loading={busy} disabled={busy} icon={<KeyRound className="h-4 w-4" />}>Generate API Key</Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Existing Keys" subtitle="Metadata only. Raw secrets are never recoverable." icon={<Shield className="h-5 w-5 text-brand" />} />
        <div className="divide-y divide-edge">
          {keys.length === 0 ? (
            <div className="px-6 py-8 text-sm text-ink-3">No API keys configured.</div>
          ) : keys.map((item) => (
            <div key={item.id} className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-ink">{item.name}</span>
                  <StatusBadge tone={item.revokedAt ? "error" : "ok"} label={item.revokedAt ? "Revoked" : "Active"} />
                </div>
                <div className="mt-1 text-xs text-ink-3">Created {new Date(item.createdAt).toLocaleString()} · Last used {item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : "Never"}</div>
                <div className="mt-1 font-mono text-[11px] text-ink-3">{item.id}</div>
              </div>
              {!item.revokedAt && <Button type="button" variant="secondary" onClick={() => revoke(item.id)} disabled={busy} icon={<Trash2 className="h-4 w-4" />}>Revoke</Button>}
            </div>
          ))}
        </div>
      </Card>
    </main>
  );
}
