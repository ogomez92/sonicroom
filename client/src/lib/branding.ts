// The display name of this SonicRoom instance — shown as the app title in the
// lobby heading and the browser tab. Operators rebrand a deployment by setting
// INSTANCE_NAME in their .env; the server injects it into the served index.html
// as `window.__SONICROOM_CONFIG__` (see server/src/index.ts), so a pre-built
// static client is rebranded at runtime with no rebuild. Falls back to the
// default in dev (Vite serves the raw HTML, so the global is absent) or if unset.
export const DEFAULT_INSTANCE_NAME = "SonicRoom";

export interface SonicRoomConfig {
  instanceName?: string;
  // Set only by the Electron thin client (the web build leaves these undefined,
  // so behaviour is unchanged): the remote SonicRoom instance to connect to and
  // optional ICE/TURN overrides. See `runtime-config.ts` for how they retarget
  // the socket.io connection, the REST (`/api`) calls and the WebRTC ICE config.
  serverUrl?: string;
  iceServers?: RTCIceServer[];
  // Prefilled name in the lobby's "Your name" field (Electron settings default).
  defaultDisplayName?: string;
}

// The display name to prefill in the lobby. Empty on the web (the field starts
// blank); the Electron client can seed it from its settings.
export function getDefaultDisplayName(): string {
  const name =
    typeof window !== "undefined" ? window.__SONICROOM_CONFIG__?.defaultDisplayName?.trim() : "";
  return name || "";
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
