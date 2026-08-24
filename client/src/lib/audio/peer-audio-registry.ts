// Incoming peer audio: the per-peer Web Audio pipelines, the owner maps that
// track which peer owns each share/file/mic "music stream" tile, and the gain
// math that composes per-peer volume, deafen, listener-side local mute, and
// music auto-ducking. Extracted from useMediasoup so the gain logic is pure and
// unit-testable, and the registry can be driven with the same fakes the
// characterization suite uses (no hook render).
import type { Device } from "mediasoup-client";
import type { Transport, Consumer } from "mediasoup-client/types";
import { useRoomStore } from "../../stores/room";
import { resumeContext, GAIN_RAMP } from "./shared-context";
import {
  announce_a_participant,
  announce_music_started,
  share_stream_name,
  share_stream_name_titled,
  file_stream_name,
  file_stream_name_titled,
  mic_stream_name,
  mic_stream_name_titled,
} from "../../paraglide/messages.js";

// Auto-ducking: how loud a music-type stream stays while a voice is active.
// Smaller = the music dips further under talking.
export const DUCK_FACTOR = 0.22;
// Ducking ramp time-constants (seconds): attack fast (duck under a voice that
// starts), release a touch slower (bring the music back, avoiding pumping
// between words).
const DUCK_ATTACK = 0.05;
const DUCK_RELEASE = 0.09;

// The subset of a peer's store state that determines its playback gain. A full
// PeerState satisfies this structurally, so callers pass the store peer directly.
export interface PeerGainInputs {
  volume: number; // 0-4
  isMusic: boolean;
  localMuted: boolean;
}

// The gain a peer's audio should currently play at, composing the listener's
// per-peer volume, deafen, local mute, and music auto-ducking (music dips while
// a voice is active). Voice peers are unaffected by ducking. Pure: the caller
// supplies the live store flags + voice-active state.
export function computeEffectiveGain(
  peer: PeerGainInputs | undefined,
  flags: { isDeafened: boolean; duckingEnabled: boolean; isVoiceActive: boolean },
): number {
  // No peer, room-wide deafen, or you locally muted this one → silence.
  if (!peer || flags.isDeafened || peer.localMuted) return 0;
  // Ducking is gated by the room-wide toggle: with it off, music-type streams
  // (caster/share/file) never dip under voice.
  if (peer.isMusic && flags.isVoiceActive && flags.duckingEnabled) return peer.volume * DUCK_FACTOR;
  return peer.volume;
}

export interface PeerAudio {
  audioEl: HTMLAudioElement;
  gainNode: GainNode;
  sourceNode: MediaStreamAudioSourceNode;
  // Taps the incoming signal (pre-gain) for client-side "who's talking" level
  // detection — see the speaking-detection loop. Passive: only does work when
  // read, so leaving it permanently connected is effectively free.
  analyser: AnalyserNode;
  // SFU-only
  consumer?: Consumer;
}

interface ConsumeResult {
  ok: boolean;
  consumerId: string;
  producerId: string;
  kind: string;
  rtpParameters: Record<string, unknown>;
  error?: string;
}

// Matches useMediasoup's `emit` helper: a promisified, ack-with-timeout socket emit.
export type Emit = <T>(event: string, data?: unknown) => Promise<T>;

// Readiness getters into the live SFU state the registry consumes against. The
// hook supplies closures over its deviceRef / recvTransportRef.
export interface SfuConsumeDeps {
  getDevice(): Device | null;
  getRecvTransport(): Transport | null;
}

type PendingProducer = { peerId: string; producerId: string; source: string; title?: string };
type StreamKind = "share" | "file" | "mic";

