export function normalizeDocumentType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error("document type is required");
  return normalized;
}
