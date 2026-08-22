import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { getRooms } from "./room-manager.js";
import { RateLimiter } from "./chat-util.js";
import type { RecordingManager } from "./recording.js";
import type { StreamManager } from "./streaming.js";
import { createRoomHelpers } from "./signaling/room-helpers.js";
import type { ConnectionContext, ConnectionSession } from "./signaling/context.js";
import { registerSessionHandlers } from "./signaling/handlers/session.js";
import { registerSfuHandlers } from "./signaling/handlers/sfu.js";
import { registerStreamHandlers } from "./signaling/handlers/streams.js";
import { registerRecordingHandlers } from "./signaling/handlers/recording.js";
import { registerStreamingHandlers } from "./signaling/handlers/streaming.js";
import { registerModerationHandlers } from "./signaling/handlers/moderation.js";
import { registerNotesHandlers } from "./signaling/handlers/notes.js";
import { registerVideoHandlers } from "./signaling/handlers/video.js";

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

  // Room-scoped operations shared by every connection handler (mode switching,
  // teardown, kick settlement, chat fan-out, ducking), bound once to io + the
  // managers.
  const helpers = createRoomHelpers(io, recordingManager, streamManager);

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
    if (room) helpers.applyModeDecision(room);
  };

  // Anti-spam: 5 messages / 10s per sender, keyed by socket id. Blocked sends
  // are dropped (the client keeps the unsent text and plays a "thunk"), never
  // queued.
  const chatLimiter = new RateLimiter();

  // Anti-spam for vote-to-kick: at most 5 vote *changes* / 10s per voter, so a
  // peer can't flood the room with "X voted to kick Y / withdrew…" churn.
  // Keyed by socket id; only real cast/withdraw toggles consume a slot (a
  // redundant re-vote or empty withdraw is a no-op and doesn't count).
  const kickLimiter = new RateLimiter();

  io.on("connection", (socket) => {
    console.log(`[ws] connected: ${socket.id}`);

    // Per-connection mutable state, populated by the join handler and read by
    // the rest. Held in one object so every handler group shares the same live
    // values the old single connection closure did.
    const session: ConnectionSession = {
      currentRoom: null,
      currentPeer: null,
      pendingRequest: null,
    };

    const ctx: ConnectionContext = {
      io,
      socket,
      recordingManager,
      streamManager,
      chatLimiter,
      kickLimiter,
      helpers,
      session,
    };

    registerSessionHandlers(ctx);
    registerSfuHandlers(ctx);
    registerStreamHandlers(ctx);
    registerRecordingHandlers(ctx);
    registerStreamingHandlers(ctx);
    registerModerationHandlers(ctx);
    registerNotesHandlers(ctx);
    registerVideoHandlers(ctx);
  });

  return { io };
}
