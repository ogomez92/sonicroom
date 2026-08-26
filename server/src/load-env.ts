// Loads the repo-root .env into process.env, and does it FIRST.
//
// This lives in its own module, imported before everything else in index.ts, on
// purpose: ESM evaluates every import before the importing module's body, so
// calling `process.loadEnvFile()` inside index.ts was already too late for any
// module that reads process.env at module scope — `mediasoup-config.ts` builds
// `transportOptions` (i.e. ANNOUNCED_IP / ANNOUNCE_LOCAL_IPS) as it loads. Real
// environment variables worked; the same settings in .env were silently
// ignored. A side-effect import at the top of the import list fixes the order.
//
// The file is gitignored and hidden from the app UI on purpose (NOTY_*
// notification target, etc.); an absent one is fine — the .env-gated features
// simply stay off. Resolved from this file, not cwd, since
// `pnpm --filter server start` runs with the server package as cwd.
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.resolve(here, "../../.env"));
} catch {
  /* no .env present — fine */
}
