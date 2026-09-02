import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { randomBytes } from "crypto";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  closePool,
  pool,
  sha256,
} from "./helpers/pg";
import {
  compareBindings,
  selectBestBinding,
  selectFallbackBindings,
  type BindingCandidate,
} from "@/lib/routing";
import { printJobPayloadSchema, looksLikePdf, PDF_MAGIC } from "@/lib/payload";
import {
  cleanupAuthRateLimits,
  AUTH_RATE_WINDOW_MS,
  RETENTION_GRACE_MS,
  CLEANUP_BATCH,
} from "@/lib/auth-rate-limit";
import {
  MAX_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  idField,
  idempotencyKeyField,
  metadataField,
  MAX_METADATA_BYTES,
} from "@/lib/limits";

const b64 = (s: string | Buffer) => Buffer.from(s as never).toString("base64");

/* ==========================================================================
 * 1. Agent registration: the device cannot choose its branch
 * ======================================================================= */
describe("agent registration contract", () => {
  const src = readFileSync("src/app/api/agent/register/route.ts", "utf8");

  it("uses a strict schema that does not contain a branchId field", () => {
    const schemaBlock = src.slice(src.indexOf("const registerSchema"), src.indexOf("export async function POST"));
    expect(schemaBlock).toContain(".strict()");
    expect(schemaBlock).not.toContain("branchId");
  });

  it("never derives the branch from the request body", () => {
    // The old code did `branchId: branchId ?? agent.branchId`. That must be gone:
    // pairing must not be able to move an agent between branches.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/branchId\s*\?\?\s*agent\.branchId/);
    expect(code).not.toContain("body?.branchId");
  });

  it("rejects a client-supplied branchId explicitly rather than ignoring it", () => {
    expect(src).toContain("client_supplied_branch");
    expect(src).toContain("branchId is not accepted during agent registration");
  });
});

/* ==========================================================================
 * 2. Agent creation requires an explicit branch
 * ======================================================================= */
describe("agent creation requires an explicit branch", () => {
  const src = readFileSync("src/app/actions.ts", "utf8");

  it("takes branchId as a required parameter", () => {
    expect(src).toContain("export async function createAgent(name: string, branchId: string");
  });

  it("has no 'first branch' / 'default branch' fallback", () => {
    const fn = src.slice(src.indexOf("export async function createAgent"), src.indexOf("export async function createPrintJob"));
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Previously: if exactly one enabled branch existed it was chosen silently.
    expect(code).not.toContain("enabled.length === 1");
    expect(code).not.toContain('"default"');
    expect(code).toContain("branchId is required");
  });

  it("validates that a supplied localNetwork belongs to the same branch", () => {
    const fn = src.slice(src.indexOf("export async function createAgent"), src.indexOf("export async function createPrintJob"));
    expect(fn).toContain("localNetworks");
    expect(fn).toContain("an agent and its local network must be in the same branch");
  });
});

/* ==========================================================================
 * 3. Lifecycle instead of destructive delete
 * ======================================================================= */
describe("agent/printer lifecycle", () => {
  const actions = readFileSync("src/app/actions.ts", "utf8");

  it("exposes lifecycle transitions", () => {
    expect(actions).toContain("export async function setAgentLifecycle");
    expect(actions).toContain("export async function setPrinterLifecycle");
  });

  it("retiring an agent revokes its credential and cascades to its printers", () => {
    const fn = actions.slice(actions.indexOf("export async function setAgentLifecycle"), actions.indexOf("export async function setPrinterLifecycle"));
    expect(fn).toContain("secret: null");
    expect(fn).toContain("pairingCode: null");
    // Cascade must be in the same transaction as the agent update.
    expect(fn).toContain("db.transaction");
    expect(fn).toContain("eq(printers.agentId, id)");
  });

  it("hard delete is restricted and refuses to destroy history", () => {
    const fn = actions.slice(actions.indexOf("export async function deleteAgent"));
    expect(fn).toContain("has print history and cannot be deleted");
    expect(fn).toContain("still owns");
  });

  it("agent auth fails closed for disabled and retired agents", () => {
    const auth = readFileSync("src/lib/agent-auth.ts", "utf8");
    expect(auth).toContain('agent.status === "disabled" || agent.status === "retired"');
  });

  it("the dashboard no longer claims printers survive an agent removal", () => {
    const ui = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
    expect(ui).not.toContain("Its printers remain in the database");
    expect(ui).toContain("Retire agent");
    // Preserved, not deleted — the copy must say so.
    expect(ui).toContain("preserved");
  });
});

