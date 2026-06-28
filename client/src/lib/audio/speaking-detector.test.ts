import { describe, it, expect } from "vitest";
import { rms, pushRecentSpeaker, nextSpeaking } from "./speaking-detector";

describe("rms", () => {
  it("is 0 for silence", () => {
    expect(rms(new Float32Array(512))).toBe(0);
  });

  it("equals the constant level of a DC buffer", () => {
    const buf = new Float32Array(256).fill(0.012);
    expect(rms(buf)).toBeCloseTo(0.012, 6); // pins the SPEAK_THRESHOLD scale
  });

  it("computes the root-mean-square of a known buffer", () => {
    // [3, 4] → sqrt((9+16)/2) = sqrt(12.5)
    expect(rms(new Float32Array([3, 4]))).toBeCloseTo(Math.sqrt(12.5), 6);
  });
});

describe("pushRecentSpeaker", () => {
  it("prepends a new speaker", () => {
    expect(pushRecentSpeaker([], "a", 12)).toEqual(["a"]);
    expect(pushRecentSpeaker(["a"], "b", 12)).toEqual(["b", "a"]);
  });

  it("moves an existing speaker to the front (dedupe)", () => {
    expect(pushRecentSpeaker(["a", "b", "c"], "c", 12)).toEqual(["c", "a", "b"]);
  });

  it("truncates to the keep cap", () => {
    expect(pushRecentSpeaker(["b", "c"], "a", 2)).toEqual(["a", "b"]);
  });
});

describe("nextSpeaking", () => {
  const threshold = 0.012;
  const hold = 600;

  it("rises to speaking when the level crosses the threshold (stamps loudAt)", () => {
    expect(nextSpeaking(0.02, undefined, 1000, threshold, hold)).toEqual({
      loudAt: 1000,
      speaking: true,
    });
  });

  it("stays speaking while still within the hold of the last loud moment", () => {
    // below threshold now, but loud 500ms ago (< 600ms hold)
    expect(nextSpeaking(0.001, 1000, 1500, threshold, hold)).toEqual({
      loudAt: 1000,
      speaking: true,
    });
  });

  it("falls silent once the hold has elapsed", () => {
    // below threshold, last loud 700ms ago (> 600ms hold)
    expect(nextSpeaking(0.001, 1000, 1700, threshold, hold)).toEqual({
      loudAt: 1000,
      speaking: false,
    });
  });

  it("is silent with no prior loud moment", () => {
    expect(nextSpeaking(0.001, undefined, 1000, threshold, hold)).toEqual({
      loudAt: undefined,
      speaking: false,
    });
  });
});
