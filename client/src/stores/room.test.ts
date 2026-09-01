import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatMessage } from "../lib/chat";
import { isIOS } from "../lib/microphone";
import { useRoomStore, DEFAULT_STREAM_CONFIG, MAX_MIC_GAIN, type StreamConfig } from "./room";

// localStorage keys (kept in lockstep with room.ts — they are module-private there).
const KEYS = {
  micGain: "sonicroom:micGain",
  streamMonitorVolume: "sonicroom:streamMonitorVolume",
  micDevice: "sonicroom:micDeviceId",
  speakerDevice: "sonicroom:speakerDeviceId",
  voiceProcessing: "sonicroom:voiceProcessing",
  hifiVoice: "sonicroom:hifiVoice",
  streamedMics: "sonicroom:streamedMicDeviceIds",
  micStereo: "sonicroom:micStereoByDevice",
  streamConfig: "sonicroom:streamConfig",
  chatAnnounce: "sonicroom:chatAnnounceMode",
  videoBackground: "sonicroom:videoBackground",
  videoBackgroundImage: "sonicroom:videoBackgroundImage",
};

const CHAT_MESSAGES_MAX = 200;

function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, sender: "Alice", text: `text-${id}`, ts: 1000, ...over };
}

beforeEach(() => {
  localStorage.clear();
  useRoomStore.getState().reset();
  // reset() intentionally PRESERVES persisted prefs (device prefs, streamConfig,
  // chatAnnounceMode, locale), so they would otherwise leak between tests. Force
  // them back to a known baseline so each test starts clean. We assert reset()'s
  // preservation behavior explicitly in its own test instead.
  useRoomStore.setState({
    locale: "en",
    micGain: 1,
    streamMonitorVolume: 0.5,
    micDeviceId: "",
    speakerDeviceId: "",
    voiceProcessingEnabled: isIOS,
    hifiVoiceEnabled: false,
    streamedMicDeviceIds: [],
    micStereoByDevice: {},
    streamConfig: { ...DEFAULT_STREAM_CONFIG },
    chatAnnounceMode: "polite",
  });
});

