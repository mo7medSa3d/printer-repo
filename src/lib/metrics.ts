import { pool } from "../db";

type Counter = { value: number };

const localCounters = new Map<string, Counter>();

function sanitizeMetricName(name: string): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`Invalid Prometheus metric name: ${name}`);
  return name;
}

export async function incrementMetric(name: string, value = 1): Promise<void> {
  const safeName = sanitizeMetricName(name);
  if (!Number.isInteger(value) || value <= 0) return;
  const current = localCounters.get(safeName) ?? { value: 0 };
  current.value += value;
  localCounters.set(safeName, current);

  try {
    await pool.query(`
      INSERT INTO gateway_metrics (name, value, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (name)
      DO UPDATE SET value = gateway_metrics.value + EXCLUDED.value, updated_at = now()
    `, [safeName, value]);
  } catch {
    // Metrics must never break a print/auth/job request when the metrics table
    // is unavailable during startup, migration, or an isolated DB outage.
  }
}

async function renderFleetGauges(): Promise<string> {
  const staleSecondsRaw = Number(process.env.STALE_AGENT_THRESHOLD_SECONDS ?? "90");
  const staleSeconds = Number.isFinite(staleSecondsRaw) && staleSecondsRaw >= 10 ? Math.min(staleSecondsRaw, 3600) : 90;
  try {
    const [jobs, agents, printers] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'queued')::bigint AS queued,
          COUNT(*) FILTER (WHERE status IN ('claimed', 'printing'))::bigint AS in_flight
        FROM print_jobs
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE lifecycle = 'active' AND status = 'online')::bigint AS online,
          COUNT(*) FILTER (WHERE lifecycle = 'active' AND (status = 'offline' OR last_seen_at < now() - make_interval(secs => $1)))::bigint AS stale,
          COUNT(*) FILTER (WHERE lifecycle = 'active' AND status = 'offline')::bigint AS offline
        FROM agents
      `, [staleSeconds]),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE lifecycle = 'active' AND status = 'online')::bigint AS online,
          COUNT(*) FILTER (WHERE lifecycle = 'active' AND status = 'offline')::bigint AS offline,
          COUNT(*) FILTER (WHERE lifecycle = 'disabled')::bigint AS disabled
        FROM printers
      `),
    ]);

    const j = jobs.rows[0] as Record<string, string>;
    const a = agents.rows[0] as Record<string, string>;
    const p = printers.rows[0] as Record<string, string>;
    return [
      `# TYPE print_jobs_queue_depth gauge`,
      `print_jobs_queue_depth ${j.queued}`,
      `# TYPE print_jobs_in_flight gauge`,
      `print_jobs_in_flight ${j.in_flight}`,
      `# TYPE agents_online gauge`,
      `agents_online ${a.online}`,
      `# TYPE agents_offline gauge`,
      `agents_offline ${a.offline}`,
      `# TYPE agents_stale gauge`,
      `agents_stale ${a.stale}`,
      `# TYPE printers_online gauge`,
      `printers_online ${p.online}`,
      `# TYPE printers_offline gauge`,
      `printers_offline ${p.offline}`,
      `# TYPE printers_disabled gauge`,
      `printers_disabled ${p.disabled}`,
    ].join("\n");
  } catch {
    return "";
  }
}

export async function renderPrometheusMetrics(): Promise<string> {
  let counterOutput = "";
  try {
    const result = await pool.query<{ name: string; value: string }>(
      "SELECT name, value::text FROM gateway_metrics ORDER BY name",
    );
    if (result.rows.length > 0) {
      counterOutput = result.rows.map((row) => `# TYPE ${row.name} counter\n${row.name} ${row.value}`).join("\n");
    }
  } catch {
    // Fall back to the local process counters below.
  }

  if (!counterOutput) {
    counterOutput = Array.from(localCounters.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, counter]) => `# TYPE ${name} counter\n${name} ${counter.value}`)
      .join("\n");
  }

  const gauges = await renderFleetGauges();
  const sections = [counterOutput, gauges].filter(Boolean);
  return sections.length ? `${sections.join("\n")}\n` : "";
}
