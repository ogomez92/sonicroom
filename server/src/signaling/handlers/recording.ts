import type { ProducerInfo } from "../../recording.js";
import type { ConnectionContext } from "../context.js";

// --- Recording (room-wide; forces SFU so the server can see the media) ---
export function registerRecordingHandlers(ctx: ConnectionContext) {
  const { io, socket, recordingManager, helpers, session } = ctx;

  socket.on("start-recording", async (_data: unknown, cb: (res: unknown) => void) => {
    try {
      if (!session.currentRoom) {
        cb({ ok: false, error: "Not in a room" });
        return;
      }
      const room = session.currentRoom;

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
      helpers.applyModeDecision(room);

      io.to(room.name).emit("recording-started", {
        recordingId: rec.id,
        by: session.currentPeer?.displayName ?? "Someone",
      });
      cb({ ok: true, recordingId: rec.id });
    } catch (err) {
      cb({ ok: false, error: err instanceof Error ? err.message : "Failed to start recording" });
    }
  });

  socket.on("stop-recording", async (_data: unknown, cb: (res: unknown) => void) => {
    try {
      if (!session.currentRoom) {
        cb({ ok: false, error: "Not in a room" });
        return;
      }
      const room = session.currentRoom;
      // Finalize (not discard): captures stop, but the file stays
      // downloadable until its TTL / a new recording / room exit.
      const rec = await recordingManager.finalize(room.name);
      io.to(room.name).emit("recording-stopped", { recordingId: rec?.id ?? null });
      // Recording no longer pins SFU — fall back to P2P if <=2 peers remain.
      helpers.applyModeDecision(room);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err instanceof Error ? err.message : "Failed to stop recording" });
    }
  });
}
