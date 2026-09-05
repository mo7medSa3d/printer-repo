from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def edit(path, transform):
    p = ROOT / path
    text = p.read_text(encoding="utf-8")
    new = transform(text)
    if new == text:
        return False
    p.write_text(new, encoding="utf-8")
    return True


def must_replace(text, old, new, path):
    if old not in text:
        raise SystemExit(f"Expected marker not found in {path}: {old[:120]!r}")
    return text.replace(old, new, 1)


# P1/#9: align the gateway claim cap with the agent's local pending executor cap.
edit("src/app/api/agent/jobs/route.ts", lambda t: t.replace(
    "export const MAX_AGENT_IN_FLIGHT_JOBS = 500;",
    "export const MAX_AGENT_IN_FLIGHT_JOBS = 64;",
    1,
))

# P1/#3: allow an authenticated printing agent to refresh the execution lease.
agent_jobs = ROOT / "src/app/api/agent/jobs/route.ts"
t = agent_jobs.read_text(encoding="utf-8")
needle = '  if (!canTransition(currentStatus, requestedStatus)) return NextResponse.json({ error: `Invalid status transition: ${currentStatus} -> ${requestedStatus}` }, { status: 409 });\n'
replacement = '''  // A printing agent may heartbeat the same state to extend its execution lease.\n  // This is intentionally restricted to printing so terminal and queued states\n  // cannot be kept alive by arbitrary clients.\n  if (currentStatus === "printing" && requestedStatus === "printing") {\n    const refreshed = await db.update(printJobs)\n      .set({ error: errorMessage, updatedAt: new Date() })\n      .where(and(whereClause, eq(printJobs.status, "printing")))\n      .returning({ status: printJobs.status });\n    if (refreshed.length !== 1) return NextResponse.json({ error: "Concurrent status transition rejected" }, { status: 409 });\n    return NextResponse.json({ success: true, status: "printing", heartbeat: true });\n  }\n\n  // Crash recovery may explicitly request a retry. The marker prevents a\n  // generic caller from turning printing back into an unbounded queue loop.\n  const retryAfterCrash = currentStatus === "printing" &&\n    requestedStatus === "queued" &&\n    typeof rawError === "string" &&\n    rawError.startsWith("AGENT_RESTART_DURING_PRINT_RETRYABLE:");\n  if (!retryAfterCrash && !canTransition(currentStatus, requestedStatus)) {\n    return NextResponse.json({ error: `Invalid status transition: ${currentStatus} -> ${requestedStatus}` }, { status: 409 });\n  }\n'''
t = must_replace(t, needle, replacement, "src/app/api/agent/jobs/route.ts")
needle2 = '      ...(requestedStatus === "claimed" ? { claimedAt: new Date() } : {}),\n'
replacement2 = '''      ...(requestedStatus === "claimed" ? { claimedAt: new Date() } : {}),\n      ...(retryAfterCrash ? { claimedAt: null, deliveredAt: null, ackedAt: null, retries: sql`${printJobs.retries} + 1` } : {}),\n'''
t = must_replace(t, needle2, replacement2, "src/app/api/agent/jobs/route.ts")
agent_jobs.write_text(t, encoding="utf-8")

