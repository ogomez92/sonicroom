// The outgoing audio graph: mic → micGain → limiter → outDest → outgoing track.
// The track added to peers / produced to the SFU is always outDest's, so senders
// never swap tracks. Shared system/tab audio ("share") and a streamed local file
// ("file") each get their OWN destination → produced as separate stereo tracks,
// independent of voice and of each other. Extracted from useMediasoup so the node
// graph + its two side producers are owned in one place; the hook keeps the DOM /
// socket orchestration (getDisplayMedia, the <audio> element, emits, cues).
import type { Device } from "mediasoup-client";
import type { Transport, Producer } from "mediasoup-client/types";
import { useRoomStore } from "../../stores/room";
import { resumeContext, GAIN_RAMP } from "./shared-context";

// Soft limiter sitting after the outgoing mic gain so boosting a quiet/cheap mic
// doesn't clip: transparent until peaks approach 0 dBFS, then ~20:1 with a fast
// attack. Adds ~5 ms of look-ahead latency, negligible for voice.
const MIC_LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 };

// The share + file producers negotiate full stereo hi-fi (the router's 256 kbps
// ceiling allows it), independent of voice. Identical for both.
const SHARE_FILE_CODEC_OPTIONS = {
  opusStereo: true,
  opusDtx: false,
  opusFec: true,
  opusMaxPlaybackRate: 48000,
  opusMaxAverageBitrate: 256000,
} as const;

// Readiness getters into the live SFU state the producers need (the hook supplies
// closures over its sendTransportRef / deviceRef).
export interface SfuProduceDeps {
  getSendTransport(): Transport | null;
  getDevice(): Device | null;
}

