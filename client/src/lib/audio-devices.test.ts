import { describe, it, expect, vi, afterEach } from "vitest";
import { canSelectSpeaker, applySpeakerToContext } from "./audio-devices";
import { FakeAudioContext } from "../test/webaudio-mock";

// `applySpeakerToContext` takes a real `AudioContext`; the fake is structurally
// compatible, so cast through `unknown` to satisfy the signature in tests.
const asCtx = (ctx: FakeAudioContext) => ctx as unknown as AudioContext;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("canSelectSpeaker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is true when AudioContext exists with setSinkId on its prototype", () => {
    // The fake installs setSinkId on AudioContext.prototype in setup.
    expect("setSinkId" in AudioContext.prototype).toBe(true);
    expect(canSelectSpeaker()).toBe(true);
  });

  it("is false when setSinkId is missing from the prototype (e.g. Safari)", () => {
    const proto = AudioContext.prototype as unknown as { setSinkId?: unknown };
    const orig = proto.setSinkId;
    try {
      delete proto.setSinkId;
      expect("setSinkId" in AudioContext.prototype).toBe(false);
      expect(canSelectSpeaker()).toBe(false);
    } finally {
      proto.setSinkId = orig;
    }
  });

  it("is false when AudioContext itself is undefined", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(canSelectSpeaker()).toBe(false);
  });

  it("recovers (true again) after the global is restored", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(canSelectSpeaker()).toBe(false);
    vi.unstubAllGlobals();
    expect(canSelectSpeaker()).toBe(true);
  });
});

describe("applySpeakerToContext", () => {
  it("calls setSinkId with the requested device id", () => {
    const ctx = new FakeAudioContext();
    applySpeakerToContext(asCtx(ctx), "device-123");
    // The fake records the chosen sink synchronously.
    expect(ctx.sinkId).toBe("device-123");
  });

  it("forwards exactly the id passed (single call for a good device)", () => {
    const ctx = new FakeAudioContext();
    const spy = vi.spyOn(ctx, "setSinkId");
    applySpeakerToContext(asCtx(ctx), "good-device");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("good-device");
  });

  it('falls back to the default output ("") when the device id rejects', async () => {
    const ctx = new FakeAudioContext();
    ctx.sinkId = "previous-device"; // prove the retry actually re-sets it
    const spy = vi.spyOn(ctx, "setSinkId");

    expect(() => applySpeakerToContext(asCtx(ctx), "bad-sink")).not.toThrow();
    await flush();

    // First the bad id (which rejects), then the empty-string fallback.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, "bad-sink");
    expect(spy).toHaveBeenNthCalledWith(2, "");
    expect(ctx.sinkId).toBe("");
  });

  it("does not retry when an empty id rejects (no infinite loop)", async () => {
    const ctx = new FakeAudioContext();
    const spy = vi.spyOn(ctx, "setSinkId").mockRejectedValue(new Error("nope"));
    expect(() => applySpeakerToContext(asCtx(ctx), "")).not.toThrow();
    await flush();
    // deviceId is "" so the fallback branch (which only fires for a truthy id)
    // is skipped — exactly one attempt.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("");
  });

  it("is a safe no-op when the context has no setSinkId", () => {
    const ctx = new FakeAudioContext();
    // Shadow the prototype method so the instance reports no support.
    (ctx as unknown as { setSinkId?: unknown }).setSinkId = undefined;
    ctx.sinkId = "untouched";
    expect(() => applySpeakerToContext(asCtx(ctx), "device-9")).not.toThrow();
    expect(ctx.sinkId).toBe("untouched");
  });
});
