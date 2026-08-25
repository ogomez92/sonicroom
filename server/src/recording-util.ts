import type { RtpParameters } from "mediasoup/types";

export type RoomMode = "p2p" | "sfu";

// --- Port allocator -------------------------------------------------------
// mediasoup sends each consumed stream's RTP to a local UDP port where an
// ffmpeg process is listening. ffmpeg's RTP receiver ALSO opens an RTCP socket
// at port+1, so each capture actually occupies a *pair* of ports (P and P+1).
// We therefore hand out ports spaced `step` (default 2) apart, so consecutive
// recorders never collide on each other's RTCP port.
export class PortAllocator {
  private readonly start: number;
  private readonly end: number;
  private readonly step: number;
  private readonly inUse = new Set<number>();
  private cursorIdx = 0;

  constructor(start = 50000, end = 50998, step = 2) {
    if (end < start) throw new Error("PortAllocator: end must be >= start");
    if (step < 1) throw new Error("PortAllocator: step must be >= 1");
    this.start = start;
    this.end = end;
    this.step = step;
  }

  private get slots(): number {
    return Math.floor((this.end - this.start) / this.step) + 1;
  }

  allocate(): number {
    const n = this.slots;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursorIdx + i) % n;
      const port = this.start + idx * this.step;
      if (!this.inUse.has(port)) {
        this.inUse.add(port);
        this.cursorIdx = (idx + 1) % n;
        return port;
      }
    }
    throw new Error("PortAllocator: no free ports available");
  }

  release(port: number): void {
    this.inUse.delete(port);
  }

  get size(): number {
    return this.inUse.size;
  }
}

// --- SDP generation -------------------------------------------------------
// ffmpeg receives the RTP we push to it by reading an SDP file describing the
// single audio stream. Built from the mediasoup consumer's rtpParameters.
export type TrackKind = "audio" | "video";

export interface SdpParams {
  port: number;
  payloadType: number;
  codec: string; // e.g. "opus", "VP8"
  clockRate: number;
  channels: number;
  ssrc?: number;
  fmtp?: Record<string, string | number>;
  ip?: string; // default 127.0.0.1
  // VIDEO ROOMS ONLY. Defaults to "audio" so every existing (audio) caller is
  // unchanged. A video media line carries no channel count, so the rtpmap is
  // `VP8/90000`, not `VP8/90000/2`.
  kind?: TrackKind;
}

export function buildSdp(p: SdpParams): string {
  const ip = p.ip ?? "127.0.0.1";
  const kind: TrackKind = p.kind ?? "audio";
  const rtpmap =
    kind === "video" ? `${p.codec}/${p.clockRate}` : `${p.codec}/${p.clockRate}/${p.channels}`;
  const lines = [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=sonicroom-recording",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=${kind} ${p.port} RTP/AVP ${p.payloadType}`,
    `a=rtpmap:${p.payloadType} ${rtpmap}`,
  ];
  if (p.fmtp && Object.keys(p.fmtp).length > 0) {
    const fmtp = Object.entries(p.fmtp)
      .map(([k, v]) => `${k}=${v}`)
      .join(";");
    lines.push(`a=fmtp:${p.payloadType} ${fmtp}`);
  }
  if (p.ssrc !== undefined) {
    lines.push(`a=ssrc:${p.ssrc} cname:sonicroom`);
  }
  lines.push("a=recvonly");
  return lines.join("\n") + "\n";
}

export function sdpParamsFromRtp(rtpParameters: RtpParameters, port: number): SdpParams {
  const codec = rtpParameters.codecs[0];
  if (!codec) throw new Error("sdpParamsFromRtp: no codec in rtpParameters");
  // "audio/opus" -> "opus"; "video/VP8" -> "VP8" (video codec names are
  // case-sensitive in an SDP rtpmap, so the video subtype is NOT lowercased).
  const [type, rawSubtype] = codec.mimeType.split("/");
  const kind: TrackKind = type?.toLowerCase() === "video" ? "video" : "audio";
  const subtype = (kind === "video" ? rawSubtype : rawSubtype?.toLowerCase()) ?? "opus";
  const ssrc = rtpParameters.encodings?.[0]?.ssrc;
  return {
    port,
    payloadType: codec.payloadType,
    codec: subtype,
    clockRate: codec.clockRate,
    channels: codec.channels ?? 2,
    ssrc,
    fmtp: codec.parameters as Record<string, string | number> | undefined,
    kind,
  };
}

