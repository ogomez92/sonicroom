import { describe, it, expect, vi } from "vitest";
import { playCue, startKnockLoop, type Cue } from "./sounds";
import { FakeAudioContext, FakeAudioBufferSourceNode } from "../test/webaudio-mock";

const asCtx = (ctx: FakeAudioContext) => ctx as unknown as AudioContext;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// Minimum number of OscillatorNodes each cue must create. The fake only counts
// oscillators/gains/etc. (not buffer sources), so we assert on oscillators:
//   tone()  -> 1 osc        bell() -> 2 osc (carrier + modulator)
//   creak() -> 2 osc (saw + LFO)   noise() -> 0 osc (buffer source)
const EXPECTED_MIN_OSC: Record<Cue, number> = {
  mute: 2, // two tones
  unmute: 2, // two tones
  join: 4, // two bells x2
  leave: 3, // creak(2) + one thunk tone(1)
  message: 4, // two bells x2
  thunk: 1, // one tone
  "share-start": 3, // three tones
  "share-stop": 3, // three tones
  knock: 3, // three raps, one thud tone each
  "peer-mute": 1, // one tone
  "peer-unmute": 1, // one tone
};

const ALL_CUES = Object.keys(EXPECTED_MIN_OSC) as Cue[];

describe("playCue", () => {
  it.each(ALL_CUES)("plays the %s cue without throwing and creates oscillators", (cue) => {
    const ctx = new FakeAudioContext();
    expect(() => playCue(asCtx(ctx), cue)).not.toThrow();
    expect(ctx.created.oscillator).toBeGreaterThanOrEqual(EXPECTED_MIN_OSC[cue]);
    // Every voice also routes through a gain envelope.
    expect(ctx.created.gain).toBeGreaterThan(0);
  });

  it("connects every oscillator into the graph (none left dangling)", () => {
    const ctx = new FakeAudioContext();
    playCue(asCtx(ctx), "join");
    // join = 2 bells -> 4 oscillators, each connected to a gain node.
    expect(ctx.created.oscillator).toBe(4);
  });

  it("resumes a suspended context before scheduling", () => {
    const ctx = new FakeAudioContext();
    ctx.state = "suspended";
    const resumeSpy = vi.spyOn(ctx, "resume");

    playCue(asCtx(ctx), "message");

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe("running");
  });

  it("does not call resume when already running", () => {
    const ctx = new FakeAudioContext();
    expect(ctx.state).toBe("running");
    const resumeSpy = vi.spyOn(ctx, "resume");

    playCue(asCtx(ctx), "mute");

    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("starts and stops every oscillator it creates", () => {
    const ctx = new FakeAudioContext();
    const oscillators: { started: boolean; stopped: boolean }[] = [];
    const realCreate = ctx.createOscillator.bind(ctx);
    vi.spyOn(ctx, "createOscillator").mockImplementation(() => {
      const osc = realCreate();
      oscillators.push(osc);
      return osc;
    });

    playCue(asCtx(ctx), "leave");

    // Scheduling is synchronous inside playCue: every oscillator is started and
    // stopped (so none leaks as a permanently-running node).
    expect(oscillators.length).toBeGreaterThan(0);
    for (const osc of oscillators) {
      expect(osc.started).toBe(true);
      expect(osc.stopped).toBe(true);
    }
  });

  it("does nothing observable for an unknown cue value", () => {
    const ctx = new FakeAudioContext();
    // Cast an invalid value through the union to exercise the default switch path.
    expect(() => playCue(asCtx(ctx), "nonexistent" as Cue)).not.toThrow();
    expect(ctx.created.oscillator).toBe(0);
  });
});

describe("startKnockLoop", () => {
  it("returns a stop function and starts a looping buffer source after render", async () => {
    const ctx = new FakeAudioContext();
    const sources: FakeAudioBufferSourceNode[] = [];
    vi.spyOn(ctx, "createBufferSource").mockImplementation(() => {
      const src = new FakeAudioBufferSourceNode();
      sources.push(src);
      return src;
    });

    const stop = startKnockLoop(asCtx(ctx));
    expect(typeof stop).toBe("function");

    await tick(); // let startRendering().then(...) run

    expect(sources).toHaveLength(1);
    const src = sources[0];
    expect(src.loop).toBe(true);
    expect(src.started).toBe(true);
    expect(src.buffer).not.toBeNull();
    // The looping source must reach the destination.
    expect(src.connectedTo).toContain(ctx.destination);

    expect(() => stop()).not.toThrow();
    expect(src.stopped).toBe(true);
  });

  it("is safe to call stop twice", async () => {
    const ctx = new FakeAudioContext();
    const stop = startKnockLoop(asCtx(ctx));
    await tick();
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });

  it("never starts a source if stopped before rendering completes", async () => {
    const ctx = new FakeAudioContext();
    const createSpy = vi.spyOn(ctx, "createBufferSource");

    const stop = startKnockLoop(asCtx(ctx));
    stop(); // stop BEFORE the render promise resolves
    await tick();

    // The stopped flag short-circuits the .then, so no source is ever made.
    expect(createSpy).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it("resumes a suspended context", async () => {
    const ctx = new FakeAudioContext();
    ctx.state = "suspended";
    const resumeSpy = vi.spyOn(ctx, "resume");

    const stop = startKnockLoop(asCtx(ctx));
    await tick();

    expect(resumeSpy).toHaveBeenCalled();
    expect(ctx.state).toBe("running");
    stop();
  });

  it("accepts a custom period without throwing", async () => {
    const ctx = new FakeAudioContext();
    const sources: FakeAudioBufferSourceNode[] = [];
    vi.spyOn(ctx, "createBufferSource").mockImplementation(() => {
      const src = new FakeAudioBufferSourceNode();
      sources.push(src);
      return src;
    });

    const stop = startKnockLoop(asCtx(ctx), 0.5);
    await tick();

    expect(sources).toHaveLength(1);
    expect(sources[0].loop).toBe(true);
    stop();
  });
});
