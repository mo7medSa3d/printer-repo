from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CHANGES = 0


def apply(path, fn):
    global CHANGES
    p = ROOT / path
    text = p.read_text(encoding="utf-8")
    new = fn(text)
    if new != text:
        p.write_text(new, encoding="utf-8")
        CHANGES += 1


def replace_if_absent(path, marker, old, new):
    def fn(text):
        if marker in text:
            return text
        if old not in text:
            raise SystemExit(f"missing patch target in {path}: {old[:100]!r}")
        return text.replace(old, new, 1)
    apply(path, fn)


# Gateway claim budget must match the agent executor.
apply("src/app/api/agent/jobs/route.ts", lambda t: t.replace(
    "export const MAX_AGENT_IN_FLIGHT_JOBS = 500;",
    "export const MAX_AGENT_IN_FLIGHT_JOBS = 64;",
    1,
))

# Agent status heartbeat + controlled crash requeue.
def patch_agent_jobs(t):
    marker = 'const RETRYABLE_CRASH_MARKER = "AGENT_RESTART_DURING_PRINT_RETRYABLE:";'
    if marker not in t:
        t = t.replace('const MAX_ERROR_LENGTH = 2000;\n', 'const MAX_ERROR_LENGTH = 2000;\n' + marker + '\n', 1)
    if 'currentStatus === "printing" && requestedStatus === "printing"' not in t:
        needle = '  if (!canTransition(currentStatus, requestedStatus)) return NextResponse.json({ error: `Invalid status transition: ${currentStatus} -> ${requestedStatus}` }, { status: 409 });\n'
        block = '''  // A printing agent may refresh the execution lease without changing state.\n  if (currentStatus === "printing" && requestedStatus === "printing") {\n    const refreshed = await db.update(printJobs)\n      .set({ error: errorMessage, updatedAt: new Date() })\n      .where(and(whereClause, eq(printJobs.status, "printing")))\n      .returning({ status: printJobs.status });\n    if (refreshed.length !== 1) return NextResponse.json({ error: "Concurrent status transition rejected" }, { status: 409 });\n    return NextResponse.json({ success: true, status: "printing", heartbeat: true });\n  }\n\n  const retryAfterCrash = currentStatus === "printing" &&\n    requestedStatus === "queued" &&\n    typeof rawError === "string" &&\n    rawError.startsWith(RETRYABLE_CRASH_MARKER);\n  if (!retryAfterCrash && !canTransition(currentStatus, requestedStatus)) {\n    return NextResponse.json({ error: `Invalid status transition: ${currentStatus} -> ${requestedStatus}` }, { status: 409 });\n  }\n  if (retryAfterCrash && job.retries >= MAX_RETRIES) {\n    return NextResponse.json({ error: "Job retry budget exhausted", status: "failed" }, { status: 409 });\n  }\n'''
        t = t.replace(needle, block, 1)
        t = t.replace('      ...(requestedStatus === "claimed" ? { claimedAt: new Date() } : {}),\n', '      ...(requestedStatus === "claimed" ? { claimedAt: new Date() } : {}),\n      ...(retryAfterCrash ? { claimedAt: null, deliveredAt: null, ackedAt: null, retries: sql`${printJobs.retries} + 1` } : {}),\n', 1)
    return t
apply("src/app/api/agent/jobs/route.ts", patch_agent_jobs)

# Stale printing is configurable and must not race with normal expiry.
apply("src/lib/job-maintenance.ts", lambda t: re.sub(
    r'export const STALE_PRINTING_SECONDS = 10 \* 60;\n',
    '''export const STALE_PRINTING_SECONDS = (() => {\n  const configured = Number(process.env.STALE_PRINTING_SECONDS ?? "1800");\n  if (!Number.isFinite(configured)) return 1800;\n  return Math.min(24 * 60 * 60, Math.max(10 * 60, Math.floor(configured)));\n})();\n''',
    t, count=1
).replace(
    "WHERE status = 'printing'\n      AND updated_at < now() - make_interval(secs => ${STALE_PRINTING_SECONDS})\n",
    "WHERE status = 'printing'\n      AND updated_at < now() - make_interval(secs => ${STALE_PRINTING_SECONDS})\n      AND expires_at > now()\n",
    1,
))

