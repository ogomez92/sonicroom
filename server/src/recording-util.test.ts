import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RtpParameters } from "mediasoup/types";
import {
  PortAllocator,
  buildSdp,
  sdpParamsFromRtp,
  buildCaptureArgs,
  buildMixArgs,
  buildPadArgs,
  decideMode,
  computeDelayMs,
  trackFileName,
} from "./recording-util.js";

describe("PortAllocator", () => {
  it("hands out distinct ports within the range", () => {
    const a = new PortAllocator(50000, 50004, 2);
    const p1 = a.allocate();
    const p2 = a.allocate();
    const p3 = a.allocate();
    assert.equal(new Set([p1, p2, p3]).size, 3);
    for (const p of [p1, p2, p3]) {
      assert.ok(p >= 50000 && p <= 50004);
    }
    assert.equal(a.size, 3);
  });

  it("spaces ports by the step so RTP/RTCP pairs never collide", () => {
    // ffmpeg opens RTCP at port+1, so consecutive recorders must be >=2 apart.
    const a = new PortAllocator(50000, 50998, 2);
    const ports = [a.allocate(), a.allocate(), a.allocate()].sort((x, y) => x - y);
    assert.deepEqual(ports, [50000, 50002, 50004]);
    for (const p of ports) assert.equal(p % 2, 0);
  });

  it("reuses a released port and never double-allocates", () => {
    const a = new PortAllocator(50000, 50002, 2);
    const p1 = a.allocate();
    const p2 = a.allocate();
    a.release(p1);
    const p3 = a.allocate();
    assert.equal(p3, p1);
    assert.notEqual(p3, p2);
    assert.equal(a.size, 2);
  });

  it("throws when exhausted", () => {
    const a = new PortAllocator(50000, 50000, 2);
    a.allocate();
    assert.throws(() => a.allocate(), /no free ports/);
  });

  it("rejects an invalid range", () => {
    assert.throws(() => new PortAllocator(50001, 50000));
  });
});

describe("buildSdp", () => {
  it("produces a valid recvonly SDP with fmtp and ssrc", () => {
    const sdp = buildSdp({
      port: 50000,
      payloadType: 100,
      codec: "opus",
      clockRate: 48000,
      channels: 2,
      ssrc: 12345,
      fmtp: { minptime: 10, useinbandfec: 1 },
    });
    assert.ok(sdp.includes("m=audio 50000 RTP/AVP 100"));
    assert.ok(sdp.includes("a=rtpmap:100 opus/48000/2"));
    assert.ok(sdp.includes("a=fmtp:100 minptime=10;useinbandfec=1"));
    assert.ok(sdp.includes("a=ssrc:12345 cname:sonicroom"));
    assert.ok(sdp.includes("a=recvonly"));
    assert.ok(sdp.includes("c=IN IP4 127.0.0.1"));
    assert.ok(sdp.endsWith("\n"));
  });

  it("omits fmtp/ssrc lines when not provided", () => {
    const sdp = buildSdp({
      port: 50001,
      payloadType: 111,
      codec: "opus",
      clockRate: 48000,
      channels: 1,
    });
    assert.ok(!sdp.includes("a=fmtp"));
    assert.ok(!sdp.includes("a=ssrc"));
    assert.ok(sdp.includes("a=rtpmap:111 opus/48000/1"));
  });
});

describe("sdpParamsFromRtp", () => {
  it("derives codec/payload/ssrc from rtpParameters", () => {
    const rtp = {
      codecs: [
        {
          mimeType: "audio/opus",
          payloadType: 100,
          clockRate: 48000,
          channels: 2,
          parameters: { minptime: 10 },
          rtcpFeedback: [],
        },
      ],
      encodings: [{ ssrc: 999 }],
      headerExtensions: [],
      rtcp: {},
    } as unknown as RtpParameters;
    const p = sdpParamsFromRtp(rtp, 50005);
    assert.equal(p.port, 50005);
    assert.equal(p.payloadType, 100);
    assert.equal(p.codec, "opus");
    assert.equal(p.clockRate, 48000);
    assert.equal(p.channels, 2);
    assert.equal(p.ssrc, 999);
    assert.deepEqual(p.fmtp, { minptime: 10 });
  });

  it("throws when there is no codec", () => {
    const rtp = { codecs: [], encodings: [] } as unknown as RtpParameters;
    assert.throws(() => sdpParamsFromRtp(rtp, 50000));
  });
});

