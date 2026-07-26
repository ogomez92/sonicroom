import { useEffect, useCallback, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { Headphones, Users, Loader2, Circle, MessageSquare, Radio } from "lucide-react";
import { useRoomStore } from "../stores/room";
import { useMediasoup } from "../hooks/useMediasoup";
import { formatMessage, messageContent } from "../lib/chat";
import { getInstanceName } from "../lib/branding";
import { ParticipantList } from "./ParticipantList";
import { AudioControls } from "./AudioControls";
import { FileStreamPlayer } from "./FileStreamPlayer";
import { AudioSourceDialog } from "./AudioSourceDialog";
import { Chat } from "./Chat";
import { JoinRequests } from "./JoinRequests";
import { LanguageSelect } from "./LanguageSelect";
import { Footer, PoweredBy } from "./Footer";
import { m } from "../paraglide/messages.js";

type JoinState = "idle" | "joining" | "joined" | "error";

// Max gap between two Alt+<same number> presses for the second to count as a
// "copy that message" double-press rather than a fresh readback.
const DOUBLE_PRESS_MS = 600;

// `?p2p=off` (also accepts false/0/no/disable/disabled) pins the room to the
// SFU even with two participants, instead of the usual P2P mesh.
function isP2pDisabled(value: string | null): boolean {
  if (value == null) return false;
  const v = value.toLowerCase();
  return ["off", "false", "0", "no", "disable", "disabled"].includes(v);
}

// `?public=true` (also accepts 1/yes/on/enable/enabled/public) lists this room
// in the lobby's public directory — flows from the lobby's "Make this room
// public" toggle, and is sticky for the room's lifetime once any joiner sets it.
function isPublicEnabled(value: string | null): boolean {
  if (value == null) return false;
  const v = value.toLowerCase();
  return ["true", "1", "yes", "on", "enable", "enabled", "public"].includes(v);
}

// `?mic=off` (also accepts false/0/no/disable/disabled) joins WITHOUT a
// microphone — listen + text chat only, no mic prompt. Flows from the lobby's
// "Join without a microphone" toggle. (A missing/denied mic falls back to the
// same mode automatically, even without this.)
function isMicDisabled(value: string | null): boolean {
  if (value == null) return false;
  const v = value.toLowerCase();
  return ["off", "false", "0", "no", "disable", "disabled"].includes(v);
}

// When embedded in an iframe (e.g. jitchat), mirror room lifecycle events to the
// host page via postMessage so it can play sounds / reset its view. The event
// names match the Jitsi External API events the host previously relied on. No-op
// when sonic runs as a top-level page.
function postToHost(type: string, payload?: Record<string, unknown>) {
  if (typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage({ source: "sonicroom", type, ...payload }, "*");
  }
}

export function Room() {
  const { roomName } = useParams<{ roomName: string }>();
  const [searchParams] = useSearchParams();
  // P2P-off can come from the URL (?p2p=off) or — so the choice survives a
  // reload/rejoin even if the reloaded link drops the query — from a per-room
  // flag we persist for this tab's session once it's been set.
  const p2pStorageKey = roomName ? `sonicroom:p2p-off:${roomName}` : null;
  const disableP2p =
    isP2pDisabled(searchParams.get("p2p")) ||
    (p2pStorageKey != null && sessionStorage.getItem(p2pStorageKey) === "1");
  const makePublic = isPublicEnabled(searchParams.get("public"));
  const noMic = isMicDisabled(searchParams.get("mic"));
  const navigate = useNavigate();
  const {
    join,
    leave,
    toggleMute,
    toggleDucking,
    toggleAudioShare,
    startFileStream,
    startUrlStream,
    startServerFileStream,
    stopFileStream,
    toggleFilePlayback,
    toggleRecording,
    startStreaming,
    stopStreaming,
    setPeerVolume,
    setPeerLocalMute,
    setMicGain,
    setStreamMonitorVolume,
    sendChatMessage,
    decideJoinRequest,
    voteKick,
    kickCaster,
    stopPeerStream,
    announceSpeakers,
  } = useMediasoup();

  const [joinState, setJoinState] = useState<JoinState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [audioSourceOpen, setAudioSourceOpen] = useState(false);
  // Bumped to (re)focus the chat composer even when the panel is already open —
  // used to hand focus to the call after the knock-to-join modal closes.
  const [chatFocusSignal, setChatFocusSignal] = useState(0);
  const joinedRef = useRef(false);
  const knownPeersRef = useRef<Set<string>>(new Set());
  // How many messages had arrived last time chat was open, to badge unread.
  const seenCountRef = useRef(0);
  // The header chat toggle — focus returns here when the panel closes, so
  // keyboard/SR focus is never dropped onto <body>.
  const chatToggleRef = useRef<HTMLButtonElement>(null);
  // The last Alt+number readback (which digit, and when), so a quick second
  // press of the SAME number copies that message instead of just re-reading it.
  const lastAltNumRef = useRef<{ digit: string; at: number } | null>(null);

  const closeChat = useCallback(() => {
    setChatOpen(false);
    chatToggleRef.current?.focus();
  }, []);

  // When the knock-to-join modal closes (everyone decided), drop focus back into
  // the call WITHOUT opening the chat panel. If chat is already open behind the
  // modal, bump the signal to re-focus its composer; otherwise park focus on the
  // toggle so it never falls onto <body>.
  const onJoinRequestsCleared = useCallback(() => {
    if (chatOpen) setChatFocusSignal((n) => n + 1);
    else chatToggleRef.current?.focus();
  }, [chatOpen]);

  // Hidden local-file picker used by the audio-source chooser. Choosing a file
  // starts — or, mid-stream, replaces — the stream. The floating player handles
  // play/pause + stop after that.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickFile = useCallback(() => {
    setAudioSourceOpen(false);
    fileInputRef.current?.click();
  }, []);
  const onFileChosen = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset so picking the SAME file again still fires `change`.
      e.target.value = "";
      if (file) void startFileStream(file);
    },
    [startFileStream],
  );
  // Toolbar button: stop an active stream, otherwise open the source chooser.
  const toggleFileStream = useCallback(() => {
    if (useRoomStore.getState().fileStreamName != null) void stopFileStream();
    else setAudioSourceOpen(true);
  }, [stopFileStream]);

  const localPeerId = useRoomStore((s) => s.localPeerId);
  const displayName = useRoomStore((s) => s.displayName);
  const peers = useRoomStore((s) => s.peers);
  // Transient numbered badges on the most recent talkers (W shortcut / button).
  const speakerBadges = useRoomStore((s) => s.speakerBadges);
  const isMuted = useRoomStore((s) => s.isMuted);
  const hasMic = useRoomStore((s) => s.hasMic);
  const micGain = useRoomStore((s) => s.micGain);
  const mode = useRoomStore((s) => s.mode);
  const isRecording = useRoomStore((s) => s.isRecording);
  const isStreaming = useRoomStore((s) => s.isStreaming);
  const fileStreamName = useRoomStore((s) => s.fileStreamName);
  const fileStreamPlaying = useRoomStore((s) => s.fileStreamPlaying);
  const streamMonitorVolume = useRoomStore((s) => s.streamMonitorVolume);
  const messages = useRoomStore((s) => s.messages);
  const announcement = useRoomStore((s) => s.announcement);
  const announceSeq = useRoomStore((s) => s.announceSeq);
  // Bare (transient) announcer for local mute toggles — not logged to chat.
  const announce = useRoomStore((s) => s.announce);
  // Chat-message announcements ride their own polite/assertive regions, driven
  // by the user's chatAnnounceMode (the other mode, TTS, speaks via the browser
  // and leaves both strings empty).
  const chatPoliteMsg = useRoomStore((s) => s.chatPoliteMsg);
  const chatAssertiveMsg = useRoomStore((s) => s.chatAssertiveMsg);
  const chatAnnounceSeq = useRoomStore((s) => s.chatAnnounceSeq);
  // True while we're knocking on a public room and waiting to be let in.
  const awaitingApproval = useRoomStore((s) => s.awaitingApproval);
  // Whether the room is public (shows the vote-to-kick controls) and whether we
  // ourselves were just voted out (shows the "removed" screen).
  const roomIsPublic = useRoomStore((s) => s.roomIsPublic);
  const kicked = useRoomStore((s) => s.kicked);

  // Reflect the room name in the document/tab title while in (or joining) the
  // room, restoring the default when we leave.
  useEffect(() => {
    if (!roomName) return;
    const instance = getInstanceName();
    document.title = `${roomName} · ${instance}`;
    return () => {
      document.title = instance;
    };
  }, [roomName]);

  // Unread count for the chat toggle badge; resets whenever the panel is open.
  useEffect(() => {
    if (chatOpen) seenCountRef.current = messages.length;
  }, [chatOpen, messages.length]);
  const unread = chatOpen ? 0 : Math.max(0, messages.length - seenCountRef.current);

  // Join on mount. An embedder (e.g. jitchat) can deep-link straight into a
  // room with ?displayName=... to skip the lobby name prompt; otherwise we fall
  // back to the name the Lobby stashed in sessionStorage.
  useEffect(() => {
    if (joinedRef.current || !roomName) return;
    const fromQuery = searchParams
      .get("displayName")
      ?.replace(/[<>"'&]/g, "")
      .trim();
    const name = fromQuery || sessionStorage.getItem("sonicroom:displayName");
    if (!name) {
      navigate(`/?room=${encodeURIComponent(roomName)}`);
      return;
    }
    sessionStorage.setItem("sonicroom:displayName", name);

    joinedRef.current = true;
    setJoinState("joining");

    // Remember the p2p-off choice for this room/tab so a later reload or rejoin
    // re-asserts it even without the URL param.
    if (disableP2p && p2pStorageKey) sessionStorage.setItem(p2pStorageKey, "1");

    join(roomName, name, { disableP2p, isPublic: makePublic, noMic })
      .then(() => setJoinState("joined"))
      .catch((err) => {
        setJoinState("error");
        // A declined knock-to-join request (or a prior deny that banned this IP
        // from the room) gets a friendlier, localized message than the raw
        // sentinel the hook/server rejects with.
        const msg = err instanceof Error ? err.message : "";
        setErrorMsg(
          msg === "join_denied" || msg === "banned"
            ? m.room_join_denied()
            : msg || m.room_failed_to_join(),
        );
      });
  }, [roomName, join, navigate, disableP2p, makePublic, noMic, p2pStorageKey, searchParams]);

  // Mirror room lifecycle to the host page when embedded (see postToHost).
  useEffect(() => {
    if (joinState === "joined") postToHost("videoConferenceJoined");
  }, [joinState]);

  useEffect(() => {
    if (joinState !== "joined") return;
    const known = knownPeersRef.current;
    const current = new Set(peers.keys());
    for (const id of current) {
      if (!known.has(id)) postToHost("participantJoined", { peerId: id });
    }
    for (const id of known) {
      if (!current.has(id)) postToHost("participantLeft", { peerId: id });
    }
    knownPeersRef.current = current;
  }, [peers, joinState]);

  // Keyboard shortcuts
  useEffect(() => {
    if (joinState !== "joined") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // While the knock-to-join modal is up it owns the keyboard — don't let any
      // room shortcut (mute, share, Alt+number readback, …) fire underneath it.
      if (useRoomStore.getState().joinRequests.length > 0) return;

      // Alt+1..9 and Alt+0 read the last 10 messages aloud via the ARIA region:
      // 1 = newest, 2 = next, … 0 = the 10th most recent. Pressing the SAME
      // number again within DOUBLE_PRESS_MS copies that message to the clipboard
      // (the same body the chat panel's Ctrl+C copies) — so it's grabbable
      // without opening the panel. The listener is on window, so it works
      // whether the chat panel is open or closed. Match the *physical* number
      // key (e.code) rather than e.key so it fires regardless of layout — on
      // AZERTY/macOS-Option/AltGr, Alt+1 yields a non-digit e.key (which is why
      // it appeared to only work with the composer focused). Plain e.key digits
      // stay as a fallback. Checked before the input guard below so it also
      // works while typing in the composer.
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const digit =
          /^(?:Digit|Numpad)([0-9])$/.exec(e.code)?.[1] ?? (/^[0-9]$/.test(e.key) ? e.key : null);
        if (digit != null) {
          e.preventDefault();
          const n = digit === "0" ? 10 : Number(digit);
          const { messages: msgs, announce } = useRoomStore.getState();
          const msg = msgs[msgs.length - n];
          const now = Date.now();
          const prev = lastAltNumRef.current;
          // Second quick press of the same digit on an existing message → copy.
          if (msg && prev && prev.digit === digit && now - prev.at < DOUBLE_PRESS_MS) {
            lastAltNumRef.current = null;
            void navigator.clipboard
              ?.writeText(messageContent(msg))
              .then(() => announce(m.chat_copied()));
            return;
          }
          lastAltNumRef.current = { digit, at: now };
          announce(msg ? formatMessage(msg, now) : m.room_no_message({ n }));
          return;
        }
      }

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Single-letter room shortcuts must not hijack browser/OS combos like
      // Ctrl+R (reload), Alt+D (address bar) or Cmd+R — bail when any of
      // Ctrl/Alt/Meta is held. (Shift stays allowed: it's how the uppercase
      // variants handled below get produced.)
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleMute();
      } else if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        toggleAudioShare();
      } else if (e.key === "f" || e.key === "F") {
        // Open the audio-source chooser.
        e.preventDefault();
        setAudioSourceOpen(true);
      } else if (e.key === "d" || e.key === "D") {
        // Toggle room-wide auto-ducking.
        e.preventDefault();
        toggleDucking();
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        toggleRecording();
      } else if (e.key === "w" || e.key === "W") {
        // Announce + briefly number the people talking now / who talked recently.
        e.preventDefault();
        announceSpeakers();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [joinState, toggleMute, toggleAudioShare, toggleDucking, toggleRecording, announceSpeakers]);

  const handleLeave = useCallback(() => {
    postToHost("readyToClose");
    leave();
    navigate("/");
  }, [leave, navigate]);

  // Loading state — or, for a public room, waiting to be let in (knock-to-join).
  if (joinState === "joining") {
    return (
      <div className="flex min-h-dvh flex-col bg-sonic-900">
        <div className="flex flex-1 items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-4 px-4 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-sonic-accent" />
            {/* One STABLE assertive live region (always mounted while joining), so
              the connecting → "waiting to be let in" change is reliably read out
              with priority — it interrupts other speech instead of queueing
              behind it. (Swapping a freshly-mounted region in/out announces
              unreliably, hence the single persistent node.) */}
            <p className="text-sonic-300" role="alert" aria-live="assertive" aria-atomic="true">
              {awaitingApproval ? m.room_awaiting_approval() : m.room_connecting()}
            </p>
            {awaitingApproval && (
              <button
                onClick={handleLeave}
                className="rounded-lg bg-sonic-700 px-4 py-2 text-sm text-sonic-100 hover:bg-sonic-600"
              >
                {m.room_cancel_request()}
              </button>
            )}
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  // Error state
  if (joinState === "error") {
    return (
      <div className="flex min-h-dvh flex-col bg-sonic-900">
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="text-lg text-muted">{errorMsg}</p>
            <button
              onClick={() => navigate("/")}
              className="rounded-lg bg-sonic-accent px-4 py-2 text-sm text-white hover:bg-sonic-accent/90"
            >
              {m.room_back_to_lobby()}
            </button>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  // Voted out of the room: a modal dialog overlays the room (this happens after
  // we'd already joined, so it's separate from the join error state above).
  // The SR text was already announced via announceEvent when the kick arrived.
  const kickedDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (kicked) kickedDialogRef.current?.showModal();
  }, [kicked]);

  const peerList = Array.from(peers.values());
  // Vote-to-kick needs a real group — it's disabled (controls hidden, like a
  // private room) below 3 votable people. Votable = humans only: everyone except
  // media-source tiles (music casters and extra-mic streams), plus ourself (+1).
  const votableCount = peerList.filter((p) => !p.isMusic && !p.isMicStream).length + 1;
  const kickEnabled = roomIsPublic && votableCount >= 3;

  return (
    <div className="flex min-h-dvh flex-col bg-sonic-900">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-sonic-700 px-6 py-3">
        <div className="flex items-center gap-3">
          <Headphones className="h-5 w-5 text-sonic-accent" />
          <h1 className="text-lg font-semibold text-sonic-100">{roomName}</h1>
        </div>
        <div className="flex items-center gap-3 text-sm text-sonic-300">
          {isRecording && (
            <span
              className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium bg-red-500/20 text-red-400"
              title={m.room_recording_title()}
            >
              <Circle className="h-2.5 w-2.5 animate-pulse fill-red-500 text-red-500" />
              REC
            </span>
          )}
          {isStreaming && (
            <span
              className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium bg-purple-500/20 text-purple-300"
              title={m.room_streaming_title()}
            >
              <Radio className="h-2.5 w-2.5 animate-pulse" />
              LIVE
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-medium ${
              mode === "p2p" ? "bg-green-500/20 text-green-400" : "bg-blue-500/20 text-blue-400"
            }`}
          >
            {mode === "p2p" ? "P2P" : "SFU"}
          </span>
          <div className="flex items-center gap-1">
            <Users className="h-4 w-4" />
            <span>{peerList.length + 1}</span>
          </div>
          <button
            ref={chatToggleRef}
            onClick={() => (chatOpen ? closeChat() : setChatOpen(true))}
            className={`relative flex h-8 items-center gap-1.5 rounded-full px-3 transition-all ${
              chatOpen
                ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
                : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
            }`}
            aria-label={
              unread > 0
                ? chatOpen
                  ? m.room_chat_close_unread({ count: unread })
                  : m.room_chat_open_unread({ count: unread })
                : chatOpen
                  ? m.room_chat_close()
                  : m.room_chat_open()
            }
            aria-expanded={chatOpen}
            title={m.room_toggle_chat_title()}
          >
            <MessageSquare className="h-4 w-4" />
            {unread > 0 && (
              <span
                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white"
                aria-hidden="true"
              >
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
          <LanguageSelect />
        </div>
      </header>

      {/* Participants grid + optional chat side panel */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <main className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto p-6">
          {/* Self + everyone (and every stream) as one keyboard-navigable
              listbox; Enter on a row opens that participant's options (volume,
              local mute, vote-to-kick), self's being the mic level. */}
          {localPeerId && displayName && (
            <ParticipantList
              selfPeer={{
                peerId: localPeerId,
                displayName,
                isSpeaking: false,
                isMuted,
                volume: 1,
                isMusic: false,
                isCaster: false,
                isMicStream: false,
                kickVotes: 0,
                iVotedKick: false,
                localMuted: false,
              }}
              peerList={peerList}
              hasMic={hasMic}
              micGain={micGain}
              onMicGainChange={hasMic ? setMicGain : undefined}
              onVolumeChange={setPeerVolume}
              onLocalMuteChange={setPeerLocalMute}
              kickEnabled={kickEnabled}
              onToggleKick={(id) => voteKick(id, !peers.get(id)?.iVotedKick)}
              onKickCaster={kickCaster}
              onStopStream={stopPeerStream}
              announce={announce}
              speakerBadges={speakerBadges}
            />
          )}
        </main>

        {chatOpen && (
          <Chat onSend={sendChatMessage} onClose={closeChat} focusSignal={chatFocusSignal} />
        )}
      </div>

      {/* Bottom controls + attribution. The "Powered by SonicRoom" link lives
          inside this single footer landmark (rather than a second <Footer />) so
          the active call keeps exactly one `contentinfo`. */}
      <footer className="flex flex-col items-center gap-2 border-t border-sonic-700 p-4">
        <AudioControls
          onToggleMute={toggleMute}
          onToggleAudioShare={toggleAudioShare}
          onToggleFileStream={toggleFileStream}
          onToggleDucking={toggleDucking}
          onToggleRecording={toggleRecording}
          onStartStreaming={startStreaming}
          onStopStreaming={stopStreaming}
          onAnnounceSpeakers={announceSpeakers}
          onLeave={handleLeave}
        />
        <PoweredBy />
      </footer>

      {/* Screen reader announcements (peer join/leave, recording, etc.).
          key changes per announcement so identical messages re-announce. */}
      <div aria-live="polite" role="status" className="sr-only" id="sr-announcements">
        <span key={announceSeq}>{announcement}</span>
      </div>

      {/* Chat-message announcements on their OWN regions so they can follow the
          user's preference (Chat panel → "Announce new messages"). Both are
          always mounted; announceChat fills only the one for the active mode
          (polite or assertive), or neither in spoken-TTS / off modes. The key
          re-mounts the span so a repeated identical message re-announces. */}
      <div aria-live="polite" role="status" className="sr-only" id="sr-chat-polite">
        <span key={`cp-${chatAnnounceSeq}`}>{chatPoliteMsg}</span>
      </div>
      <div aria-live="assertive" role="alert" className="sr-only" id="sr-chat-assertive">
        <span key={`ca-${chatAnnounceSeq}`}>{chatAssertiveMsg}</span>
      </div>

      {/* Knock-to-join: allow/deny people asking to enter this public room.
          Self-hides when nobody is waiting. */}
      <JoinRequests onDecide={decideJoinRequest} onCleared={onJoinRequestsCleared} />

      {audioSourceOpen && (
        <AudioSourceDialog
          onClose={() => setAudioSourceOpen(false)}
          onChooseComputerFile={pickFile}
          onStartUrl={startUrlStream}
          onStartServerFile={startServerFileStream}
        />
      )}

      {/* Hidden local-file picker opened from the audio-source chooser. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        onChange={onFileChosen}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* Floating player for the local-file stream — autofocuses play/pause when
          a file is picked; Escape stops the stream and closes it. */}
      {fileStreamName && (
        <FileStreamPlayer
          name={fileStreamName}
          playing={fileStreamPlaying}
          onTogglePlay={toggleFilePlayback}
          onStop={() => stopFileStream()}
          volume={streamMonitorVolume}
          onVolumeChange={setStreamMonitorVolume}
        />
      )}

      {/* Kicked modal — overlays the room; focus is trapped inside. */}
      <dialog
        ref={kickedDialogRef}
        className="m-auto rounded-2xl border border-sonic-700 bg-sonic-900 p-8 text-center shadow-2xl backdrop:bg-black/60"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex max-w-sm flex-col items-center gap-4">
          <p className="text-lg font-semibold text-sonic-100" role="alert">
            {m.room_kicked_title()}
          </p>
          <p className="text-sm text-muted">{m.room_kicked_body()}</p>
          <button
            onClick={() => navigate("/")}
            className="mt-2 rounded-lg bg-sonic-accent px-4 py-2 text-sm font-medium text-white hover:bg-sonic-accent/90"
          >
            {m.room_back_to_lobby()}
          </button>
        </div>
      </dialog>
    </div>
  );
}