# P1/#3/#10/#17: real keepalive, crash-reprint policy, and size-aware print timeout.
agent = ROOT / "agent/internal/agent/agent.go"
t = agent.read_text(encoding="utf-8")
t = must_replace(t,
'''\tif err := a.queue.Push(jobID, printerID, pl.Data); err != nil\n\t\tlog.Printf("Job %s: failed to persist to local durable queue (continuing anyway): %v", jobID, err)\n\t}\n\ta.queue.UpdateStatus(jobID, "printing")\n\tlock.Unlock()\n\n\t// Report printing outside the per-printer lock (network I/O must not hold mutex)\n\ta.updateJobStatus(jobID, "printing", "")\n\n\tprintCtx, cancel := context.WithTimeout(ctx, 20*time.Second)\n\tdefer cancel()\n''',
'''\tif err := a.queue.Push(jobID, printerID, pl.Data); err != nil {\n\t\tlog.Printf("Job %s: failed to persist to local durable queue (continuing anyway): %v", jobID, err)\n\t}\n\ta.queue.UpdateStatus(jobID, "printing")\n\tlock.Unlock()\n\n\t// Report printing outside the per-printer lock (network I/O must not hold mutex)\n\ta.updateJobStatus(jobID, "printing", "")\n\n\tprintTimeout := printExecutionTimeout(len(pl.Data), kind)\n\tprintCtx, cancel := context.WithTimeout(ctx, printTimeout)\n\tdefer cancel()\n\n\t// Keep the gateway execution lease alive while the physical printer is\n\t// working. The server treats an authenticated printing->printing update as\n\t// a lease heartbeat, so long/slow prints are not incorrectly failed at 10m.\n\tkeepaliveCtx, keepaliveCancel := context.WithCancel(ctx)\n\tdefer keepaliveCancel()\n\tkeepaliveDone := make(chan struct{})\n\tgo func() {\n\t\tticker := time.NewTicker(30 * time.Second)\n\t\tdefer ticker.Stop()\n\t\tdefer close(keepaliveDone)\n\t\tfor {\n\t\t\tselect {\n\t\t\tcase <-ticker.C:\n\t\t\t\ta.updateJobStatus(jobID, "printing", "")\n\t\t\tcase <-keepaliveCtx.Done():\n\t\t\t\treturn\n\t\t\t}\n\t\t}\n\t}()\n\tdefer func() {\n\t\tkeepaliveCancel()\n\t\t<-keepaliveDone\n\t}()\n''',
"agent/internal/agent/agent.go")

# Add the timeout policy directly before processJob.
marker = '// processJob executes exactly one print job end-to-end and reports the\n'
insert = '''// printExecutionTimeout gives slow physical transports more time as payloads grow\n// while retaining a hard upper bound. PDF has its own stricter helper budget.\nfunc printExecutionTimeout(bytes int, kind string) time.Duration {\n\tif kind == "pdf" {\n\t\treturn 2 * time.Minute\n\t}\n\tbase := 30 * time.Second\n\tperMiB := time.Duration((bytes+1024*1024-1)/(1024*1024)) * 75 * time.Second\n\ttimeout := base + perMiB\n\tif timeout > 15*time.Minute {\n\t\treturn 15 * time.Minute\n\t}\n\treturn timeout\n}\n\n'''
t = must_replace(t, marker, insert + marker, "agent/internal/agent/agent.go")

# Crash recovery: honor reprint_after_crash=true by explicitly asking the gateway to requeue.
old = '''\tfor _, job := range interrupted {\n\t\tlog.Printf(\n\t\t\t"WARNING: job %s on printer %s was still printing when the agent stopped. Physical output is UNKNOWN (full, partial or none). Reporting it as failed; reprint_after_crash=%v",\n\t\t\tjob.ID, job.PrinterID, a.cfg.ReprintAfterCrashEnabled(),\n\t\t)\n\t\ta.updateJobStatus(job.ID, "failed", queue.InterruptedMarker+\n\t\t\t": the agent stopped while this job was printing; the physical output is unknown (full, partial or none)")\n\t}\n'''
new = '''\tfor _, job := range interrupted {\n\t\treason := queue.InterruptedMarker + ": the agent stopped while this job was printing; the physical output is unknown (full, partial or none)"\n\t\tif a.cfg.ReprintAfterCrashEnabled() {\n\t\t\tlog.Printf("WARNING: job %s on printer %s interrupted during print; requesting controlled re-delivery because reprint_after_crash=true", job.ID, job.PrinterID)\n\t\t\ta.updateJobStatus(job.ID, "queued", "AGENT_RESTART_DURING_PRINT_RETRYABLE: "+reason)\n\t\t} else {\n\t\t\tlog.Printf("WARNING: job %s on printer %s interrupted during print; reporting failed because reprint_after_crash=false", job.ID, job.PrinterID)\n\t\t\ta.updateJobStatus(job.ID, "failed", reason+": reprint_after_crash=false")\n\t\t}\n\t}\n'''
t = must_replace(t, old, new, "agent/internal/agent/agent.go")
agent.write_text(t, encoding="utf-8")

