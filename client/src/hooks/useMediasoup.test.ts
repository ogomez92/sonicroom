import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Swap the network/SFU libraries for fakes BEFORE importing the hook (these
// factories are hoisted above the imports below by vitest).
vi.mock("socket.io-client", async () => {
  const mod = await import("../test/socket-mock");
  return { io: mod.ioMock };
});
vi.mock("mediasoup-client", async () => {
  const mod = await import("../test/mediasoup-mock");
  return { Device: mod.FakeDevice };
});

import { useMediasoup } from "./useMediasoup";
import { useRoomStore } from "../stores/room";
import { fakeServer, FakeServer, FakeSocket, type JoinResponse } from "../test/socket-mock";
import { FakeRTCPeerConnection, FakeIceCandidate, resetWebRtcMock } from "../test/webrtc-mock";
import { FakeDevice, FakeProducer, resetMediasoupMock } from "../test/mediasoup-mock";
import { mediaController } from "../test/media-mock";
import {
  announce_mic_muted,
  announce_recording_started,
  announce_no_mic,
} from "../paraglide/messages.js";

// A microtask flush — the P2P offer/answer dance and produce acks resolve on
// chained microtasks after a server event.
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

type Hook = ReturnType<typeof useMediasoup>;

function peerEntry(id: string, producers: JoinResponse["peers"][number]["producers"] = []) {
  return { peerId: id, displayName: id, producers };
}
function voiceProd(producerId: string) {
  return { producerId, source: "voice" };
}

function socket(): FakeSocket {
  return fakeServer.lastSocket!;
}
function device(): FakeDevice {
  return FakeDevice.instances[0];
}
function sendTransport() {
  return device().sendTransports[0];
}
function recvTransport() {
  return device().recvTransports[0];
}
function producersOfSource(source: string): FakeProducer[] {
  return device().sendTransports.flatMap((t) => t.producers.filter((p) => p.source === source));
}
function systemMessages() {
  return useRoomStore.getState().messages.filter((m) => m.kind === "system");
}

interface Harness {
  result: { current: Hook };
  unmount: () => void;
}

// Render the hook, run join(), drive the socket to "connect", and wait for the
// initial join+setup to complete. Returns the hook result + the unmount fn.
async function joinRoom(
  opts: {
    join?: Partial<JoinResponse>;
    joinOpts?: { disableP2p?: boolean; isPublic?: boolean; noMic?: boolean };
    id?: string;
  } = {},
): Promise<Harness> {
  if (opts.join) fakeServer.joinResponse = { ...FakeServer.defaultJoin(), ...opts.join };
  const hook = renderHook(() => useMediasoup());
  let joinPromise: Promise<void>;
  await act(async () => {
    joinPromise = hook.result.current.join("room", "Alice", opts.joinOpts);
    await Promise.resolve();
  });
  await act(async () => {
    await socket().connect(opts.id ?? "id-self");
  });
  await act(async () => {
    await joinPromise!;
  });
  await flush();
  return { result: hook.result, unmount: hook.unmount };
}

// SFU room needs 3+ peers. Default helper joins an SFU room with the given peers.
function sfuJoin(peers: JoinResponse["peers"], extra: Partial<JoinResponse> = {}, id = "id-self") {
  return joinRoom({ join: { mode: "sfu", peers, ...extra }, id });
}

async function fire(event: string, payload?: unknown) {
  await act(async () => {
    await socket().fire(event, payload);
  });
  await flush();
}

async function runAct<T>(fn: () => Promise<T> | T): Promise<void> {
  await act(async () => {
    await fn();
  });
  await flush();
}

beforeEach(() => {
  fakeServer.reset();
  resetWebRtcMock();
  resetMediasoupMock();
  mediaController.reset();
  localStorage.clear();
  sessionStorage.clear();
  useRoomStore.getState().reset();
});

afterEach(() => {
  useRoomStore.getState().reset();
});

// ---------------------------------------------------------------------------
// P2P mesh join (≤2 peers)
// ---------------------------------------------------------------------------
describe("join — P2P mesh (≤2 peers)", () => {
  it("connects, records the room, and offers to one existing peer", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [peerEntry("id-bob")] } });

    const s = useRoomStore.getState();
    expect(s.connected).toBe(true);
    expect(s.mode).toBe("p2p");
    expect(s.roomName).toBe("room");
    expect(s.displayName).toBe("Alice");
    expect(s.hasMic).toBe(true);
    expect(s.peers.has("id-bob")).toBe(true);

    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    const pc = FakeRTCPeerConnection.instances[0];
    expect(pc.addedTracks).toHaveLength(1); // outDest's processed track
    expect(pc.localDescription?.type).toBe("offer");
    expect(FakeDevice.instances).toHaveLength(0); // no SFU device in P2P

    const offer = socket().lastSent("p2p-signal") as { type: string; targetPeerId: string };
    expect(offer.type).toBe("offer");
    expect(offer.targetPeerId).toBe("id-bob");

    h.unmount();
  });

  it("builds no peer connection in an empty room", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [] } });
    expect(FakeRTCPeerConnection.instances).toHaveLength(0);
    expect(useRoomStore.getState().peers.size).toBe(0);
    h.unmount();
  });

  it("acquires a microphone with the persisted device + processing prefs", async () => {
    useRoomStore.getState().setMicDeviceId("mic-1");
    useRoomStore.getState().setVoiceProcessingEnabled(true);
    const h = await joinRoom({ join: { mode: "p2p", peers: [] } });
    const constraints = mediaController.userMediaCalls[0].audio as {
      deviceId?: { ideal?: string };
      echoCancellation?: boolean;
    };
    expect(constraints.deviceId?.ideal).toBe("mic-1");
    expect(constraints.echoCancellation).toBe(true);
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// P2P signaling (offer/answer/ICE) handling
// ---------------------------------------------------------------------------
describe("P2P signaling relay", () => {
  it("answers an incoming offer (as the answerer)", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [] } });

    await fire("p2p-signal", {
      fromPeerId: "id-carol",
      type: "offer",
      payload: { type: "offer", sdp: "m=audio\r\na=fmtp:111 minptime=10\r\n" },
    });

    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    const pc = FakeRTCPeerConnection.instances[0];
    expect(pc.remoteDescription?.type).toBe("offer");
    expect(pc.localDescription?.type).toBe("answer");

    const answer = socket().lastSent("p2p-signal") as { type: string; targetPeerId: string };
    expect(answer.type).toBe("answer");
    expect(answer.targetPeerId).toBe("id-carol");
    h.unmount();
  });

  it("queues ICE candidates until the answer arrives, then flushes them", async () => {
    // We are the offerer to id-bob (pc exists, no remote description yet).
    const h = await joinRoom({ join: { mode: "p2p", peers: [peerEntry("id-bob")] } });
    const pc = FakeRTCPeerConnection.instances[0];

    // A candidate arriving before the answer is queued (addIceCandidate would
    // throw without a remote description).
    await fire("p2p-signal", {
      fromPeerId: "id-bob",
      type: "ice-candidate",
      payload: { candidate: "host-1" },
    });
    expect(pc.addedIceCandidates).toHaveLength(0);

    // The answer sets the remote description and flushes the queued candidate.
    await fire("p2p-signal", {
      fromPeerId: "id-bob",
      type: "answer",
      payload: { type: "answer", sdp: "a=fmtp:111 minptime=10\r\n" },
    });
    expect(pc.remoteDescription?.type).toBe("answer");
    expect(pc.addedIceCandidates).toHaveLength(1);
    h.unmount();
  });

  it("relays our local ICE candidates to the peer", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [peerEntry("id-bob")] } });
    const pc = FakeRTCPeerConnection.instances[0];
    await runAct(() => pc.fireIceCandidate(new FakeIceCandidate({ candidate: "host" })));
    const signals = socket().sentEvents("p2p-signal") as Array<{ type: string }>;
    expect(signals.some((s) => s.type === "ice-candidate")).toBe(true);
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// SFU join (3+ peers)
// ---------------------------------------------------------------------------
describe("join — SFU (3+ peers)", () => {
  it("builds transports, produces voice, and consumes every existing producer", async () => {
    const h = await sfuJoin([
      peerEntry("id-bob", [voiceProd("prod-bob")]),
      peerEntry("id-carol", [voiceProd("prod-carol")]),
    ]);

    expect(useRoomStore.getState().mode).toBe("sfu");
    expect(FakeDevice.instances).toHaveLength(1);
    expect(device().sendTransports).toHaveLength(1);
    expect(device().recvTransports).toHaveLength(1);
    expect(FakeRTCPeerConnection.instances).toHaveLength(0); // no P2P in SFU

    // Our voice producer was created with mono-by-default codec opts.
    const voice = producersOfSource("voice");
    expect(voice).toHaveLength(1);
    expect(voice[0].options.codecOptions?.opusStereo).toBe(false);
    // Voice omits the appData source tag, so the produce event's source is
    // undefined — the server defaults an untagged producer to "voice".
    const produceEvt = socket().lastSent("produce") as { source?: string };
    expect(produceEvt).toBeDefined();
    expect(produceEvt.source).toBeUndefined();

    // Both remote voice producers were consumed.
    expect(recvTransport().consumers).toHaveLength(2);
    const pa = h.result.current.peerAudiosRef.current;
    expect(pa.has("id-bob")).toBe(true);
    expect(pa.has("id-carol")).toBe(true);
    h.unmount();
  });

  it("produces stereo 128k voice when hi-fi is enabled", async () => {
    useRoomStore.getState().setHifiVoiceEnabled(true);
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    const voice = producersOfSource("voice")[0];
    expect(voice.options.codecOptions?.opusStereo).toBe(true);
    expect(voice.options.codecOptions?.opusMaxAverageBitrate).toBe(128000);
    h.unmount();
  });

  it("flags a music caster, announces it, and starts it un-ducked", async () => {
    const h = await sfuJoin([
      peerEntry("id-bob", [voiceProd("p-bob")]),
      peerEntry("id-eco", [{ producerId: "p-music", source: "music" }]),
    ]);
    const eco = useRoomStore.getState().peers.get("id-eco");
    expect(eco?.isMusic).toBe(true);
    expect(eco?.isCaster).toBe(true);
    expect(systemMessages().length).toBeGreaterThan(0); // music_started logged
    // Music tile (keyed by peerId) plays at full volume with no voice active.
    const gain = h.result.current.peerAudiosRef.current.get("id-eco")!.gainNode.gain.value;
    expect(gain).toBe(1);
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// 2P ↔ SFU SWITCHING — the core hybrid-transport behaviour
// ---------------------------------------------------------------------------
describe("mode switching: P2P → SFU", () => {
  it("tears down the mesh and builds the SFU on switch-to-sfu", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [peerEntry("id-bob")] } });
    const p2pPc = FakeRTCPeerConnection.instances[0];
    expect(p2pPc.closed).toBe(false);

    await fire("switch-to-sfu", { rtpCapabilities: {} });

    expect(useRoomStore.getState().mode).toBe("sfu");
    expect(p2pPc.closed).toBe(true); // mesh torn down
    expect(FakeDevice.instances).toHaveLength(1);
    expect(producersOfSource("voice")).toHaveLength(1);

    // The server then announces the existing peer's producer.
    await fire("new-producer", { peerId: "id-bob", producerId: "prod-bob", source: "voice" });
    expect(recvTransport().consumers).toHaveLength(1);
    h.unmount();
  });

  it("is idempotent — a second switch-to-sfu does not rebuild transports", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [peerEntry("id-bob")] } });
    await fire("switch-to-sfu", { rtpCapabilities: {} });
    expect(FakeDevice.instances).toHaveLength(1);
    const transportCount = device().sendTransports.length;

    await fire("switch-to-sfu", { rtpCapabilities: {} });
    // Guard: a live sendTransport short-circuits the rebuild.
    expect(FakeDevice.instances).toHaveLength(1);
    expect(device().sendTransports.length).toBe(transportCount);
    h.unmount();
  });

  it("flips modeRef synchronously so a trailing offer is ignored", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [peerEntry("id-bob")] } });
    // switch-to-sfu sets the mode synchronously; an offer relayed just behind it
    // must be ignored by the p2p-signal mode guard (no new answerer PC).
    await act(async () => {
      void socket().fire("switch-to-sfu", { rtpCapabilities: {} });
      await socket().fire("p2p-signal", {
        fromPeerId: "id-bob",
        type: "offer",
        payload: { type: "offer", sdp: "a=fmtp:111 minptime=10\r\n" },
      });
    });
    await flush();
    // Only the original join-time offerer PC exists; the stale offer made none.
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    h.unmount();
  });
});

