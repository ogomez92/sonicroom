import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  serverBase,
  apiUrl,
  socketTarget,
  iceServers,
  resetIceCache,
  DEFAULT_ICE_SERVERS,
  STUN_ONLY_ICE_SERVERS,
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
  // The minter is a network call; stub it per test so nothing hits the wire.
  function stubFetch(impl: typeof fetch) {
    globalThis.fetch = impl as typeof fetch;
  }
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetIceCache();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetIceCache();
  });

  it("returns the injected list when a non-empty array is provided", async () => {
    const custom: RTCIceServer[] = [{ urls: "stun:stun.other.example:3478" }];
    setConfig({ iceServers: custom });
    await expect(iceServers()).resolves.toBe(custom);
  });

  it("mints TURN credentials when there is no override", async () => {
    const minted: RTCIceServer[] = [
      { urls: "stun:turn.gomsen.com:3478" },
      { urls: "turn:turn.gomsen.com:3478?transport=udp", username: "1:web", credential: "sig" },
    ];
    stubFetch(
      (async () =>
        new Response(
          JSON.stringify({ iceServers: minted, expiresAt: Date.now() / 1000 + 3600 }),
          { status: 200 },
        )) as typeof fetch,
    );
    await expect(iceServers()).resolves.toEqual(minted);
  });

  it("caches the minted credential across calls", async () => {
    let calls = 0;
    stubFetch(
      (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            iceServers: [{ urls: "turn:x", username: "u", credential: "c" }],
            expiresAt: Date.now() / 1000 + 3600,
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    );
    await Promise.all([iceServers(), iceServers()]);
    await iceServers();
    expect(calls).toBe(1);
  });

  it("falls back to STUN-only when the minter fails", async () => {
    stubFetch((async () => new Response("nope", { status: 500 })) as typeof fetch);
    await expect(iceServers()).resolves.toBe(STUN_ONLY_ICE_SERVERS);
  });

  it("falls back to STUN-only when the minter is unreachable", async () => {
    stubFetch((async () => {
      throw new Error("offline");
    }) as typeof fetch);
    await expect(iceServers()).resolves.toBe(STUN_ONLY_ICE_SERVERS);
  });

  it("ships no TURN credentials in the static defaults", () => {
    const urls = DEFAULT_ICE_SERVERS.map((s) => s.urls);
    expect(urls).toContain("stun:turn.gomsen.com:3478");
    expect(urls).toContain("stun:stun.l.google.com:19302");
    // The whole point: nothing baked into the bundle carries a TURN secret.
    for (const s of DEFAULT_ICE_SERVERS) {
      expect(String(s.urls).startsWith("stun:")).toBe(true);
      expect(s.username).toBeUndefined();
      expect(s.credential).toBeUndefined();
    }
  });
});