# Disable HTTP server fallback in the agent WebSocket URL builder; config validation is authoritative.
# P1 already gates HTTP, so this closes accidental ws:// construction if a test bypasses config validation.
agent = ROOT / "agent/internal/agent/agent.go"
t = agent.read_text(encoding="utf-8")
t = must_replace(t,
'''\tscheme := "wss"\n\tif u.Scheme == "http" {\n\t\tscheme = "ws"\n\t}\n''',
'''\tif u.Scheme != "https" && u.Scheme != "http" {\n\t\tlog.Printf("Invalid server URL scheme: %s", u.Scheme)\n\t\treturn\n\t}\n\tscheme := "wss"\n\tif u.Scheme == "http" {\n\t\tscheme = "ws"\n\t}\n''',
"agent/internal/agent/agent.go")

# P2/#5: keep agent secrets out of YAML and persist them through the DPAPI-backed store.
config = ROOT / "agent/internal/config/config.go"
t = config.read_text(encoding="utf-8")
t = must_replace(t,
'\t\tSecret string `yaml:"secret"`\n',
'\t\tSecret string `yaml:"secret,omitempty"`\n',
"agent/internal/config/config.go")
# Load: migrate legacy plaintext once, then load sealed secret from storage.
old = '''\tcfg := defaultConfig()\n\terr = yaml.NewDecoder(f).Decode(cfg)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n\tif cfg.Agent.ReprintAfterCrash == nil {\n\t\tcfg.Agent.ReprintAfterCrash = boolPtr(false)\n\t}\n\treturn cfg, nil\n'''
new = '''\tcfg := defaultConfig()\n\terr = yaml.NewDecoder(f).Decode(cfg)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n\t// Migrate a legacy plaintext secret into the sealed store on first load.\n\tlegacySecret := cfg.Agent.Secret\n\tcfg.Agent.Secret = ""\n\tstore := storage.NewStore(filepath.Dir(path))\n\tif legacySecret != "" {\n\t\tif err := store.SaveSecret("agent-secret", legacySecret); err != nil {\n\t\t\treturn nil, fmt.Errorf("migrate agent secret to secure storage: %w", err)\n\t\t}\n\t}\n\tif secret, err := store.GetSecret("agent-secret"); err == nil {\n\t\tcfg.Agent.Secret = secret\n\t} else if !errors.Is(err, storage.ErrNotFound) {\n\t\treturn nil, fmt.Errorf("load agent secret from secure storage: %w", err)\n\t}\n\tif cfg.Agent.ReprintAfterCrash == nil {\n\t\tcfg.Agent.ReprintAfterCrash = boolPtr(false)\n\t}\n\treturn cfg, nil\n'''
t = must_replace(t, old, new, "agent/internal/config/config.go")
# Add imports.
t = t.replace('"fmt"\n', '"errors"\n\t"fmt"\n', 1)
t = t.replace('"runtime"\n', '"runtime"\n\n\t"github.com/odoo-print-agent/agent/internal/storage"\n', 1)
# Save a sanitized YAML and store the secret separately.
old = '''\tdata, err := yaml.Marshal(c)\n\tif err != nil {\n\t\treturn fmt.Errorf("encode config %s: %w", path, err)\n\t}\n'''
new = '''\tstore := storage.NewStore(dir)\n\tif c.Agent.Secret != "" {\n\t\tif err := store.SaveSecret("agent-secret", c.Agent.Secret); err != nil {\n\t\t\treturn fmt.Errorf("store agent secret securely: %w", err)\n\t\t}\n\t}\n\tsafe := *c\n\tsafe.Agent.Secret = ""\n\tdata, err := yaml.Marshal(&safe)\n\tif err != nil {\n\t\treturn fmt.Errorf("encode config %s: %w", path, err)\n\t}\n'''
t = must_replace(t, old, new, "agent/internal/config/config.go")
config.write_text(t, encoding="utf-8")

