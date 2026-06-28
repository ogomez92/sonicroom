import { describe, it, expect, vi } from "vitest";
import { teardownPeerMedia } from "./peer-teardown";
import type { PeerAudioRegistry } from "../audio/peer-audio-registry";

function fakeRegistry() {
  return { removePeerAudio: vi.fn() } as unknown as PeerAudioRegistry & {
    removePeerAudio: ReturnType<typeof vi.fn>;
  };
}

describe("teardownPeerMedia", () => {
  it("closes the peer's P2P connection and drops it from both maps", () => {
    const close = vi.fn();
    const p2pConnections = new Map<string, RTCPeerConnection>([
      ["bob", { close } as unknown as RTCPeerConnection],
    ]);
    const pendingCandidates = new Map<string, RTCIceCandidateInit[]>([["bob", [{}]]]);
    const registry = fakeRegistry();

    teardownPeerMedia("bob", { p2pConnections, pendingCandidates, registry });

    expect(close).toHaveBeenCalledOnce();
    expect(p2pConnections.has("bob")).toBe(false);
    expect(pendingCandidates.has("bob")).toBe(false);
    expect(registry.removePeerAudio).toHaveBeenCalledWith("bob");
  });

  it("is a no-op on the P2P maps when there is no mesh connection (SFU room)", () => {
    const registry = fakeRegistry();
    const p2pConnections = new Map<string, RTCPeerConnection>();
    const pendingCandidates = new Map<string, RTCIceCandidateInit[]>();

    // Must not throw, and still tears down the peer's audio.
    teardownPeerMedia("carol", { p2pConnections, pendingCandidates, registry });

    expect(registry.removePeerAudio).toHaveBeenCalledWith("carol");
  });
});
