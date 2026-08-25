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
  buildTrackMp4Args,
  buildVideoMixArgs,
  captureExtension,
  gridLayout,
  pairTracks,
  type RecorderMeta,
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

// --- Video rooms ----------------------------------------------------------
// Everything below covers the picture path, which only ever runs in a video
// room. The audio-room expectations above are the guard that it stays that way.

describe("buildSdp / sdpParamsFromRtp (video)", () => {
  it("writes a video media line with no channel count", () => {
    const sdp = buildSdp({
      port: 50002,
      payloadType: 96,
      codec: "VP8",
      clockRate: 90000,
      channels: 2,
      ssrc: 42,
      kind: "video",
    });
    assert.ok(sdp.includes("m=video 50002 RTP/AVP 96"));
    assert.ok(sdp.includes("a=rtpmap:96 VP8/90000"));
    assert.ok(!sdp.includes("VP8/90000/"), "a video rtpmap must not carry channels");
    assert.ok(sdp.includes("a=ssrc:42 cname:sonicroom"));
  });

  it("derives kind + case-preserved codec name from a video mimeType", () => {
    const rtp = {
      codecs: [
        {
          mimeType: "video/VP8",
          payloadType: 96,
          clockRate: 90000,
          parameters: {},
          rtcpFeedback: [],
        },
      ],
      encodings: [{ ssrc: 7 }],
      headerExtensions: [],
      rtcp: {},
    } as unknown as RtpParameters;
    const p = sdpParamsFromRtp(rtp, 50010);
    assert.equal(p.kind, "video");
    assert.equal(p.codec, "VP8"); // NOT lowercased — SDP codec names are case-sensitive
    assert.equal(p.clockRate, 90000);
  });

  it("still reports audio for an opus producer", () => {
    const rtp = {
      codecs: [
        { mimeType: "audio/opus", payloadType: 100, clockRate: 48000, channels: 2, parameters: {} },
      ],
      encodings: [{ ssrc: 1 }],
    } as unknown as RtpParameters;
    assert.equal(sdpParamsFromRtp(rtp, 50000).kind, "audio");
  });
});

describe("buildCaptureArgs / captureExtension (video)", () => {
  it("remuxes a picture stream to WebM with -c:v copy", () => {
    const args = buildCaptureArgs("/tmp/in.sdp", "/tmp/out.webm", "video");
    assert.ok(args.includes("-c:v"));
    assert.equal(args[args.indexOf("-c:v") + 1], "copy");
    assert.ok(!args.includes("-c:a"), "no audio codec flag on a picture capture");
    assert.deepEqual(args.slice(-2), ["-y", "/tmp/out.webm"]);
  });

  it("leaves the audio capture untouched", () => {
    assert.deepEqual(
      buildCaptureArgs("/a.sdp", "/a.ogg"),
      buildCaptureArgs("/a.sdp", "/a.ogg", "audio"),
    );
    assert.equal(captureExtension("audio"), "ogg");
    assert.equal(captureExtension("video"), "webm");
  });
});

describe("gridLayout", () => {
  it("uses the squarest grid that holds n", () => {
    assert.deepEqual([gridLayout(1).cols, gridLayout(1).rows], [1, 1]);
    assert.deepEqual([gridLayout(2).cols, gridLayout(2).rows], [2, 1]);
    assert.deepEqual([gridLayout(3).cols, gridLayout(3).rows], [2, 2]);
    assert.deepEqual([gridLayout(4).cols, gridLayout(4).rows], [2, 2]);
    assert.deepEqual([gridLayout(9).cols, gridLayout(9).rows], [3, 3]);
  });

  it("places each cell at its own corner of the canvas", () => {
    const g = gridLayout(4);
    assert.equal(g.width, 1280);
    assert.equal(g.height, 720);
    assert.deepEqual(
      g.cells.map((c) => [c.x, c.y]),
      [
        [0, 0],
        [640, 0],
        [0, 360],
        [640, 360],
      ],
    );
  });

  it("shrinks the cell instead of growing past the max canvas width", () => {
    const big = gridLayout(25); // 5x5
    assert.ok(big.width <= 1920, `canvas ${big.width} wide`);
    assert.ok(big.cells[0].w < 640);
  });

  it("keeps every dimension even (H.264 requires it)", () => {
    for (let n = 1; n <= 20; n++) {
      const g = gridLayout(n);
      assert.equal(g.width % 2, 0, `n=${n} width`);
      assert.equal(g.height % 2, 0, `n=${n} height`);
      assert.equal(g.cells[0].w % 2, 0, `n=${n} cell w`);
      assert.equal(g.cells[0].h % 2, 0, `n=${n} cell h`);
    }
  });

  it("refuses an empty grid", () => {
    assert.throws(() => gridLayout(0));
  });
});

