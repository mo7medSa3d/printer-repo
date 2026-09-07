import { describe, expect, it } from "vitest";
import { normalizeDocumentType } from "../src/lib/document-type";

describe("document-type normalization", () => {
  it("normalizes case and surrounding whitespace deterministically", () => {
    expect(normalizeDocumentType("  INVOICE ")).toBe("invoice");
    expect(normalizeDocumentType("Kitchen")).toBe("kitchen");
  });

  it("rejects empty document types", () => {
    expect(() => normalizeDocumentType("   ")).toThrow();
  });
});
