import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  root: "src/desktop",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: { outDir: "../../dist-desktop", emptyOutDir: true, rollupOptions: { external: ["@tauri-apps/api/core", "@tauri-apps/api/event"] }, rolldownOptions: { external: ["@tauri-apps/api/core", "@tauri-apps/api/event"] } as never },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
