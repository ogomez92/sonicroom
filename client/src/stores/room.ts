import { create } from "zustand";
import type { ChatMessage } from "../lib/chat";
import { getLocale, setLocale as applyParaglideLocale, type Locale } from "../lib/i18n";
import { isIOS } from "../lib/microphone";
import { speak } from "../lib/tts";

// Keep the in-memory chat bounded; the server caps history too. Newest last.
const CHAT_MESSAGES_MAX = 200;

// Outgoing mic gain is a per-device preference, so it's persisted and survives
// reloads — and carries from the lobby's mic preview into the room.
const MIC_GAIN_KEY = "sonicroom:micGain";
export const MAX_MIC_GAIN = 4;

function loadMicGain(): number {
  try {
    const v = parseFloat(localStorage.getItem(MIC_GAIN_KEY) ?? "");
    if (Number.isFinite(v)) return Math.min(MAX_MIC_GAIN, Math.max(0, v));
  } catch {
    // localStorage unavailable (e.g. private mode) — fall back to unity.
  }
  return 1;
}

// Selected audio devices ("" = browser default). Per-device preferences like
// micGain: persisted, and carried from the lobby preview into the call.
const MIC_DEVICE_KEY = "sonicroom:micDeviceId";
const SPEAKER_DEVICE_KEY = "sonicroom:speakerDeviceId";
const VOICE_PROCESSING_KEY = "sonicroom:voiceProcessing";
const HIFI_VOICE_KEY = "sonicroom:hifiVoice";

function loadString(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function saveString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort; keep the in-memory value regardless.
  }
}

function loadVoiceProcessing(): boolean {
  try {
    const value = localStorage.getItem(VOICE_PROCESSING_KEY);
    return value == null ? isIOS : value === "true";
  } catch {
    return isIOS;
  }
}

// Hi-fi (stereo, ~128 kbps) voice is opt-in; the default is mono ~64 kbps for
// everyone, since most mics are mono and the higher bitrate costs every
// listener bandwidth. Applies on the next call.
function loadHifiVoice(): boolean {
  try {
    return localStorage.getItem(HIFI_VOICE_KEY) === "true";
  } catch {
    return false;
  }
}

// Extra microphones to stream: which input device ids the user has opted to
// stream as separate "mic" producers (in addition to the primary voice mic),
// and a per-device mono/stereo choice. Persisted per-device preferences (like
// micDeviceId), carried from the lobby into the call. Stored as JSON, mirroring
// streamConfig.
const STREAMED_MICS_KEY = "sonicroom:streamedMicDeviceIds";
const MIC_STEREO_KEY = "sonicroom:micStereoByDevice";

function loadStreamedMicDeviceIds(): string[] {
  try {
    const raw = localStorage.getItem(STREAMED_MICS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((d): d is string => typeof d === "string");
    }
  } catch {
    // Missing/corrupt/unavailable — none selected.
  }
  return [];
}

function loadMicStereoByDevice(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(MIC_STEREO_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "boolean") out[k] = v;
        return out;
      }
    }
  } catch {
    // Missing/corrupt/unavailable — default mono for every device.
  }
  return {};
}

// Icecast streaming target. Persisted (incl. password) so the user configures
// it once and can re-stream without retyping — same "remember my settings"
// treatment as the mic/speaker choice. Sent to the server on start-streaming
// and never broadcast to other peers.
export type StreamFormat = "mp3" | "opus";
export interface StreamConfig {
  host: string;
  port: number;
  mount: string;
  username: string;
  password: string;
  format: StreamFormat;
  bitrateKbps: number;
}

const STREAM_CONFIG_KEY = "sonicroom:streamConfig";

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  host: "",
  port: 8000,
  mount: "/sonicroom",
  username: "source",
  password: "",
  format: "mp3",
  bitrateKbps: 160,
};

function loadStreamConfig(): StreamConfig {
  try {
    const raw = localStorage.getItem(STREAM_CONFIG_KEY);
    if (raw) return { ...DEFAULT_STREAM_CONFIG, ...(JSON.parse(raw) as Partial<StreamConfig>) };
  } catch {
    // Missing/corrupt/unavailable — fall back to defaults.
  }
  return { ...DEFAULT_STREAM_CONFIG };
}

