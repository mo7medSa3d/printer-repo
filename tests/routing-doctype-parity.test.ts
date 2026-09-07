import { describe, expect, it } from "vitest";
import { printerTone, agentTone, jobTone } from "../src/components/ui";

// The old Gateway-side binding selector was removed. Document type is now
// derived by the Odoo central router from real Odoo report/model context.
describe("document and runtime status semantics", () => {
  it("maps canonical runtime states consistently", () => {
    expect(agentTone("online")).toBe("ok");
    expect(agentTone("disabled")).toBe("warn");
    expect(printerTone("printing")).toBe("warn");
    expect(printerTone("offline")).toBe("bad");
    expect(jobTone("success")).toBe("ok");
    expect(jobTone("failed")).toBe("bad");
    expect(jobTone("claimed")).toBe("info");
  });
});
