import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { removePeer, type Room, type Peer } from "../room-manager.js";
import { decideMode } from "../recording-util.js";
import { kickThreshold } from "../kick-util.js";
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
      room.disableP2p
    );
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
  function broadcastJoinRequests(room: Room) {
    io.to(room.name).emit("join-requests", {
      requests: Array.from(room.pendingJoins.entries()).map(([id, p]) => ({
        id,
        displayName: p.displayName,
      })),
    });
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

    removePeer(room, peerId);

    if (room.peers.size > 0) {
      applyModeDecision(room);
    } else if (room.pendingJoins.size > 0) {
      // The room just emptied while someone was still knocking — their request
      // can never be answered now, so let them go (their client surfaces the
      // denial and can retry, landing in the now-empty room).
      for (const reqId of room.pendingJoins.keys()) io.to(reqId).emit("join-denied", {});
      room.pendingJoins.clear();
    }
  }

  // Remove a peer the room voted out. Tells the room (`peer-kicked`) and the
  // target (`you-were-kicked`), room-bans their IP so they can't immediately
  // walk back in (the same soft ban a knock-deny applies), tears them down, then
  // force-disconnects their socket. Emitting before disconnecting flushes the
  // notice to them first; a server-initiated disconnect won't auto-reconnect.
  // (A caster removal is NOT a vote-kick — it goes through kick-caster, which
  // does NOT ban; `reason` lets the client tell the two announcements apart.)
  function kickPeer(room: Room, targetId: string) {
    const target = room.peers.get(targetId);
    if (!target) {
      room.kickVotes.delete(targetId);
      return;
    }
    if (target.ip) room.bannedIps.add(target.ip);
    room.admittedNames.delete(target.displayName);

    io.to(room.name).except(targetId).emit("peer-kicked", {
      peerId: targetId,
      displayName: target.displayName,
      reason: "vote",
    });
    io.to(targetId).emit("you-were-kicked", {});
    console.log(`[ws] ${target.displayName} (${targetId}) kicked from ${room.name} by vote`);

    teardownPeer(room, targetId, { announceLeft: false });
    io.sockets.sockets.get(targetId)?.disconnect(true);
  }

  // Remove every target that has reached the current threshold. A kick shrinks
  // the room, which lowers the threshold and can push the next target over the
  // line, so loop until nobody qualifies (bounded by the peer count). Called
  // after any vote change or membership change.
  function settleKicks(room: Room) {
    for (let guard = room.peers.size + 1; guard >= 0; guard--) {
      const threshold = kickThreshold(votablePeerCount(room));
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
    cleanupKickVotes,
    teardownPeer,
    kickPeer,
    settleKicks,
  };
}

export type RoomHelpers = ReturnType<typeof createRoomHelpers>;