// How incoming/outgoing chat messages are spoken to the user. A persisted
// accessibility preference:
//  - "polite"    — announced on a polite ARIA live region (default; queues
//                  behind other screen-reader speech).
//  - "assertive" — announced on an assertive ARIA live region (interrupts).
//  - "tts"       — read aloud by the browser's speech synthesis, for users who
//                  do NOT run a screen reader (see lib/tts).
//  - "off"       — not announced at all (still shown in the chat list).
export type ChatAnnounceMode = "polite" | "assertive" | "tts" | "off";

const CHAT_ANNOUNCE_KEY = "sonicroom:chatAnnounceMode";

function loadChatAnnounceMode(): ChatAnnounceMode {
  const v = loadString(CHAT_ANNOUNCE_KEY);
  return v === "assertive" || v === "tts" || v === "off" ? v : "polite";
}

export interface PeerState {
  peerId: string;
  displayName: string;
  isSpeaking: boolean;
  isMuted: boolean;
  volume: number; // 0-4
  // True for a send-only "music caster" peer (e.g. Ecobox): rendered with a
  // music icon and treated as a media source rather than a talking participant.
  isMusic: boolean;
  // True for an EXTRA-microphone stream tile (a peer's additional input device,
  // a separate "mic" producer keyed by producerId). Like `isMusic` it's a media
  // tile, not a votable human, so it's excluded from vote-to-kick — but UNLIKE
  // `isMusic` it is voice-like and NOT ducked (ducking keys on isMusic only).
  isMicStream: boolean;
  // Vote-to-kick (public rooms): how many people have voted to remove this peer
  // (server-authoritative tally), and whether WE are one of them (drives the
  // kick button's aria-pressed). Both 0/false outside a public room.
  kickVotes: number;
  iVotedKick: boolean;
  // Per-LISTENER local mute (this client only, never signaled to the server or
  // other peers). When true, effectiveGain() returns 0 for this peer/stream
  // regardless of volume — i.e. you silence one participant or stream just for
  // yourself. Distinct from `isMuted` (the peer's own mic mute, server-reported)
  // and from room-wide deafen.
  localMuted: boolean;
}

export type RoomMode = "p2p" | "sfu";

// A pending "ask to join" request shown to people already in the room. `id` is
// the requester's socket id — the target a participant's allow/deny references.
export interface JoinRequest {
  id: string;
  displayName: string;
}

interface RoomState {
  // Active UI language. Mirrors Paraglide's runtime locale so a change here
  // re-renders the tree (see main.tsx's App); the actual messages are resolved
  // by the generated m.*() functions, not from this field.
  locale: Locale;

  // Connection
  connected: boolean;
  roomName: string | null;
  displayName: string | null;
  localPeerId: string | null;
  mode: RoomMode;

  // Whether we joined with a working microphone. False when the user opted out
  // ("Join without a microphone") or no mic was available / permission denied —
  // they listen and use text chat only. Gates the mute control + mic-level
  // slider and shows a "text only" indicator on their own card.
  hasMic: boolean;

  // Local controls
  isMuted: boolean;
  isDeafened: boolean;
  isPushToTalk: boolean;
  pttActive: boolean;
  // Room-wide auto-ducking toggle (default on). When off, no music-type stream
  // (caster/share/file) is ducked under voice. Synced from the server.
  duckingEnabled: boolean;
  isSharingAudio: boolean;
  // Local-file streaming (independent of the audio share): the name of the file
  // currently being streamed into the call (null = not streaming), and whether
  // it's playing or paused. Drives the floating file-player window and the
  // toolbar button. The actual <audio> element lives in the media hook.
  fileStreamName: string | null;
  fileStreamPlaying: boolean;
  // Outgoing (send-side) mic gain applied before the track reaches peers/SFU,
  // 0–MAX_MIC_GAIN. 1 = unity (raw mic). Lets a quiet/cheap mic be boosted for
  // everyone, independent of each listener's per-peer playback volume.
  micGain: number;
  // Selected input/output devices ("" = browser default). The lobby preview
  // and the in-call media graph both follow these (see DeviceSettings).
  micDeviceId: string;
  speakerDeviceId: string;
  // Browser voice processing (echo cancellation, noise suppression and
  // automatic gain). Defaults on for iOS/iPadOS and off elsewhere.
  voiceProcessingEnabled: boolean;
  // Opt-in hi-fi voice (stereo, ~128 kbps). Default off → mono ~64 kbps.
  // Read at call start (join / P2P offer / produce); applies on the next call.
  hifiVoiceEnabled: boolean;
  // Extra input devices to stream as separate "mic" producers (alongside the
  // primary voice mic), and each one's mono/stereo choice (default mono). The
  // in-call graph reconciles producers to match these (see useMediasoup); the
  // picker lives in DeviceSettings. Persisted, carried from the lobby.
  streamedMicDeviceIds: string[];
  micStereoByDevice: Record<string, boolean>;