export class OutgoingAudioGraph {
  // Voice chain (built once by ensure()).
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private outDest: MediaStreamAudioDestinationNode | null = null;
  private micStream: MediaStream | null = null;
  // Share sub-graph (displaySource → shareDest) + its capture + producer.
  private displaySource: MediaStreamAudioSourceNode | null = null;
  private shareDest: MediaStreamAudioDestinationNode | null = null;
  private displayStream: MediaStream | null = null;
  private shareProducer: Producer | null = null;
  // File sub-graph (fileSource → fileDest, and source → fileMonitorGain → speakers)
  // + its producer. The <audio> element feeding fileSource is owned by the hook.
  private fileSource: MediaElementAudioSourceNode | null = null;
  private fileDest: MediaStreamAudioDestinationNode | null = null;
  private fileMonitorGain: GainNode | null = null;
  private fileProducer: Producer | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly store: typeof useRoomStore,
    private readonly deps: SfuProduceDeps,
  ) {}

  // Build mic → micGain → limiter → outDest once; reused for the whole session.
  ensure() {
    if (this.outDest) return;
    // The mic flows through the shared context, so it must be running (it starts
    // suspended on iOS until a user gesture).
    resumeContext(this.ctx);
    const micGain = this.ctx.createGain();
    micGain.gain.value = this.store.getState().micGain;
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = MIC_LIMITER.threshold;
    limiter.knee.value = MIC_LIMITER.knee;
    limiter.ratio.value = MIC_LIMITER.ratio;
    limiter.attack.value = MIC_LIMITER.attack;
    limiter.release.value = MIC_LIMITER.release;
    const outDest = this.ctx.createMediaStreamDestination();
    micGain.connect(limiter);
    limiter.connect(outDest);
    this.micGain = micGain;
    this.limiter = limiter;
    this.outDest = outDest;
  }

  // The processed outgoing track / stream everyone receives. ensure() must have run.
  get outTrack(): MediaStreamTrack {
    return this.outDest!.stream.getAudioTracks()[0];
  }
  get outStream(): MediaStream {
    return this.outDest!.stream;
  }

  // (Re)route the raw mic into the graph. Idempotent for a given stream; re-runs
  // when the mic is re-acquired (track died / device change).
  connectMic(stream: MediaStream) {
    this.ensure();
    if (this.micStream === stream && this.micSource) return;
    this.micSource?.disconnect();
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.micGain!);
    this.micStream = stream;
  }

  // Live mic-gain control: persist the value and ramp the outgoing gain node.
  setMicGain(gain: number) {
    this.store.getState().setMicGain(gain);
    this.micGain?.gain.setTargetAtTime(gain, this.ctx.currentTime, GAIN_RAMP);
  }

  // Live local-monitor volume for the file stream: persist + ramp the monitor gain.
  // Only changes what the streamer hears — fileDest (what others get) is untouched.
  setStreamMonitorVolume(volume: number) {
    this.store.getState().setStreamMonitorVolume(volume);
    this.fileMonitorGain?.gain.setTargetAtTime(volume, this.ctx.currentTime, GAIN_RAMP);
  }

  // --- Audio share (system/tab audio as its own stereo "share" producer) ---

  // Route shared audio into its OWN destination (not the voice graph) so it becomes
  // a separate high-bitrate stereo producer.
  attachShare(audioTracks: MediaStreamTrack[], displayStream: MediaStream) {
    this.ensure();
    const shareDest = this.ctx.createMediaStreamDestination();
    const displaySource = this.ctx.createMediaStreamSource(new MediaStream(audioTracks));
    displaySource.connect(shareDest);
    this.displaySource = displaySource;
    this.shareDest = shareDest;
    this.displayStream = displayStream;
  }

  // Produce the share dest's track as a separate stereo "share" producer. SFU-only;
  // idempotent. stopTracks:false: shareDest is app-owned and reused across produces.
  async produceShare() {
    const sendTransport = this.deps.getSendTransport();
    const device = this.deps.getDevice();
    if (!sendTransport || !device || !this.shareDest) return;
    if (this.shareProducer && !this.shareProducer.closed) return;
    const track = this.shareDest.stream.getAudioTracks()[0];
    if (!track) return;
    // The display-capture track names what's being shared ("System Audio" / "Tab
    // audio"), so other peers' tiles read "Tyler's shared audio: …".
    const shareLabel = this.displayStream?.getAudioTracks()[0]?.label || undefined;
    this.shareProducer = await sendTransport.produce({
      track,
      codecOptions: { ...SHARE_FILE_CODEC_OPTIONS },
      codec: device.recvRtpCapabilities.codecs?.find(
        (c) => c.mimeType.toLowerCase() === "audio/opus",
      ),
      appData: { source: "share", title: shareLabel },
      stopTracks: false,
    });
  }

  // Disconnect the share nodes + stop the display capture.
  private detachShare() {
    this.displaySource?.disconnect();
    this.shareDest?.disconnect();
    this.displaySource = null;
    this.shareDest = null;
    this.displayStream?.getTracks().forEach((t) => t.stop());
    this.displayStream = null;
  }

  // Local-only teardown of OUR share: close the producer, detach the nodes, clear
  // the flag. No server emit / announcement (the caller does that).
  teardownShareLocal() {
    if (this.shareProducer) {
      if (!this.shareProducer.closed) this.shareProducer.close();
      this.shareProducer = null;
    }
    this.detachShare();
    this.store.getState().setSharingAudio(false);
  }

  // --- File streaming (an <audio> element's output as its own stereo producer) ---

  // Disconnect the previous file source node before swapping in a new <audio>
  // element (the replace path keeps fileDest + its producer).
  disconnectFileSource() {
    this.fileSource?.disconnect();
    this.fileSource = null;
  }

  // Wire a freshly-created <audio> element into its OWN destination (produced — the
  // full-level track everyone hears) AND a local monitor gain (source →
  // fileMonitorGain → speakers, so the streamer sets their own level). fileDest and
  // fileMonitorGain persist across file swaps; only the source feeding them changes.
  connectFileElement(audioEl: HTMLAudioElement) {
    const source = this.ctx.createMediaElementSource(audioEl);
    this.fileSource = source;
    if (!this.fileDest) this.fileDest = this.ctx.createMediaStreamDestination();
    source.connect(this.fileDest);
    if (!this.fileMonitorGain) {
      this.fileMonitorGain = this.ctx.createGain();
      this.fileMonitorGain.gain.value = this.store.getState().streamMonitorVolume;
      this.fileMonitorGain.connect(this.ctx.destination);
    }
    source.connect(this.fileMonitorGain);
  }

  // Produce the file dest's track as a separate stereo "file" producer (mirrors
  // produceShare). SFU-only; idempotent. stopTracks:false (see produceShare).
  async produceFile() {
    const sendTransport = this.deps.getSendTransport();
    const device = this.deps.getDevice();
    if (!sendTransport || !device || !this.fileDest) return;
    if (this.fileProducer && !this.fileProducer.closed) return;
    const track = this.fileDest.stream.getAudioTracks()[0];
    if (!track) return;
    this.fileProducer = await sendTransport.produce({
      track,
      codecOptions: { ...SHARE_FILE_CODEC_OPTIONS },
      codec: device.recvRtpCapabilities.codecs?.find(
        (c) => c.mimeType.toLowerCase() === "audio/opus",
      ),
      // The file name / URL last segment, so other peers' tiles read e.g.
      // "Tyler's file: song.mp3" instead of a bare "Tyler's file".
      appData: { source: "file", title: this.store.getState().fileStreamName ?? undefined },
      stopTracks: false,
    });
  }

  // The live file producer's id (for re-titling on a file swap), if any.
  get fileProducerId(): string | undefined {
    return this.fileProducer?.id;
  }

  // Node half of the file teardown — close the producer + disconnect the file
  // nodes. The <audio> element / object URL + store writes are the hook's concern.
  teardownFileNodes() {
    if (this.fileProducer) {
      if (!this.fileProducer.closed) this.fileProducer.close();
      this.fileProducer = null;
    }
    this.fileSource?.disconnect();
    this.fileDest?.disconnect();
    this.fileMonitorGain?.disconnect();
    this.fileSource = null;
    this.fileDest = null;
    this.fileMonitorGain = null;
  }

  // Close the share + file producers on an SFU teardown WITHOUT touching the dest
  // nodes — stopTracks:false keeps their tracks alive so setupSfu can re-produce.
  closeProducers() {
    this.shareProducer?.close();
    this.shareProducer = null;
    this.fileProducer?.close();
    this.fileProducer = null;
  }

  // Disconnect every node and reset to unbuilt (leave). The shared context itself
  // is reused for the next room, so a later ensure() rebuilds the chain. Also stops
  // any live display capture (the share's getDisplayMedia tracks).
  disconnectAll() {
    if (this.outDest) {
      this.micSource?.disconnect();
      this.micGain?.disconnect();
      this.limiter?.disconnect();
      this.displaySource?.disconnect();
      this.shareDest?.disconnect();
      this.fileSource?.disconnect();
      this.fileDest?.disconnect();
      this.fileMonitorGain?.disconnect();
    }
    this.displayStream?.getTracks().forEach((t) => t.stop());
    this.micSource = null;
    this.micGain = null;
    this.limiter = null;
    this.outDest = null;
    this.micStream = null;
    this.displaySource = null;
    this.shareDest = null;
    this.displayStream = null;
    this.shareProducer = null;
    this.fileSource = null;
    this.fileDest = null;
    this.fileMonitorGain = null;
    this.fileProducer = null;
  }
}
