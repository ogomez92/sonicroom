import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn as nodeSpawn } from "node:child_process";
import {
  activeTranscodeCount,
  assertPublicAudioUrl,
  buildAudioTranscodeArgs,
  buildFfmpegStreamArgs,
  buildYtDlpArgs,
  classifyLibraryEntries,
  isAudioContentType,
  isAudioFileName,
  isPrivateAddress,
  looksLikeDirectStream,
  looksLikeStreamContentType,
  resolveLibraryPath,
  streamAudioWithFfmpeg,
  streamAudioWithYtDlp,
  streamFallbackAudio,
  TranscodeBusyError,
} from "./audio-sources.js";

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

// --- Fake spawn harness ------------------------------------------------------
// The transcode resolvers take an injected `spawn`, so their process lifecycle
// (first-byte gating, teardown, timeout, routing) is testable with no real
// ffmpeg/yt-dlp — the same pattern RecordingManager/StreamManager use.
class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill(): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.stdout.end();
    return true;
  }
}

function makeFakeSpawn() {
  const procs: FakeChildProcess[] = [];
  const calls: { cmd: string; args: string[] }[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    const proc = new FakeChildProcess();
    procs.push(proc);
    calls.push({ cmd, args });
    return proc;
  }) as unknown as typeof nodeSpawn;
  return { spawn, procs, calls };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(condition: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error("waitFor: condition never became true");
}

// A public IP literal: dns.lookup short-circuits IP literals (no network), so
// these URLs pass the SSRF guard without touching real DNS.
const PUBLIC_TS = "http://1.1.1.1/live/stream.ts"; // direct media -> ffmpeg first
const PUBLIC_SITE = "https://1.1.1.1/watch?v=abc"; // no media ext -> yt-dlp first

describe("isAudioFileName", () => {
  it("allows supported root-level audio files", () => {
    assert.equal(isAudioFileName("show.mp3"), true);
    assert.equal(isAudioFileName("MIX.OPUS"), true);
  });

  it("rejects paths, hidden files and unrelated extensions", () => {
    assert.equal(isAudioFileName("../show.mp3"), false);
    assert.equal(isAudioFileName(".secret.mp3"), false);
    assert.equal(isAudioFileName("notes.txt"), false);
  });
});