  // Recording (a recording belongs to the room; visible to everyone)
  isRecording: boolean;
  recordingId: string | null;

  // Live Icecast streaming (room-wide, like recording — everyone sees it's
  // live). `streamConfig` is this client's persisted Icecast target (the only
  // place the password lives); `isStreaming` is the room-wide live state.
  isStreaming: boolean;
  streamConfig: StreamConfig;
  // Last streaming failure reason (server-supplied), shown in the Streaming
  // panel. Set when the server reports the stream died (bad target, unreachable,
  // auth, …); cleared on a fresh start/stop. Null when there's nothing to show.
  streamError: string | null;

  // Latest screen-reader announcement (peer join/leave, recording, etc.).
  // `announceSeq` changes on every announce() so React re-renders even when
  // the same message repeats.
  announcement: string;
  announceSeq: number;

  // Chat-message announcements are kept on their OWN channel, separate from the
  // general announcement above, so they can follow the user's chatAnnounceMode
  // (polite / assertive / spoken / off). `chatPoliteMsg` and `chatAssertiveMsg`
  // feed two always-mounted live regions of the matching politeness — only the
  // one for the active mode is filled. `chatAnnounceSeq` re-keys the region so
  // an identical repeated message is still re-announced. (TTS mode speaks via
  // the browser and leaves both region strings empty.)
  chatAnnounceMode: ChatAnnounceMode;
  chatPoliteMsg: string;
  chatAssertiveMsg: string;
  chatAnnounceSeq: number;

  // "Ask to join" (knock-to-join) for public rooms:
  // - joinRequests: people waiting at the door, shown to participants in a modal
  //   (with a looping knock cue) so they can allow/deny. Empty when nobody waits.
  // - awaitingApproval: set on OUR side while we're the one knocking and waiting
  //   to be let in, so the Room shows a "waiting" screen instead of the spinner.
  joinRequests: JoinRequest[];
  awaitingApproval: boolean;

  // Whether the current room is publicly listed. Gates the vote-to-kick UI
  // (only public rooms can vote-kick). Seeded from the join response and flipped
  // by a `room-public` event if someone makes the room public after we joined.
  roomIsPublic: boolean;
  // Set true when WE were voted out of the room. Room.tsx shows a dedicated
  // "you were removed" screen; cleared on reset (leaving / next join).
  kicked: boolean;

  // Peers
  peers: Map<string, PeerState>;

  // Chat messages in arrival order (newest last). Seeded with room history on
  // join, then appended as `chat-message` events arrive (including our own).
  messages: ChatMessage[];