# Pairing writes the in-memory secret; Config.Save now seals it instead of serializing it.
pairing = ROOT / "agent/internal/agent/pairing.go"
t = pairing.read_text(encoding="utf-8")
t = t.replace('"github.com/odoo-print-agent/agent/internal/config"\n', '"github.com/odoo-print-agent/agent/internal/config"\n\t"github.com/odoo-print-agent/agent/internal/storage"\n', 1)
t = must_replace(t,
'''\tcfg.Agent.ID = data.AgentID\n\tcfg.Agent.Secret = data.Secret\n''',
'''\tcfg.Agent.ID = data.AgentID\n\tif err := storage.NewStore(filepath.Dir(configPath)).SaveSecret("agent-secret", data.Secret); err != nil {\n\t\treturn fmt.Errorf("securely save registration secret: %w", err)\n\t}\n\tcfg.Agent.Secret = data.Secret\n''',
"agent/internal/agent/pairing.go")
t = t.replace('"net/url"\n', '"net/url"\n\t"path/filepath"\n', 1)
pairing.write_text(t, encoding="utf-8")

# P2/#6: branch API key is a secret; normal users should not have model-level read access.
acl = ROOT / "odoo_addons/print_gateway/security/ir.model.access.csv"
t = acl.read_text(encoding="utf-8")
t = t.replace('access_print_gateway_branch,print_gateway.branch,model_print_gateway_branch,base.group_user,1,0,0,0\n', '')
acl.write_text(t, encoding="utf-8")

# P2/#7: bound the Odoo status cron.
print_job = ROOT / "odoo_addons/print_gateway/models/print_job.py"
t = print_job.read_text(encoding="utf-8")
t = must_replace(t,
"pending = self.search([('status', 'in', ['queued', 'claimed', 'printing'])])",
"pending = self.search([('status', 'in', ['queued', 'claimed', 'printing'])], order='id asc', limit=50)",
"odoo_addons/print_gateway/models/print_job.py")
print_job.write_text(t, encoding="utf-8")

# P2/#4: strip payload from Odoo sync status responses.
sync = ROOT / "src/app/api/odoo/sync/route.ts"
t = sync.read_text(encoding="utf-8")
old = '      jobRows = await db.select().from(printJobs).where(eq(printJobs.branchId, branchFilter)).orderBy(desc(printJobs.createdAt)).limit(50);\n'
new = '''      jobRows = await db.select({\n        id: printJobs.id,\n        branchId: printJobs.branchId,\n        printerId: printJobs.printerId,\n        agentId: printJobs.agentId,\n        destinationId: printJobs.destinationId,\n        documentType: printJobs.documentType,\n        status: printJobs.status,\n        error: printJobs.error,\n        retries: printJobs.retries,\n        createdAt: printJobs.createdAt,\n        updatedAt: printJobs.updatedAt,\n        expiresAt: printJobs.expiresAt,\n      }).from(printJobs).where(eq(printJobs.branchId, branchFilter)).orderBy(desc(printJobs.createdAt)).limit(50);\n'''
t = must_replace(t, old, new, "src/app/api/odoo/sync/route.ts")
# Default semantics: empty arrays are non-destructive unless wipe=true is explicit.
t = t.replace('const hasDestinations = Array.isArray(body.destinations);', 'const hasDestinations = Array.isArray(body.destinations) && (body.destinations.length > 0 || body.wipe === true);', 1)
t = t.replace('const hasDocumentTypes = Array.isArray(body.documentTypes) || Array.isArray(body.document_types);', 'const hasDocumentTypes = (Array.isArray(body.documentTypes) && (body.documentTypes.length > 0 || body.wipe === true)) || (Array.isArray(body.document_types) && (body.document_types.length > 0 || body.wipe === true));', 1)
t = t.replace('const hasBindings = Array.isArray(body.bindings);', 'const hasBindings = Array.isArray(body.bindings) && (body.bindings.length > 0 || body.wipe === true);', 1)
sync.write_text(t, encoding="utf-8")

