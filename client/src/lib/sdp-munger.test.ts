import { describe, it, expect } from "vitest";
import { forceOpusParams } from "./sdp-munger";

// A representative offer SDP with one Opus fmtp line (the only line the munger
// rewrites — it keys on `a=fmtp:` + "minptime"), plus lines it must leave alone.
const SDP = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 110",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1;stereo=0",
  "a=rtpmap:110 telephone-event/48000",
  "a=fmtp:110 0-15",
].join("\r\n");

function opusFmtp(sdp: string): string {
  return sdp.split("\r\n").find((l) => l.startsWith("a=fmtp:111"))!;
}
function params(fmtp: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of fmtp.substring(fmtp.indexOf(" ") + 1).split(";")) {
    const [k, v] = p.split("=");
    m.set(k, v ?? "");
  }
  return m;
}

describe("forceOpusParams", () => {
  it("defaults to mono 64 kbps low-latency voice", () => {
    const out = forceOpusParams(SDP);
    const p = params(opusFmtp(out));
    expect(p.get("stereo")).toBe("0");
    expect(p.get("sprop-stereo")).toBe("0");
    expect(p.get("maxaveragebitrate")).toBe("64000");
    expect(p.get("useinbandfec")).toBe("1");
    expect(p.get("minptime")).toBe("10");
    expect(p.get("ptime")).toBe("10");
    expect(p.get("maxplaybackrate")).toBe("48000");
    expect(p.get("usedtx")).toBe("0");
  });

  it("sets stereo 128 kbps when hifi is requested", () => {
    const p = params(opusFmtp(forceOpusParams(SDP, true)));
    expect(p.get("stereo")).toBe("1");
    expect(p.get("sprop-stereo")).toBe("1");
    expect(p.get("maxaveragebitrate")).toBe("128000");
  });

  it("preserves the payload type and only touches the Opus fmtp line", () => {
    const out = forceOpusParams(SDP, true);
    expect(opusFmtp(out).startsWith("a=fmtp:111 ")).toBe(true);
    // The telephone-event fmtp (no minptime) is untouched.
    expect(out).toContain("a=fmtp:110 0-15");
    expect(out).toContain("a=rtpmap:111 opus/48000/2");
  });

  it("keeps CRLF line endings and line count", () => {
    const out = forceOpusParams(SDP);
    expect(out.split("\r\n").length).toBe(SDP.split("\r\n").length);
  });

  it("is a no-op on SDP without an Opus fmtp line", () => {
    const noOpus = ["v=0", "m=audio 9 RTP 0", "a=rtpmap:0 PCMU/8000"].join("\r\n");
    expect(forceOpusParams(noOpus, true)).toBe(noOpus);
  });

  it("overwrites pre-existing stereo/bitrate values", () => {
    const hostile = "a=fmtp:111 minptime=10;stereo=1;maxaveragebitrate=510000";
    const p = params(opusFmtp(forceOpusParams(hostile, false)));
    expect(p.get("stereo")).toBe("0");
    expect(p.get("maxaveragebitrate")).toBe("64000");
  });
});