# Long printing: keep the gateway lease alive and use size-aware execution timeout.
def patch_agent(t):
    if 'func printExecutionTimeout(' not in t:
        marker = '// processJob executes exactly one print job end-to-end and reports the\n'
        helper = '''// printExecutionTimeout gives slow transports more time as payloads grow\n// while keeping a hard upper bound.\nfunc printExecutionTimeout(bytes int, kind string) time.Duration {\n\tif kind == "pdf" {\n\t\treturn 2 * time.Minute\n\t}\n\tbase := 30 * time.Second\n\tperMiB := time.Duration((bytes+1024*1024-1)/(1024*1024)) * 75 * time.Second\n\ttimeout := base + perMiB\n\tif timeout > 15*time.Minute {\n\t\treturn 15 * time.Minute\n\t}\n\treturn timeout\n}\n\n'''
        if marker not in t:
            raise SystemExit('agent.go processJob marker not found')
        t = t.replace(marker, helper + marker, 1)
    old = '''\tprintCtx, cancel := context.WithTimeout(ctx, 20*time.Second)\n\tdefer cancel()\n'''
    if old in t and 'keepaliveCtx, keepaliveCancel := context.WithCancel(ctx)' not in t:
        new = '''\tprintTimeout := printExecutionTimeout(len(pl.Data), kind)\n\tprintCtx, cancel := context.WithTimeout(ctx, printTimeout)\n\tdefer cancel()\n\n\tkeepaliveCtx, keepaliveCancel := context.WithCancel(ctx)\n\tdefer keepaliveCancel()\n\tkeepaliveDone := make(chan struct{})\n\tgo func() {\n\t\tticker := time.NewTicker(30 * time.Second)\n\t\tdefer ticker.Stop()\n\t\tdefer close(keepaliveDone)\n\t\tfor {\n\t\t\tselect {\n\t\t\tcase <-ticker.C:\n\t\t\t\ta.updateJobStatus(jobID, "printing", "")\n\t\t\tcase <-keepaliveCtx.Done():\n\t\t\t\treturn\n\t\t\t}\n\t\t}\n\t}()\n\tdefer func() {\n\t\tkeepaliveCancel()\n\t\t<-keepaliveDone\n\t}()\n'''
        t = t.replace(old, new, 1)
    # Honor reprint_after_crash in recovery when the main implementation is still terminal-only.
    old_recovery = '''\tfor _, job := range interrupted {\n\t\tlog.Printf(\n\t\t\t"WARNING: job %s on printer %s was still printing when the agent stopped. Physical output is UNKNOWN (full, partial or none). Reporting it as failed; reprint_after_crash=%v",\n\t\t\tjob.ID, job.PrinterID, a.cfg.ReprintAfterCrashEnabled(),\n\t\t)\n\t\ta.updateJobStatus(job.ID, "failed", queue.InterruptedMarker+\n\t\t\t": the agent stopped while this job was printing; the physical output is unknown (full, partial or none)")\n\t}\n'''
    if old_recovery in t:
        new_recovery = '''\tfor _, job := range interrupted {\n\t\treason := queue.InterruptedMarker + ": the agent stopped while this job was printing; the physical output is unknown (full, partial or none)"\n\t\tif a.cfg.ReprintAfterCrashEnabled() {\n\t\t\tlog.Printf("WARNING: job %s interrupted during print; requesting controlled re-delivery because reprint_after_crash=true", job.ID)\n\t\t\ta.updateJobStatus(job.ID, "queued", "AGENT_RESTART_DURING_PRINT_RETRYABLE: "+reason)\n\t\t} else {\n\t\t\tlog.Printf("WARNING: job %s interrupted during print; reporting failed because reprint_after_crash=false", job.ID)\n\t\t\ta.updateJobStatus(job.ID, "failed", reason+": reprint_after_crash=false")\n\t\t}\n\t}\n'''
        t = t.replace(old_recovery, new_recovery, 1)
    return t
