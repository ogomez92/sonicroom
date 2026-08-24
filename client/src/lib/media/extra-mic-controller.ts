// Our OUTGOING extra microphones: additional input devices streamed as their own
// separate "mic" producers (one per device), on top of the primary voice mic. Each
// is SFU-only (a separate producer must be routed by the server, like share/file)
// and reclocked through Web Audio (getUserMedia → source → dest) before produce —
// the raw-produce variant could drift a stereo extra mic's two channels apart over
// time, so we produce the DESTINATION track, like every other stereo producer here.
// Extracted from useMediasoup so the capture/produce/reconcile logic is one unit
// and the reconcile decision is a pure, testable function.
import type { Device } from "mediasoup-client";
import type { Transport, Producer } from "mediasoup-client/types";
import { useRoomStore, type RoomMode } from "../../stores/room";
import { resumeContext } from "../audio/shared-context";
import { extraMicConstraints } from "../microphone";
import { playCue } from "../sounds";
import {
  announce_extra_mic_started_you,
  announce_extra_mic_stopped_you,
} from "../../paraglide/messages.js";

// Matches useMediasoup's `emit` helper (promisified ack-with-timeout socket emit).
type Emit = <T>(event: string, data?: unknown) => Promise<T>;

export interface ExtraMicDeps {
  getSendTransport(): Transport | null;
  getDevice(): Device | null;
  getMode(): RoomMode;
}

interface ExtraMicEntry {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  dest: MediaStreamAudioDestinationNode;
  producer: Producer | null;
  stereo: boolean;
}

// The reconcile decision: given the previously-applied selection and the desired
// one (deviceId → stereo), what to start / stop / restart. A device is started when
// newly desired, stopped when no longer desired, and restarted when its mono↔stereo
// flips (the codec can't renegotiate live). Pure — the three sets are disjoint, so
// the order between them doesn't matter (each op touches only its own device).
export function diffDesiredMics(
  prev: Map<string, boolean>,
  desired: Map<string, boolean>,
): { toStop: string[]; toStart: Array<[string, boolean]>; toRestart: Array<[string, boolean]> } {
  const toStop: string[] = [];
  for (const [deviceId] of prev) if (!desired.has(deviceId)) toStop.push(deviceId);
  const toStart: Array<[string, boolean]> = [];
  const toRestart: Array<[string, boolean]> = [];
  for (const [deviceId, stereo] of desired) {
    const was = prev.get(deviceId);
    if (was === undefined) toStart.push([deviceId, stereo]);
    else if (was !== stereo) toRestart.push([deviceId, stereo]);
  }
  return { toStop, toStart, toRestart };
}

export class ExtraMicController {
  // keyed by deviceId; app-owned (kept across reconnects so produceAll re-produces).
  private readonly mics = new Map<string, ExtraMicEntry>();
  // Serialize start/stop/restart so a rapid flip-and-back can't run overlapping
  // captures/produces on one device (leaving a doubled / wrong-channel producer).
  private chain: Promise<void> = Promise.resolve();
  // Baseline of the last reconciled selection, diffed against the desired set.
  private prevDesired = new Map<string, boolean>();

  // The context is taken as a getter so it can be created lazily (iOS creates
  // it only once the mic is open — see shared-context.ts); a plain context is
  // accepted too, for tests.
  private readonly getCtx: () => AudioContext;
  private get ctx(): AudioContext {
    return this.getCtx();
  }

  constructor(
    ctx: AudioContext | (() => AudioContext),
    private readonly store: typeof useRoomStore,
    private readonly emit: Emit,
    private readonly deps: ExtraMicDeps,
  ) {
    this.getCtx = typeof ctx === "function" ? ctx : () => ctx;
  }

