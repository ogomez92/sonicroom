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
export interface SdpParams {
  port: number;
  payloadType: number;
  codec: string; // e.g. "opus"
  clockRate: number;
  channels: number;
  ssrc?: number;
  fmtp?: Record<string, string | number>;
  ip?: string; // default 127.0.0.1
}

export function buildSdp(p: SdpParams): string {
  const ip = p.ip ?? "127.0.0.1";
  const lines = [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=sonicroom-recording",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${p.port} RTP/AVP ${p.payloadType}`,
    `a=rtpmap:${p.payloadType} ${p.codec}/${p.clockRate}/${p.channels}`,
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
  // "audio/opus" -> "opus"
  const subtype = codec.mimeType.split("/")[1]?.toLowerCase() ?? "opus";
  const ssrc = rtpParameters.encodings?.[0]?.ssrc;
  return {
    port,
    payloadType: codec.payloadType,
    codec: subtype,
    clockRate: codec.clockRate,
    channels: codec.channels ?? 2,
    ssrc,
    fmtp: codec.parameters as Record<string, string | number> | undefined,
  };
}

// --- ffmpeg argument builders --------------------------------------------
// Capture one RTP stream (described by an SDP file) into a streamable Ogg
// Opus file. `-c:a copy` keeps the original Opus payload (no re-encode), and
// `-flush_packets 1` keeps the file flushed so a mid-recording read picks up
// recent audio.
export function buildCaptureArgs(sdpPath: string, outPath: string): string[] {
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
    "-c:a",
    "copy",
    "-flush_packets",
    "1",
    "-y",
    outPath,
  ];
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
  meta: { peerId: string; label?: string; source?: string },
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
  return `${n}-${who}${src}.ogg`;
}