// --- ffmpeg argument builders --------------------------------------------
// Capture one RTP stream (described by an SDP file) into a streamable file.
// Audio (the only kind in an audio room) goes to Ogg/Opus with `-c:a copy`,
// keeping the original Opus payload (no re-encode). VIDEO ROOMS ONLY: a
// camera/screen stream goes to WebM with `-c:v copy`, keeping the original VP8
// payload — WebM is VP8's native container, so this is a remux, not a re-encode
// (the MP4 the download hands out is rendered later, from these captures).
// `-flush_packets 1` keeps the file flushed so a mid-recording read picks up
// recent media.
export function buildCaptureArgs(
  sdpPath: string,
  outPath: string,
  kind: TrackKind = "audio",
): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-protocol_whitelist",
    "file,udp,rtp",
    "-fflags",
    "+genpts",
    "-f",
    "sdp",
    "-i",
    sdpPath,
    ...(kind === "video" ? ["-c:v", "copy"] : ["-c:a", "copy"]),
    "-flush_packets",
    "1",
    "-y",
    outPath,
  ];
}

// Extension of the on-disk capture file for a track of this kind. Audio keeps
// the Ogg/Opus captures the audio path has always written.
export function captureExtension(kind: TrackKind): string {
  return kind === "video" ? "webm" : "ogg";
}

export interface MixInput {
  path: string;
  // ms by which this stream started after the recording began; used to keep
  // late-joiners aligned in the mix.
  delayMs: number;
}

// Mix N captured Ogg files into a single Ogg Opus stream written to stdout
// (pipe:1) so the HTTP download can stream it without a temp output file.
// The source capture files keep being written — mixing does not stop them.
export function buildMixArgs(inputs: MixInput[]): string[] {
  if (inputs.length === 0) throw new Error("buildMixArgs: no inputs");

  const args: string[] = ["-hide_banner", "-loglevel", "warning"];
  for (const input of inputs) {
    args.push("-i", input.path);
  }

  if (inputs.length === 1 && inputs[0].delayMs <= 0) {
    // Single stream, no offset — stream it straight through, no re-encode.
    args.push("-c:a", "copy");
  } else {
    const parts: string[] = [];
    const labels: string[] = [];
    inputs.forEach((input, i) => {
      const label = `a${i}`;
      labels.push(`[${label}]`);
      const d = Math.max(0, Math.round(input.delayMs));
      // Per-input chain, in order:
      //  - aformat upmixes mono voice to stereo BEFORE amix (amix adopts the
      //    first input's layout, so a mono-first mix would fold the stereo
      //    music/share tracks down to mono);
      //  - aresample async fills timestamp gaps with silence so a track that
      //    paused mid-recording (mute, share stopped) stays time-aligned;
      //  - adelay shifts a late-joining stream so voices line up in time.
      const chain = `aformat=channel_layouts=stereo,aresample=async=1${d > 0 ? `,adelay=${d}:all=1` : ""}`;
      parts.push(`[${i}:a]${chain}[${label}]`);
    });
    // normalize=0 keeps each voice at full level instead of dividing by N
    // (which would make everyone quieter as more people join).
    const filter = `${parts.join(";")};${labels.join("")}amix=inputs=${inputs.length}:normalize=0[out]`;
    args.push("-filter_complex", filter, "-map", "[out]", "-c:a", "libopus", "-b:a", "96k");
  }

  args.push("-f", "ogg", "pipe:1");
  return args;
}

export interface PadInput {
  path: string;
  // ms of leading silence to prepend — this track's offset from the recording
  // start, so a late joiner lines up at t=0 when dropped into a DAW.
  delayMs: number;
  // target length of the output in ms — the full recording span (start →
  // stop/now) — so every track in the per-track zip comes out the same length.
  totalMs: number;
}

