import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dev proxy target must match the backend's actual port. Resolution order:
//   1. shell env  (DEV_API_PROXY_TARGET=... npx vite)
//   2. .env file  (DEV_API_PROXY_TARGET=http://127.0.0.1:9090) — loadEnv,
//      because vite.config.ts does NOT see .env through process.env on its own.
//   3. fallback :8080 (the config.go default).
//
// DELIBERATELY NOT VITE_-prefixed: a VITE_* var is exposed to the frontend
// bundle (import.meta.env), where apiClient treats it as an absolute API base —
// turning every call cross-origin, which silently breaks the SameSite=Lax
// session cookie (login succeeds, everything after is 401). The frontend must
// keep calling same-origin relative /api paths through this proxy.
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const apiBaseUrl = process.env.DEV_API_PROXY_TARGET
    ?? fileEnv.DEV_API_PROXY_TARGET
    ?? "http://127.0.0.1:8080";

  return {
    plugins: [react(), tailwindcss()],
    // 3D model assets (React Bits Lanyard card) imported as URLs.
    assetsInclude: ["**/*.glb"],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiBaseUrl,
          changeOrigin: true,
          timeout: 600000, // 10 min — video generation polls for up to ~8 min
        },
        "/uploads": {
          target: apiBaseUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