  // Actions
  setLanguage: (locale: Locale) => void;
  setConnected: (connected: boolean) => void;
  setRoom: (roomName: string, displayName: string, localPeerId: string) => void;
  setMode: (mode: RoomMode) => void;
  setHasMic: (hasMic: boolean) => void;
  setMuted: (muted: boolean) => void;
  setDeafened: (deafened: boolean) => void;
  setPttActive: (active: boolean) => void;
  togglePushToTalk: () => void;
  setDuckingEnabled: (enabled: boolean) => void;
  setSharingAudio: (sharing: boolean) => void;
  setFileStream: (name: string | null) => void;
  setFileStreamPlaying: (playing: boolean) => void;
  setMicGain: (gain: number) => void;
  setMicDeviceId: (deviceId: string) => void;
  setSpeakerDeviceId: (deviceId: string) => void;
  setVoiceProcessingEnabled: (enabled: boolean) => void;
  setHifiVoiceEnabled: (enabled: boolean) => void;
  // Replace the full set of extra mics to stream (the picker writes the new list).
  setStreamedMicDeviceIds: (deviceIds: string[]) => void;
  // Set one device's mono(false)/stereo(true) choice.
  setMicStereoForDevice: (deviceId: string, stereo: boolean) => void;
  setRecording: (recording: boolean, recordingId?: string | null) => void;
  setStreaming: (streaming: boolean) => void;
  setStreamConfig: (config: StreamConfig) => void;
  setStreamError: (error: string | null) => void;
  announce: (message: string) => void;
  announceEvent: (message: string) => void;
  setChatAnnounceMode: (mode: ChatAnnounceMode) => void;
  // Announce a chat message via whichever channel chatAnnounceMode selects.
  announceChat: (message: string) => void;
  setJoinRequests: (requests: JoinRequest[]) => void;
  setAwaitingApproval: (awaiting: boolean) => void;
  setRoomIsPublic: (isPublic: boolean) => void;
  setKicked: (kicked: boolean) => void;
  addMessage: (message: ChatMessage) => void;
  addPeer: (peerId: string, displayName: string) => void;
  removePeer: (peerId: string) => void;
  setPeerSpeaking: (peerId: string, speaking: boolean) => void;
  setPeerMuted: (peerId: string, muted: boolean) => void;
  setPeerVolume: (peerId: string, volume: number) => void;
  // Toggle our local (listener-side) mute of one peer/stream. Pure client state.
  setPeerLocalMute: (peerId: string, muted: boolean) => void;
  setPeerMusic: (peerId: string, isMusic: boolean) => void;
  setPeerMicStream: (peerId: string, isMicStream: boolean) => void;
  // Rename a tile (used when a file streamer swaps files mid-stream: the producer
  // — and thus its tile, keyed by producerId — persists, only its label changes).
  setPeerName: (peerId: string, displayName: string) => void;
  // Update a peer's vote-to-kick tally; `iVoted` is set only when WE toggled
  // (left undefined for others' votes / membership recounts, keeping our state).
  setPeerKickVote: (peerId: string, votes: number, iVoted?: boolean) => void;
  reset: () => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  locale: getLocale(),
  connected: false,
  roomName: null,
  displayName: null,
  localPeerId: null,
  mode: "p2p",
  hasMic: true,
  isMuted: false,
  isDeafened: false,
  isPushToTalk: false,
  pttActive: false,
  duckingEnabled: true,
  isSharingAudio: false,
  fileStreamName: null,
  fileStreamPlaying: false,
  micGain: loadMicGain(),
  micDeviceId: loadString(MIC_DEVICE_KEY),
  speakerDeviceId: loadString(SPEAKER_DEVICE_KEY),
  voiceProcessingEnabled: loadVoiceProcessing(),
  hifiVoiceEnabled: loadHifiVoice(),
  streamedMicDeviceIds: loadStreamedMicDeviceIds(),
  micStereoByDevice: loadMicStereoByDevice(),
  isRecording: false,
  recordingId: null,
  isStreaming: false,
  streamConfig: loadStreamConfig(),
  streamError: null,
  announcement: "",
  announceSeq: 0,
  chatAnnounceMode: loadChatAnnounceMode(),
  chatPoliteMsg: "",
  chatAssertiveMsg: "",
  chatAnnounceSeq: 0,
  joinRequests: [],
  awaitingApproval: false,
  roomIsPublic: false,
  kicked: false,
  peers: new Map(),
  messages: [],

