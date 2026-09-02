import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "node:fs";

/**
 * Dev-only browser harness switch.
 *
 * `index.html` is the Tauri entry: it boots the real Rust backend through
 * `invoke`, so opening it in a plain browser gives a blank screen. The
 * reviewable UI lives in `preview.html`.
 *
 * With PREVIEW_HARNESS=1 the dev server serves `preview.html` for `/`, so a
 * browser (or a proxied remote preview) lands straight on the working UI.
 * `tauri dev` and the production build never set the variable, so they keep
 * using the real entry — and because this plugin is `apply: "serve"` it does
 * not exist in the installer at all.
 */
const previewHarness = {
  name: "desktop-preview-harness",
  apply: "serve" as const,
  transformIndexHtml: {
    order: "pre" as const,
    handler(_html: string, ctx: { path: string }) {
      if (process.env.PREVIEW_HARNESS !== "1") return _html;
      if (ctx.path !== "/" && !ctx.path.endsWith("/index.html")) return _html;
      return readFileSync(path.resolve(__dirname, "src/desktop/preview.html"), "utf8");
    },
  },
};

export default defineConfig({
  root: "src/desktop",
  plugins: [react(), previewHarness],
  base: "./",
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  // Pin the production entry: `preview.html` is a browser-only harness and
  // must never end up inside the Windows installer.
  build: {
    outDir: "../../dist-desktop",
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, "src/desktop/index.html") },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // The dev server is sometimes reached through a proxied preview host
    // (sandboxes, remote review) rather than plain localhost.
    allowedHosts: true,
  },
});