describe("buildTrackMp4Args", () => {
  it("muxes one peer's picture with their own voice, aligned and padded", () => {
    const args = buildTrackMp4Args({
      video: { path: "/tmp/cam.webm", delayMs: 4000 },
      audio: { path: "/tmp/voice.ogg", delayMs: 0 },
      totalMs: 30000,
    });
    // both captures are inputs, picture first
    assert.deepEqual(
      args.filter((a, i) => args[i - 1] === "-i"),
      ["/tmp/cam.webm", "/tmp/voice.ogg"],
    );
    const filter = args[args.indexOf("-filter_complex") + 1];
    // picture: constant rate, pinned frame size, black lead-in for the 4s the
    // camera was off, black run-out past the end
    assert.ok(filter.includes("fps=25"));
    assert.ok(filter.includes("scale=1280:720:force_original_aspect_ratio=decrease"));
    assert.ok(filter.includes("tpad=start_duration=4.000:start_mode=add:color=black"));
    assert.ok(filter.includes("tpad=stop_duration=30.000"));
    // sound: gap-filled + run out to the shared length
    assert.ok(filter.includes("aresample=async=1"));
    assert.ok(filter.includes("apad"));
    // one shared length for every entry in the zip
    assert.equal(args[args.indexOf("-t") + 1], "30.000");
    assert.ok(args.includes("libx264"));
    assert.ok(args.includes("aac"));
    // an MP4 on a pipe cannot be faststart-ed — it must be fragmented
    assert.equal(
      args[args.indexOf("-movflags") + 1],
      "+frag_keyframe+empty_moov+default_base_moof",
    );
    assert.deepEqual(args.slice(-2), ["mp4", "pipe:1"]);
  });

  it("gives a silent picture a real (silent) stereo track", () => {
    const args = buildTrackMp4Args({
      video: { path: "/tmp/screen.webm", delayMs: 0 },
      totalMs: 5000,
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.ok(filter.includes("anullsrc=channel_layout=stereo"));
    assert.equal(args.filter((a) => a === "-i").length, 1);
    // no lead-in filter when the picture starts with the recording
    assert.ok(!filter.includes("tpad=start_duration"));
  });
});

describe("buildVideoMixArgs", () => {
  it("lays every picture on a generated black canvas and mixes all the sound", () => {
    const args = buildVideoMixArgs({
      video: [
        { path: "/tmp/a.webm", delayMs: 0 },
        { path: "/tmp/b.webm", delayMs: 2000 },
      ],
      audio: [
        { path: "/tmp/a.ogg", delayMs: 0 },
        { path: "/tmp/b.ogg", delayMs: 2000 },
      ],
      totalMs: 12000,
    });
    // picture inputs first, then sound — the filter indices below depend on it
    assert.deepEqual(
      args.filter((a, i) => args[i - 1] === "-i"),
      ["/tmp/a.webm", "/tmp/b.webm", "/tmp/a.ogg", "/tmp/b.ogg"],
    );
    const filter = args[args.indexOf("-filter_complex") + 1];
    // full-size, full-length black background so a late/short camera just
    // leaves black rather than resizing or shortening the output
    assert.ok(filter.includes("color=c=black:s=1280x360:r=25:d=12.000[bg]"));
    assert.ok(filter.includes("[0:v]"));
    assert.ok(filter.includes("[1:v]"));
    assert.ok(filter.includes("overlay=x=0:y=0"));
    assert.ok(filter.includes("overlay=x=640:y=0"));
    // a camera that stops goes back to black instead of freezing its last frame
    assert.ok(filter.includes("eof_action=pass:repeatlast=0"));
    // sound indices continue after the picture inputs
    assert.ok(filter.includes("[2:a]"));
    assert.ok(filter.includes("[3:a]"));
    assert.ok(filter.includes("amix=inputs=2:normalize=0[aout]"));
    assert.ok(filter.includes("adelay=2000:all=1"));
    assert.equal(args[args.indexOf("-t") + 1], "12.000");
    assert.deepEqual(args.slice(-2), ["mp4", "pipe:1"]);
  });

  it("still produces a silent stereo track when nothing was captured with sound", () => {
    const args = buildVideoMixArgs({
      video: [{ path: "/tmp/a.webm", delayMs: 0 }],
      audio: [],
      totalMs: 1000,
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.ok(filter.includes("anullsrc"));
    assert.ok(!filter.includes("amix"));
  });

  it("refuses a mix with no picture (that is the audio path's job)", () => {
    assert.throws(() => buildVideoMixArgs({ video: [], audio: [], totalMs: 1000 }));
  });
});

describe("pairTracks", () => {
  const rec = (o: Partial<RecorderMeta> & { peerId: string }): RecorderMeta => ({
    label: undefined,
    source: "voice",
    kind: "audio",
    path: `/tmp/${o.peerId}-${o.source ?? "voice"}.ogg`,
    delayMs: 0,
    ...o,
  });

  it("leaves an all-audio recording exactly as the audio path had it", () => {
    const entries = pairTracks([
      rec({ peerId: "a", label: "Alice" }),
      rec({ peerId: "b", label: "Bob", source: "share", delayMs: 3000 }),
      rec({ peerId: "c", label: "Eco", source: "music", delayMs: 6000 }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.name),
      ["01-Alice.ogg", "02-Bob-share.ogg", "03-Eco-music.ogg"],
    );
    assert.ok(entries.every((e) => !e.video));
  });

  it("folds a peer's camera and their voice into one mp4", () => {
    const entries = pairTracks([
      rec({ peerId: "a", label: "Alice" }),
      rec({
        peerId: "a",
        label: "Alice",
        source: "camera",
        kind: "video",
        path: "/tmp/a-cam.webm",
        delayMs: 5000,
      }),
    ]);
    assert.equal(entries.length, 1, "the voice is not also emitted on its own");
    assert.equal(entries[0].name, "01-Alice.mp4");
    assert.deepEqual(entries[0].video, { path: "/tmp/a-cam.webm", delayMs: 5000 });
    assert.deepEqual(entries[0].audio, { path: "/tmp/a-voice.ogg", delayMs: 0 });
  });

  it("pairs a screen share's picture with the share's own audio", () => {
    const entries = pairTracks([
      rec({ peerId: "a", label: "Alice" }),
      rec({ peerId: "a", label: "Alice", source: "share", delayMs: 1000 }),
      rec({
        peerId: "a",
        label: "Alice",
        source: "screen",
        kind: "video",
        path: "/tmp/a-screen.webm",
        delayMs: 1000,
      }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.name),
      ["01-Alice.ogg", "02-Alice-screen.mp4"],
    );
    // the voice stays its own track (no camera to ride on); the share's audio
    // goes under the screen picture
    assert.equal(entries[0].video, undefined);
    assert.deepEqual(entries[1].audio, { path: "/tmp/a-share.ogg", delayMs: 1000 });
  });

  it("keeps a silent screen share as a picture-only mp4", () => {
    const entries = pairTracks([
      rec({
        peerId: "a",
        label: "Alice",
        source: "screen",
        kind: "video",
        path: "/tmp/a-screen.webm",
      }),
    ]);
    assert.equal(entries[0].name, "01-Alice-screen.mp4");
    assert.equal(entries[0].audio, undefined);
    assert.ok(entries[0].video);
  });

  it("never duplicates the voice when a camera is cycled off and on", () => {
    const entries = pairTracks([
      rec({ peerId: "a", label: "Alice" }),
      rec({
        peerId: "a",
        label: "Alice",
        source: "camera",
        kind: "video",
        path: "/tmp/a-cam1.webm",
        delayMs: 1000,
      }),
      rec({
        peerId: "a",
        label: "Alice",
        source: "camera",
        kind: "video",
        path: "/tmp/a-cam2.webm",
        delayMs: 9000,
      }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.name),
      ["01-Alice.mp4", "02-Alice-camera.mp4"],
    );
    assert.deepEqual(entries[0].audio, { path: "/tmp/a-voice.ogg", delayMs: 0 });
    assert.equal(entries[1].audio, undefined, "the voice rides only the first camera");
    assert.equal(entries.filter((e) => e.audio?.path === "/tmp/a-voice.ogg").length, 1);
  });

  it("still names a muted peer's camera as their track", () => {
    // Their voice capture was header-only and got filtered out before pairing,
    // so there is nothing to mux — the picture is still their track.
    const entries = pairTracks([
      rec({
        peerId: "a",
        label: "Alice",
        source: "camera",
        kind: "video",
        path: "/tmp/a-cam.webm",
      }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.name),
      ["01-Alice.mp4"],
    );
    assert.equal(entries[0].audio, undefined);
  });

  it("orders entries chronologically and numbers them in that order", () => {
    const entries = pairTracks([
      rec({ peerId: "b", label: "Bob", delayMs: 8000 }),
      rec({
        peerId: "a",
        label: "Alice",
        source: "camera",
        kind: "video",
        path: "/tmp/a-cam.webm",
        delayMs: 2000,
      }),
      rec({ peerId: "a", label: "Alice", delayMs: 0 }),
      rec({ peerId: "c", label: "Eco", source: "music", delayMs: 15000 }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.name),
      ["01-Alice.mp4", "02-Bob.ogg", "03-Eco-music.ogg"],
    );
  });

  it("leaves extra mics and streamed files as their own audio tracks", () => {
    const entries = pairTracks([
      rec({
        peerId: "a",
        label: "Alice",
        source: "camera",
        kind: "video",
        path: "/tmp/a-cam.webm",
      }),
      rec({ peerId: "a", label: "Alice" }),
      rec({ peerId: "a", label: "Alice", source: "mic", delayMs: 100 }),
      rec({ peerId: "a", label: "Alice", source: "file", delayMs: 200 }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.name),
      ["01-Alice.mp4", "02-Alice-mic.ogg", "03-Alice-file.ogg"],
    );
  });
});