// Re-encode one captured Ogg/Opus track into a time-aligned, fixed-length
// Ogg/Opus stream on stdout (pipe:1): <delayMs> of leading silence, then the
// audio (internal gaps from mid-recording mutes filled with silence), then
// trailing silence — padded/truncated to exactly <totalMs>. So every track in
// the per-track download shares the same start boundary AND the same length:
// unzip them, drop them at the project start in Reaper, and they're aligned.
//
// adelay/apad are filters, so this MUST re-encode (libopus) — `-c:a copy` is
// impossible with a filtergraph, exactly like the delayed mix above. The
// bitrate is a generous default that's transparent for voice and good for
// music (the captures themselves cap at the router's 256k ceiling).
export function buildPadArgs(input: PadInput): string[] {
  const delay = Math.max(0, Math.round(input.delayMs));
  // ffmpeg -t takes seconds; keep ms precision so lengths match exactly.
  const totalSec = (Math.max(0, input.totalMs) / 1000).toFixed(3);
  // aresample first fills timestamp gaps (a track muted mid-recording) with
  // silence; adelay then shifts the whole thing; apad runs the tail to infinity
  // and -t caps the output at the shared total length.
  const filters = ["aresample=async=1"];
  if (delay > 0) filters.push(`adelay=${delay}:all=1`);
  filters.push("apad");
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    input.path,
    "-af",
    filters.join(","),
    "-t",
    totalSec,
    "-c:a",
    "libopus",
    "-b:a",
    "192k",
    "-f",
    "ogg",
    "pipe:1",
  ];
}

// --- Mode decision --------------------------------------------------------
export interface ModeDecision {
  mode: RoomMode;
  action: "switch-to-sfu" | "switch-to-p2p" | "none";
}

// Pure decision for the mode a room should be in:
//   - 3+ peers always require the SFU.
//   - `forceSfu` pins the SFU even with <=2 peers. Callers set this when the
//     server must see/route the media on the SFU: while recording (P2P media
//     never reaches the server) or when a send-only "music caster" peer is
//     present (it produces but never sets up P2P, so the room must be SFU).
//   - otherwise <=2 peers fall back to P2P.
export function decideMode(
  peerCount: number,
  currentMode: RoomMode,
  forceSfu: boolean,
): ModeDecision {
  const target: RoomMode = peerCount > 2 || forceSfu ? "sfu" : "p2p";
  if (target === currentMode) return { mode: currentMode, action: "none" };
  return {
    mode: target,
    action: target === "sfu" ? "switch-to-sfu" : "switch-to-p2p",
  };
}

export function computeDelayMs(recordingStartedAt: number, recorderStartedAt: number): number {
  return Math.max(0, recorderStartedAt - recordingStartedAt);
}

// Friendly, unique file name for one captured track inside the per-track zip.
// Shape: `NN-<who>[-<source>].ogg`, e.g. `01-alice.ogg`, `02-alice-share.ogg`,
// `03-ecobox-music.ogg`. The `NN` prefix (1-based, from the caller's order)
// guarantees uniqueness even when two tracks share a display name, and keeps a
// stable, chronological ordering when the archive is unpacked. `who` falls back
// to the peer id when no display name is known; `source` is appended only when
// it isn't plain voice, so mic tracks stay clean.
export function trackFileName(
  meta: { peerId: string; label?: string; source?: string; kind?: TrackKind },
  index: number,
): string {
  const raw = meta.label?.trim() || meta.peerId;
  const who =
    raw
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "track";
  const src = meta.source && meta.source !== "voice" ? `-${meta.source}` : "";
  const n = String(index + 1).padStart(2, "0");
  // A track that carries picture is handed out as an MP4 (video rooms only);
  // an audio track stays the Ogg/Opus it has always been.
  const ext = meta.kind === "video" ? "mp4" : "ogg";
  return `${n}-${who}${src}.${ext}`;
}

// --- Video rendering (VIDEO ROOMS ONLY) -----------------------------------
// Everything below this line is reached only when a recording actually
// captured picture, i.e. only in a video room. An audio room's downloads never
// touch it: the manager branches on "did any recorder capture video?" and, when
// nothing did, runs exactly the Ogg/Opus paths above.
//
// Both renderers re-encode: the captures are VP8 (+ Opus), and the deliverable
// is an MP4 that plays anywhere, so picture goes to H.264 and sound to AAC.
// The MP4 is written to a pipe, which rules out `+faststart` (that needs a
// seekable output) — we use a FRAGMENTED MP4 instead
// (`+frag_keyframe+empty_moov+default_base_moof`), which browsers, VLC,
// QuickTime and every NLE open happily and which streams as it is produced.

