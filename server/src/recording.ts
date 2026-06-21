import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir as fsMkdir, writeFile as fsWriteFile, rm as fsRm } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RtpParameters, RtpCapabilities } from "mediasoup/types";
import {
  PortAllocator,
  buildSdp,
  sdpParamsFromRtp,
  buildCaptureArgs,
  buildMixArgs,
  buildPadArgs,
  computeDelayMs,
  trackFileName,
  type MixInput,
} from "./recording-util.js";

// A capture that received no RTP — a muted/silent producer, or one whose peer
// never actually sent — still leaves a tiny header-only Ogg/Opus file on disk
// (~158 bytes: the OpusHead + OpusTags pages, no audio). ffmpeg cannot open
// such a file ("End of file") and, fatally, that aborts the WHOLE mix (exit
// 187) so the download comes back empty — the room records "no audio" whenever
// anyone happened to be muted. We therefore require a capture to be safely
// larger than a bare header before it's fed to the mix or the per-track zip.
// 1 KiB is far above any header yet far below any real capture (even a fraction
// of a second of Opus is several KB), so this only ever drops audio-less
// tracks, never real audio.
export const MIN_CAPTURE_BYTES = 1024;

// --- Minimal structural interfaces -----------------------------------------
// We depend only on the slices of mediasoup / child_process / fs that we use,
// so the manager can be driven by fakes in tests. The real mediasoup Router,
// PlainTransport and Consumer satisfy these structurally.

export interface SpawnedProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface RtpConsumer {
  id: string;
  kind: string;
  rtpParameters: RtpParameters;
  resume(): Promise<void>;
  close(): void;
}

export interface RtpPlainTransport {
  connect(params: { ip: string; port: number }): Promise<void>;
  consume(params: {
    producerId: string;
    rtpCapabilities: RtpCapabilities;
    paused?: boolean;
  }): Promise<RtpConsumer>;
  close(): void;
}

export interface RecordingRouter {
  rtpCapabilities: RtpCapabilities;
  createPlainTransport(opts: {
    listenInfo: { protocol: "udp"; ip: string };
    rtcpMux: boolean;
    comedia: boolean;
  }): Promise<RtpPlainTransport>;
}

export interface RecordingDeps {
  spawn: (command: string, args: string[]) => SpawnedProcess;
  now: () => number;
  mkdir: (dir: string) => Promise<void>;
  writeFile: (file: string, data: string) => Promise<void>;
  rm: (dir: string) => Promise<void>;
  fileSize: (file: string) => number;
  sleep: (ms: number) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  tmpRoot: string;
  ports: PortAllocator;
  ffmpegPath: string;
  rtpListenIp: string;
  // ms to wait after spawning the capture ffmpeg (so it binds its UDP port)
  // before resuming the consumer, to avoid losing the first packets.
  resumeDelayMs: number;
  // how long a finished (stopped) recording stays downloadable before it's
  // auto-discarded. 0 disables the timer.
  finishedTtlMs: number;
  log: (msg: string) => void;
}

export interface ProducerInfo {
  producerId: string;
  peerId: string;
  // Display name of the producing peer and the track's source ("voice" |
  // "music" | "share"), if known. Purely cosmetic — used to name the files in
  // the per-track download. Captured up front so a left peer's track keeps its
  // name even after the peer is gone.
  label?: string;
  source?: string;
}

interface ProducerRecorder {
  producerId: string;
  peerId: string;
  label?: string;
  source?: string;
  port: number;
  filePath: string;
  startedAt: number;
  transport: RtpPlainTransport;
  consumer: RtpConsumer;
  ffmpeg: SpawnedProcess;
}

// One captured track in the per-track download: the on-disk file and the name
// it should carry inside the zip.
export interface TrackFile {
  path: string;
  name: string;
}

// A per-track download entry expanded with the timing needed to pad it to the
// full recording span: leading silence equal to its start offset, and a shared
// total length so every track comes out the same size and aligned (see
// buildPadArgs).
export interface PaddedTrack extends TrackFile {
  delayMs: number;
  totalMs: number;
}

export type RecordingStatus = "recording" | "finished";

