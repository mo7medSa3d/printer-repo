import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("production TypeScript safety contracts", () => {
  it("does not use escape-hatch casts or suppression directives in source", () => {
    const root = resolve(process.cwd(), "src");
    const files = [
      "app/api/printers/[id]/route.ts",
      "desktop/components/AddPrinterDialog.tsx",
      "db/schema.ts",
    ];

    for (const relative of files) {
      const source = readFileSync(resolve(root, relative), "utf8");
      expect(source).not.toMatch(/\bas\s+(?:any|never)\b/);
      expect(source).not.toMatch(/@ts-(?:ignore|expect-error)/);
    }
  });

  it("keeps printer capability metadata compatible with the API's validated record contract", () => {
    const source = readFileSync(resolve(process.cwd(), "src/db/schema.ts"), "utf8");
    expect(source).toContain('capabilities: jsonb("capabilities").$type<Record<string, unknown>>()');
  });
});
