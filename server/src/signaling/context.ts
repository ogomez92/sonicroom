import type { Server, Socket } from "socket.io";
import type { Room, Peer } from "../room-manager.js";
import type { RecordingManager } from "../recording.js";
import type { StreamManager } from "../streaming.js";
import type { RateLimiter } from "../chat-util.js";
import type { RoomHelpers } from "./room-helpers.js";

// Per-connection mutable state. The join handler sets currentRoom/currentPeer
// once the socket is admitted; every other handler reads them. pendingRequest is
// the public room this socket is knocking on but not yet admitted to (so the
// disconnect handler can retract a pending knock even though the visitor was
// never added as a peer). Held in one object so the handler groups — split
// across ./handlers/* — share the same live state the old single closure did.
export interface ConnectionSession {
  currentRoom: Room | null;
  currentPeer: Peer | null;
  pendingRequest: Room | null;
}

// Everything one connection's handler groups need: the server, this socket, the
// recording/stream managers, the per-socket rate limiters, the room helpers, and
// the mutable session above. Built once per connection and passed to each
// register*() function.
export interface ConnectionContext {
  io: Server;
  socket: Socket;
  recordingManager: RecordingManager;
  streamManager: StreamManager;
  chatLimiter: RateLimiter;
  kickLimiter: RateLimiter;
  helpers: RoomHelpers;
  session: ConnectionSession;
}
