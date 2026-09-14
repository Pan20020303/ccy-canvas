import { readFileSync } from "node:fs";

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { canvasDevBridge } from "./scripts/canvas-cli/vite-canvas-dev";

// Newest release (version + 大白话 notes) from src/app/releases.json. The build
// writes it to dist/version.json so a running (older) tab can detect a fresh
// deploy, show what changed, and offer to reload.
function currentRelease(): { version: string; date: string; notes: string[] } {
  const list = JSON.parse(readFileSync("src/app/releases.json", "utf-8"));
  return list[0];
}

// The dev proxy target must match the backend's actual port. Resolution order:
//   1. shell env  (DEV_API_PROXY_TARGET=... npx vite)
//   2. .env file  (DEV_API_PROXY_TARGET=http://127.0.0.1:8080) — loadEnv,
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

  const release = currentRelease();

  // 画布 dev 桥接：让 DSH/CLI 改出来的 canvas patch 实时回灌到浏览器画布。
  // 关掉它：CCY_CANVAS_AGENT_BRIDGE=off npx vite
  const canvasBridgeEnabled = (process.env.CCY_CANVAS_AGENT_BRIDGE ?? "").toLowerCase() !== "off";

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(canvasBridgeEnabled
        ? [canvasDevBridge({ workspace: process.env.CCY_CANVAS_WORKSPACE ?? ".canvas-agent-workspace" })]
        : []),
      {
        // Emit dist/version.json (newest release: version + notes) so deployed
        // tabs can poll it, show what changed, and prompt to reload.
        name: "emit-version-json",
        apply: "build",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "version.json",
            source: JSON.stringify(release),
          });
        },
      },
    ],
    // 3D model assets (React Bits Lanyard card) imported as URLs.
    assetsInclude: ["**/*.glb"],
    build: {
      // Do not delete hashed chunks from the preceding release. Users often
      // keep a canvas tab open while a new build is deployed; that tab still
      // references the old lazy MediaPreview/Editor filenames. Retaining them
      // prevents a double-click from turning into a 404 application crash.
      emptyOutDir: false,
    },
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
