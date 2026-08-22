import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { cpSync, existsSync, createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// MediaPipe's face detector (VIDEO rooms' face-centering guidance, loaded
// lazily) needs its wasm runtime served from a URL we control — same-origin,
// no CDN. Serve `@mediapipe/tasks-vision/wasm` at /mediapipe/wasm in dev and
// copy it into dist/mediapipe/wasm on build (the ~230 KB BlazeFace model is
// committed under public/models). See client/src/lib/video/face-locator.ts.
function mediapipeWasm(): Plugin {
  // A plain path (the package's `exports` map doesn't expose package.json, so
  // require.resolve can't be used to find it).
  const wasmDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "node_modules",
    "@mediapipe",
    "tasks-vision",
    "wasm",
  );
  const mount = "/mediapipe/wasm";
  return {
    name: "sonicroom:mediapipe-wasm",
    configureServer(server) {
      if (!existsSync(wasmDir)) return;
      const types: Record<string, string> = {
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
      };
      server.middlewares.use(mount, (req, res, next) => {
        // Basename only — no traversal out of the wasm dir.
        const name = path.basename(decodeURIComponent((req.url ?? "/").split("?")[0]));
        const file = path.join(wasmDir, name);
        const type = types[path.extname(name)];
        if (!name || !type || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", type);
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(wasmDir)) return;
      cpSync(wasmDir, path.join("dist", "mediapipe", "wasm"), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [
    mediapipeWasm(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      // Locale resolution order (first hit wins): a stored choice from the
      // language picker, then the browser's preferred language, then English.
      // A ?lang= URL override is applied imperatively in src/lib/i18n.ts.
      strategy: ["localStorage", "preferredLanguage", "baseLocale"],
    }),
    react(),
    tailwindcss(),
  ],
  build: {
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing third-party code out of the app
        // bundle. mediasoup-client is the largest dependency, so it gets its
        // own chunk; everything else from node_modules shares a vendor chunk.
        // Beyond silencing the 500 kB chunk-size warning, this matters for our
        // deploy model: client redeploys are frequent (`pnpm build` only), but
        // these chunks rarely change, so returning users keep them cached.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("mediasoup-client")) return "mediasoup";
          // VIDEO-room-only dependencies, reached solely through dynamic
          // imports (lib/video/*): keep them OUT of the shared vendor chunk so
          // an audio room never downloads the Claude SDK or MediaPipe.
          if (id.includes("@anthropic-ai")) return "claude-sdk";
          if (id.includes("@mediapipe")) return "mediapipe";
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/socket.io": {
        target: "http://localhost:3100",
        ws: true,
      },
      // Recording download endpoint lives on the backend.
      "/api": {
        target: "http://localhost:3100",
      },
    },
  },
});
