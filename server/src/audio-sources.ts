import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform, type Readable } from "node:stream";

export const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
]);

export function isAudioFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name === path.basename(name) &&
    !name.startsWith(".") &&
    AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())
  );
}

export function isAudioContentType(value: string): boolean {
  const type = value.split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("audio/") || type === "application/ogg";
}

// Resolve a client-supplied relative path inside the library `root` for the
// folder browser. Returns the absolute path + a normalized forward-slash
// relative path, or null if it escapes the root. This is the path-traversal
// guard: leading slashes/backslashes are neutralized and `..` is collapsed
// lexically, so neither an absolute path nor `../` can climb out of the root.
export function resolveLibraryPath(
  root: string,
  relPath: string,
): { abs: string; rel: string } | null {
  const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, cleaned);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  return { abs, rel: path.relative(rootResolved, abs).split(path.sep).join("/") };
}

export interface LibraryEntry {
  name: string;
  dir: boolean;
}

// Shape one directory listing for the picker: drop dotfiles/dotfolders, keep
// sub-directories (navigable) and audio files, sort folders first then files,
// each A–Z. (Symlinks report neither isDirectory nor isFile, so they're
// dropped — only real folders/files are surfaced.)
export function classifyLibraryEntries(
  entries: { name: string; isDirectory: boolean; isFile: boolean }[],
): LibraryEntry[] {
  return entries
    .filter(
      (e) => !e.name.startsWith(".") && (e.isDirectory || (e.isFile && isAudioFileName(e.name))),
    )
    .map((e) => ({ name: e.name, dir: e.isDirectory }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;

  const normalized = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

interface ResolvedAudioUrl {
  url: URL;
  address: string;
  family: number;
}

async function resolvePublicAudioUrl(raw: string): Promise<ResolvedAudioUrl> {
  if (raw.length > 4096) throw new Error("URL is too long");
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS audio URLs are supported");
  }
  if (url.username || url.password) throw new Error("URL credentials are not supported");

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Private network audio URLs are not allowed");
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

function requestAudio(
  { url, address, family }: ResolvedAudioUrl,
  range?: string,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    // Pin the request to the public address we just validated. Without this,
    // attacker-controlled DNS could rebind between validation and connection.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        lookup: pinnedLookup,
        headers: {
          Accept: "audio/*,application/ogg;q=0.9,*/*;q=0.1",
          "User-Agent": "SonicRoom/1.0",
          ...(range ? { Range: range } : {}),
        },
      },
      resolve,
    );
    req.setTimeout(15_000, () => req.destroy(new Error("Audio URL timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function fetchPublicAudio(raw: string, range?: string): Promise<IncomingMessage> {
  let target = await resolvePublicAudioUrl(raw);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await requestAudio(target, range);
    const status = response.statusCode ?? 502;
    if (status < 300 || status >= 400) return response;
    const location = response.headers.location;
    response.resume();
    if (!location) return response;
    target = await resolvePublicAudioUrl(new URL(location, target.url).href);
  }
  throw new Error("Too many redirects");
}

// Throw unless `raw` is a fetchable public http(s) URL. The SSRF guard shared by
// the direct proxy and the yt-dlp fallback so neither can reach internal hosts.
export async function assertPublicAudioUrl(raw: string): Promise<void> {
  await resolvePublicAudioUrl(raw);
}

// --- Transcoding fallbacks ---------------------------------------------------
//
// When a URL isn't itself a browser-playable audio stream we still try to play
// it before failing, by re-encoding its audio to a progressive Opus/WebM stream
// a browser <audio> element can start immediately (Web Audio then mixes it into
// the call like a local file). Two resolvers feed the same transcode:
//
//   * ffmpeg directly (streamAudioWithFfmpeg) for direct media streams — IPTV
//     `.ts`, HLS `.m3u8`, DASH `.mpd`, raw audio — which ffmpeg ingests natively
//     and continuously (the right tool for 24/7 live streams).
//   * yt-dlp (streamAudioWithYtDlp) for sites that need extraction — YouTube,
//     SoundCloud, Bandcamp, livestream landing pages.
//
// streamFallbackAudio routes by URL shape and uses the other resolver as a
// backup, so "links like it" keep working even when the first guess is wrong.

export const YTDLP_AUDIO_CONTENT_TYPE = "audio/webm";
export const YTDLP_VIDEO_CONTENT_TYPE = "video/webm";

const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 45_000;

// Player-style User-Agent — some IPTV/CDN edges reject non-player agents.
const STREAM_USER_AGENT = "VLC/3.0.20 LibVLC/3.0.20";

// Path extensions that denote a direct media stream ffmpeg can open itself — so
// they're routed to ffmpeg first, with yt-dlp's generic extractor as a backup.
const DIRECT_STREAM_EXTENSIONS = new Set([
  ".ts",
  ".m3u8",
  ".m3u",
  ".mpd",
  ".aac",
  ".ac3",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
  ".mp4",
  ".mkv",
  ".mov",
  ".flv",
  ".avi",
  ".divx",
  ".xvid",
]);

// True if the URL path looks like a direct media stream (IPTV/HLS/DASH/raw).
export function looksLikeDirectStream(raw: string): boolean {
  try {
    return DIRECT_STREAM_EXTENSIONS.has(path.extname(new URL(raw).pathname).toLowerCase());
  } catch {
    return false;
  }
}

// Content types that mark a direct media stream the browser <audio> can't play
// but ffmpeg can ingest: IPTV `application/octet-stream`, MPEG-TS / other video,
// HLS and DASH manifests. (Browser-playable `audio/*` is served directly; an
// HTML type means a page that needs yt-dlp.) Lets extension-less IPTV URLs
// (e.g. host/user/token/streamid) still take the fast ffmpeg path.
const STREAM_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/mp4",
  "application/mpegurl",
  "application/x-mpegurl",
  "application/vnd.apple.mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "application/dash+xml",
]);

export function looksLikeStreamContentType(value: string): boolean {
  const type = value.split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("video/") || STREAM_CONTENT_TYPES.has(type);
}

export interface YtDlpExtraction {
  contentType: string;
  stream: Readable;
  // Stop yt-dlp + ffmpeg — call when the response finishes or the client leaves.
  destroy: () => void;
}

export interface YtDlpOptions {
  spawn?: typeof nodeSpawn;
  ytDlpPath?: string;
  ffmpegPath?: string;
  // How long to wait for the first transcoded byte before giving up. yt-dlp can
  // need a few seconds to resolve a site (e.g. fetch YouTube's player), so this
  // is deliberately generous.
  firstByteTimeoutMs?: number;
  // streamFallbackAudio only: run the ffmpeg-direct resolver first regardless of
  // the URL extension (set when the direct fetch already revealed a media-stream
  // content type, e.g. an extension-less IPTV octet-stream).
  preferFfmpeg?: boolean;
  // streamFallbackAudio only: override the global concurrent-transcode cap (for
  // tests). Production reads MAX_CONCURRENT_TRANSCODES (AUDIO_TRANSCODE_LIMIT).
  maxConcurrentTranscodes?: number;
}

// yt-dlp argv: best audio-only format to stdout, a single item, no on-disk cache
// (the service home is read-only under systemd hardening), and a `--` guard so a
// URL beginning with "-" is never read as an option.
export function buildYtDlpArgs(url: string): string[] {
  return [
    "--no-playlist",
    "--no-progress",
    "--no-warnings",
    "--quiet",
    "--no-cache-dir",
    "--socket-timeout",
    "15",
    "--retries",
    "2",
    "--max-filesize",
    "512M",
    "-f",
    "bestaudio/best",
    "-o",
    "-",
    "--",
    url,
  ];
}

// The video equivalent preserves the best available picture plus sound. ffmpeg
// below normalizes it to browser-playable WebM, so source containers/codecs
// (including IPTV MPEG-TS/HLS and Matroska) never leak to the client.
export function buildYtDlpVideoArgs(url: string): string[] {
  return [
    "--no-playlist",
    "--no-progress",
    "--no-warnings",
    "--quiet",
    "--no-cache-dir",
    "--socket-timeout",
    "15",
    "--retries",
    "2",
    "-f",
    "bestvideo*+bestaudio/best",
    "-o",
    "-",
    "--",
    url,
  ];
}

// ffmpeg argv: read yt-dlp's container on stdin, drop any video, and emit a
// progressive Opus-in-WebM stream on stdout that streams cleanly to the browser.
export function buildAudioTranscodeArgs(): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-vn",
    "-c:a",
    "libopus",
    // A common TV/movie source is AC-3 5.1. libopus cannot infer a mapping
    // for every 5.1 layout, while SonicRoom's media producer is stereo anyway.
    "-ac",
    "2",
    "-b:a",
    "160k",
    "-f",
    "webm",
    "pipe:1",
  ];
}

