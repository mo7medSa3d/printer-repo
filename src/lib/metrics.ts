import { pool } from "../db";

type Counter = { value: number };

// Local counters remain as a best-effort fallback for tests/builds without DB.
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

export async function renderPrometheusMetrics(): Promise<string> {
  try {
    const result = await pool.query<{ name: string; value: string }>(
      "SELECT name, value::text FROM gateway_metrics ORDER BY name",
    );
    if (result.rows.length > 0) {
      return result.rows.map((row) => `# TYPE ${row.name} counter\n${row.name} ${row.value}`).join("\n") + "\n";
    }
  } catch {
    // Fall back to the local process counters below.
  }

  return Array.from(localCounters.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, counter]) => `# TYPE ${name} counter\n${name} ${counter.value}`)
    .join("\n") + (localCounters.size ? "\n" : "");
}