  setLanguage: (locale) => {
    // reload:false — App re-renders in place on the store change below, so a
    // language switch (even mid-call) never tears down the connection.
    applyParaglideLocale(locale, { reload: false });
    document.documentElement.lang = locale;
    set({ locale });
  },
  setConnected: (connected) => set({ connected }),
  setRoom: (roomName, displayName, localPeerId) => set({ roomName, displayName, localPeerId }),
  setMode: (mode) => set({ mode }),
  setHasMic: (hasMic) => set({ hasMic }),
  setMuted: (isMuted) => set({ isMuted }),
  setDeafened: (isDeafened) => set({ isDeafened }),
  setPttActive: (pttActive) => set({ pttActive }),
  togglePushToTalk: () => set((s) => ({ isPushToTalk: !s.isPushToTalk })),
  setDuckingEnabled: (duckingEnabled) => set({ duckingEnabled }),
  setSharingAudio: (isSharingAudio) => set({ isSharingAudio }),
  setFileStream: (fileStreamName) => set({ fileStreamName }),
  setFileStreamPlaying: (fileStreamPlaying) => set({ fileStreamPlaying }),
  setMicGain: (micGain) => {
    try {
      localStorage.setItem(MIC_GAIN_KEY, String(micGain));
    } catch {
      // Persistence is best-effort; keep the in-memory value regardless.
    }
    set({ micGain });
  },
  setMicDeviceId: (micDeviceId) => {
    saveString(MIC_DEVICE_KEY, micDeviceId);
    set({ micDeviceId });
  },
  setSpeakerDeviceId: (speakerDeviceId) => {
    saveString(SPEAKER_DEVICE_KEY, speakerDeviceId);
    set({ speakerDeviceId });
  },
  setVoiceProcessingEnabled: (voiceProcessingEnabled) => {
    saveString(VOICE_PROCESSING_KEY, String(voiceProcessingEnabled));
    set({ voiceProcessingEnabled });
  },
  setHifiVoiceEnabled: (hifiVoiceEnabled) => {
    saveString(HIFI_VOICE_KEY, String(hifiVoiceEnabled));
    set({ hifiVoiceEnabled });
  },
  setStreamedMicDeviceIds: (streamedMicDeviceIds) => {
    saveString(STREAMED_MICS_KEY, JSON.stringify(streamedMicDeviceIds));
    set({ streamedMicDeviceIds });
  },
  setMicStereoForDevice: (deviceId, stereo) =>
    set((s) => {
      const micStereoByDevice = { ...s.micStereoByDevice, [deviceId]: stereo };
      saveString(MIC_STEREO_KEY, JSON.stringify(micStereoByDevice));
      return { micStereoByDevice };
    }),
  setRecording: (isRecording, recordingId) =>
    set((s) => ({
      isRecording,
      recordingId: recordingId !== undefined ? recordingId : s.recordingId,
    })),
  // Going live clears any stale failure from a previous attempt; a stop leaves
  // the last error untouched (stopping doesn't surface one). streaming-failed
  // sets the reason explicitly via setStreamError.
  setStreaming: (isStreaming) =>
    set(isStreaming ? { isStreaming, streamError: null } : { isStreaming }),
  setStreamConfig: (streamConfig) => {
    saveString(STREAM_CONFIG_KEY, JSON.stringify(streamConfig));
    set({ streamConfig });
  },
  setStreamError: (streamError) => set({ streamError }),
  announce: (message) => set((s) => ({ announcement: message, announceSeq: s.announceSeq + 1 })),
  setJoinRequests: (joinRequests) => set({ joinRequests }),
  setAwaitingApproval: (awaitingApproval) => set({ awaitingApproval }),
  setRoomIsPublic: (roomIsPublic) => set({ roomIsPublic }),
  setKicked: (kicked) => set({ kicked }),

  // Room-event announcement (recording/share/music/mute…): speak it AND log it
  // into the chat history as a "system" entry, so chat is the single timeline
  // of everything that was ever announced (rule: announcements go to chat).
  // Bare announce() stays reserved for re-reading chat content that is already
  // in history (incoming messages, the Alt+number readback).
  announceEvent: (message) =>
    set((s) => {
      const ts = Date.now();
      const messages = [
        ...s.messages,
        {
          id: `sys-evt-${ts}-${s.announceSeq + 1}`,
          sender: "",
          text: message,
          ts,
          kind: "system" as const,
        },
      ];
      if (messages.length > CHAT_MESSAGES_MAX)
        messages.splice(0, messages.length - CHAT_MESSAGES_MAX);
      return { announcement: message, announceSeq: s.announceSeq + 1, messages };
    }),

