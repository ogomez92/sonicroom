import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import type { DtlsParameters, MediaKind, RtpCapabilities, RtpParameters } from "mediasoup/types";
import {
  getOrCreateRoom,
  getRooms,
  createPeer,
  createWebRtcTransport,
  removePeer,
  type Room,
  type Peer,
} from "./room-manager.js";
import { decideMode } from "./recording-util.js";
import { kickThreshold } from "./kick-util.js";
import { RateLimiter, CHAT_HISTORY_MAX, CHAT_TEXT_MAX, type ChatMessage } from "./chat-util.js";
import { notifyPublicRoomCreated, notifyPublicRoomJoin } from "./notify.js";
import type { RecordingManager, ProducerInfo } from "./recording.js";
import type { StreamManager } from "./streaming.js";
import type { IcecastConfig } from "./streaming-util.js";

// --- Validation schemas ---
const roomNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "Room name must be alphanumeric, hyphens, or underscores");

const displayNameSchema = z
  .string()
  .min(1)
  .max(256)
  .transform((s) => s.replace(/[<>"'&]/g, ""));

// A chat message body: trimmed, non-empty, capped. React escapes it on render
// and it's only ever used as text content (list + ARIA announcement), so the
// content itself isn't sanitized beyond trimming/length.
const chatTextSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "Message is empty").max(CHAT_TEXT_MAX));

// Icecast target supplied by whoever starts streaming. Host/mount are charset-
// restricted so the icecast:// URL stays well-formed (the password/username are
// percent-encoded in buildIcecastUrl, so they may contain anything). The config
// is only ever used to start the server's own ffmpeg — it's never broadcast to
// other peers (the password would leak), only `streaming-started { by }` is.
const icecastConfigSchema = z.object({
  host: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9.-]+$/, "Host must be a hostname or IPv4 address"),
  port: z.number().int().min(1).max(65535),
  mount: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\/?[a-zA-Z0-9._/-]+$/, "Invalid mount point")
    .transform((m) => (m.startsWith("/") ? m : `/${m}`)),
  username: z.string().min(1).max(128).default("source"),
  password: z.string().min(1).max(256),
  format: z.enum(["mp3", "opus"]).default("mp3"),
  bitrateKbps: z.number().int().min(32).max(320).default(160),
  name: z.string().max(128).optional(),
});

const joinSchema = z.object({
  roomName: roomNameSchema,
  displayName: displayNameSchema,
  // A "caster" is a send-only media source (e.g. Ecobox streaming music). It
  // produces a stereo track but never consumes or sets up P2P, so its presence
  // forces the room onto the SFU.
  role: z.enum(["caster"]).optional(),
  // Explicitly disable P2P for this room (the `?p2p=off` room URL param). Pins
  // the room to the SFU even with <=2 peers; sticky once any joiner sets it.
  disableP2p: z.boolean().optional(),
  // List this room publicly in the lobby (the "Make this room public" toggle /
  // `?public=true` URL param). Off by default; sticky once any joiner sets it.
  isPublic: z.boolean().optional(),
  // Set on a reconnect if this peer was sharing audio when it dropped, so the
  // server re-pins SFU for the rejoin (the share producer is rebuilt right
  // after, in setupSfu). On a first join it's always false.
  sharing: z.boolean().optional(),
  // Same as `sharing`, but for an in-progress local-file stream: re-pins SFU on
  // a reconnect so the "file" producer rebuilds. Always false on a first join.
  fileStreaming: z.boolean().optional(),
  // Same as `sharing`, but for in-progress extra-microphone streams: re-pins SFU
  // on a reconnect so the "mic" producer(s) rebuild. Always false on a first join.
  extraMic: z.boolean().optional(),
  // Per-session, per-room random token the client persists (sessionStorage).
  // Identifies an already-admitted session so a reconnect/refresh skips the
  // knock gate, and is what an approval records as "admitted".
  joinToken: z.string().min(1).max(128).optional(),
});