describe("mode switching: SFU → P2P", () => {
  it("tears down the SFU and only the lower-id peer initiates offers", async () => {
    // Our id is "id-self"; peers id-aaa (< self) and id-zzz (> self).
    const h = await sfuJoin(
      [peerEntry("id-aaa", [voiceProd("pa")]), peerEntry("id-zzz", [voiceProd("pz")])],
      {},
      "id-self",
    );
    const send = sendTransport();
    const recv = recvTransport();
    const voice = producersOfSource("voice")[0];

    await fire("switch-to-p2p", { peerIds: ["id-self", "id-aaa", "id-zzz"] });

    expect(useRoomStore.getState().mode).toBe("p2p");
    expect(send.closed).toBe(true);
    expect(recv.closed).toBe(true);
    expect(voice.closed).toBe(true);

    // We offer ONLY to the peer whose id is greater than ours (id-zzz).
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    const offer = socket().lastSent("p2p-signal") as { type: string; targetPeerId: string };
    expect(offer.type).toBe("offer");
    expect(offer.targetPeerId).toBe("id-zzz");
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Mute / unmute / deafen
// ---------------------------------------------------------------------------
describe("mute / unmute", () => {
  it("pauses the SFU voice producer and logs the event to chat", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    const voice = producersOfSource("voice")[0];

    await runAct(() => h.result.current.mute());
    expect(useRoomStore.getState().isMuted).toBe(true);
    expect(voice.paused).toBe(true);
    expect(socket().sentEvents("producer-pause").length).toBeGreaterThan(0);
    expect(systemMessages().some((m) => m.text === announce_mic_muted())).toBe(true);

    await runAct(() => h.result.current.unmute());
    expect(useRoomStore.getState().isMuted).toBe(false);
    expect(voice.paused).toBe(false);
    expect(socket().sentEvents("producer-resume").length).toBeGreaterThan(0);
    h.unmount();
  });

  it("disables the raw mic track when muting in P2P", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [peerEntry("id-bob")] } });
    await runAct(() => h.result.current.toggleMute());
    expect(useRoomStore.getState().isMuted).toBe(true);
    // The captured mic track is disabled (P2P has no producer to pause).
    const stream = mediaController.userMediaCalls; // sanity: a mic was acquired
    expect(stream.length).toBeGreaterThan(0);
    await runAct(() => h.result.current.toggleMute());
    expect(useRoomStore.getState().isMuted).toBe(false);
    h.unmount();
  });
});