// ffmpeg argv for a direct stream URL (IPTV `.ts`, HLS, DASH, raw audio): follow
// the URL itself, restrict protocols (no `file:`/local-disk reads via a hostile
// playlist), reconnect through live-stream blips, cap stream probing so playback
// starts fast (codecs are standard), drop video, and emit the same progressive
// Opus/WebM as the yt-dlp path.
export function buildFfmpegStreamArgs(url: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "http,https,tcp,tls,crypto",
    "-user_agent",
    STREAM_USER_AGENT,
    "-rw_timeout",
    "15000000",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "2",
    // Cap probing: standard MPEG-TS/HLS expose codecs early, so the default
    // 5s/5MB analysis just delays first audio. yt-dlp is the backup if this is
    // ever too little to detect the stream.
    "-analyzeduration",
    "2000000",
    "-probesize",
    "1000000",
    "-i",
    url,
    "-vn",
    "-c:a",
    "libopus",
    "-ac",
    "2",
    "-b:a",
    "160k",
    "-f",
    "webm",
    "pipe:1",
  ];
}

// Video rooms use this pipeline for URLs/IPTV. VP8+Opus in WebM is the shared
// browser baseline and, unlike a direct upstream response, is CORS-safe for
// Web Audio and captureStream. The realtime settings matter for live HLS/TS.
export function buildFfmpegVideoStreamArgs(url: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "http,https,tcp,tls,crypto",
    "-user_agent",
    STREAM_USER_AGENT,
    "-rw_timeout",
    "15000000",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "2",
    "-analyzeduration",
    "2000000",
    "-probesize",
    "1000000",
    "-i",
    url,
    "-map",
    "0:v:0?",
    "-map",
    "0:a?",
    "-c:v",
    "libvpx",
    "-deadline",
    "realtime",
    "-cpu-used",
    "5",
    "-b:v",
    "2M",
    "-maxrate",
    "3M",
    "-c:a",
    "libopus",
    "-ac",
    "2",
    "-b:a",
    "160k",
    "-f",
    "webm",
    "pipe:1",
  ];
}