// ---------------------------------------------------------------------------
// Peer map actions
// ---------------------------------------------------------------------------
describe("peer map actions", () => {
  it("addPeer creates a peer with documented defaults", () => {
    useRoomStore.getState().addPeer("p1", "Alice");
    const peer = useRoomStore.getState().peers.get("p1")!;
    expect(peer).toEqual({
      peerId: "p1",
      displayName: "Alice",
      isSpeaking: false,
      isMuted: false,
      volume: 1,
      isMusic: false,
      isCaster: false,
      isMicStream: false,
      kickVotes: 0,
      iVotedKick: false,
      localMuted: false,
      hasVideo: false,
      hasScreen: false,
    });
  });

  it("addPeer replaces an existing peer id and yields a new Map identity", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    const mapBefore = useRoomStore.getState().peers;
    s.addPeer("p1", "Alice2");
    expect(useRoomStore.getState().peers).not.toBe(mapBefore);
    expect(useRoomStore.getState().peers.size).toBe(1);
    expect(useRoomStore.getState().peers.get("p1")!.displayName).toBe("Alice2");
  });

  it("removePeer deletes the peer", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    s.addPeer("p2", "Bob");
    s.removePeer("p1");
    const peers = useRoomStore.getState().peers;
    expect(peers.has("p1")).toBe(false);
    expect(peers.has("p2")).toBe(true);
  });

  it("removePeer also drops the peer from speakerBadges when present", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    s.addPeer("p2", "Bob");
    s.setSpeakerBadges({ p1: 1, p2: 2 });
    s.removePeer("p1");
    expect(useRoomStore.getState().speakerBadges).toEqual({ p2: 2 });
  });

  it("removePeer leaves speakerBadges identity untouched when the peer isn't badged", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    s.setSpeakerBadges({ p2: 2 });
    const badgesBefore = useRoomStore.getState().speakerBadges;
    s.removePeer("p1");
    expect(useRoomStore.getState().speakerBadges).toBe(badgesBefore);
  });

  it("setPeerSpeaking is a no-op (same state identity) when the peer is missing", () => {
    const stateBefore = useRoomStore.getState();
    stateBefore.setPeerSpeaking("ghost", true);
    expect(useRoomStore.getState()).toBe(stateBefore);
  });

  it("setPeerSpeaking is a no-op (same peers Map identity) when value is unchanged", () => {
    useRoomStore.getState().addPeer("p1", "Alice");
    const peersBefore = useRoomStore.getState().peers;
    // peer.isSpeaking already false
    useRoomStore.getState().setPeerSpeaking("p1", false);
    expect(useRoomStore.getState().peers).toBe(peersBefore);
  });

  it("setPeerSpeaking toggles and creates a new Map when changed", () => {
    useRoomStore.getState().addPeer("p1", "Alice");
    const peersBefore = useRoomStore.getState().peers;
    useRoomStore.getState().setPeerSpeaking("p1", true);
    expect(useRoomStore.getState().peers).not.toBe(peersBefore);
    expect(useRoomStore.getState().peers.get("p1")!.isSpeaking).toBe(true);
    // redundant call back to the same value is a no-op again
    const peersAfter = useRoomStore.getState().peers;
    useRoomStore.getState().setPeerSpeaking("p1", true);
    expect(useRoomStore.getState().peers).toBe(peersAfter);
  });

  it("setPeerMuted updates the flag and no-ops gracefully when absent", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    s.setPeerMuted("p1", true);
    expect(useRoomStore.getState().peers.get("p1")!.isMuted).toBe(true);
    // absent peer: no throw, no new peer
    expect(() => s.setPeerMuted("ghost", true)).not.toThrow();
    expect(useRoomStore.getState().peers.has("ghost")).toBe(false);
    expect(useRoomStore.getState().peers.size).toBe(1);
  });

  it("setPeerVolume updates volume and no-ops when absent", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    s.setPeerVolume("p1", 2.5);
    expect(useRoomStore.getState().peers.get("p1")!.volume).toBe(2.5);
    expect(() => s.setPeerVolume("ghost", 3)).not.toThrow();
    expect(useRoomStore.getState().peers.has("ghost")).toBe(false);
  });

  it("setPeerLocalMute updates localMuted and no-ops when absent", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    s.setPeerLocalMute("p1", true);
    expect(useRoomStore.getState().peers.get("p1")!.localMuted).toBe(true);
    expect(() => s.setPeerLocalMute("ghost", true)).not.toThrow();
    expect(useRoomStore.getState().peers.has("ghost")).toBe(false);
  });

  it("setPeerMusic updates isMusic and no-ops when absent", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    s.setPeerMusic("p1", true);
    expect(useRoomStore.getState().peers.get("p1")!.isMusic).toBe(true);
    expect(() => s.setPeerMusic("ghost", true)).not.toThrow();
    expect(useRoomStore.getState().peers.has("ghost")).toBe(false);
  });

  it("setPeerCaster updates isCaster and no-ops when absent", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    s.setPeerCaster("p1", true);
    expect(useRoomStore.getState().peers.get("p1")!.isCaster).toBe(true);
    expect(() => s.setPeerCaster("ghost", true)).not.toThrow();
    expect(useRoomStore.getState().peers.has("ghost")).toBe(false);
  });

  it("setPeerMicStream updates isMicStream and no-ops when absent", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    s.setPeerMicStream("p1", true);
    expect(useRoomStore.getState().peers.get("p1")!.isMicStream).toBe(true);
    expect(() => s.setPeerMicStream("ghost", true)).not.toThrow();
    expect(useRoomStore.getState().peers.has("ghost")).toBe(false);
  });

  it("setPeerName renames and no-ops when absent", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    s.setPeerName("p1", "Renamed");
    expect(useRoomStore.getState().peers.get("p1")!.displayName).toBe("Renamed");
    expect(() => s.setPeerName("ghost", "X")).not.toThrow();
    expect(useRoomStore.getState().peers.has("ghost")).toBe(false);
  });

  it("setPeerKickVote sets votes and updates iVotedKick only when iVoted is provided", () => {
    const s = useRoomStore.getState();
    s.addPeer("p1", "Alice");
    // seed iVotedKick true
    s.setPeerKickVote("p1", 1, true);
    expect(useRoomStore.getState().peers.get("p1")!.kickVotes).toBe(1);
    expect(useRoomStore.getState().peers.get("p1")!.iVotedKick).toBe(true);

    // votes-only update (iVoted undefined) preserves the existing iVotedKick
    s.setPeerKickVote("p1", 3);
    expect(useRoomStore.getState().peers.get("p1")!.kickVotes).toBe(3);
    expect(useRoomStore.getState().peers.get("p1")!.iVotedKick).toBe(true);

    // explicit false IS honored (not treated as "unset")
    s.setPeerKickVote("p1", 2, false);
    expect(useRoomStore.getState().peers.get("p1")!.kickVotes).toBe(2);
    expect(useRoomStore.getState().peers.get("p1")!.iVotedKick).toBe(false);
  });

  it("setPeerKickVote no-ops when the peer is absent", () => {
    const s = useRoomStore.getState();
    expect(() => s.setPeerKickVote("ghost", 5, true)).not.toThrow();
    expect(useRoomStore.getState().peers.has("ghost")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addMessage
// ---------------------------------------------------------------------------
describe("addMessage", () => {
  it("appends messages in order", () => {
    const s = useRoomStore.getState();
    s.addMessage(msg("m1"));
    s.addMessage(msg("m2"));
    const messages = useRoomStore.getState().messages;
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("de-dupes by message id (same id added twice keeps one, identity preserved)", () => {
    const s = useRoomStore.getState();
    s.addMessage(msg("m1"));
    const stateBefore = useRoomStore.getState();
    s.addMessage(msg("m1", { text: "different body" }));
    // duplicate returns the same state object reference (no change)
    expect(useRoomStore.getState()).toBe(stateBefore);
    expect(useRoomStore.getState().messages).toHaveLength(1);
    expect(useRoomStore.getState().messages[0].text).toBe("text-m1");
  });

  it("enforces the 200-message cap by trimming oldest", () => {
    const s = useRoomStore.getState();
    for (let i = 0; i < 205; i++) s.addMessage(msg(`m${i}`));
    const messages = useRoomStore.getState().messages;
    expect(messages).toHaveLength(CHAT_MESSAGES_MAX);
    // m0..m4 dropped; m5..m204 survive (newest kept)
    expect(messages[0].id).toBe("m5");
    expect(messages[messages.length - 1].id).toBe("m204");
  });
});

// ---------------------------------------------------------------------------
// announce / announceEvent
// ---------------------------------------------------------------------------
describe("announce and announceEvent", () => {
  it("announce sets announcement + bumps seq but adds NO chat message", () => {
    const seqBefore = useRoomStore.getState().announceSeq;
    useRoomStore.getState().announce("hello");
    expect(useRoomStore.getState().announcement).toBe("hello");
    expect(useRoomStore.getState().announceSeq).toBe(seqBefore + 1);
    expect(useRoomStore.getState().messages).toHaveLength(0);
  });

  it("announceEvent appends a kind:system message, bumps seq, sets announcement", () => {
    const seqBefore = useRoomStore.getState().announceSeq;
    useRoomStore.getState().announceEvent("recording started");
    const st = useRoomStore.getState();
    expect(st.announcement).toBe("recording started");
    expect(st.announceSeq).toBe(seqBefore + 1);
    expect(st.messages).toHaveLength(1);
    const m = st.messages[0];
    expect(m.kind).toBe("system");
    expect(m.text).toBe("recording started");
    expect(m.sender).toBe("");
  });

  it("announceEvent respects the 200-message cap", () => {
    const s = useRoomStore.getState();
    for (let i = 0; i < 200; i++) s.addMessage(msg(`m${i}`));
    s.announceEvent("evt");
    const messages = useRoomStore.getState().messages;
    expect(messages).toHaveLength(CHAT_MESSAGES_MAX);
    // oldest (m0) dropped, the system event is newest
    expect(messages[0].id).toBe("m1");
    const last = messages[messages.length - 1];
    expect(last.kind).toBe("system");
    expect(last.text).toBe("evt");
  });
});

// ---------------------------------------------------------------------------
// announceChat + chatAnnounceMode
// ---------------------------------------------------------------------------
describe("announceChat across chatAnnounceMode", () => {
  it("setChatAnnounceMode persists to localStorage and updates state", () => {
    useRoomStore.getState().setChatAnnounceMode("assertive");
    expect(useRoomStore.getState().chatAnnounceMode).toBe("assertive");
    expect(localStorage.getItem(KEYS.chatAnnounce)).toBe("assertive");
  });

  it("polite: fills chatPoliteMsg, clears assertive, bumps seq", () => {
    const s = useRoomStore.getState();
    s.setChatAnnounceMode("polite");
    // pre-seed assertive to prove it gets cleared
    useRoomStore.setState({ chatAssertiveMsg: "stale" });
    const seqBefore = useRoomStore.getState().chatAnnounceSeq;
    s.announceChat("hi");
    const st = useRoomStore.getState();
    expect(st.chatPoliteMsg).toBe("hi");
    expect(st.chatAssertiveMsg).toBe("");
    expect(st.chatAnnounceSeq).toBe(seqBefore + 1);
  });

  it("assertive: fills chatAssertiveMsg, clears polite, bumps seq", () => {
    const s = useRoomStore.getState();
    s.setChatAnnounceMode("assertive");
    useRoomStore.setState({ chatPoliteMsg: "stale" });
    const seqBefore = useRoomStore.getState().chatAnnounceSeq;
    s.announceChat("hey");
    const st = useRoomStore.getState();
    expect(st.chatAssertiveMsg).toBe("hey");
    expect(st.chatPoliteMsg).toBe("");
    expect(st.chatAnnounceSeq).toBe(seqBefore + 1);
  });

  it("off: bumps seq only, both region strings stay empty", () => {
    const s = useRoomStore.getState();
    s.setChatAnnounceMode("off");
    const seqBefore = useRoomStore.getState().chatAnnounceSeq;
    s.announceChat("ignored");
    const st = useRoomStore.getState();
    expect(st.chatPoliteMsg).toBe("");
    expect(st.chatAssertiveMsg).toBe("");
    expect(st.chatAnnounceSeq).toBe(seqBefore + 1);
  });

  it("tts: speaks via speechSynthesis, leaves region strings empty, bumps seq", () => {
    const speakSpy = vi.spyOn(window.speechSynthesis, "speak");
    const s = useRoomStore.getState();
    s.setChatAnnounceMode("tts");
    const seqBefore = useRoomStore.getState().chatAnnounceSeq;
    s.announceChat("spoken line");
    const st = useRoomStore.getState();
    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(st.chatPoliteMsg).toBe("");
    expect(st.chatAssertiveMsg).toBe("");
    expect(st.chatAnnounceSeq).toBe(seqBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// Persistence setters
// ---------------------------------------------------------------------------
describe("persistence setters write to localStorage and update state", () => {
  it("setMicGain", () => {
    useRoomStore.getState().setMicGain(2.5);
    expect(useRoomStore.getState().micGain).toBe(2.5);
    expect(localStorage.getItem(KEYS.micGain)).toBe("2.5");
  });

  it("setStreamMonitorVolume", () => {
    useRoomStore.getState().setStreamMonitorVolume(0.25);
    expect(useRoomStore.getState().streamMonitorVolume).toBe(0.25);
    expect(localStorage.getItem(KEYS.streamMonitorVolume)).toBe("0.25");
  });

  it("setMicDeviceId", () => {
    useRoomStore.getState().setMicDeviceId("mic-abc");
    expect(useRoomStore.getState().micDeviceId).toBe("mic-abc");
    expect(localStorage.getItem(KEYS.micDevice)).toBe("mic-abc");
  });

  it("setSpeakerDeviceId", () => {
    useRoomStore.getState().setSpeakerDeviceId("spk-abc");
    expect(useRoomStore.getState().speakerDeviceId).toBe("spk-abc");
    expect(localStorage.getItem(KEYS.speakerDevice)).toBe("spk-abc");
  });

  it("setVoiceProcessingEnabled stringifies the bool", () => {
    useRoomStore.getState().setVoiceProcessingEnabled(true);
    expect(useRoomStore.getState().voiceProcessingEnabled).toBe(true);
    expect(localStorage.getItem(KEYS.voiceProcessing)).toBe("true");
    useRoomStore.getState().setVoiceProcessingEnabled(false);
    expect(localStorage.getItem(KEYS.voiceProcessing)).toBe("false");
  });

  it("setHifiVoiceEnabled stringifies the bool", () => {
    useRoomStore.getState().setHifiVoiceEnabled(true);
    expect(useRoomStore.getState().hifiVoiceEnabled).toBe(true);
    expect(localStorage.getItem(KEYS.hifiVoice)).toBe("true");
  });

  it("setStreamedMicDeviceIds writes a JSON array", () => {
    useRoomStore.getState().setStreamedMicDeviceIds(["a", "b"]);
    expect(useRoomStore.getState().streamedMicDeviceIds).toEqual(["a", "b"]);
    expect(localStorage.getItem(KEYS.streamedMics)).toBe('["a","b"]');
  });

  it("setMicStereoForDevice merges into the per-device map and persists JSON", () => {
    const s = useRoomStore.getState();
    s.setMicStereoForDevice("d1", true);
    s.setMicStereoForDevice("d2", false);
    expect(useRoomStore.getState().micStereoByDevice).toEqual({ d1: true, d2: false });
    expect(JSON.parse(localStorage.getItem(KEYS.micStereo)!)).toEqual({ d1: true, d2: false });
    // overwrite an existing device key
    s.setMicStereoForDevice("d1", false);
    expect(useRoomStore.getState().micStereoByDevice).toEqual({ d1: false, d2: false });
  });

  it("setStreamConfig writes JSON and updates state", () => {
    const cfg: StreamConfig = {
      host: "stream.example",
      port: 9000,
      mount: "/live",
      username: "src",
      password: "secret",
      format: "opus",
      bitrateKbps: 192,
    };
    useRoomStore.getState().setStreamConfig(cfg);
    expect(useRoomStore.getState().streamConfig).toEqual(cfg);
    expect(JSON.parse(localStorage.getItem(KEYS.streamConfig)!)).toEqual(cfg);
  });
});

// ---------------------------------------------------------------------------
// Persistence LOADERS (re-read at module init)
// ---------------------------------------------------------------------------
describe("persistence loaders (fresh module init)", () => {
  // Re-import room.ts so its top-level load* functions re-read localStorage.
  async function freshStore() {
    vi.resetModules();
    const mod = await import("./room");
    return mod.useRoomStore;
  }

  describe("loadMicGain", () => {
    it("defaults to 1 when missing", async () => {
      expect((await freshStore()).getState().micGain).toBe(1);
    });
    it("defaults to 1 on NaN", async () => {
      localStorage.setItem(KEYS.micGain, "not-a-number");
      expect((await freshStore()).getState().micGain).toBe(1);
    });
    it("clamps above MAX_MIC_GAIN", async () => {
      localStorage.setItem(KEYS.micGain, "99");
      expect((await freshStore()).getState().micGain).toBe(MAX_MIC_GAIN);
    });
    it("clamps below 0", async () => {
      localStorage.setItem(KEYS.micGain, "-3");
      expect((await freshStore()).getState().micGain).toBe(0);
    });
    it("honors an in-range value", async () => {
      localStorage.setItem(KEYS.micGain, "2.5");
      expect((await freshStore()).getState().micGain).toBe(2.5);
    });
  });

  describe("loadStreamMonitorVolume", () => {
    it("defaults to 0.5 when missing", async () => {
      expect((await freshStore()).getState().streamMonitorVolume).toBe(0.5);
    });
    it("defaults to 0.5 on NaN", async () => {
      localStorage.setItem(KEYS.streamMonitorVolume, "xyz");
      expect((await freshStore()).getState().streamMonitorVolume).toBe(0.5);
    });
    it("clamps to [0,1]", async () => {
      localStorage.setItem(KEYS.streamMonitorVolume, "5");
      expect((await freshStore()).getState().streamMonitorVolume).toBe(1);
      localStorage.setItem(KEYS.streamMonitorVolume, "-1");
      expect((await freshStore()).getState().streamMonitorVolume).toBe(0);
    });
    it("honors an in-range value", async () => {
      localStorage.setItem(KEYS.streamMonitorVolume, "0.3");
      expect((await freshStore()).getState().streamMonitorVolume).toBe(0.3);
    });
  });

  describe("loadVoiceProcessing", () => {
    it("defaults to isIOS when unset", async () => {
      const v = (await freshStore()).getState().voiceProcessingEnabled;
      expect(typeof v).toBe("boolean");
      expect(v).toBe(isIOS);
    });
    it('honors "true"', async () => {
      localStorage.setItem(KEYS.voiceProcessing, "true");
      expect((await freshStore()).getState().voiceProcessingEnabled).toBe(true);
    });
    it('honors "false"', async () => {
      localStorage.setItem(KEYS.voiceProcessing, "false");
      expect((await freshStore()).getState().voiceProcessingEnabled).toBe(false);
    });
  });

  describe("loadHifiVoice", () => {
    it("defaults to false when missing", async () => {
      expect((await freshStore()).getState().hifiVoiceEnabled).toBe(false);
    });
    it('is true only for "true"', async () => {
      localStorage.setItem(KEYS.hifiVoice, "true");
      expect((await freshStore()).getState().hifiVoiceEnabled).toBe(true);
      localStorage.setItem(KEYS.hifiVoice, "anything-else");
      expect((await freshStore()).getState().hifiVoiceEnabled).toBe(false);
    });
  });

  describe("loadStreamedMicDeviceIds", () => {
    it("defaults to [] when missing", async () => {
      expect((await freshStore()).getState().streamedMicDeviceIds).toEqual([]);
    });
    it("parses a JSON array and filters non-strings", async () => {
      localStorage.setItem(KEYS.streamedMics, JSON.stringify(["a", 1, "b", null, true]));
      expect((await freshStore()).getState().streamedMicDeviceIds).toEqual(["a", "b"]);
    });
    it("returns [] on corrupt JSON", async () => {
      localStorage.setItem(KEYS.streamedMics, "{not valid");
      expect((await freshStore()).getState().streamedMicDeviceIds).toEqual([]);
    });
    it("returns [] when parsed value is not an array", async () => {
      localStorage.setItem(KEYS.streamedMics, JSON.stringify({ a: true }));
      expect((await freshStore()).getState().streamedMicDeviceIds).toEqual([]);
    });
  });

  describe("loadMicStereoByDevice", () => {
    it("defaults to {} when missing", async () => {
      expect((await freshStore()).getState().micStereoByDevice).toEqual({});
    });
    it("parses an object of booleans, dropping non-boolean values", async () => {
      localStorage.setItem(KEYS.micStereo, JSON.stringify({ a: true, b: false, c: "nope", d: 1 }));
      expect((await freshStore()).getState().micStereoByDevice).toEqual({ a: true, b: false });
    });
    it("returns {} on corrupt JSON", async () => {
      localStorage.setItem(KEYS.micStereo, "{bad");
      expect((await freshStore()).getState().micStereoByDevice).toEqual({});
    });
    it("returns {} when parsed value is an array", async () => {
      localStorage.setItem(KEYS.micStereo, JSON.stringify([1, 2]));
      expect((await freshStore()).getState().micStereoByDevice).toEqual({});
    });
  });

  describe("loadStreamConfig", () => {
    it("returns DEFAULT_STREAM_CONFIG when missing", async () => {
      expect((await freshStore()).getState().streamConfig).toEqual(DEFAULT_STREAM_CONFIG);
    });
    it("merges a partial over the defaults", async () => {
      localStorage.setItem(KEYS.streamConfig, JSON.stringify({ host: "h", port: 9000 }));
      expect((await freshStore()).getState().streamConfig).toEqual({
        ...DEFAULT_STREAM_CONFIG,
        host: "h",
        port: 9000,
      });
    });
    it("returns DEFAULT_STREAM_CONFIG on corrupt JSON", async () => {
      localStorage.setItem(KEYS.streamConfig, "{nope");
      expect((await freshStore()).getState().streamConfig).toEqual(DEFAULT_STREAM_CONFIG);
    });
  });

  describe("loadChatAnnounceMode", () => {
    it("defaults to polite when missing", async () => {
      expect((await freshStore()).getState().chatAnnounceMode).toBe("polite");
    });
    it.each(["assertive", "tts", "off"] as const)("honors %s", async (mode) => {
      localStorage.setItem(KEYS.chatAnnounce, mode);
      expect((await freshStore()).getState().chatAnnounceMode).toBe(mode);
    });
    it("falls back to polite for an unknown value", async () => {
      localStorage.setItem(KEYS.chatAnnounce, "garbage");
      expect((await freshStore()).getState().chatAnnounceMode).toBe("polite");
    });
  });
});

// ---------------------------------------------------------------------------
// Simple setters
// ---------------------------------------------------------------------------
describe("simple setters", () => {
  it("setConnected", () => {
    useRoomStore.getState().setConnected(true);
    expect(useRoomStore.getState().connected).toBe(true);
  });

  it("setRoom sets roomName/displayName/localPeerId", () => {
    useRoomStore.getState().setRoom("lounge", "Alice", "peer-1");
    const st = useRoomStore.getState();
    expect(st.roomName).toBe("lounge");
    expect(st.displayName).toBe("Alice");
    expect(st.localPeerId).toBe("peer-1");
  });

  it("setMode", () => {
    useRoomStore.getState().setMode("sfu");
    expect(useRoomStore.getState().mode).toBe("sfu");
  });

  it("setHasMic", () => {
    useRoomStore.getState().setHasMic(false);
    expect(useRoomStore.getState().hasMic).toBe(false);
  });

  it("setMuted", () => {
    useRoomStore.getState().setMuted(true);
    expect(useRoomStore.getState().isMuted).toBe(true);
  });

  it("setDeafened", () => {
    useRoomStore.getState().setDeafened(true);
    expect(useRoomStore.getState().isDeafened).toBe(true);
  });

  it("setPttActive", () => {
    useRoomStore.getState().setPttActive(true);
    expect(useRoomStore.getState().pttActive).toBe(true);
  });

  it("togglePushToTalk flips the flag", () => {
    expect(useRoomStore.getState().isPushToTalk).toBe(false);
    useRoomStore.getState().togglePushToTalk();
    expect(useRoomStore.getState().isPushToTalk).toBe(true);
    useRoomStore.getState().togglePushToTalk();
    expect(useRoomStore.getState().isPushToTalk).toBe(false);
  });

  it("setDuckingEnabled", () => {
    useRoomStore.getState().setDuckingEnabled(false);
    expect(useRoomStore.getState().duckingEnabled).toBe(false);
  });

  it("setSharingAudio", () => {
    useRoomStore.getState().setSharingAudio(true);
    expect(useRoomStore.getState().isSharingAudio).toBe(true);
  });

  it("setFileStream", () => {
    useRoomStore.getState().setFileStream("song.mp3");
    expect(useRoomStore.getState().fileStreamName).toBe("song.mp3");
    useRoomStore.getState().setFileStream(null);
    expect(useRoomStore.getState().fileStreamName).toBe(null);
  });

  it("setFileStreamPlaying", () => {
    useRoomStore.getState().setFileStreamPlaying(true);
    expect(useRoomStore.getState().fileStreamPlaying).toBe(true);
  });

  it("setStreamError", () => {
    useRoomStore.getState().setStreamError("boom");
    expect(useRoomStore.getState().streamError).toBe("boom");
    useRoomStore.getState().setStreamError(null);
    expect(useRoomStore.getState().streamError).toBe(null);
  });

  it("setJoinRequests", () => {
    const reqs = [{ id: "j1", displayName: "Bob" }];
    useRoomStore.getState().setJoinRequests(reqs);
    expect(useRoomStore.getState().joinRequests).toEqual(reqs);
  });

  it("setAwaitingApproval", () => {
    useRoomStore.getState().setAwaitingApproval(true);
    expect(useRoomStore.getState().awaitingApproval).toBe(true);
  });

  it("setRoomIsPublic", () => {
    useRoomStore.getState().setRoomIsPublic(true);
    expect(useRoomStore.getState().roomIsPublic).toBe(true);
  });

  it("setKicked", () => {
    useRoomStore.getState().setKicked(true);
    expect(useRoomStore.getState().kicked).toBe(true);
  });

  it("setSpeakerBadges", () => {
    useRoomStore.getState().setSpeakerBadges({ p1: 1, p2: 2 });
    expect(useRoomStore.getState().speakerBadges).toEqual({ p1: 1, p2: 2 });
  });

  it("setLanguage updates locale and document.documentElement.lang", () => {
    useRoomStore.getState().setLanguage("es");
    expect(useRoomStore.getState().locale).toBe("es");
    expect(document.documentElement.lang).toBe("es");
    useRoomStore.getState().setLanguage("fr");
    expect(useRoomStore.getState().locale).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
  });
});

// ---------------------------------------------------------------------------
// setRecording / setStreaming nuances
// ---------------------------------------------------------------------------
describe("setRecording", () => {
  it("sets a recordingId when provided", () => {
    useRoomStore.getState().setRecording(true, "rec-1");
    expect(useRoomStore.getState().isRecording).toBe(true);
    expect(useRoomStore.getState().recordingId).toBe("rec-1");
  });

  it("KEEPS the prior recordingId when omitted", () => {
    const s = useRoomStore.getState();
    s.setRecording(true, "rec-1");
    s.setRecording(false); // omitted -> keep id
    expect(useRoomStore.getState().isRecording).toBe(false);
    expect(useRoomStore.getState().recordingId).toBe("rec-1");
  });

  it("clears the recordingId when explicitly passed null", () => {
    const s = useRoomStore.getState();
    s.setRecording(true, "rec-1");
    s.setRecording(true, null);
    expect(useRoomStore.getState().recordingId).toBe(null);
  });
});

describe("setStreaming", () => {
  it("going live clears a stale streamError", () => {
    const s = useRoomStore.getState();
    s.setStreamError("previous failure");
    s.setStreaming(true);
    expect(useRoomStore.getState().isStreaming).toBe(true);
    expect(useRoomStore.getState().streamError).toBe(null);
  });

  it("stopping leaves streamError untouched", () => {
    const s = useRoomStore.getState();
    s.setStreamError("kept");
    s.setStreaming(false);
    expect(useRoomStore.getState().isStreaming).toBe(false);
    expect(useRoomStore.getState().streamError).toBe("kept");
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------
describe("reset", () => {
  it("clears live state but preserves persisted prefs", () => {
    const s = useRoomStore.getState();

    // Persisted prefs (should survive reset)
    s.setMicDeviceId("mic-x");
    s.setSpeakerDeviceId("spk-x");
    s.setMicGain(3);
    s.setStreamMonitorVolume(0.9);
    s.setVoiceProcessingEnabled(!isIOS);
    s.setHifiVoiceEnabled(true);
    s.setStreamedMicDeviceIds(["a", "b"]);
    s.setMicStereoForDevice("a", true);
    s.setChatAnnounceMode("tts");
    const customCfg: StreamConfig = {
      host: "h",
      port: 7000,
      mount: "/m",
      username: "u",
      password: "p",
      format: "opus",
      bitrateKbps: 320,
    };
    s.setStreamConfig(customCfg);
    s.setLanguage("fr");

    // Live state (should be cleared)
    s.setConnected(true);
    s.setRoom("lounge", "Alice", "peer-1");
    s.setMode("sfu");
    s.setHasMic(false);
    s.setMuted(true);
    s.setDeafened(true);
    s.setPttActive(true);
    s.setDuckingEnabled(false);
    s.setSharingAudio(true);
    s.setFileStream("song.mp3");
    s.setFileStreamPlaying(true);
    s.addPeer("p1", "Alice");
    s.addMessage(msg("m1"));
    s.setSpeakerBadges({ p1: 1 });
    s.setRecording(true, "rec-1");
    s.setStreaming(true);
    s.setStreamError("err");
    s.announce("noise");
    s.setJoinRequests([{ id: "j", displayName: "J" }]);
    s.setAwaitingApproval(true);
    s.setRoomIsPublic(true);
    s.setKicked(true);

    useRoomStore.getState().reset();
    const st = useRoomStore.getState();

    // --- live state cleared ---
    expect(st.connected).toBe(false);
    expect(st.roomName).toBe(null);
    expect(st.displayName).toBe(null);
    expect(st.localPeerId).toBe(null);
    expect(st.mode).toBe("p2p");
    expect(st.hasMic).toBe(true);
    expect(st.isMuted).toBe(false);
    expect(st.isDeafened).toBe(false);
    expect(st.isPushToTalk).toBe(false);
    expect(st.pttActive).toBe(false);
    expect(st.duckingEnabled).toBe(true);
    expect(st.isSharingAudio).toBe(false);
    expect(st.fileStreamName).toBe(null);
    expect(st.fileStreamPlaying).toBe(false);
    expect(st.peers.size).toBe(0);
    expect(st.messages).toEqual([]);
    expect(st.speakerBadges).toEqual({});
    expect(st.isRecording).toBe(false);
    expect(st.recordingId).toBe(null);
    expect(st.isStreaming).toBe(false);
    expect(st.streamError).toBe(null);
    expect(st.announcement).toBe("");
    expect(st.announceSeq).toBe(0);
    expect(st.chatPoliteMsg).toBe("");
    expect(st.chatAssertiveMsg).toBe("");
    expect(st.chatAnnounceSeq).toBe(0);
    expect(st.joinRequests).toEqual([]);
    expect(st.awaitingApproval).toBe(false);
    expect(st.roomIsPublic).toBe(false);
    expect(st.kicked).toBe(false);

    // --- persisted prefs preserved ---
    expect(st.micDeviceId).toBe("mic-x");
    expect(st.speakerDeviceId).toBe("spk-x");
    expect(st.micGain).toBe(3);
    expect(st.streamMonitorVolume).toBe(0.9);
    expect(st.voiceProcessingEnabled).toBe(!isIOS);
    expect(st.hifiVoiceEnabled).toBe(true);
    expect(st.streamedMicDeviceIds).toEqual(["a", "b"]);
    expect(st.micStereoByDevice).toEqual({ a: true });
    expect(st.chatAnnounceMode).toBe("tts");
    expect(st.streamConfig).toEqual(customCfg);
    expect(st.locale).toBe("fr");
  });
});

describe("video background (lobby-configured, persisted)", () => {
  // A stand-in for the downscaled JPEG data URL the picker produces.
  const IMAGE = "data:image/jpeg;base64,AAAA";

  async function freshStore() {
    vi.resetModules();
    const mod = await import("./room");
    return mod.useRoomStore;
  }

  it("defaults to no background — the raw camera, and no compositor at all", () => {
    expect(useRoomStore.getState().videoBackground).toBe("none");
    expect(useRoomStore.getState().videoBackgroundImage).toBe("");
  });

  it("persists a preset choice", () => {
    useRoomStore.getState().setVideoBackground("beach");
    expect(useRoomStore.getState().videoBackground).toBe("beach");
    expect(localStorage.getItem(KEYS.videoBackground)).toBe("beach");
  });

  it("refuses 'custom' while no image is stored, keeping none instead", () => {
    useRoomStore.getState().setVideoBackground("custom");
    expect(useRoomStore.getState().videoBackground).toBe("none");
  });

  it("accepts 'custom' once an image is stored", () => {
    useRoomStore.getState().setVideoBackgroundImage(IMAGE);
    useRoomStore.getState().setVideoBackground("custom");
    expect(useRoomStore.getState().videoBackground).toBe("custom");
    expect(localStorage.getItem(KEYS.videoBackgroundImage)).toBe(IMAGE);
  });

  it("drops a 'custom' selection when the image is removed, and persists that too", () => {
    useRoomStore.getState().setVideoBackgroundImage(IMAGE);
    useRoomStore.getState().setVideoBackground("custom");
    useRoomStore.getState().setVideoBackgroundImage("");
    expect(useRoomStore.getState().videoBackground).toBe("none");
    expect(localStorage.getItem(KEYS.videoBackground)).toBe("none");
  });

  it("leaves a preset selection alone when the custom image is removed", () => {
    useRoomStore.getState().setVideoBackgroundImage(IMAGE);
    useRoomStore.getState().setVideoBackground("mountains");
    useRoomStore.getState().setVideoBackgroundImage("");
    expect(useRoomStore.getState().videoBackground).toBe("mountains");
  });

  it("reports whether the image actually persisted", () => {
    expect(useRoomStore.getState().setVideoBackgroundImage(IMAGE)).toBe(true);
    // The test harness installs its own in-memory Storage, so spy on the
    // instance rather than Storage.prototype.
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    // Applied in memory for this call even though storage refused it.
    expect(useRoomStore.getState().setVideoBackgroundImage(IMAGE)).toBe(false);
    expect(useRoomStore.getState().videoBackgroundImage).toBe(IMAGE);
    setItem.mockRestore();
  });

  it("survives reset — it is a preference, not per-room state", () => {
    useRoomStore.getState().setVideoBackground("studio");
    useRoomStore.getState().reset();
    expect(useRoomStore.getState().videoBackground).toBe("studio");
  });

  describe("loading a stored choice", () => {
    it("restores a preset", async () => {
      localStorage.setItem(KEYS.videoBackground, "bookshelves");
      expect((await freshStore()).getState().videoBackground).toBe("bookshelves");
    });
    it("degrades 'custom' to none when the image is gone", async () => {
      localStorage.setItem(KEYS.videoBackground, "custom");
      expect((await freshStore()).getState().videoBackground).toBe("none");
    });
    it("keeps 'custom' when the image is still there", async () => {
      localStorage.setItem(KEYS.videoBackground, "custom");
      localStorage.setItem(KEYS.videoBackgroundImage, IMAGE);
      expect((await freshStore()).getState().videoBackground).toBe("custom");
    });
    it("degrades a preset this build no longer ships", async () => {
      localStorage.setItem(KEYS.videoBackground, "some-retired-preset");
      expect((await freshStore()).getState().videoBackground).toBe("none");
    });
  });
});