apply("agent/internal/agent/agent.go", patch_agent)

# Bound discovery execution concurrency.
def patch_discovery(t):
    if 'var discoveryExecutionSem = make(chan struct{}, 2)' not in t:
        t = t.replace('func (a *Agent) pollDiscovery(ctx context.Context) {\n', 'var discoveryExecutionSem = make(chan struct{}, 2)\n\nfunc (a *Agent) pollDiscovery(ctx context.Context) {\n', 1)
    old = '''\tfor _, s := range sessions {\n\t\tid, _ := s["id"].(string)\n\t\tif id == "" {\n\t\t\tcontinue\n\t\t}\n\t\tgo a.executeDiscoverySession(ctx, id)\n\t}\n'''
    if old in t:
        new = '''\tfor _, s := range sessions {\n\t\tid, _ := s["id"].(string)\n\t\tif id == "" {\n\t\t\tcontinue\n\t\t}\n\t\tselect {\n\t\tcase discoveryExecutionSem <- struct{}{}:\n\t\t\tgo func(discoveryID string) {\n\t\t\t\tdefer func() { <-discoveryExecutionSem }()\n\t\t\t\ta.executeDiscoverySession(ctx, discoveryID)\n\t\t\t}(id)\n\t\tdefault:\n\t\t\tlog.Printf("[discovery] concurrency limit reached; leaving session %s for the next poll", id)\n\t\t}\n\t}\n'''
        t = t.replace(old, new, 1)
    return t
apply("agent/internal/agent/discovery_manager.go", patch_discovery)

# Secret persistence: idempotent check that current config is sanitized.
def patch_config(t):
    if '"github.com/odoo-print-agent/agent/internal/storage"' not in t:
        t = t.replace('"strings"\n\n', '"strings"\n\n\t"github.com/odoo-print-agent/agent/internal/storage"\n', 1)
        t = t.replace('"fmt"\n', '"errors"\n\t"fmt"\n', 1)
    if 'yaml:"secret,omitempty"' not in t:
        t = t.replace('Secret string `yaml:"secret"`', 'Secret string `yaml:"secret,omitempty"`', 1)
    if 'store := storage.NewStore(dir)' not in t:
        old = '''\tdata, err := yaml.Marshal(c)\n\tif err != nil {\n\t\treturn fmt.Errorf("encode config %s: %w", path, err)\n\t}\n'''
        new = '''\tstore := storage.NewStore(dir)\n\tif c.Agent.Secret != "" {\n\t\tif err := store.SaveSecret("agent-secret", c.Agent.Secret); err != nil {\n\t\t\treturn fmt.Errorf("store agent secret securely: %w", err)\n\t\t}\n\t}\n\tsafe := *c\n\tsafe.Agent.Secret = ""\n\tdata, err := yaml.Marshal(&safe)\n\tif err != nil {\n\t\treturn fmt.Errorf("encode config %s: %w", path, err)\n\t}\n'''
        if old not in t:
            raise SystemExit('config.go Save marker not found')
        t = t.replace(old, new, 1)
    if 'store := storage.NewStore(filepath.Dir(path))' not in t:
        old = '''\tcfg := defaultConfig()\n\terr = yaml.NewDecoder(f).Decode(cfg)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n\tif cfg.Agent.ReprintAfterCrash == nil {\n\t\tcfg.Agent.ReprintAfterCrash = boolPtr(false)\n\t}\n\treturn cfg, nil\n'''
        new = '''\tcfg := defaultConfig()\n\terr = yaml.NewDecoder(f).Decode(cfg)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n\tlegacySecret := cfg.Agent.Secret\n\tcfg.Agent.Secret = ""\n\tstore := storage.NewStore(filepath.Dir(path))\n\tif legacySecret != "" {\n\t\tif err := store.SaveSecret("agent-secret", legacySecret); err != nil {\n\t\t\treturn nil, fmt.Errorf("migrate agent secret to secure storage: %w", err)\n\t\t}\n\t}\n\tif secret, err := store.GetSecret("agent-secret"); err == nil {\n\t\tcfg.Agent.Secret = secret\n\t} else if !errors.Is(err, storage.ErrNotFound) {\n\t\treturn nil, fmt.Errorf("load agent secret from secure storage: %w", err)\n\t}\n\tif cfg.Agent.ReprintAfterCrash == nil {\n\t\tcfg.Agent.ReprintAfterCrash = boolPtr(false)\n\t}\n\treturn cfg, nil\n'''
        if old not in t:
            raise SystemExit('config.go Load marker not found')
        t = t.replace(old, new, 1)
    return t
