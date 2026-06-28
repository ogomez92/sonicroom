import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Device } from "mediasoup-client";
import type { Transport } from "mediasoup-client/types";
import {
  computeEffectiveGain,
  DUCK_FACTOR,
  PeerAudioRegistry,
  type Emit,
  type PeerGainInputs,
} from "./peer-audio-registry";
import { useRoomStore } from "../../stores/room";
import { FakeDevice, type FakeTransport, resetMediasoupMock } from "../../test/mediasoup-mock";

// The composed gain: per-peer volume × deafen × listener-side local mute ×
// music auto-ducking. These cases pin the exact precedence the hook relies on
// (the characterization suite only observes the resulting gainNode value).
describe("computeEffectiveGain", () => {
  const voice: PeerGainInputs = { volume: 1, isMusic: false, localMuted: false };
  const music: PeerGainInputs = { volume: 1, isMusic: true, localMuted: false };
  const quiet = { isDeafened: false, duckingEnabled: true, isVoiceActive: false };

  it("returns 0 for an unknown peer", () => {
    expect(computeEffectiveGain(undefined, quiet)).toBe(0);
  });

  it("returns 0 when deafened, regardless of peer", () => {
    expect(computeEffectiveGain(voice, { ...quiet, isDeafened: true })).toBe(0);
    expect(computeEffectiveGain(music, { ...quiet, isDeafened: true, isVoiceActive: true })).toBe(
      0,
    );
  });

  it("returns 0 when the listener locally muted this peer", () => {
    expect(computeEffectiveGain({ ...voice, localMuted: true }, quiet)).toBe(0);
  });

  it("passes a voice peer through at its raw volume", () => {
    expect(computeEffectiveGain({ ...voice, volume: 2 }, quiet)).toBe(2);
  });

  it("ducks a music peer to volume × DUCK_FACTOR while a voice is active", () => {
    expect(computeEffectiveGain(music, { ...quiet, isVoiceActive: true })).toBeCloseTo(
      DUCK_FACTOR,
      5,
    );
    expect(
      computeEffectiveGain({ ...music, volume: 2 }, { ...quiet, isVoiceActive: true }),
    ).toBeCloseTo(2 * DUCK_FACTOR, 5);
  });

  it("does not duck a music peer when no voice is active", () => {
    expect(computeEffectiveGain(music, { ...quiet, isVoiceActive: false })).toBe(1);
  });

  it("does not duck when the room ducking toggle is off, even with a voice active", () => {
    expect(
      computeEffectiveGain(music, {
        isDeafened: false,
        duckingEnabled: false,
        isVoiceActive: true,
      }),
    ).toBe(1);
  });

  it("never ducks a voice peer", () => {
    expect(computeEffectiveGain(voice, { ...quiet, isVoiceActive: true })).toBe(1);
  });

  it("deafen/local-mute take precedence over the duck branch", () => {
    expect(
      computeEffectiveGain({ ...music, localMuted: true }, { ...quiet, isVoiceActive: true }),
    ).toBe(0);
  });
});

// Drive the registry directly with the same mediasoup fakes the hook test uses
// (no renderHook). The setup file installs the Web Audio / Audio fakes globally.
describe("PeerAudioRegistry — consume + pending queue", () => {
  beforeEach(() => {
    resetMediasoupMock();
    useRoomStore.getState().reset();
  });

  // A live SFU device + recv transport, supplied lazily so a test can start with
  // them absent (consume queues) and wire them in before draining.
  function makeRegistry() {
    let device: FakeDevice | null = null;
    let recv: FakeTransport | null = null;
    const emit = vi.fn().mockResolvedValue({
      ok: true,
      consumerId: "consumer-x",
      producerId: "prod-x",
      kind: "audio",
      rtpParameters: {},
    }) as unknown as Emit;
    const reg = new PeerAudioRegistry(new AudioContext(), useRoomStore, emit, {
      getDevice: () => device as unknown as Device | null,
      getRecvTransport: () => recv as unknown as Transport | null,
    });
    const wireSfu = () => {
      device = new FakeDevice();
      recv = device.createRecvTransport({});
      return recv;
    };
    return { reg, emit, wireSfu };
  }

  it("queues a producer while the SFU isn't ready, then consumes it on drainPending", async () => {
    const { reg, emit, wireSfu } = makeRegistry();

    // No device/recvTransport yet → the consume is parked, nothing emitted.
    await reg.consumeProducer("peer-a", "prod-a", "voice");
    expect(emit).not.toHaveBeenCalled();
    expect(reg.peerAudios.size).toBe(0);

    // Transports come up; draining consumes the parked producer once.
    const recv = wireSfu();
    await reg.drainPending();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(recv.consumers).toHaveLength(1);
    expect(reg.peerAudios.has("peer-a")).toBe(true); // voice is keyed by peerId
  });

  it("renders a share producer as its own music tile keyed by producerId", async () => {
    const { reg, wireSfu } = makeRegistry();
    wireSfu();
    useRoomStore.getState().addPeer("peer-b", "Bob");

    await reg.consumeProducer("peer-b", "share-1", "share", "System Audio");

    expect(reg.peerAudios.has("share-1")).toBe(true);
    expect(useRoomStore.getState().peers.get("share-1")?.isMusic).toBe(true);
    expect(reg.streamOwner("share-1")).toEqual({ ownerId: "peer-b", kind: "share" });

    // Tearing it down drops the tile, the owner mapping, and the store peer.
    reg.removeShareStream("share-1");
    expect(reg.peerAudios.has("share-1")).toBe(false);
    expect(reg.streamOwner("share-1")).toBeUndefined();
    expect(useRoomStore.getState().peers.has("share-1")).toBe(false);
  });

  it("flags an incoming mic producer as a non-ducked mic tile (not isMusic)", async () => {
    const { reg, wireSfu } = makeRegistry();
    wireSfu();
    useRoomStore.getState().addPeer("peer-c", "Cara");

    await reg.consumeProducer("peer-c", "mic-1", "mic", "Virtual Cable");

    const tile = useRoomStore.getState().peers.get("mic-1");
    expect(tile?.isMicStream).toBe(true);
    expect(tile?.isMusic).toBe(false);
    expect(reg.streamOwner("mic-1")).toEqual({ ownerId: "peer-c", kind: "mic" });
  });
});
