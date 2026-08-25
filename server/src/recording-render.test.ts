import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, createWriteStream, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildSdp,
  buildCaptureArgs,
  buildTrackMp4Args,
  buildVideoMixArgs,
} from "./recording-util.js";

// --- Does the rendered file actually play? --------------------------------
// Every other test in this repo drives ffmpeg through a fake spawn and asserts
// on the argv. That proves we ASK for the right thing; it cannot prove the
// result is a file anyone can open. Video rooms hand people an MP4, so this
// suite runs the REAL ffmpeg over real VP8/Opus captures and then looks at the
// output: does it decode without errors, is it the right size and length, is
// there sound on it, and — the part argv can never show — is the picture
// actually where and when it should be? Frames are sampled as raw RGB and
// checked pixel by pixel: black before a camera came on, that camera's colour
// after, each camera in its own grid cell.
//
// Skipped (not failed) where ffmpeg isn't installed, so the suite stays green
// on a machine without it; the server needs ffmpeg to record at all.

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function have(bin: string): boolean {
  try {
    return spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
const canRender = have(FFMPEG) && have(FFPROBE);

// Run ffmpeg/ffprobe to completion, collecting stderr (and stdout as bytes when
// the caller wants the raw output, e.g. a decoded frame).
function run(
  bin: string,
  args: string[],
  opts: { toFile?: string } = {},
): Promise<{ code: number | null; stderr: string; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const errChunks: Buffer[] = [];
    const outChunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
    if (opts.toFile) {
      const out = createWriteStream(opts.toFile);
      proc.stdout.pipe(out);
      out.on("error", reject);
    } else {
      proc.stdout.on("data", (d: Buffer) => outChunks.push(d));
    }
    proc.on("error", reject);
    proc.on("close", (code) =>
      resolve({
        code,
        stderr: Buffer.concat(errChunks).toString(),
        stdout: Buffer.concat(outChunks),
      }),
    );
  });
}

async function ffmpegOk(args: string[], toFile?: string): Promise<void> {
  const { code, stderr } = await run(FFMPEG, args, { toFile });
  assert.equal(code, 0, `ffmpeg failed (${code}):\n${stderr}`);
}

// One decoded frame of `file` at `atSec`, as raw RGB. Decoding from the start
// (output-side -ss) rather than seeking keeps the sample exact.
async function frame(file: string, atSec: number, width: number, height: number): Promise<Buffer> {
  const { code, stdout, stderr } = await run(FFMPEG, [
    "-v",
    "error",
    "-i",
    file,
    "-ss",
    String(atSec),
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ]);
  assert.equal(code, 0, `frame grab failed:\n${stderr}`);
  assert.equal(
    stdout.length,
    width * height * 3,
    `expected one ${width}x${height} RGB frame at ${atSec}s, got ${stdout.length} bytes`,
  );
  return stdout;
}

const pixel = (buf: Buffer, width: number, x: number, y: number) => {
  const i = (y * width + x) * 3;
  return { r: buf[i], g: buf[i + 1], b: buf[i + 2] };
};

// Colour checks are loose on purpose: the fixtures go through VP8, a yuv420p
// H.264 re-encode and a scale, so "red" is never exactly 255,0,0.
const isBlack = (p: { r: number; g: number; b: number }) => p.r < 48 && p.g < 48 && p.b < 48;
const isRed = (p: { r: number; g: number; b: number }) => p.r > 140 && p.g < 90 && p.b < 90;
const isBlue = (p: { r: number; g: number; b: number }) => p.b > 140 && p.r < 90 && p.g < 90;
const show = (p: { r: number; g: number; b: number }) => `rgb(${p.r},${p.g},${p.b})`;

async function probe(file: string, entries: string): Promise<Record<string, string>> {
  const { code, stdout, stderr } = await run(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    entries,
    "-of",
    "default=noprint_wrappers=1",
    file,
  ]);
  assert.equal(code, 0, `ffprobe failed:\n${stderr}`);
  const out: Record<string, string> = {};
  for (const line of stdout.toString().split("\n")) {
    const [k, ...rest] = line.split("=");
    if (k && rest.length) out[k] = rest.join("=");
  }
  return out;
}