apply("agent/internal/config/config.go", patch_config)

# Odoo ACL: normal users must not read the branch secret.
apply("odoo_addons/print_gateway/security/ir.model.access.csv", lambda t: t.replace(
    'access_print_gateway_branch,print_gateway.branch,model_print_gateway_branch,base.group_user,1,0,0,0\n', '', 1
))

# Odoo status cron bound.
apply("odoo_addons/print_gateway/models/print_job.py", lambda t: t.replace(
    "pending = self.search([('status', 'in', ['queued', 'claimed', 'printing'])])",
    "pending = self.search([('status', 'in', ['queued', 'claimed', 'printing'])], order='id asc', limit=50)", 1
))

# Remove payloads from Odoo sync status response.
def patch_sync(t):
    old = '      jobRows = await db.select().from(printJobs).where(eq(printJobs.branchId, branchFilter)).orderBy(desc(printJobs.createdAt)).limit(50);\n'
    if old in t:
        new = '''      jobRows = await db.select({\n        id: printJobs.id, branchId: printJobs.branchId, printerId: printJobs.printerId, agentId: printJobs.agentId,\n        destinationId: printJobs.destinationId, documentType: printJobs.documentType, status: printJobs.status,\n        error: printJobs.error, retries: printJobs.retries, createdAt: printJobs.createdAt, updatedAt: printJobs.updatedAt,\n        expiresAt: printJobs.expiresAt,\n      }).from(printJobs).where(eq(printJobs.branchId, branchFilter)).orderBy(desc(printJobs.createdAt)).limit(50);\n'''
        t = t.replace(old, new, 1)
    # Empty arrays are non-destructive unless explicitly requested as a wipe.
    t = t.replace('const hasDestinations = Array.isArray(body.destinations);', 'const hasDestinations = Array.isArray(body.destinations) && (body.destinations.length > 0 || body.wipe === true);', 1)
    t = t.replace('const hasDocumentTypes = Array.isArray(body.documentTypes) || Array.isArray(body.document_types);', 'const hasDocumentTypes = (Array.isArray(body.documentTypes) && (body.documentTypes.length > 0 || body.wipe === true)) || (Array.isArray(body.document_types) && (body.document_types.length > 0 || body.wipe === true));', 1)
    t = t.replace('const hasBindings = Array.isArray(body.bindings);', 'const hasBindings = Array.isArray(body.bindings) && (body.bindings.length > 0 || body.wipe === true);', 1)
    return t
apply("src/app/api/odoo/sync/route.ts", patch_sync)

# Bounded printer inventory.
apply("src/app/api/odoo/printers/route.ts", lambda t: t.replace(
    'const rows = filter ? await query.where(eq(agents.branchId, filter)) : await query;',
    'const rows = filter ? await query.where(eq(agents.branchId, filter)).limit(500) : await query.limit(500);', 1
))

