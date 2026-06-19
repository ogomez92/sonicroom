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

// How an announcement is conveyed to the user. A single persisted accessibility
// preference covering BOTH channels — chat messages and room events alike:
//  - "polite"    — announced on a polite ARIA live region (default; queues
//                  behind other screen-reader speech).
//  - "assertive" — announced on an assertive ARIA live region (interrupts).
//  - "tts"       — read aloud by the browser's speech synthesis, for users who
//                  do NOT run a screen reader (see lib/tts).
//  - "off"       — not announced at all (chat still shown in the list; room
//                  events still logged to chat by announceEvent).
export type AnnounceMode = "polite" | "assertive" | "tts" | "off";

function isAnnounceMode(v: string): v is AnnounceMode {
  return v === "assertive" || v === "tts" || v === "off" || v === "polite";
}

const ANNOUNCE_KEY = "sonicroom:announceMode";
// Pre-unification this was the chat-only key; read it as a fallback so anyone
// who'd already picked a mode keeps it after the upgrade.
const LEGACY_CHAT_ANNOUNCE_KEY = "sonicroom:chatAnnounceMode";
// The SpeechSynthesis voiceURI used for spoken (TTS) announcements. "" = the
// browser/OS default voice. Persisted.
const TTS_VOICE_KEY = "sonicroom:ttsVoice";
// Spoken-voice rate (speed) and pitch, persisted. These map onto
// SpeechSynthesisUtterance.rate / .pitch; 1 is normal for both. Ranges are kept
// to the universally-supported band (the platform clamps anything outside).
const TTS_RATE_KEY = "sonicroom:ttsRate";
const TTS_PITCH_KEY = "sonicroom:ttsPitch";
export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 2;
export const TTS_PITCH_MIN = 0;
export const TTS_PITCH_MAX = 2;

function loadAnnounceMode(): AnnounceMode {
  const v = loadString(ANNOUNCE_KEY);
  if (isAnnounceMode(v)) return v;
  const legacy = loadString(LEGACY_CHAT_ANNOUNCE_KEY);
  return isAnnounceMode(legacy) ? legacy : "polite";
}

// Load a persisted TTS rate/pitch, clamped to [min,max]; 1 (normal) on absence
// or anything unparseable.
function loadTtsNumber(key: string, min: number, max: number): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? "");
    if (Number.isFinite(v)) return Math.min(max, Math.max(min, v));
  } catch {
    // localStorage unavailable — fall back to normal.
  }
  return 1;
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

  // Direct, always-polite local feedback that must speak regardless of any
  // announce-mode setting: the Alt+number chat readback, "Copied", and the
  // file-player's own play/pause feedback. `announceSeq` changes on every
  // announce() so React re-renders even when the same message repeats.
  announcement: string;
  announceSeq: number;

  // A single mode (polite/assertive/spoken/off) drives BOTH announcement
  // channels below. For spoken mode: `ttsVoiceURI` is the chosen voice ("" =
  // browser/OS default) and `ttsRate` / `ttsPitch` tune its speed and pitch
  // (1 = normal for both).
  announceMode: AnnounceMode;
  ttsVoiceURI: string;
  ttsRate: number;
  ttsPitch: number;

  // Chat-message announcements are kept on their OWN live-region channel,
  // separate from the general announcement above, and follow announceMode.
  // `chatPoliteMsg` and `chatAssertiveMsg` feed two always-mounted live regions
  // of the matching politeness — only the one for the active mode is filled.
  // `chatAnnounceSeq` re-keys the region so an identical repeated message is
  // still re-announced. (TTS mode speaks via the browser and leaves both empty.)
  chatPoliteMsg: string;
  chatAssertiveMsg: string;
  chatAnnounceSeq: number;

  // Room-event announcements (join/leave/mute/recording/share/music/…) ride
  // their OWN region channel too, following the same announceMode — kept
  // separate from chat so a message and an event don't clobber each other's
  // live-region text: two always-mounted regions (`roomPoliteMsg` /
  // `roomAssertiveMsg`), `roomAnnounceSeq` re-keys them, TTS speaks & leaves
  // both empty.
  roomPoliteMsg: string;
  roomAssertiveMsg: string;
  roomAnnounceSeq: number;

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
  setRecording: (recording: boolean, recordingId?: string | null) => void;
  setStreaming: (streaming: boolean) => void;
  setStreamConfig: (config: StreamConfig) => void;
  setStreamError: (error: string | null) => void;
  // Always-polite local feedback (readback / "Copied" / file play-pause). Never
  // gated by an announce-mode — it's a direct response to the user's own action.
  announce: (message: string) => void;
  // A room event that belongs in the chat timeline (recording/share/music/kick/
  // …): logs it to chat AND speaks it via whichever channel announceMode
  // selects. announceTransient is the same routing WITHOUT the chat-log (for
  // noisy events — peer join/leave/mute, vote tallies).
  announceEvent: (message: string) => void;
  announceTransient: (message: string) => void;
  setAnnounceMode: (mode: AnnounceMode) => void;
  setTtsVoiceURI: (voiceURI: string) => void;
  setTtsRate: (rate: number) => void;
  setTtsPitch: (pitch: number) => void;
  // Announce a chat message via whichever channel announceMode selects.
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
  // Update a peer's vote-to-kick tally; `iVoted` is set only when WE toggled
  // (left undefined for others' votes / membership recounts, keeping our state).
  setPeerKickVote: (peerId: string, votes: number, iVoted?: boolean) => void;
  reset: () => void;
}

