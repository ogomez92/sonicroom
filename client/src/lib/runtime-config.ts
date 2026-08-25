// Runtime connection seam.
//
// On the web, SonicRoom is served same-origin by its own signaling server, so the
// socket.io connection and every `/api` request use relative URLs and the WebRTC
// ICE servers are the ones baked in below. The Electron desktop client instead
// connects to a *configurable* remote instance: its preload injects
// `window.__SONICROOM_CONFIG__` with a `serverUrl` (and optional `iceServers`)
// before the app boots, and the helpers here transparently retarget the socket,
// the REST calls and the ICE config.
//
// When no config is injected (the plain web build), every helper falls back to
// today's behaviour — same-origin URLs and the default ICE list — so the existing
// web deployment is byte-for-byte unchanged.

import type { SonicRoomConfig } from "./branding";

// ICE servers.
//
// TURN credentials are NEVER baked into this bundle. Our coturn runs with
// `use-auth-secret` (the TURN REST API), so the only long-lived secret lives on
// the server; clients ask the credential minter at `TURN_CREDENTIAL_URL` for a
// short-lived HMAC credential (username `<expiry>:<label>`) that coturn verifies
// and that stops working once it expires. See /home/turnauth on the VPS.
//
// STUN needs no credentials, so the static list below is STUN-only. It is also
// the graceful fallback: if the minter is unreachable we still return STUN, and
// direct P2P (the overwhelmingly common path) keeps working — only the relay
// fallback for symmetric NATs is lost.
export const STUN_ONLY_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:turn.gomsen.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

// Kept for the Electron settings UI, which shows "the defaults" to the user.
export const DEFAULT_ICE_SERVERS = STUN_ONLY_ICE_SERVERS;

// Where to mint ephemeral TURN credentials. Same host as coturn itself so one
// DNS name covers the whole relay story.
const TURN_CREDENTIAL_URL = "https://turn.gomsen.com/ice?app=sonicroom";

interface MintedIce {
  iceServers: RTCIceServer[];
  expiresAt: number; // unix seconds
}

// One in-flight fetch shared by every caller, plus a cache until shortly before
// expiry — a call start creates three transports back to back and must not mint
// three separate credentials.
let cached: MintedIce | null = null;
let inFlight: Promise<MintedIce | null> | null = null;

const EXPIRY_SKEW_S = 60;

function cacheValid(): boolean {
  return !!cached && cached.expiresAt - EXPIRY_SKEW_S > Date.now() / 1000;
}

async function mintIceServers(): Promise<MintedIce | null> {
  try {
    const res = await fetch(TURN_CREDENTIAL_URL, { credentials: "omit" });
    if (!res.ok) throw new Error(`minter returned ${res.status}`);
    const body = (await res.json()) as { iceServers?: RTCIceServer[]; expiresAt?: number };
    if (!Array.isArray(body.iceServers) || body.iceServers.length === 0) {
      throw new Error("minter returned no iceServers");
    }
    return {
      iceServers: body.iceServers,
      expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : Date.now() / 1000 + 300,
    };
  } catch (err) {
    // Non-fatal: fall back to STUN-only rather than failing the call.
    console.warn("[ice] could not mint TURN credentials, falling back to STUN:", err);
    return null;
  }
}

function config(): SonicRoomConfig {
  return (typeof window !== "undefined" && window.__SONICROOM_CONFIG__) || {};
}

// Absolute origin of the signaling/API server with any trailing slash removed.
// "" means same-origin (the web default).
export function serverBase(): string {
  const url = config().serverUrl?.trim();
  return url ? url.replace(/\/+$/, "") : "";
}

// Build a URL for a server REST path (paths already start with "/api/..."). On
// the web this is just the relative path; in Electron it's prefixed with the
// configured server origin.
export function apiUrl(path: string): string {
  return serverBase() + path;
}

// socket.io connection target — `undefined` means same-origin (the web default),
// which is what `io()` expects to keep its current behaviour.
export function socketTarget(): string | undefined {
  return config().serverUrl?.trim() || undefined;
}

// ICE servers for RTCPeerConnection / mediasoup transports.
//
// An explicit override injected by the host (the Electron client pointing at an
// instance with its own TURN) wins outright and is returned synchronously.
// Otherwise we mint short-lived TURN credentials, cached until just before they
// expire, and degrade to STUN-only if the minter can't be reached.
export async function iceServers(): Promise<RTCIceServer[]> {
  const override = config().iceServers;
  if (Array.isArray(override) && override.length > 0) return override;

  if (cacheValid()) return cached!.iceServers;

  if (!inFlight) {
    inFlight = mintIceServers().finally(() => {
      inFlight = null;
    });
  }
  const minted = await inFlight;
  if (minted) cached = minted;
  return minted ? minted.iceServers : STUN_ONLY_ICE_SERVERS;
}

// Test seam: drop any cached credential.
export function resetIceCache(): void {
  cached = null;
  inFlight = null;
}
