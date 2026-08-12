import { useRef, useCallback, useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import type { Transport, Producer } from "mediasoup-client/types";
import { forceOpusParams } from "../lib/sdp-munger";
import { applySpeakerToContext } from "../lib/audio-devices";
import { microphoneConstraints } from "../lib/microphone";
import { playCue, startKnockLoop } from "../lib/sounds";
import { RateLimiter, type ChatMessage } from "../lib/chat";
import {
  announce_joined,
  announce_left,
  announce_music_stopped,
  announce_a_participant,
  announce_recording_failed,
  announce_mic_muted,
  announce_mic_unmuted,
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
  announce_extra_mic_started,
  announce_extra_mic_stopped,
  announce_ducking_enabled,
  announce_ducking_disabled,
  announce_kick_vote,
  announce_kick_vote_withdrawn,
  announce_peer_kicked,
  announce_caster_removed,
  announce_peer_stream_stopped,
  announce_your_stream_stopped,
  announce_you_were_kicked,
  announce_no_mic,
  file_stream_name,
  file_stream_name_titled,
  file_player_streaming,
  share_stream_name,
  share_stream_name_titled,
  mic_stream_name,
  mic_stream_name_titled,
} from "../paraglide/messages.js";
import { useRoomStore, type RoomMode, type JoinRequest } from "../stores/room";
import { apiUrl, iceServers, socketTarget } from "../lib/runtime-config";
import { PeerAudioRegistry } from "../lib/audio/peer-audio-registry";
import { OutgoingAudioGraph } from "../lib/audio/outgoing-graph";
import { SpeakingDetector } from "../lib/audio/speaking-detector";
import { ExtraMicController } from "../lib/media/extra-mic-controller";
import { teardownPeerMedia } from "../lib/socket/peer-teardown";
import {
  registerRecordingHandlers,
  registerStreamingHandlers,
  registerMuteHandlers,
  registerChatHandlers,
} from "../lib/socket/room-event-handlers";
import { sharedAudioContext, resumeContext } from "../lib/audio/shared-context";

// ICE servers (with optional per-instance overrides) live in runtime-config.ts —
// `iceServers()` returns the default coturn list on the web and whatever the
// Electron client injects when pointed at another instance.

// The shared AudioContext + its keep-alive + the gain-ramp time-constant live in
// lib/audio/shared-context.ts (imported above); the per-peer gain math + ducking
// constants live in lib/audio/peer-audio-registry.ts.

// "Who's talking" detection (poll loop + recent-talkers ring + announceSpeakers)
// lives in lib/audio/speaking-detector.ts.

// Rapid mute/duck toggling would otherwise announce + chime on every single
// flip — mute 10× and everyone hears/reads it 10×. Coalesce a burst: surface the
// FIRST change immediately (leading edge, so a deliberate single toggle still
// gives instant feedback), suppress the middle, then surface the final settled
// state once more after TOGGLE_DEDUP_MS of quiet — and only if it actually
// differs from what was last surfaced. So a mash shows at most the first + last.
const TOGGLE_DEDUP_MS = 1000;

// resumeContext (the keep-alive) lives in lib/audio/shared-context.ts and is
// already wired to the document gestures / statechange / visibility there.
// The per-peer pipeline build/destroy live in PeerAudioRegistry.

// Apply the LOCAL user's hi-fi / low-latency Opus prefs to a REMOTE P2P
// description before setRemoteDescription. Crucial RFC 7587 subtlety: the
// `stereo` / `maxaveragebitrate` fmtp params describe the RECEIVE capability of
// whoever SENT that SDP, so the description we apply as *remote* is what gates
// OUR OWN encoder. Munging it by our local hi-fi flag is therefore what actually
// makes our mic SEND stereo 128k — independent of the remote peer's setting,
// exactly like the speaker-controlled SFU `opusStereo` produce flag.
//
// forceOpusParams on the LOCAL description (in createOffer/createAnswer) only
// sets *our* receive prefs, which gate the OTHER peer's encoder — so on its own
// it made hi-fi voice silently RECEIVER-gated in P2P (you sent stereo only if
// your listener had also enabled hi-fi). That's why a hi-fi speaker stayed mono
// until something (an extra mic, a share, recording…) forced the room onto the
// SFU, where the produce flag is speaker-controlled. Munging the remote desc too
// makes P2P match: hi-fi is the SPEAKER's choice in both transports.
function withHifiOpus(desc: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  if (!desc.sdp) return desc;
  return { ...desc, sdp: forceOpusParams(desc.sdp, useRoomStore.getState().hifiVoiceEnabled) };
}

export function useMediasoup() {
  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const producerRef = useRef<Producer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // True when we joined WITHOUT a microphone (opted out, or none available /
  // permission denied) — we listen and use text chat only. The outgoing track is
  // always outDest's (silent with no mic connected), so producing/adding it
  // still works; we just never acquire a mic and stay muted. Persists across
  // reconnects so a rejoin doesn't re-prompt.
  const noMicRef = useRef(false);
  // Client-side per-peer speaking detection lives in SpeakingDetector (below).
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
  // P2P↔SFU transitions (and reconnect rebuilds) are serialized through this
  // promise chain so an in-flight transition always finishes tearing down /
  // building up before the next starts — overlapping async handlers could
  // otherwise re-add stale connections after a newer teardown already ran.
  const transitionChainRef = useRef<Promise<void>>(Promise.resolve());
  // The outgoing audio graph + the share/file producers live in OutgoingAudioGraph
  // (constructed below). The hook keeps only the <audio> element streaming a local
  // file: the element decoding it, its object URL, and an AbortController for the
  // element's ended/error listeners (so swapping the file never fires a stale one).
  const fileAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileObjectUrlRef = useRef<string | null>(null);
  const fileAbortRef = useRef<AbortController | null>(null);
  // Owner-side "someone stopped my stream" cleanup, bridged through a ref: the
  // join callback registers the peer-stream-stopped handler but is defined before
  // the share/file teardown helpers, so it calls through this (kept current by an
  // effect right after those helpers).
  const stopOwnStreamLocalRef = useRef<(source: "share" | "file") => void>(() => {});
  // Our OUTGOING extra microphones, keyed by deviceId. Each entry owns a live
  // getUserMedia capture and routes it through Web Audio (source → dest) exactly
  // like share/file and the primary voice mic — we produce the DESTINATION's track,
  // not the raw capture track. An earlier variant produced the raw capture track
  // directly and a stereo extra mic could drift its two channels apart over time
  // (image slides right + a periodic "boop"); routing through a dest — which every
  // other stereo producer here already does — was stable in testing. We never
  // pinned down the exact mechanism (it looked browser-specific), so treat the
  // dest route as the empirically-stable path, not a proven fix for a known cause.
  // The entry also holds the producer (null until the SFU is up) and the stereo
  // choice it was produced with (so a mono↔stereo flip re-acquires + re-produces
  // just it). App-owned: kept across reconnects so produceAllExtraMics can
  // re-produce; torn down only on uncheck or leave.
  // Our outgoing extra microphones live in ExtraMicController (constructed below).
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

  // Incoming peer audio: the per-peer pipelines, owner maps, gain math, ducking,
  // and SFU consume all live in PeerAudioRegistry. Constructed once (its methods
  // are stable, so the delegators below carry empty dep arrays). It reads the live
  // SFU device/recvTransport through getters, and the per-render socket through
  // the stable `emit` (which late-binds socketRef at call time).
  const registryRef = useRef(
    new PeerAudioRegistry(sharedAudioContext, store, emit, {
      getDevice: () => deviceRef.current,
      getRecvTransport: () => recvTransportRef.current,
    }),
  );
  const registry = registryRef.current;

  // Outgoing audio: the mic → micGain → limiter → outDest graph plus the separate
  // stereo "share" and "file" producers. Constructed once; reads the live SFU
  // send transport / device through getters. The hook keeps the DOM/socket
  // orchestration (getDisplayMedia, the <audio> element, emits, cues).
  const graphRef = useRef(
    new OutgoingAudioGraph(sharedAudioContext, store, {
      getSendTransport: () => sendTransportRef.current,
      getDevice: () => deviceRef.current,
    }),
  );
  const graph = graphRef.current;

  // Client-side "who's talking" detection: polls the registry's per-peer analysers.
  const detectorRef = useRef(new SpeakingDetector(store, registry));
  const detector = detectorRef.current;

  // Our outgoing extra microphones (each a separate "mic" producer). Owns the
  // captures + the start/stop/restart serialization; reconciled by the effect below.
  const extraMicsRef = useRef(
    new ExtraMicController(sharedAudioContext, store, emit, {
      getSendTransport: () => sendTransportRef.current,
      getDevice: () => deviceRef.current,
      getMode: () => modeRef.current,
    }),
  );
  const extraMics = extraMicsRef.current;
  // The registry owns the live map; expose it by stable reference (never reassigned)
  // so the returned ref and the speaking detector read the same Map it mutates.
  const peerAudiosRef = useRef(registry.peerAudios);

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

  // Run the speaking-detection poll loop for the hook's lifetime (cleanup stops it
  // + clears the badge timer). The detector reads the registry's analysers directly.
  useEffect(() => detector.start(), [detector]);

  // Announce + briefly number the most recent talkers (W shortcut / toolbar button).
  const announceSpeakers = useCallback(() => detector.announceSpeakers(), [detector]);

  // The outgoing audio graph (mic gain + soft limiter + the share/file producers)
  // lives in OutgoingAudioGraph. `connectMicToGraph` is a thin stable delegator so
  // the effects that depend on it keep a stable identity.
  const connectMicToGraph = useCallback((stream: MediaStream) => graph.connectMic(stream), [graph]);

  // --- Device selection (set in the lobby or via the in-call settings) ---
  const micDeviceId = useRoomStore((s) => s.micDeviceId);
  const speakerDeviceId = useRoomStore((s) => s.speakerDeviceId);
  const voiceProcessingEnabled = useRoomStore((s) => s.voiceProcessingEnabled);
  // Extra mics to stream (separate "mic" producers) + per-device mono/stereo. The
  // reconcile effect below diffs these against the live producers.
  const streamedMicDeviceIds = useRoomStore((s) => s.streamedMicDeviceIds);
  const micStereoByDevice = useRoomStore((s) => s.micStereoByDevice);
  // Gate the reconcile effect: while disconnected (lobby) we only track the
  // selection as a baseline; the persisted selection is applied at join via the
  // join payload + produceAllExtraMics, not by acquiring devices in the lobby.
  const connected = useRoomStore((s) => s.connected);

  // All incoming audio plays through the shared context, so the speaker pick
  // is one setSinkId there — it covers every peer, current and future.
  useEffect(() => {
    applySpeakerToContext(sharedAudioContext, speakerDeviceId);
  }, [speakerDeviceId]);

  // Mid-call mic setting change: re-acquire the mic with the selected device
  // and voice-processing preference, then reroute it into the outgoing graph.
  // Senders/producers never see the swap because they always carry outDest's
  // track. Before a call (no local stream), join() picks the settings up.
  const prevMicSettingsRef = useRef({ micDeviceId, voiceProcessingEnabled });
  useEffect(() => {
    const previous = prevMicSettingsRef.current;
    if (
      previous.micDeviceId === micDeviceId &&
      previous.voiceProcessingEnabled === voiceProcessingEnabled
    )
      return;
    prevMicSettingsRef.current = { micDeviceId, voiceProcessingEnabled };
    if (!localStreamRef.current) return;
    let cancelled = false;
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // hi-fi read non-reactively: changing it shouldn't re-acquire mid-call
          // (it can't change the live producer's stereo/codec), it applies next call.
          audio: microphoneConstraints(
            micDeviceId,
            voiceProcessingEnabled,
            useRoomStore.getState().hifiVoiceEnabled,
          ),
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
  }, [micDeviceId, voiceProcessingEnabled, connectMicToGraph, store]);

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
      audio: microphoneConstraints(
        useRoomStore.getState().micDeviceId,
        useRoomStore.getState().voiceProcessingEnabled,
        useRoomStore.getState().hifiVoiceEnabled,
      ),
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
        iceServers: iceServers(),
      });

      // Send the processed outgoing track (mic gain + limiter, + shared audio),
      // not the raw mic.
      graph.ensure();
      pc.addTrack(graph.outTrack, graph.outStream);

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

      // Remote track → audio pipeline (registry starts it at the right gain so an
      // SFU→P2P switch doesn't reset deafen / per-peer volume).
      pc.ontrack = (e) => {
        registry.attachP2pTrack(peerId, e.track);
      };

      p2pConnectionsRef.current.set(peerId, pc);

      if (isOfferer) {
        // Create offer with low-latency Opus params (mono 64k, or stereo 128k
        // when the user opted into hi-fi voice).
        pc.createOffer().then(async (offer) => {
          offer.sdp = forceOpusParams(offer.sdp!, useRoomStore.getState().hifiVoiceEnabled);
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
    [ensureLocalStream, connectMicToGraph, graph, registry],
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
    registry.cleanupAll();
  }, [registry]);

  // --- SFU: tear down mediasoup transports ---
  const teardownSfu = useCallback(() => {
    producerRef.current?.close();
    producerRef.current = null;
    // Close the share + file producers (rebuilt by setupSfuInner if still active;
    // stopTracks:false keeps their dest tracks alive for the re-produce).
    graph.closeProducers();
    sendTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current?.close();
    recvTransportRef.current = null;
    registry.clearPending();
    // Candidates queued here can only be trailing ones from a dead P2P epoch
    // (a new P2P session's candidates can't arrive before its offer) — drop
    // them so they never flush into a future session's connection.
    pendingCandidatesRef.current.clear();
    registry.cleanupAll();
  }, [registry, graph]);

  // SFU consume lives in PeerAudioRegistry (registry.consumeProducer); the share/
  // file producers in OutgoingAudioGraph; the extra-mic captures + produce/reconcile
  // in ExtraMicController (extraMics, above).

  // Reconcile our outgoing extra-mic producers to the user's selection whenever it
  // changes (and when the primary mic changes, so a device promoted to primary is
  // dropped from the extras — the same physical capture must never stream twice).
  // The controller advances its baseline + (while connected) starts/stops/restarts
  // the delta through its serialization chain.
  useEffect(() => {
    const desired = new Map<string, boolean>();
    for (const id of streamedMicDeviceIds) {
      if (!id || id === micDeviceId) continue;
      desired.set(id, !!micStereoByDevice[id]);
    }
    extraMics.reconcile(desired, connected);
  }, [connected, streamedMicDeviceIds, micStereoByDevice, micDeviceId, extraMics]);

  // Incoming share/file/mic "music stream" teardown lives in PeerAudioRegistry
  // (registry.removeShareStream / removeFileStream / removeMicStream).

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
        iceServers: iceServers(),
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
          // stereo audio share) so the server tags/routes it correctly, plus an
          // optional `title` (device/file detail) shown in the participant list.
          const res = await emit<{ producerId: string }>("produce", {
            kind,
            rtpParameters,
            source: (appData as { source?: string })?.source,
            title: (appData as { title?: string })?.title,
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
        iceServers: iceServers(),
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

      // Produce the processed outgoing track (mic gain + limiter, + shared audio).
      // Voice is mono ~64k by default; the per-user hi-fi opt-in sends stereo
      // 128k (read at produce time, so it takes effect on the next call).
      const hifiVoice = store.getState().hifiVoiceEnabled;
      graph.ensure();
      const producer = await sendTransport.produce({
        track: graph.outTrack,
        codecOptions: {
          opusStereo: hifiVoice,
          opusDtx: false,
          opusFec: true,
          opusMaxPlaybackRate: 48000,
          ...(hifiVoice ? { opusMaxAverageBitrate: 128000 } : {}),
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
      if (store.getState().isSharingAudio) await graph.produceShare();
      // Likewise rebuild the file producer if a local file stream is active.
      if (store.getState().fileStreamName) await graph.produceFile();
      // Likewise rebuild any selected extra-mic producers.
      if (store.getState().streamedMicDeviceIds.length > 0) await extraMics.produceAll();

      // Consume any producers announced while the transports were still being
      // built (their new-producer events arrived too early and were queued).
      await registry.drainPending();
    },
    [emit, connectMicToGraph, ensureLocalStream, graph, extraMics, registry, store],
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
            audio: microphoneConstraints(
              store.getState().micDeviceId,
              store.getState().voiceProcessingEnabled,
              store.getState().hifiVoiceEnabled,
            ),
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
        graph.ensure();
        store.getState().setHasMic(false);
        store.getState().setMuted(true);
      }

      // `socketTarget()` is undefined on the web (same-origin, today's behaviour)
      // and the configured remote instance origin in the Electron client.
      const socket = io(socketTarget(), { transports: ["websocket"] });
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
            producers: Array<{ producerId: string; source: string; title?: string }>;
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
          // Likewise re-pin SFU on a reconnect while streaming extra mic(s).
          extraMic: store.getState().streamedMicDeviceIds.length > 0,
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
        registry.isVoiceActive = !!joinRes.voiceActive;
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
        registry.clearPending();

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
              await registry.consumeProducer(peer.peerId, prod.producerId, prod.source, prod.title);
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
        // Close their P2P connection, drop queued candidates, and tear down all
        // their incoming audio (they may have left mid-stream without a stop event).
        teardownPeerMedia(peerId, {
          p2pConnections: p2pConnectionsRef.current,
          pendingCandidates: pendingCandidatesRef.current,
          registry,
        });
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
        ({
          peerId,
          displayName,
          reason,
        }: {
          peerId: string;
          displayName: string;
          reason?: "vote" | "caster";
        }) => {
          const name = store.getState().peers.get(peerId)?.displayName ?? displayName;
          // Tear down their media exactly like a leave.
          teardownPeerMedia(peerId, {
            p2pConnections: p2pConnectionsRef.current,
            pendingCandidates: pendingCandidatesRef.current,
            registry,
          });
          store.getState().removePeer(peerId);
          store
            .getState()
            .announceEvent(
              reason === "caster"
                ? announce_caster_removed({ name })
                : announce_peer_kicked({ name }),
            );
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

      // Recording + live streaming state-sync handlers (room-wide; both force SFU
      // server-side). Self-contained — see lib/socket/room-event-handlers.ts.
      registerRecordingHandlers(socket);
      registerStreamingHandlers(socket);

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
              // Munge the remote OFFER by our hi-fi flag so OUR encoder sends
              // stereo per our own choice (see withHifiOpus).
              await pc.setRemoteDescription(
                new RTCSessionDescription(withHifiOpus(payload as RTCSessionDescriptionInit)),
              );
              await flushPendingCandidates(fromPeerId, pc);
              const answer = await pc.createAnswer();
              answer.sdp = forceOpusParams(answer.sdp!, useRoomStore.getState().hifiVoiceEnabled);
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
              // Same as the offer path: munge the remote ANSWER so our encoder
              // sends stereo per OUR hi-fi flag (see withHifiOpus).
              await pc.setRemoteDescription(
                new RTCSessionDescription(withHifiOpus(payload as RTCSessionDescriptionInit)),
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
          title,
        }: {
          peerId: string;
          producerId: string;
          source?: string;
          title?: string;
        }) => {
          if (modeRef.current !== "sfu") return;
          try {
            await registry.consumeProducer(peerId, producerId, source ?? "voice", title);
          } catch (err) {
            console.error("[sfu] consume failed:", err);
          }
        },
      );

      // Auto-ducking: server says whether anyone is talking right now.
      socket.on("duck", ({ active }: { active: boolean }) => {
        registry.applyDuck(active);
      });

      // Room-wide ducking toggle changed (by anyone). Reflect it, re-ramp every
      // music stream to its new level (un-duck when turned off, re-duck when
      // turned back on if a voice is active), and log it. De-duped so an echo of
      // our own change — or one matching the value we already have — is a no-op.
      socket.on("ducking-changed", ({ enabled, by }: { enabled: boolean; by?: string }) => {
        if (store.getState().duckingEnabled === enabled) return;
        store.getState().setDuckingEnabled(enabled);
        registry.rampMusicGains();
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
          registry.removeSharesOwnedBy(peerId);
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
          registry.removeFilesOwnedBy(peerId);
          store.getState().announceEvent(announce_file_stream_stopped({ name }));
          playCue(sharedAudioContext, "share-stop");
        },
      );

      // Someone stopped a peer's share/file/extra-mic stream outright (anti-troll,
      // not a vote). The server already closed the producer; we just reconcile the
      // UI. If it's OURS, run owner-side local cleanup WITHOUT re-telling the
      // server; otherwise tear down the tile.
      socket.on(
        "peer-stream-stopped",
        ({
          ownerId,
          producerId,
          source,
        }: {
          ownerId: string;
          producerId: string;
          source: "share" | "file" | "mic";
        }) => {
          if (ownerId === store.getState().localPeerId) {
            if (source === "mic") {
              // Deselect the device whose producer this is; the extra-mic reconcile
              // effect then tears down the capture + (already-closed) producer and
              // announces — so we don't announce here (avoids a double).
              const deviceId = extraMics.deviceIdForProducer(producerId);
              if (deviceId) {
                const remaining = store
                  .getState()
                  .streamedMicDeviceIds.filter((d) => d !== deviceId);
                store.getState().setStreamedMicDeviceIds(remaining);
              }
              return;
            }
            // Share/file: close the producer + stop local playback in place.
            stopOwnStreamLocalRef.current(source);
            store.getState().announceEvent(announce_your_stream_stopped());
            playCue(sharedAudioContext, "share-stop");
            return;
          }
          if (source === "share") registry.removeShareStream(producerId);
          else if (source === "file") registry.removeFileStream(producerId);
          else registry.removeMicStream(producerId);
          const name = store.getState().peers.get(ownerId)?.displayName ?? announce_a_participant();
          store.getState().announceEvent(announce_peer_stream_stopped({ name }));
          playCue(sharedAudioContext, "share-stop");
        },
      );

      // A media producer's detail changed (a file streamer swapped files) — the
      // producer (and its tile, keyed by producerId) persists, so just re-label it
      // from the owner's name + the new title. Owner/source come from whichever
      // stream-owner map holds this producerId.
      socket.on(
        "producer-title-updated",
        ({ producerId, title }: { producerId: string; title?: string }) => {
          const owner = registry.streamOwner(producerId);
          if (!owner) return;
          const ownerName =
            store.getState().peers.get(owner.ownerId)?.displayName ?? announce_a_participant();
          let name: string;
          if (owner.kind === "file")
            name = title
              ? file_stream_name_titled({ name: ownerName, title })
              : file_stream_name({ name: ownerName });
          else if (owner.kind === "share")
            name = title
              ? share_stream_name_titled({ name: ownerName, title })
              : share_stream_name({ name: ownerName });
          else
            name = title
              ? mic_stream_name_titled({ name: ownerName, title })
              : mic_stream_name({ name: ownerName });
          store.getState().setPeerName(producerId, name);
        },
      );

      // A peer started streaming extra microphone(s) — announce once (the server
      // only sends this on their first one) + cue. Each device's tile arrives
      // separately via new-producer.
      socket.on("mic-stream-started", ({ displayName: name }: { displayName: string }) => {
        store.getState().announceEvent(announce_extra_mic_started({ name }));
        playCue(sharedAudioContext, "share-start");
      });

      // A peer stopped one extra mic — tear down that specific tile (addressed by
      // producerId, since a peer may stream several). Announce + cue only once,
      // when they've stopped their last one (`last`).
      socket.on(
        "mic-stream-stopped",
        ({
          producerId,
          displayName: name,
          last,
        }: {
          peerId: string;
          producerId: string;
          displayName: string;
          last: boolean;
        }) => {
          registry.removeMicStream(producerId);
          if (last) {
            store.getState().announceEvent(announce_extra_mic_stopped({ name }));
            playCue(sharedAudioContext, "share-stop");
          }
        },
      );

      // Remote mute/unmute + incoming chat handlers. See room-event-handlers.ts.
      registerMuteHandlers(socket, surfaceToggle);
      registerChatHandlers(socket, chatHintGivenRef);

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
      registry,
      extraMics,
      setupSfu,
      createP2pConnection,
      connectMicToGraph,
      graph,
      teardownP2p,
      teardownSfu,
      surfaceToggle,
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
    registry.rampAll();
  }, [store, registry]);

  // Flip the room-wide auto-ducking toggle. Fire-and-forget: the server echoes
  // `ducking-changed` to everyone (us included), which is what applies it.
  const toggleDucking = useCallback(async () => {
    await emit("set-ducking", { enabled: !store.getState().duckingEnabled }).catch(() => {});
  }, [emit, store]);

  const setPeerVolume = useCallback(
    (peerId: string, volume: number) => {
      store.getState().setPeerVolume(peerId, volume);
      registry.rampPeer(peerId);
    },
    [store, registry],
  );

  // Local (listener-side) mute of one peer/stream: pure client-side, ramps that
  // peer's gain to 0 (via effectiveGain) and back. Never signaled to the server.
  const setPeerLocalMute = useCallback(
    (peerId: string, muted: boolean) => {
      store.getState().setPeerLocalMute(peerId, muted);
      registry.rampPeer(peerId);
    },
    [store, registry],
  );

  // --- Audio share: cast system/tab audio as a SEPARATE stereo producer ---
  // The shared audio gets its own destination + stereo "share" producer (owned by
  // OutgoingAudioGraph), so the voice track is never touched. graph.teardownShareLocal
  // does the node/producer/flag teardown (no emit) — shared by the user-initiated
  // stop and the "someone stopped my stream" path.
  const stopAudioShare = useCallback(async () => {
    if (!store.getState().isSharingAudio) return;
    graph.teardownShareLocal();
    // Tell the server: drop us from the sharer set (may release the SFU pin)
    // and close the server-side producer so peers' tiles disappear.
    await emit("stop-share").catch(() => {});
    // Local feedback; peers get theirs via the share-stopped broadcast.
    store.getState().announceEvent(announce_share_stopped_you());
    playCue(sharedAudioContext, "share-stop");
  }, [store, graph, emit]);

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
    // it becomes a separate high-bitrate stereo producer.
    graph.attachShare(audioTracks, displayStream);

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
    if (wasSfu) await graph.produceShare();

    // Local feedback; peers get theirs via the share-started broadcast.
    store.getState().announceEvent(announce_share_started_you());
    playCue(sharedAudioContext, "share-start");
  }, [store, graph, stopAudioShare, emit]);

  const toggleAudioShare = useCallback(async () => {
    if (store.getState().isSharingAudio) await stopAudioShare();
    else await startAudioShare();
  }, [store, startAudioShare, stopAudioShare]);

  // --- File streaming: stream a local audio file into the call as a SEPARATE
  // stereo "file" producer. Independent of the audio share; the file is decoded
  // by an <audio> element whose Web Audio source feeds its own destination
  // (produced) and the local speakers (monitored). Like a share it forces SFU
  // and is auto-tapped by recording/streaming server-side. ---
  // Local-only teardown of OUR file stream: stop the <audio>, close the producer,
  // disconnect the nodes, clear state. No server emit / announcement — shared by
  // the user-initiated stop (below) and the "someone stopped my stream" path.
  const teardownFileLocal = useCallback(() => {
    // Drop the element's ended/error listeners first so teardown can't fire them.
    fileAbortRef.current?.abort();
    fileAbortRef.current = null;
    // Close the file producer + disconnect the file nodes (the graph owns those).
    graph.teardownFileNodes();
    if (fileAudioRef.current) {
      fileAudioRef.current.pause();
      fileAudioRef.current.src = "";
      fileAudioRef.current = null;
    }
    if (fileObjectUrlRef.current) {
      URL.revokeObjectURL(fileObjectUrlRef.current);
      fileObjectUrlRef.current = null;
    }
    store.getState().setFileStream(null);
    store.getState().setFileStreamPlaying(false);
  }, [store, graph]);

  const stopFileStream = useCallback(
    async (announcement?: string) => {
      if (store.getState().fileStreamName == null) return;
      teardownFileLocal();
      // Tell the server: drop us from the file-streamer set (may release the SFU
      // pin) and close the server-side producer so peers' tiles disappear.
      await emit("stop-file-stream").catch(() => {});
      store.getState().announceEvent(announcement ?? announce_file_stream_stopped_you());
      playCue(sharedAudioContext, "share-stop");
    },
    [store, teardownFileLocal, emit],
  );

  // Keep the owner-side teardown bridge current for the peer-stream-stopped
  // handler registered in join() (see stopOwnStreamLocalRef). The share teardown
  // lives on the graph; the file teardown is the hook's (owns the <audio> element).
  useEffect(() => {
    stopOwnStreamLocalRef.current = (source) =>
      source === "share" ? graph.teardownShareLocal() : teardownFileLocal();
  }, [graph, teardownFileLocal]);

  const startFileSource = useCallback(
    async (src: string, name: string, objectUrl?: string) => {
      graph.ensure();
      resumeContext(sharedAudioContext);

      const firstStart = store.getState().fileStreamName == null;

      // Replace path: tear down the previous element/source but KEEP fileDest and
      // its producer, so swapping the file causes no mode flap or peer tile churn
      // (the produced track is fileDest's, which never changes — only its input).
      fileAbortRef.current?.abort();
      fileAbortRef.current = null;
      graph.disconnectFileSource();
      if (fileAudioRef.current) {
        fileAudioRef.current.pause();
        fileAudioRef.current.src = "";
        fileAudioRef.current = null;
      }
      if (fileObjectUrlRef.current) {
        URL.revokeObjectURL(fileObjectUrlRef.current);
        fileObjectUrlRef.current = null;
      }

      // New <audio> element decoding a local object URL or same-origin server
      // source (library file / proxied public URL).
      fileObjectUrlRef.current = objectUrl ?? null;
      const audioEl = new Audio();
      audioEl.src = src;
      (audioEl as unknown as Record<string, boolean>).playsInline = true;
      fileAudioRef.current = audioEl;

      // Wire the element into its own produced dest + a local monitor gain.
      graph.connectFileElement(audioEl);

      // Stop the whole stream when the file ends or fails to decode.
      const ac = new AbortController();
      fileAbortRef.current = ac;
      audioEl.addEventListener("ended", () => void stopFileStream(announce_file_stream_ended()), {
        signal: ac.signal,
      });
      audioEl.addEventListener("error", () => void stopFileStream(announce_file_stream_error()), {
        signal: ac.signal,
      });

      store.getState().setFileStream(name);
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
        if (wasSfu) await graph.produceFile();
        store.getState().announceEvent(announce_file_stream_started_you());
        playCue(sharedAudioContext, "share-start");
      } else {
        // Replacing the file mid-stream — producer/SFU pin are unchanged, but the
        // persisted producer still carries the OLD file's title, so push the new
        // one so other peers' tiles re-label from the old file name to the new.
        const fileProducerId = graph.fileProducerId;
        if (fileProducerId)
          emit("update-stream-title", { producerId: fileProducerId, title: name }).catch(() => {});
        store.getState().announce(file_player_streaming({ name }));
      }
    },
    [store, graph, emit, stopFileStream],
  );

  const startFileStream = useCallback(
    async (file: File) => {
      const objectUrl = URL.createObjectURL(file);
      try {
        await startFileSource(objectUrl, file.name, objectUrl);
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        throw err;
      }
    },
    [startFileSource],
  );

  const startUrlStream = useCallback(
    async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid URL");
      const name = decodeURIComponent(
        url.pathname.split("/").filter(Boolean).pop() ?? url.hostname,
      );
      await startFileSource(apiUrl(`/api/audio-proxy?url=${encodeURIComponent(url.href)}`), name);
    },
    [startFileSource],
  );

  const startServerFileStream = useCallback(
    // `relPath` may include subfolders (e.g. "Movies/Dune.mp3"); display the
    // basename while streaming.
    async (relPath: string) => {
      const name = relPath.split("/").pop() || relPath;
      await startFileSource(
        apiUrl(`/api/audio-library/file?path=${encodeURIComponent(relPath)}`),
        name,
      );
    },
    [startFileSource],
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
  const setMicGain = useCallback((gain: number) => graph.setMicGain(gain), [graph]);

  // Live local-monitor volume for the file/URL stream: persists the value and
  // ramps the monitor gain node. Only changes what the streamer hears — the
  // produced track (fileDest) everyone else consumes is untouched.
  const setStreamMonitorVolume = useCallback(
    (volume: number) => graph.setStreamMonitorVolume(volume),
    [graph],
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
    // Tear down any active file stream (stops the <audio>, revokes its URL).
    fileAbortRef.current?.abort();
    fileAbortRef.current = null;
    if (fileAudioRef.current) {
      fileAudioRef.current.pause();
      fileAudioRef.current.src = "";
      fileAudioRef.current = null;
    }
    if (fileObjectUrlRef.current) {
      URL.revokeObjectURL(fileObjectUrlRef.current);
      fileObjectUrlRef.current = null;
    }
    teardownP2p();
    teardownSfu();
    // Tear down the outgoing graph (nodes live in the shared context, so just
    // disconnect them — the context itself is reused for the next room).
    graph.disconnectAll();
    // Tear down every outgoing extra mic — the capture + Web Audio nodes are
    // app-owned (stopTracks:false producers), so they'd leak across rooms otherwise.
    extraMics.teardownAll();
    // Incoming-stream owner maps are owned by PeerAudioRegistry and already
    // cleared by registry.cleanupAll() (via teardownP2p/teardownSfu above).
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
  }, [teardownP2p, teardownSfu, graph, extraMics, store]);

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

  // Remove a music caster (e.g. Ecobox) outright — available to anyone, in
  // public AND private rooms (casters can't be vote-kicked and bypass the knock
  // gate, so an abusive one would otherwise be unremovable). The server hard-
  // limits this to caster targets; on success it broadcasts `peer-kicked` like a
  // vote-kick, so our own teardown runs through that handler. A rejection thunks.
  const kickCaster = useCallback(
    (targetId: string) => {
      emit("kick-caster", { targetId }).catch(() => {
        playCue(sharedAudioContext, "thunk");
      });
    },
    [emit],
  );

  // Stop one peer's share/file stream outright (anti-troll), in any room — the
  // person stays, only the stream ends. The server hard-limits this to share/file
  // producers and authoritatively closes it, then broadcasts peer-stream-stopped.
  // A rejection thunks.
  const stopPeerStream = useCallback(
    (producerId: string) => {
      emit("stop-peer-stream", { producerId }).catch(() => {
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
    kickCaster,
    stopPeerStream,
    mute,
    unmute,
    toggleMute,
    toggleDeafen,
    toggleDucking,
    toggleAudioShare,
    startFileStream,
    startUrlStream,
    startServerFileStream,
    stopFileStream,
    toggleFilePlayback,
    toggleRecording,
    startRecording,
    stopRecording,
    startStreaming,
    stopStreaming,
    toggleStreaming,
    setPeerVolume,
    setPeerLocalMute,
    setMicGain,
    setStreamMonitorVolume,
    sendChatMessage,
    announceSpeakers,
    peerAudiosRef,
  };
}
