import { describe, it, expect, afterEach, vi } from "vitest";
import { microphoneConstraints, extraMicConstraints } from "./microphone";

// `isIOS` is computed once at module load from the ambient navigator. The static
// import above captures the jsdom default (a non-iOS UA), which the property
// tests below rely on (only the sampleRate hint depends on isIOS, and these
// assertions deliberately avoid it). The branch tests re-import the module under
// a stubbed navigator via vi.resetModules so each platform is evaluated fresh.

describe("microphoneConstraints", () => {
  it("captures 2 channels for hi-fi voice, 1 otherwise", () => {
    expect(microphoneConstraints("", false, true).channelCount).toBe(2);
    expect(microphoneConstraints("", false, false).channelCount).toBe(1);
  });

  it("ties echo/noise/AGC to voiceProcessingEnabled", () => {
    const on = microphoneConstraints("", true, false);
    expect(on.echoCancellation).toBe(true);
    expect(on.noiseSuppression).toBe(true);
    expect(on.autoGainControl).toBe(true);

    const off = microphoneConstraints("", false, false);
    expect(off.echoCancellation).toBe(false);
    expect(off.noiseSuppression).toBe(false);
    expect(off.autoGainControl).toBe(false);
  });

  it("uses an `ideal` deviceId hint when a device is given", () => {
    const c = microphoneConstraints("mic-1", false, false);
    expect(c.deviceId).toEqual({ ideal: "mic-1" });
  });

  it("omits deviceId entirely for the empty (default) device", () => {
    const c = microphoneConstraints("", false, false);
    expect("deviceId" in c).toBe(false);
  });
});

describe("extraMicConstraints", () => {
  it("captures 2 channels when stereo, 1 otherwise", () => {
    expect(extraMicConstraints("dev", true).channelCount).toBe(2);
    expect(extraMicConstraints("dev", false).channelCount).toBe(1);
  });

  it("captures raw — echo/noise/AGC all off", () => {
    const c = extraMicConstraints("dev", false);
    expect(c.echoCancellation).toBe(false);
    expect(c.noiseSuppression).toBe(false);
    expect(c.autoGainControl).toBe(false);
  });

  it("pins the device with `exact` (fail-clean, no aliasing to default)", () => {
    expect(extraMicConstraints("dev-2", true).deviceId).toEqual({ exact: "dev-2" });
  });

  it("never sets a sample-rate hint (not even off-iOS)", () => {
    expect("sampleRate" in extraMicConstraints("dev", true)).toBe(false);
    expect("sampleRate" in extraMicConstraints("dev", false)).toBe(false);
  });
});

describe("isIOS (computed at module load from navigator)", () => {
  // Re-import the module with a stubbed navigator so `isIOS` re-evaluates.
  async function importWith(userAgent: string, maxTouchPoints: number) {
    vi.resetModules();
    vi.stubGlobal("navigator", { userAgent, maxTouchPoints });
    return import("./microphone");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("is true for an iPhone UA (touch count irrelevant)", async () => {
    const { isIOS } = await importWith(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      0,
    );
    expect(isIOS).toBe(true);
  });

  it("is true for an iPad reporting as MacIntel with touch support", async () => {
    const { isIOS } = await importWith(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      5,
    );
    expect(isIOS).toBe(true);
  });

  it("is true for an iPod UA", async () => {
    const { isIOS } = await importWith(
      "Mozilla/5.0 (iPod touch; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
      0,
    );
    expect(isIOS).toBe(true);
  });

  it("is false for a desktop Mac without touch", async () => {
    const { isIOS } = await importWith(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      0,
    );
    expect(isIOS).toBe(false);
  });

  it("is false on Windows", async () => {
    const { isIOS } = await importWith(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120",
      0,
    );
    expect(isIOS).toBe(false);
  });

  it("includes the 48 kHz sampleRate hint off-iOS", async () => {
    const { microphoneConstraints: mc } = await importWith(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
      0,
    );
    expect(mc("dev", false, false).sampleRate).toBe(48000);
  });

  it("drops the sampleRate hint on iOS while keeping the channel layout", async () => {
    const { microphoneConstraints: mc } = await importWith(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      5,
    );
    const c = mc("dev", false, true);
    expect("sampleRate" in c).toBe(false);
    expect(c.channelCount).toBe(2);
  });
});
