export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        // Codepoint order, not locale collation: localeCompare is ICU/locale
        // dependent (a ≠ A ordering differs), which made idempotency
        // fingerprints locale-sensitive. All contract keys are lowercase
        // ASCII, so existing stored fingerprints are unchanged.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
