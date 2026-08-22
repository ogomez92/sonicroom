import type { ProducerInfo } from "../../recording.js";
import type { IcecastConfig } from "../../streaming-util.js";
import { icecastConfigSchema } from "../schemas.js";
import type { ConnectionContext } from "../context.js";

// --- Live streaming to Icecast (room-wide; forces SFU like recording) ---
// The starter supplies the Icecast target; the server runs the mixer ffmpeg.
// The config (incl. password) is NOT broadcast — only the fact that the room
// is now live, and by whom.
export function registerStreamingHandlers(ctx: ConnectionContext) {
  const { io, socket, streamManager, helpers, session } = ctx;

  socket.on("start-streaming", async (data: unknown, cb: (res: unknown) => void) => {
    try {
      if (!session.currentRoom) {
        cb({ ok: false, error: "Not in a room" });
        return;
      }
      const room = session.currentRoom;

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
          // Audio only — the mixer is an Opus/MP3 pipeline (video rooms'
          // camera/screen producers are never mixed).
          if (producer.kind !== "audio") continue;
          const src = (producer.appData?.source as string) ?? "voice";
          producers.push({ producerId, peerId, label: peer.displayName, source: src });
        }
      }

      await streamManager.start(room.name, room.router, producers, config);
      // Force SFU if we're in P2P so the server can see the media.
      helpers.applyModeDecision(room);

      io.to(room.name).emit("streaming-started", {
        by: session.currentPeer?.displayName ?? "Someone",
      });
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err instanceof Error ? err.message : "Failed to start streaming" });
    }
  });

  socket.on("stop-streaming", async (_data: unknown, cb: (res: unknown) => void) => {
    try {
      if (!session.currentRoom) {
        cb({ ok: false, error: "Not in a room" });
        return;
      }
      const room = session.currentRoom;
      await streamManager.stop(room.name);
      io.to(room.name).emit("streaming-stopped", {});
      // Streaming no longer pins SFU — fall back to P2P if <=2 peers remain.
      helpers.applyModeDecision(room);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err instanceof Error ? err.message : "Failed to stop streaming" });
    }
  });
}
