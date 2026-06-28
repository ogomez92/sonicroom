// Fake RTCPeerConnection / RTCSessionDescription / RTCIceCandidate for the P2P
// path. Every created connection is recorded so tests can assert how many were
// built, who offered, and that ICE candidates / remote descriptions were applied.
import { FakeMediaStreamTrack } from "./media-mock";

// A minimal SDP that forceOpusParams can recognise (it looks for an Opus fmtp
// line containing "minptime"). createOffer/createAnswer return this.
export const FAKE_OPUS_SDP = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "",
].join("\r\n");

export class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];

  readonly config: RTCConfiguration;
  onicecandidate: ((e: { candidate: FakeIceCandidate | null }) => void) | null = null;
  ontrack: ((e: { track: FakeMediaStreamTrack }) => void) | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  readonly addedTracks: FakeMediaStreamTrack[] = [];
  readonly addedIceCandidates: RTCIceCandidateInit[] = [];

  constructor(config: RTCConfiguration = {}) {
    this.config = config;
    FakeRTCPeerConnection.instances.push(this);
  }

  addTrack(track: FakeMediaStreamTrack) {
    this.addedTracks.push(track);
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "offer", sdp: FAKE_OPUS_SDP });
  }
  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "answer", sdp: FAKE_OPUS_SDP });
  }
  setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = desc;
    return Promise.resolve();
  }
  setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = desc;
    return Promise.resolve();
  }
  addIceCandidate(c: RTCIceCandidateInit) {
    this.addedIceCandidates.push(c);
    return Promise.resolve();
  }
  close() {
    this.closed = true;
  }

  // Test helpers.
  fireIceCandidate(candidate: FakeIceCandidate | null) {
    this.onicecandidate?.({ candidate });
  }
  fireTrack(track = new FakeMediaStreamTrack("audio", "remote")) {
    this.ontrack?.({ track });
  }
}

export class FakeSessionDescription {
  type: string;
  sdp?: string;
  constructor(init: RTCSessionDescriptionInit) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

export class FakeIceCandidate {
  candidate: string;
  constructor(init: RTCIceCandidateInit = {}) {
    this.candidate = init.candidate ?? "candidate:fake";
  }
  toJSON() {
    return { candidate: this.candidate };
  }
}

export function resetWebRtcMock() {
  FakeRTCPeerConnection.instances.length = 0;
}

export function installWebRtcMock() {
  const g = globalThis as Record<string, unknown>;
  g.RTCPeerConnection = FakeRTCPeerConnection;
  g.RTCSessionDescription = FakeSessionDescription;
  g.RTCIceCandidate = FakeIceCandidate;
}