export interface RoomRecording {
  id: string;
  dir: string;
  startedAt: number;
  // When the recording was finalized (stopped). Unset while still recording.
  // Used to fix the total span when padding the per-track download, so the
  // tracks of a finished recording all share the same length regardless of
  // when the zip is downloaded.
  finishedAt?: number;
  router: RecordingRouter;
  recorders: Map<string, ProducerRecorder>;
  // Recorders whose producer went away mid-recording (peer left, stopped
  // sharing, etc.). Their capture is stopped and the file kept on disk so the
  // already-recorded audio is still part of the mix and the per-track download
  // — we never drop a track just because its peer left before the end.
  closedRecorders: ProducerRecorder[];
  status: RecordingStatus;
  ttlHandle: unknown;
  closing: boolean;
}

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function createDefaultDeps(overrides: Partial<RecordingDeps> = {}): RecordingDeps {
  return {
    spawn: (command, args) => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
    now: () => Date.now(),
    mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => undefined),
    writeFile: (file, data) => fsWriteFile(file, data),
    rm: (dir) => fsRm(dir, { recursive: true, force: true }),
    fileSize: (file) => {
      try {
        return statSync(file).size;
      } catch {
        return 0;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      // don't keep the process alive just for a cleanup timer
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    tmpRoot: path.join(os.tmpdir(), "sonicroom-recordings"),
    ports: new PortAllocator(),
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
    rtpListenIp: "127.0.0.1",
    resumeDelayMs: 250,
    finishedTtlMs: 15 * 60 * 1000,
    log: (msg) => console.log(`[recording] ${msg}`),
    ...overrides,
  };
}

export class RecordingManager {
  private readonly deps: RecordingDeps;
  private readonly recordings = new Map<string, RoomRecording>();

  // Set by the signaling layer so the manager can tell the room when a
  // finished recording is auto-discarded (so clients hide the stale link).
  onExpire?: (roomName: string, recordingId: string) => void;

  constructor(deps: Partial<RecordingDeps> = {}) {
    this.deps = createDefaultDeps(deps);
  }

  // True only while actively capturing — this is what pins the room to SFU.
  // A finished-but-downloadable recording does NOT count.
  isRecording(roomName: string): boolean {
    return this.recordings.get(roomName)?.status === "recording";
  }

  getRecording(roomName: string): RoomRecording | undefined {
    return this.recordings.get(roomName);
  }

  // Begin recording a room. Starts one capture per existing producer; later
  // producers are added via addProducer(). Idempotent while active; if a
  // previous recording for this room is still hanging around (finished, not
  // yet discarded), it's discarded first.
  async start(
    roomName: string,
    router: RecordingRouter,
    producers: ProducerInfo[],
  ): Promise<RoomRecording> {
    const existing = this.recordings.get(roomName);
    if (existing?.status === "recording") return existing;
    if (existing) {
      await this.discard(roomName);
      // A concurrent start() may have claimed the room while discard awaited.
      const claimed = this.recordings.get(roomName);
      if (claimed?.status === "recording") return claimed;
    }

    const startedAt = this.deps.now();
    // Random id: the download URLs are unauthenticated and rely on this being
    // an unguessable capability token (a timestamp-based id is enumerable).
    const id = `rec_${randomUUID()}`;
    const dir = path.join(this.deps.tmpRoot, id);

    const rec: RoomRecording = {
      id,
      dir,
      startedAt,
      router,
      recorders: new Map(),
      closedRecorders: [],
      status: "recording",
      ttlHandle: null,
      closing: false,
    };
    // Claim the room slot BEFORE the first await below — two concurrent
    // start() calls could otherwise both pass the checks above, and the
    // losing recording would be orphaned with its ffmpeg processes and
    // ports never released.
    this.recordings.set(roomName, rec);
    try {
      await this.deps.mkdir(dir);
    } catch (err) {
      this.recordings.delete(roomName);
      throw err;
    }
    this.deps.log(`started ${id} for room "${roomName}" (${producers.length} producer(s))`);

    for (const info of producers) {
      await this.startRecorder(rec, info);
    }
    return rec;
  }

  // Add a producer to an in-progress recording (a new speaker, or a producer
  // that came online after a P2P→SFU switch). No-op unless actively recording.
  async addProducer(roomName: string, info: ProducerInfo): Promise<void> {
    const rec = this.recordings.get(roomName);
    if (!rec || rec.status !== "recording" || rec.closing) return;
    if (rec.recorders.has(info.producerId)) return;
    await this.startRecorder(rec, info);
  }

  // Stop capturing a single producer (it closed / its peer left). The already
  // captured audio stays on disk AND in the recording (moved to closedRecorders)
  // so it's still included in the mix and the per-track download. No-op once a
  // recording is finished (its files must be preserved for download).
  async removeProducer(roomName: string, producerId: string): Promise<void> {
    const rec = this.recordings.get(roomName);
    if (!rec || rec.status !== "recording") return;
    const recorder = rec.recorders.get(producerId);
    if (!recorder) return;
    rec.recorders.delete(producerId);
    rec.closedRecorders.push(recorder);
    this.stopRecorder(recorder);
  }

  // Every recorder that belongs to this recording — still-live ones plus those
  // whose producer left — in chronological (start) order.
  private allRecorders(rec: RoomRecording): ProducerRecorder[] {
    return [...rec.recorders.values(), ...rec.closedRecorders].sort(
      (a, b) => a.startedAt - b.startedAt,
    );
  }

  // Current per-producer files with their start offsets, for mixing. Includes
  // producers that already left — their captured audio is still part of the mix.
  getMixInputs(roomName: string): MixInput[] {
    const rec = this.recordings.get(roomName);
    if (!rec) return [];
    return this.allRecorders(rec).map((r) => ({
      path: r.filePath,
      delayMs: computeDelayMs(rec.startedAt, r.startedAt),
    }));
  }

  // Per-track files (live + already-left producers) with friendly, unique names
  // for the "download every track on its own" zip. Header-only/missing captures
  // (a silent producer, or a recorder that failed to start) are skipped so the
  // zip has no dead entries — see MIN_CAPTURE_BYTES.
  getTrackFiles(roomName: string): TrackFile[] {
    const rec = this.recordings.get(roomName);
    if (!rec) return [];
    return this.allRecorders(rec)
      .map((r, i) => ({ path: r.filePath, name: trackFileName(r, i) }))
      .filter((t) => this.deps.fileSize(t.path) >= MIN_CAPTURE_BYTES);
  }

  // Same as getTrackFiles(), addressed by the (hard-to-guess) recording id that
  // the download URL carries. Works for active and finished recordings.
  tracksByRecordingId(recordingId: string): TrackFile[] | null {
    for (const [roomName, rec] of this.recordings) {
      if (rec.id === recordingId) return this.getTrackFiles(roomName);
    }
    return null;
  }

  // Like getTrackFiles(), but each entry also carries the timing to pad it to
  // the full recording span — leading silence equal to its start offset, and a
  // shared total length (recording start → finish, or → now while still
  // recording) — so the per-track zip unpacks to equal-length, time-aligned
  // files that drop straight into a DAW. Same MIN_CAPTURE_BYTES filtering.
  getPaddedTracks(roomName: string): PaddedTrack[] {
    const rec = this.recordings.get(roomName);
    if (!rec) return [];
    const totalMs = Math.max(0, (rec.finishedAt ?? this.deps.now()) - rec.startedAt);
    return this.allRecorders(rec)
      .map((r, i) => ({
        path: r.filePath,
        name: trackFileName(r, i),
        delayMs: computeDelayMs(rec.startedAt, r.startedAt),
        totalMs,
      }))
      .filter((t) => this.deps.fileSize(t.path) >= MIN_CAPTURE_BYTES);
  }

  // Same as getPaddedTracks(), addressed by the recording id the download URL
  // carries. Works for active and finished recordings.
  paddedTracksByRecordingId(recordingId: string): PaddedTrack[] | null {
    for (const [roomName, rec] of this.recordings) {
      if (rec.id === recordingId) return this.getPaddedTracks(roomName);
    }
    return null;
  }

  // Spawn a one-shot ffmpeg that streams one padded, time-aligned track to its
  // stdout (Ogg/Opus). Used per entry by the per-track zip download; the source
  // capture file is read but never modified, so live captures are unaffected.
  spawnPaddedTrack(track: PaddedTrack): SpawnedProcess {
    return this.deps.spawn(this.deps.ffmpegPath, buildPadArgs(track));
  }

  // Spawn a one-shot ffmpeg that mixes the current capture files into a single
  // Ogg/Opus stream on stdout. Capture processes (if still running) are never
  // interrupted. Files that don't exist yet, are empty, or hold only an Opus
  // header with no audio (a muted/silent producer — see MIN_CAPTURE_BYTES) are
  // skipped: ffmpeg can't open a header-only file and would abort the entire
  // mix, so one silent stream must not be able to zero out the whole download.
  // Returns null if there's nothing with audio to mix.
  mix(roomName: string): SpawnedProcess | null {
    const inputs = this.getMixInputs(roomName).filter(
      (i) => this.deps.fileSize(i.path) >= MIN_CAPTURE_BYTES,
    );
    if (inputs.length === 0) return null;
    const args = buildMixArgs(inputs);
    this.deps.log(`mixing ${inputs.length} stream(s) for room "${roomName}"`);
    return this.deps.spawn(this.deps.ffmpegPath, args);
  }

  // Same as mix(), but addressed by the (hard-to-guess) recording id, which is
  // what the download URL carries. Works for active and finished recordings.
  mixByRecordingId(recordingId: string): SpawnedProcess | null {
    for (const [roomName, rec] of this.recordings) {
      if (rec.id === recordingId) return this.mix(roomName);
    }
    return null;
  }

  // Stop capturing but KEEP the recording downloadable. Closes every capture
  // (SIGINT finalizes the Ogg trailer), releases transports/ports, and keeps
  // the files on disk until discarded (TTL, a new recording, or room exit).
  async finalize(roomName: string): Promise<RoomRecording | null> {
    const rec = this.recordings.get(roomName);
    if (!rec || rec.status !== "recording") return null;

    rec.status = "finished";
    rec.finishedAt = this.deps.now();
    for (const recorder of rec.recorders.values()) {
      this.stopRecorder(recorder);
    }

    if (this.deps.finishedTtlMs > 0) {
      rec.ttlHandle = this.deps.setTimer(() => {
        // Only discard if this exact recording is still the one parked here.
        if (this.recordings.get(roomName)?.id === rec.id) {
          void this.discard(roomName).then(() => this.onExpire?.(roomName, rec.id));
        }
      }, this.deps.finishedTtlMs);
    }
    this.deps.log(`finalized ${rec.id} for room "${roomName}" (kept for download)`);
    return rec;
  }

  // Fully tear down a recording: kill any live captures, release ports/
  // transports, cancel the TTL, and delete the working directory.
  async discard(roomName: string): Promise<void> {
    const rec = this.recordings.get(roomName);
    if (!rec) return;
    rec.closing = true;
    this.recordings.delete(roomName);

    if (rec.ttlHandle) this.deps.clearTimer(rec.ttlHandle);
    // If still actively recording, captures are live and must be killed.
    for (const recorder of rec.recorders.values()) {
      this.stopRecorder(recorder);
    }
    rec.recorders.clear();

    try {
      await this.deps.rm(rec.dir);
    } catch (err) {
      this.deps.log(`failed to remove ${rec.dir}: ${String(err)}`);
    }
    this.deps.log(`discarded ${rec.id} for room "${roomName}"`);
  }

  // Best-effort teardown of every recording (server shutdown).
  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.recordings.keys()).map((name) => this.discard(name)));
  }

  // --- internals ----------------------------------------------------------

  private async startRecorder(rec: RoomRecording, info: ProducerInfo): Promise<void> {
    const { deps } = this;
    let port: number | undefined;
    let transport: RtpPlainTransport | undefined;
    let consumer: RtpConsumer | undefined;
    let ffmpeg: SpawnedProcess | undefined;
    try {
      port = deps.ports.allocate();
      transport = await rec.router.createPlainTransport({
        listenInfo: { protocol: "udp", ip: deps.rtpListenIp },
        rtcpMux: true,
        comedia: false,
      });
      await transport.connect({ ip: deps.rtpListenIp, port });

      consumer = await transport.consume({
        producerId: info.producerId,
        rtpCapabilities: rec.router.rtpCapabilities,
        paused: true,
      });

      const sdp = buildSdp(sdpParamsFromRtp(consumer.rtpParameters, port));
      const base = `${safeId(info.peerId)}__${safeId(info.producerId)}`;
      const sdpPath = path.join(rec.dir, `${base}.sdp`);
      const filePath = path.join(rec.dir, `${base}.ogg`);
      await deps.writeFile(sdpPath, sdp);

      ffmpeg = deps.spawn(deps.ffmpegPath, buildCaptureArgs(sdpPath, filePath));
      const captured = ffmpeg;
      ffmpeg.stderr?.on("data", (d: Buffer) => {
        const line = d.toString().trim();
        if (line) deps.log(`ffmpeg[${base}]: ${line}`);
      });
      ffmpeg.on("exit", (code, signal) => {
        deps.log(`ffmpeg[${base}] exited code=${code} signal=${signal}`);
      });

      // Let ffmpeg bind its UDP port before media starts flowing.
      if (deps.resumeDelayMs > 0) await deps.sleep(deps.resumeDelayMs);
      // Bail out if the recording was torn down while we were waiting.
      if (rec.closing || rec.status !== "recording") {
        throw new Error("recording closed during recorder startup");
      }
      await consumer.resume();

      rec.recorders.set(info.producerId, {
        producerId: info.producerId,
        peerId: info.peerId,
        label: info.label,
        source: info.source,
        port,
        filePath,
        startedAt: deps.now(),
        transport,
        consumer,
        ffmpeg: captured,
      });
      deps.log(`recording producer ${info.producerId} (peer ${info.peerId}) on port ${port}`);
    } catch (err) {
      // Clean up any partially-created resources for this producer.
      try {
        ffmpeg?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        consumer?.close();
      } catch {
        /* ignore */
      }
      try {
        transport?.close();
      } catch {
        /* ignore */
      }
      if (port !== undefined) deps.ports.release(port);
      deps.log(`failed to record producer ${info.producerId}: ${String(err)}`);
    }
  }

  private stopRecorder(recorder: ProducerRecorder): void {
    try {
      // SIGINT lets ffmpeg finalize the Ogg trailer cleanly.
      recorder.ffmpeg.kill("SIGINT");
    } catch {
      /* ignore */
    }
    try {
      recorder.consumer.close();
    } catch {
      /* ignore */
    }
    try {
      recorder.transport.close();
    } catch {
      /* ignore */
    }
    this.deps.ports.release(recorder.port);
  }
}