  setChatAnnounceMode: (mode) => {
    saveString(CHAT_ANNOUNCE_KEY, mode);
    set({ chatAnnounceMode: mode });
  },

  // Route a chat-message announcement to the channel the user chose. Each call
  // bumps chatAnnounceSeq so the live-region <span> re-keys (re-announcing an
  // identical repeated line), and fills exactly one of the two region strings
  // (clearing the other) — or, in TTS mode, speaks it and leaves both empty.
  // "off" announces nothing (the message is still rendered + chimed elsewhere).
  announceChat: (message) => {
    const s = get();
    const chatAnnounceSeq = s.chatAnnounceSeq + 1;
    switch (s.chatAnnounceMode) {
      case "off":
        set({ chatAnnounceSeq });
        return;
      case "tts":
        speak(message, s.locale);
        set({ chatAnnounceSeq, chatPoliteMsg: "", chatAssertiveMsg: "" });
        return;
      case "assertive":
        set({ chatAnnounceSeq, chatAssertiveMsg: message, chatPoliteMsg: "" });
        return;
      case "polite":
      default:
        set({ chatAnnounceSeq, chatPoliteMsg: message, chatAssertiveMsg: "" });
        return;
    }
  },

  addMessage: (message) =>
    set((s) => {
      // De-dupe: the sender receives its own message via the room broadcast,
      // and join history may overlap with an in-flight message.
      if (s.messages.some((m) => m.id === message.id)) return s;
      const messages = [...s.messages, message];
      if (messages.length > CHAT_MESSAGES_MAX)
        messages.splice(0, messages.length - CHAT_MESSAGES_MAX);
      return { messages };
    }),

  addPeer: (peerId, displayName) =>
    set((state) => {
      const peers = new Map(state.peers);
      peers.set(peerId, {
        peerId,
        displayName,
        isSpeaking: false,
        isMuted: false,
        volume: 1,
        isMusic: false,
        isMicStream: false,
        kickVotes: 0,
        iVotedKick: false,
        localMuted: false,
      });
      return { peers };
    }),

  removePeer: (peerId) =>
    set((state) => {
      const peers = new Map(state.peers);
      peers.delete(peerId);
      return { peers };
    }),

  setPeerSpeaking: (peerId, speaking) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, isSpeaking: speaking });
      return { peers };
    }),

  setPeerMuted: (peerId, muted) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, isMuted: muted });
      return { peers };
    }),

  setPeerVolume: (peerId, volume) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, volume });
      return { peers };
    }),

  setPeerLocalMute: (peerId, muted) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, localMuted: muted });
      return { peers };
    }),

  setPeerMusic: (peerId, isMusic) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, isMusic });
      return { peers };
    }),

  setPeerMicStream: (peerId, isMicStream) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, isMicStream });
      return { peers };
    }),

  setPeerName: (peerId, displayName) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer) peers.set(peerId, { ...peer, displayName });
      return { peers };
    }),

  setPeerKickVote: (peerId, votes, iVoted) =>
    set((state) => {
      const peers = new Map(state.peers);
      const peer = peers.get(peerId);
      if (peer)
        peers.set(peerId, {
          ...peer,
          kickVotes: votes,
          iVotedKick: iVoted ?? peer.iVotedKick,
        });
      return { peers };
    }),

  reset: () =>
    set({
      connected: false,
      roomName: null,
      displayName: null,
      localPeerId: null,
      mode: "p2p",
      hasMic: true,
      isMuted: false,
      isDeafened: false,
      isPushToTalk: false,
      pttActive: false,
      duckingEnabled: true,
      isSharingAudio: false,
      fileStreamName: null,
      fileStreamPlaying: false,
      isRecording: false,
      recordingId: null,
      // Keep streamConfig (a persisted preference); only the live state resets.
      isStreaming: false,
      streamError: null,
      announcement: "",
      announceSeq: 0,
      // Keep chatAnnounceMode (a persisted preference); only the live strings reset.
      chatPoliteMsg: "",
      chatAssertiveMsg: "",
      chatAnnounceSeq: 0,
      joinRequests: [],
      awaitingApproval: false,
      roomIsPublic: false,
      kicked: false,
      peers: new Map(),
      messages: [],
    }),
}));
