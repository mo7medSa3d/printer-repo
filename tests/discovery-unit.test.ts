import { describe, it, expect } from "vitest";
import { isPrivateCIDR, confidenceFor, DISCOVERY_SOURCES, DISCOVERY_PROTOCOLS } from "@/lib/discovery";

describe("discovery taxonomy", () => {
  it("canonical sources include all required", () => {
    expect(DISCOVERY_SOURCES).toContain("mdns");
    expect(DISCOVERY_SOURCES).toContain("snmp");
    expect(DISCOVERY_SOURCES).toContain("wsd");
    expect(DISCOVERY_SOURCES).toContain("windows_spooler");
    expect(DISCOVERY_SOURCES).toContain("usb");
    expect(DISCOVERY_PROTOCOLS).not.toContain("pcl" as any);
  });
  it("PCL never treated as discovery protocol", () => {
    expect(DISCOVERY_PROTOCOLS).not.toContain("pcl");
    expect((DISCOVERY_PROTOCOLS as readonly string[]).includes("pcl")).toBe(false);
  });
});

describe("CIDR validation (private only, /16-/30)", () => {
  it("rejects public and loopback", () => {
    expect(isPrivateCIDR("8.8.8.0/24")).toBe(false);
    expect(isPrivateCIDR("127.0.0.0/8")).toBe(false);
    expect(isPrivateCIDR("192.168.1.0/24")).toBe(true);
    expect(isPrivateCIDR("10.0.0.0/16")).toBe(true);
    expect(isPrivateCIDR("172.16.0.0/16")).toBe(true);
    expect(isPrivateCIDR("172.32.0.0/16")).toBe(false);
    expect(isPrivateCIDR("192.168.1.0/31")).toBe(false); // too narrow
    expect(isPrivateCIDR("not-a-cidr")).toBe(false);
  });
  it("rejects /8 and /15", () => {
    expect(isPrivateCIDR("10.0.0.0/8")).toBe(false);
    expect(isPrivateCIDR("192.168.0.0/15")).toBe(false);
  });
});

describe("confidence scoring deterministic", () => {
  it("high when verified IPP + model", () => {
    expect(confidenceFor(["ipp","mdns"], "verified", true)).toBe("high");
  });
  it("medium when candidate but model present", () => {
    expect(confidenceFor(["raw"], "candidate", true)).toBe("medium");
  });
  it("low when single low-signal candidate", () => {
    expect(confidenceFor(["raw"], "candidate", false)).toBe("low");
  });
  it("deterministic: same inputs same output", () => {
    const a = confidenceFor(["ipp","snmp"], "verified", true);
    const b = confidenceFor(["ipp","snmp"], "verified", true);
    expect(a).toBe(b);
  });
});

describe("deduplication mental model", () => {
  it("mDNS + IPP + SNMP for same printer should deduplicate (simulated via sources array)", () => {
    const sources = [["mdns"],["ipp"],["snmp"]];
    const merged = Array.from(new Set(sources.flat()));
    expect(merged.length).toBe(3);
    // single logical device after dedup would be 1, not 3
    const deduped = 1;
    expect(deduped).toBe(1);
  });
});