// Output frame rate. WebRTC video is variable-rate; normalising to a constant
// rate up front is what makes the H.264 output well-formed and seekable.
export const VIDEO_FPS = 25;
// Box a single track's picture is letterboxed into.
export const TRACK_VIDEO_WIDTH = 1280;
export const TRACK_VIDEO_HEIGHT = 720;
// Nominal grid cell for the whole-call mix, and the widest canvas we will
// build from it (a 5-across grid shrinks the cell instead of growing past this).
export const GRID_CELL_WIDTH = 640;
export const GRID_MAX_WIDTH = 1920;

export interface GridCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridLayout {
  cols: number;
  rows: number;
  width: number;
  height: number;
  cells: GridCell[];
}

const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);

// Lay n pictures out in the squarest grid that holds them. Cells keep 16:9 and
// every dimension is even (H.264 requires even width/height). The cell shrinks
// as the grid widens so the canvas never exceeds `maxWidth` — a 9-person call
// renders as a 1920-wide sheet, not a 5760-wide one no encoder wants.
export function gridLayout(
  n: number,
  cellWidth = GRID_CELL_WIDTH,
  maxWidth = GRID_MAX_WIDTH,
): GridLayout {
  if (n < 1) throw new Error("gridLayout: need at least one cell");
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = even(Math.min(cellWidth, maxWidth / cols));
  const h = even(Math.round((w * 9) / 16));
  const cells: GridCell[] = [];
  for (let i = 0; i < n; i++) {
    cells.push({ x: (i % cols) * w, y: Math.floor(i / cols) * h, w, h });
  }
  return { cols, rows, width: cols * w, height: rows * h, cells };
}

// ffmpeg's -t/-d take seconds; keep ms precision so lengths match exactly.
const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

export interface TrackSource {
  path: string;
  // ms by which this capture started after the recording began.
  delayMs: number;
}

// One picture, letterboxed into `w`x`h`, normalised to a constant frame rate and
// shifted to its start offset. Used identically by the per-track and whole-call
// renderers, so a source that changes resolution mid-call (WebRTC does that
// under congestion) can never break the encoder: the scale/pad pin the frame
// size for the whole output.
function videoChain(delayMs: number, w: number, h: number, fps: number): string {
  const chain = [
    `fps=${fps}`,
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
  ];
  const d = Math.max(0, Math.round(delayMs));
  if (d > 0) chain.push(`tpad=start_duration=${secs(d)}:start_mode=add:color=black`);
  return chain.join(",");
}

// One sound track, upmixed to stereo, gap-filled and shifted to its start
// offset — the same chain the Ogg mix uses, so picture and sound line up on the
// same clock.
function audioChain(delayMs: number, pad: boolean): string {
  const chain = ["aformat=channel_layouts=stereo", "aresample=async=1"];
  const d = Math.max(0, Math.round(delayMs));
  if (d > 0) chain.push(`adelay=${d}:all=1`);
  if (pad) chain.push("apad");
  return chain.join(",");
}

const H264_ARGS = (fps: number) => [
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "23",
  "-pix_fmt",
  "yuv420p",
  "-r",
  String(fps),
  // a keyframe every 2s keeps the fragmented MP4 seekable
  "-g",
  String(fps * 2),
];

const AAC_ARGS = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

const MP4_PIPE_ARGS = [
  "-movflags",
  "+frag_keyframe+empty_moov+default_base_moof",
  "-f",
  "mp4",
  "pipe:1",
];

export interface Mp4TrackInput {
  // The captured picture (WebM/VP8) this track is built around.
  video: TrackSource;
  // The peer's own sound to mux with it — their voice for a camera track, the
  // share's audio for a screen track. Absent for a silent screen share, which
  // still gets a silent stereo track so the MP4 is a normal A/V file.
  audio?: TrackSource;
  // Full recording span; the output is padded/truncated to exactly this, so
  // every entry in the per-track zip shares one start boundary and one length.
  totalMs: number;
  width?: number;
  height?: number;
  fps?: number;
}

