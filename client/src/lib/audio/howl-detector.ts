// Acoustic-feedback ("howl") detector for the outgoing mic. Pure: feed it the
// mic's pre-filter spectrum (AnalyserNode.getFloatFrequencyData, dB) on each
// poll and it returns the notch filters to apply and whether to duck the mic.
//
// A howl is a narrow tone that holds its pitch and keeps rising. Criteria (see
// the feedback-control literature, e.g. van Waterschoot & Moonen "Fifty years of
// acoustic feedback control", and open howling-suppression implementations):
//   - height: peak ≥ 30 dB over the local median (±~750 Hz). Speech measured on
//     real calls stays under ~25 dB.
//   - narrowness (PNPR): peak ≥ 12 dB over the bins ±3..6 away (a voice
//     harmonic or a noise band is wider than that).
//   - absolute level ≥ -60 dBFS (ignores faint fan / coil whine).
//   - persistence: same frequency (±2 bins) for ≥ 250 ms (≥ 500 ms below 2 kHz,
//     where whistles and sung vowels live), measured in wall time so a
//     background tab's 1 s timer throttling still detects it on the 2nd poll.
//   - growth: rising ≥ 3 dB/s, or already ≥ 40 dB high (a steady note doesn't grow).
// The cut feeds back only what the mic sends; a loop outside the app (another
// device's speakers) keeps ringing locally, so notches are deep (up to 40 dB)
// and a too-loud tone ducks the whole mic.

export const HOWL = {
  minHz: 300,
  maxHz: 16000,
  medianHalfWidth: 64,
  heightDb: 30,
  pnprDb: 12,
  floorDb: -60,
  persistMs: 250,
  persistLowMs: 500,
  lowHz: 2000,
  growthDbPerS: 3,
  tallDb: 40,
  // Notch depth follows the tone: -(height - 15) dB, clamped to 0..40.
  depthOffsetDb: 15,
  maxDepthDb: 40,
  maxNotches: 3,
  // Reuse a notch only for (nearly) the same tone: two howls ~640 Hz apart
  // were measured at once, and sharing one notch made it swing between them.
  reuseOctaves: 1 / 24,
  holdMs: 3000,
  releaseAfterMs: 10000,
  releaseBelowDb: 15,
  // Duck the whole mic when a confirmed tone gets this loud (dBFS).
  // Analyser scale, not waveform scale: a full-scale 4 kHz tone reads about
  // -14.6 dB in getFloatFrequencyData (Blackman window + the spec's
  // normalisation), so a "-10 dBFS" threshold could never be reached and the
  // duck would never fire. -22 dB is roughly a half-scale tone (about -6 dBFS
  // peak), well above speech bins and comfortably inside a real howl's range.
  duckAtDbfs: -22,
  duckHoldMs: 1000,
};

export interface Notch {
  hz: number;
  gainDb: number; // ≤ 0
}

export interface HowlState {
  // Fixed-length (HOWL.maxNotches); a slot keeps its index so a filter never
  // jumps to another tone when a different slot is released.
  notches: (Notch | null)[];
  duck: boolean;
}

interface Track {
  bin: number;
  firstMs: number;
  lastMs: number;
  firstDb: number;
  lastDb: number;
}

interface Slot {
  hz: number;
  bin: number;
  gainDb: number;
  sinceMs: number; // when the slot was (re)triggered
  lastHotMs: number; // last poll where the tone was still ≥ releaseBelowDb high
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

export class HowlDetector {
  private tracks: Track[] = [];
  private slots: (Slot | null)[] = new Array(HOWL.maxNotches).fill(null);
  private duckUntilMs = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly fftSize: number,
  ) {}

  private hzOf(bin: number): number {
    return (bin * this.sampleRate) / this.fftSize;
  }