describe("isPrivateAddress", () => {
  it("blocks local and private addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.2", "::1", "fd00::1", "fe80::1"]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it("blocks SSRF-favourite ranges: cloud metadata, CGNAT, and IPv4-mapped IPv6", () => {
    for (const address of [
      "169.254.169.254", // AWS/GCP/Azure link-local metadata endpoint
      "100.64.0.1", // CGNAT (RFC 6598)
      "0.0.0.0", // "this host"
      "172.16.5.5", // private /12 mid-range
      "198.18.0.1", // benchmarking range
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:169.254.169.254", // IPv4-mapped metadata
      "fc00::1", // unique-local
      "::", // unspecified
    ]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it("allows public addresses", () => {
    assert.equal(isPrivateAddress("1.1.1.1"), false);
    assert.equal(isPrivateAddress("8.8.8.8"), false);
    assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
    assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false);
  });

  it("treats malformed input as private (fail closed)", () => {
    assert.equal(isPrivateAddress("not-an-ip"), true);
    assert.equal(isPrivateAddress(""), true);
  });
});

describe("resolveLibraryPath", () => {
  const root = "/srv/media";

  it("resolves the root and nested subfolders to normalized relative paths", () => {
    assert.deepEqual(resolveLibraryPath(root, ""), { abs: "/srv/media", rel: "" });
    assert.deepEqual(resolveLibraryPath(root, "movies"), {
      abs: "/srv/media/movies",
      rel: "movies",
    });
    assert.deepEqual(resolveLibraryPath(root, "a/b/c.mp3"), {
      abs: "/srv/media/a/b/c.mp3",
      rel: "a/b/c.mp3",
    });
  });

  it("neutralizes leading slashes and backslashes (no absolute escape)", () => {
    // A leading slash is stripped, so it's read as relative to the root.
    assert.equal(resolveLibraryPath(root, "/etc/passwd")?.rel, "etc/passwd");
    assert.equal(resolveLibraryPath(root, "sub\\track.mp3")?.rel, "sub/track.mp3");
  });

  it("rejects any path that climbs out of the root", () => {
    for (const bad of ["..", "../etc", "a/../../etc", "sub/../../../etc/passwd", "..\\..\\x"]) {
      assert.equal(resolveLibraryPath(root, bad), null, bad);
    }
  });

  it("rejects a sibling-directory prefix attack", () => {
    // `/srv/media-evil` must not pass as if it were under `/srv/media`.
    assert.equal(resolveLibraryPath(root, "../media-evil/x.mp3"), null);
  });
});

describe("classifyLibraryEntries", () => {
  const dirent = (name: string, kind: "dir" | "file") => ({
    name,
    isDirectory: kind === "dir",
    isFile: kind === "file",
  });

  it("lists folders first then audio files, each A–Z", () => {
    const out = classifyLibraryEntries([
      dirent("zebra.mp3", "file"),
      dirent("Movies", "dir"),
      dirent("apple.flac", "file"),
      dirent("Albums", "dir"),
    ]);
    assert.deepEqual(out, [
      { name: "Albums", dir: true },
      { name: "Movies", dir: true },
      { name: "apple.flac", dir: false },
      { name: "zebra.mp3", dir: false },
    ]);
  });

  it("drops dotfiles/dotfolders, non-audio files, and symlinks", () => {
    const out = classifyLibraryEntries([
      dirent(".hidden", "dir"),
      dirent(".secret.mp3", "file"),
      dirent("notes.txt", "file"),
      { name: "link.mp3", isDirectory: false, isFile: false }, // symlink: neither
      dirent("ok.ogg", "file"),
      dirent("Sub", "dir"),
    ]);
    assert.deepEqual(out, [
      { name: "Sub", dir: true },
      { name: "ok.ogg", dir: false },
    ]);
  });
});

describe("isAudioContentType", () => {
  it("allows audio responses and rejects general proxy content", () => {
    assert.equal(isAudioContentType("audio/mpeg"), true);
    assert.equal(isAudioContentType("application/ogg; charset=binary"), true);
    assert.equal(isAudioContentType("application/octet-stream"), false);
    assert.equal(isAudioContentType("text/html"), false);
  });
});

describe("buildYtDlpArgs", () => {
  it("extracts best audio to stdout without a cache or playlist", () => {
    const args = buildYtDlpArgs("https://www.youtube.com/watch?v=abc");
    assert.equal(after(args, "-f"), "bestaudio/best");
    assert.equal(after(args, "-o"), "-");
    assert.ok(args.includes("--no-playlist"));
    assert.ok(args.includes("--no-cache-dir"));
  });

  it("passes the URL after `--` so a hostile '-…' URL is never read as a flag", () => {
    const args = buildYtDlpArgs("-malicious");
    assert.equal(args.at(-2), "--");
    assert.equal(args.at(-1), "-malicious");
  });
});

describe("buildAudioTranscodeArgs", () => {
  it("drops video and emits a progressive Opus/WebM stream to stdout", () => {
    const args = buildAudioTranscodeArgs();
    assert.ok(args.includes("-vn"));
    assert.equal(after(args, "-ac"), "2");
    assert.equal(after(args, "-c:a"), "libopus");
    assert.equal(after(args, "-f"), "webm");
    assert.equal(args.at(-1), "pipe:1");
  });
});

describe("looksLikeDirectStream", () => {
  it("matches IPTV / HLS / DASH / raw media URLs (ignoring query + port)", () => {
    for (const url of [
      "http://stream.example.com:8080/u/p/2902375.ts",
      "https://cdn.example.com/live/stream.m3u8?token=abc",
      "https://example.com/manifest.mpd",
      "https://example.com/song.mp3",
    ]) {
      assert.equal(looksLikeDirectStream(url), true, url);
    }
  });

  it("does not match site pages (which need yt-dlp extraction)", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=abc",
      "https://youtu.be/abc",
      "https://soundcloud.com/artist/track",
      "not a url",
    ]) {
      assert.equal(looksLikeDirectStream(url), false, url);
    }
  });
});