// Count the frames that actually DECODE — the strongest cheap statement that a
// file plays, and the length of the output in one number (25 fps, so 250
// frames is 10 seconds).
async function videoFrames(file: string): Promise<number> {
  const { code, stdout, stderr } = await run(FFPROBE, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  assert.equal(code, 0, `frame count failed:\n${stderr}`);
  return Number(stdout.toString().trim());
}

// Mean volume in dBFS. -inf (reported as "-inf") means pure silence.
async function meanVolume(file: string): Promise<number> {
  const { stderr } = await run(FFMPEG, [
    "-v",
    "info",
    "-i",
    file,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  assert.ok(m, `no mean_volume in ffmpeg output:\n${stderr}`);
  return m[1] === "-inf" ? -Infinity : Number(m[1]);
}

// Decode the whole file with errors fatal — nothing should be reported.
async function decodesCleanly(file: string): Promise<void> {
  const { code, stderr } = await run(FFMPEG, ["-v", "error", "-i", file, "-f", "null", "-"]);
  assert.equal(code, 0, `decode failed:\n${stderr}`);
  assert.equal(stderr.trim(), "", `decode reported errors:\n${stderr}`);
}

describe(
  "rendered video downloads (real ffmpeg)",
  { skip: !canRender && "ffmpeg/ffprobe not installed" },
  () => {
    let dir: string;
    const f = (name: string) => path.join(dir, name);

    before(async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "sonicroom-render-"));
      // Stand-ins for what the capture ffmpeg writes: VP8-in-WebM pictures and
      // an Opus-in-Ogg voice track. Flat colours make the pixel assertions below
      // unambiguous.
      await ffmpegOk([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=640x360:r=25:d=6",
        "-c:v",
        "libvpx",
        "-b:v",
        "400k",
        "-y",
        f("cam-red.webm"),
      ]);
      await ffmpegOk([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=640x360:r=25:d=4",
        "-c:v",
        "libvpx",
        "-b:v",
        "400k",
        "-y",
        f("cam-blue.webm"),
      ]);
      await ffmpegOk([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=6",
        "-c:a",
        "libopus",
        "-b:a",
        "96k",
        "-y",
        f("voice.ogg"),
      ]);
      // Short, because the RTP round trip below sends it in real time.
      await ffmpegOk([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=640x360:r=25:d=2",
        "-c:v",
        "libvpx",
        "-b:v",
        "400k",
        "-y",
        f("cam-short.webm"),
      ]);
    });

    after(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("captures a VP8 RTP stream through our SDP into a playable WebM", async () => {
      // The riskiest new piece: the SDP we hand ffmpeg for a camera producer, and
      // the capture argv that remuxes it. Push our own fixture over real RTP on
      // loopback and check what lands on disk.
      const port = 50600;
      const sdp = buildSdp({
        port,
        payloadType: 96,
        codec: "VP8",
        clockRate: 90000,
        channels: 2,
        kind: "video",
      });
      writeFileSync(f("cam.sdp"), sdp);

      const receiver = spawn(FFMPEG, buildCaptureArgs(f("cam.sdp"), f("captured.webm"), "video"), {
        stdio: ["ignore", "ignore", "pipe"],
      });
      const done = new Promise<void>((resolve) => receiver.on("close", () => resolve()));
      await new Promise((r) => setTimeout(r, 700)); // let it bind the UDP port

      await ffmpegOk([
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-i",
        f("cam-short.webm"),
        "-c:v",
        "copy",
        "-f",
        "rtp",
        "-payload_type",
        "96",
        `rtp://127.0.0.1:${port}`,
      ]);
      await new Promise((r) => setTimeout(r, 500));
      // SIGINT is what stopRecorder sends. ffmpeg's RTP demuxer can sit in a
      // blocking read for its own timeout before noticing, and this test should
      // not wait that out — the capture is flushed per packet and WebM is a
      // streamable container, so what is already on disk is complete either way.
      receiver.kill("SIGINT");
      await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
      receiver.kill("SIGKILL");
      await done;

      const info = await probe(f("captured.webm"), "stream=codec_name,width,height");
      assert.equal(info.codec_name, "vp8", "the capture is a remux — the payload stays VP8");
      assert.equal(info.width, "640");
      assert.equal(info.height, "360");
      assert.ok(statSync(f("captured.webm")).size > 1024);
      await decodesCleanly(f("captured.webm"));
    });

    it("renders one peer's track as an MP4 with their picture and their voice", async () => {
      // Alice's camera came on 2s into a 10s recording and ran 6s.
      const args = buildTrackMp4Args({
        video: { path: f("cam-red.webm"), delayMs: 2000 },
        audio: { path: f("voice.ogg"), delayMs: 0 },
        totalMs: 10000,
      });
      await ffmpegOk(args, f("track.mp4"));

      const info = await probe(f("track.mp4"), "stream=width,height");
      assert.equal(info.width, "1280");
      assert.equal(info.height, "720");

      // both streams, so the file is a normal A/V MP4 and not a picture with a
      // codec no player expects
      const kinds = (
        await run(FFPROBE, [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,codec_name",
          "-of",
          "csv=p=0",
          f("track.mp4"),
        ])
      ).stdout
        .toString()
        .trim()
        .split("\n")
        .sort();
      assert.deepEqual(kinds, ["aac,audio", "h264,video"]);

      await decodesCleanly(f("track.mp4"));
      // 10s at 25 fps — padded past the end of a 6s camera, so every entry in the
      // per-track zip is the same length.
      const frames = await videoFrames(f("track.mp4"));
      assert.ok(Math.abs(frames - 250) <= 3, `expected ~250 frames, got ${frames}`);

      // ...and the picture is in the right place on the timeline.
      const at = async (t: number) =>
        pixel(await frame(f("track.mp4"), t, 1280, 720), 1280, 640, 360);
      const before = await at(1);
      const during = await at(4);
      const afterEnd = await at(9);
      assert.ok(isBlack(before), `camera was off at 1s, got ${show(before)}`);
      assert.ok(isRed(during), `camera was on at 4s, got ${show(during)}`);
      assert.ok(isBlack(afterEnd), `camera had stopped by 9s, got ${show(afterEnd)}`);

      // and there is real sound on it
      assert.ok((await meanVolume(f("track.mp4"))) > -50, "the peer's voice is on the MP4");
    });

    it("gives a silent screen share a picture-only MP4 that still plays", async () => {
      const args = buildTrackMp4Args({
        video: { path: f("cam-blue.webm"), delayMs: 0 },
        totalMs: 5000,
      });
      await ffmpegOk(args, f("silent.mp4"));
      await decodesCleanly(f("silent.mp4"));
      const p = pixel(await frame(f("silent.mp4"), 1, 1280, 720), 1280, 640, 360);
      assert.ok(isBlue(p), `expected the shared picture, got ${show(p)}`);
      // a silent stereo track, not a missing one — players and NLEs prefer it.
      // (AAC encodes digital silence at about -91 dBFS, never a true -inf.)
      const kinds = (
        await run(FFPROBE, [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type",
          "-of",
          "csv=p=0",
          f("silent.mp4"),
        ])
      ).stdout
        .toString()
        .trim()
        .split("\n")
        .sort();
      assert.deepEqual(kinds, ["audio", "video"]);
      assert.ok((await meanVolume(f("silent.mp4"))) < -80, "the picture-only entry is silent");
    });

    it("renders the whole call as one MP4 grid with everyone's audio", async () => {
      // Alice from the start, Bob's camera 2s in; both on a 10s recording.
      const args = buildVideoMixArgs({
        video: [
          { path: f("cam-red.webm"), delayMs: 0 },
          { path: f("cam-blue.webm"), delayMs: 2000 },
        ],
        audio: [{ path: f("voice.ogg"), delayMs: 0 }],
        totalMs: 10000,
      });
      await ffmpegOk(args, f("call.mp4"));

      const info = await probe(f("call.mp4"), "stream=width,height");
      assert.equal(info.width, "1280", "two cameras side by side");
      assert.equal(info.height, "360");
      await decodesCleanly(f("call.mp4"));
      const frames = await videoFrames(f("call.mp4"));
      assert.ok(Math.abs(frames - 250) <= 3, `expected ~250 frames, got ${frames}`);

      const cell = async (t: number) => {
        const buf = await frame(f("call.mp4"), t, 1280, 360);
        return {
          left: pixel(buf, 1280, 320, 180),
          right: pixel(buf, 1280, 960, 180),
        };
      };

      // 1s: Alice is up, Bob's cell is still black
      const early = await cell(1);
      assert.ok(isRed(early.left), `left cell at 1s: ${show(early.left)}`);
      assert.ok(isBlack(early.right), `right cell at 1s: ${show(early.right)}`);

      // 4s: both cameras live, each in its own cell
      const both = await cell(4);
      assert.ok(isRed(both.left), `left cell at 4s: ${show(both.left)}`);
      assert.ok(isBlue(both.right), `right cell at 4s: ${show(both.right)}`);

      // 9s: both cameras have stopped — cells go back to black rather than
      // freezing on the last frame
      const late = await cell(9);
      assert.ok(isBlack(late.left), `left cell at 9s: ${show(late.left)}`);
      assert.ok(isBlack(late.right), `right cell at 9s: ${show(late.right)}`);

      assert.ok((await meanVolume(f("call.mp4"))) > -50, "the room's audio is on the call MP4");
    });
  },
);
