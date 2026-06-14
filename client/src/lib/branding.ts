// The display name of this SonicRoom instance — shown as the app title in the
// lobby heading and the browser tab. Operators rebrand a deployment by setting
// INSTANCE_NAME in their .env; the server injects it into the served index.html
// as `window.__SONICROOM_CONFIG__` (see server/src/index.ts), so a pre-built
// static client is rebranded at runtime with no rebuild. Falls back to the
// default in dev (Vite serves the raw HTML, so the global is absent) or if unset.
export const DEFAULT_INSTANCE_NAME = "SonicRoom";

interface SonicRoomConfig {
  instanceName?: string;
}

declare global {
  interface Window {
    __SONICROOM_CONFIG__?: SonicRoomConfig;
  }
}

export function getInstanceName(): string {
  const name =
    typeof window !== "undefined" ? window.__SONICROOM_CONFIG__?.instanceName?.trim() : "";
  return name || DEFAULT_INSTANCE_NAME;
}