describe("looksLikeStreamContentType", () => {
  it("matches media-stream types so extension-less IPTV URLs go to ffmpeg", () => {
    for (const ct of [
      "video/mp2t",
      "application/octet-stream",
      "application/vnd.apple.mpegurl",
      "application/dash+xml; charset=utf-8",
    ]) {
      assert.equal(looksLikeStreamContentType(ct), true, ct);
    }
  });

  it("does not match web pages or plain audio", () => {
    assert.equal(looksLikeStreamContentType("text/html"), false);
    assert.equal(looksLikeStreamContentType("application/json"), false);
    // audio/* is served by the direct proxy, not treated as a transcode stream.
    assert.equal(looksLikeStreamContentType("audio/mpeg"), false);
  });
});

describe("buildFfmpegStreamArgs", () => {
  it("opens the URL with a restricted protocol set and emits Opus/WebM", () => {
    const args = buildFfmpegStreamArgs("http://host/live/123.ts");
    // No `file:` etc. — a hostile playlist can't make ffmpeg read local disk.
    assert.equal(after(args, "-protocol_whitelist"), "http,https,tcp,tls,crypto");
    assert.equal(after(args, "-i"), "http://host/live/123.ts");
    assert.ok(args.includes("-vn"));
    assert.equal(after(args, "-ac"), "2");
    assert.equal(after(args, "-c:a"), "libopus");
    assert.equal(args.at(-1), "pipe:1");
  });
});

describe("assertPublicAudioUrl (SSRF guard entry point)", () => {
  it("rejects private, loopback and cloud-metadata targets", async () => {
    for (const url of [
      "http://127.0.0.1/x",
      "http://10.0.0.1/x",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "https://192.168.0.1/x",
    ]) {
      await assert.rejects(assertPublicAudioUrl(url), /private/i, url);
    }
  });

  it("rejects non-http(s) schemes, embedded credentials and oversized URLs", async () => {
    await assert.rejects(assertPublicAudioUrl("ftp://1.1.1.1/x"), /HTTP/);
    await assert.rejects(assertPublicAudioUrl("file:///etc/passwd"), /HTTP/);
    await assert.rejects(assertPublicAudioUrl("http://user:pass@1.1.1.1/x"), /credential/i);
    await assert.rejects(assertPublicAudioUrl(`http://1.1.1.1/${"a".repeat(5000)}`), /too long/i);
  });

  it("accepts a public http(s) URL", async () => {
    await assert.doesNotReject(assertPublicAudioUrl("http://1.1.1.1/song.mp3"));
  });
});

describe("streamAudioWithFfmpeg (direct-stream lifecycle)", () => {
  it("resolves once ffmpeg emits its first byte and exposes a webm stream", async () => {
    const { spawn, procs, calls } = makeFakeSpawn();
    const pending = streamAudioWithFfmpeg(PUBLIC_TS, { spawn, firstByteTimeoutMs: 5000 });
    await waitFor(() => procs.length > 0);
    assert.equal(calls[0].cmd, "ffmpeg");
    await tick();
    procs[0].stdout.write(Buffer.from([1, 2, 3]));
    const extraction = await pending;
    assert.equal(extraction.contentType, "audio/webm");
    extraction.destroy();
    assert.equal(procs[0].killed, true);
  });

  it("rejects with 'no audio' when ffmpeg closes before any output", async () => {
    const { spawn, procs } = makeFakeSpawn();
    const pending = streamAudioWithFfmpeg(PUBLIC_TS, { spawn, firstByteTimeoutMs: 5000 });
    await waitFor(() => procs.length > 0);
    procs[0].emit("close", 1);
    await assert.rejects(pending, /no audio was produced/);
  });

  it("surfaces the tail of ffmpeg's stderr as the failure reason", async () => {
    const { spawn, procs } = makeFakeSpawn();
    const pending = streamAudioWithFfmpeg(PUBLIC_TS, { spawn, firstByteTimeoutMs: 5000 });
    await waitFor(() => procs.length > 0);
    procs[0].stderr.write("Server returned 403 Forbidden\n");
    await tick();
    procs[0].emit("close", 1);
    await assert.rejects(pending, /audio extraction failed: Server returned 403 Forbidden/);
  });

  it("rejects on the first-byte timeout and kills the process", async () => {
    const { spawn, procs } = makeFakeSpawn();
    const pending = streamAudioWithFfmpeg(PUBLIC_TS, { spawn, firstByteTimeoutMs: 20 });
    await assert.rejects(pending, /timed out extracting audio/);
    await waitFor(() => procs.length > 0 && procs[0].killed);
  });
});

