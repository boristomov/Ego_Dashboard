import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The base path is configurable via VITE_BASE so the build can target
// GitHub Pages (e.g. "/Ego_Dashboard/") without code changes.
const base = process.env.VITE_BASE || "/";

export default defineConfig({
  plugins: [react()],
  base,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
