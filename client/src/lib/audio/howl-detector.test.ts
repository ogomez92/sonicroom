import { describe, it, expect } from "vitest";
import { HOWL, HowlDetector } from "./howl-detector";

// Bin layout matches the graph: fftSize 4096 at 48 kHz → 11.72 Hz per bin.
const SR = 48000;
const FFT = 4096;
const BIN_HZ = SR / FFT;
const FLOOR_DB = -80;

const hzToBin = (hz: number) => Math.round(hz / BIN_HZ);

// A spectrum with a flat noise floor and an optional narrow peak (one bin, like
// a real howl) or a wide plateau (like a voiced harmonic).
function spectrum(opts: { peakHz?: number; levelDb?: number; wide?: number }) {
  const db = new Float32Array(FFT / 2).fill(FLOOR_DB);
  if (opts.peakHz === undefined) return db;
  const bin = hzToBin(opts.peakHz);
  db[bin] = opts.levelDb!;
  // `wide` mirrors the peak onto ±N neighbours, which is what defeats the
  // narrowness (PNPR) test.
  for (let k = 1; k <= (opts.wide ?? 0); k++) {
    db[bin - k] = opts.levelDb!;
    db[bin + k] = opts.levelDb!;
  }
  return db;
}

// Poll every 50 ms, the graph's interval, growing the tone at `dbPerS`.
function run(d: HowlDetector, steps: number, levelAt: (ms: number) => number, hz = 4000) {
  let state = d.update(spectrum({ peakHz: hz, levelDb: -100 }), 0);
  for (let i = 0; i < steps; i++) {
    const ms = i * 50;
    state = d.update(spectrum({ peakHz: hz, levelDb: levelAt(ms) }), ms);
  }
  return state;
}

describe("HowlDetector", () => {
  it("notches a narrow tone that holds its pitch and rises", () => {
    const d = new HowlDetector(SR, FFT);
    // -50 dBFS rising ~15 dB/s, the rate measured on a real howl.
    const state = run(d, 8, (ms) => -50 + 15 * (ms / 1000));
    expect(state.notches[0]).not.toBeNull();
    expect(Math.abs(state.notches[0]!.hz - 4000)).toBeLessThan(20);
    expect(state.notches[0]!.gainDb).toBeLessThan(-15);
    expect(state.duck).toBe(false);
  });

  it("does not notch a wide peak (a voiced harmonic)", () => {
    const d = new HowlDetector(SR, FFT);
    for (let i = 0; i < 20; i++) {
      d.update(spectrum({ peakHz: 4000, levelDb: -20 + i, wide: 4 }), i * 50);
    }
    expect(d.update(spectrum({ peakHz: 4000, levelDb: 0, wide: 4 }), 1000).notches).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("does not notch a steady tone that is quiet and not growing", () => {
    const d = new HowlDetector(SR, FFT);
    const state = run(d, 40, () => -45); // height 35 dB, flat
    expect(state.notches).toEqual([null, null, null]);
  });

  it("notches a steady tone once it is tall enough on its own", () => {
    const d = new HowlDetector(SR, FFT);
    const state = run(d, 8, () => -38); // height 42 dB ≥ tallDb
    expect(state.notches[0]).not.toBeNull();
  });

  it("needs persistence: one loud frame is not enough", () => {
    const d = new HowlDetector(SR, FFT);
    d.update(spectrum({ peakHz: 4000, levelDb: -100 }), 0);
    const state = d.update(spectrum({ peakHz: 4000, levelDb: -20 }), 50);
    expect(state.notches).toEqual([null, null, null]);
  });

  it("ducks a howl that is loud in analyser terms", () => {
    // A full-scale 4 kHz tone measures about -14.6 dB from
    // getFloatFrequencyData, so that is the realistic ceiling of a howl; the
    // duck threshold has to sit below it or the duck can never fire.
    const d = new HowlDetector(SR, FFT);
    const state = run(d, 8, (ms) => -35 + 60 * (ms / 1000)); // reaches -14
    expect(state.duck).toBe(true);
  });

  it("notches but does not duck a moderate tone", () => {
    const d = new HowlDetector(SR, FFT);
    const state = run(d, 8, (ms) => -40 + 40 * (ms / 1000)); // reaches -26
    expect(state.notches[0]).not.toBeNull();
    expect(state.duck).toBe(false);
  });

  it("keeps separate notches for two howls ~640 Hz apart", () => {
    const d = new HowlDetector(SR, FFT);
    let state = d.update(spectrum({ peakHz: 4000, levelDb: -100 }), 0);
    for (let i = 0; i < 8; i++) {
      const ms = i * 50;
      const level = -50 + 15 * (ms / 1000);
      const db = spectrum({ peakHz: 4000, levelDb: level });
      const bin2 = hzToBin(4640);
      db[bin2] = level;
      state = d.update(db, ms);
    }
    const hz = state.notches.filter(Boolean).map((n) => n!.hz);
    expect(hz).toHaveLength(2);
    expect(Math.abs(hz[0] - hz[1])).toBeGreaterThan(600);
  });

  it("holds a notch then releases it once the tone is gone", () => {
    const d = new HowlDetector(SR, FFT);
    run(d, 8, (ms) => -50 + 15 * (ms / 1000));
    expect(d.update(spectrum({ peakHz: 4000, levelDb: -100 }), 5000).notches[0]).not.toBeNull();
    expect(d.update(spectrum({ peakHz: 4000, levelDb: -100 }), 11000).notches[0]).toBeNull();
  });

  it("ignores tones outside the 300 Hz–16 kHz band", () => {
    const d = new HowlDetector(SR, FFT);
    const state = run(d, 8, (ms) => -50 + 15 * (ms / 1000), 120);
    expect(state.notches).toEqual([null, null, null]);
  });

  it("has room for maxNotches and ducks only when they run out", () => {
    const d = new HowlDetector(SR, FFT);
    for (let i = 0; i < 30; i++) {
      const db = spectrum({ peakHz: 2500, levelDb: -100 });
      for (let k = 0; k < 4; k++) db[hzToBin(2500 + k * 700)] = -50 + i;
      d.update(db, i * 50);
    }
    const state = d.update(spectrum({ peakHz: 2500, levelDb: -100 }), 1500);
    expect(state.notches).toHaveLength(HOWL.maxNotches);
    expect(state.notches.filter(Boolean)).toHaveLength(HOWL.maxNotches);
  });
});