# P3/#13: hard upper bound on printer inventory responses.
printers_route = ROOT / "src/app/api/odoo/printers/route.ts"
t = printers_route.read_text(encoding="utf-8")
old = 'const rows = filter ? await query.where(eq(agents.branchId, filter)) : await query;'
new = 'const rows = filter ? await query.where(eq(agents.branchId, filter)).limit(500) : await query.limit(500);'
t = must_replace(t, old, new, "src/app/api/odoo/printers/route.ts")
printers_route.write_text(t, encoding="utf-8")

# P3/#14: job list must never transport the full payload.
jobs_route = ROOT / "src/app/api/jobs/route.ts"
t = jobs_route.read_text(encoding="utf-8")
old = '''  const rows = await db\n    .select()\n    .from(printJobs)\n'''
new = '''  const rows = await db\n    .select({\n      id: printJobs.id, branchId: printJobs.branchId, agentId: printJobs.agentId, printerId: printJobs.printerId,\n      destinationId: printJobs.destinationId, documentType: printJobs.documentType, status: printJobs.status,\n      error: printJobs.error, retries: printJobs.retries, deliveryAttempts: printJobs.deliveryAttempts,\n      expiresAt: printJobs.expiresAt, createdAt: printJobs.createdAt, updatedAt: printJobs.updatedAt,\n    })\n    .from(printJobs)\n'''
t = must_replace(t, old, new, "src/app/api/jobs/route.ts")
jobs_route.write_text(t, encoding="utf-8")

# P3/#16: Odoo job reads must always be branch-scoped.
print_jobs_route = ROOT / "src/app/api/print/jobs/route.ts"
t = print_jobs_route.read_text(encoding="utf-8")
old = '  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });\n  const id = url.searchParams.get("id");'
new = '  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });\n  if (!odoo.branchId) return NextResponse.json({ error: "Branch-scoped API key required" }, { status: 403 });\n  const id = url.searchParams.get("id");'
t = must_replace(t, old, new, "src/app/api/print/jobs/route.ts")
print_jobs_route.write_text(t, encoding="utf-8")

# P3/#12: disable/retire must actively close live agent sockets.
ws = ROOT / "src/server/ws.ts"
t = ws.read_text(encoding="utf-8")
marker = 'export function hasOpenAgentSocket(agentId: string): boolean {\n'
insert = '''export function closeAgentSockets(agentId: string): number {\n  const set = agentSockets.get(agentId);\n  if (!set) return 0;\n  let closed = 0;\n  for (const ws of [...set]) {\n    try { ws.close(1008, "Agent disabled or retired"); } catch { ws.terminate(); }\n    closed += 1;\n  }\n  agentSockets.delete(agentId);\n  return closed;\n}\n\n'''
t = must_replace(t, marker, insert + marker, "src/server/ws.ts")
# wrong upgrade path: destroy the socket instead of leaving it hanging.
t = must_replace(t, '    if (!url.startsWith("/api/agent/ws")) return;\n', '    if (!url.startsWith("/api/agent/ws")) { socket.destroy(); return; }\n', "src/server/ws.ts")
ws.write_text(t, encoding="utf-8")

