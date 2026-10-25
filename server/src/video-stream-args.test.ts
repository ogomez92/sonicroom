import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFfmpegVideoStreamArgs } from "./audio-sources.js";

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("buildFfmpegVideoStreamArgs", () => {
  it("retries 5xx so a briefly-stopping IPTV channel doesn't fail the stream", () => {
    const args = buildFfmpegVideoStreamArgs("http://host/live/123.ts");
    assert.equal(after(args, "-reconnect_on_http_error"), "5xx");
    assert.equal(after(args, "-reconnect_delay_max"), "3");
    assert.equal(after(args, "-i"), "http://host/live/123.ts");
  });
});
