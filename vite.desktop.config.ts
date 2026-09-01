import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  root: "src/desktop",
  plugins: [react()],
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
