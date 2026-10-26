// Self-contained socket.on registrars for the routine room-event handlers that
// only sync store state + chime/announce — recording, live streaming, remote
// mute, and chat. Lifted out of useMediasoup's join() so its body shows the
// structurally significant handlers (mode switch, p2p-signal, presence, consume)
// without the noise. These reach the store + sounds + messages directly (all
// module singletons); only the two hook-owned pieces (surfaceToggle, the chat
// hint ref) are passed in.
import type { Socket } from "socket.io-client";
import { useRoomStore } from "../../stores/room";
import { getSharedAudioContext } from "../audio/shared-context";
import { playCue } from "../sounds";
import { altKeyLabel } from "../keys";
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
  announce_chat_hint,
  announce_notes_opened,
  announce_peer_muted_by,
  announce_all_muted,
  announce_admin_named,
  announce_admin_revoked,
  announce_admin_joined,
  announce_you_admin_named,
  announce_you_admin_revoked,
  announce_you_admin_promoted,
  announce_moderation_ended,
  announce_notes_available,
  announce_recording_available,
  announce_you_were_muted,
} from "../../paraglide/messages.js";

const store = useRoomStore;

// --- Recording (room-wide; the server forces SFU while recording) ---
export function registerRecordingHandlers(socket: Socket) {
  // `recordingId` is the download capability. In a moderated room a peer the
  // policy keeps from recording gets null here (and in the join snapshot): the
  // REC badge and the announcement still land, the download buttons don't.
  socket.on(
    "recording-started",
    ({ recordingId, by }: { recordingId: string | null; by: string }) => {
      // Two near-simultaneous starts can broadcast this twice for the same
      // recording — announce it only once.
      const s = store.getState();
      if (s.isRecording && s.recordingId === recordingId) return;
      s.setRecording(true, recordingId);
      s.announceEvent(announce_recording_started({ name: by }));
    },
  );

  // Our access to the recording download changed with our role in a moderated
  // room: a freshly named admin is handed the id (announced, like the notes
  // URL), a revoked one has it withdrawn (silently — the role change itself
  // was just announced; the buttons simply go).
  socket.on("recording-access", ({ recordingId }: { recordingId: string | null }) => {
    const s = store.getState();
    if (s.recordingId === recordingId) return;
    s.setRecording(s.isRecording, recordingId);
    if (recordingId) s.announceEvent(announce_recording_available());
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

// --- Shared notes (room-wide): someone opened this room's collaborative note
// for the first time. Sync the URL so our button flips to "open" and a later
// Alt+N opens it straight away, and log it to chat (rule: room events go to
// chat via announceEvent). Deduped so we don't re-announce a URL we already have
// (e.g. a creator who got the URL from their own ack). ---
export function registerNotesHandlers(socket: Socket) {
  // `by` names the creator; null means the note just became available to US
  // (we were named admin in a room whose notes are admins-only, or the room
  // stopped being moderated) — a different, listener-only announcement.
  socket.on("notes-updated", ({ url, by }: { url: string; by?: string | null }) => {
    if (!url || store.getState().notesUrl === url) return;
    store.getState().setNotesUrl(url);
    store
      .getState()
      .announceEvent(by ? announce_notes_opened({ name: by }) : announce_notes_available());
  });
}

type SurfaceToggle = (key: string, value: boolean, emit: () => void) => void;

// A remote peer toggled their mic: reflect it and play a soft cue — the CUE ONLY,
// deliberately no spoken announcement. A room full of people riding their mute key
// buried everything else under "X muted their microphone"; the tone says the same
// thing in a fraction of the time and the card/participant list carry the state.
// Coalesced per peer (surfaceToggle) so a peer mashing their mic only blips once.
export function registerMuteHandlers(socket: Socket, surfaceToggle: SurfaceToggle) {
  socket.on("peer-muted", ({ peerId, by }: { peerId: string; by?: string }) => {
    store.getState().setPeerMuted(peerId, true);
    // Muted FOR everyone by someone else (moderated room): that IS still spoken and
    // logged to chat by name — a moderation action, not the transient self-mute.
    if (by) {
      const name = store.getState().peers.get(peerId)?.displayName ?? announce_a_participant();
      store.getState().announceEvent(announce_peer_muted_by({ name, by }));
      playCue(getSharedAudioContext(), "peer-mute");
      return;
    }
    surfaceToggle(`peer:${peerId}`, true, () => {
      playCue(getSharedAudioContext(), "peer-mute");
    });
  });

  socket.on("peer-unmuted", ({ peerId }: { peerId: string }) => {
    store.getState().setPeerMuted(peerId, false);
    surfaceToggle(`peer:${peerId}`, false, () => {
      playCue(getSharedAudioContext(), "peer-unmute");
    });
  });
}

// --- MODERATED rooms: admin-set changes, the end of moderation, forced mutes.
// Never fire in an ordinary room (the server has no admins there). `onForcedMute` is the
// hook-owned local mute (track off + producer paused + store), applied when an
// admin muted US — the server already paused our producer, so no emit. ---
export interface AdminChange {
  peerId: string;
  displayName: string;
  isAdmin: boolean;
  reason: "named" | "revoked";
  by: string | null;
}
export function registerAdminHandlers(socket: Socket, onForcedMute: (by: string) => void) {
  socket.on(
    "admins-changed",
    ({
      admins,
      change,
    }: {
      admins: Array<{ peerId: string; displayName: string }>;
      change: AdminChange;
    }) => {
      const s = store.getState();
      s.setAdmins(admins.map((a) => a.peerId));
      const me = change.peerId === s.localPeerId;
      const name = change.displayName;
      const by = change.by ?? "";
      let text: string;
      if (change.isAdmin) {
        // Named by someone — or an admin (re)joined (no `by`).
        text = change.by
          ? me
            ? announce_you_admin_named({ by })
            : announce_admin_named({ name, by })
          : me
            ? announce_you_admin_promoted()
            : announce_admin_joined({ name });
      } else {
        text = me ? announce_you_admin_revoked({ by }) : announce_admin_revoked({ name, by });
      }
      s.announceEvent(text);
    },
  );

  // The last admin left: the room is an ordinary room from now on. Dropping
  // the policy is what un-gates every control (Room.tsx derives all its gates
  // from `moderation`), reopens the chat and brings PoweredBy back; clearing
  // the admin list drops every row's badge. A room event — logged to chat.
  socket.on("moderation-ended", () => {
    const s = store.getState();
    s.setModeration(null);
    s.setAdmins([]);
    s.announceEvent(announce_moderation_ended());
  });

  // Someone muted OUR microphone for everyone. Soft: we may unmute again (M).
  socket.on("you-were-muted", ({ by }: { by: string }) => {
    onForcedMute(by);
    store.getState().announceEvent(announce_you_were_muted({ by }));
    playCue(getSharedAudioContext(), "mute");
  });

  // Someone muted everyone at once (each affected peer also got peer-muted /
  // you-were-muted; this is the one room-level line for the log).
  socket.on("all-muted", ({ by }: { by: string }) => {
    store.getState().announceEvent(announce_all_muted({ by }));
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
      announcement += `${META_SEP}${announce_chat_hint({ alt: altKeyLabel() })}`;
    }
    store.getState().announceChat(announcement);
    playCue(getSharedAudioContext(), "message");
  });
}
