import type { NextConfig } from "next";

/**
 * Defensive HTTP response headers.
 *
 * These are applied to every route. They are all "deny by default" hardening
 * headers that this application does not rely on the absence of: the console is
 * a first-party, same-origin app that is never framed and never loads
 * cross-origin plugin content.
 *
 * HSTS is deliberately conditional. Sending Strict-Transport-Security over
 * plain HTTP during local development would pin `localhost` to HTTPS in the
 * developer's browser — a sticky, hard-to-clear failure that has nothing to do
 * with production security. It is therefore emitted only in production builds.
 */
const isProduction = process.env.NODE_ENV === "production";

const securityHeaders = [
  // Never let a browser second-guess a declared Content-Type (protects against
  // a JSON/text response being sniffed and executed as script).
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send the full URL only to same-origin destinations; cross-origin gets the
  // origin alone, so job ids and query parameters do not leak in Referer.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Clickjacking: the console must never be framed. X-Frame-Options covers
  // older browsers; frame-ancestors below is the modern, authoritative rule.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  // The console needs none of these capabilities; deny them outright so a
  // compromised dependency cannot silently request them.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  // Cross-origin isolation of this document from other windows/resources.
  { key: "X-DNS-Prefetch-Control", value: "off" },
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