function closeSfuResources(peer: Peer) {
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
function clientIp(socket: Socket): string {
  const xff = socket.handshake.headers["x-forwarded-for"];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(",")[0];
  return (first || socket.handshake.address || "").trim();
}

export function createSignalingServer(
  httpServer: HttpServer,
  recordingManager: RecordingManager,
  streamManager: StreamManager,
) {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    transports: ["websocket"],
    pingInterval: 5000,
    pingTimeout: 10000,
  });

  // When a finished recording is auto-discarded (TTL), tell the room so
  // clients can hide the now-dead download link.
  recordingManager.onExpire = (roomName, recordingId) => {
    io.to(roomName).emit("recording-expired", { recordingId });
  };

  // The mixer ffmpeg died on its own (bad Icecast target, server unreachable,
  // mount already in use, …). Tell the room the stream stopped and re-evaluate
  // the mode (streaming no longer pins SFU).
  streamManager.onStop = (roomName, _reason, message) => {
    io.to(roomName).emit("streaming-failed", { error: message });
    const room = getRooms().get(roomName);
    if (room) applyModeDecision(room);
  };

  // Anti-spam: 5 messages / 10s per sender. Keyed by socket id for in-room
  // chat, and by `api:<room>` for HTTP posts. Blocked sends are dropped (the
  // client keeps the unsent text and plays a "thunk"), never queued.
  const chatLimiter = new RateLimiter();

  // Anti-spam for vote-to-kick: at most 5 vote *changes* / 10s per voter, so a
  // peer can't flood the room with "X voted to kick Y / withdrew…" churn.
  // Keyed by socket id; only real cast/withdraw toggles consume a slot (a
  // redundant re-vote or empty withdraw is a no-op and doesn't count).
  const kickLimiter = new RateLimiter();

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

  // HTTP entrypoint (see the POST /api/rooms/:room/messages route): post a
  // message into a live room from outside the socket world (e.g. Ecobox
  // announcing the now-playing track). Same validation + rate limit as a peer.
  function postChatMessage(
    roomName: string,
    sender: string,
    rawText: string,
  ): { ok: true; message: ChatMessage } | { ok: false; error: string; status: number } {
    const room = getRooms().get(roomName);
    if (!room) return { ok: false, error: "Room not found or empty", status: 404 };

    const parsed = chatTextSchema.safeParse(rawText);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid message",
        status: 400,
      };
    }
    const cleanSender =
      sender
        .replace(/[<>"'&]/g, "")
        .trim()
        .slice(0, 256) || "System";
    if (!chatLimiter.tryConsume(`api:${roomName}`, Date.now())) {
      return { ok: false, error: "Rate limited", status: 429 };
    }
    return { ok: true, message: deliverChatMessage(room, cleanSender, parsed.data) };
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

  io.on("connection", (socket) => {
    console.log(`[ws] connected: ${socket.id}`);
    let currentRoom: Room | null = null;
    let currentPeer: Peer | null = null;
    // The public room this socket is currently knocking on but hasn't been
    // admitted to (null once admitted or if no knock is pending). Lets the
    // disconnect handler retract a pending request even though the visitor was
    // never added as a peer.
    let pendingRequest: Room | null = null;

    socket.on("join", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        const {
          roomName,
          displayName,
          role,
          disableP2p,
          isPublic,
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
          pendingRequest = room;
          console.log(`[ws] ${socket.id} knocking on ${roomName} as "${displayName}"`);
          broadcastJoinRequests(room);
          // Reply immediately: a held ack would trip the client's emit timeout.
          // The actual decision arrives later as a pushed join-approved/-denied,
          // after which the client re-joins (now token-admitted).
          cb({ ok: true, status: "pending" });
          return;
        }

        console.log(
          `[ws] ${socket.id} joined ${roomName} as "${displayName}"${role ? ` (${role})` : ""}${disableP2p ? " (p2p disabled)" : ""}${isPublic ? " (public)" : ""}`,
        );

        // Admitted (open join, reconnect, or just-approved): remember the token
        // AND the display name so a later reconnect/refresh — or a return under
        // the same name after leaving — skips the gate; clear any knock state.
        if (joinToken != null) room.admittedTokens.add(joinToken);
        room.admittedNames.add(displayName);
        pendingRequest = null;

        wireDucking(room);
        const peer = createPeer(room, socket.id, displayName, ip);

        // Register a caster / P2P-disable BEFORE deciding the mode, so the join
        // response (and the new peer's own setup) already reflects the
        // forced-SFU room. disableP2p is sticky for the room's lifetime.
        if (role === "caster") room.casters.add(socket.id);
        if (disableP2p) room.disableP2p = true;
        // Public listing is sticky for the room's lifetime, like disableP2p.
        if (isPublic) room.isPublic = true;
        // A peer reconnecting mid-share re-pins SFU before the mode is decided,
        // so the rejoin lands straight in SFU and its share producer rebuilds.
        if (sharing) room.sharers.add(socket.id);
        // Likewise for an in-progress local-file stream.
        if (fileStreaming) room.fileStreamers.add(socket.id);
        // Likewise for in-progress extra-microphone stream(s).
        if (extraMic) room.extraMicStreamers.add(socket.id);

        currentRoom = room;
        currentPeer = peer;

        await socket.join(roomName);

        // Notify existing peers
        socket.to(roomName).emit("peer-joined", {
          peerId: socket.id,
          displayName,
        });

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
        // `source` ("voice" | "music") so a late joiner can label/treat the
        // music caster as a media source without waiting for a new-producer event,
        // plus its `title` (device/file detail) so media tiles read in full at once.
        const existingPeers = Array.from(room.peers.entries())
          .filter(([id]) => id !== socket.id)
          .map(([id, p]) => ({
            peerId: id,
            displayName: p.displayName,
            muted: p.muted,
            producers: Array.from(p.producers.values()).map((prod) => ({
              producerId: prod.id,
              source: (prod.appData?.source as string) ?? "voice",
              title: (prod.appData?.title as string) || undefined,
            })),
          }));

        // Determine mode: 3+ peers => SFU; an active recording or music caster
        // also forces SFU even with <=2 peers.
        const decision = decideMode(room.peers.size, room.mode, shouldForceSfu(room));

        cb({
          ok: true,
          status: "joined",
          rtpCapabilities: room.router.rtpCapabilities,
          peers: existingPeers,
          mode: decision.mode,
          // Whether this room is publicly listed — gates the vote-to-kick UI
          // (only public rooms can vote-kick; private rooms are link-gated).
          isPublic: room.isPublic,
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
        });

        if (decision.action === "switch-to-sfu") {
          // A new peer pushed the room into SFU — switch everyone ELSE over.
          // Exclude this socket: it already got mode:"sfu" in its join response
          // and sets up the SFU from that, so re-notifying it would double-setup.
          applyModeDecision(room, socket.id);
        }
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Invalid input" });
      }
    });

    // --- P2P signaling relay ---
    socket.on("p2p-signal", (data: unknown) => {
      if (!currentRoom) return;
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
      if (!currentRoom || !currentPeer) {
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
      const msg = deliverChatMessage(currentRoom, currentPeer.displayName, parsed.data.text);
      cb?.({ ok: true, message: msg });
    });

    // --- SFU transport/produce/consume (same as before) ---
    socket.on("create-transport", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom || !currentPeer) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }

        const { direction } = z.object({ direction: z.enum(["send", "recv"]) }).parse(data);
        const { transport, params } = await createWebRtcTransport(currentRoom);

        if (direction === "send") {
          currentPeer.sendTransport = transport;
        } else {
          currentPeer.recvTransport = transport;
        }

        cb({ ok: true, params });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Transport creation failed" });
      }
    });

    socket.on("connect-transport", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentPeer) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }

        const { direction, dtlsParameters } = z
          .object({
            direction: z.enum(["send", "recv"]),
            dtlsParameters: z.any() as z.ZodType<DtlsParameters>,
          })
          .parse(data);

        const transport =
          direction === "send" ? currentPeer.sendTransport : currentPeer.recvTransport;

        if (!transport) {
          cb({ ok: false, error: "Transport not found" });
          return;
        }

        await transport.connect({ dtlsParameters });
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Connect failed" });
      }
    });

    socket.on("produce", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom || !currentPeer?.sendTransport) {
          cb({ ok: false, error: "No send transport" });
          return;
        }

        const { kind, rtpParameters, source, title } = z
          .object({
            kind: z.enum(["audio", "video"]) as z.ZodType<MediaKind>,
            rtpParameters: z.any() as z.ZodType<RtpParameters>,
            // "music" for a caster's stereo track, "share" for a peer's stereo
            // system/tab-audio share, "file" for a peer streaming a local audio
            // file, "mic" for an EXTRA microphone (a separate producer alongside
            // the peer's voice), "voice" (default) for the primary mic.
            source: z.enum(["voice", "music", "share", "file", "mic"]).optional(),
            // Human-readable detail for a media producer (extra-mic device name,
            // file name / URL), shown alongside the owner in the participant list.
            // Trusted only as a display string; capped so a peer can't flood it.
            title: z.string().trim().max(120).optional(),
          })
          .parse(data);

        const producer = await currentPeer.sendTransport.produce({
          kind,
          rtpParameters,
          appData: { source: source ?? "voice", title: title || undefined },
        });

        currentPeer.producers.set(producer.id, producer);

        // Feed VOICE producers into the audio-level observer so talking ducks
        // the music. Music/share producers are deliberately excluded so the
        // music never ducks itself. (Closed producers auto-remove themselves.)
        if (producer.kind === "audio" && (source ?? "voice") === "voice") {
          void currentRoom.audioLevelObserver
            .addProducer({ producerId: producer.id })
            .catch((err) => console.error("[duck] addProducer failed:", err));
        }

        // If the room is being recorded and/or streamed, tap this producer for
        // each too. Not awaited — the produce callback should return promptly,
        // and the recorder/feed spins up in the background. Recording and
        // streaming each consume the producer independently.
        const producerInfo: ProducerInfo = {
          producerId: producer.id,
          peerId: socket.id,
          label: currentPeer.displayName,
          source: source ?? "voice",
        };
        if (recordingManager.isRecording(currentRoom.name)) {
          void recordingManager
            .addProducer(currentRoom.name, producerInfo)
            .catch((err) => console.error("[recording] addProducer failed:", err));
        }
        if (streamManager.isStreaming(currentRoom.name)) {
          void streamManager
            .addProducer(currentRoom.name, producerInfo)
            .catch((err) => console.error("[streaming] addProducer failed:", err));
        }

        // Notify all other peers that a new producer is available
        socket.to(currentRoom.name).emit("new-producer", {
          peerId: socket.id,
          producerId: producer.id,
          kind: producer.kind,
          source: (producer.appData?.source as string) ?? "voice",
          title: (producer.appData?.title as string) || undefined,
        });

        cb({ ok: true, producerId: producer.id });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Produce failed" });
      }
    });

    socket.on("consume", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom || !currentPeer?.recvTransport) {
          cb({ ok: false, error: "No recv transport" });
          return;
        }

        const { producerId, rtpCapabilities } = z
          .object({
            producerId: z.string(),
            rtpCapabilities: z.any() as z.ZodType<RtpCapabilities>,
          })
          .parse(data);

        if (!currentRoom.router.canConsume({ producerId, rtpCapabilities })) {
          cb({ ok: false, error: "Cannot consume" });
          return;
        }

        const consumer = await currentPeer.recvTransport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        currentPeer.consumers.set(consumer.id, consumer);

        cb({
          ok: true,
          consumerId: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Consume failed" });
      }
    });

    // Mute/unmute pauses only the VOICE producer — a peer's shared-audio
    // ("share") producer keeps streaming so the music isn't cut when they mute.
    socket.on("producer-pause", async (_data: unknown, cb: (res: unknown) => void) => {
      if (!currentPeer) return cb({ ok: false });
      currentPeer.muted = true;
      for (const producer of currentPeer.producers.values()) {
        if (((producer.appData?.source as string) ?? "voice") !== "voice") continue;
        await producer.pause();
        // A paused producer sends no RTP, which would stall the live mixer's
        // amix — drop it from the stream (kept allocated) until it resumes.
        if (currentRoom && streamManager.isStreaming(currentRoom.name)) {
          streamManager.setProducerActive(currentRoom.name, producer.id, false);
        }
      }
      if (currentRoom) {
        socket.to(currentRoom.name).emit("peer-muted", { peerId: socket.id });
      }
      cb({ ok: true });
    });

    socket.on("producer-resume", async (_data: unknown, cb: (res: unknown) => void) => {
      if (!currentPeer) return cb({ ok: false });
      currentPeer.muted = false;
      for (const producer of currentPeer.producers.values()) {
        if (((producer.appData?.source as string) ?? "voice") !== "voice") continue;
        await producer.resume();
        // Voice is flowing again — fold this producer back into the live mix.
        if (currentRoom && streamManager.isStreaming(currentRoom.name)) {
          streamManager.setProducerActive(currentRoom.name, producer.id, true);
        }
      }
      if (currentRoom) {
        socket.to(currentRoom.name).emit("peer-unmuted", { peerId: socket.id });
      }
      cb({ ok: true });
    });

    // --- Audio share (a peer casting system/tab audio as a stereo producer) ---
    // start-share pins the room to SFU (a stereo producer must be routed by the
    // server) and announces it; the client then produces a "share" track. We
    // broadcast share-started/-stopped so peers play a cue + SR announcement.
    socket.on("start-share", (_data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      currentRoom.sharers.add(socket.id);
      socket.to(currentRoom.name).emit("share-started", {
        peerId: socket.id,
        displayName: currentPeer.displayName,
      });
      applyModeDecision(currentRoom);
      cb?.({ ok: true });
    });

    socket.on("stop-share", (_data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      currentRoom.sharers.delete(socket.id);
      // Close this peer's share producer(s) so consumers stop receiving the
      // music; the matching consumers close client-side via share-stopped.
      for (const [id, producer] of currentPeer.producers) {
        if ((producer.appData?.source as string) === "share") {
          producer.close();
          currentPeer.producers.delete(id);
          // Also stop its capture/feed if recording/streaming — otherwise the
          // recorder/mixer idles on a dead port until it ends.
          if (recordingManager.isRecording(currentRoom.name)) {
            void recordingManager.removeProducer(currentRoom.name, id).catch(() => {});
          }
          if (streamManager.isStreaming(currentRoom.name)) {
            void streamManager.removeProducer(currentRoom.name, id).catch(() => {});
          }
        }
      }
      socket.to(currentRoom.name).emit("share-stopped", {
        peerId: socket.id,
        displayName: currentPeer.displayName,
      });
      // No longer pins SFU — fall back to P2P if <=2 peers and nothing else forces it.
      applyModeDecision(currentRoom);
      cb?.({ ok: true });
    });

    // --- File streaming (a peer streaming a local audio file as a stereo
    // producer). Independent of the audio share above and of any caster: a peer
    // can stream a file AND share system audio at the same time. start-file-stream
    // pins the room to SFU (a stereo producer must be routed by the server) and
    // announces it; the client then produces a "file" track. ---
    socket.on("start-file-stream", (_data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      currentRoom.fileStreamers.add(socket.id);
      socket.to(currentRoom.name).emit("file-stream-started", {
        peerId: socket.id,
        displayName: currentPeer.displayName,
      });
      applyModeDecision(currentRoom);
      cb?.({ ok: true });
    });

    socket.on("stop-file-stream", (_data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      currentRoom.fileStreamers.delete(socket.id);
      // Close this peer's file producer(s) so consumers stop receiving the audio;
      // the matching consumers close client-side via file-stream-stopped.
      for (const [id, producer] of currentPeer.producers) {
        if ((producer.appData?.source as string) === "file") {
          producer.close();
          currentPeer.producers.delete(id);
          // Also stop its capture/feed if recording/streaming — otherwise the
          // recorder/mixer idles on a dead port until it ends.
          if (recordingManager.isRecording(currentRoom.name)) {
            void recordingManager.removeProducer(currentRoom.name, id).catch(() => {});
          }
          if (streamManager.isStreaming(currentRoom.name)) {
            void streamManager.removeProducer(currentRoom.name, id).catch(() => {});
          }
        }
      }
      socket.to(currentRoom.name).emit("file-stream-stopped", {
        peerId: socket.id,
        displayName: currentPeer.displayName,
      });
      // No longer pins SFU — fall back to P2P if <=2 peers and nothing else forces it.
      applyModeDecision(currentRoom);
      cb?.({ ok: true });
    });

    // A media producer's display detail changed (a file streamer swapped files —
    // the producer persists, only its `title` changes). Update appData and re-
    // broadcast so other peers re-label the tile. Voice never carries a title.
    socket.on("update-stream-title", (data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      const parsed = z
        .object({ producerId: z.string(), title: z.string().trim().max(120).optional() })
        .safeParse(data);
      if (!parsed.success) return cb?.({ ok: false, error: "Invalid payload" });
      const { producerId, title } = parsed.data;
      const producer = currentPeer.producers.get(producerId);
      const src = producer ? (producer.appData?.source as string) : undefined;
      // Ownership is implicit (only this peer's producer map); guard the source so
      // a voice/music producer can never be re-titled.
      if (!producer || !src || src === "voice" || src === "music") {
        return cb?.({ ok: false, error: "No such media producer" });
      }
      producer.appData.title = title || undefined;
      socket.to(currentRoom.name).emit("producer-title-updated", {
        producerId,
        title: title || undefined,
      });
      cb?.({ ok: true });
    });

    // --- Extra microphone streams (a peer streaming additional input devices,
    // each as its own "mic" producer alongside their voice). Like a share/file it
    // pins SFU (a separate producer must be routed by the server) and is auto-
    // tapped by recording/streaming. Unlike a share (one per peer) a peer can
    // have several, so the stop is addressed by producerId. The "mic" producer is
    // excluded from ducking and from mute by the source checks in the produce /
    // producer-pause handlers — extra mics never duck and aren't muted. ---
    socket.on("start-extra-mic", (_data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      // Idempotent: a peer streaming several mics is a single set membership, so
      // announce only on their first one (the per-device tiles arrive separately
      // via new-producer).
      const firstForPeer = !currentRoom.extraMicStreamers.has(socket.id);
      currentRoom.extraMicStreamers.add(socket.id);
      if (firstForPeer) {
        socket.to(currentRoom.name).emit("mic-stream-started", {
          peerId: socket.id,
          displayName: currentPeer.displayName,
        });
      }
      applyModeDecision(currentRoom);
      cb?.({ ok: true });
    });

    socket.on("stop-extra-mic", (data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      // producerId is optional: a client that registered an extra mic but never
      // reached SFU (so never produced) sends none — we still reconcile the set
      // below so the SFU pin can't leak.
      const parsed = z.object({ producerId: z.string().optional() }).safeParse(data);
      if (!parsed.success) return cb?.({ ok: false, error: "Invalid value" });
      const { producerId } = parsed.data;
      if (producerId) {
        const producer = currentPeer.producers.get(producerId);
        // Ownership + source guard: only ever close this peer's own "mic" producers.
        if (!producer || (producer.appData?.source as string) !== "mic") {
          return cb?.({ ok: false, error: "Unknown mic producer" });
        }
        producer.close();
        currentPeer.producers.delete(producerId);
        // Stop its capture/feed if recording/streaming — otherwise the recorder/
        // mixer idles on a dead port until it ends.
        if (recordingManager.isRecording(currentRoom.name)) {
          void recordingManager.removeProducer(currentRoom.name, producerId).catch(() => {});
        }
        if (streamManager.isStreaming(currentRoom.name)) {
          void streamManager.removeProducer(currentRoom.name, producerId).catch(() => {});
        }
      }
      // Release the SFU pin only once this peer's LAST mic producer is gone.
      const hasMoreMics = Array.from(currentPeer.producers.values()).some(
        (p) => (p.appData?.source as string) === "mic",
      );
      if (!hasMoreMics) currentRoom.extraMicStreamers.delete(socket.id);
      // Only the peers that saw a tile (i.e. a real producer) need it removed.
      if (producerId) {
        socket.to(currentRoom.name).emit("mic-stream-stopped", {
          peerId: socket.id,
          producerId,
          displayName: currentPeer.displayName,
          last: !hasMoreMics,
        });
      }
      applyModeDecision(currentRoom);
      cb?.({ ok: true });
    });

    // --- Auto-ducking toggle (room-wide) ---
    // Anyone can turn the room's auto-ducking on/off. Off means listeners stop
    // ducking every music-type stream (caster/share/file). We just flip the room
    // flag and broadcast it to EVERYONE (incl. the sender, like recording) — the
    // gain change itself is applied client-side in effectiveGain.
    socket.on("set-ducking", (data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      const parsed = z.object({ enabled: z.boolean() }).safeParse(data);
      if (!parsed.success) return cb?.({ ok: false, error: "Invalid value" });
      currentRoom.duckingEnabled = parsed.data.enabled;
      io.to(currentRoom.name).emit("ducking-changed", {
        enabled: parsed.data.enabled,
        by: currentPeer.displayName,
      });
      cb?.({ ok: true });
    });

    // --- Recording ---
    socket.on("start-recording", async (_data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }
        const room = currentRoom;

        if (recordingManager.isRecording(room.name)) {
          cb({ ok: true, recordingId: recordingManager.getRecording(room.name)!.id });
          return;
        }

        // Snapshot producers that already exist (only present if the room was
        // already in SFU). In P2P there are none yet — applyModeDecision below
        // forces SFU, and each peer's `produce` then registers via addProducer.
        const producers: ProducerInfo[] = [];
        for (const [peerId, peer] of room.peers) {
          for (const [producerId, producer] of peer.producers) {
            producers.push({
              producerId,
              peerId,
              label: peer.displayName,
              source: (producer.appData?.source as string) ?? "voice",
            });
          }
        }

        const rec = await recordingManager.start(room.name, room.router, producers);
        // Force SFU if we're in P2P so the server can see the media.
        applyModeDecision(room);

        io.to(room.name).emit("recording-started", {
          recordingId: rec.id,
          by: currentPeer?.displayName ?? "Someone",
        });
        cb({ ok: true, recordingId: rec.id });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Failed to start recording" });
      }
    });

    socket.on("stop-recording", async (_data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }
        const room = currentRoom;
        // Finalize (not discard): captures stop, but the file stays
        // downloadable until its TTL / a new recording / room exit.
        const rec = await recordingManager.finalize(room.name);
        io.to(room.name).emit("recording-stopped", { recordingId: rec?.id ?? null });
        // Recording no longer pins SFU — fall back to P2P if <=2 peers remain.
        applyModeDecision(room);
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Failed to stop recording" });
      }
    });

    // --- Live streaming to Icecast (room-wide; forces SFU like recording) ---
    // The starter supplies the Icecast target; the server runs the mixer ffmpeg.
    // The config (incl. password) is NOT broadcast — only the fact that the room
    // is now live, and by whom.
    socket.on("start-streaming", async (data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }
        const room = currentRoom;

        if (streamManager.isStreaming(room.name)) {
          cb({ ok: true });
          return;
        }

        const parsed = icecastConfigSchema.safeParse(data);
        if (!parsed.success) {
          cb({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid streaming settings" });
          return;
        }
        const config: IcecastConfig = parsed.data;

        // Snapshot producers that already exist (only present if already in
        // SFU). In P2P there are none yet — applyModeDecision below forces SFU
        // and each peer's `produce` then registers via addProducer.
        const producers: ProducerInfo[] = [];
        for (const [peerId, peer] of room.peers) {
          for (const [producerId, producer] of peer.producers) {
            const src = (producer.appData?.source as string) ?? "voice";
            producers.push({ producerId, peerId, label: peer.displayName, source: src });
          }
        }

        await streamManager.start(room.name, room.router, producers, config);
        // Force SFU if we're in P2P so the server can see the media.
        applyModeDecision(room);

        io.to(room.name).emit("streaming-started", {
          by: currentPeer?.displayName ?? "Someone",
        });
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Failed to start streaming" });
      }
    });

    socket.on("stop-streaming", async (_data: unknown, cb: (res: unknown) => void) => {
      try {
        if (!currentRoom) {
          cb({ ok: false, error: "Not in a room" });
          return;
        }
        const room = currentRoom;
        await streamManager.stop(room.name);
        io.to(room.name).emit("streaming-stopped", {});
        // Streaming no longer pins SFU — fall back to P2P if <=2 peers remain.
        applyModeDecision(room);
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, error: err instanceof Error ? err.message : "Failed to stop streaming" });
      }
    });

    // --- Ask to join (knock) decision ---
    // Any participant in the room can allow or deny a pending requester. The
    // first decision wins (the request is removed); a late/duplicate decision
    // for an already-resolved request is a harmless no-op. Allow records the
    // requester's token as admitted and pushes `join-approved` so their client
    // re-joins; deny pushes `join-denied`.
    socket.on("join-decision", (data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      const parsed = z.object({ requestId: z.string(), allow: z.boolean() }).safeParse(data);
      if (!parsed.success) return cb?.({ ok: false, error: "Invalid decision" });

      const room = currentRoom;
      const { requestId, allow } = parsed.data;
      const pending = room.pendingJoins.get(requestId);
      if (!pending) return cb?.({ ok: true }); // already resolved by someone else

      room.pendingJoins.delete(requestId);
      if (allow) {
        if (pending.token) room.admittedTokens.add(pending.token);
        io.to(requestId).emit("join-approved", {});
        console.log(`[ws] ${currentPeer.displayName} admitted ${requestId} to ${room.name}`);
      } else {
        // Ban the denied visitor's IP from THIS room (only) so they can't just
        // re-knock; the ban lives as long as the room does.
        if (pending.ip) room.bannedIps.add(pending.ip);
        // Drop the name from the auto-admit set: a denial overrides any earlier
        // admission, so this name must knock again rather than walk back in.
        room.admittedNames.delete(pending.displayName);
        io.to(requestId).emit("join-denied", { by: currentPeer.displayName });
        console.log(
          `[ws] ${currentPeer.displayName} denied + banned ${requestId} (${pending.ip}) from ${room.name}`,
        );
      }
      broadcastJoinRequests(room);
      cb?.({ ok: true });
    });

    // --- Vote to kick (public rooms; no moderators) ---
    // Cast or withdraw a vote to remove another peer. Real toggles broadcast a
    // `kick-vote` to the whole room (so everyone updates the tally + announces);
    // once a target reaches kickThreshold it's removed (settleKicks). Casters
    // and yourself can't be targeted; private rooms — and two-person rooms (no
    // real majority) — have no vote-kick at all.
    socket.on("vote-kick", (data: unknown, cb?: (res: unknown) => void) => {
      if (!currentRoom || !currentPeer) return cb?.({ ok: false, error: "Not in a room" });
      const room = currentRoom;
      if (!room.isPublic) return cb?.({ ok: false, error: "not_public" });
      // Defense-in-depth — the client also hides the controls below 3 votable
      // peers (kickThreshold is Infinity there, so a vote could never land).
      if (votablePeerCount(room) < 3) return cb?.({ ok: false, error: "too_small" });

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
        voterName: currentPeer.displayName,
        action: vote ? "cast" : "withdraw",
      });

      // A fresh vote may have reached the threshold (or a withdraw left it below).
      settleKicks(room);
      cb?.({ ok: true });
    });

    socket.on("disconnect", (reason) => {
      console.log(`[ws] disconnected: ${socket.id} (${reason})`);
      chatLimiter.forget(socket.id);
      kickLimiter.forget(socket.id);

      // A visitor who was still knocking (never admitted) bailed — retract their
      // request so participants' modals update.
      if (pendingRequest) {
        pendingRequest.pendingJoins.delete(socket.id);
        broadcastJoinRequests(pendingRequest);
        pendingRequest = null;
      }

      if (currentRoom && currentPeer) {
        const room = currentRoom;
        // Shared teardown (also re-evaluates the mode). No-ops if this peer was
        // already removed by a vote-kick that force-disconnected them.
        teardownPeer(room, socket.id, { announceLeft: true });
        // A departure shrinks the room, lowering the kick threshold — that can
        // push an already-half-voted target over the line, so re-settle.
        settleKicks(room);
      }
    });
  });

  return { io, postChatMessage };
}
