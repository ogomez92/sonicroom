// Everything video in a VIDEO room, on one object: our outgoing camera and
// screen-share video (each its own mediasoup producer, "camera" / "screen" —
// separate tracks like share/file are for audio), and the incoming camera/screen
// consumers rendered as tiles. Audio-first by construction: this module is only
// dynamically imported by useMediasoup once the join response says the room is a
// video room, so an audio room never loads, captures, or consumes any video. It
// is SFU-only — a video room is pinned to the SFU server-side — so there is no
// P2P path to keep in sync. Mirrors the OutgoingAudioGraph / PeerAudioRegistry
// split the audio side uses, with the same injected readiness getters.
import type { Device } from "mediasoup-client";
import type { Transport, Producer, Consumer } from "mediasoup-client/types";
import { useRoomStore } from "../../stores/room";
import { getSharedAudioContext } from "../audio/shared-context";
import { playCue } from "../sounds";
import {
  announce_a_participant,
  announce_video_on_you,
  announce_video_off_you,
  announce_video_failed,
  announce_background_unavailable,
  describe_working,
  describe_result_self,
  describe_result_camera,
  describe_result_screen,
  describe_no_key,
  describe_no_stream,
  describe_error_auth,
  describe_error_rate_limited,
  describe_error_network,
  describe_error_generic,
} from "../../paraglide/messages.js";
import { captureFrame, describeFrame, DescribeError, type DescribeSubject } from "./describe-video";
import type { CameraBackgroundFx } from "./background-fx";

export type VideoSource = "camera" | "screen";

// An incoming video tile: one remote producer, owned by `peerId`.
export interface VideoTile {
  producerId: string;
  peerId: string;
  source: VideoSource;
}

// Matches useMediasoup's `emit` helper (promisified ack-with-timeout socket emit).
type Emit = <T>(event: string, data?: unknown) => Promise<T>;

export interface VideoDeps {
  getSendTransport(): Transport | null;
  getRecvTransport(): Transport | null;
  getDevice(): Device | null;
}

interface ConsumeResult {
  consumerId: string;
  producerId: string;
  kind: string;
  rtpParameters: Record<string, unknown>;
}

// A modest webcam picture: voice stays the priority, and every camera costs
// every listener bandwidth in the SFU fan-out.
const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: "user",
};
const CAMERA_ENCODINGS = [{ maxBitrate: 600_000 }];
// A shared screen needs more for legible text, at a lower frame rate.
const SCREEN_ENCODINGS = [{ maxBitrate: 1_500_000, maxFramerate: 15 }];

export class VideoMedia {
  // Outgoing camera. TWO streams, and the distinction matters:
  //  - rawCameraStream is the actual getUserMedia capture — the device. Only
  //    this object owns real hardware, and only stopCamera/teardownAll stop it.
  //  - cameraStream is what we PRODUCE and preview. With no background it IS
  //    the raw capture; with one, it's the compositor's canvas track and the
  //    raw capture never leaves this machine.
  // Everything downstream (produceCamera, getLocalStream, the self tile, the
  // face-centering loop, "describe my video") reads cameraStream, so it sees
  // exactly what the room sees. Both are app-owned (stopTracks:false) so a mode
  // rebuild or reconnect re-produces the same track.
  private rawCameraStream: MediaStream | null = null;
  private cameraStream: MediaStream | null = null;
  private cameraProducer: Producer | null = null;
  // The background compositor, null whenever the background is "none" (the
  // default) or it couldn't be set up here. Loaded by dynamic import so an
  // audio room — and a video room with no background — never ships MediaPipe's
  // segmenter or the model.
  private backgroundFx: CameraBackgroundFx | null = null;
  // True only between the getUserMedia call and rawCameraStream being set —
  // the one window cameraActive can't cover.
  private starting = false;
  // Outgoing screen video: the display-capture video track (the audio half, if
  // any, lives in OutgoingAudioGraph's share) + its producer.
  private screenTrack: MediaStreamTrack | null = null;
  private screenProducer: Producer | null = null;
  // Incoming tiles keyed by producerId → the consumer and a MediaStream the
  // <video> elements attach to. The store holds the serialisable VideoTile list.
  private readonly incoming = new Map<
    string,
    { consumer: Consumer; stream: MediaStream; tile: VideoTile }
  >();
  // Producers announced before the recv transport existed (see drainPending).
  private pending: VideoTile[] = [];
  private describing = false;

