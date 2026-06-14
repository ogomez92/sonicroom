import { useRef, useCallback, useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import type { Transport, Producer, Consumer } from "mediasoup-client/types";
import { forceOpusParams } from "../lib/sdp-munger";
import { applySpeakerToContext } from "../lib/audio-devices";
import { playCue, startKnockLoop } from "../lib/sounds";
import { formatMessage, RateLimiter, META_SEP, type ChatMessage } from "../lib/chat";
import {
  announce_joined,
  announce_left,
  announce_music_started,
  announce_music_stopped,
  announce_chat_hint,
  announce_a_participant,
  announce_recording_started,
  announce_recording_stopped,
  announce_recording_unavailable,
  announce_recording_failed,
  announce_streaming_started,
  announce_streaming_stopped,
  announce_streaming_failed,
  announce_streaming_failed_reason,
  announce_mic_muted,
  announce_mic_unmuted,
  announce_peer_muted,
  announce_peer_unmuted,
  announce_share_started,
  announce_share_stopped,
  announce_share_started_you,
  announce_share_stopped_you,
  announce_file_stream_started,
  announce_file_stream_stopped,
  announce_file_stream_started_you,
  announce_file_stream_stopped_you,
  announce_file_stream_ended,
  announce_file_stream_error,
  announce_file_stream_paused,
  announce_file_stream_resumed,
  announce_ducking_enabled,
  announce_ducking_disabled,
  announce_kick_vote,
  announce_kick_vote_withdrawn,
  announce_peer_kicked,
  announce_you_were_kicked,
  announce_no_mic,
  file_stream_name,
  file_player_streaming,
  share_stream_name,
} from "../paraglide/messages.js";
import { useRoomStore, type RoomMode, type JoinRequest } from "../stores/room";

interface ConsumeResult {
  ok: boolean;
  consumerId: string;
  producerId: string;
  kind: string;
  rtpParameters: Record<string, unknown>;
  error?: string;
}

interface PeerAudio {
  audioEl: HTMLAudioElement;
  gainNode: GainNode;
  sourceNode: MediaStreamAudioSourceNode;
  // SFU-only
  consumer?: Consumer;
}

// ICE servers — self-hosted coturn at turn.oriolgomez.com (shared with the
// games on the same VPS). STUN is tried first, so most P2P connections
// never hit the relay; TURN/TURNS only kick in for symmetric NATs and
// restrictive corporate/hotel networks. Credentials are visible to
// clients by design (WebRTC requires them in the browser); coturn's
// denied-peer-ip rules limit blast radius.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:turn.oriolgomez.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:turn.oriolgomez.com:3478?transport=udp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
  {
    urls: "turn:turn.oriolgomez.com:3478?transport=tcp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
  {
    urls: "turns:turn.oriolgomez.com:5349?transport=tcp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
];

// iOS/iPadOS Safari (iPadOS now reports as "MacIntel" + touch). WebKit's audio
// stack is behind the "sample rate keeps breaking" reports: it fights a forced
// AudioContext/getUserMedia sample rate that doesn't match the current hardware
// route, and it drops the whole context into an "interrupted" state on any route
// change (Bluetooth/headset connect, the session flipping to voice-chat when a
// peer joins, Siri, backgrounding).
const isIOS =
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    // iPadOS 13+ reports a desktop "Macintosh" UA; a touch-capable Mac is one.
    (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

// Mic constraints. On iOS we drop the sample-rate hint: forcing a rate the
// current route can't honour (e.g. a Bluetooth headset locked to 16 kHz) yields
// garbled/pitched capture. WebRTC/Opus negotiates its own rate regardless.
// The selected mic is `ideal`, not `exact`, so a remembered-but-unplugged
// device falls back to the default instead of failing the join.
function micConstraints(channelCount: 1 | 2, deviceId?: string): MediaTrackConstraints {
  return {
    channelCount,
    ...(isIOS ? {} : { sampleRate: 48000 }),
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}

// Shared AudioContext — single output buffer for all peers (lower latency than
// one per peer). On iOS we let it adopt the device-native rate instead of pinning
// 48 kHz, so WebKit doesn't resample/fight the hardware on every route change;
// other browsers honour the pin cleanly.
const sharedAudioContext = new AudioContext({
  ...(isIOS ? {} : { sampleRate: 48000 }),
  latencyHint: "interactive",
});

// Auto-ducking: how loud the music stays while someone is talking, and the
// setTargetAtTime time-constants (seconds) for the gain ramps. Smaller = snappier.
// Attack (duck down when a voice starts) is fast; release (bring the music back
// when the voice stops) is a touch slower to avoid pumping between words.
const DUCK_FACTOR = 0.22;
const DUCK_ATTACK = 0.05;
const DUCK_RELEASE = 0.09;
const GAIN_RAMP = 0.03;

// Rapid mute/duck toggling would otherwise announce + chime on every single
// flip — mute 10× and everyone hears/reads it 10×. Coalesce a burst: surface the
// FIRST change immediately (leading edge, so a deliberate single toggle still
// gives instant feedback), suppress the middle, then surface the final settled
// state once more after TOGGLE_DEDUP_MS of quiet — and only if it actually
// differs from what was last surfaced. So a mash shows at most the first + last.
const TOGGLE_DEDUP_MS = 1000;

// Soft limiter sitting after the outgoing mic gain so boosting a quiet/cheap
// mic doesn't clip: transparent until peaks approach 0 dBFS, then ~20:1 with a
// fast attack. Adds ~5 ms of look-ahead latency, negligible for voice.
const MIC_LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 };

// Keep the shared context running. iOS needs a user gesture to start it, and it
// also drops to "suspended" or the WebKit-only "interrupted" state whenever the
// audio route changes / the tab backgrounds — and without re-resuming, audio dies
// until a reload (this is what "keeps fucking up" mid-call). So we resume on the
// first AND every gesture, on each statechange, and when the tab refocuses.
function resumeSharedContext() {
  const state = sharedAudioContext.state as string;
  if (state === "suspended" || state === "interrupted") {
    // iOS rejects resume() while still interrupted (e.g. mid phone call); the
    // statechange/visibility/gesture retries pick it up once it's allowed again.
    sharedAudioContext.resume().catch(() => {});
  }
}
document.addEventListener("touchstart", resumeSharedContext);
document.addEventListener("click", resumeSharedContext);
sharedAudioContext.addEventListener("statechange", resumeSharedContext);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeSharedContext();
});

function createAudioPipeline(track: MediaStreamTrack): Omit<PeerAudio, "consumer"> {
  const stream = new MediaStream([track]);
  const audioEl = new Audio();
  audioEl.srcObject = stream;
  audioEl.autoplay = true;
  // iOS Safari requires webkit attributes
  (audioEl as unknown as Record<string, boolean>).playsInline = true;
  (audioEl as unknown as Record<string, string>).webkitPlaysinline = "true";
  // Mute the HTML element — audio is routed through the shared AudioContext
  audioEl.volume = 0;

  resumeSharedContext();

  const sourceNode = sharedAudioContext.createMediaStreamSource(stream);
  const gainNode = sharedAudioContext.createGain();
  gainNode.gain.value = 1;
  sourceNode.connect(gainNode);
  gainNode.connect(sharedAudioContext.destination);

  return { audioEl, gainNode, sourceNode };
}

function destroyAudioPipeline(pa: PeerAudio) {
  pa.consumer?.close();
  pa.audioEl.srcObject = null;
  pa.audioEl.pause();
  pa.sourceNode.disconnect();
  pa.gainNode.disconnect();
}

export function useMediasoup() {
  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const producerRef = useRef<Producer | null>(null);
  const peerAudiosRef = useRef<Map<string, PeerAudio>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  // True when we joined WITHOUT a microphone (opted out, or none available /
  // permission denied) — we listen and use text chat only. The outgoing track is
  // always outDest's (silent with no mic connected), so producing/adding it
  // still works; we just never acquire a mic and stay muted. Persists across
  // reconnects so a rejoin doesn't re-prompt.
  const noMicRef = useRef(false);
  // True while the server reports someone is talking (drives music ducking).
  const isVoiceActiveRef = useRef(false);
  // P2P
  const p2pConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Remote ICE candidates that arrived before their peer connection had a
  // remote description (or before it existed at all) — applied after
  // setRemoteDescription instead of being dropped (addIceCandidate throws
  // without a remote description, and a lost host candidate can stall ICE).
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  // Monotonic per-peer offer counter: a queued offer handler bails when a
  // newer offer from the same peer arrived while it waited in the transition
  // chain — answering the superseded one would consume the newer session's
  // queued candidates and build a dead connection.
  const offerSeqRef = useRef<Map<string, number>>(new Map());
  const modeRef = useRef<RoomMode>("p2p");
  // Producers announced while the SFU transports were still being built —
  // consumed at the end of setupSfu instead of being silently dropped.
  const pendingProducersRef = useRef<Array<{ peerId: string; producerId: string; source: string }>>(
    [],
  );
  // P2P↔SFU transitions (and reconnect rebuilds) are serialized through this
  // promise chain so an in-flight transition always finishes tearing down /
  // building up before the next starts — overlapping async handlers could
  // otherwise re-add stale connections after a newer teardown already ran.
  const transitionChainRef = useRef<Promise<void>>(Promise.resolve());
  // Outgoing audio graph: mic → micGain → limiter → outDest → outgoing track.
  // The track added to peers / produced to the SFU is always outDest's, so the
  // mic slider just rides `micGain` and shared system audio is mixed straight
  // into `outDest` (bypassing the gain/limiter so the music keeps its dynamics).
  const outGraphRef = useRef<{
    micSource: MediaStreamAudioSourceNode | null;
    micGain: GainNode;
    limiter: DynamicsCompressorNode;
    outDest: MediaStreamAudioDestinationNode;
    displaySource: MediaStreamAudioSourceNode | null;
    // Shared system/tab audio gets its OWN destination so it's produced as a
    // separate stereo "share" track — the voice track (outDest) stays mono.
    shareDest: MediaStreamAudioDestinationNode | null;
    // A streamed local file gets its OWN destination too, so it's produced as a
    // separate stereo "file" track, independent of voice AND of any share. The
    // <audio> element feeding it is swapped (replace file) without touching this
    // destination or its producer.
    fileSource: MediaElementAudioSourceNode | null;
    fileDest: MediaStreamAudioDestinationNode | null;
    micStream: MediaStream | null;
  } | null>(null);
  // Audio share (system / tab audio produced as its own stereo "share" track)
  const displayStreamRef = useRef<MediaStream | null>(null);
  // The local stereo "share" producer (SFU), separate from the voice producer.
  const musicProducerRef = useRef<Producer | null>(null);
  // Other peers' incoming share streams: producerId -> owner peerId, so we can
  // tear down a share "music" tile when its owner stops sharing or leaves.
  const shareOwnersRef = useRef<Map<string, string>>(new Map());
  // Local file streaming (independent of the audio share above): the stereo
  // "file" producer (SFU), the <audio> element decoding the file, its object
  // URL, the Web Audio source node, and an AbortController for the element's
  // ended/error listeners (so swapping the file never fires a stale handler).
  const fileProducerRef = useRef<Producer | null>(null);
  const fileAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileUrlRef = useRef<string | null>(null);
  const fileAbortRef = useRef<AbortController | null>(null);
  // Other peers' incoming file streams: producerId -> owner peerId, mirroring
  // shareOwnersRef so a peer can stream a file AND share system audio at once
  // without the two tearing each other's tiles down.
  const fileOwnersRef = useRef<Map<string, string>>(new Map());
  // Local anti-spam guard for instant "thunk" feedback (the server enforces the
  // same 5-per-10s budget authoritatively).
  const chatLimiterRef = useRef(new RateLimiter());
  // The first received chat message carries a one-time hint that Alt+1..0
  // reads recent messages aloud even with the chat panel closed.
  const chatHintGivenRef = useRef(false);
  // Set while we're knocking on a public room and waiting to be let in. The
  // pushed join-approved/-denied handlers resolve/reject it so the blocked join
  // flow continues (re-join) or fails (denied).
  const admissionRef = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const store = useRoomStore;

  // Queue `fn` behind any in-flight mode transition. The chain itself never
  // breaks (failures are surfaced to the caller's promise, then swallowed for
  // the next link), so one failed transition can't wedge all later ones.
  const runTransition = useCallback(<T>(fn: () => Promise<T>): Promise<T> => {
    const run = transitionChainRef.current.then(fn);
    transitionChainRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  const emit = useCallback(
    <T>(event: string, data?: unknown): Promise<T> =>
      new Promise((resolve, reject) => {
        const socket = socketRef.current;
        if (!socket) return reject(new Error("No socket"));
        // The timeout matters beyond slow servers: if the socket drops while
        // an ack is pending, socket.io NEVER invokes the callback — an
        // un-timed-out emit inside a queued transition would leave the
        // transition chain pending forever and block the reconnect rejoin.
        socket
          .timeout(10_000)
          .emit(event, data, (err: Error | null, res: T & { ok: boolean; error?: string }) => {
            if (err) return reject(err);
            if (res.ok) resolve(res);
            else reject(new Error(res.error || "Unknown error"));
          });
      }),
    [],
  );

  // The gain a peer's audio should currently play at, composing the listener's
  // per-peer volume, deafen, and music auto-ducking (music drops while a voice
  // is active). Voice peers are unaffected by ducking.
  const effectiveGain = useCallback(
    (peerId: string): number => {
      const state = store.getState();
      const peer = state.peers.get(peerId);
      if (!peer || state.isDeafened) return 0;
      // Ducking is gated by the room-wide toggle: with it off, music-type
      // streams (caster/share/file) never dip under voice.
      if (peer.isMusic && isVoiceActiveRef.current && state.duckingEnabled)
        return peer.volume * DUCK_FACTOR;
      return peer.volume;
    },
    [store],
  );

  // Ramp every music peer's gain to its current effective value (respecting
  // deafen, per-peer volume, the live duck state, and the room ducking toggle).
  const rampMusicGains = useCallback(
    (ramp: number = GAIN_RAMP) => {
      const now = sharedAudioContext.currentTime;
      for (const [peerId, pa] of peerAudiosRef.current) {
        if (!store.getState().peers.get(peerId)?.isMusic) continue;
        pa.gainNode.gain.setTargetAtTime(effectiveGain(peerId), now, ramp);
      }
    },
    [store, effectiveGain],
  );

  // Server told us whether anyone is talking — ramp every music peer's gain.
  const applyDuck = useCallback(
    (active: boolean) => {
      isVoiceActiveRef.current = active;
      rampMusicGains(active ? DUCK_ATTACK : DUCK_RELEASE);
    },
    [rampMusicGains],
  );

  // Per-key state for the toggle coalescer (see TOGGLE_DEDUP_MS): a debounce
  // timer, the value we last surfaced, and the latest pending value + emitter.
  const surfaceRef = useRef<
    Map<
      string,
      {
        timer: number | null;
        lastEmitted: boolean | undefined;
        latestValue: boolean;
        latestEmit: () => void;
      }
    >
  >(new Map());

  // Coalesce a rapid run of boolean-state toggles (mute, ducking, …) into at
  // most a leading + a trailing announcement. `emit` does the actual
  // announce/chime for THIS change; it runs immediately on the first change of a
  // burst, and again when the burst settles iff the final value differs from the
  // last surfaced one. The underlying effect (mute/gain) is applied by the
  // caller BEFORE this — only the user-facing surfacing is debounced.
  const surfaceToggle = useCallback((key: string, value: boolean, emit: () => void) => {
    const map = surfaceRef.current;
    const s = map.get(key) ?? {
      timer: null,
      lastEmitted: undefined as boolean | undefined,
      latestValue: value,
      latestEmit: emit,
    };
    s.latestValue = value;
    s.latestEmit = emit;
    // Leading edge: nothing pending and this is a genuine change → surface now.
    if (s.timer === null && value !== s.lastEmitted) {
      s.lastEmitted = value;
      emit();
    }
    if (s.timer !== null) clearTimeout(s.timer);
    s.timer = window.setTimeout(() => {
      s.timer = null;
      if (s.latestValue !== s.lastEmitted) {
        s.lastEmitted = s.latestValue;
        s.latestEmit();
      }
    }, TOGGLE_DEDUP_MS);
    map.set(key, s);
  }, []);

  // --- Shared: clean up all peer audio ---
  const cleanupAllPeerAudio = useCallback(() => {
    for (const pa of peerAudiosRef.current.values()) {
      destroyAudioPipeline(pa);
    }
    peerAudiosRef.current.clear();
    // Share + file streams are keyed in peerAudiosRef too; drop their owner
    // mappings so a re-consume (mode switch / reconnect) rebuilds them cleanly.
    shareOwnersRef.current.clear();
    fileOwnersRef.current.clear();
  }, []);

  // --- Outgoing audio graph (mic gain + soft limiter, + optional shared audio) ---
  // Built lazily and reused for the whole session. The produced/added track is
  // always `outDest`'s, so we never have to swap tracks on senders/producer.
  const ensureOutGraph = useCallback(() => {
    if (outGraphRef.current) return outGraphRef.current;
    // The mic now flows through the shared context, so it must be running
    // (it starts suspended on iOS until a user gesture).
    resumeSharedContext();
    const ctx = sharedAudioContext;
    const micGain = ctx.createGain();
    micGain.gain.value = store.getState().micGain;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = MIC_LIMITER.threshold;
    limiter.knee.value = MIC_LIMITER.knee;
    limiter.ratio.value = MIC_LIMITER.ratio;
    limiter.attack.value = MIC_LIMITER.attack;
    limiter.release.value = MIC_LIMITER.release;
    const outDest = ctx.createMediaStreamDestination();
    micGain.connect(limiter);
    limiter.connect(outDest);
    outGraphRef.current = {
      micSource: null,
      micGain,
      limiter,
      outDest,
      displaySource: null,
      shareDest: null,
      fileSource: null,
      fileDest: null,
      micStream: null,
    };
    return outGraphRef.current;
  }, [store]);

  // (Re)route the raw mic into the outgoing graph. Idempotent for a given
  // stream; re-runs when the mic is re-acquired (track died / device change).
  const connectMicToGraph = useCallback(
    (stream: MediaStream) => {
      const g = ensureOutGraph();
      if (g.micStream === stream && g.micSource) return;
      g.micSource?.disconnect();
      g.micSource = sharedAudioContext.createMediaStreamSource(stream);
      g.micSource.connect(g.micGain);
      g.micStream = stream;
    },
    [ensureOutGraph],
  );

  // --- Device selection (set in the lobby or via the in-call settings) ---
  const micDeviceId = useRoomStore((s) => s.micDeviceId);
  const speakerDeviceId = useRoomStore((s) => s.speakerDeviceId);

  // All incoming audio plays through the shared context, so the speaker pick
  // is one setSinkId there — it covers every peer, current and future.
  useEffect(() => {
    applySpeakerToContext(sharedAudioContext, speakerDeviceId);
  }, [speakerDeviceId]);

  // Mid-call mic switch: re-acquire the mic on the new device and reroute it
  // into the outgoing graph. Senders/producers never see the swap — they
  // always carry outDest's track. Guarded by a prev-ref so it only runs on an
  // actual change; before a call (no local stream) join() picks the device up.
  const prevMicDeviceRef = useRef(micDeviceId);
  useEffect(() => {
    if (prevMicDeviceRef.current === micDeviceId) return;
    prevMicDeviceRef.current = micDeviceId;
    if (!localStreamRef.current) return;
    let cancelled = false;
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(2, micDeviceId),
        });
      } catch (err) {
        console.error("[mic] device switch failed:", err);
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // Carry an active mute onto the fresh track before it can leak audio.
      if (store.getState().isMuted) stream.getAudioTracks().forEach((t) => (t.enabled = false));
      const old = localStreamRef.current;
      localStreamRef.current = stream;
      connectMicToGraph(stream);
      old?.getTracks().forEach((t) => t.stop());
    })();
    return () => {
      cancelled = true;
    };
  }, [micDeviceId, connectMicToGraph, store]);

  // --- P2P: create a peer connection ---
  const ensureLocalStream = useCallback(async () => {
    // Mic-less session: never acquire (or re-acquire) a microphone. Callers
    // build/produce from outDest's silent track instead, guarding the null.
    if (noMicRef.current) return null;

    const existing = localStreamRef.current;
    const track = existing?.getAudioTracks()[0];
    if (track && track.readyState === "live") return existing!;

    // Re-acquire mic (on the user's selected device, if any)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints(1, useRoomStore.getState().micDeviceId),
    });
    localStreamRef.current = stream;
    connectMicToGraph(stream);
    return stream;
  }, [connectMicToGraph]);

  const createP2pConnection = useCallback(
    async (peerId: string, isOfferer: boolean) => {
      const socket = socketRef.current;
      if (!socket) return;

      // If we already have a connection to this peer (a re-offer, or a mode
      // switch re-establishing the mesh), tear it down first so the peer map
      // never ends up pointing at a stale/duplicate RTCPeerConnection — ICE
      // candidates are routed by peer id, and a dead PC in the map silently
      // sinks them so ICE never completes.
      const stale = p2pConnectionsRef.current.get(peerId);
      if (stale) {
        stale.close();
        p2pConnectionsRef.current.delete(peerId);
      }

      const localStream = await ensureLocalStream();
      if (localStream) connectMicToGraph(localStream);

      const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
      });

      // Send the processed outgoing track (mic gain + limiter, + shared audio),
      // not the raw mic.
      const g = ensureOutGraph();
      pc.addTrack(g.outDest.stream.getAudioTracks()[0], g.outDest.stream);

      // ICE candidates → relay via server
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("p2p-signal", {
            targetPeerId: peerId,
            type: "ice-candidate",
            payload: e.candidate.toJSON(),
          });
        }
      };

      // Remote track → audio pipeline
      pc.ontrack = (e) => {
        const remoteTrack = e.track;
        if ("playoutDelayHint" in remoteTrack) {
          (remoteTrack as unknown as Record<string, number>).playoutDelayHint = 0;
        }
        const pipeline = createAudioPipeline(remoteTrack);
        // Respect deafen / per-peer volume on a (re)built P2P pipeline too —
        // otherwise an SFU→P2P switch resets everyone to full volume and a
        // deafened listener starts hearing audio again.
        pipeline.gainNode.gain.value = effectiveGain(peerId);
        peerAudiosRef.current.set(peerId, pipeline);
      };

      p2pConnectionsRef.current.set(peerId, pc);

      if (isOfferer) {
        // Create offer with low-latency Opus params
        pc.createOffer().then(async (offer) => {
          offer.sdp = forceOpusParams(offer.sdp!);
          await pc.setLocalDescription(offer);
          socket.emit("p2p-signal", {
            targetPeerId: peerId,
            type: "offer",
            payload: offer,
          });
        });
      }

      return pc;
    },
    [ensureLocalStream, connectMicToGraph, ensureOutGraph, effectiveGain],
  );

  // Apply candidates that were queued for a peer while its connection had no
  // remote description yet. Call right after setRemoteDescription.
  const flushPendingCandidates = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const pending = pendingCandidatesRef.current.get(peerId);
    pendingCandidatesRef.current.delete(peerId);
    if (!pending) return;
    for (const candidate of pending) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => {
        console.error("[p2p] queued addIceCandidate failed:", err);
      });
    }
  }, []);

  // --- P2P: tear down all connections ---
  const teardownP2p = useCallback(() => {
    for (const pc of p2pConnectionsRef.current.values()) {
      pc.close();
    }
    p2pConnectionsRef.current.clear();
    pendingCandidatesRef.current.clear();
    cleanupAllPeerAudio();
  }, [cleanupAllPeerAudio]);

  // --- SFU: tear down mediasoup transports ---
  const teardownSfu = useCallback(() => {
    producerRef.current?.close();
    producerRef.current = null;
    musicProducerRef.current?.close();
    musicProducerRef.current = null;
    // The file producer is rebuilt by setupSfuInner if a file stream is still
    // active; closing with stopTracks:false keeps fileDest's track alive.
    fileProducerRef.current?.close();
    fileProducerRef.current = null;
    sendTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current?.close();
    recvTransportRef.current = null;
    pendingProducersRef.current = [];
    // Candidates queued here can only be trailing ones from a dead P2P epoch
    // (a new P2P session's candidates can't arrive before its offer) — drop
    // them so they never flush into a future session's connection.
    pendingCandidatesRef.current.clear();
    cleanupAllPeerAudio();
  }, [cleanupAllPeerAudio]);

  // --- SFU: consume a producer ---
  const consumeProducer = useCallback(
    async (peerId: string, producerId: string, source: string = "voice") => {
      const device = deviceRef.current;
      const recvTransport = recvTransportRef.current;
      if (!device || !recvTransport) {
        // SFU setup is still in flight — queue it for the end of setupSfu
        // (dropping it would permanently silence this producer for us).
        pendingProducersRef.current.push({ peerId, producerId, source });
        return;
      }

      const res = await emit<ConsumeResult>("consume", {
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

      const pipeline = createAudioPipeline(consumer.track);

      // A "share" is a peer casting system/tab audio as a SEPARATE stereo
      // producer (their voice stays its own mono track). Represent it as its
      // own "music stream" participant keyed by the producer id, so a peer that
      // produces BOTH voice and a share never collides in the peer/audio maps.
      // Stereo is preserved end-to-end by createAudioPipeline.
      if (source === "share") {
        const ownerName =
          store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
        store.getState().addPeer(producerId, share_stream_name({ name: ownerName }));
        store.getState().setPeerMusic(producerId, true);
        shareOwnersRef.current.set(producerId, peerId);
        peerAudiosRef.current.set(producerId, { ...pipeline, consumer });
        pipeline.gainNode.gain.value = effectiveGain(producerId);
        return;
      }

      // A "file" is a peer streaming a local audio file as a SEPARATE stereo
      // producer — same treatment as a share (its own music-stream tile keyed by
      // producer id, ducks under voice), but tracked in its own owner map so a
      // peer streaming a file AND sharing system audio keeps the two independent.
      if (source === "file") {
        const ownerName =
          store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
        store.getState().addPeer(producerId, file_stream_name({ name: ownerName }));
        store.getState().setPeerMusic(producerId, true);
        fileOwnersRef.current.set(producerId, peerId);
        peerAudiosRef.current.set(producerId, { ...pipeline, consumer });
        pipeline.gainNode.gain.value = effectiveGain(producerId);
        return;
      }

      peerAudiosRef.current.set(peerId, { ...pipeline, consumer });

      // Flag a music-caster peer (e.g. Ecobox) so the UI shows it as a media
      // source. Stereo is preserved end-to-end by createAudioPipeline. The
      // first time we learn this peer casts music, announce + log it — a
      // re-consume (mode switch / reconnect) finds isMusic already set, so it
      // never re-announces.
      if (source === "music") {
        if (!store.getState().peers.get(peerId)?.isMusic) {
          const name = store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
          store.getState().announceEvent(announce_music_started({ name }));
        }
        store.getState().setPeerMusic(peerId, true);
      }

      // Start at the correct gain: respects deafen, and ducks immediately if a
      // voice is already active when this (music) producer joins.
      pipeline.gainNode.gain.value = effectiveGain(peerId);
    },
    [emit, store, effectiveGain],
  );

  // Produce the shared system/tab audio as a SEPARATE stereo, hi-fi "share"
  // track (the router's 256 kbps ceiling lets it negotiate full quality). The
  // voice producer is untouched, so voice stays mono/64k. SFU-only — an active
  // share forces the room onto the SFU server-side. Idempotent.
  const produceShare = useCallback(async () => {
    const sendTransport = sendTransportRef.current;
    const device = deviceRef.current;
    const g = outGraphRef.current;
    if (!sendTransport || !device || !g?.shareDest) return;
    if (musicProducerRef.current && !musicProducerRef.current.closed) return;
    const track = g.shareDest.stream.getAudioTracks()[0];
    if (!track) return;
    musicProducerRef.current = await sendTransport.produce({
      track,
      codecOptions: {
        opusStereo: true,
        opusDtx: false,
        opusFec: true,
        opusMaxPlaybackRate: 48000,
        opusMaxAverageBitrate: 256000,
      },
      codec: device.recvRtpCapabilities.codecs?.find(
        (c) => c.mimeType.toLowerCase() === "audio/opus",
      ),
      appData: { source: "share" },
      // shareDest is an app-owned, long-lived Web Audio track reused across the
      // session; mediasoup-client must NOT stop it when this producer closes
      // (default stopTracks:true would kill it, so a later re-produce sends a
      // dead track and no RTP flows).
      stopTracks: false,
    });
  }, []);

  // Produce the streamed local file as a SEPARATE stereo, hi-fi "file" track
  // (mirrors produceShare — the 256 kbps ceiling lets it negotiate full
  // quality). Independent of the share producer. SFU-only; idempotent.
  const produceFile = useCallback(async () => {
    const sendTransport = sendTransportRef.current;
    const device = deviceRef.current;
    const g = outGraphRef.current;
    if (!sendTransport || !device || !g?.fileDest) return;
    if (fileProducerRef.current && !fileProducerRef.current.closed) return;
    const track = g.fileDest.stream.getAudioTracks()[0];
    if (!track) return;
    fileProducerRef.current = await sendTransport.produce({
      track,
      codecOptions: {
        opusStereo: true,
        opusDtx: false,
        opusFec: true,
        opusMaxPlaybackRate: 48000,
        opusMaxAverageBitrate: 256000,
      },
      codec: device.recvRtpCapabilities.codecs?.find(
        (c) => c.mimeType.toLowerCase() === "audio/opus",
      ),
      appData: { source: "file" },
      // fileDest is an app-owned, long-lived Web Audio track reused across the
      // session and rebuilt-on-reconnect produces; mediasoup-client must NOT
      // stop it when this producer closes (see produceShare).
      stopTracks: false,
    });
  }, []);

  // Tear down an incoming peer's share "music stream" (they stopped, or left).
  const removeShareStream = useCallback(
    (producerId: string) => {
      const pa = peerAudiosRef.current.get(producerId);
      if (pa) {
        destroyAudioPipeline(pa);
        peerAudiosRef.current.delete(producerId);
      }
      shareOwnersRef.current.delete(producerId);
      store.getState().removePeer(producerId);
    },
    [store],
  );

  // Tear down an incoming peer's file "music stream" (they stopped, or left).
  const removeFileStream = useCallback(
    (producerId: string) => {
      const pa = peerAudiosRef.current.get(producerId);
      if (pa) {
        destroyAudioPipeline(pa);
        peerAudiosRef.current.delete(producerId);
      }
      fileOwnersRef.current.delete(producerId);
      store.getState().removePeer(producerId);
    },
    [store],
  );

  // --- SFU: set up transports and produce ---
  const setupSfuInner = useCallback(
    async (rtpCapabilities: Record<string, unknown>) => {
      // Re-acquires the mic if its track died (e.g. iOS killed it during the
      // outage that preceded a reconnect) — producing from a dead source
      // would silently send silence for the rest of the session. Null in a
      // mic-less session; the produce below still uses outDest's silent track.
      const localStream = await ensureLocalStream();
      if (localStream) connectMicToGraph(localStream);

      // Load device if needed
      let device = deviceRef.current;
      if (!device) {
        device = new Device();
        deviceRef.current = device;
      }
      if (!device.loaded) {
        await device.load({
          routerRtpCapabilities: rtpCapabilities as Parameters<
            typeof device.load
          >[0]["routerRtpCapabilities"],
        });
      }

      // Create send transport
      const sendRes = await emit<{ ok: boolean; params: Record<string, unknown> }>(
        "create-transport",
        { direction: "send" },
      );
      const sendTransport = device.createSendTransport({
        ...(sendRes.params as Parameters<typeof device.createSendTransport>[0]),
        iceServers: ICE_SERVERS,
      });

      sendTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
        try {
          await emit("connect-transport", { direction: "send", dtlsParameters });
          callback();
        } catch (e) {
          errback(e as Error);
        }
      });

      sendTransport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          // Forward the track's source ("voice" default, or "share" for a
          // stereo audio share) so the server tags/routes it correctly.
          const res = await emit<{ producerId: string }>("produce", {
            kind,
            rtpParameters,
            source: (appData as { source?: string })?.source,
          });
          callback({ id: res.producerId });
        } catch (e) {
          errback(e as Error);
        }
      });

      sendTransportRef.current = sendTransport;

      // Create recv transport
      const recvRes = await emit<{ ok: boolean; params: Record<string, unknown> }>(
        "create-transport",
        { direction: "recv" },
      );
      const recvTransport = device.createRecvTransport({
        ...(recvRes.params as Parameters<typeof device.createRecvTransport>[0]),
        iceServers: ICE_SERVERS,
      });

      recvTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
        try {
          await emit("connect-transport", { direction: "recv", dtlsParameters });
          callback();
        } catch (e) {
          errback(e as Error);
        }
      });

      recvTransportRef.current = recvTransport;

      // Produce the processed outgoing track (mic gain + limiter, + shared audio)
      const producer = await sendTransport.produce({
        track: ensureOutGraph().outDest.stream.getAudioTracks()[0],
        codecOptions: {
          opusStereo: false,
          opusDtx: false,
          opusFec: true,
          opusMaxPlaybackRate: 48000,
        },
        codec: device.recvRtpCapabilities.codecs?.find(
          (c) => c.mimeType.toLowerCase() === "audio/opus",
        ),
        // outDest is an app-owned, long-lived Web Audio track reused for the
        // whole session and across P2P↔SFU switches; mediasoup-client must NOT
        // stop it when this producer closes (default stopTracks:true would kill
        // it, so the next produce sends a dead track and no RTP flows).
        stopTracks: false,
      });
      producerRef.current = producer;

      // If we were already sharing audio (a mode switch into SFU, or a
      // reconnect mid-share), rebuild the separate stereo share producer too.
      if (store.getState().isSharingAudio) await produceShare();
      // Likewise rebuild the file producer if a local file stream is active.
      if (store.getState().fileStreamName) await produceFile();

      // Consume any producers announced while the transports were still being
      // built (their new-producer events arrived too early and were queued).
      while (pendingProducersRef.current.length > 0) {
        const pending = pendingProducersRef.current.shift()!;
        await consumeProducer(pending.peerId, pending.producerId, pending.source).catch((err) => {
          console.error("[sfu] queued consume failed:", err);
        });
      }
    },
    [
      emit,
      connectMicToGraph,
      ensureLocalStream,
      ensureOutGraph,
      produceShare,
      produceFile,
      consumeProducer,
      store,
    ],
  );

  // setupSfu never leaves a half-built SFU behind on failure — a live-but-
  // broken sendTransport would arm the switch-to-sfu idempotency guard and
  // block the next rebuild from ever running.
  const setupSfu = useCallback(
    async (rtpCapabilities: Record<string, unknown>) => {
      try {
        await setupSfuInner(rtpCapabilities);
      } catch (err) {
        teardownSfu();
        throw err;
      }
    },
    [setupSfuInner, teardownSfu],
  );

  // --- Main join ---
  const join = useCallback(
    async (
      roomName: string,
      displayName: string,
      opts?: { disableP2p?: boolean; isPublic?: boolean; noMic?: boolean },
    ) => {
      // Acquire stereo audio + build the outgoing graph BEFORE connecting so
      // it's ready the moment we (re)join. The mic, AudioContext and outgoing
      // track are reused for the whole session and survive reconnects, so a
      // network blip never re-prompts for the mic or rebuilds the send chain.
      //
      // A microphone must NEVER block joining: if the user opted out ("Join
      // without a microphone") we don't even prompt, and if acquisition fails
      // (no device, or permission denied) we fall back to the same mic-less
      // mode instead of throwing. Either way they can still listen and chat —
      // the outgoing track is outDest's, which is valid (silent) without a mic.
      let stream: MediaStream | null = null;
      if (!opts?.noMic) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: micConstraints(2, store.getState().micDeviceId),
          });
        } catch (err) {
          console.warn("[mic] no microphone — joining in listen/chat-only mode:", err);
        }
      }
      if (stream) {
        noMicRef.current = false;
        localStreamRef.current = stream;
        connectMicToGraph(stream);
        store.getState().setHasMic(true);
      } else {
        // Mic-less: build the (silent) outgoing graph so producing/adding the
        // outDest track still works, and reflect the state in the store (gates
        // the mute control + mic slider, shows a "text only" indicator).
        noMicRef.current = true;
        localStreamRef.current = null;
        ensureOutGraph();
        store.getState().setHasMic(false);
        store.getState().setMuted(true);
      }

      const socket = io({ transports: ["websocket"] });
      socketRef.current = socket;

      // Per-session, per-room token so a reconnect/refresh is recognized as an
      // already-admitted session (skips a public room's knock gate) and so an
      // approval can mark us admitted. Persisted in sessionStorage; falls back
      // to an in-memory value if storage is unavailable.
      let joinToken: string;
      try {
        const k = `sonicroom:joinToken:${roomName}`;
        joinToken = sessionStorage.getItem(k) ?? crypto.randomUUID();
        sessionStorage.setItem(k, joinToken);
      } catch {
        joinToken = crypto.randomUUID();
      }

      // (Re)join the room and (re)build all media from the server's response.
      // Runs on the initial join AND on every reconnect; it never registers
      // socket handlers (those are attached once, below, and persist across
      // reconnects).
      const joinAndSetup = async () => {
        type JoinResponse = {
          ok: boolean;
          // "pending" = held at the door of a public room (knock-to-join);
          // "joined" = admitted, full payload below is present.
          status?: "joined" | "pending";
          rtpCapabilities: Record<string, unknown>;
          peers: Array<{
            peerId: string;
            displayName: string;
            muted?: boolean;
            producers: Array<{ producerId: string; source: string }>;
          }>;
          mode: RoomMode;
          recording: { recordingId: string } | null;
          streaming?: boolean;
          voiceActive?: boolean;
          duckingEnabled?: boolean;
          // Whether this room is public (gates vote-to-kick) + current tallies.
          isPublic?: boolean;
          kickVotes?: Array<{ targetId: string; votes: number }>;
          messages: ChatMessage[];
        };
        const joinPayload = {
          roomName,
          displayName,
          disableP2p: opts?.disableP2p,
          // List this room in the lobby's public directory (sticky server-side).
          isPublic: opts?.isPublic,
          joinToken,
          // On a reconnect mid-share, re-pin SFU so the share rebuilds.
          sharing: store.getState().isSharingAudio,
          // Likewise re-pin SFU on a reconnect mid-file-stream.
          fileStreaming: store.getState().fileStreamName != null,
        };

        let joinRes = await emit<JoinResponse>("join", joinPayload);

        // Knock-to-join: the room is public + occupied, so we're held at the
        // door. Show the waiting screen and block until a participant decides —
        // approval lets us re-join (now token-admitted), denial/abort throws.
        if (joinRes.status === "pending") {
          store.getState().setAwaitingApproval(true);
          try {
            await new Promise<void>((resolve, reject) => {
              admissionRef.current = { resolve, reject };
            });
          } finally {
            admissionRef.current = null;
            store.getState().setAwaitingApproval(false);
          }
          joinRes = await emit<JoinResponse>("join", joinPayload);
        }

        store.getState().setRoom(roomName, displayName, socket.id!);
        store.getState().setMode(joinRes.mode);
        modeRef.current = joinRes.mode;

        // Seed the current duck state BEFORE consuming, so a music peer that's
        // being talked over starts ducked instead of blasting at full volume
        // until the next talk-start/stop transition. Likewise seed the room-wide
        // ducking toggle so effectiveGain is correct as producers are consumed.
        isVoiceActiveRef.current = !!joinRes.voiceActive;
        store.getState().setDuckingEnabled(joinRes.duckingEnabled ?? true);

        // Seed chat history (de-duped in the store, silent — no chime/announce).
        for (const m of joinRes.messages ?? []) store.getState().addMessage(m);

        // Sync recording state — it may have started/stopped while we were away.
        store
          .getState()
          .setRecording(
            !!joinRes.recording,
            joinRes.recording ? joinRes.recording.recordingId : null,
          );
        // Likewise the room-wide live-streaming state.
        store.getState().setStreaming(!!joinRes.streaming);
        // Whether this room is public — gates the vote-to-kick controls.
        store.getState().setRoomIsPublic(!!joinRes.isPublic);

        // Reconcile the peer list: drop anyone who left while we were
        // disconnected, add newcomers. addPeer resets per-peer state, so only
        // add peers we don't already track (keeps volume/mute across a rejoin).
        const present = new Set(joinRes.peers.map((p) => p.peerId));
        for (const id of [...store.getState().peers.keys()]) {
          if (!present.has(id)) store.getState().removePeer(id);
        }
        for (const peer of joinRes.peers) {
          if (!store.getState().peers.has(peer.peerId)) {
            store.getState().addPeer(peer.peerId, peer.displayName);
          }
          // Server truth for mute state — a late joiner (or a reconnect that
          // missed the peer-muted events) renders existing mutes correctly.
          store.getState().setPeerMuted(peer.peerId, !!peer.muted);
        }
        // Seed existing vote-to-kick tallies. Our own vote state always starts
        // clear on a (re)join — votes are keyed by socket id, which changes.
        for (const { targetId, votes } of joinRes.kickVotes ?? []) {
          store.getState().setPeerKickVote(targetId, votes, false);
        }

        // Producers queued before this ack (stale modeRef during a rejoin) are
        // all covered by the join snapshot below — draining them too would
        // consume them twice and double that peer's audio.
        pendingProducersRef.current = [];

        if (joinRes.mode === "p2p") {
          // P2P: we're the newcomer, so we offer to every existing peer (they
          // wait for the offer in the p2p-signal handler).
          for (const peer of joinRes.peers) {
            await createP2pConnection(peer.peerId, true);
          }
        } else {
          // SFU mode: set up transports, then consume existing producers.
          await setupSfu(joinRes.rtpCapabilities);
          for (const peer of joinRes.peers) {
            for (const prod of peer.producers) {
              await consumeProducer(peer.peerId, prod.producerId, prod.source);
            }
          }
        }

        // Mic-less session: we still produced/added outDest's silent track, so
        // present as muted — pause the (SFU) voice producer and tell the server,
        // which marks us muted and broadcasts peer-muted so everyone sees it.
        // Re-runs on every reconnect, keeping us muted after a rejoin.
        if (noMicRef.current) {
          store.getState().setMuted(true);
          if (modeRef.current === "sfu") producerRef.current?.pause();
          await emit("producer-pause", {}).catch(() => {});
        }
      };

      // socket.io fires "connect" on the first connection AND on every
      // reconnection — each reconnect gets a NEW socket id, so the server has
      // already dropped our old peer and we must rejoin from scratch. Without
      // this, a transient drop silently left us in a room the server no longer
      // knew about: the call appeared to "drop", and a forced-SFU room (e.g.
      // ?p2p=off) could fall back to P2P for the peers that stayed.
      let hasJoined = false;
      let resolveReady!: () => void;
      let rejectReady!: (err: unknown) => void;
      const ready = new Promise<void>((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
      });

      socket.on("connect", async () => {
        store.getState().setConnected(true);
        try {
          // Serialized with the mode-switch handlers so a rejoin never
          // interleaves with an in-flight P2P↔SFU transition.
          await runTransition(async () => {
            if (hasJoined) {
              console.log("[ws] reconnected — rejoining room");
              // The old transports / peer connections are dead; rebuild them.
              teardownP2p();
              teardownSfu();
            }
            await joinAndSetup();
          });
          if (!hasJoined) {
            hasJoined = true;
            resolveReady();
          }
        } catch (err) {
          if (hasJoined) console.error("[ws] rejoin failed:", err);
          else rejectReady(err);
        }
      });

      socket.on("disconnect", () => {
        store.getState().setConnected(false);
        // If we drop while still knocking, abort the blocked join so it doesn't
        // deadlock the transition chain (a reconnect re-knocks from scratch).
        admissionRef.current?.reject(new Error("disconnected"));
      });

      // --- Knock-to-join (public rooms) ---
      // Participant side: who is currently waiting at the door (drives the modal
      // + the looping knock cue). Requester side: our own knock was answered.
      socket.on("join-requests", ({ requests }: { requests: JoinRequest[] }) => {
        store.getState().setJoinRequests(requests ?? []);
      });
      socket.on("join-approved", () => {
        admissionRef.current?.resolve();
      });
      socket.on("join-denied", () => {
        admissionRef.current?.reject(new Error("join_denied"));
      });
      // Someone made the room public after we joined — reveal the vote-to-kick
      // controls (the room was private when we arrived).
      socket.on("room-public", () => {
        store.getState().setRoomIsPublic(true);
      });

      // --- Socket event handlers (attached once; persist across reconnects) ---
      socket.on(
        "peer-joined",
        ({ peerId, displayName: name }: { peerId: string; displayName: string }) => {
          store.getState().addPeer(peerId, name);
          store.getState().announce(announce_joined({ name }));
          const joinTs = Date.now();
          store.getState().addMessage({
            id: `sys-join-${peerId}-${joinTs}`,
            sender: name,
            text: "",
            ts: joinTs,
            kind: "join",
          });
          playCue(sharedAudioContext, "join");
          // In P2P mode, the new peer will send us an offer — we wait for it
        },
      );

      socket.on("peer-left", ({ peerId }: { peerId: string }) => {
        const name = store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
        const wasMusic = !!store.getState().peers.get(peerId)?.isMusic;
        // Clean up P2P connection if any
        const pc = p2pConnectionsRef.current.get(peerId);
        if (pc) {
          pc.close();
          p2pConnectionsRef.current.delete(peerId);
        }
        pendingCandidatesRef.current.delete(peerId);
        // Clean up audio
        const peerAudio = peerAudiosRef.current.get(peerId);
        if (peerAudio) {
          destroyAudioPipeline(peerAudio);
          peerAudiosRef.current.delete(peerId);
        }
        // Drop any share / file "music stream" tiles this peer owned (they may
        // have left mid-share/-stream, without a stop event first).
        for (const [producerId, owner] of shareOwnersRef.current) {
          if (owner === peerId) removeShareStream(producerId);
        }
        for (const [producerId, owner] of fileOwnersRef.current) {
          if (owner === peerId) removeFileStream(producerId);
        }
        store.getState().removePeer(peerId);
        if (wasMusic) {
          // A music caster (e.g. Ecobox) going away reads as the music
          // stopping, not as a participant leaving.
          store.getState().announceEvent(announce_music_stopped({ name }));
        } else {
          store.getState().announce(announce_left({ name }));
          const leaveTs = Date.now();
          store.getState().addMessage({
            id: `sys-leave-${peerId}-${leaveTs}`,
            sender: name,
            text: "",
            ts: leaveTs,
            kind: "leave",
          });
        }
        playCue(sharedAudioContext, "leave");
      });

      // --- Vote to kick (public rooms) ---
      // A vote was cast/withdrawn (or recounted after someone left). Update the
      // tally; reflect OUR own toggle in iVotedKick (so the button's aria-pressed
      // is right); announce OTHERS' votes (ours is conveyed by the button state).
      socket.on(
        "kick-vote",
        ({
          targetId,
          targetName,
          votes,
          voterId,
          voterName,
          action,
        }: {
          targetId: string;
          targetName: string;
          votes: number;
          voterId: string | null;
          voterName: string | null;
          action: "cast" | "withdraw" | "recount";
        }) => {
          const myId = store.getState().localPeerId;
          const mine = voterId != null && voterId === myId;
          store.getState().setPeerKickVote(targetId, votes, mine ? action === "cast" : undefined);
          if (action === "recount" || mine) return;
          const voter = voterName || announce_a_participant();
          const target =
            targetName ||
            store.getState().peers.get(targetId)?.displayName ||
            announce_a_participant();
          store
            .getState()
            .announce(
              action === "cast"
                ? announce_kick_vote({ voter, target })
                : announce_kick_vote_withdrawn({ voter, target }),
            );
        },
      );

      // Another peer was voted out: tear down their media (like a leave) and log
      // it to chat as an event (rule: room events go to chat via announceEvent).
      socket.on(
        "peer-kicked",
        ({ peerId, displayName }: { peerId: string; displayName: string }) => {
          const name = store.getState().peers.get(peerId)?.displayName ?? displayName;
          const pc = p2pConnectionsRef.current.get(peerId);
          if (pc) {
            pc.close();
            p2pConnectionsRef.current.delete(peerId);
          }
          pendingCandidatesRef.current.delete(peerId);
          const peerAudio = peerAudiosRef.current.get(peerId);
          if (peerAudio) {
            destroyAudioPipeline(peerAudio);
            peerAudiosRef.current.delete(peerId);
          }
          for (const [producerId, owner] of shareOwnersRef.current) {
            if (owner === peerId) removeShareStream(producerId);
          }
          for (const [producerId, owner] of fileOwnersRef.current) {
            if (owner === peerId) removeFileStream(producerId);
          }
          store.getState().removePeer(peerId);
          store.getState().announceEvent(announce_peer_kicked({ name }));
          playCue(sharedAudioContext, "leave");
        },
      );

      // WE were voted out. Show the dedicated "removed" screen (Room.tsx) and
      // stop the socket so it doesn't auto-reconnect into the now-banned room.
      socket.on("you-were-kicked", () => {
        store.getState().setKicked(true);
        store.getState().announceEvent(announce_you_were_kicked());
        playCue(sharedAudioContext, "leave");
        socket.disconnect();
      });

      // --- Recording (room-wide; the server forces SFU while recording) ---
      socket.on("recording-started", ({ recordingId, by }: { recordingId: string; by: string }) => {
        // Two near-simultaneous starts can broadcast this twice for the same
        // recording — announce it only once.
        const s = store.getState();
        if (s.isRecording && s.recordingId === recordingId) return;
        s.setRecording(true, recordingId);
        s.announceEvent(announce_recording_started({ name: by }));
      });

      socket.on("recording-stopped", () => {
        // Keep recordingId so the download link stays available after stopping.
        store.getState().setRecording(false);
        store.getState().announceEvent(announce_recording_stopped());
      });

      // The finished recording was cleaned up server-side (TTL) — drop the link.
      socket.on("recording-expired", () => {
        store.getState().setRecording(false, null);
        store.getState().announceEvent(announce_recording_unavailable());
      });

      // --- Live streaming (room-wide; the server forces SFU while streaming) ---
      socket.on("streaming-started", ({ by }: { by: string }) => {
        const s = store.getState();
        if (s.isStreaming) return; // de-dupe near-simultaneous starts
        s.setStreaming(true);
        s.announceEvent(announce_streaming_started({ name: by }));
      });

      socket.on("streaming-stopped", () => {
        if (!store.getState().isStreaming) return;
        store.getState().setStreaming(false);
        store.getState().announceEvent(announce_streaming_stopped());
      });

      // The server's mixer died on its own (bad Icecast target, unreachable, …).
      // `error` is the server's already-classified, human-readable reason — keep
      // it so the Streaming panel can show what to fix, and read it aloud.
      socket.on("streaming-failed", ({ error }: { error?: string } = {}) => {
        const s = store.getState();
        s.setStreaming(false);
        const reason = error?.trim() || "";
        s.setStreamError(reason || null);
        s.announceEvent(
          reason ? announce_streaming_failed_reason({ reason }) : announce_streaming_failed(),
        );
      });

      // P2P signaling relay
      socket.on(
        "p2p-signal",
        async ({
          fromPeerId,
          type,
          payload,
        }: {
          fromPeerId: string;
          type: "offer" | "answer" | "ice-candidate";
          payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
        }) => {
          if (type === "offer") {
            // Candidates already queued for this peer belong to a previous
            // session — a session's candidates always arrive after its offer —
            // so clear them NOW, at offer arrival; everything queued from this
            // point on belongs to the session this offer starts.
            pendingCandidatesRef.current.delete(fromPeerId);
            const seq = (offerSeqRef.current.get(fromPeerId) ?? 0) + 1;
            offerSeqRef.current.set(fromPeerId, seq);
            // Serialized behind any in-flight transition: answering immediately
            // could build a pipeline that a queued teardown then destroys.
            void runTransition(async () => {
              // Re-checked at run time — ignore offers from a stale P2P epoch
              // (relayed just before a switch-to-sfu), and offers superseded by
              // a newer one from the same peer while this waited in the chain.
              if (modeRef.current !== "p2p") return;
              if (offerSeqRef.current.get(fromPeerId) !== seq) return;
              // We received an offer — create connection as answerer
              const pc = await createP2pConnection(fromPeerId, false);
              if (!pc) return;
              await pc.setRemoteDescription(
                new RTCSessionDescription(payload as RTCSessionDescriptionInit),
              );
              await flushPendingCandidates(fromPeerId, pc);
              const answer = await pc.createAnswer();
              answer.sdp = forceOpusParams(answer.sdp!);
              await pc.setLocalDescription(answer);
              socket.emit("p2p-signal", {
                targetPeerId: fromPeerId,
                type: "answer",
                payload: answer,
              });
            }).catch((err) => console.error("[p2p] offer handling failed:", err));
          } else if (type === "answer") {
            const pc = p2pConnectionsRef.current.get(fromPeerId);
            if (pc) {
              await pc.setRemoteDescription(
                new RTCSessionDescription(payload as RTCSessionDescriptionInit),
              );
              await flushPendingCandidates(fromPeerId, pc);
            }
          } else if (type === "ice-candidate") {
            const pc = p2pConnectionsRef.current.get(fromPeerId);
            if (pc?.remoteDescription) {
              await pc.addIceCandidate(new RTCIceCandidate(payload as RTCIceCandidateInit));
            } else {
              // No remote description yet (its offer/answer is still being
              // processed) — addIceCandidate would throw and lose the
              // candidate. Queue it; flushed right after setRemoteDescription.
              const pending = pendingCandidatesRef.current.get(fromPeerId) ?? [];
              pending.push(payload as RTCIceCandidateInit);
              pendingCandidatesRef.current.set(fromPeerId, pending);
            }
          }
        },
      );

      // Switch to SFU (3+ peers)
      socket.on(
        "switch-to-sfu",
        ({ rtpCapabilities }: { rtpCapabilities: Record<string, unknown> }) => {
          console.log("[mode] switching to SFU");
          // Mode flips synchronously (event arrival order = server truth) so
          // other handlers route correctly even while the rebuild is queued.
          modeRef.current = "sfu";
          store.getState().setMode("sfu");
          void runTransition(async () => {
            // Already on a live SFU (e.g. our own join response said "sfu" and
            // this broadcast raced it) — rebuilding would duplicate transports
            // and producers, so peers would hear us twice.
            if (sendTransportRef.current && !sendTransportRef.current.closed) return;
            teardownP2p();
            await setupSfu(rtpCapabilities);
            // The server will send new-producer events for all existing producers after they also set up
          }).catch((err) => console.error("[mode] switch to SFU failed:", err));
        },
      );

      // Switch to P2P (back to 2 peers)
      socket.on("switch-to-p2p", ({ peerIds }: { peerIds: string[] }) => {
        console.log("[mode] switching to P2P");
        // Mode flips synchronously so an offer arriving right behind this
        // event isn't dropped by the p2p-signal handler's mode guard.
        modeRef.current = "p2p";
        store.getState().setMode("p2p");
        void runTransition(async () => {
          teardownSfu();

          // Re-establish the mesh. Only the lower-id peer initiates; the higher-id
          // peer waits for the offer and builds its side in the p2p-signal handler
          // (same convention as the initial join). Previously BOTH sides called
          // createP2pConnection here, which raced with the incoming offer also
          // creating one — the peer map could end up pointing at the orphaned PC,
          // so ICE candidates went to a dead connection and the call silently
          // dropped on every SFU→P2P switch (stopping a recording, or a caster
          // leaving).
          const myId = socket.id!;
          for (const peerId of peerIds) {
            if (peerId !== myId && myId < peerId) {
              await createP2pConnection(peerId, true);
            }
          }
        }).catch((err) => console.error("[mode] switch to P2P failed:", err));
      });

      // SFU: new producer available
      socket.on(
        "new-producer",
        async ({
          peerId,
          producerId,
          source,
        }: {
          peerId: string;
          producerId: string;
          source?: string;
        }) => {
          if (modeRef.current !== "sfu") return;
          try {
            await consumeProducer(peerId, producerId, source ?? "voice");
          } catch (err) {
            console.error("[sfu] consume failed:", err);
          }
        },
      );

      // Auto-ducking: server says whether anyone is talking right now.
      socket.on("duck", ({ active }: { active: boolean }) => {
        applyDuck(active);
      });

      // Room-wide ducking toggle changed (by anyone). Reflect it, re-ramp every
      // music stream to its new level (un-duck when turned off, re-duck when
      // turned back on if a voice is active), and log it. De-duped so an echo of
      // our own change — or one matching the value we already have — is a no-op.
      socket.on("ducking-changed", ({ enabled, by }: { enabled: boolean; by?: string }) => {
        if (store.getState().duckingEnabled === enabled) return;
        store.getState().setDuckingEnabled(enabled);
        rampMusicGains();
        const name = by ?? announce_a_participant();
        // Coalesced so mashing the ducking toggle doesn't spam the whole room's
        // chat log (the gain change above still applies on every flip).
        surfaceToggle("ducking", enabled, () => {
          store
            .getState()
            .announceEvent(
              enabled ? announce_ducking_enabled({ name }) : announce_ducking_disabled({ name }),
            );
        });
      });

      // A peer started sharing system/tab audio — announce it + play a cue.
      // Their stereo "share" stream arrives separately via new-producer.
      socket.on(
        "share-started",
        ({ displayName: name }: { peerId: string; displayName: string }) => {
          store.getState().announceEvent(announce_share_started({ name }));
          playCue(sharedAudioContext, "share-start");
        },
      );

      // A peer stopped sharing — tear down their share "music stream" tile(s),
      // announce it, and play a cue.
      socket.on(
        "share-stopped",
        ({ peerId, displayName: name }: { peerId: string; displayName: string }) => {
          for (const [producerId, owner] of shareOwnersRef.current) {
            if (owner === peerId) removeShareStream(producerId);
          }
          store.getState().announceEvent(announce_share_stopped({ name }));
          playCue(sharedAudioContext, "share-stop");
        },
      );

      // A peer started streaming a local file — announce it + play a cue. Their
      // stereo "file" stream arrives separately via new-producer.
      socket.on("file-stream-started", ({ displayName: name }: { displayName: string }) => {
        store.getState().announceEvent(announce_file_stream_started({ name }));
        playCue(sharedAudioContext, "share-start");
      });

      // A peer stopped their file stream — tear down their file "music stream"
      // tile(s), announce it, and play a cue.
      socket.on(
        "file-stream-stopped",
        ({ peerId, displayName: name }: { peerId: string; displayName: string }) => {
          for (const [producerId, owner] of fileOwnersRef.current) {
            if (owner === peerId) removeFileStream(producerId);
          }
          store.getState().announceEvent(announce_file_stream_stopped({ name }));
          playCue(sharedAudioContext, "share-stop");
        },
      );

      // A remote peer toggled their mic: reflect it, play a soft cue, and speak
      // it on the polite ARIA region. Unlike other room events this is NOT
      // logged to chat (announce, not announceEvent) — it'd be too noisy.
      socket.on("peer-muted", ({ peerId }: { peerId: string }) => {
        store.getState().setPeerMuted(peerId, true);
        // Coalesced per peer so a peer mashing their mic only blips us once or
        // twice, not on every flip (see surfaceToggle).
        surfaceToggle(`peer:${peerId}`, true, () => {
          const name = store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
          store.getState().announce(announce_peer_muted({ name }));
          playCue(sharedAudioContext, "peer-mute");
        });
      });

      socket.on("peer-unmuted", ({ peerId }: { peerId: string }) => {
        store.getState().setPeerMuted(peerId, false);
        surfaceToggle(`peer:${peerId}`, false, () => {
          const name = store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
          store.getState().announce(announce_peer_unmuted({ name }));
          playCue(sharedAudioContext, "peer-unmute");
        });
      });

      // Incoming chat (including the echo of our own messages): render it, chime
      // a distinct cue, and announce it via the user's chosen channel — a polite
      // or assertive ARIA live region, or the browser's spoken TTS (announceChat
      // reads chatAnnounceMode). Both sent and received messages flow through
      // here (own messages come back as an echo), so both get announced.
      socket.on("chat-message", (msg: ChatMessage) => {
        store.getState().addMessage(msg);
        let announcement = formatMessage(msg, Date.now());
        // First message of the session: tell SR users once that Alt+1..0 reads
        // the recent messages aloud even while the chat panel is closed.
        if (!chatHintGivenRef.current) {
          chatHintGivenRef.current = true;
          announcement += `${META_SEP}${announce_chat_hint()}`;
        }
        store.getState().announceChat(announcement);
        playCue(sharedAudioContext, "message");
      });

      // Resolve once the first connect → join → media setup has completed (or
      // reject if that initial join fails), so callers can flip to "joined".
      await ready;

      // Once joined, let the user know (and log to chat) that they're in
      // listen/chat-only mode, so it's not a silent surprise that they can't
      // talk. Runs once — `ready` resolves only on the first successful join.
      if (noMicRef.current) store.getState().announceEvent(announce_no_mic());
    },
    [
      emit,
      consumeProducer,
      setupSfu,
      createP2pConnection,
      connectMicToGraph,
      ensureOutGraph,
      teardownP2p,
      teardownSfu,
      applyDuck,
      rampMusicGains,
      surfaceToggle,
      removeShareStream,
      removeFileStream,
      runTransition,
      flushPendingCandidates,
      store,
    ],
  );

  const mute = useCallback(async () => {
    // Silence the mic track (feeds the voice graph only); any shared system
    // audio is a separate track/producer, so it keeps flowing. The server
    // pauses just the VOICE producer, so muting never cuts the music.
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = false;

    if (modeRef.current === "sfu" && producerRef.current) {
      producerRef.current.pause();
    }
    await emit("producer-pause", {}).catch(() => {});
    store.getState().setMuted(true);
    // Coalesced so mashing mute doesn't spam the chat log + cue (see surfaceToggle).
    surfaceToggle("mic", true, () => {
      store.getState().announceEvent(announce_mic_muted());
      playCue(sharedAudioContext, "mute");
    });
  }, [emit, store, surfaceToggle]);

  const unmute = useCallback(async () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = true;

    if (modeRef.current === "sfu" && producerRef.current) {
      producerRef.current.resume();
    }
    await emit("producer-resume", {}).catch(() => {});
    store.getState().setMuted(false);
    surfaceToggle("mic", false, () => {
      store.getState().announceEvent(announce_mic_unmuted());
      playCue(sharedAudioContext, "unmute");
    });
  }, [emit, store, surfaceToggle]);

  const toggleMute = useCallback(async () => {
    if (store.getState().isMuted) await unmute();
    else await mute();
  }, [mute, unmute, store]);

  const toggleDeafen = useCallback(() => {
    store.getState().setDeafened(!store.getState().isDeafened);
    // Recompute every peer's gain so un-deafen restores per-peer volume (and
    // any active music duck) instead of resetting everyone to 1.
    const now = sharedAudioContext.currentTime;
    for (const [peerId, peerAudio] of peerAudiosRef.current) {
      peerAudio.gainNode.gain.setTargetAtTime(effectiveGain(peerId), now, GAIN_RAMP);
    }
  }, [store, effectiveGain]);

  // Flip the room-wide auto-ducking toggle. Fire-and-forget: the server echoes
  // `ducking-changed` to everyone (us included), which is what applies it.
  const toggleDucking = useCallback(async () => {
    await emit("set-ducking", { enabled: !store.getState().duckingEnabled }).catch(() => {});
  }, [emit, store]);

  const setPeerVolume = useCallback(
    (peerId: string, volume: number) => {
      store.getState().setPeerVolume(peerId, volume);
      const peerAudio = peerAudiosRef.current.get(peerId);
      if (peerAudio) {
        peerAudio.gainNode.gain.setTargetAtTime(
          effectiveGain(peerId),
          sharedAudioContext.currentTime,
          GAIN_RAMP,
        );
      }
    },
    [store, effectiveGain],
  );

  // --- Audio share: cast system/tab audio as a SEPARATE stereo producer ---
  // The shared audio gets its own destination (shareDest) and its own stereo
  // "share" producer, so the voice track stays mono/64k and is never touched.
  const detachSharedAudio = useCallback(() => {
    const g = outGraphRef.current;
    g?.displaySource?.disconnect();
    g?.shareDest?.disconnect();
    if (g) {
      g.displaySource = null;
      g.shareDest = null;
    }
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
  }, []);

  const stopAudioShare = useCallback(async () => {
    if (!store.getState().isSharingAudio) return;
    // Close our stereo share producer, then detach the shared-audio nodes.
    if (musicProducerRef.current) {
      if (!musicProducerRef.current.closed) musicProducerRef.current.close();
      musicProducerRef.current = null;
    }
    detachSharedAudio();
    store.getState().setSharingAudio(false);
    // Tell the server: drop us from the sharer set (may release the SFU pin)
    // and close the server-side producer so peers' tiles disappear.
    await emit("stop-share").catch(() => {});
    // Local feedback; peers get theirs via the share-stopped broadcast.
    store.getState().announceEvent(announce_share_stopped_you());
    playCue(sharedAudioContext, "share-stop");
  }, [store, detachSharedAudio, emit]);

  const startAudioShare = useCallback(async () => {
    if (store.getState().isSharingAudio) return;
    if (!localStreamRef.current) return;

    // Chrome requires `video: true` to expose system/tab audio. We discard
    // the video track immediately — we only want the audio.
    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Exclude this page's own playback (the other participants) from
          // system-audio capture, so they don't get looped back and doubled.
          // Chrome 140+ on Windows/macOS; ignored elsewhere.
          restrictOwnAudio: true,
        } as MediaTrackConstraints,
      });
    } catch {
      // User cancelled the picker, or the browser refused
      return;
    }

    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((t) => t.stop());
      alert(
        'No audio was shared. When choosing what to share, tick "Share system audio" (entire screen) or "Share tab audio" (Chrome tab). On Firefox/Safari this is not supported.',
      );
      return;
    }

    // Discard the video track — we don't need to send any video
    displayStream.getVideoTracks().forEach((t) => t.stop());

    // Route the shared audio into its OWN destination (not the voice graph), so
    // it becomes a separate stereo producer and the voice track stays mono.
    const g = ensureOutGraph();
    const shareDest = sharedAudioContext.createMediaStreamDestination();
    const displaySource = sharedAudioContext.createMediaStreamSource(new MediaStream(audioTracks));
    displaySource.connect(shareDest);
    g.displaySource = displaySource;
    g.shareDest = shareDest;
    displayStreamRef.current = displayStream;

    // Fire when the user hits the browser's "Stop sharing" UI
    audioTracks[0].addEventListener("ended", () => {
      stopAudioShare();
    });

    store.getState().setSharingAudio(true);

    // A stereo producer must be routed by the server, so pin the room to SFU.
    // If we're already on the SFU, produce now; otherwise the resulting
    // switch-to-sfu rebuilds the SFU and setupSfu produces the share (it sees
    // isSharingAudio). Either way produceShare is idempotent.
    const wasSfu = modeRef.current === "sfu";
    await emit("start-share").catch(() => {});
    if (wasSfu) await produceShare();

    // Local feedback; peers get theirs via the share-started broadcast.
    store.getState().announceEvent(announce_share_started_you());
    playCue(sharedAudioContext, "share-start");
  }, [store, ensureOutGraph, stopAudioShare, produceShare, emit]);

  const toggleAudioShare = useCallback(async () => {
    if (store.getState().isSharingAudio) await stopAudioShare();
    else await startAudioShare();
  }, [store, startAudioShare, stopAudioShare]);

  // --- File streaming: stream a local audio file into the call as a SEPARATE
  // stereo "file" producer. Independent of the audio share; the file is decoded
  // by an <audio> element whose Web Audio source feeds its own destination
  // (produced) and the local speakers (monitored). Like a share it forces SFU
  // and is auto-tapped by recording/streaming server-side. ---
  const stopFileStream = useCallback(
    async (announcement?: string) => {
      if (store.getState().fileStreamName == null) return;
      // Drop the element's ended/error listeners first so teardown can't fire them.
      fileAbortRef.current?.abort();
      fileAbortRef.current = null;
      if (fileProducerRef.current) {
        if (!fileProducerRef.current.closed) fileProducerRef.current.close();
        fileProducerRef.current = null;
      }
      const g = outGraphRef.current;
      g?.fileSource?.disconnect();
      g?.fileDest?.disconnect();
      if (g) {
        g.fileSource = null;
        g.fileDest = null;
      }
      if (fileAudioRef.current) {
        fileAudioRef.current.pause();
        fileAudioRef.current.src = "";
        fileAudioRef.current = null;
      }
      if (fileUrlRef.current) {
        URL.revokeObjectURL(fileUrlRef.current);
        fileUrlRef.current = null;
      }
      store.getState().setFileStream(null);
      store.getState().setFileStreamPlaying(false);
      // Tell the server: drop us from the file-streamer set (may release the SFU
      // pin) and close the server-side producer so peers' tiles disappear.
      await emit("stop-file-stream").catch(() => {});
      store.getState().announceEvent(announcement ?? announce_file_stream_stopped_you());
      playCue(sharedAudioContext, "share-stop");
    },
    [store, emit],
  );

  const startFileStream = useCallback(
    async (file: File) => {
      const g = ensureOutGraph();
      resumeSharedContext();

      const firstStart = store.getState().fileStreamName == null;

      // Replace path: tear down the previous element/source but KEEP fileDest and
      // its producer, so swapping the file causes no mode flap or peer tile churn
      // (the produced track is fileDest's, which never changes — only its input).
      fileAbortRef.current?.abort();
      fileAbortRef.current = null;
      g.fileSource?.disconnect();
      g.fileSource = null;
      if (fileAudioRef.current) {
        fileAudioRef.current.pause();
        fileAudioRef.current.src = "";
        fileAudioRef.current = null;
      }
      if (fileUrlRef.current) {
        URL.revokeObjectURL(fileUrlRef.current);
        fileUrlRef.current = null;
      }

      // New <audio> element decoding the chosen file.
      const url = URL.createObjectURL(file);
      fileUrlRef.current = url;
      const audioEl = new Audio();
      audioEl.src = url;
      (audioEl as unknown as Record<string, boolean>).playsInline = true;
      fileAudioRef.current = audioEl;

      const source = sharedAudioContext.createMediaElementSource(audioEl);
      g.fileSource = source;
      // Its OWN destination → produced as a separate stereo "file" track.
      if (!g.fileDest) g.fileDest = sharedAudioContext.createMediaStreamDestination();
      source.connect(g.fileDest);
      // Also monitor it locally, so the streamer hears what they're playing.
      source.connect(sharedAudioContext.destination);

      // Stop the whole stream when the file ends or fails to decode.
      const ac = new AbortController();
      fileAbortRef.current = ac;
      audioEl.addEventListener("ended", () => void stopFileStream(announce_file_stream_ended()), {
        signal: ac.signal,
      });
      audioEl.addEventListener("error", () => void stopFileStream(announce_file_stream_error()), {
        signal: ac.signal,
      });

      store.getState().setFileStream(file.name);
      try {
        await audioEl.play();
        store.getState().setFileStreamPlaying(true);
      } catch {
        // Autoplay refused (rare — we're in a user gesture); land paused so the
        // window's play button can start it.
        store.getState().setFileStreamPlaying(false);
      }

      if (firstStart) {
        // A stereo producer must be routed by the server, so pin the room to SFU.
        // If already on the SFU, produce now; otherwise the switch-to-sfu rebuilds
        // the SFU and setupSfu produces the file (it sees fileStreamName).
        const wasSfu = modeRef.current === "sfu";
        await emit("start-file-stream").catch(() => {});
        if (wasSfu) await produceFile();
        store.getState().announceEvent(announce_file_stream_started_you());
        playCue(sharedAudioContext, "share-start");
      } else {
        // Replacing the file mid-stream — producer/SFU pin are unchanged.
        store.getState().announce(file_player_streaming({ name: file.name }));
      }
    },
    [store, ensureOutGraph, emit, produceFile, stopFileStream],
  );

  const toggleFilePlayback = useCallback(() => {
    const el = fileAudioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => {});
      store.getState().setFileStreamPlaying(true);
      store.getState().announce(announce_file_stream_resumed());
    } else {
      el.pause();
      store.getState().setFileStreamPlaying(false);
      store.getState().announce(announce_file_stream_paused());
    }
  }, [store]);

  // --- Recording ---
  // Recording is server-side: the server taps every participant's stream off
  // the SFU. Starting it forces the room out of P2P (the server can't see P2P
  // media). Download happens via /api/recordings/:id/download at any time.
  const startRecording = useCallback(async () => {
    if (store.getState().isRecording) return;
    try {
      const res = await emit<{ recordingId: string }>("start-recording");
      store.getState().setRecording(true, res.recordingId);
    } catch (err) {
      console.error("[recording] failed to start:", err);
      store.getState().announceEvent(announce_recording_failed());
    }
  }, [emit, store]);

  const stopRecording = useCallback(async () => {
    if (!store.getState().isRecording) return;
    try {
      await emit("stop-recording");
    } catch (err) {
      console.error("[recording] failed to stop:", err);
    }
    // The server also broadcasts recording-stopped; mark stopped locally but
    // keep recordingId so the download link remains until the file expires.
    store.getState().setRecording(false);
  }, [emit, store]);

  const toggleRecording = useCallback(async () => {
    if (store.getState().isRecording) await stopRecording();
    else await startRecording();
  }, [startRecording, stopRecording, store]);

  // --- Live streaming to Icecast ---
  // Like recording, this is server-side and room-wide: the server taps every
  // participant's stream off the SFU, mixes it, and pushes it to the Icecast
  // target supplied here. Starting it forces the room out of P2P. Throws (with
  // the server's reason) so the settings UI can surface a bad target.
  const startStreaming = useCallback(async () => {
    if (store.getState().isStreaming) return;
    store.getState().setStreamError(null); // drop any stale failure before retrying
    const { host, port, mount, username, password, format, bitrateKbps } =
      store.getState().streamConfig;
    await emit("start-streaming", {
      host: host.trim(),
      port,
      mount: mount.trim(),
      username: username.trim() || "source",
      password,
      format,
      bitrateKbps,
    });
    // The server also broadcasts streaming-started; reflect it immediately so
    // the button flips without waiting for the echo.
    store.getState().setStreaming(true);
  }, [emit, store]);

  const stopStreaming = useCallback(async () => {
    if (!store.getState().isStreaming) return;
    try {
      await emit("stop-streaming");
    } catch (err) {
      console.error("[streaming] failed to stop:", err);
    }
    store.getState().setStreaming(false);
  }, [emit, store]);

  const toggleStreaming = useCallback(async () => {
    if (store.getState().isStreaming) await stopStreaming();
    else await startStreaming();
  }, [startStreaming, stopStreaming, store]);

  // Live mic-gain control: persists the value and ramps the outgoing gain node.
  const setMicGain = useCallback(
    (gain: number) => {
      store.getState().setMicGain(gain);
      const g = outGraphRef.current;
      if (g) g.micGain.gain.setTargetAtTime(gain, sharedAudioContext.currentTime, GAIN_RAMP);
    },
    [store],
  );

  // Send a chat message. Returns why it didn't go out so the caller can keep
  // the text in the box ("empty"/"rate_limited" — never cleared on failure).
  // A blocked send plays the "thunk" cue; the delivered message comes back via
  // the `chat-message` echo, which is what renders/announces/chimes it.
  const sendChatMessage = useCallback(
    async (text: string): Promise<{ ok: boolean; reason?: "empty" | "rate_limited" }> => {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, reason: "empty" };
      if (!chatLimiterRef.current.tryConsume()) {
        playCue(sharedAudioContext, "thunk");
        return { ok: false, reason: "rate_limited" };
      }
      try {
        await emit("chat-message", { text: trimmed });
        return { ok: true };
      } catch {
        // Server rejected (its budget was also spent via the API, or transient).
        playCue(sharedAudioContext, "thunk");
        return { ok: false, reason: "rate_limited" };
      }
    },
    [emit],
  );

  const leave = useCallback(() => {
    detachSharedAudio();
    // Tear down any active file stream (stops the <audio>, revokes its URL).
    fileAbortRef.current?.abort();
    fileAbortRef.current = null;
    if (fileAudioRef.current) {
      fileAudioRef.current.pause();
      fileAudioRef.current.src = "";
      fileAudioRef.current = null;
    }
    if (fileUrlRef.current) {
      URL.revokeObjectURL(fileUrlRef.current);
      fileUrlRef.current = null;
    }
    teardownP2p();
    teardownSfu();
    // Tear down the outgoing graph (nodes live in the shared context, so just
    // disconnect them — the context itself is reused for the next room).
    const g = outGraphRef.current;
    if (g) {
      g.micSource?.disconnect();
      g.micGain.disconnect();
      g.limiter.disconnect();
      g.displaySource?.disconnect();
      g.shareDest?.disconnect();
      g.fileSource?.disconnect();
      g.fileDest?.disconnect();
      outGraphRef.current = null;
    }
    musicProducerRef.current = null;
    fileProducerRef.current = null;
    shareOwnersRef.current.clear();
    fileOwnersRef.current.clear();
    // Cancel any pending coalesced mute/duck announcements.
    for (const s of surfaceRef.current.values()) {
      if (s.timer !== null) clearTimeout(s.timer);
    }
    surfaceRef.current.clear();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    deviceRef.current = null;
    store.getState().reset();
  }, [teardownP2p, teardownSfu, detachSharedAudio, store]);

  // Allow/deny a pending join request (participant side). Optimistically drop it
  // from our local list so the button doesn't linger; the server also broadcasts
  // the updated list to everyone in the room.
  const decideJoinRequest = useCallback(
    (requestId: string, allow: boolean) => {
      socketRef.current?.emit("join-decision", { requestId, allow });
      store
        .getState()
        .setJoinRequests(store.getState().joinRequests.filter((r) => r.id !== requestId));
    },
    [store],
  );

  // Vote to remove a peer (public rooms only), or withdraw that vote. We don't
  // update local state optimistically — the server echoes an authoritative
  // `kick-vote` to the whole room (including us), keeping every client's tally
  // and our own iVotedKick in sync. A rejection (rate-limited, etc.) thunks.
  const voteKick = useCallback(
    (targetId: string, vote: boolean) => {
      emit("vote-kick", { targetId, vote }).catch(() => {
        playCue(sharedAudioContext, "thunk");
      });
    },
    [emit],
  );

  // While anyone is waiting at the door, loop the knock cue so participants
  // notice. Driven on the audio thread (not a setInterval, which browsers
  // throttle/suspend for background tabs — that made it knock once and stop when
  // unfocused). Plays through the shared context regardless of deafen, never
  // routed to peers.
  const someoneKnocking = useRoomStore((s) => s.joinRequests.length > 0);
  useEffect(() => {
    if (!someoneKnocking) return;
    return startKnockLoop(sharedAudioContext);
  }, [someoneKnocking]);

  useEffect(() => {
    return () => {
      leave();
    };
  }, [leave]);

  return {
    join,
    leave,
    decideJoinRequest,
    voteKick,
    mute,
    unmute,
    toggleMute,
    toggleDeafen,
    toggleDucking,
    toggleAudioShare,
    startFileStream,
    stopFileStream,
    toggleFilePlayback,
    toggleRecording,
    startRecording,
    stopRecording,
    startStreaming,
    stopStreaming,
    toggleStreaming,
    setPeerVolume,
    setMicGain,
    sendChatMessage,
    peerAudiosRef,
  };
}