// Compute the live-region patch for a room-event announcement in the active
// announceMode (and, for "tts", speak it). Mirrors announceChat's routing:
// fills exactly one of the two region strings (clearing the other) and bumps
// roomAnnounceSeq so a repeated identical line still re-announces; "tts" speaks
// via the browser and leaves both empty; "off" announces nothing. The caller
// merges any extra fields (e.g. the chat-log `messages`) onto the result.
function roomAnnouncePatch(s: RoomState, message: string): Partial<RoomState> {
  const roomAnnounceSeq = s.roomAnnounceSeq + 1;
  switch (s.announceMode) {
    case "off":
      return { roomAnnounceSeq };
    case "tts":
      speak(message, {
        lang: s.locale,
        voiceURI: s.ttsVoiceURI || undefined,
        rate: s.ttsRate,
        pitch: s.ttsPitch,
      });
      return { roomAnnounceSeq, roomPoliteMsg: "", roomAssertiveMsg: "" };
    case "assertive":
      return { roomAnnounceSeq, roomAssertiveMsg: message, roomPoliteMsg: "" };
    case "polite":
    default:
      return { roomAnnounceSeq, roomPoliteMsg: message, roomAssertiveMsg: "" };
  }
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
  isRecording: false,
  recordingId: null,
  isStreaming: false,
  streamConfig: loadStreamConfig(),
  streamError: null,
  announcement: "",
  announceSeq: 0,
  announceMode: loadAnnounceMode(),
  ttsVoiceURI: loadString(TTS_VOICE_KEY),
  ttsRate: loadTtsNumber(TTS_RATE_KEY, TTS_RATE_MIN, TTS_RATE_MAX),
  ttsPitch: loadTtsNumber(TTS_PITCH_KEY, TTS_PITCH_MIN, TTS_PITCH_MAX),
  chatPoliteMsg: "",
  chatAssertiveMsg: "",
  chatAnnounceSeq: 0,
  roomPoliteMsg: "",
  roomAssertiveMsg: "",
  roomAnnounceSeq: 0,
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

  // Room-event announcement (recording/share/music/mute…): log it into the chat
  // history as a "system" entry — so chat is the single timeline of everything
  // that was ever announced (rule: announcements go to chat) — AND speak it via
  // whichever channel announceMode selects (polite/assertive region, TTS, or
  // off). "off" still logs to chat; it just isn't spoken.
  announceEvent: (message) => {
    const s = get();
    const ts = Date.now();
    const messages = [
      ...s.messages,
      {
        id: `sys-evt-${ts}-${s.roomAnnounceSeq + 1}`,
        sender: "",
        text: message,
        ts,
        kind: "system" as const,
      },
    ];
    if (messages.length > CHAT_MESSAGES_MAX)
      messages.splice(0, messages.length - CHAT_MESSAGES_MAX);
    set({ ...roomAnnouncePatch(s, message), messages });
  },

  // A transient room event that should NOT clutter the chat timeline — peer
  // join/leave, mute/unmute, vote tallies. Same announceMode routing as
  // announceEvent, just without the chat log.
  announceTransient: (message) => set(roomAnnouncePatch(get(), message)),

  setAnnounceMode: (mode) => {
    saveString(ANNOUNCE_KEY, mode);
    set({ announceMode: mode });
  },

  setTtsVoiceURI: (ttsVoiceURI) => {
    saveString(TTS_VOICE_KEY, ttsVoiceURI);
    set({ ttsVoiceURI });
  },

  setTtsRate: (rate) => {
    const ttsRate = Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, rate));
    saveString(TTS_RATE_KEY, String(ttsRate));
    set({ ttsRate });
  },

  setTtsPitch: (pitch) => {
    const ttsPitch = Math.min(TTS_PITCH_MAX, Math.max(TTS_PITCH_MIN, pitch));
    saveString(TTS_PITCH_KEY, String(ttsPitch));
    set({ ttsPitch });
  },

  // Route a chat-message announcement to the channel the user chose. Each call
  // bumps chatAnnounceSeq so the live-region <span> re-keys (re-announcing an
  // identical repeated line), and fills exactly one of the two region strings
  // (clearing the other) — or, in TTS mode, speaks it and leaves both empty.
  // "off" announces nothing (the message is still rendered + chimed elsewhere).
  announceChat: (message) => {
    const s = get();
    const chatAnnounceSeq = s.chatAnnounceSeq + 1;
    switch (s.announceMode) {
      case "off":
        set({ chatAnnounceSeq });
        return;
      case "tts":
        speak(message, {
          lang: s.locale,
          voiceURI: s.ttsVoiceURI || undefined,
          rate: s.ttsRate,
          pitch: s.ttsPitch,
        });
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
      // Keep announceMode / ttsVoiceURI (persisted preferences); only the live
      // announcement strings reset.
      chatPoliteMsg: "",
      chatAssertiveMsg: "",
      chatAnnounceSeq: 0,
      roomPoliteMsg: "",
      roomAssertiveMsg: "",
      roomAnnounceSeq: 0,
      joinRequests: [],
      awaitingApproval: false,
      roomIsPublic: false,
      kicked: false,
      peers: new Map(),
      messages: [],
    }),
}));
