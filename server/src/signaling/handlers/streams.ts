import { z } from "zod";
import type { ConnectionContext } from "../context.js";

// --- Peer media-stream sources: audio share, local-file stream, extra mics,
// title updates, and the room-wide auto-ducking toggle. Each share/file/mic
// source is a separate producer that pins the room to the SFU. ---
export function registerStreamHandlers(ctx: ConnectionContext) {
  const { io, socket, recordingManager, streamManager, helpers, session } = ctx;

  // --- Audio share (a peer casting system/tab audio as a stereo producer) ---
  // start-share pins the room to SFU (a stereo producer must be routed by the
  // server) and announces it; the client then produces a "share" track. We
  // broadcast share-started/-stopped so peers play a cue + SR announcement.
  socket.on("start-share", (_data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const { currentRoom, currentPeer } = session;
    currentRoom.sharers.add(socket.id);
    socket.to(currentRoom.name).emit("share-started", {
      peerId: socket.id,
      displayName: currentPeer.displayName,
    });
    helpers.applyModeDecision(currentRoom);
    cb?.({ ok: true });
  });

  socket.on("stop-share", (_data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const { currentRoom, currentPeer } = session;
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
    helpers.applyModeDecision(currentRoom);
    cb?.({ ok: true });
  });

  // --- File streaming (a peer streaming a local audio file as a stereo
  // producer). Independent of the audio share above and of any caster: a peer
  // can stream a file AND share system audio at the same time. start-file-stream
  // pins the room to SFU (a stereo producer must be routed by the server) and
  // announces it; the client then produces a "file" track. ---
  socket.on("start-file-stream", (_data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const { currentRoom, currentPeer } = session;
    currentRoom.fileStreamers.add(socket.id);
    socket.to(currentRoom.name).emit("file-stream-started", {
      peerId: socket.id,
      displayName: currentPeer.displayName,
    });
    helpers.applyModeDecision(currentRoom);
    cb?.({ ok: true });
  });

  socket.on("stop-file-stream", (_data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const { currentRoom, currentPeer } = session;
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
    helpers.applyModeDecision(currentRoom);
    cb?.({ ok: true });
  });

  // A media producer's display detail changed (a file streamer swapped files —
  // the producer persists, only its `title` changes). Update appData and re-
  // broadcast so other peers re-label the tile. Voice never carries a title.
  socket.on("update-stream-title", (data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const { currentRoom, currentPeer } = session;
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
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const { currentRoom, currentPeer } = session;
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
    helpers.applyModeDecision(currentRoom);
    cb?.({ ok: true });
  });

  socket.on("stop-extra-mic", (data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const { currentRoom, currentPeer } = session;
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
    helpers.applyModeDecision(currentRoom);
    cb?.({ ok: true });
  });

  // --- Auto-ducking toggle (room-wide) ---
  // Anyone can turn the room's auto-ducking on/off. Off means listeners stop
  // ducking every music-type stream (caster/share/file). We just flip the room
  // flag and broadcast it to EVERYONE (incl. the sender, like recording) — the
  // gain change itself is applied client-side in effectiveGain.
  socket.on("set-ducking", (data: unknown, cb?: (res: unknown) => void) => {
    if (!session.currentRoom || !session.currentPeer)
      return cb?.({ ok: false, error: "Not in a room" });
    const { currentRoom, currentPeer } = session;
    const parsed = z.object({ enabled: z.boolean() }).safeParse(data);
    if (!parsed.success) return cb?.({ ok: false, error: "Invalid value" });
    currentRoom.duckingEnabled = parsed.data.enabled;
    io.to(currentRoom.name).emit("ducking-changed", {
      enabled: parsed.data.enabled,
      by: currentPeer.displayName,
    });
    cb?.({ ok: true });
  });
}