describe("buildCaptureArgs", () => {
  it("captures RTP from an SDP file to a copied Ogg with frequent flushing", () => {
    const args = buildCaptureArgs("/tmp/in.sdp", "/tmp/out.ogg");
    assert.ok(args.includes("-protocol_whitelist"));
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,udp,rtp");
    assert.deepEqual(args.slice(args.indexOf("-i")), [
      "-i",
      "/tmp/in.sdp",
      "-c:a",
      "copy",
      "-flush_packets",
      "1",
      "-y",
      "/tmp/out.ogg",
    ]);
  });
});

describe("buildMixArgs", () => {
  it("copies a single zero-offset input straight to stdout", () => {
    const args = buildMixArgs([{ path: "/tmp/a.ogg", delayMs: 0 }]);
    assert.deepEqual(args, [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-i",
      "/tmp/a.ogg",
      "-c:a",
      "copy",
      "-f",
      "ogg",
      "pipe:1",
    ]);
  });

  it("mixes multiple inputs with per-input delay and no volume normalization", () => {
    const args = buildMixArgs([
      { path: "/tmp/a.ogg", delayMs: 0 },
      { path: "/tmp/b.ogg", delayMs: 1500 },
    ]);
    const fc = args[args.indexOf("-filter_complex") + 1];
    assert.ok(fc.includes("[0:a]aformat=channel_layouts=stereo,aresample=async=1[a0]"));
    assert.ok(
      fc.includes("[1:a]aformat=channel_layouts=stereo,aresample=async=1,adelay=1500:all=1[a1]"),
    );
    assert.ok(fc.includes("amix=inputs=2:normalize=0[out]"));
    assert.deepEqual(args.slice(-2), ["ogg", "pipe:1"]);
    assert.ok(args.includes("libopus"));
  });

  it("re-encodes a single delayed input (cannot copy with a filter)", () => {
    const args = buildMixArgs([{ path: "/tmp/a.ogg", delayMs: 800 }]);
    assert.ok(args.includes("-filter_complex"));
    assert.ok(args.includes("libopus"));
  });

  it("throws when there are no inputs", () => {
    assert.throws(() => buildMixArgs([]));
  });
});

describe("buildPadArgs", () => {
  it("pads a delayed track with leading silence and a fixed total length", () => {
    const args = buildPadArgs({ path: "/tmp/a.ogg", delayMs: 5000, totalMs: 600000 });
    const af = args[args.indexOf("-af") + 1];
    // gaps filled, then shifted by the offset, then padded out to the end
    assert.equal(af, "aresample=async=1,adelay=5000:all=1,apad");
    // -t caps the (now infinite, via apad) output at the full span, in seconds
    assert.equal(args[args.indexOf("-t") + 1], "600.000");
    // a filter forces a re-encode (cannot -c:a copy) and an Ogg stream to stdout
    assert.ok(args.includes("libopus"));
    assert.deepEqual(args.slice(-2), ["ogg", "pipe:1"]);
  });

  it("omits adelay for a zero-offset track but still pads to total length", () => {
    const args = buildPadArgs({ path: "/tmp/a.ogg", delayMs: 0, totalMs: 12500 });
    const af = args[args.indexOf("-af") + 1];
    assert.equal(af, "aresample=async=1,apad");
    assert.equal(args[args.indexOf("-t") + 1], "12.500");
  });

  it("rounds the delay and clamps a negative total to zero", () => {
    const args = buildPadArgs({ path: "/tmp/a.ogg", delayMs: 1499.6, totalMs: -100 });
    assert.ok(args[args.indexOf("-af") + 1].includes("adelay=1500:all=1"));
    assert.equal(args[args.indexOf("-t") + 1], "0.000");
  });
});

