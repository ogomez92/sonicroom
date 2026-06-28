// Self-contained socket.on registrars for the routine room-event handlers that
// only sync store state + chime/announce — recording, live streaming, remote
// mute, and chat. Lifted out of useMediasoup's join() so its body shows the
// structurally significant handlers (mode switch, p2p-signal, presence, consume)
// without the noise. These reach the store + sounds + messages directly (all
// module singletons); only the two hook-owned pieces (surfaceToggle, the chat
// hint ref) are passed in.
import type { Socket } from "socket.io-client";
import { useRoomStore } from "../../stores/room";
import { sharedAudioContext } from "../audio/shared-context";
import { playCue } from "../sounds";
import { formatMessage, META_SEP, type ChatMessage } from "../chat";
import {
  announce_a_participant,
  announce_recording_started,
  announce_recording_stopped,
  announce_recording_unavailable,
  announce_streaming_started,
  announce_streaming_stopped,
  announce_streaming_failed,
  announce_streaming_failed_reason,
  announce_peer_muted,
  announce_peer_unmuted,
  announce_chat_hint,
} from "../../paraglide/messages.js";

const store = useRoomStore;

// --- Recording (room-wide; the server forces SFU while recording) ---
export function registerRecordingHandlers(socket: Socket) {
  socket.on("recording-started", ({ recordingId, by }: { recordingId: string; by: string }) => {
    // Two near-simultaneous starts can broadcast this twice for the same
    // recording — announce it only once.
    const s = store.getState();
    if (s.isRecording && s.recordingId === recordingId) return;
    s.setRecording(true, recordingId);
    s.announceEvent(announce_recording_started({ name: by }));
  });

  socket.on("recording-stopped", () => {
    // Keep recordingId so the download link stays available after stopping.
    store.getState().setRecording(false);
    store.getState().announceEvent(announce_recording_stopped());
  });

  // The finished recording was cleaned up server-side (TTL) — drop the link.
  socket.on("recording-expired", () => {
    store.getState().setRecording(false, null);
    store.getState().announceEvent(announce_recording_unavailable());
  });
}

// --- Live streaming (room-wide; the server forces SFU while streaming) ---
export function registerStreamingHandlers(socket: Socket) {
  socket.on("streaming-started", ({ by }: { by: string }) => {
    const s = store.getState();
    if (s.isStreaming) return; // de-dupe near-simultaneous starts
    s.setStreaming(true);
    s.announceEvent(announce_streaming_started({ name: by }));
  });

  socket.on("streaming-stopped", () => {
    if (!store.getState().isStreaming) return;
    store.getState().setStreaming(false);
    store.getState().announceEvent(announce_streaming_stopped());
  });

  // The server's mixer died on its own (bad Icecast target, unreachable, …).
  // `error` is the server's already-classified, human-readable reason — keep it so
  // the Streaming panel can show what to fix, and read it aloud.
  socket.on("streaming-failed", ({ error }: { error?: string } = {}) => {
    const s = store.getState();
    s.setStreaming(false);
    const reason = error?.trim() || "";
    s.setStreamError(reason || null);
    s.announceEvent(
      reason ? announce_streaming_failed_reason({ reason }) : announce_streaming_failed(),
    );
  });
}

type SurfaceToggle = (key: string, value: boolean, emit: () => void) => void;

// A remote peer toggled their mic: reflect it, play a soft cue, and speak it on the
// polite ARIA region. NOT logged to chat (announce, not announceEvent) — too noisy.
// Coalesced per peer (surfaceToggle) so a peer mashing their mic only blips once.
export function registerMuteHandlers(socket: Socket, surfaceToggle: SurfaceToggle) {
  socket.on("peer-muted", ({ peerId }: { peerId: string }) => {
    store.getState().setPeerMuted(peerId, true);
    surfaceToggle(`peer:${peerId}`, true, () => {
      const name = store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
      store.getState().announce(announce_peer_muted({ name }));
      playCue(sharedAudioContext, "peer-mute");
    });
  });

  socket.on("peer-unmuted", ({ peerId }: { peerId: string }) => {
    store.getState().setPeerMuted(peerId, false);
    surfaceToggle(`peer:${peerId}`, false, () => {
      const name = store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
      store.getState().announce(announce_peer_unmuted({ name }));
      playCue(sharedAudioContext, "peer-unmute");
    });
  });
}

// Incoming chat (including the echo of our own messages): render it, chime a cue,
// and announce it via the user's chosen channel (announceChat reads chatAnnounceMode).
// chatHintGiven is flipped once to append the one-time Alt+1..0 readback hint.
export function registerChatHandlers(socket: Socket, chatHintGiven: { current: boolean }) {
  socket.on("chat-message", (msg: ChatMessage) => {
    store.getState().addMessage(msg);
    let announcement = formatMessage(msg, Date.now());
    // First message of the session: tell SR users once that Alt+1..0 reads the
    // recent messages aloud even while the chat panel is closed.
    if (!chatHintGiven.current) {
      chatHintGiven.current = true;
      announcement += `${META_SEP}${announce_chat_hint()}`;
    }
    store.getState().announceChat(announcement);
    playCue(sharedAudioContext, "message");
  });
}