  constructor(
    private readonly store: typeof useRoomStore,
    private readonly emit: Emit,
    private readonly deps: VideoDeps,
  ) {}

  // --- Local camera ---

  getLocalStream(): MediaStream | null {
    return this.cameraStream;
  }

  // Is the camera on, or on its way on? Starting one is no longer instant — a
  // background has to load a model and warm the compositor up — so "on" is
  // owned by the RAW capture, which exists for that whole window. Every
  // start/stop/toggle gates on this so a double-press can't open the device
  // twice or leave a compositor running with nothing behind it.
  private get cameraActive(): boolean {
    return this.rawCameraStream != null;
  }

  // Turn our camera on: acquire, apply the lobby-chosen background, tell the
  // room (so peers announce + chime), and produce if the SFU is already up
  // (else setupSfu's produceAll does it). A denied/missing camera is announced,
  // never thrown — nothing else breaks.
  async startCamera(): Promise<void> {
    if (this.cameraActive || this.starting) return;
    this.starting = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS });
    } catch (err) {
      console.warn("[video] camera unavailable:", err);
      this.store.getState().announceEvent(announce_video_failed());
      playCue(getSharedAudioContext(), "thunk");
      return;
    } finally {
      this.starting = false;
    }
    this.rawCameraStream = stream;
    // The OS/browser can end the track (device unplugged, permission revoked,
    // another app grabbed it) — reflect that as "video off" everywhere. Watched
    // on the RAW device track: the compositor's canvas track never "ends".
    stream.getVideoTracks()[0]?.addEventListener("ended", () => void this.stopCamera());

    const { output, fx } = await this.applyBackground(stream);
    // Warming the compositor takes a moment, and the user can turn the camera
    // back off (or leave the room) inside it. If that happened, closeCamera has
    // already stopped this capture — don't resurrect it, and don't leak the
    // compositor that finished building for a camera nobody wants any more.
    if (this.rawCameraStream !== stream) {
      fx?.close();
      return;
    }
    this.backgroundFx = fx;
    this.cameraStream = output;

    this.store.getState().setVideoOn(true);
    this.store.getState().bumpLocalVideo();
    await this.emit("start-video", {}).catch(() => {});
    await this.produceCamera();
    this.store.getState().announceEvent(announce_video_on_you());
    playCue(getSharedAudioContext(), "video-on");
  }

  // Produce the camera track (SFU-only; idempotent). Called from startCamera and
  // again by setupSfu on every mode rebuild / reconnect while the camera is on.
  async produceCamera(): Promise<void> {
    const sendTransport = this.deps.getSendTransport();
    const device = this.deps.getDevice();
    const track = this.cameraStream?.getVideoTracks()[0];
    if (!sendTransport || !device || !track || track.readyState !== "live") return;
    if (this.cameraProducer && !this.cameraProducer.closed) return;
    this.cameraProducer = await sendTransport.produce({
      track,
      encodings: CAMERA_ENCODINGS,
      codecOptions: { videoGoogleStartBitrate: 800 },
      appData: { source: "camera" },
      stopTracks: false,
    });
  }

  // Turn our camera off: close the producer, stop the capture, tell the room
  // (which authoritatively closes the server-side producer + announces).
  async stopCamera(): Promise<void> {
    if (!this.cameraActive) return;
    this.closeCameraProducer();
    this.closeCamera();
    this.store.getState().setVideoOn(false);
    this.store.getState().bumpLocalVideo();
    await this.emit("stop-video", {}).catch(() => {});
    this.store.getState().announceEvent(announce_video_off_you());
    playCue(getSharedAudioContext(), "video-off");
  }

  async toggleCamera(): Promise<void> {
    if (this.cameraActive) await this.stopCamera();
    else await this.startCamera();
  }

  private closeCameraProducer() {
    if (this.cameraProducer && !this.cameraProducer.closed) this.cameraProducer.close();
    this.cameraProducer = null;
  }

  // Put the lobby-chosen background behind the capture, and return the stream
  // to produce. "none" (the default) short-circuits before the dynamic import,
  // so the common path costs nothing at all. Anything that goes wrong — an
  // unsupported browser, a model that won't load, a blur this browser can't
  // actually apply — falls back to the raw camera AND says so: silently
  // sending the real room to everyone is the one outcome we won't accept.
  private async applyBackground(
    raw: MediaStream,
  ): Promise<{ output: MediaStream; fx: CameraBackgroundFx | null }> {
    const { videoBackground, videoBackgroundImage } = this.store.getState();
    if (videoBackground === "none") return { output: raw, fx: null };
    try {
      const { createCameraBackgroundFx } = await import("./background-fx");
      const fx = await createCameraBackgroundFx(raw, videoBackground, videoBackgroundImage);
      if (fx) return { output: fx.stream, fx };
    } catch (err) {
      console.warn("[video] background compositor failed:", err);
    }
    this.store.getState().announceEvent(announce_background_unavailable());
    return { output: raw, fx: null };
  }

  // Tear the capture down in dependency order: the compositor first (it reads
  // frames from the raw capture and owns only its own canvas track), then the
  // device itself.
  private closeCamera() {
    this.backgroundFx?.close();
    this.backgroundFx = null;
    this.rawCameraStream?.getTracks().forEach((t) => t.stop());
    this.rawCameraStream = null;
    this.cameraStream = null;
  }

  // --- Screen-share video (the video half of the audio share's getDisplayMedia) ---

  // Keep the display capture's video track and produce it as "screen". The share
  // itself (start-share / stop-share, the SFU pin, the audio producer) is driven
  // by useMediasoup's startAudioShare; this only adds the picture.
  async attachScreen(track: MediaStreamTrack): Promise<void> {
    this.detachScreen();
    this.screenTrack = track;
    await this.produceScreen();
  }

  async produceScreen(): Promise<void> {
    const sendTransport = this.deps.getSendTransport();
    const device = this.deps.getDevice();
    const track = this.screenTrack;
    if (!sendTransport || !device || !track || track.readyState !== "live") return;
    if (this.screenProducer && !this.screenProducer.closed) return;
    this.screenProducer = await sendTransport.produce({
      track,
      encodings: SCREEN_ENCODINGS,
      codecOptions: { videoGoogleStartBitrate: 1000 },
      // The display-capture label ("Screen 1" / a window title) so peers' tiles
      // can say what's shared.
      appData: { source: "screen", title: track.label || undefined },
      stopTracks: false,
    });
  }

  // Stop the screen video (the share ended — by us, by the browser's "Stop
  // sharing" bar, or by a peer stopping our stream). The server closes its
  // "screen" producer on stop-share, so no extra emit is needed here.
  detachScreen(): void {
    if (this.screenProducer && !this.screenProducer.closed) this.screenProducer.close();
    this.screenProducer = null;
    this.screenTrack?.stop();
    this.screenTrack = null;
  }

  get isSharingScreen(): boolean {
    return this.screenTrack != null && this.screenTrack.readyState === "live";
  }

  // --- SFU lifecycle hooks (called by useMediasoup) ---

  // Re-produce whatever is live after the SFU (re)builds: setupSfu calls this.
  async produceAll(): Promise<void> {
    await this.produceCamera();
    await this.produceScreen();
  }

  // SFU teardown: close producers but KEEP the captures (stopTracks:false), so
  // the rebuild can re-produce them — same contract as graph.closeProducers().
  closeProducers(): void {
    this.closeCameraProducer();
    if (this.screenProducer && !this.screenProducer.closed) this.screenProducer.close();
    this.screenProducer = null;
  }

  // --- Incoming tiles ---

  getStream(producerId: string): MediaStream | null {
    return this.incoming.get(producerId)?.stream ?? null;
  }

  // Consume a remote camera/screen producer into a tile. Queued if the recv
  // transport isn't up yet (drained at the end of setupSfu).
  async consume(peerId: string, producerId: string, source: VideoSource): Promise<void> {
    const device = this.deps.getDevice();
    const recvTransport = this.deps.getRecvTransport();
    if (!device || !recvTransport) {
      this.pending.push({ producerId, peerId, source });
      return;
    }
    if (this.incoming.has(producerId)) return;
    const res = await this.emit<ConsumeResult>("consume", {
      producerId,
      rtpCapabilities: device.recvRtpCapabilities,
    });
    const consumer = await recvTransport.consume({
      id: res.consumerId,
      producerId: res.producerId,
      kind: "video",
      rtpParameters: res.rtpParameters as Parameters<
        typeof recvTransport.consume
      >[0]["rtpParameters"],
    });
    const tile: VideoTile = { producerId, peerId, source };
    this.incoming.set(producerId, { consumer, stream: new MediaStream([consumer.track]), tile });
    const s = this.store.getState();
    s.addVideoTile(tile);
    if (source === "camera") s.setPeerVideo(peerId, true);
    else s.setPeerScreen(peerId, true);
  }

  async drainPending(): Promise<void> {
    while (this.pending.length > 0) {
      const p = this.pending.shift()!;
      await this.consume(p.peerId, p.producerId, p.source).catch((err) => {
        console.error("[video] queued consume failed:", err);
      });
    }
  }

  clearPending(): void {
    this.pending = [];
  }

  remove(producerId: string): void {
    const entry = this.incoming.get(producerId);
    if (!entry) return;
    entry.consumer.close();
    this.incoming.delete(producerId);
    const s = this.store.getState();
    s.removeVideoTile(producerId);
    // The peer's indicator clears only when their LAST tile of that kind is gone.
    const { peerId, source } = entry.tile;
    const stillHas = [...this.incoming.values()].some(
      (e) => e.tile.peerId === peerId && e.tile.source === source,
    );
    if (!stillHas) {
      if (source === "camera") s.setPeerVideo(peerId, false);
      else s.setPeerScreen(peerId, false);
    }
  }

  // Drop every tile a peer owns (a leave/kick), or only those of one source (a
  // camera off / share stopped).
  removeOwnedBy(peerId: string, source?: VideoSource): void {
    for (const [producerId, entry] of [...this.incoming]) {
      if (entry.tile.peerId === peerId && (!source || entry.tile.source === source)) {
        this.remove(producerId);
      }
    }
  }

  // Which incoming tile (if any) shows `peerId`'s camera/screen — for "Describe".
  tileFor(peerId: string, source: VideoSource): VideoTile | undefined {
    for (const entry of this.incoming.values()) {
      if (entry.tile.peerId === peerId && entry.tile.source === source) return entry.tile;
    }
    return undefined;
  }

  // Close every incoming consumer and forget the tiles (mode rebuild / reconnect
  // / leave). Producers still live are re-consumed from the next join snapshot.
  cleanupAll(): void {
    for (const entry of this.incoming.values()) entry.consumer.close();
    this.incoming.clear();
    this.store.getState().clearVideoTiles();
  }

  // Leave: everything, including our own captures.
  teardownAll(): void {
    this.closeProducers();
    this.closeCamera();
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.cleanupAll();
    this.clearPending();
    const s = this.store.getState();
    s.setVideoOn(false);
    s.bumpLocalVideo();
  }

  // --- "Describe X's video / my video / X's screen" (Claude) ---

  // Snapshot the stream, ask Claude, and read the answer out — through
  // announceEvent, so the description also lands in the chat timeline and can
  // be re-read with Alt+number. Failures are announced with a localized reason.
  async describe(peerId: string, source: VideoSource): Promise<void> {
    if (this.describing) return;
    const s = this.store.getState();
    const isSelf = peerId === s.localPeerId;
    const subject: DescribeSubject = isSelf ? "self" : source;
    const stream = isSelf ? this.cameraStream : this.streamForPeer(peerId, source);
    if (!stream) {
      s.announce(describe_no_stream());
      playCue(getSharedAudioContext(), "thunk");
      return;
    }
    if (!s.claudeApiKey.trim()) {
      s.announce(describe_no_key());
      playCue(getSharedAudioContext(), "thunk");
      return;
    }
    const name = isSelf ? "" : (s.peers.get(peerId)?.displayName ?? announce_a_participant());
    this.describing = true;
    s.announce(describe_working());
    try {
      const frame = await captureFrame(stream);
      const text = await describeFrame({
        apiKey: s.claudeApiKey,
        frame,
        locale: this.store.getState().locale,
        subject,
      });
      this.store
        .getState()
        .announceEvent(
          subject === "self"
            ? describe_result_self({ text })
            : subject === "screen"
              ? describe_result_screen({ name, text })
              : describe_result_camera({ name, text }),
        );
    } catch (err) {
      this.store.getState().announce(describeErrorMessage(err));
      playCue(getSharedAudioContext(), "thunk");
    } finally {
      this.describing = false;
    }
  }

  private streamForPeer(peerId: string, source: VideoSource): MediaStream | null {
    const tile = this.tileFor(peerId, source);
    return tile ? this.getStream(tile.producerId) : null;
  }
}

function describeErrorMessage(err: unknown): string {
  if (err instanceof DescribeError) {
    switch (err.code) {
      case "no_key":
        return describe_no_key();
      case "no_frame":
        return describe_no_stream();
      case "auth":
        return describe_error_auth();
      case "rate_limited":
        return describe_error_rate_limited();
      case "network":
        return describe_error_network();
      default:
        return describe_error_generic();
    }
  }
  return describe_error_generic();
}
