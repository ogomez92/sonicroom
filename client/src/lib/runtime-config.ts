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

// ICE servers — self-hosted coturn at turn.gomsen.com (shared with the
// games on the same VPS). STUN is tried first, so most P2P connections
// never hit the relay; TURN/TURNS only kick in for symmetric NATs and
// restrictive corporate/hotel networks. Credentials are visible to
// clients by design (WebRTC requires them in the browser); coturn's
// denied-peer-ip rules limit blast radius. The Electron client can override
// this whole list from its settings (e.g. when pointing at another instance
// with its own TURN).
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:turn.gomsen.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:turn.gomsen.com:3478?transport=udp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
  {
    urls: "turn:turn.gomsen.com:3478?transport=tcp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
  {
    urls: "turns:turn.gomsen.com:5349?transport=tcp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
];

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

// ICE servers for RTCPeerConnection / mediasoup transports. Falls back to the
// baked-in default list when the host doesn't inject an override.
export function iceServers(): RTCIceServer[] {
  const ice = config().iceServers;
  return Array.isArray(ice) && ice.length > 0 ? ice : DEFAULT_ICE_SERVERS;
}
