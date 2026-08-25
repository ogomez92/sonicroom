import type { ConnectionContext } from "../context.js";

// --- Camera video (VIDEO rooms only). A peer's webcam is its own "camera"
// producer, like share/file are separate audio producers. The room is already
// pinned to the SFU by its type (shouldForceSfu), so these handlers never touch
// the mode — they only (a) broadcast the on/off so peers can announce/chime,
// and (b) authoritatively close the camera producer on "off" so every consumer
// drops the tile even if the client's own close didn't reach the server. The
// screen-share video ("screen") is owned by start-share/stop-share instead:
// one share, two producers. Both are rejected outright by the produce handler
// unless room.isVideo. ---
export function registerVideoHandlers(ctx: ConnectionContext) {
  const { socket, recordingManager, session } = ctx;

  socket.on("start-video", (_data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const { currentRoom, currentPeer } = session;
    if (!currentRoom.isVideo) return cb?.({ ok: false, error: "not_video_room" });
    socket.to(currentRoom.name).emit("video-started", {
      peerId: socket.id,
      displayName: currentPeer.displayName,
    });
    cb?.({ ok: true });
  });

  socket.on("stop-video", (_data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const { currentRoom, currentPeer } = session;
    for (const [id, producer] of currentPeer.producers) {
      if ((producer.appData?.source as string) === "camera") {
        producer.close();
        currentPeer.producers.delete(id);
        // Stop its capture too if the room is being recorded — otherwise the
        // recorder idles on a dead port until the recording ends. The picture
        // captured so far is kept and still appears in the download, exactly
        // like a stopped audio share (see stop-share).
        if (recordingManager.isRecording(currentRoom.name)) {
          void recordingManager.removeProducer(currentRoom.name, id).catch(() => {});
        }
      }
    }
    socket.to(currentRoom.name).emit("video-stopped", {
      peerId: socket.id,
      displayName: currentPeer.displayName,
    });
    cb?.({ ok: true });
  });
}
