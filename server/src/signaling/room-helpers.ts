import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { admittedNameKey, removePeer, type Room, type Peer } from "../room-manager.js";
import { decideMode } from "../recording-util.js";
import { kickThreshold } from "../kick-util.js";
import { allowed, voteIsAdminsOnly } from "../moderation-util.js";
import { CHAT_HISTORY_MAX, type ChatMessage } from "../chat-util.js";
import type { RecordingManager } from "../recording.js";
import type { StreamManager } from "../streaming.js";

export function closeSfuResources(peer: Peer) {
  peer.sendTransport?.close();
  peer.sendTransport = null;
  peer.recvTransport?.close();
  peer.recvTransport = null;
  peer.producers.clear();
  peer.consumers.clear();
}

// Best-effort client IP for room-scoped knock bans. Behind the TLS-terminating
// reverse proxy that fronts this server, the socket's own address is the proxy
// (127.0.0.1), so prefer the left-most X-Forwarded-For entry (the original
// client) when present, else the direct peer address. A soft ban: a determined
// evader can change IP, and NAT means a ban can catch a household — good enough
// to shut out the obvious repeat knocker.
export function clientIp(socket: Socket): string {
  const xff = socket.handshake.headers["x-forwarded-for"];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(",")[0];
  return (first || socket.handshake.address || "").trim();
}