  // A failed op never wedges the chain (failures surface to the caller's promise,
  // then are swallowed for the next link). Mirrors useMediasoup's runTransition.
  private runOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // (Re)acquire a device's capture and wire it through Web Audio (source → dest).
  // Idempotent while the capture is live AND already at the requested layout;
  // otherwise re-acquires + rebuilds the nodes (the track died, or a mono↔stereo
  // flip needs a fresh capture with the new channelCount).
  private async ensureGraph(deviceId: string, stereo: boolean): Promise<ExtraMicEntry> {
    resumeContext(this.ctx);
    const existing = this.mics.get(deviceId);
    const liveTrack = existing?.stream.getAudioTracks()[0];
    if (existing && existing.stereo === stereo && liveTrack && liveTrack.readyState === "live")
      return existing;
    if (existing) {
      existing.source.disconnect();
      existing.dest.disconnect();
      existing.stream.getTracks().forEach((t) => t.stop());
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: extraMicConstraints(deviceId, stereo),
    });
    // Reclock through the shared context and produce the dest's track (see the file
    // header). dest.channelCount matches the layout so a mono pick stays mono.
    const source = this.ctx.createMediaStreamSource(stream);
    const dest = this.ctx.createMediaStreamDestination();
    dest.channelCount = stereo ? 2 : 1;
    source.connect(dest);
    const entry: ExtraMicEntry = {
      stream,
      source,
      dest,
      producer: existing?.producer ?? null,
      stereo,
    };
    this.mics.set(deviceId, entry);
    return entry;
  }

  // Produce one extra mic as its own stereo/mono "mic" track. SFU-only; idempotent.
  private async produceOne(deviceId: string, stereo: boolean) {
    const sendTransport = this.deps.getSendTransport();
    const device = this.deps.getDevice();
    if (!sendTransport || !device) return;
    const entry = await this.ensureGraph(deviceId, stereo);
    if (entry.producer && !entry.producer.closed) return;
    // Produce the Web Audio DESTINATION track. The dest track has no label, so the
    // device's human name comes off the RAW capture track ("Tyler's mic: …").
    const track = entry.dest.stream.getAudioTracks()[0];
    if (!track) return;
    const deviceLabel = entry.stream.getAudioTracks()[0]?.label || undefined;
    entry.producer = await sendTransport.produce({
      track,
      codecOptions: {
        opusStereo: stereo,
        opusDtx: false,
        opusFec: true,
        opusMaxPlaybackRate: 48000,
        ...(stereo ? { opusMaxAverageBitrate: 256000 } : {}),
      },
      codec: device.recvRtpCapabilities.codecs?.find(
        (c) => c.mimeType.toLowerCase() === "audio/opus",
      ),
      appData: { source: "mic", title: deviceLabel },
      // The dest track is app-owned and reused across reconnects — don't let
      // mediasoup-client stop it when this producer closes (see produceShare).
      stopTracks: false,
    });
  }

  // Rebuild every selected extra mic — called from setupSfuInner on a mode switch
  // into SFU or a reconnect. One dead device must not abort the others.
  async produceAll() {
    const { streamedMicDeviceIds, micStereoByDevice, micDeviceId } = this.store.getState();
    for (const deviceId of streamedMicDeviceIds) {
      if (!deviceId || deviceId === micDeviceId) continue;
      try {
        await this.produceOne(deviceId, !!micStereoByDevice[deviceId]);
      } catch (err) {
        console.error("[extra-mic] produce failed:", deviceId, err);
      }
    }
  }

  // Start streaming one extra mic (user checked it). Builds the capture first so a
  // getUserMedia failure aborts before we touch the server / room mode, then pins
  // SFU and produces (mirrors startAudioShare's wasSfu flow).
  private async startOne(deviceId: string, stereo: boolean) {
    try {
      await this.ensureGraph(deviceId, stereo);
    } catch (err) {
      console.error("[extra-mic] capture failed:", deviceId, err);
      // Roll the selection back so the checkbox reflects reality.
      const remaining = this.store.getState().streamedMicDeviceIds.filter((d) => d !== deviceId);
      this.store.getState().setStreamedMicDeviceIds(remaining);
      return;
    }
    const wasSfu = this.deps.getMode() === "sfu";
    await this.emit("start-extra-mic").catch(() => {});
    if (wasSfu) await this.produceOne(deviceId, stereo);
    this.store.getState().announceEvent(announce_extra_mic_started_you());
    playCue(this.ctx, "share-start");
  }

  // Stop streaming one extra mic (user unchecked it, or it died). Closes the
  // producer and tells the server to close its server-side producer (a client close
  // doesn't propagate) — which releases the SFU pin once it was our last.
  private async stopOne(deviceId: string) {
    const entry = this.mics.get(deviceId);
    if (!entry) return;
    const producerId = entry.producer?.id;
    if (entry.producer && !entry.producer.closed) entry.producer.close();
    entry.source.disconnect();
    entry.dest.disconnect();
    entry.stream.getTracks().forEach((t) => t.stop());
    this.mics.delete(deviceId);
    // Always signal the server: with a producerId it closes that producer; with none
    // (we never reached SFU) it just reconciles the set so the SFU pin can't leak.
    await this.emit("stop-extra-mic", producerId ? { producerId } : {}).catch(() => {});
    this.store.getState().announceEvent(announce_extra_mic_stopped_you());
    playCue(this.ctx, "share-stop");
  }

  // Mono↔stereo flip for one device. The codec can't renegotiate live, so close +
  // re-produce — but produce the NEW one BEFORE retiring the old server-side
  // producer, so the server always still sees a "mic" producer for us and never
  // drops us from extraMicStreamers. That keeps the SFU pin held, so a ≤2-peer room
  // doesn't flap SFU→P2P→SFU.
  private async restartOne(deviceId: string, stereo: boolean) {
    const entry = this.mics.get(deviceId);
    if (!entry) return;
    const oldProducerId = entry.producer?.id;
    if (entry.producer && !entry.producer.closed) entry.producer.close();
    entry.producer = null;
    if (this.deps.getMode() === "sfu") {
      try {
        await this.produceOne(deviceId, stereo);
      } catch (err) {
        console.error("[extra-mic] restart failed:", deviceId, err);
      }
    }
    // Retire the OLD server-side producer now that the new one exists.
    if (oldProducerId)
      await this.emit("stop-extra-mic", { producerId: oldProducerId }).catch(() => {});
  }

  // Reconcile our outgoing producers to the desired selection. Always advances the
  // baseline; while disconnected, only that (the persisted selection is applied at
  // join via produceAll). All ops go through the serialization chain.
  reconcile(desired: Map<string, boolean>, connected: boolean) {
    const prev = this.prevDesired;
    this.prevDesired = desired;
    if (!connected) return;
    const { toStop, toStart, toRestart } = diffDesiredMics(prev, desired);
    for (const deviceId of toStop) void this.runOp(() => this.stopOne(deviceId));
    for (const [deviceId, stereo] of toStart)
      void this.runOp(() => this.startOne(deviceId, stereo));
    for (const [deviceId, stereo] of toRestart)
      void this.runOp(() => this.restartOne(deviceId, stereo));
  }

  // Which device owns a given producer id (for the "someone stopped my stream" path,
  // which deselects the device so the reconcile effect tears it down).
  deviceIdForProducer(producerId: string): string | null {
    for (const [deviceId, entry] of this.mics) {
      if (entry.producer?.id === producerId) return deviceId;
    }
    return null;
  }

  // Tear down every capture + its nodes + producer (leave). App-owned tracks would
  // otherwise leak across rooms.
  teardownAll() {
    for (const entry of this.mics.values()) {
      if (entry.producer && !entry.producer.closed) entry.producer.close();
      entry.source.disconnect();
      entry.dest.disconnect();
      entry.stream.getTracks().forEach((t) => t.stop());
    }
    this.mics.clear();
  }
}
