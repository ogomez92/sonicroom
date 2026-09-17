import { z } from "zod";
import type { Room } from "../../room-manager.js";
import { allowed, kickMode } from "../../moderation-util.js";
import type { ConnectionContext } from "../context.js";

// --- MODERATED rooms only: the admin actions. Every handler here refuses
// outright in an ordinary private/public room (`room.moderation` is null),
// which is what keeps those rooms moderator-free by construction; within a
// moderated room each action is gated by the room's fixed policy through
// `allowed` / `kickMode` (moderation-util.ts). The client hides what it can't
// use, but the server is the authority. ---
export function registerAdminHandlers(ctx: ConnectionContext) {
  const { io, socket, streamManager, kickLimiter, helpers, session } = ctx;

  // Pause a peer's voice producer(s) server-side and mark them muted — the
  // SOFT mute: the person is told (`you-were-muted`) and may unmute themselves
  // again (the ordinary producer-resume). A moderated room is pinned to the
  // SFU, so the producer exists whenever they have produced at all; a peer who
  // hasn't yet (still connecting) just gets the flag + notice and their client
  // mutes locally. Casters have no voice and are skipped by callers.
  async function forceMute(room: Room, targetId: string, by: string) {
    const target = room.peers.get(targetId);
    if (!target) return;
    target.muted = true;
    for (const producer of target.producers.values()) {
      if (((producer.appData?.source as string) ?? "voice") !== "voice") continue;
      await producer.pause();
      if (streamManager.isStreaming(room.name)) {
        streamManager.setProducerActive(room.name, producer.id, false);
      }
    }
    io.to(targetId).emit("you-were-muted", { by });
    // Everyone else renders the mute the usual way (peer-muted); the muter's
    // own client also gets a named announcement via the ack.
    io.to(room.name).except(targetId).emit("peer-muted", { peerId: targetId, by });
  }

  // --- Name / revoke a co-admin ---
  // Admins only, and naming needs the room's "Allow several admins" setting.
  // You can't change your own role; casters can't be admins. Revoking drops the
  // token too, so the person doesn't come back as an admin on a reconnect.
  socket.on("set-admin", (data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const room = session.currentRoom;
    if (!room.moderation) return cb?.({ ok: false, error: "not_moderated" });
    if (!room.admins.has(socket.id)) return cb?.({ ok: false, error: "forbidden" });
    const parsed = z.object({ targetId: z.string(), admin: z.boolean() }).safeParse(data);
    if (!parsed.success) return cb?.({ ok: false, error: "Invalid target" });
    const { targetId, admin } = parsed.data;
    if (targetId === socket.id) return cb?.({ ok: false, error: "self" });
    const target = room.peers.get(targetId);
    if (!target || room.casters.has(targetId)) return cb?.({ ok: false, error: "no_target" });
    if (admin && !room.moderation.multipleAdmins) return cb?.({ ok: false, error: "single_admin" });
    if (admin === room.admins.has(targetId)) return cb?.({ ok: true }); // no change

    if (admin) {
      room.admins.add(targetId);
      if (target.token) room.adminTokens.add(target.token);
    } else {
      room.admins.delete(targetId);
      if (target.token) room.adminTokens.delete(target.token);
    }
    console.log(
      `[ws] ${session.currentPeer.displayName} ${admin ? "named" : "revoked"} admin ${target.displayName} (${targetId}) in ${room.name}`,
    );
    helpers.emitAdminsChanged(room, {
      peerId: targetId,
      displayName: target.displayName,
      isAdmin: admin,
      reason: admin ? "named" : "revoked",
      by: session.currentPeer.displayName,
    });
    // Everything the role unlocks (or takes away) is handed over / withdrawn
    // right here, so the client never has to guess:
    // - The door: a newly named admin may now be the one who has to answer
    //   it (sent even when the queue is empty, so a stale list from an earlier
    //   stint as admin is cleared); a revoked one loses the queue at once.
    //   Only when approving is admins-only — otherwise nothing changed.
    if (room.moderation.approveJoins === "admins") {
      io.to(targetId).emit("join-requests", {
        requests: admin
          ? Array.from(room.pendingJoins.entries()).map(([id, p]) => ({
              id,
              displayName: p.displayName,
            }))
          : [],
      });
    }
    // - The shared note: admins-only notes are handed to a new admin now
    //   (a revoked admin keeps a link they already opened — a NoteLab link
    //   can't be withdrawn — but their button goes with the role).
    if (admin) helpers.sendNotesUrl(room, null, targetId);
    // - The recording download: the recording id IS the download capability,
    //   so an admins-only recording is handed to a new admin now and withdrawn
    //   from a revoked one (their buttons go; a file already fetched stays).
    if (room.moderation.recording === "admins") helpers.sendRecordingAccess(room, targetId, !admin);
    // - Vote-kick: a new admin can no longer be a target (votes against them
    //   are dropped); a revoked one's own votes stop counting when only admins
    //   vote, and that electorate's threshold moved with its size — so settle
    //   (a smaller electorate can tip an already-voted target).
    if (room.moderation.kick === "admins_vote" || room.moderation.kick === "everyone_vote") {
      if (admin) helpers.dropKickVotesAgainst(room, targetId);
      else if (room.moderation.kick === "admins_vote") helpers.cleanupKickVotes(room, targetId);
      helpers.settleKicks(room);
    }
    cb?.({ ok: true });
  });

  // --- Mute ONE participant for everyone ---
  // Per the room's mutePeer setting. Not yourself (that's the mute button),
  // not a caster/stream (stop-peer-stream / kick-caster handle those), and an
  // admin only by another admin.
  socket.on("mute-peer", async (data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const room = session.currentRoom;
    if (!room.moderation) return cb?.({ ok: false, error: "not_moderated" });
    const isAdmin = room.admins.has(socket.id);
    if (!allowed(room.moderation, isAdmin, "mutePeer"))
      return cb?.({ ok: false, error: "forbidden" });
    const parsed = z.object({ targetId: z.string() }).safeParse(data);
    if (!parsed.success) return cb?.({ ok: false, error: "Invalid target" });
    const { targetId } = parsed.data;
    if (targetId === socket.id) return cb?.({ ok: false, error: "self" });
    const target = room.peers.get(targetId);
    if (!target || room.casters.has(targetId)) return cb?.({ ok: false, error: "no_target" });
    if (room.admins.has(targetId) && !isAdmin) return cb?.({ ok: false, error: "forbidden" });
    if (target.muted) return cb?.({ ok: true }); // already muted: nothing to do
    if (!kickLimiter.tryConsume(socket.id, Date.now()))
      return cb?.({ ok: false, error: "rate_limited" });

    console.log(
      `[ws] ${session.currentPeer.displayName} muted ${target.displayName} (${targetId}) for everyone in ${room.name}`,
    );
    await forceMute(room, targetId, session.currentPeer.displayName);
    cb?.({ ok: true, targetName: target.displayName });
  });

  // --- Mute EVERYONE else ---
  // Per the room's muteAll setting. Mutes every human but the caller (admins
  // included — the setting decides who may do it, not who it applies to);
  // casters (no voice) are skipped. Already-muted people are left alone.
  socket.on("mute-all", async (_data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const room = session.currentRoom;
    if (!room.moderation) return cb?.({ ok: false, error: "not_moderated" });
    if (!allowed(room.moderation, room.admins.has(socket.id), "muteAll"))
      return cb?.({ ok: false, error: "forbidden" });
    if (!kickLimiter.tryConsume(socket.id, Date.now()))
      return cb?.({ ok: false, error: "rate_limited" });

    const by = session.currentPeer.displayName;
    let count = 0;
    for (const [id, peer] of room.peers) {
      if (id === socket.id || room.casters.has(id) || peer.muted) continue;
      await forceMute(room, id, by);
      count++;
    }
    console.log(`[ws] ${by} muted everyone (${count}) in ${room.name}`);
    io.to(room.name).emit("all-muted", { by, count });
    cb?.({ ok: true, count });
  });

  // --- Remove a participant at once (no vote) ---
  // Only when the room's kick policy gives THIS peer the direct mode. Not
  // yourself; not a caster (kick-caster); an admin only by another admin. Reuses
  // the vote-kick's removal path (room-ban + teardown + force-disconnect).
  socket.on("kick-peer", (data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const room = session.currentRoom;
    if (!room.moderation) return cb?.({ ok: false, error: "not_moderated" });
    const isAdmin = room.admins.has(socket.id);
    if (kickMode(room.moderation, isAdmin) !== "direct")
      return cb?.({ ok: false, error: "forbidden" });
    const parsed = z.object({ targetId: z.string() }).safeParse(data);
    if (!parsed.success) return cb?.({ ok: false, error: "Invalid target" });
    const { targetId } = parsed.data;
    if (targetId === socket.id) return cb?.({ ok: false, error: "self" });
    const target = room.peers.get(targetId);
    if (!target || room.casters.has(targetId)) return cb?.({ ok: false, error: "no_target" });
    if (room.admins.has(targetId) && !isAdmin) return cb?.({ ok: false, error: "forbidden" });
    if (!kickLimiter.tryConsume(socket.id, Date.now()))
      return cb?.({ ok: false, error: "rate_limited" });

    helpers.kickPeer(room, targetId, "admin", session.currentPeer.displayName);
    io.sockets.sockets.get(targetId)?.disconnect(true);
    cb?.({ ok: true });
  });
}
