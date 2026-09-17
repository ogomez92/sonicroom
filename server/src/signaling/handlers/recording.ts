import type { ProducerInfo } from "../../recording.js";
import type { ConnectionContext } from "../context.js";
import { allowed } from "../../moderation-util.js";

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
      // Moderated room: recording may be admins-only or off.
      if (!allowed(room.moderation, room.admins.has(socket.id), "recording")) {
        cb({ ok: false, error: "forbidden" });
        return;
      }

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
          // Audio always; picture too, but only in a video room — where the
          // download renders each person's camera with their own voice as an
          // MP4. An audio room has no video producers at all, so this stays a
          // pure Opus pipeline there.
          if (producer.kind !== "audio" && !room.isVideo) continue;
          producers.push({
            producerId,
            peerId,
            label: peer.displayName,
            source: (producer.appData?.source as string) ?? "voice",
            kind: producer.kind === "video" ? "video" : "audio",
          });
        }
      }

      const rec = await recordingManager.start(room.name, room.router, producers);
      // Force SFU if we're in P2P so the server can see the media.
      helpers.applyModeDecision(room);

      // The recording id is the download capability: a peer the policy keeps
      // from recording still learns the room is being recorded (REC badge,
      // announcement) but is handed no id, so no download buttons.
      const by = session.currentPeer?.displayName ?? "Someone";
      for (const id of room.peers.keys()) {
        io.to(id).emit("recording-started", {
          recordingId: helpers.canRecord(room, id) ? rec.id : null,
          by,
        });
      }
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
      if (!allowed(room.moderation, room.admins.has(socket.id), "recording")) {
        cb({ ok: false, error: "forbidden" });
        return;
      }
      // Finalize (not discard): captures stop, but the file stays
      // downloadable until its TTL / a new recording / room exit.
      const rec = await recordingManager.finalize(room.name);
      for (const id of room.peers.keys()) {
        io.to(id).emit("recording-stopped", {
          recordingId: rec && helpers.canRecord(room, id) ? rec.id : null,
        });
      }
      // Recording no longer pins SFU — fall back to P2P if <=2 peers remain.
      helpers.applyModeDecision(room);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err instanceof Error ? err.message : "Failed to stop recording" });
    }
  });
}
