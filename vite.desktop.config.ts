import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  root: "src/desktop",
  plugins: [react()],
  base: "./",
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: { outDir: "../../dist-desktop", emptyOutDir: true },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
