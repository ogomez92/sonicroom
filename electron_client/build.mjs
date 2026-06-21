// Bundles the Electron main process, the two preloads, and the settings-window
// renderer with esbuild. Node-side code (main + preloads) is emitted as CommonJS
// with `electron` left external; the settings UI is emitted as a browser IIFE.
// The settings HTML is copied alongside. Run via `node build.mjs`.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, "dist-electron");
const rendererDir = path.join(outdir, "renderer");

await rm(outdir, { recursive: true, force: true });
await mkdir(rendererDir, { recursive: true });

// Main process + preloads: CommonJS, Node target, `electron` external.
await build({
  entryPoints: {
    main: path.join(root, "src/main.ts"),
    preload: path.join(root, "src/preload.ts"),
    "settings-preload": path.join(root, "src/settings-preload.ts"),
  },
  outdir,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
});

// Settings window renderer: browser IIFE.
await build({
  entryPoints: { settings: path.join(root, "src/settings/settings.ts") },
  outdir: rendererDir,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
});

// Static settings HTML.
await cp(path.join(root, "src/settings/index.html"), path.join(rendererDir, "index.html"));

console.log("electron_client: build complete →", path.relative(root, outdir));
