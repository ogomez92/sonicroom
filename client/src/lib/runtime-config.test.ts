import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  serverBase,
  apiUrl,
  socketTarget,
  iceServers,
  DEFAULT_ICE_SERVERS,
} from "./runtime-config";
import type { SonicRoomConfig } from "./branding";

// Every helper reads window.__SONICROOM_CONFIG__ (injected by the Electron
// preload, absent on the web). Reset it around each test so the "web default"
// branch is genuinely unconfigured.
function setConfig(cfg: SonicRoomConfig) {
  window.__SONICROOM_CONFIG__ = cfg;
}
beforeEach(() => {
  delete window.__SONICROOM_CONFIG__;
});
afterEach(() => {
  delete window.__SONICROOM_CONFIG__;
});

describe("serverBase", () => {
  it('is "" with no config at all (same-origin web default)', () => {
    expect(serverBase()).toBe("");
  });

  it('is "" when config is present but has no serverUrl', () => {
    setConfig({ instanceName: "X" });
    expect(serverBase()).toBe("");
  });

  it('is "" for an empty or whitespace-only serverUrl', () => {
    setConfig({ serverUrl: "" });
    expect(serverBase()).toBe("");
    setConfig({ serverUrl: "   " });
    expect(serverBase()).toBe("");
  });

  it("strips trailing slashes", () => {
    setConfig({ serverUrl: "https://x.example.com/" });
    expect(serverBase()).toBe("https://x.example.com");
    setConfig({ serverUrl: "https://x.example.com///" });
    expect(serverBase()).toBe("https://x.example.com");
  });

  it("trims surrounding whitespace (then strips trailing slashes)", () => {
    setConfig({ serverUrl: "  https://x.example.com/  " });
    expect(serverBase()).toBe("https://x.example.com");
  });
});

describe("apiUrl", () => {
  it("returns the path as-is on the web (no config)", () => {
    expect(apiUrl("/api/recordings")).toBe("/api/recordings");
  });

  it("prefixes the configured server origin", () => {
    setConfig({ serverUrl: "https://api.example.com" });
    expect(apiUrl("/api/recordings")).toBe("https://api.example.com/api/recordings");
  });

  it("uses the trailing-slash-stripped base so paths don't double up", () => {
    setConfig({ serverUrl: "https://api.example.com/" });
    expect(apiUrl("/api/x")).toBe("https://api.example.com/api/x");
  });
});

describe("socketTarget", () => {
  it("is undefined on the web (same-origin io())", () => {
    expect(socketTarget()).toBeUndefined();
  });

  it("is undefined for empty/whitespace serverUrl", () => {
    setConfig({ serverUrl: "" });
    expect(socketTarget()).toBeUndefined();
    setConfig({ serverUrl: "   " });
    expect(socketTarget()).toBeUndefined();
  });

  it("is the trimmed serverUrl when configured", () => {
    setConfig({ serverUrl: "  https://socket.example.com  " });
    expect(socketTarget()).toBe("https://socket.example.com");
  });
});

describe("iceServers", () => {
  it("returns the baked-in defaults with no override", () => {
    expect(iceServers()).toBe(DEFAULT_ICE_SERVERS);
  });

  it("returns the defaults for an empty-array override", () => {
    setConfig({ iceServers: [] });
    expect(iceServers()).toBe(DEFAULT_ICE_SERVERS);
  });

  it("returns the defaults for a non-array override", () => {
    setConfig({ iceServers: "nope" as unknown as RTCIceServer[] });
    expect(iceServers()).toBe(DEFAULT_ICE_SERVERS);
  });

  it("returns the injected list when a non-empty array is provided", () => {
    const custom: RTCIceServer[] = [{ urls: "stun:stun.other.example:3478" }];
    setConfig({ iceServers: custom });
    expect(iceServers()).toBe(custom);
  });

  it("ships the expected default STUN/TURN entries", () => {
    const urls = DEFAULT_ICE_SERVERS.map((s) => s.urls);
    expect(urls).toContain("stun:turn.oriolgomez.com:3478");
    expect(urls).toContain("stun:stun.l.google.com:19302");
    expect(urls).toContain("turn:turn.oriolgomez.com:3478?transport=udp");
    expect(urls).toContain("turn:turn.oriolgomez.com:3478?transport=tcp");
    expect(urls).toContain("turns:turn.oriolgomez.com:5349?transport=tcp");
    // The TURN (not STUN) entries carry credentials.
    for (const s of DEFAULT_ICE_SERVERS) {
      if (String(s.urls).startsWith("turn")) {
        expect(s.username).toBe("gamesturn");
        expect(s.credential).toBeTruthy();
      }
    }
  });
});