# Job lists must not carry payload.
def patch_jobs(t):
    if '.select({\n      id: printJobs.id,' not in t:
        old = '''  const rows = await db\n    .select()\n    .from(printJobs)\n'''
        new = '''  const rows = await db\n    .select({\n      id: printJobs.id, branchId: printJobs.branchId, agentId: printJobs.agentId, printerId: printJobs.printerId,\n      destinationId: printJobs.destinationId, documentType: printJobs.documentType, status: printJobs.status,\n      error: printJobs.error, retries: printJobs.retries, deliveryAttempts: printJobs.deliveryAttempts,\n      expiresAt: printJobs.expiresAt, createdAt: printJobs.createdAt, updatedAt: printJobs.updatedAt,\n      claimedAt: printJobs.claimedAt, deliveredAt: printJobs.deliveredAt, ackedAt: printJobs.ackedAt,\n    })\n    .from(printJobs)\n'''
        if old in t:
            t = t.replace(old, new, 1)
    return t
apply("src/app/api/jobs/route.ts", patch_jobs)

# Global Odoo keys cannot read arbitrary jobs.
def patch_print_jobs(t):
    needle = '  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });\n  const id = url.searchParams.get("id");'
    if needle in t:
        t = t.replace(needle, '  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });\n  if (!odoo.branchId) return NextResponse.json({ error: "Branch-scoped API key required" }, { status: 403 });\n  const id = url.searchParams.get("id");', 1)
    return t
apply("src/app/api/print/jobs/route.ts", patch_print_jobs)

# Disable/retire an agent: close active sockets.
# The direct Tauri and WS code already has the helper; only wire it if missing.
def patch_agent_route(t):
    if 'import { closeAgentSockets }' not in t:
        t = t.replace('import { generatePairingCode } from "../../../../lib/agent-auth";\n', 'import { generatePairingCode } from "../../../../lib/agent-auth";\nimport { closeAgentSockets } from "../../../../server/ws";\n', 1)
    if 'if (next !== "active") closeAgentSockets(id);' not in t:
        t = t.replace('  return NextResponse.json({ ok: true, lifecycle: next, pairingCode });\n', '  if (next !== "active") closeAgentSockets(id);\n  return NextResponse.json({ ok: true, lifecycle: next, pairingCode });\n', 1)
    return t
apply("src/app/api/agents/[id]/route.ts", patch_agent_route)

# Production must use hashed manager password only.
apply("src/lib/manager-auth.ts", lambda t: t.replace(
    '  if (process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD !== "1" || !expectedPass) return false;\n',
    '  if (process.env.NODE_ENV === "production") return false;\n  if (process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD !== "1" || !expectedPass) return false;\n', 1
))

# Enforce UTC at gateway startup.
apply("server.ts", lambda t: t if 'Production gateway requires TZ=UTC' in t else t.replace(
    'app.prepare().then(() => {\n',
    'app.prepare().then(() => {\n  if (process.env.NODE_ENV === "production" && Intl.DateTimeFormat().resolvedOptions().timeZone !== "UTC") {\n    throw new Error("Production gateway requires TZ=UTC for timestamp consistency");\n  }\n', 1
))

# Remove stale pairing example and option docs.
for doc in ["docs/SECURITY.md", "API.md"]:
    p = ROOT / doc
    if p.exists():
        s = p.read_text(encoding="utf-8").replace("AB12CD", "AB22CD")
        p.write_text(s, encoding="utf-8")

# Generate a committed Rust lockfile on the CI runner.
lock = ROOT / "src-tauri/Cargo.lock"
if not lock.exists():
    subprocess.run(["cargo", "generate-lockfile", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml")], check=True)

print(f"Hardening patch applied; changed files: {CHANGES}")