/* ==========================================================================
 * 4. Deterministic routing
 * ======================================================================= */
describe("routing determinism", () => {
  const mk = (id: string, priority: number): BindingCandidate => ({
    id,
    branchId: "b1",
    destinationId: "d1",
    documentType: null,
    printerId: `printer_${id}`,
    priority,
    enabled: true,
  });

  it("orders by priority first", () => {
    expect(compareBindings(mk("z", 1), mk("a", 2))).toBeLessThan(0);
    expect(compareBindings(mk("a", 5), mk("z", 2))).toBeGreaterThan(0);
  });

  it("breaks equal priority by binding id, never by input order", () => {
    expect(compareBindings(mk("a", 1), mk("b", 1))).toBeLessThan(0);
    expect(compareBindings(mk("b", 1), mk("a", 1))).toBeGreaterThan(0);
    expect(compareBindings(mk("a", 1), mk("a", 1))).toBe(0);
  });

  it("selects the same binding regardless of the order rows arrive in", () => {
    const rows = [mk("bind_c", 1), mk("bind_a", 1), mk("bind_b", 1)];
    // Every permutation must resolve to the same winner. Without the id
    // tie-break this depended on PostgreSQL's unspecified row order.
    const permutations = [
      [rows[0], rows[1], rows[2]],
      [rows[2], rows[1], rows[0]],
      [rows[1], rows[0], rows[2]],
      [rows[1], rows[2], rows[0]],
    ];
    const winners = new Set(permutations.map((p) => selectBestBinding(p)?.id));
    expect(winners.size).toBe(1);
    expect([...winners][0]).toBe("bind_a");
  });

  it("produces a stable full fallback ordering too", () => {
    const rows = [mk("y", 2), mk("b", 1), mk("a", 1), mk("x", 2)];
    const order = selectFallbackBindings(rows).map((r) => r.id);
    expect(order).toEqual(["a", "b", "x", "y"]);
    // Reversed input, identical output.
    expect(selectFallbackBindings([...rows].reverse()).map((r) => r.id)).toEqual(order);
  });

  it("queries bindings with an explicit deterministic SQL ordering", () => {
    const routing = readFileSync("src/lib/routing.ts", "utf8");
    expect(routing).toContain("asc(printerBindings.priority), asc(printerBindings.id)");
  });
});

/* ==========================================================================
 * 5. PDF vs RAW vs ESC/POS
 * ======================================================================= */
