import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The web app lives in web/ and builds into dist/web, which the server serves in production
export default defineConfig(({ mode }) => {
  const apiPort = loadEnv(mode, process.cwd(), "").PORT || "3000";
  const api = `http://127.0.0.1:${apiPort}`;
  return {
    root: "web",
    plugins: [react()],
    build: { outDir: "../dist/web", emptyOutDir: true },
    server: { proxy: { "/api": api, "/health": api } },
  };
});