// Collect the tail of one or more processes' stderr, for failure diagnostics
// (private video, unsupported URL, geo-block, dead stream…).
function captureStderr(...procs: ChildProcess[]): () => string {
  let text = "";
  const collect = (chunk: unknown) => {
    if (text.length < 8192) text += String(chunk);
  };
  for (const proc of procs) proc.stderr?.on("data", collect);
  return () => text;
}

// Shared plumbing for both resolvers: gate ffmpeg's stdout on its first byte (so
// the route commits 200 + audio headers only once audio is really flowing), and
// kill every process in the pipeline on teardown, failure, or timeout. Resolves
// once audio flows; rejects if the pipeline ends with no output.
async function gateTranscodedAudio(
  ffmpeg: ChildProcess,
  pipeline: ChildProcess[],
  readDiagnostics: () => string,
  firstByteTimeoutMs: number,
  contentType = YTDLP_AUDIO_CONTENT_TYPE,
): Promise<YtDlpExtraction> {
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const proc of pipeline) proc.kill("SIGKILL");
  };

  let sawFirstByte = false;
  let settle: { resolve: () => void; reject: (err: Error) => void } | null = null;
  const firstByte = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });

  // A pass-through that flips the first-byte flag without consuming the chunk.
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      if (!sawFirstByte) {
        sawFirstByte = true;
        settle?.resolve();
      }
      callback(null, chunk);
    },
  });
  output.on("error", () => {});
  output.on("close", destroy);

  const timer = setTimeout(
    () => settle?.reject(new Error("timed out extracting audio")),
    firstByteTimeoutMs,
  );
  timer.unref();
  for (const proc of pipeline) {
    // A spawn/process error before any audio is a startup failure.
    proc.on("error", (err) => settle?.reject(err instanceof Error ? err : new Error(String(err))));
  }
  ffmpeg.on("close", () => {
    if (!sawFirstByte) settle?.reject(new Error("no audio was produced"));
  });

  if (!ffmpeg.stdout) {
    destroy();
    throw new Error("ffmpeg produced no output stream");
  }
  ffmpeg.stdout.on("error", () => {});
  ffmpeg.stdout.pipe(output);

  try {
    await firstByte;
  } catch (err) {
    clearTimeout(timer);
    destroy();
    const detail = readDiagnostics()
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
    throw new Error(
      detail
        ? `audio extraction failed: ${detail}`
        : err instanceof Error
          ? err.message
          : String(err),
      { cause: err },
    );
  }
  clearTimeout(timer);
  return { contentType, stream: output, destroy };
}

