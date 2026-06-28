// The shared media-teardown a departing peer needs, whether they left voluntarily
// (peer-left) or were removed (peer-kicked) — both did byte-identical work inline.
// Closes the P2P connection (if the mesh was up), drops any ICE candidates queued
// for them, and tears down all their incoming audio (voice/music pipeline + every
// share/file/mic tile they owned). The caller still removes the peer from the store
// roster and announces (the wording differs: leave vs music-stopped vs kick).
import type { PeerAudioRegistry } from "../audio/peer-audio-registry";

export interface PeerTeardownCtx {
  p2pConnections: Map<string, RTCPeerConnection>;
  pendingCandidates: Map<string, RTCIceCandidateInit[]>;
  registry: PeerAudioRegistry;
}

export function teardownPeerMedia(peerId: string, ctx: PeerTeardownCtx) {
  const pc = ctx.p2pConnections.get(peerId);
  if (pc) {
    pc.close();
    ctx.p2pConnections.delete(peerId);
  }
  ctx.pendingCandidates.delete(peerId);
  ctx.registry.removePeerAudio(peerId);
}