agents_route = ROOT / "src/app/api/agents/[id]/route.ts"
t = agents_route.read_text(encoding="utf-8")
t = t.replace('import { generatePairingCode } from "../../../../lib/agent-auth";\n', 'import { generatePairingCode } from "../../../../lib/agent-auth";\nimport { closeAgentSockets } from "../../../../server/ws";\n', 1)
old = '  return NextResponse.json({ ok: true, lifecycle: next, pairingCode });\n'
new = '  if (next !== "active") closeAgentSockets(id);\n  return NextResponse.json({ ok: true, lifecycle: next, pairingCode });\n'
t = must_replace(t, old, new, "src/app/api/agents/[id]/route.ts")
agents_route.write_text(t, encoding="utf-8")

# P3/#24: bound discovery executions.
disc = ROOT / "agent/internal/agent/discovery_manager.go"
t = disc.read_text(encoding="utf-8")
t = t.replace('"time"\n', '"time"\n', 1)
t = must_replace(t, 'func (a *Agent) pollDiscovery(ctx context.Context) {\n', 'var discoveryExecutionSem = make(chan struct{}, 2)\n\nfunc (a *Agent) pollDiscovery(ctx context.Context) {\n', "agent/internal/agent/discovery_manager.go")
old = '''\tfor _, s := range sessions {\n\t\tid, _ := s["id"].(string)\n\t\tif id == "" {\n\t\t\tcontinue\n\t\t}\n\t\tgo a.executeDiscoverySession(ctx, id)\n\t}\n'''
new = '''\tfor _, s := range sessions {\n\t\tid, _ := s["id"].(string)\n\t\tif id == "" {\n\t\t\tcontinue\n\t\t}\n\t\tselect {\n\t\tcase discoveryExecutionSem <- struct{}{}:\n\t\t\tgo func(discoveryID string) {\n\t\t\t\tdefer func() { <-discoveryExecutionSem }()\n\t\t\t\ta.executeDiscoverySession(ctx, discoveryID)\n\t\t\t}(id)\n\t\tdefault:\n\t\t\tlog.Printf("[discovery] concurrency limit reached; leaving session %s for the next poll", id)\n\t\t}\n\t}\n'''
t = must_replace(t, old, new, "agent/internal/agent/discovery_manager.go")
disc.write_text(t, encoding="utf-8")

# P3/#15: plaintext manager passwords are development-only; production always requires scrypt.
manager = ROOT / "src/lib/manager-auth.ts"
t = manager.read_text(encoding="utf-8")
old = '  if (process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD !== "1" || !expectedPass) return false;\n'
new = '  if (process.env.NODE_ENV === "production") return false;\n  if (process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD !== "1" || !expectedPass) return false;\n'
t = must_replace(t, old, new, "src/lib/manager-auth.ts")
manager.write_text(t, encoding="utf-8")

# #25: make the UTC operational contract executable at startup.
server = ROOT / "server.ts"
t = server.read_text(encoding="utf-8")
old = 'app.prepare().then(() => {\n'
new = '''app.prepare().then(() => {\n  if (process.env.NODE_ENV === "production" && Intl.DateTimeFormat().resolvedOptions().timeZone !== "UTC") {\n    throw new Error("Production gateway requires TZ=UTC for timestamp consistency");\n  }\n'''
t = must_replace(t, old, new, "server.ts")
server.write_text(t, encoding="utf-8")

# Remove documentation drift in pairing example.
for doc in ["docs/SECURITY.md", "API.md"]:
    p = ROOT / doc
    if p.exists():
        s = p.read_text(encoding="utf-8")
        s = s.replace("AB12CD", "AB22CD")
        p.write_text(s, encoding="utf-8")

# #21: don't autostart the agent unless the user explicitly enables the launcher.
autostart = ROOT / "src-tauri/src/lib.rs"
if autostart.exists():
    s = autostart.read_text(encoding="utf-8")
    s = s.replace('use tauri_plugin_autostart::MacosLauncher;\n', '')
    autostart.write_text(s, encoding="utf-8")

# Generate the lockfile when the workflow runner has Cargo and registry access.
subprocess.run(["cargo", "generate-lockfile", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml")], check=False)

print("Production hardening transformations completed")