  // Candidate tonal peaks in this frame: { bin (fractional), level, height }.
  private candidates(db: Float32Array) {
    const lo = Math.max(7, Math.ceil(HOWL.minHz / this.hzOf(1)));
    const hi = Math.min(db.length - 7, Math.floor(HOWL.maxHz / this.hzOf(1)));
    const local: { bin: number; level: number }[] = [];
    for (let i = lo; i < hi; i++) {
      const v = db[i];
      if (v < HOWL.floorDb || v < db[i - 1] || v < db[i + 1]) continue;
      local.push({ bin: i, level: v });
    }
    // Only the loudest few need the (costlier) local-median test.
    local.sort((a, b) => b.level - a.level);
    const out: { bin: number; level: number; height: number }[] = [];
    for (const { bin, level } of local.slice(0, 8)) {
      let side = -Infinity;
      for (let k = 3; k <= 6; k++) side = Math.max(side, db[bin - k], db[bin + k]);
      if (level - side < HOWL.pnprDb) continue;
      const a = Math.max(0, bin - HOWL.medianHalfWidth);
      const b = Math.min(db.length, bin + HOWL.medianHalfWidth + 1);
      const around: number[] = [];
      for (let j = a; j < b; j++) around.push(Number.isFinite(db[j]) ? db[j] : -200);
      const height = level - median(around);
      if (height < HOWL.heightDb) continue;
      // Parabolic interpolation of the true peak between bins.
      const l = db[bin - 1];
      const r = db[bin + 1];
      const denom = l - 2 * level + r;
      const offset = denom !== 0 ? (0.5 * (l - r)) / denom : 0;
      out.push({ bin: bin + Math.max(-0.5, Math.min(0.5, offset)), level, height });
    }
    return out;
  }

  // One poll. `db` is the pre-notch spectrum; `nowMs` a monotonic clock.
  update(db: Float32Array, nowMs: number): HowlState {
    const found = this.candidates(db);

    // Track candidates across polls (same frequency within ±2 bins).
    const tracks: Track[] = [];
    for (const c of found) {
      const prev = this.tracks.find((t) => Math.abs(t.bin - c.bin) <= 2);
      tracks.push(
        prev
          ? { ...prev, bin: c.bin, lastMs: nowMs, lastDb: c.height }
          : { bin: c.bin, firstMs: nowMs, lastMs: nowMs, firstDb: c.height, lastDb: c.height },
      );
    }
    this.tracks = tracks;

    let duck = false;
    for (const t of tracks) {
      const hz = this.hzOf(t.bin);
      const age = t.lastMs - t.firstMs;
      if (age < (hz < HOWL.lowHz ? HOWL.persistLowMs : HOWL.persistMs)) continue;
      const growth = ((t.lastDb - t.firstDb) * 1000) / Math.max(age, 1);
      if (growth < HOWL.growthDbPerS && t.lastDb < HOWL.tallDb) continue;
      this.confirm(t, hz, nowMs);
      const peak = found.find((c) => c.bin === t.bin)!;
      if (peak.level >= HOWL.duckAtDbfs) duck = true;
    }

    // Keep existing notches tracking their tone; release quiet ones.
    for (const s of this.slots) {
      if (!s) continue;
      const c = found.find((f) => Math.abs(f.bin - s.bin) <= 2);
      if (c && c.height >= HOWL.releaseBelowDb) {
        s.lastHotMs = nowMs;
        s.gainDb = -Math.min(HOWL.maxDepthDb, Math.max(0, c.height - HOWL.depthOffsetDb));
      }
    }
    this.slots = this.slots.map((s) =>
      s && (nowMs - s.sinceMs < HOWL.holdMs || nowMs - s.lastHotMs < HOWL.releaseAfterMs) ? s : null,
    );

    if (duck) this.duckUntilMs = nowMs + HOWL.duckHoldMs;
    return {
      notches: this.slots.map((s) => (s ? { hz: s.hz, gainDb: s.gainDb } : null)),
      duck: duck || nowMs < this.duckUntilMs,
    };
  }

  private confirm(t: Track, hz: number, nowMs: number) {
    const depth = -Math.min(HOWL.maxDepthDb, Math.max(0, t.lastDb - HOWL.depthOffsetDb));
    const near = this.slots.find((s) => s && Math.abs(Math.log2(s.hz / hz)) < HOWL.reuseOctaves);
    if (near) {
      Object.assign(near, { hz, bin: t.bin, gainDb: Math.min(near.gainDb, depth), lastHotMs: nowMs });
      return;
    }
    const free = this.slots.indexOf(null);
    if (free < 0) {
      // Out of notches: the whole mic ducks instead (caller sees duck=true).
      this.duckUntilMs = nowMs + HOWL.duckHoldMs;
      return;
    }
    this.slots[free] = { hz, bin: t.bin, gainDb: depth, sinceMs: nowMs, lastHotMs: nowMs };
  }
}