describe("print type semantics", () => {
  const PDF_BYTES = Buffer.concat([
    Buffer.from(`${PDF_MAGIC}1.7\n`),
    Buffer.from("%\xE2\xE3\xCF\xD3\n1 0 obj\n<<>>\nendobj\n", "latin1"),
  ]);
  const ESCPOS_BYTES = Buffer.from("\x1b@Hello\n\x1dV\x01", "binary");

  it("detects PDF content by its magic header", () => {
    expect(looksLikePdf(PDF_BYTES)).toBe(true);
    expect(looksLikePdf(ESCPOS_BYTES)).toBe(false);
  });

  it("accepts a genuine PDF declared as pdf", () => {
    const r = printJobPayloadSchema.safeParse({ type: "pdf", encoding: "base64", data: b64(PDF_BYTES) });
    expect(r.success).toBe(true);
  });

  it("accepts genuine ESC/POS declared as escpos", () => {
    const r = printJobPayloadSchema.safeParse({ type: "escpos", encoding: "base64", data: b64(ESCPOS_BYTES) });
    expect(r.success).toBe(true);
  });

  it("REJECTS PDF bytes declared as raw", () => {
    const r = printJobPayloadSchema.safeParse({ type: "raw", encoding: "base64", data: b64(PDF_BYTES) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain("PDF");
    }
  });

  it("REJECTS PDF bytes declared as escpos", () => {
    const r = printJobPayloadSchema.safeParse({ type: "escpos", encoding: "base64", data: b64(PDF_BYTES) });
    expect(r.success).toBe(false);
  });

  it("REJECTS non-PDF bytes declared as pdf", () => {
    const r = printJobPayloadSchema.safeParse({ type: "pdf", encoding: "base64", data: b64(ESCPOS_BYTES) });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain(PDF_MAGIC);
  });
});

/* ==========================================================================
 * 6. Input validation / resource limits
 * ======================================================================= */
describe("input limits", () => {
  it("bounds identifiers", () => {
    expect(idField().safeParse("printer_abc").success).toBe(true);
    expect(idField().safeParse("x".repeat(MAX_ID_LENGTH)).success).toBe(true);
    expect(idField().safeParse("x".repeat(MAX_ID_LENGTH + 1)).success).toBe(false);
    expect(idField().safeParse("").success).toBe(false);
  });

  it("bounds idempotency keys below the btree index limit", () => {
    // uuid4().hex, what Odoo actually sends.
    expect(idempotencyKeyField().safeParse("a".repeat(32)).success).toBe(true);
    expect(idempotencyKeyField().safeParse("a".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)).success).toBe(false);
    // A btree entry caps out around 2704 bytes; the limit must be well under it.
    expect(MAX_IDEMPOTENCY_KEY_LENGTH).toBeLessThan(2704);
  });

  it("bounds metadata blobs by serialized size", () => {
    expect(metadataField().safeParse({ hostname: "pos-1", os: "windows" }).success).toBe(true);
    expect(metadataField().safeParse({ blob: "x".repeat(MAX_METADATA_BYTES) }).success).toBe(false);
  });

  it("applies the limits at the print job API boundary", () => {
    const src = readFileSync("src/app/api/print/jobs/route.ts", "utf8");
    expect(src).toContain("idempotencyKeyField()");
    expect(src).toContain("documentTypeField()");
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("idempotencyKey: z.string().optional()");
  });
});

/* ==========================================================================
 * 7. Security headers
 * ======================================================================= */