// Render ONE participant's track as an MP4 on stdout: their picture with their
// own voice on it, time-aligned to the recording start and padded to the full
// span — black before their camera came on, black after it went off, silence
// where they weren't speaking. Drop the whole zip on a timeline and every file
// starts at 0 and ends together.
export function buildTrackMp4Args(input: Mp4TrackInput): string[] {
  const fps = input.fps ?? VIDEO_FPS;
  const w = input.width ?? TRACK_VIDEO_WIDTH;
  const h = input.height ?? TRACK_VIDEO_HEIGHT;
  const total = secs(input.totalMs);

  const args = ["-hide_banner", "-loglevel", "warning", "-i", input.video.path];
  if (input.audio) args.push("-i", input.audio.path);

  // tpad's stop_duration runs the picture out past the end; -t then cuts every
  // stream to the shared total. (apad does the same job for the sound.)
  const vFilter =
    `[0:v]${videoChain(input.video.delayMs, w, h, fps)},` +
    `tpad=stop_duration=${total}:stop_mode=add:color=black[vout]`;
  const aFilter = input.audio
    ? `[1:a]${audioChain(input.audio.delayMs, true)}[aout]`
    : `anullsrc=channel_layout=stereo:sample_rate=48000[aout]`;

  args.push(
    "-filter_complex",
    `${vFilter};${aFilter}`,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-t",
    total,
    ...H264_ARGS(fps),
    ...AAC_ARGS,
    ...MP4_PIPE_ARGS,
  );
  return args;
}

export interface VideoMixSpec {
  // Every captured picture, in the order they should fill the grid.
  video: TrackSource[];
  // Every captured sound track — voices, music, shares, extra mics. Mixed the
  // same way the audio-only download mixes them.
  audio: TrackSource[];
  totalMs: number;
  fps?: number;
  cellWidth?: number;
  maxWidth?: number;
}

// Render the WHOLE CALL as one MP4 on stdout: every camera/screen laid out in a
// grid over black, with everyone's audio mixed on top. The black background is
// generated (not one of the inputs) so the canvas is full-length and full-size
// from the first frame: a camera that comes on late, goes off early, or never
// fills its cell simply leaves black there rather than resizing the output.
export function buildVideoMixArgs(spec: VideoMixSpec): string[] {
  if (spec.video.length === 0) throw new Error("buildVideoMixArgs: no video inputs");
  const fps = spec.fps ?? VIDEO_FPS;
  const layout = gridLayout(spec.video.length, spec.cellWidth, spec.maxWidth);
  const total = secs(spec.totalMs);

  const args = ["-hide_banner", "-loglevel", "warning"];
  // Picture inputs first, then sound, so the filter indices below are stable.
  for (const v of spec.video) args.push("-i", v.path);
  for (const a of spec.audio) args.push("-i", a.path);

  const parts: string[] = [
    `color=c=black:s=${layout.width}x${layout.height}:r=${fps}:d=${total}[bg]`,
  ];
  spec.video.forEach((v, i) => {
    const c = layout.cells[i];
    parts.push(`[${i}:v]${videoChain(v.delayMs, c.w, c.h, fps)}[v${i}]`);
  });
  let prev = "bg";
  spec.video.forEach((_, i) => {
    const c = layout.cells[i];
    const out = i === spec.video.length - 1 ? "vout" : `s${i}`;
    // eof_action=pass + repeatlast=0: once a camera stops, its cell goes back
    // to black instead of freezing on the last frame for the rest of the call.
    parts.push(`[${prev}][v${i}]overlay=x=${c.x}:y=${c.y}:eof_action=pass:repeatlast=0[${out}]`);
    prev = out;
  });

  if (spec.audio.length > 0) {
    const offset = spec.video.length;
    const labels: string[] = [];
    spec.audio.forEach((a, i) => {
      labels.push(`[m${i}]`);
      parts.push(`[${offset + i}:a]${audioChain(a.delayMs, false)}[m${i}]`);
    });
    // normalize=0, as in the Ogg mix: nobody gets quieter as the room grows.
    parts.push(`${labels.join("")}amix=inputs=${spec.audio.length}:normalize=0[aout]`);
  } else {
    parts.push("anullsrc=channel_layout=stereo:sample_rate=48000[aout]");
  }

  args.push(
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-t",
    total,
    ...H264_ARGS(fps),
    ...AAC_ARGS,
    ...MP4_PIPE_ARGS,
  );
  return args;
}

// --- Pairing picture with sound (VIDEO ROOMS ONLY) ------------------------

export interface RecorderMeta {
  peerId: string;
  label?: string;
  source?: string;
  kind: TrackKind;
  path: string;
  // ms by which this capture started after the recording began.
  delayMs: number;
}

