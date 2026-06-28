import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getInstanceName, getDefaultDisplayName, DEFAULT_INSTANCE_NAME } from "./branding";
import type { SonicRoomConfig } from "./branding";

// Both helpers read window.__SONICROOM_CONFIG__ (set by the Electron preload,
// absent on the web). Reset around each test so the unconfigured branch is real.
function setConfig(cfg: SonicRoomConfig) {
  window.__SONICROOM_CONFIG__ = cfg;
}
beforeEach(() => {
  delete window.__SONICROOM_CONFIG__;
});
afterEach(() => {
  delete window.__SONICROOM_CONFIG__;
});

describe("getInstanceName", () => {
  it('exposes the "SonicRoom" default constant', () => {
    expect(DEFAULT_INSTANCE_NAME).toBe("SonicRoom");
  });

  it("falls back to the default with no config", () => {
    expect(getInstanceName()).toBe("SonicRoom");
  });

  it("falls back to the default for a blank or whitespace name", () => {
    setConfig({ instanceName: "" });
    expect(getInstanceName()).toBe("SonicRoom");
    setConfig({ instanceName: "   " });
    expect(getInstanceName()).toBe("SonicRoom");
  });

  it("returns the configured name", () => {
    setConfig({ instanceName: "AcmeRoom" });
    expect(getInstanceName()).toBe("AcmeRoom");
  });

  it("trims surrounding whitespace from the configured name", () => {
    setConfig({ instanceName: "  AcmeRoom  " });
    expect(getInstanceName()).toBe("AcmeRoom");
  });
});

describe("getDefaultDisplayName", () => {
  it('is "" with no config (lobby field starts blank)', () => {
    expect(getDefaultDisplayName()).toBe("");
  });

  it('is "" for a blank or whitespace value', () => {
    setConfig({ defaultDisplayName: "" });
    expect(getDefaultDisplayName()).toBe("");
    setConfig({ defaultDisplayName: "   " });
    expect(getDefaultDisplayName()).toBe("");
  });

  it("returns the configured name", () => {
    setConfig({ defaultDisplayName: "Alice" });
    expect(getDefaultDisplayName()).toBe("Alice");
  });

  it("trims surrounding whitespace", () => {
    setConfig({ defaultDisplayName: "  Alice  " });
    expect(getDefaultDisplayName()).toBe("Alice");
  });
});
