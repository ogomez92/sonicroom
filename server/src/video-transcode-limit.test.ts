import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeTranscodeCount,
  MAX_CONCURRENT_VIDEO_TRANSCODES,
  streamFallbackVideo,
  TranscodeBusyError,
} from "./audio-sources.js";

describe("video transcode cap", () => {
  it("defaults far below the audio cap (VP8 is expensive)", () => {
    assert.ok(MAX_CONCURRENT_VIDEO_TRANSCODES <= 4);
  });

  it("rejects as busy once the video cap is reached, without taking a shared slot", async () => {
    await assert.rejects(
      streamFallbackVideo("http://1.1.1.1/live.ts", { maxConcurrentVideoTranscodes: 0 }),
      (err) => err instanceof TranscodeBusyError,
    );
    assert.equal(activeTranscodeCount(), 0);
  });
});