describe("decideMode", () => {
  it("requires SFU for 3+ peers", () => {
    assert.deepEqual(decideMode(3, "p2p", false), { mode: "sfu", action: "switch-to-sfu" });
    assert.deepEqual(decideMode(5, "sfu", false), { mode: "sfu", action: "none" });
  });

  it("uses P2P for <=2 peers when not recording", () => {
    assert.deepEqual(decideMode(2, "sfu", false), { mode: "p2p", action: "switch-to-p2p" });
    assert.deepEqual(decideMode(1, "p2p", false), { mode: "p2p", action: "none" });
  });

  it("forces SFU when forceSfu is set even with <=2 peers", () => {
    // forceSfu is true while recording OR while a music caster is present.
    assert.deepEqual(decideMode(2, "p2p", true), { mode: "sfu", action: "switch-to-sfu" });
    assert.deepEqual(decideMode(1, "sfu", true), { mode: "sfu", action: "none" });
  });

  it("never downgrades to P2P while forceSfu holds", () => {
    const d = decideMode(2, "sfu", true);
    assert.equal(d.action, "none");
    assert.equal(d.mode, "sfu");
  });

  it("a 2-peer room with a caster (user + Ecobox) stays SFU", () => {
    // user + caster = 2 peers; forceSfu (caster present) keeps it on the SFU.
    assert.deepEqual(decideMode(2, "p2p", true), { mode: "sfu", action: "switch-to-sfu" });
    // caster leaves -> 1 peer, not forced -> back to P2P.
    assert.deepEqual(decideMode(1, "sfu", false), { mode: "p2p", action: "switch-to-p2p" });
  });
});

describe("computeDelayMs", () => {
  it("returns the offset of a recorder from the recording start", () => {
    assert.equal(computeDelayMs(1000, 1000), 0);
    assert.equal(computeDelayMs(1000, 4500), 3500);
  });

  it("clamps negative offsets to zero", () => {
    assert.equal(computeDelayMs(5000, 4000), 0);
  });
});

describe("trackFileName", () => {
  it("uses a 1-based index prefix and the display name", () => {
    assert.equal(trackFileName({ peerId: "x", label: "Alice" }, 0), "01-Alice.ogg");
    assert.equal(trackFileName({ peerId: "x", label: "Bob" }, 1), "02-Bob.ogg");
  });

  it("appends the source only when it isn't plain voice", () => {
    assert.equal(trackFileName({ peerId: "x", label: "Al", source: "voice" }, 0), "01-Al.ogg");
    assert.equal(
      trackFileName({ peerId: "x", label: "Al", source: "share" }, 0),
      "01-Al-share.ogg",
    );
    assert.equal(
      trackFileName({ peerId: "x", label: "Eco", source: "music" }, 2),
      "03-Eco-music.ogg",
    );
  });

  it("falls back to the peer id when there is no label", () => {
    assert.equal(trackFileName({ peerId: "sock-42" }, 0), "01-sock-42.ogg");
    assert.equal(trackFileName({ peerId: "sock-42", label: "   " }, 0), "01-sock-42.ogg");
  });

  it("sanitizes names and stays unique via the index prefix", () => {
    // same display name, different index -> still distinct files
    assert.equal(trackFileName({ peerId: "a", label: "DJ / Río!" }, 0), "01-DJ_R_o.ogg");
    assert.equal(trackFileName({ peerId: "b", label: "DJ / Río!" }, 1), "02-DJ_R_o.ogg");
  });

  it("never yields an empty base name", () => {
    assert.equal(trackFileName({ peerId: "???", label: "***" }, 0), "01-track.ogg");
  });
});
