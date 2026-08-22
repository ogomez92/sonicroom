import { z } from "zod";
import { getOrCreateRoom, createPeer } from "../../room-manager.js";
import { decideMode } from "../../recording-util.js";
import { notifyPublicRoomCreated, notifyPublicRoomJoin } from "../../notify.js";
import { notesEnabled } from "../../notes.js";
import { joinSchema, chatTextSchema } from "../schemas.js";
import { clientIp } from "../room-helpers.js";
import type { ConnectionContext } from "../context.js";

// --- Per-connection lifecycle: join (admission + mode), the P2P signaling
// relay, chat fan-out, and disconnect teardown. Owns the mutable session state
// (currentRoom/currentPeer/pendingRequest) that the other handler groups read. ---
export function registerSessionHandlers(ctx: ConnectionContext) {
  const {
    io,
    socket,
    recordingManager,
    streamManager,
    chatLimiter,
    kickLimiter,
    helpers,
    session,
  } = ctx;

  socket.on("join", async (data: unknown, cb: (res: unknown) => void) => {
    try {
      const {
        roomName,
        displayName,
        role,
        disableP2p,
        isPublic,
        video,
        sharing,
        fileStreaming,
        extraMic,
        joinToken,
      } = joinSchema.parse(data);
      const room = await getOrCreateRoom(roomName);
      const ip = clientIp(socket);

      // Banned from this room by a prior deny — refuse outright (no knock).
      // Room-scoped and for the room's lifetime only.
      if (room.bannedIps.has(ip)) {
        console.log(`[ws] ${socket.id} (${ip}) blocked from ${roomName} (banned)`);
        cb({ ok: false, error: "banned" });
        return;
      }

      // Captured before this join can flip the (sticky) public flag below, so
      // we can tell "this join just made the room public" (a public room is
      // born) apart from "joined an already-public room", and so the knock
      // gate sees the room's public state as the visitor saw it in the lobby.
      const wasPublic = room.isPublic;
      // Likewise for the room type, so we can tell peers already inside that
      // this join just turned the room into a video call.
      const wasVideo = room.isVideo;

      // Knock-to-join: a newcomer to an ALREADY-public, occupied room must be
      // let in by someone inside. Skipping the gate: casters (infra, e.g.
      // Ecobox); returning sessions recognized by their join token
      // (reconnect/refresh); and anyone whose display name was already
      // admitted to this room and not since denied (someone let in earlier who
      // left and came back under the same name). A PRIVATE room never gates —
      // `wasPublic` is false, so anyone with the link joins openly.
      const alreadyAdmitted =
        (joinToken != null && room.admittedTokens.has(joinToken)) ||
        room.admittedNames.has(displayName);
      if (wasPublic && room.peers.size > 0 && role !== "caster" && !alreadyAdmitted) {
        room.pendingJoins.set(socket.id, { displayName, token: joinToken ?? "", ip });
        session.pendingRequest = room;
        console.log(`[ws] ${socket.id} knocking on ${roomName} as "${displayName}"`);
        helpers.broadcastJoinRequests(room);
        // Reply immediately: a held ack would trip the client's emit timeout.
        // The actual decision arrives later as a pushed join-approved/-denied,
        // after which the client re-joins (now token-admitted).
        cb({ ok: true, status: "pending" });
        return;
      }

      console.log(
        `[ws] ${socket.id} joined ${roomName} as "${displayName}"${role ? ` (${role})` : ""}${disableP2p ? " (p2p disabled)" : ""}${isPublic ? " (public)" : ""}${video ? " (video)" : ""}`,
      );

      // Admitted (open join, reconnect, or just-approved): remember the token
      // AND the display name so a later reconnect/refresh — or a return under
      // the same name after leaving — skips the gate; clear any knock state.
      if (joinToken != null) room.admittedTokens.add(joinToken);
      room.admittedNames.add(displayName);
      session.pendingRequest = null;

      helpers.wireDucking(room);
      const peer = createPeer(room, socket.id, displayName, ip);

      // Register a caster / P2P-disable BEFORE deciding the mode, so the join
      // response (and the new peer's own setup) already reflects the
      // forced-SFU room. disableP2p is sticky for the room's lifetime.
      if (role === "caster") room.casters.add(socket.id);
      if (disableP2p) room.disableP2p = true;
      // Public listing is sticky for the room's lifetime, like disableP2p.
      if (isPublic) room.isPublic = true;
      // Video room type is sticky too, and pins the SFU (see shouldForceSfu).
      if (video) room.isVideo = true;
      // A peer reconnecting mid-share re-pins SFU before the mode is decided,
      // so the rejoin lands straight in SFU and its share producer rebuilds.
      if (sharing) room.sharers.add(socket.id);
      // Likewise for an in-progress local-file stream.
      if (fileStreaming) room.fileStreamers.add(socket.id);
      // Likewise for in-progress extra-microphone stream(s).
      if (extraMic) room.extraMicStreamers.add(socket.id);

      session.currentRoom = room;
      session.currentPeer = peer;

      await socket.join(roomName);

      // Notify existing peers
      socket.to(roomName).emit("peer-joined", {
        peerId: socket.id,
        displayName,
      });

      // This join just made an existing audio room a video room (the flag is
      // sticky, so it can only ever go audio → video). Tell everyone already
      // inside so they load their video UI/media too — the joiner learns it from
      // `isVideo` in its own join response.
      if (room.isVideo && !wasVideo) socket.to(roomName).emit("room-video", {});

      // Ping the operator's off-box noty daemon on public-room activity
      // (target + on/off live in .env, hidden from users). Fire-and-forget:
      // either the room was just made public (born) or it already was.
      if (room.isPublic) {
        if (!wasPublic) {
          notifyPublicRoomCreated(roomName, displayName);
          // This join just flipped an existing room public — tell anyone
          // already inside so their vote-to-kick controls appear (the joiner
          // itself learns it's public from `isPublic` in the join response).
          socket.to(roomName).emit("room-public", {});
        } else {
          notifyPublicRoomJoin(roomName, displayName, room.peers.size);
        }
      }

      // A newcomer who lands while others are still knocking sees them too,
      // so they can help admit/deny (the broadcast above only reached peers
      // who were already in the room).
      if (room.pendingJoins.size > 0) {
        socket.emit("join-requests", {
          requests: Array.from(room.pendingJoins.entries()).map(([id, p]) => ({
            id,
            displayName: p.displayName,
          })),
        });
      }

      // Send existing peers to the new joiner. Each producer carries its
      // `source` ("voice" | "music" | … | "camera" | "screen") and `kind` so a
      // late joiner can label/treat the music caster as a media source — or
      // route a video producer to its video tile — without waiting for a
      // new-producer event, plus its `title` (device/file detail) so media
      // tiles read in full at once.
      const existingPeers = Array.from(room.peers.entries())
        .filter(([id]) => id !== socket.id)
        .map(([id, p]) => ({
          peerId: id,
          displayName: p.displayName,
          muted: p.muted,
          producers: Array.from(p.producers.values()).map((prod) => ({
            producerId: prod.id,
            kind: prod.kind,
            source: (prod.appData?.source as string) ?? "voice",
            title: (prod.appData?.title as string) || undefined,
          })),
        }));

      // Determine mode: 3+ peers => SFU; an active recording or music caster
      // also forces SFU even with <=2 peers.
      const decision = decideMode(room.peers.size, room.mode, helpers.shouldForceSfu(room));

      cb({
        ok: true,
        status: "joined",
        rtpCapabilities: room.router.rtpCapabilities,
        peers: existingPeers,
        mode: decision.mode,
        // Whether this room is publicly listed — gates the vote-to-kick UI
        // (only public rooms can vote-kick; private rooms are link-gated).
        isPublic: room.isPublic,
        // Room type. The client loads its video UI/media ONLY when this is
        // true — an audio room never renders or captures any video.
        isVideo: room.isVideo,
        // Current vote-to-kick tallies so a (re)joiner renders existing votes
        // (their own vote state always starts clear — votes are per session).
        kickVotes: Array.from(room.kickVotes.entries()).map(([targetId, voters]) => ({
          targetId,
          votes: voters.size,
        })),
        recording: recordingManager.isRecording(room.name)
          ? { recordingId: recordingManager.getRecording(room.name)!.id }
          : null,
        // Whether the room is being streamed live to Icecast (room-wide, like
        // recording). The Icecast target itself is never shared.
        streaming: streamManager.isStreaming(room.name),
        // Whether someone is talking RIGHT NOW, so a late joiner starts
        // music peers ducked instead of waiting for the next transition.
        voiceActive: room.voiceActive,
        // Room-wide auto-ducking toggle, so a joiner matches the room's state.
        duckingEnabled: room.duckingEnabled,
        // Recent chat so a late joiner can read/announce the last messages.
        messages: room.messages,
        // Whether shared notes are configured for this instance (gates the
        // "Notes" button / Alt+N) and this room's note URL if one exists yet.
        notesEnabled: notesEnabled(),
        notesUrl: room.notesUrl,
      });

      if (decision.action === "switch-to-sfu") {
        // A new peer pushed the room into SFU — switch everyone ELSE over.
        // Exclude this socket: it already got mode:"sfu" in its join response
        // and sets up the SFU from that, so re-notifying it would double-setup.
        helpers.applyModeDecision(room, socket.id);
      }
    } catch (err) {
      cb({ ok: false, error: err instanceof Error ? err.message : "Invalid input" });
    }
  });

  // --- P2P signaling relay ---
  socket.on("p2p-signal", (data: unknown) => {
    if (!session.currentRoom) return;
    const parsed = z
      .object({
        targetPeerId: z.string(),
        type: z.enum(["offer", "answer", "ice-candidate"]),
        payload: z.any(),
      })
      .safeParse(data);
    if (!parsed.success) return;

    const { targetPeerId, type, payload } = parsed.data;
    io.to(targetPeerId).emit("p2p-signal", {
      fromPeerId: socket.id,
      type,
      payload,
    });
  });

  // --- Chat ---
  // Broadcast a text message to the room. Rate-limited per socket; a blocked
  // send returns `rate_limited` and is NOT delivered (the client keeps the
  // text and plays a thunk). The accepted message echoes back to the sender
  // too, so every client renders/announces it through one code path.
  socket.on("chat-message", (data: unknown, cb: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer) {
      cb?.({ ok: false, error: "Not in a room" });
      return;
    }
    const parsed = z.object({ text: chatTextSchema }).safeParse(data);
    if (!parsed.success) {
      cb?.({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid message" });
      return;
    }
    if (!chatLimiter.tryConsume(socket.id, Date.now())) {
      cb?.({ ok: false, error: "rate_limited" });
      return;
    }
    const msg = helpers.deliverChatMessage(
      session.currentRoom,
      session.currentPeer.displayName,
      parsed.data.text,
    );
    cb?.({ ok: true, message: msg });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[ws] disconnected: ${socket.id} (${reason})`);
    chatLimiter.forget(socket.id);
    kickLimiter.forget(socket.id);

    // A visitor who was still knocking (never admitted) bailed — retract their
    // request so participants' modals update.
    if (session.pendingRequest) {
      session.pendingRequest.pendingJoins.delete(socket.id);
      helpers.broadcastJoinRequests(session.pendingRequest);
      session.pendingRequest = null;
    }

    if (session.currentRoom && session.currentPeer) {
      const room = session.currentRoom;
      // Shared teardown (also re-evaluates the mode). No-ops if this peer was
      // already removed by a vote-kick that force-disconnected them.
      helpers.teardownPeer(room, socket.id, { announceLeft: true });
      // A departure shrinks the room, lowering the kick threshold — that can
      // push an already-half-voted target over the line, so re-settle.
      helpers.settleKicks(room);
    }
  });
}