// Room-scoped operations shared across the connection handlers — mode switching,
// teardown, kick settlement, chat fan-out, ducking. Bound once per server to the
// io instance and the recording/stream managers; the per-connection handlers in
// ./handlers/* receive the returned object via the connection context.
export function createRoomHelpers(
  io: Server,
  recordingManager: RecordingManager,
  streamManager: StreamManager,
) {
  // Append a message to the room's bounded history and fan it out to everyone
  // in the room — INCLUDING the original sender, so the sender's own client
  // also gets the echo to render, announce, and chime on.
  function deliverChatMessage(room: Room, sender: string, text: string): ChatMessage {
    const msg: ChatMessage = { id: randomUUID(), sender, text, ts: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > CHAT_HISTORY_MAX) {
      room.messages.splice(0, room.messages.length - CHAT_HISTORY_MAX);
    }
    io.to(room.name).emit("chat-message", msg);
    return msg;
  }

  // The room must be pinned to the SFU when the server has to see/route the
  // media itself: while recording, or while a send-only "music caster" peer
  // (Ecobox) is present (a caster produces but never sets up P2P). P2P can also
  // be disabled outright for the room via the `?p2p=off` URL param.
  function shouldForceSfu(room: Room): boolean {
    return (
      recordingManager.isRecording(room.name) ||
      streamManager.isStreaming(room.name) ||
      room.casters.size > 0 ||
      room.sharers.size > 0 ||
      room.fileStreamers.size > 0 ||
      room.extraMicStreamers.size > 0 ||
      room.disableP2p ||
      // A video room never uses the P2P mesh: camera/screen video are separate
      // producers the server has to route, so the room is pinned from its
      // first join (before anyone turns a camera on) — no SFU↔P2P flap when
      // the first camera comes on or the last goes off.
      room.isVideo ||
      // A MODERATED room is pinned too: "mute X for everyone" is enforced by
      // the server pausing X's voice producer, which only exists on the SFU
      // (P2P media never touches the server).
      room.moderation != null
    );
  }

  // --- Moderated rooms: admins ---

  function isAdmin(room: Room, peerId: string): boolean {
    return room.admins.has(peerId);
  }

  // The current admins, for the join snapshot and the `admins-changed`
  // broadcast (ids + names, so clients can announce by name).
  function adminList(room: Room): { peerId: string; displayName: string }[] {
    const out: { peerId: string; displayName: string }[] = [];
    for (const id of room.admins) {
      const p = room.peers.get(id);
      if (p) out.push({ peerId: id, displayName: p.displayName });
    }
    return out;
  }

  // Tell the whole room the admin set changed: who changed (and how) plus the
  // full current list, so every client re-flags its participant rows and
  // announces the change through announceEvent (it's a room event).
  function emitAdminsChanged(
    room: Room,
    change: {
      peerId: string;
      displayName: string;
      isAdmin: boolean;
      reason: "named" | "revoked";
      by: string | null;
    },
  ) {
    io.to(room.name).emit("admins-changed", { admins: adminList(room), change });
  }

  // Whether this peer may decide knock requests: anyone in an unmoderated
  // public room (today's rule); in a moderated room, per its approveJoins.
  function canApproveJoins(room: Room, peerId: string): boolean {
    if (!room.moderation) return true;
    return room.moderation.approveJoins === "everyone" || isAdmin(room, peerId);
  }

  // Whether this peer may open the room's shared notes (per the moderated
  // room's `notes` setting; anyone in an ordinary room). Access to a note IS
  // its link, so this also gates who is ever handed the URL.
  function canOpenNotes(room: Room, peerId: string): boolean {
    return allowed(room.moderation, isAdmin(room, peerId), "notes");
  }

  // Hand the room's note URL (if it has one) to every peer allowed to open it
  // — or, with `only`, to that one peer (a freshly named admin). `by` names
  // the creator for the announcement; null means "it just became available
  // to you" (the client dedupes against a URL it already holds).
  function sendNotesUrl(room: Room, by: string | null, only?: string) {
    if (!room.notesUrl) return;
    const payload = { url: room.notesUrl, by };
    const targets = only ? [only] : [...room.peers.keys()];
    for (const id of targets) {
      if (canOpenNotes(room, id)) io.to(id).emit("notes-updated", payload);
    }
  }

  // Whether this peer may record — and therefore DOWNLOAD a recording. The
  // download endpoints are capability-keyed on the recording id (no session),
  // so "may download" is decided by who is ever handed the id: it is nulled in
  // the join snapshot / `recording-started` / `recording-stopped` for a peer
  // the policy keeps from recording, mirroring the notes URL.
  function canRecord(room: Room, peerId: string): boolean {
    return allowed(room.moderation, isAdmin(room, peerId), "recording");
  }

  // Hand the room's recording id (in progress or finished-but-downloadable) to
  // every peer allowed to record — or, with `only`, to that one peer (a freshly
  // named admin). `recordingId: null` withdraws it (a revoked admin — their
  // buttons go with the role; a file they already fetched is theirs).
  function sendRecordingAccess(room: Room, only?: string, withdraw = false) {
    const rec = recordingManager.getRecording(room.name);
    if (!rec && !withdraw) return;
    const targets = only ? [only] : [...room.peers.keys()];
    for (const id of targets) {
      const ok = canRecord(room, id);
      if (withdraw && ok) continue;
      io.to(id).emit("recording-access", { recordingId: ok && rec ? rec.id : null });
    }
  }

  // Auto-ducking: the room's AudioLevelObserver watches VOICE producers only
  // (music producers are never added — see the produce handler), so it fires
  // 'volumes' when someone talks and 'silence' when nobody does. We broadcast a
  // `duck` event on each transition; listeners ramp the music peer's gain down
  // while a voice is active. Wired once per room.
  function wireDucking(room: Room) {
    if (room.observerWired) return;
    room.observerWired = true;
    room.audioLevelObserver.on("volumes", () => {
      if (room.voiceActive) return;
      room.voiceActive = true;
      io.to(room.name).emit("duck", { active: true });
    });
    room.audioLevelObserver.on("silence", () => {
      if (!room.voiceActive) return;
      room.voiceActive = false;
      io.to(room.name).emit("duck", { active: false });
    });
  }

  // --- Evaluate room mode and trigger switches ---
  // A recording (or an active music caster) forces SFU and prevents the usual
  // downgrade to P2P, so the server keeps seeing the media.
  // exceptSocketId: when a newly-joined peer pushes the room into SFU, that peer
  // already learned mode:"sfu" from its join response and sets up the SFU from
  // it — so it must be EXCLUDED from the switch broadcast, or it would set up
  // SFU twice concurrently (duplicate transports → "connect() already called",
  // and one transport that never finishes connecting).
  function applyModeDecision(room: Room, exceptSocketId?: string) {
    const decision = decideMode(room.peers.size, room.mode, shouldForceSfu(room));
    if (decision.action === "none") return;

    room.mode = decision.mode;
    const targets = exceptSocketId ? io.to(room.name).except(exceptSocketId) : io.to(room.name);
    if (decision.action === "switch-to-sfu") {
      console.log(`[room:${room.name}] switching to SFU (${room.peers.size} peers)`);
      targets.emit("switch-to-sfu", {
        rtpCapabilities: room.router.rtpCapabilities,
      });
    } else {
      console.log(`[room:${room.name}] switching to P2P (${room.peers.size} peers)`);
      for (const peer of room.peers.values()) {
        closeSfuResources(peer);
      }
      const peerIds = Array.from(room.peers.keys());
      targets.emit("switch-to-p2p", { peerIds });
    }
  }

  // Push the room's current "ask to join" queue to everyone already inside, so
  // each participant's modal reflects who is waiting at the door right now. The
  // requesters themselves aren't in the socket.io room yet, so they never see
  // their own knock. Keyed by socket id, which is also the decision target.
  // In a moderated room whose approveJoins is admins-only, only the admins get
  // the queue (everyone else never sees the modal or hears the knock).
  function broadcastJoinRequests(room: Room) {
    const payload = {
      requests: Array.from(room.pendingJoins.entries()).map(([id, p]) => ({
        id,
        displayName: p.displayName,
      })),
    };
    if (room.moderation && room.moderation.approveJoins === "admins") {
      for (const adminId of room.admins) io.to(adminId).emit("join-requests", payload);
      return;
    }
    io.to(room.name).emit("join-requests", payload);
  }

  // --- Vote-to-kick (public rooms only; no moderators) ---

  // How many peers count toward the kick threshold: everyone EXCEPT casters
  // (send-only infra like Ecobox, which never votes and can't be kicked). The
  // target is included, matching kickThreshold's `n`.
  function votablePeerCount(room: Room): number {
    let n = 0;
    for (const id of room.peers.keys()) if (!room.casters.has(id)) n++;
    return n;
  }

  // How many people the kick threshold is computed over: every human in an
  // ordinary public room or an "everyone votes" moderated room; only the admins
  // when the moderated room's kick policy is a vote among admins.
  function kickElectorateCount(room: Room): number {
    if (room.moderation && voteIsAdminsOnly(room.moderation)) {
      let n = 0;
      for (const id of room.admins) if (room.peers.has(id) && !room.casters.has(id)) n++;
      return n;
    }
    return votablePeerCount(room);
  }

  // Drop a departing peer from the kick tallies: their own pending removal vote
  // tally is moot, and any votes THEY cast against others are retracted. Each
  // affected target gets a `recount` so everyone's "(N votes)" label updates
  // (silent — no "withdrew" announcement, since this is a leave, not a choice).
  function cleanupKickVotes(room: Room, departedId: string) {
    room.kickVotes.delete(departedId);
    for (const [targetId, voters] of room.kickVotes) {
      if (!voters.delete(departedId)) continue;
      if (voters.size === 0) room.kickVotes.delete(targetId);
      io.to(room.name).emit("kick-vote", {
        targetId,
        targetName: room.peers.get(targetId)?.displayName ?? "",
        votes: voters.size,
        voterId: null,
        voterName: null,
        action: "recount",
      });
    }
  }

  // Drop every vote AGAINST one peer and tell the room (tally back to 0) —
  // for someone who just became an admin, since admins are never a vote's
  // target. (cleanupKickVotes is the departed-VOTER counterpart.)
  function dropKickVotesAgainst(room: Room, targetId: string) {
    if (!room.kickVotes.delete(targetId)) return;
    io.to(room.name).emit("kick-vote", {
      targetId,
      targetName: room.peers.get(targetId)?.displayName ?? "",
      votes: 0,
      voterId: null,
      voterName: null,
      action: "recount",
    });
  }

  // Remove one peer from the room and clean up everything they held — the shared
  // teardown for BOTH a normal disconnect and a vote-kick. `announceLeft` is
  // false for a kick (peers already got `peer-kicked` instead of `peer-left`).
  // No-ops if the peer is already gone, so a kicked socket's own later disconnect
  // doesn't double-fire.
  function teardownPeer(room: Room, peerId: string, opts: { announceLeft: boolean }) {
    const peer = room.peers.get(peerId);
    if (!peer) return;

    if (opts.announceLeft) {
      io.to(room.name).except(peerId).emit("peer-left", { peerId });
    }

    // Stop capturing/feeding this peer's producers (already-recorded audio stays
    // on disk and is still included in downloads).
    if (recordingManager.isRecording(room.name)) {
      for (const producerId of peer.producers.keys()) {
        void recordingManager.removeProducer(room.name, producerId).catch(() => {});
      }
    }
    if (streamManager.isStreaming(room.name)) {
      for (const producerId of peer.producers.keys()) {
        void streamManager.removeProducer(room.name, producerId).catch(() => {});
      }
    }
    // If this was the last peer, the room is about to be destroyed — drop any
    // recording (active or finished-but-downloadable) and tear down any stream.
    if (room.peers.size <= 1 && recordingManager.getRecording(room.name)) {
      void recordingManager.discard(room.name).catch(() => {});
    }
    if (room.peers.size <= 1 && streamManager.isStreaming(room.name)) {
      void streamManager.stop(room.name).catch(() => {});
    }

    // Drop from the caster/sharer/file-streamer/extra-mic sets before removePeer
    // (which may destroy the room) so the mode decision no longer forces SFU once
    // this music caster / audio-sharer / file-streamer / extra-mic peer is gone.
    room.casters.delete(peerId);
    room.sharers.delete(peerId);
    room.fileStreamers.delete(peerId);
    room.extraMicStreamers.delete(peerId);
    cleanupKickVotes(room, peerId);
    // An admin who leaves stops being one for this socket id (their token stays
    // in adminTokens, so a reconnect brings the role back).
    room.admins.delete(peerId);

    removePeer(room, peerId);

    if (room.peers.size > 0) {
      // Before the mode decision: a room that just stopped being moderated
      // loses its SFU pin, and applyModeDecision must see that.
      endModerationIfNoAdmins(room);
      applyModeDecision(room);
    } else if (room.pendingJoins.size > 0) {
      // The room just emptied while someone was still knocking — their request
      // can never be answered now, so let them go (their client surfaces the
      // denial and can retry, landing in the now-empty room).
      for (const reqId of room.pendingJoins.keys()) io.to(reqId).emit("join-denied", {});
      room.pendingJoins.clear();
    }
  }

  // When the LAST admin of a moderated room leaves while people remain, the
  // room stops being moderated: the policy is dropped, so from here on it
  // behaves exactly like an ordinary private/public room (every control comes
  // back, knocks can be answered by anyone, the chat reopens), and everyone is
  // told (`moderation-ended`, announced + logged client-side). Nobody is
  // promoted — an admin role handed to whoever happened to be there longest
  // was the alternative, and it was ruled out. The admin tokens go too: a
  // former admin who reconnects comes back as a regular participant, because
  // there is no moderated room to be an admin of any more. Pending knockers
  // are re-broadcast because the set of people who may answer them has just
  // widened to everyone.
  // A RESERVED room is the exception: its policy belongs to the reservation,
  // not to whoever is inside, and the host can return as admin with the key
  // at any time — so it stays moderated with (for now) no admin present.
  function endModerationIfNoAdmins(room: Room) {
    if (!room.moderation || room.admins.size > 0 || room.reserved) return;
    room.moderation = null;
    room.adminTokens.clear();
    console.log(`[ws] last admin left ${room.name}: room is no longer moderated`);
    io.to(room.name).emit("moderation-ended", {});
    if (room.pendingJoins.size > 0) broadcastJoinRequests(room);
    // Likewise the shared note and the recording download, if they were
    // admins-only until now.
    sendNotesUrl(room, null);
    sendRecordingAccess(room);
  }

  // Remove a peer the room voted out — or, in a moderated room, one an admin
  // removed directly (`reason: "admin"`, with the remover's name). Tells the
  // room (`peer-kicked`) and the target (`you-were-kicked`), room-bans their IP
  // so they can't immediately walk back in (the same soft ban a knock-deny
  // applies), tears them down, then force-disconnects their socket. Emitting
  // before disconnecting flushes the notice to them first; a server-initiated
  // disconnect won't auto-reconnect. (A caster removal is NOT a kick — it goes
  // through kick-caster, which does NOT ban; `reason` lets the client tell the
  // announcements apart.)
  function kickPeer(
    room: Room,
    targetId: string,
    reason: "vote" | "admin" = "vote",
    by: string | null = null,
  ) {
    const target = room.peers.get(targetId);
    if (!target) {
      room.kickVotes.delete(targetId);
      return;
    }
    if (target.ip) room.bannedIps.add(target.ip);
    room.admittedNames.delete(admittedNameKey(target.ip, target.displayName));
    // A removed admin loses the role for good (their token too), so they can't
    // come back as an admin even if the ban doesn't catch them.
    if (target.token) room.adminTokens.delete(target.token);

    io.to(room.name).except(targetId).emit("peer-kicked", {
      peerId: targetId,
      displayName: target.displayName,
      reason,
      by,
    });
    io.to(targetId).emit("you-were-kicked", { reason, by });
    console.log(
      `[ws] ${target.displayName} (${targetId}) kicked from ${room.name} ${reason === "admin" ? `by ${by}` : "by vote"}`,
    );

    teardownPeer(room, targetId, { announceLeft: false });
    io.sockets.sockets.get(targetId)?.disconnect(true);
  }

  // Remove every target that has reached the current threshold. A kick shrinks
  // the room, which lowers the threshold and can push the next target over the
  // line, so loop until nobody qualifies (bounded by the peer count). Called
  // after any vote change or membership change.
  function settleKicks(room: Room) {
    for (let guard = room.peers.size + 1; guard >= 0; guard--) {
      const threshold = kickThreshold(kickElectorateCount(room));
      let kicked = false;
      for (const [targetId, voters] of room.kickVotes) {
        if (voters.size >= threshold && room.peers.has(targetId)) {
          kickPeer(room, targetId); // mutates kickVotes — restart the scan
          kicked = true;
          break;
        }
      }
      if (!kicked) break;
    }
  }

  return {
    deliverChatMessage,
    shouldForceSfu,
    wireDucking,
    applyModeDecision,
    broadcastJoinRequests,
    votablePeerCount,
    kickElectorateCount,
    cleanupKickVotes,
    dropKickVotesAgainst,
    teardownPeer,
    kickPeer,
    settleKicks,
    isAdmin,
    adminList,
    emitAdminsChanged,
    canApproveJoins,
    canOpenNotes,
    sendNotesUrl,
    canRecord,
    sendRecordingAccess,
    endModerationIfNoAdmins,
  };
}

export type RoomHelpers = ReturnType<typeof createRoomHelpers>;
