type Counter = { value: number };

const counters = new Map<string, Counter>();

export function incrementMetric(name: string, value = 1): void {
  const current = counters.get(name) ?? { value: 0 };
  current.value += value;
  counters.set(name, current);
}

export function renderPrometheusMetrics(): string {
  return Array.from(counters.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, counter]) => `# TYPE ${name} counter\n${name} ${counter.value}`)
    .join('\n') + (counters.size ? '\n' : '');
}