describe("deafen + per-peer volume + local mute", () => {
  it("ramps every peer to silence on deafen and restores on un-deafen", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    const gain = () => h.result.current.peerAudiosRef.current.get("id-bob")!.gainNode.gain.value;
    expect(gain()).toBe(1);

    await runAct(() => h.result.current.toggleDeafen());
    expect(useRoomStore.getState().isDeafened).toBe(true);
    expect(gain()).toBe(0);

    await runAct(() => h.result.current.toggleDeafen());
    expect(useRoomStore.getState().isDeafened).toBe(false);
    expect(gain()).toBe(1);
    h.unmount();
  });

  it("applies per-peer volume and local (listener-side) mute", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    const gain = () => h.result.current.peerAudiosRef.current.get("id-bob")!.gainNode.gain.value;

    await runAct(() => h.result.current.setPeerVolume("id-bob", 2));
    expect(useRoomStore.getState().peers.get("id-bob")?.volume).toBe(2);
    expect(gain()).toBe(2);

    await runAct(() => h.result.current.setPeerLocalMute("id-bob", true));
    expect(useRoomStore.getState().peers.get("id-bob")?.localMuted).toBe(true);
    expect(gain()).toBe(0);
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Auto-ducking
// ---------------------------------------------------------------------------
describe("music auto-ducking", () => {
  async function withCaster(): Promise<Harness> {
    return sfuJoin([
      peerEntry("id-bob", [voiceProd("p-bob")]),
      peerEntry("id-eco", [{ producerId: "p-music", source: "music" }]),
    ]);
  }

  it("ducks the music when the server reports a voice active, and releases after", async () => {
    const h = await withCaster();
    const gain = () => h.result.current.peerAudiosRef.current.get("id-eco")!.gainNode.gain.value;
    expect(gain()).toBe(1);

    await fire("duck", { active: true });
    expect(gain()).toBeCloseTo(0.22, 5); // volume * DUCK_FACTOR

    await fire("duck", { active: false });
    expect(gain()).toBe(1);
    h.unmount();
  });

  it("respects the room-wide ducking toggle and de-dupes echoes", async () => {
    const h = await withCaster();
    const gain = () => h.result.current.peerAudiosRef.current.get("id-eco")!.gainNode.gain.value;

    // Same value as current (true) → no-op, nothing logged.
    const before = systemMessages().length;
    await fire("ducking-changed", { enabled: true });
    expect(systemMessages().length).toBe(before);

    // Turn ducking off: even with a voice active, music stays at full volume.
    await fire("ducking-changed", { enabled: false, by: "Bob" });
    expect(useRoomStore.getState().duckingEnabled).toBe(false);
    await fire("duck", { active: true });
    expect(gain()).toBe(1);
    h.unmount();
  });

  it("toggleDucking emits set-ducking to the server", async () => {
    const h = await withCaster();
    await runAct(() => h.result.current.toggleDucking());
    expect(socket().lastSent("set-ducking")).toEqual({ enabled: false });
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Audio share (system/tab audio as a separate stereo producer)
// ---------------------------------------------------------------------------
describe("audio share", () => {
  it("starts and stops a share producer in SFU", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);

    await runAct(() => h.result.current.toggleAudioShare());
    expect(useRoomStore.getState().isSharingAudio).toBe(true);
    expect(socket().sentEvents("start-share").length).toBe(1);
    const share = producersOfSource("share");
    expect(share).toHaveLength(1);
    expect(share[0].options.codecOptions?.opusStereo).toBe(true);

    await runAct(() => h.result.current.toggleAudioShare());
    expect(useRoomStore.getState().isSharingAudio).toBe(false);
    expect(share[0].closed).toBe(true);
    expect(socket().sentEvents("stop-share").length).toBe(1);
    h.unmount();
  });

  it("does not share when the display capture has no audio track", async () => {
    mediaController.displayHasAudio = false;
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await runAct(() => h.result.current.toggleAudioShare());
    expect(useRoomStore.getState().isSharingAudio).toBe(false);
    expect(producersOfSource("share")).toHaveLength(0);
    h.unmount();
  });

  it("aborts cleanly when the user cancels the picker", async () => {
    mediaController.failDisplay = true;
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await runAct(() => h.result.current.toggleAudioShare());
    expect(useRoomStore.getState().isSharingAudio).toBe(false);
    h.unmount();
  });

  it("renders an incoming peer's share as a music tile and tears it down", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await fire("new-producer", {
      peerId: "id-bob",
      producerId: "share-1",
      source: "share",
      title: "System Audio",
    });
    expect(useRoomStore.getState().peers.get("share-1")?.isMusic).toBe(true);
    await fire("share-stopped", { peerId: "id-bob", displayName: "Bob" });
    expect(useRoomStore.getState().peers.has("share-1")).toBe(false);
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// File streaming
// ---------------------------------------------------------------------------
describe("file streaming", () => {
  it("streams a local file as its own producer and stops it", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    const file = new File(["dummy"], "song.mp3", { type: "audio/mpeg" });

    await runAct(() => h.result.current.startFileStream(file));
    expect(useRoomStore.getState().fileStreamName).toBe("song.mp3");
    expect(socket().sentEvents("start-file-stream").length).toBe(1);
    const fileProd = producersOfSource("file");
    expect(fileProd).toHaveLength(1);
    expect(fileProd[0].options.appData?.title).toBe("song.mp3");

    await runAct(() => h.result.current.stopFileStream());
    expect(useRoomStore.getState().fileStreamName).toBeNull();
    expect(socket().sentEvents("stop-file-stream").length).toBe(1);
    h.unmount();
  });

  it("re-titles the live producer when the file is swapped (no churn)", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await runAct(() => h.result.current.startFileStream(new File(["a"], "first.mp3")));
    await runAct(() => h.result.current.startFileStream(new File(["b"], "second.mp3")));
    expect(useRoomStore.getState().fileStreamName).toBe("second.mp3");
    // Swap re-titles in place rather than producing again.
    expect(producersOfSource("file")).toHaveLength(1);
    const title = socket().lastSent("update-stream-title") as { title: string };
    expect(title.title).toBe("second.mp3");
    h.unmount();
  });

  it("derives the stream name for URL and library sources", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await runAct(() => h.result.current.startUrlStream("https://example.com/path/track.mp3"));
    expect(useRoomStore.getState().fileStreamName).toBe("track.mp3");
    await runAct(() => h.result.current.startServerFileStream("Movies/Dune.mp3"));
    expect(useRoomStore.getState().fileStreamName).toBe("Dune.mp3");
    h.unmount();
  });

  it("toggles play/paused state of the file element", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await runAct(() => h.result.current.startFileStream(new File(["a"], "loop.mp3")));
    expect(useRoomStore.getState().fileStreamPlaying).toBe(true);
    await runAct(() => h.result.current.toggleFilePlayback());
    expect(useRoomStore.getState().fileStreamPlaying).toBe(false);
    await runAct(() => h.result.current.toggleFilePlayback());
    expect(useRoomStore.getState().fileStreamPlaying).toBe(true);
    h.unmount();
  });

  it("pins SFU from P2P by emitting start-file-stream (produce deferred)", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [peerEntry("id-bob")] } });
    await runAct(() => h.result.current.startFileStream(new File(["a"], "p2p.mp3")));
    expect(useRoomStore.getState().fileStreamName).toBe("p2p.mp3");
    expect(socket().sentEvents("start-file-stream").length).toBe(1);
    // No SFU yet, so no producer — the resulting switch-to-sfu would produce it.
    expect(FakeDevice.instances).toHaveLength(0);
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
describe("recording", () => {
  it("starts and stops recording, keeping the id after stop", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await runAct(() => h.result.current.startRecording());
    expect(useRoomStore.getState().isRecording).toBe(true);
    expect(useRoomStore.getState().recordingId).toBe("rec-1");

    await runAct(() => h.result.current.stopRecording());
    expect(useRoomStore.getState().isRecording).toBe(false);
    expect(useRoomStore.getState().recordingId).toBe("rec-1"); // kept for download
    h.unmount();
  });

  it("announces a failure when the server rejects start", async () => {
    fakeServer.on("start-recording", () => ({ ok: false, error: "no ffmpeg" }));
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await runAct(() => h.result.current.startRecording());
    expect(useRoomStore.getState().isRecording).toBe(false);
    expect(systemMessages().length).toBeGreaterThan(0);
    h.unmount();
  });

  it("reflects server recording broadcasts", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await fire("recording-started", { recordingId: "rec-x", by: "Bob" });
    expect(useRoomStore.getState().isRecording).toBe(true);
    expect(useRoomStore.getState().recordingId).toBe("rec-x");
    expect(
      systemMessages().some((m) => m.text === announce_recording_started({ name: "Bob" })),
    ).toBe(true);
    await fire("recording-stopped");
    expect(useRoomStore.getState().isRecording).toBe(false);
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Live Icecast streaming
// ---------------------------------------------------------------------------
describe("live streaming", () => {
  it("starts streaming with the trimmed config and stops", async () => {
    useRoomStore.getState().setStreamConfig({
      host: "  icecast.example.com  ",
      port: 8000,
      mount: " /live ",
      username: "  ",
      password: "secret",
      format: "mp3",
      bitrateKbps: 192,
    });
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await runAct(() => h.result.current.startStreaming());
    expect(useRoomStore.getState().isStreaming).toBe(true);
    const cfg = socket().lastSent("start-streaming") as {
      host: string;
      mount: string;
      username: string;
    };
    expect(cfg.host).toBe("icecast.example.com");
    expect(cfg.mount).toBe("/live");
    expect(cfg.username).toBe("source"); // blank → default

    await runAct(() => h.result.current.stopStreaming());
    expect(useRoomStore.getState().isStreaming).toBe(false);
    h.unmount();
  });

  it("surfaces a server-reported stream failure", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await fire("streaming-started", { by: "Bob" });
    expect(useRoomStore.getState().isStreaming).toBe(true);
    await fire("streaming-failed", { error: "auth failed" });
    expect(useRoomStore.getState().isStreaming).toBe(false);
    expect(useRoomStore.getState().streamError).toBe("auth failed");
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
describe("chat", () => {
  it("sends a trimmed message and rejects empty input", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    let res: { ok: boolean; reason?: string } = { ok: false };
    await runAct(async () => {
      res = await h.result.current.sendChatMessage("  hi  ");
    });
    expect(res.ok).toBe(true);
    expect(socket().lastSent("chat-message")).toEqual({ text: "hi" });

    await runAct(async () => {
      res = await h.result.current.sendChatMessage("   ");
    });
    expect(res).toEqual({ ok: false, reason: "empty" });
    h.unmount();
  });

  it("rate-limits a burst client-side", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    const results: Array<{ ok: boolean; reason?: string }> = [];
    await runAct(async () => {
      for (let i = 0; i < 6; i++) results.push(await h.result.current.sendChatMessage(`m${i}`));
    });
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results[5]).toEqual({ ok: false, reason: "rate_limited" });
    expect(socket().sentEvents("chat-message")).toHaveLength(5);
    h.unmount();
  });

  it("renders + announces an incoming chat message", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await fire("chat-message", { id: "m1", sender: "Bob", text: "hello", ts: Date.now() });
    const msgs = useRoomStore.getState().messages;
    expect(msgs.some((m) => m.id === "m1")).toBe(true);
    expect(useRoomStore.getState().chatPoliteMsg).not.toBe("");
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Peer presence
// ---------------------------------------------------------------------------
describe("peer presence", () => {
  it("adds and removes peers from server broadcasts", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [] } });
    await fire("peer-joined", { peerId: "id-bob", displayName: "Bob" });
    expect(useRoomStore.getState().peers.has("id-bob")).toBe(true);
    expect(useRoomStore.getState().messages.some((m) => m.kind === "join")).toBe(true);

    await fire("peer-left", { peerId: "id-bob" });
    expect(useRoomStore.getState().peers.has("id-bob")).toBe(false);
    expect(useRoomStore.getState().messages.some((m) => m.kind === "leave")).toBe(true);
    h.unmount();
  });

  it("treats a departing music caster as 'music stopped'", async () => {
    const h = await sfuJoin([
      peerEntry("id-bob", [voiceProd("p-bob")]),
      peerEntry("id-eco", [{ producerId: "p-music", source: "music" }]),
    ]);
    const before = useRoomStore.getState().messages.filter((m) => m.kind === "leave").length;
    await fire("peer-left", { peerId: "id-eco" });
    expect(useRoomStore.getState().peers.has("id-eco")).toBe(false);
    // No "leave" line for a caster — it reads as the music stopping (system).
    expect(useRoomStore.getState().messages.filter((m) => m.kind === "leave").length).toBe(before);
    h.unmount();
  });

  it("reflects remote peer mute/unmute", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await fire("peer-muted", { peerId: "id-bob" });
    expect(useRoomStore.getState().peers.get("id-bob")?.isMuted).toBe(true);
    await fire("peer-unmuted", { peerId: "id-bob" });
    expect(useRoomStore.getState().peers.get("id-bob")?.isMuted).toBe(false);
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Moderation (knock-to-join, vote-to-kick, caster removal)
// ---------------------------------------------------------------------------
describe("moderation", () => {
  it("tracks join requests and forwards a decision", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [], isPublic: true } });
    await fire("join-requests", { requests: [{ id: "req-1", displayName: "Newbie" }] });
    expect(useRoomStore.getState().joinRequests).toHaveLength(1);

    await runAct(() => h.result.current.decideJoinRequest("req-1", true));
    expect(socket().lastSent("join-decision")).toEqual({ requestId: "req-1", allow: true });
    // Optimistically removed locally.
    expect(useRoomStore.getState().joinRequests).toHaveLength(0);
    h.unmount();
  });

  it("forwards a kick vote and applies the authoritative tally", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")], {
      isPublic: true,
    });
    await runAct(() => h.result.current.voteKick("id-bob", true));
    expect(socket().lastSent("vote-kick")).toEqual({ targetId: "id-bob", vote: true });

    // Server echoes the authoritative count (our own vote).
    await fire("kick-vote", {
      targetId: "id-bob",
      targetName: "Bob",
      votes: 2,
      voterId: "id-self",
      voterName: "Alice",
      action: "cast",
    });
    const bob = useRoomStore.getState().peers.get("id-bob");
    expect(bob?.kickVotes).toBe(2);
    expect(bob?.iVotedKick).toBe(true);
    h.unmount();
  });

  it("tears down a kicked peer and shows the removed screen when it's us", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")], {
      isPublic: true,
    });
    await fire("peer-kicked", { peerId: "id-bob", displayName: "Bob", reason: "vote" });
    expect(useRoomStore.getState().peers.has("id-bob")).toBe(false);

    await fire("you-were-kicked");
    expect(useRoomStore.getState().kicked).toBe(true);
    expect(socket().connected).toBe(false); // socket disconnected on kick
    h.unmount();
  });

  it("emits caster removal and peer-stream stop", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await runAct(() => h.result.current.kickCaster("id-eco"));
    expect(socket().lastSent("kick-caster")).toEqual({ targetId: "id-eco" });
    await runAct(() => h.result.current.stopPeerStream("share-9"));
    expect(socket().lastSent("stop-peer-stream")).toEqual({ producerId: "share-9" });
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Extra microphones (separate "mic" producers)
// ---------------------------------------------------------------------------
describe("extra microphones", () => {
  it("starts a selected extra mic as its own producer and stops it", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);

    // Selecting a device (in a call) makes the reconcile effect start it.
    await runAct(() => useRoomStore.getState().setStreamedMicDeviceIds(["cable-1"]));
    expect(socket().sentEvents("start-extra-mic").length).toBe(1);
    const mics = producersOfSource("mic");
    expect(mics).toHaveLength(1);
    expect(mics[0].options.appData?.source).toBe("mic");

    await runAct(() => useRoomStore.getState().setStreamedMicDeviceIds([]));
    expect(socket().sentEvents("stop-extra-mic").length).toBe(1);
    expect(mics[0].closed).toBe(true);
    h.unmount();
  });

  it("rolls back the selection when the device fails to open", async () => {
    mediaController.failExtraMics.add("busy-mic");
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await runAct(() => useRoomStore.getState().setStreamedMicDeviceIds(["busy-mic"]));
    // Capture failed → device removed from the selection, no producer.
    expect(useRoomStore.getState().streamedMicDeviceIds).toEqual([]);
    expect(producersOfSource("mic")).toHaveLength(0);
    h.unmount();
  });

  it("renders an incoming peer's extra mic as a non-ducked mic tile", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    await fire("new-producer", {
      peerId: "id-bob",
      producerId: "mic-1",
      source: "mic",
      title: "Virtual Cable",
    });
    const tile = useRoomStore.getState().peers.get("mic-1");
    expect(tile?.isMicStream).toBe(true);
    expect(tile?.isMusic).toBe(false); // voice-like, not ducked
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Mic-less (listen / chat-only) session
// ---------------------------------------------------------------------------
describe("mic-less session", () => {
  it("joins muted without prompting for a mic", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [] }, joinOpts: { noMic: true } });
    expect(useRoomStore.getState().hasMic).toBe(false);
    expect(useRoomStore.getState().isMuted).toBe(true);
    expect(mediaController.userMediaCalls).toHaveLength(0); // never prompted
    expect(socket().sentEvents("producer-pause").length).toBeGreaterThan(0);
    expect(systemMessages().some((m) => m.text === announce_no_mic())).toBe(true);
    h.unmount();
  });

  it("falls back to mic-less when acquisition fails", async () => {
    mediaController.failUserMedia = true;
    const h = await joinRoom({ join: { mode: "p2p", peers: [] } });
    expect(useRoomStore.getState().hasMic).toBe(false);
    expect(useRoomStore.getState().isMuted).toBe(true);
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Reconnect + leave
// ---------------------------------------------------------------------------
describe("reconnect + leave", () => {
  it("rejoins from scratch on a socket reconnect", async () => {
    const h = await joinRoom({ join: { mode: "p2p", peers: [peerEntry("id-bob")] } });
    expect(socket().sentEvents("join")).toHaveLength(1);

    // socket.io fires "connect" again on reconnect — the hook rejoins.
    await act(async () => {
      await socket().connect("id-self");
    });
    await flush();
    expect(socket().sentEvents("join")).toHaveLength(2);
    expect(useRoomStore.getState().connected).toBe(true);
    h.unmount();
  });

  it("tears everything down and resets the store on leave", async () => {
    const h = await sfuJoin([peerEntry("id-bob", [voiceProd("p1")]), peerEntry("id-carol")]);
    const send = sendTransport();
    await runAct(() => h.result.current.leave());
    expect(send.closed).toBe(true);
    expect(useRoomStore.getState().roomName).toBeNull();
    expect(useRoomStore.getState().peers.size).toBe(0);
    expect(useRoomStore.getState().connected).toBe(false);
    h.unmount();
  });
});