export class PeerAudioRegistry {
  // The live map of every incoming pipeline (voice/music keyed by peerId;
  // share/file/mic keyed by producerId). Exposed read-only by reference: the hook
  // returns it as `peerAudiosRef` and the speaking detector reads each analyser.
  // NEVER reassign it — only mutate in place — so that exposed reference stays valid.
  readonly peerAudios = new Map<string, PeerAudio>();
  private readonly shareOwners = new Map<string, string>();
  private readonly fileOwners = new Map<string, string>();
  private readonly micStreamOwners = new Map<string, string>();
  // Producers announced while the SFU transports were still being built —
  // consumed by drainPending() at the end of setupSfu instead of being dropped.
  private pending: PendingProducer[] = [];
  // Whether the server currently reports a voice active (drives ducking). Seeded
  // by join from the snapshot; flipped by applyDuck.
  private voiceActive = false;

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
    private readonly deps: SfuConsumeDeps,
  ) {
    this.getCtx = typeof ctx === "function" ? ctx : () => ctx;
  }

  get isVoiceActive(): boolean {
    return this.voiceActive;
  }
  set isVoiceActive(v: boolean) {
    this.voiceActive = v;
  }

  // The gain a peer should play at right now, reading the live store + voice state.
  effectiveGain(peerId: string): number {
    const state = this.store.getState();
    return computeEffectiveGain(state.peers.get(peerId), {
      isDeafened: state.isDeafened,
      duckingEnabled: state.duckingEnabled,
      isVoiceActive: this.voiceActive,
    });
  }

  private createPipeline(track: MediaStreamTrack): Omit<PeerAudio, "consumer"> {
    const stream = new MediaStream([track]);
    const audioEl = new Audio();
    audioEl.srcObject = stream;
    audioEl.autoplay = true;
    // iOS Safari requires webkit attributes
    (audioEl as unknown as Record<string, boolean>).playsInline = true;
    (audioEl as unknown as Record<string, string>).webkitPlaysinline = "true";
    // Mute the HTML element — audio is routed through the shared AudioContext.
    // `muted`, not just `volume = 0`: iOS ignores `volume` on media elements
    // (it's under hardware control), so the element would play the peer at full
    // level in parallel with the Web Audio path — two copies a few ms apart,
    // i.e. the "phased" sound iOS users reported.
    audioEl.muted = true;
    audioEl.volume = 0;

    resumeContext(this.ctx);

    const sourceNode = this.ctx.createMediaStreamSource(stream);
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = 1;
    sourceNode.connect(gainNode);
    gainNode.connect(this.ctx.destination);

    // Tap the PRE-gain signal for speaking detection, so what we measure is what
    // the peer is transmitting — independent of our local volume / deafen / mute.
    // An AnalyserNode is passive (computes only when read) and is never connected
    // onward, so it adds no audio and negligible cost.
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0;
    sourceNode.connect(analyser);

    return { audioEl, gainNode, sourceNode, analyser };
  }

  private destroyPipeline(pa: PeerAudio) {
    pa.consumer?.close();
    pa.audioEl.srcObject = null;
    pa.audioEl.pause();
    pa.sourceNode.disconnect();
    pa.gainNode.disconnect();
    pa.analyser.disconnect();
  }

  // A remote P2P track arrived (RTCPeerConnection.ontrack). Build its pipeline and
  // start it at the correct gain so an SFU→P2P switch doesn't reset deafen/volume.
  attachP2pTrack(peerId: string, track: MediaStreamTrack) {
    if ("playoutDelayHint" in track) {
      (track as unknown as Record<string, number>).playoutDelayHint = 0;
    }
    const pipeline = this.createPipeline(track);
    pipeline.gainNode.gain.value = this.effectiveGain(peerId);
    this.peerAudios.set(peerId, pipeline);
  }

  // SFU: consume a remote producer into a pipeline. Voice/music tiles are keyed by
  // peerId; share/file/mic are separate producers keyed by producerId with their
  // own owner map, so a peer producing voice + a share never collide. If the SFU
  // transports aren't up yet, queue for drainPending().
  async consumeProducer(peerId: string, producerId: string, source = "voice", title?: string) {
    const device = this.deps.getDevice();
    const recvTransport = this.deps.getRecvTransport();
    if (!device || !recvTransport) {
      // SFU setup is still in flight — queue it for the end of setupSfu
      // (dropping it would permanently silence this producer for us).
      this.pending.push({ peerId, producerId, source, title });
      return;
    }

    const res = await this.emit<ConsumeResult>("consume", {
      producerId,
      rtpCapabilities: device.recvRtpCapabilities,
    });

    const consumer = await recvTransport.consume({
      id: res.consumerId,
      producerId: res.producerId,
      kind: res.kind as "audio",
      rtpParameters: res.rtpParameters as Parameters<
        typeof recvTransport.consume
      >[0]["rtpParameters"],
    });

    if ("playoutDelayHint" in consumer.track) {
      (consumer.track as unknown as Record<string, number>).playoutDelayHint = 0;
    }

    const pipeline = this.createPipeline(consumer.track);

    // A "share" / "file" / "mic" is a SEPARATE producer rendered as its own tile
    // keyed by producerId. Share & file are music-type (ducked); a mic is voice-like
    // (isMicStream, NOT ducked). Stereo is preserved end-to-end by createPipeline.
    if (source === "share") {
      this.addStreamTile(producerId, peerId, this.shareOwners, consumer, pipeline, false, (name) =>
        title ? share_stream_name_titled({ name, title }) : share_stream_name({ name }),
      );
      return;
    }
    if (source === "file") {
      this.addStreamTile(producerId, peerId, this.fileOwners, consumer, pipeline, false, (name) =>
        title ? file_stream_name_titled({ name, title }) : file_stream_name({ name }),
      );
      return;
    }
    if (source === "mic") {
      this.addStreamTile(
        producerId,
        peerId,
        this.micStreamOwners,
        consumer,
        pipeline,
        true,
        (name) => (title ? mic_stream_name_titled({ name, title }) : mic_stream_name({ name })),
      );
      return;
    }

    this.peerAudios.set(peerId, { ...pipeline, consumer });

    // Flag a music-caster peer (e.g. Ecobox) so the UI shows it as a media source.
    // The first time we learn this peer casts music, announce + log it — a
    // re-consume (mode switch / reconnect) finds isMusic already set, so it never
    // re-announces.
    if (source === "music") {
      if (!this.store.getState().peers.get(peerId)?.isMusic) {
        const name =
          this.store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
        this.store.getState().announceEvent(announce_music_started({ name }));
      }
      this.store.getState().setPeerMusic(peerId, true);
      // Also flag it as an actual caster (stricter than isMusic, which share/file
      // tiles share) so the UI offers the immediate "Remove caster".
      this.store.getState().setPeerCaster(peerId, true);
    }

    // Start at the correct gain: respects deafen, and ducks immediately if a
    // voice is already active when this (music) producer joins.
    pipeline.gainNode.gain.value = this.effectiveGain(peerId);
  }

  // Register a separate share/file/mic producer tile (keyed by producerId) in the
  // store + its owner map + the pipeline map, starting it at the right gain.
  private addStreamTile(
    producerId: string,
    ownerPeerId: string,
    owners: Map<string, string>,
    consumer: Consumer,
    pipeline: Omit<PeerAudio, "consumer">,
    isMic: boolean,
    makeName: (ownerName: string) => string,
  ) {
    const ownerName =
      this.store.getState().peers.get(ownerPeerId)?.displayName ?? announce_a_participant();
    this.store.getState().addPeer(producerId, makeName(ownerName));
    if (isMic) this.store.getState().setPeerMicStream(producerId, true);
    else this.store.getState().setPeerMusic(producerId, true);
    owners.set(producerId, ownerPeerId);
    this.peerAudios.set(producerId, { ...pipeline, consumer });
    pipeline.gainNode.gain.value = this.effectiveGain(producerId);
  }

  // Ramp every music peer to its current effective gain (respecting deafen,
  // per-peer volume, the live duck state, and the room ducking toggle).
  rampMusicGains(ramp: number = GAIN_RAMP) {
    const now = this.ctx.currentTime;
    for (const [peerId, pa] of this.peerAudios) {
      if (!this.store.getState().peers.get(peerId)?.isMusic) continue;
      pa.gainNode.gain.setTargetAtTime(this.effectiveGain(peerId), now, ramp);
    }
  }

  // Server told us whether anyone is talking — ramp every music peer's gain.
  applyDuck(active: boolean) {
    this.voiceActive = active;
    this.rampMusicGains(active ? DUCK_ATTACK : DUCK_RELEASE);
  }

  // Ramp a single peer to its current effective gain (per-peer volume / local mute).
  rampPeer(peerId: string) {
    const pa = this.peerAudios.get(peerId);
    if (pa)
      pa.gainNode.gain.setTargetAtTime(this.effectiveGain(peerId), this.ctx.currentTime, GAIN_RAMP);
  }

  // Ramp every peer to its current effective gain (deafen / un-deafen).
  rampAll() {
    const now = this.ctx.currentTime;
    for (const [peerId, pa] of this.peerAudios) {
      pa.gainNode.gain.setTargetAtTime(this.effectiveGain(peerId), now, GAIN_RAMP);
    }
  }

  private removeStreamTile(producerId: string, owners: Map<string, string>) {
    const pa = this.peerAudios.get(producerId);
    if (pa) {
      this.destroyPipeline(pa);
      this.peerAudios.delete(producerId);
    }
    owners.delete(producerId);
    this.store.getState().removePeer(producerId);
  }

  removeShareStream(producerId: string) {
    this.removeStreamTile(producerId, this.shareOwners);
  }
  removeFileStream(producerId: string) {
    this.removeStreamTile(producerId, this.fileOwners);
  }
  removeMicStream(producerId: string) {
    this.removeStreamTile(producerId, this.micStreamOwners);
  }

  // Drop every share tile owned by a peer (they stopped sharing).
  removeSharesOwnedBy(peerId: string) {
    for (const [producerId, owner] of this.shareOwners)
      if (owner === peerId) this.removeShareStream(producerId);
  }
  // Drop every file tile owned by a peer (they stopped their file stream).
  removeFilesOwnedBy(peerId: string) {
    for (const [producerId, owner] of this.fileOwners)
      if (owner === peerId) this.removeFileStream(producerId);
  }

  // Tear down all audio belonging to a peer (voice/music pipeline keyed by peerId,
  // plus every share/file/mic tile they own) — the audio half of a leave/kick. The
  // caller removes the peer itself from the store and closes any P2P connection.
  removePeerAudio(peerId: string) {
    const pa = this.peerAudios.get(peerId);
    if (pa) {
      this.destroyPipeline(pa);
      this.peerAudios.delete(peerId);
    }
    for (const [producerId, owner] of this.shareOwners)
      if (owner === peerId) this.removeShareStream(producerId);
    for (const [producerId, owner] of this.fileOwners)
      if (owner === peerId) this.removeFileStream(producerId);
    for (const [producerId, owner] of this.micStreamOwners)
      if (owner === peerId) this.removeMicStream(producerId);
  }

  // Who owns a separate-producer tile, and which kind — for re-labelling on a
  // title update. Precedence file → share → mic mirrors the original lookup.
  streamOwner(producerId: string): { ownerId: string; kind: StreamKind } | undefined {
    const fileOwner = this.fileOwners.get(producerId);
    if (fileOwner) return { ownerId: fileOwner, kind: "file" };
    const shareOwner = this.shareOwners.get(producerId);
    if (shareOwner) return { ownerId: shareOwner, kind: "share" };
    const micOwner = this.micStreamOwners.get(producerId);
    if (micOwner) return { ownerId: micOwner, kind: "mic" };
    return undefined;
  }

  // Destroy every pipeline and forget all owner mappings (P2P/SFU teardown). A
  // re-consume (mode switch / reconnect) rebuilds them cleanly.
  cleanupAll() {
    for (const pa of this.peerAudios.values()) this.destroyPipeline(pa);
    this.peerAudios.clear();
    this.shareOwners.clear();
    this.fileOwners.clear();
    this.micStreamOwners.clear();
  }

  // Consume any producers that arrived while the SFU was still being built. A
  // single failed queued consume is logged and skipped, never aborting the rest.
  async drainPending() {
    while (this.pending.length > 0) {
      const p = this.pending.shift()!;
      await this.consumeProducer(p.peerId, p.producerId, p.source, p.title).catch((err) => {
        console.error("[sfu] queued consume failed:", err);
      });
    }
  }

  clearPending() {
    this.pending = [];
  }
}
