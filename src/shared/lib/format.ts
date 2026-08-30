export function formatAgo(d: Date | string | null | undefined): string {
  if (!d) return "Never";
  const t = new Date(d).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(d).toLocaleString();
}