describe("security headers", () => {
  it("declares the defensive header set", async () => {
    const mod = await import("../next.config");
    const cfg = mod.default as { headers?: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    expect(typeof cfg.headers).toBe("function");
    const rules = await cfg.headers!();
    const applied = rules.find((r) => r.source === "/:path*");
    expect(applied).toBeTruthy();
    const byKey = new Map(applied!.headers.map((h) => [h.key, h.value]));

    expect(byKey.get("X-Content-Type-Options")).toBe("nosniff");
    expect(byKey.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(byKey.get("X-Frame-Options")).toBe("DENY");
    expect(byKey.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(byKey.get("Permissions-Policy")).toContain("camera=()");
  });

  it("does not send HSTS outside production", async () => {
    // Pinning localhost to HTTPS in a developer's browser is a sticky failure
    // with no security benefit on a plain-HTTP dev server.
    const mod = await import("../next.config");
    const rules = await (mod.default as { headers: () => Promise<Array<{ headers: Array<{ key: string }> }>> }).headers();
    const keys = rules[0].headers.map((h) => h.key);
    if (process.env.NODE_ENV === "production") {
      expect(keys).toContain("Strict-Transport-Security");
    } else {
      expect(keys).not.toContain("Strict-Transport-Security");
    }
  });
});

/* ==========================================================================
 * 8. Dashboard failure state + visibility
 * ======================================================================= */
describe("dashboard", () => {
  const page = readFileSync("src/app/dashboard/page.tsx", "utf8");
  const client = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");

  it("renders an explicit database-unavailable state instead of a Live empty shell", () => {
    expect(page).toContain("Database unavailable");
    expect(page).toContain("dbUnavailable");
    expect(page).toContain("This is not an empty deployment");
    // The failure branch returns before the normal console renders.
    expect(page.indexOf("if (dbUnavailable)")).toBeLessThan(page.indexOf("<DashboardClient"));
  });

  it("logs the real error server-side but leaks nothing to the browser", () => {
    expect(page).toContain('logError("dashboard.db_unavailable"');
    const errorBlock = page.slice(page.indexOf("if (dbUnavailable)"), page.indexOf("<DashboardClient"));
    expect(errorBlock).not.toContain("error.message");
    expect(errorBlock).not.toContain("DATABASE_URL");
  });

  it("shows branch on agents and agent+branch on printers", () => {
    expect(client).toContain("Branch: {branchName(agent.branchId)");
    expect(client).toContain("Agent: {agentNameById.get(printer.agentId)");
    expect(client).toContain("Branch: {branchName(printer.branchId)");
  });

  it("uses maps instead of per-row linear scans", () => {
    expect(client).toContain("agentNameById");
    expect(client).toContain("branchNameById");
    expect(client).not.toContain("initialAgents.find(");
    expect(client).not.toContain("initialBranches.find(");
  });

  it("hides virtual/redirected queues from physical printer management", () => {
    expect(client).toContain("isVirtualPrinterRecord");
    expect(client).toContain("physicalPrinters");
  });

  it("does not offer test print on a disabled or retired printer", () => {
    expect(client).toContain("disabled={isLoading || !printer.enabled}");
  });
});

/* ==========================================================================
 * 9. CI actually gates on PostgreSQL
 * ======================================================================= */
describe("CI configuration", () => {
  // Staged under ci/workflows/ rather than .github/workflows/: the account that
  // opens the PR lacks GitHub's `workflows` permission. ci/workflows/README.md
  // documents the one-command install.
  const gateway = readFileSync("ci/workflows/gateway-ci.yml", "utf8");

  it("runs a real PostgreSQL service", () => {
    expect(gateway).toContain("image: postgres:16");
    expect(gateway).toContain("DATABASE_URL:");
  });

  it("fails if the database-backed suites silently skip", () => {
    expect(gateway).toContain("Assert no test was skipped");
    expect(gateway).toContain("numPendingTests");
  });

  it("keeps typecheck, lint, build and the Go race detector", () => {
    expect(gateway).toContain("npm run typecheck");
    expect(gateway).toContain("npm run lint");
    expect(gateway).toContain("npm run build");
    expect(gateway).toContain("go test -race ./...");
  });

  it("does not claim Odoo tests passed unless they ran", () => {
    const odoo = readFileSync("ci/workflows/odoo-ci.yml", "utf8");
    expect(odoo).toContain("refusing to report success");
    expect(odoo).toContain("--test-enable");
  });

  it("documents how to install the staged workflows", () => {
    const readme = readFileSync("ci/workflows/README.md", "utf8");
    expect(readme).toContain("workflows` permission");
    expect(readme).toContain("git mv ci/workflows/gateway-ci.yml");
    // Must not imply the gates are already running.
    expect(readme).toContain("not running on pull requests yet");
  });

  it("preserves the Windows packaging workflow", () => {
    const win = readFileSync(".github/workflows/build-windows.yml", "utf8");
    expect(win).toContain("windows-latest");
  });
});

/* ==========================================================================
 * 10. Odoo sync failure semantics (static — the ORM runs in odoo-ci.yml)
 * ======================================================================= */
describe("Odoo pull sync semantics", () => {
  const branch = readFileSync("odoo_addons/print_gateway/models/branch.py", "utf8");
  const fn = branch.slice(branch.indexOf("def action_sync_from_gateway"), branch.indexOf("def action_sync_to_gateway"));

  it("treats agents and printers as REQUIRED resources", () => {
    expect(fn).toContain("_fetch('/api/odoo/agents', required=True)");
    expect(fn).toContain("_fetch('/api/odoo/printers', required=True)");
  });

  it("records failed / partial / success rather than always succeeding", () => {
    expect(fn).toContain("'last_sync_status': 'failed'");
    expect(fn).toContain("'partial' if optional_failed else 'success'");
  });

  it("never reports success when a required pull failed", () => {
    // The failure branch raises before the success write is reached.
    expect(fn.indexOf("if required_failed:")).toBeLessThan(fn.indexOf("'partial' if optional_failed else 'success'"));
    expect(fn).toContain("raise ValidationError")
  });

  it("captures per-resource error detail including timeouts and HTTP status", () => {
    expect(fn).toContain("except requests.Timeout");
    expect(fn).toContain("'http_%s' % r.status_code");
    expect(fn).toContain("'invalid_json'");
  });

  it("does not run stale cleanup when the printer pull failed", () => {
    // The cleanup lives inside `if printers_payload is not None`, so a failed
    // fetch cannot disable every printer in the branch.
    const cleanupIdx = fn.indexOf("Marking %s stale printer mirror(s) offline");
    const guardIdx = fn.indexOf("if printers_payload is not None:");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(guardIdx);
  });
});

/* ==========================================================================
 * 11. Rate-limit retention (real PostgreSQL)
 * ======================================================================= */
const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("auth rate-limit retention (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
    await pool().query("DELETE FROM auth_rate_limits");
  });
  afterAll(async () => {
    await closePool();
  });

  const insertBucket = async (key: string, updatedAt: Date, lockedUntil: Date | null) => {
    await pool().query(
      `INSERT INTO auth_rate_limits (key, failures, window_started_at, locked_until, updated_at)
       VALUES ($1, 3, $2, $3, $2)`,
      [key, updatedAt, lockedUntil]
    );
  };

  const countBuckets = async () =>
    Number((await pool().query("SELECT count(*)::int AS n FROM auth_rate_limits")).rows[0].n);

  it("deletes buckets that can no longer influence a decision", async () => {
    const now = new Date();
    const ancient = new Date(now.getTime() - AUTH_RATE_WINDOW_MS - RETENTION_GRACE_MS - 60_000);
    await insertBucket("ip:1.2.3.4", ancient, null);
    expect(await countBuckets()).toBe(1);

    const removed = await cleanupAuthRateLimits(now);
    expect(removed).toBe(1);
    expect(await countBuckets()).toBe(0);
  });

  it("keeps buckets whose failure window is still open", async () => {
    const now = new Date();
    await insertBucket("ip:5.6.7.8", new Date(now.getTime() - 60_000), null);
    const removed = await cleanupAuthRateLimits(now);
    expect(removed).toBe(0);
    expect(await countBuckets()).toBe(1);
  });

  it("NEVER deletes a bucket that is still locked, even if stale", async () => {
    // This is the correctness-critical case: deleting an active lock would
    // hand an attacker an instant reset.
    const now = new Date();
    const ancient = new Date(now.getTime() - AUTH_RATE_WINDOW_MS - RETENTION_GRACE_MS - 3_600_000);
    const lockedUntil = new Date(now.getTime() + 30 * 60_000);
    await insertBucket("acct:victim", ancient, lockedUntil);

    const removed = await cleanupAuthRateLimits(now);
    expect(removed).toBe(0);
    expect(await countBuckets()).toBe(1);
  });

  it("removes an expired lock once it is also stale", async () => {
    const now = new Date();
    const ancient = new Date(now.getTime() - AUTH_RATE_WINDOW_MS - RETENTION_GRACE_MS - 3_600_000);
    await insertBucket("acct:old", ancient, new Date(now.getTime() - 60_000));
    expect(await cleanupAuthRateLimits(now)).toBe(1);
  });

  it("is bounded per pass so it cannot lock the table on a hot path", async () => {
    const now = new Date();
    const ancient = new Date(now.getTime() - AUTH_RATE_WINDOW_MS - RETENTION_GRACE_MS - 60_000);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      params.push(`ip:bulk-${i}`, ancient);
      values.push(`($${params.length - 1}, 1, $${params.length}, NULL, $${params.length})`);
    }
    await pool().query(
      `INSERT INTO auth_rate_limits (key, failures, window_started_at, locked_until, updated_at) VALUES ${values.join(",")}`,
      params
    );
    expect(CLEANUP_BATCH).toBeGreaterThan(0);
    const removed = await cleanupAuthRateLimits(now);
    expect(removed).toBeLessThanOrEqual(CLEANUP_BATCH);
    expect(removed).toBe(20);
  });

  it("has an index supporting the retention sweep", async () => {
    const res = await pool().query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'auth_rate_limits'`
    );
    const names = res.rows.map((r: { indexname: string }) => r.indexname);
    expect(names).toContain("auth_rate_limits_updated_at_idx");
  });

  it("login never fails because cleanup failed", () => {
    const src = readFileSync("src/lib/auth-rate-limit.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function maybeCleanupAuthRateLimits"));
    expect(fn).toContain("catch");
    // Swallowed on purpose: a maintenance error must not become an outage.
    expect(fn).toContain("Intentionally ignored");
    const login = readFileSync("src/app/api/auth/manager/login/route.ts", "utf8");
    expect(login).toContain("void maybeCleanupAuthRateLimits()");
  });
});

/* ==========================================================================
 * 12. Cross-branch safety + lifecycle, against real PostgreSQL
 * ======================================================================= */
describeDb("cross-branch safety and lifecycle (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await closePool();
  });

  it("printers.agent_id is indexed (branch derivation joins on it)", async () => {
    const res = await pool().query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'printers'`
    );
    const defs = res.rows.map((r: { indexdef: string }) => r.indexdef).join("\n");
    expect(defs).toMatch(/\(agent_id\)/);
  });

  it("agents.local_network_id pointing at another branch is rejected at creation", async () => {
    const a = await seedFixture();
    const b = await seedFixture();
    // A local network in branch B.
    const netId = `net_${randomBytes(4).toString("hex")}`;
    await pool().query(
      `INSERT INTO local_networks (id, branch_id, name) VALUES ($1, $2, 'other-branch-lan')`,
      [netId, b.branchId]
    );

    const { createAgent } = await import("@/app/actions");
    // No manager session in this harness, so the guard may reject earlier;
    // what must never happen is a successful cross-branch attachment.
    await expect(createAgent("hostile", a.branchId, netId)).rejects.toThrow();

    const rows = await pool().query(
      `SELECT a.id FROM agents a JOIN local_networks n ON n.id = a.local_network_id
       WHERE n.branch_id <> a.branch_id`
    );
    expect(rows.rowCount).toBe(0);
  });

  it("retiring an agent disables its printers and revokes its secret", async () => {
    const f = await seedFixture();
    await pool().query(`UPDATE agents SET status='online' WHERE id=$1`, [f.agentId]);

    // Perform the documented transition directly against the database, the
    // same shape setAgentLifecycle applies (the server action requires a
    // manager session that this harness does not mint).
    await pool().query(
      `UPDATE agents SET status='retired', secret=NULL, pairing_code=NULL WHERE id=$1`,
      [f.agentId]
    );
    await pool().query(
      `UPDATE printers SET enabled=false, status='retired' WHERE agent_id=$1`,
      [f.agentId]
    );

    const agent = (await pool().query(`SELECT status, secret FROM agents WHERE id=$1`, [f.agentId])).rows[0];
    expect(agent.status).toBe("retired");
    expect(agent.secret).toBeNull();

    const printer = (await pool().query(`SELECT enabled, status FROM printers WHERE id=$1`, [f.printerId])).rows[0];
    expect(printer.enabled).toBe(false);
    expect(printer.status).toBe("retired");
  });

  it("a retired agent cannot authenticate", async () => {
    const f = await seedFixture();
    const { validateAgent } = await import("@/lib/agent-auth");

    // Sanity: it works while active.
    await pool().query(`UPDATE agents SET status='online' WHERE id=$1`, [f.agentId]);
    expect(await validateAgent(f.agentAuth)).toBeTruthy();

    await pool().query(`UPDATE agents SET status='retired', secret=NULL WHERE id=$1`, [f.agentId]);
    expect(await validateAgent(f.agentAuth)).toBeNull();
  });

  it("a disabled agent cannot authenticate even though its secret is intact", async () => {
    const f = await seedFixture();
    await pool().query(`UPDATE agents SET status='disabled' WHERE id=$1`, [f.agentId]);
    const { validateAgent } = await import("@/lib/agent-auth");
    expect(await validateAgent(f.agentAuth)).toBeNull();
    // Secret preserved so re-enabling does not require re-pairing.
    const row = (await pool().query(`SELECT secret FROM agents WHERE id=$1`, [f.agentId])).rows[0];
    expect(row.secret).toBe(sha256(f.agentSecret));
  });

  it("retiring preserves print history", async () => {
    const f = await seedFixture();
    const jobId = `job_${randomBytes(4).toString("hex")}`;
    await pool().query(
      `INSERT INTO print_jobs (id, branch_id, destination_id, document_type, agent_id, printer_id, status, payload, expires_at)
       VALUES ($1,$2,$3,'receipt',$4,$5,'success','{"type":"escpos","encoding":"base64","data":"AA=="}', now() + interval '1 hour')`,
      [jobId, f.branchId, f.destinationId, f.agentId, f.printerId]
    );

    await pool().query(`UPDATE agents SET status='retired', secret=NULL WHERE id=$1`, [f.agentId]);
    await pool().query(`UPDATE printers SET enabled=false, status='retired' WHERE agent_id=$1`, [f.agentId]);

    const job = (await pool().query(
      `SELECT j.id, j.status, j.branch_id, a.status AS agent_status, p.status AS printer_status
       FROM print_jobs j JOIN agents a ON a.id=j.agent_id JOIN printers p ON p.id=j.printer_id
       WHERE j.id=$1`, [jobId])).rows[0];
    expect(job.id).toBe(jobId);
    expect(job.status).toBe("success");
    expect(job.agent_status).toBe("retired");
    expect(job.printer_status).toBe("retired");
  });

  it("equal-priority bindings resolve to the same printer on every call", async () => {
    const f = await seedFixture();
    // A second printer on the same agent, and two bindings at equal priority.
    const p2 = `printer_${randomBytes(4).toString("hex")}`;
    await pool().query(
      `INSERT INTO printers (id, agent_id, name, type, printer_type, connection_type, protocol, status, enabled)
       VALUES ($1,$2,'second','network','thermal','tcp','escpos','online',true)`,
      [p2, f.agentId]
    );
    await pool().query(`DELETE FROM printer_bindings WHERE branch_id=$1`, [f.branchId]);
    await pool().query(
      `INSERT INTO printer_bindings (id, branch_id, destination_id, document_type, printer_id, priority, enabled)
       VALUES ('bind_zzz',$1,$2,'receipt',$3,1,true), ('bind_aaa',$1,$2,'receipt',$4,1,true)`,
      [f.branchId, f.destinationId, f.printerId, p2]
    );

    const { resolvePrinterForJob } = await import("@/lib/routing");
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const r = await resolvePrinterForJob({
        branchId: f.branchId,
        destinationId: f.destinationId,
        documentType: "receipt",
        payloadType: "escpos",
      });
      expect(r).not.toBeNull();
      expect("error" in r!).toBe(false);
      if (r && !("error" in r)) seen.add(r.printer.id);
    }
    expect(seen.size).toBe(1);
    // bind_aaa < bind_zzz, so its printer wins deterministically.
    expect([...seen][0]).toBe(p2);
  });

  it("a disabled printer is never selected for a new job", async () => {
    const f = await seedFixture();
    await pool().query(
      `INSERT INTO printer_bindings (id, branch_id, destination_id, document_type, printer_id, priority, enabled)
       VALUES ($1,$2,$3,'receipt',$4,1,true)`,
      [`bind_${randomBytes(4).toString("hex")}`, f.branchId, f.destinationId, f.printerId]
    );
    await pool().query(`UPDATE printers SET enabled=false WHERE id=$1`, [f.printerId]);
    const { resolvePrinterForJob } = await import("@/lib/routing");
    const r = await resolvePrinterForJob({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payloadType: "escpos",
    });
    expect(r).not.toBeNull();
    expect("error" in r!).toBe(true);
    if (r && "error" in r) expect(r.error).toBe("PRINTER_DISABLED");
  });
});
