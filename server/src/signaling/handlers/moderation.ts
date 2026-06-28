import { z } from "zod";
import type { Peer } from "../../room-manager.js";
import type { ConnectionContext } from "../context.js";

// --- Collective moderation (no moderators): knock decisions, vote-to-kick, and
// the immediate caster/stream removals (which are not vote-gated because a
// caster/stream isn't a person). ---
export function registerModerationHandlers(ctx: ConnectionContext) {
  const { io, socket, recordingManager, streamManager, kickLimiter, helpers, session } = ctx;

  // --- Ask to join (knock) decision ---
  // Any participant in the room can allow or deny a pending requester. The
  // first decision wins (the request is removed); a late/duplicate decision
  // for an already-resolved request is a harmless no-op. Allow records the
  // requester's token as admitted and pushes `join-approved` so their client
  // re-joins; deny pushes `join-denied`.
  socket.on("join-decision", (data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const parsed = z.object({ requestId: z.string(), allow: z.boolean() }).safeParse(data);
    if (!parsed.success) return cb?.({ ok: false, error: "Invalid decision" });

    const room = session.currentRoom;
    const { requestId, allow } = parsed.data;
    const pending = room.pendingJoins.get(requestId);
    if (!pending) return cb?.({ ok: true }); // already resolved by someone else

    room.pendingJoins.delete(requestId);
    if (allow) {
      if (pending.token) room.admittedTokens.add(pending.token);
      io.to(requestId).emit("join-approved", {});
      console.log(`[ws] ${session.currentPeer.displayName} admitted ${requestId} to ${room.name}`);
    } else {
      // Ban the denied visitor's IP from THIS room (only) so they can't just
      // re-knock; the ban lives as long as the room does.
      if (pending.ip) room.bannedIps.add(pending.ip);
      // Drop the name from the auto-admit set: a denial overrides any earlier
      // admission, so this name must knock again rather than walk back in.
      room.admittedNames.delete(pending.displayName);
      io.to(requestId).emit("join-denied", { by: session.currentPeer.displayName });
      console.log(
        `[ws] ${session.currentPeer.displayName} denied + banned ${requestId} (${pending.ip}) from ${room.name}`,
      );
    }
    helpers.broadcastJoinRequests(room);
    cb?.({ ok: true });
  });

  // --- Vote to kick (public rooms; no moderators) ---
  // Cast or withdraw a vote to remove another peer. Real toggles broadcast a
  // `kick-vote` to the whole room (so everyone updates the tally + announces);
  // once a target reaches kickThreshold it's removed (settleKicks). Casters
  // and yourself can't be targeted; private rooms — and two-person rooms (no
  // real majority) — have no vote-kick at all.
  socket.on("vote-kick", (data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const room = session.currentRoom;
    if (!room.isPublic) return cb?.({ ok: false, error: "not_public" });
    // Defense-in-depth — the client also hides the controls below 3 votable
    // peers (kickThreshold is Infinity there, so a vote could never land).
    if (helpers.votablePeerCount(room) < 3) return cb?.({ ok: false, error: "too_small" });

    const parsed = z.object({ targetId: z.string(), vote: z.boolean() }).safeParse(data);
    if (!parsed.success) return cb?.({ ok: false, error: "Invalid vote" });
    const { targetId, vote } = parsed.data;

    if (targetId === socket.id) return cb?.({ ok: false, error: "self" });
    const target = room.peers.get(targetId);
    if (!target || room.casters.has(targetId)) return cb?.({ ok: false, error: "no_target" });

    const voters = room.kickVotes.get(targetId);
    const alreadyVoted = voters?.has(socket.id) ?? false;
    // Redundant re-vote / empty withdraw: a harmless no-op that neither
    // broadcasts nor counts against the anti-spam budget.
    if (vote === alreadyVoted) return cb?.({ ok: true });

    // Only a real state change costs a rate-limit slot.
    if (!kickLimiter.tryConsume(socket.id, Date.now())) {
      return cb?.({ ok: false, error: "rate_limited" });
    }

    let next = voters;
    if (vote) {
      if (!next) {
        next = new Set();
        room.kickVotes.set(targetId, next);
      }
      next.add(socket.id);
    } else {
      next!.delete(socket.id);
      if (next!.size === 0) room.kickVotes.delete(targetId);
    }

    io.to(room.name).emit("kick-vote", {
      targetId,
      targetName: target.displayName,
      votes: next ? next.size : 0,
      voterId: socket.id,
      voterName: session.currentPeer.displayName,
      action: vote ? "cast" : "withdraw",
    });

    // A fresh vote may have reached the threshold (or a withdraw left it below).
    helpers.settleKicks(room);
    cb?.({ ok: true });
  });

  // --- Kick a caster (send-only music source like Ecobox) immediately ---
  // Casters are infrastructure, not participants: they bypass the knock gate
  // and are excluded from vote-to-kick, so an abusive one (stupid music / a
  // bogus file) would otherwise be unremovable. ANY peer can remove one
  // outright, in BOTH public and private rooms — the "no moderators / collective
  // only" rule governs removing *humans*; a caster isn't one. The target is
  // HARD-GUARDED to `room.casters`, so this can never be turned on a person.
  // Deliberately does NOT IP-ban (unlike a vote-kick): it's a troll speed bump,
  // not a ban. A server-initiated disconnect doesn't auto-reconnect, so the
  // caster stays gone until someone relaunches it.
  socket.on("kick-caster", (data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const room = session.currentRoom;
    const parsed = z.object({ targetId: z.string() }).safeParse(data);
    if (!parsed.success) return cb?.({ ok: false, error: "Invalid target" });
    const { targetId } = parsed.data;
    const target = room.peers.get(targetId);
    // The safety invariant: only ever a caster, never a human peer.
    if (!target || !room.casters.has(targetId)) return cb?.({ ok: false, error: "not_a_caster" });
    console.log(
      `[ws] ${session.currentPeer.displayName} removed caster ${target.displayName} (${targetId}) from ${room.name}`,
    );
    // Tell the room (tiles tear down + announce); teardownPeer drops the caster
    // from room.casters (releasing the SFU pin) and re-evaluates the mode.
    io.to(room.name).except(targetId).emit("peer-kicked", {
      peerId: targetId,
      displayName: target.displayName,
      reason: "caster",
    });
    helpers.teardownPeer(room, targetId, { announceLeft: false });
    io.sockets.sockets.get(targetId)?.disconnect(true);
    cb?.({ ok: true });
  });

  // --- Stop one peer's media stream (a shared system/tab audio, a streamed
  // file, or an extra mic — people stream music through a virtual audio cable as
  // an extra mic) without removing the person — for a "bogus file"/blasted-audio
  // troll. Like kick-caster it's an immediate, non-vote action available in ANY
  // room; the "no moderators" rule is about removing *people*, and this stops a
  // stream, not a person (their voice/seat stay). HARD-GUARDED to "share"/"file"
  // /"mic" producers: never the primary voice, and never a caster's music (that
  // goes through kick-caster). The server authoritatively closes the producer (a
  // troll's own client can't be trusted to), tears down listeners' tiles via the
  // usual *-stopped path, and signals the owner to clean up locally.
  socket.on("stop-peer-stream", (data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const room = session.currentRoom;
    const parsed = z.object({ producerId: z.string() }).safeParse(data);
    if (!parsed.success) return cb?.({ ok: false, error: "Invalid target" });
    const { producerId } = parsed.data;

    // Locate the owning peer + the producer's source.
    let found: { ownerId: string; owner: Peer; source: string } | null = null;
    for (const [pid, p] of room.peers) {
      const prod = p.producers.get(producerId);
      if (prod) {
        found = { ownerId: pid, owner: p, source: (prod.appData?.source as string) ?? "voice" };
        break;
      }
    }
    if (!found || (found.source !== "share" && found.source !== "file" && found.source !== "mic")) {
      return cb?.({ ok: false, error: "not_a_stream" });
    }
    const { ownerId, owner, source } = found;

    owner.producers.get(producerId)?.close();
    owner.producers.delete(producerId);
    // Stop its capture/feed if recording/streaming — otherwise the recorder/
    // mixer idles on a dead port until it ends.
    if (recordingManager.isRecording(room.name)) {
      void recordingManager.removeProducer(room.name, producerId).catch(() => {});
    }
    if (streamManager.isStreaming(room.name)) {
      void streamManager.removeProducer(room.name, producerId).catch(() => {});
    }
    // Release the SFU pin once the owner has no more producers of this source (a
    // peer can run several extra mics, so only the last one drops the pin).
    const stillHas = Array.from(owner.producers.values()).some(
      (p) => (p.appData?.source as string) === source,
    );
    if (!stillHas) {
      if (source === "share") room.sharers.delete(ownerId);
      else if (source === "file") room.fileStreamers.delete(ownerId);
      else room.extraMicStreamers.delete(ownerId);
    }

    console.log(
      `[ws] ${session.currentPeer.displayName} stopped ${owner.displayName}'s ${source} stream (${producerId}) in ${room.name}`,
    );

    // One broadcast to the whole room: listeners tear down the tile, the owner
    // cleans up their own local playback/producer (keyed off ownerId === self).
    io.to(room.name).emit("peer-stream-stopped", { ownerId, producerId, source });
    helpers.applyModeDecision(room);
    cb?.({ ok: true });
  });
}