// One entry of the per-track download. `video` set => rendered as an MP4 (and
// `audio`, when set, is the sound muxed onto it); `video` unset => the plain
// Ogg/Opus track the audio path has always produced.
export interface TrackEntry {
  name: string;
  audio?: TrackSource;
  video?: TrackSource;
}

const asSource = (r: RecorderMeta): TrackSource => ({ path: r.path, delayMs: r.delayMs });

// Fold a video room's captures into one entry per *track a person would expect*:
// a peer's camera carries their voice (one MP4 per person), their screen share
// carries the share's audio (one MP4 for the screen), and everything else —
// music casters, streamed files, extra mics, and the voice of anyone who never
// turned their camera on — stays its own audio file.
//
// A peer who cycles their camera off and on produces several picture captures;
// only the FIRST takes their voice, so the voice track is never duplicated
// across entries. Ordering is chronological by each entry's picture (or, for
// audio-only entries, its sound), matching the audio path's ordering.
export function pairTracks(recorders: RecorderMeta[]): TrackEntry[] {
  const byPeer = new Map<string, RecorderMeta[]>();
  for (const r of recorders) {
    const list = byPeer.get(r.peerId);
    if (list) list.push(r);
    else byPeer.set(r.peerId, [r]);
  }

  // Where each capture sat in the (chronological) input list, so an entry can
  // be ordered by its EARLIEST capture. A person who turns their camera on
  // halfway through keeps their place in the zip — their voice was there from
  // the start, and it's the same track.
  const seqOf = new Map<RecorderMeta, number>(recorders.map((r, i) => [r, i]));

  interface Pending extends TrackEntry {
    at: number;
    seq: number;
    meta: { peerId: string; label?: string; source?: string; kind: TrackKind };
  }
  const pending: Pending[] = [];
  const order = (...parts: (RecorderMeta | undefined)[]) => {
    const present = parts.filter((r): r is RecorderMeta => r !== undefined);
    return {
      at: Math.min(...present.map((r) => r.delayMs)),
      seq: Math.min(...present.map((r) => seqOf.get(r)!)),
    };
  };

  for (const list of byPeer.values()) {
    const pictures = list.filter((r) => r.kind === "video");
    const cameras = pictures.filter((r) => r.source === "camera");
    const screens = pictures.filter((r) => r.source !== "camera");
    // Sound that gets absorbed into a picture entry: the first voice capture
    // rides the first camera, the first share capture rides the first screen.
    const claimed = new Set<RecorderMeta>();
    const claim = (src: string): RecorderMeta | undefined => {
      const hit = list.find((r) => r.kind === "audio" && (r.source ?? "voice") === src);
      if (hit) claimed.add(hit);
      return hit;
    };

    cameras.forEach((cam, i) => {
      const voice = i === 0 ? claim("voice") : undefined;
      pending.push({
        ...order(cam, voice),
        // A peer's first camera IS their track, so it carries no source suffix
        // (`01-Alice.mp4`) — including when they stayed muted and there is no
        // voice to put under it. A later camera segment, from cycling the
        // camera off and on, is disambiguated as `-camera`.
        meta: {
          peerId: cam.peerId,
          label: cam.label,
          source: i === 0 ? "voice" : "camera",
          kind: "video",
        },
        name: "",
        video: asSource(cam),
        audio: voice ? asSource(voice) : undefined,
      });
    });

    screens.forEach((scr, i) => {
      const shareAudio = i === 0 ? claim("share") : undefined;
      pending.push({
        ...order(scr, shareAudio),
        meta: { peerId: scr.peerId, label: scr.label, source: "screen", kind: "video" },
        name: "",
        video: asSource(scr),
        audio: shareAudio ? asSource(shareAudio) : undefined,
      });
    });

    for (const r of list) {
      if (r.kind !== "audio" || claimed.has(r)) continue;
      pending.push({
        ...order(r),
        meta: { peerId: r.peerId, label: r.label, source: r.source, kind: "audio" },
        name: "",
        audio: asSource(r),
      });
    }
  }

  pending.sort((a, b) => a.at - b.at || a.seq - b.seq);
  return pending.map((entry, i) => ({
    name: trackFileName(entry.meta, i),
    audio: entry.audio,
    video: entry.video,
  }));
}