// Resolve a site URL (YouTube/SoundCloud/Bandcamp/…) by piping yt-dlp's best
// audio through ffmpeg. Run from a writable dir — the service CWD is read-only
// under systemd hardening.
export async function streamAudioWithYtDlp(
  raw: string,
  options: YtDlpOptions = {},
): Promise<YtDlpExtraction> {
  await resolvePublicAudioUrl(raw);
  const spawn = options.spawn ?? nodeSpawn;
  const ytDlpPath = options.ytDlpPath ?? process.env.YTDLP_PATH ?? "yt-dlp";
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;

  const ytdlp = spawn(ytDlpPath, buildYtDlpArgs(raw), {
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ffmpeg = spawn(ffmpegPath, buildAudioTranscodeArgs(), {
    cwd: tmpdir(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const readDiagnostics = captureStderr(ytdlp, ffmpeg);

  // EPIPE guards: when one stage exits, the other's pipe errors; swallow those
  // so a torn-down extraction can't crash the server with an unhandled error.
  ytdlp.stdout?.on("error", () => {});
  ffmpeg.stdin?.on("error", () => {});
  if (ytdlp.stdout && ffmpeg.stdin) ytdlp.stdout.pipe(ffmpeg.stdin);

  return gateTranscodedAudio(ffmpeg, [ytdlp, ffmpeg], readDiagnostics, firstByteTimeoutMs);
}

// Resolve a direct media stream URL (IPTV `.ts`, HLS, DASH, raw audio) by having
// ffmpeg open it itself — the right tool for continuous live streams.
export async function streamAudioWithFfmpeg(
  raw: string,
  options: YtDlpOptions = {},
): Promise<YtDlpExtraction> {
  await resolvePublicAudioUrl(raw);
  const spawn = options.spawn ?? nodeSpawn;
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;

  const ffmpeg = spawn(ffmpegPath, buildFfmpegStreamArgs(raw), {
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const readDiagnostics = captureStderr(ffmpeg);

  return gateTranscodedAudio(ffmpeg, [ffmpeg], readDiagnostics, firstByteTimeoutMs);
}

// Resolve a video page through yt-dlp, then normalize its selected media to
// VP8/Opus WebM. This is the fallback for a landing-page URL rather than a
// direct HLS/DASH/IPTV stream.
export async function streamVideoWithYtDlp(
  raw: string,
  options: YtDlpOptions = {},
): Promise<YtDlpExtraction> {
  await resolvePublicAudioUrl(raw);
  const spawn = options.spawn ?? nodeSpawn;
  const ytDlpPath = options.ytDlpPath ?? process.env.YTDLP_PATH ?? "yt-dlp";
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
  const ytdlp = spawn(ytDlpPath, buildYtDlpVideoArgs(raw), {
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ffmpeg = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-map",
      "0:v:0?",
      "-map",
      "0:a?",
      "-c:v",
      "libvpx",
      "-deadline",
      "realtime",
      "-cpu-used",
      "5",
      "-b:v",
      "2M",
      "-c:a",
      "libopus",
      "-ac",
      "2",
      "-b:a",
      "160k",
      "-f",
      "webm",
      "pipe:1",
    ],
    { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] },
  );
  const readDiagnostics = captureStderr(ytdlp, ffmpeg);
  ytdlp.stdout?.on("error", () => {});
  ffmpeg.stdin?.on("error", () => {});
  if (ytdlp.stdout && ffmpeg.stdin) ytdlp.stdout.pipe(ffmpeg.stdin);
  return gateTranscodedAudio(
    ffmpeg,
    [ytdlp, ffmpeg],
    readDiagnostics,
    firstByteTimeoutMs,
    YTDLP_VIDEO_CONTENT_TYPE,
  );
}

// Direct media sources include IPTV/HLS/DASH as well as MP4/MKV/WebM URLs.
export async function streamVideoWithFfmpeg(
  raw: string,
  options: YtDlpOptions = {},
): Promise<YtDlpExtraction> {
  await resolvePublicAudioUrl(raw);
  const spawn = options.spawn ?? nodeSpawn;
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
  const ffmpeg = spawn(ffmpegPath, buildFfmpegVideoStreamArgs(raw), {
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return gateTranscodedAudio(
    ffmpeg,
    [ffmpeg],
    captureStderr(ffmpeg),
    firstByteTimeoutMs,
    YTDLP_VIDEO_CONTENT_TYPE,
  );
}

// Each transcode spawns ffmpeg (and yt-dlp for site URLs), and /api/audio-proxy
// is unauthenticated, so cap how many run at once — otherwise a flood of proxy
// requests can exhaust the box's CPU / PIDs / sockets. A slot is held for the
// whole playback, so this is "simultaneous live transcodes server-wide", not a
// rate; only URLs that need transcoding count (plain audio / radio / library /
// local files don't). Audio-only libopus is cheap, so the default is generous;
// tune via env. A busy server rejects further transcodes with 503, not thrash.
export const MAX_CONCURRENT_TRANSCODES = Math.max(
  1,
  Number(process.env.AUDIO_TRANSCODE_LIMIT) || 32,
);

// Thrown by streamFallbackAudio when every transcode slot is taken; the route
// maps it to 503 (transient) instead of 502.
export class TranscodeBusyError extends Error {
  constructor() {
    super("Too many audio transcodes in progress");
    this.name = "TranscodeBusyError";
  }
}

let activeTranscodes = 0;

// Test-only: current in-flight transcode count (asserts slots are released).
export function activeTranscodeCount(): number {
  return activeTranscodes;
}

// Last-resort resolver used after the direct proxy fails: route direct media
// streams to ffmpeg first and sites to yt-dlp, each backed by the other so a
// misclassified URL still plays. The caller has already run the SSRF guard.
// Holds one concurrency slot for the whole lifetime of the returned stream,
// released exactly once when the consumer calls destroy() (or on a failed start).
export async function streamFallbackAudio(
  raw: string,
  options: YtDlpOptions = {},
): Promise<YtDlpExtraction> {
  const limit = options.maxConcurrentTranscodes ?? MAX_CONCURRENT_TRANSCODES;
  if (activeTranscodes >= limit) throw new TranscodeBusyError();
  activeTranscodes += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeTranscodes -= 1;
  };

  const direct = options.preferFfmpeg === true || looksLikeDirectStream(raw);
  const primary = direct ? streamAudioWithFfmpeg : streamAudioWithYtDlp;
  const backup = direct ? streamAudioWithYtDlp : streamAudioWithFfmpeg;
  try {
    let extraction: YtDlpExtraction;
    try {
      extraction = await primary(raw, options);
    } catch (primaryErr) {
      try {
        extraction = await backup(raw, options);
      } catch {
        throw primaryErr;
      }
    }
    // Free the slot when the consumer tears the stream down (response close).
    return {
      ...extraction,
      destroy: () => {
        release();
        extraction.destroy();
      },
    };
  } catch (err) {
    release();
    throw err;
  }
}

// Video-mode counterpart to streamFallbackAudio. Always tries ffmpeg first:
// it is the correct route for direct IPTV URLs even when their path is opaque;
// yt-dlp remains the fallback for ordinary video landing pages.
export async function streamFallbackVideo(
  raw: string,
  options: YtDlpOptions = {},
): Promise<YtDlpExtraction> {
  const limit = options.maxConcurrentTranscodes ?? MAX_CONCURRENT_TRANSCODES;
  if (activeTranscodes >= limit) throw new TranscodeBusyError();
  activeTranscodes += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeTranscodes -= 1;
  };
  try {
    let extraction: YtDlpExtraction;
    try {
      extraction = await streamVideoWithFfmpeg(raw, options);
    } catch (primaryErr) {
      try {
        extraction = await streamVideoWithYtDlp(raw, options);
      } catch {
        throw primaryErr;
      }
    }
    return {
      ...extraction,
      destroy: () => {
        release();
        extraction.destroy();
      },
    };
  } catch (err) {
    release();
    throw err;
  }
}