describe("streamAudioWithYtDlp (site-extraction lifecycle)", () => {
  it("pipes yt-dlp into ffmpeg and tears both down on destroy", async () => {
    const { spawn, procs, calls } = makeFakeSpawn();
    const pending = streamAudioWithYtDlp(PUBLIC_SITE, { spawn, firstByteTimeoutMs: 5000 });
    await waitFor(() => procs.length >= 2);
    assert.equal(calls[0].cmd, "yt-dlp");
    assert.equal(calls[1].cmd, "ffmpeg");
    await tick();
    procs[1].stdout.write(Buffer.from([1, 2, 3])); // ffmpeg's transcoded output
    const extraction = await pending;
    extraction.destroy();
    assert.ok(
      procs.every((proc) => proc.killed),
      "both yt-dlp and ffmpeg are killed",
    );
  });
});

describe("streamFallbackAudio (routing, backup and concurrency)", () => {
  it("routes a direct media URL to ffmpeg first", async () => {
    const { spawn, procs, calls } = makeFakeSpawn();
    const pending = streamFallbackAudio(PUBLIC_TS, { spawn, firstByteTimeoutMs: 5000 });
    await waitFor(() => procs.length > 0);
    assert.equal(calls[0].cmd, "ffmpeg");
    await tick();
    procs[0].stdout.write(Buffer.from([1]));
    const extraction = await pending;
    extraction.destroy();
    assert.equal(activeTranscodeCount(), 0);
  });

  it("routes a site URL to yt-dlp first", async () => {
    const { spawn, procs, calls } = makeFakeSpawn();
    const pending = streamFallbackAudio(PUBLIC_SITE, { spawn, firstByteTimeoutMs: 5000 });
    await waitFor(() => procs.length >= 2);
    assert.equal(calls[0].cmd, "yt-dlp");
    await tick();
    procs[1].stdout.write(Buffer.from([1]));
    const extraction = await pending;
    extraction.destroy();
    assert.equal(activeTranscodeCount(), 0);
  });

  it("falls back to the backup resolver when the primary fails", async () => {
    const { spawn, procs, calls } = makeFakeSpawn();
    const pending = streamFallbackAudio(PUBLIC_TS, { spawn, firstByteTimeoutMs: 5000 });
    await waitFor(() => procs.length > 0); // primary: ffmpeg
    procs[0].emit("close", 1); // primary fails -> backup (yt-dlp) starts
    await waitFor(() => procs.length >= 3); // yt-dlp + its ffmpeg
    assert.equal(calls[0].cmd, "ffmpeg");
    assert.equal(calls[1].cmd, "yt-dlp");
    await tick();
    procs[2].stdout.write(Buffer.from([1])); // backup ffmpeg output
    const extraction = await pending;
    extraction.destroy();
    assert.equal(activeTranscodeCount(), 0);
  });

  it("rejects with the primary error when both resolvers fail", async () => {
    const { spawn } = makeFakeSpawn();
    await assert.rejects(
      streamFallbackAudio(PUBLIC_TS, { spawn, firstByteTimeoutMs: 20 }),
      /timed out extracting audio/,
    );
    assert.equal(activeTranscodeCount(), 0);
  });

  it("caps concurrent transcodes (503) and releases the slot on destroy", async () => {
    const { spawn, procs } = makeFakeSpawn();
    // Occupy the only slot with a transcode that hasn't produced audio yet.
    const held = streamFallbackAudio(PUBLIC_TS, {
      spawn,
      maxConcurrentTranscodes: 1,
      firstByteTimeoutMs: 5000,
    });
    await waitFor(() => procs.length > 0);
    assert.equal(activeTranscodeCount(), 1);

    // A second request while the slot is taken is rejected as busy (-> 503).
    await assert.rejects(
      streamFallbackAudio(PUBLIC_SITE, { spawn, maxConcurrentTranscodes: 1 }),
      (err) => err instanceof TranscodeBusyError,
    );

    // Releasing the held stream frees the slot.
    await tick();
    procs[0].stdout.write(Buffer.from([1]));
    const extraction = await held;
    extraction.destroy();
    assert.equal(activeTranscodeCount(), 0);
  });
});
