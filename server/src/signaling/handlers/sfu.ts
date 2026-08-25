import { z } from "zod";
import type { DtlsParameters, MediaKind, RtpCapabilities, RtpParameters } from "mediasoup/types";
import { createWebRtcTransport } from "../../room-manager.js";
import type { ProducerInfo } from "../../recording.js";
import type { ConnectionContext } from "../context.js";

// --- SFU transport/produce/consume + mute/unmute ---
export function registerSfuHandlers(ctx: ConnectionContext) {
  const { socket, recordingManager, streamManager, session } = ctx;

  socket.on("create-transport", async (data: unknown, cb: (res: unknown) => void) => {
    try {
      if (!session.currentRoom || !session.currentPeer) {
        cb({ ok: false, error: "Not in a room" });
        return;
      }

      const { direction } = z.object({ direction: z.enum(["send", "recv"]) }).parse(data);
      const { transport, params } = await createWebRtcTransport(session.currentRoom);

      if (direction === "send") {
        session.currentPeer.sendTransport = transport;
      } else {
        session.currentPeer.recvTransport = transport;
      }

      cb({ ok: true, params });
    } catch (err) {
      cb({ ok: false, error: err instanceof Error ? err.message : "Transport creation failed" });
    }
  });

  socket.on("connect-transport", async (data: unknown, cb: (res: unknown) => void) => {
    try {
      if (!session.currentPeer) {
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
        direction === "send"
          ? session.currentPeer.sendTransport
          : session.currentPeer.recvTransport;

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
      if (!session.currentRoom || !session.currentPeer?.sendTransport) {
        cb({ ok: false, error: "No send transport" });
        return;
      }
      const { currentRoom, currentPeer } = session;

      const { kind, rtpParameters, source, title } = z
        .object({
          kind: z.enum(["audio", "video"]) as z.ZodType<MediaKind>,
          rtpParameters: z.any() as z.ZodType<RtpParameters>,
          // "music" for a caster's stereo track, "share" for a peer's stereo
          // system/tab-audio share, "file" for a peer streaming a local audio
          // file, "mic" for an EXTRA microphone (a separate producer alongside
          // the peer's voice), "voice" (default) for the primary mic. VIDEO
          // rooms only: "camera" for a peer's webcam, "screen" for the video
          // half of their screen share.
          source: z.enum(["voice", "music", "share", "file", "mic", "camera", "screen"]).optional(),
          // Human-readable detail for a media producer (extra-mic device name,
          // file name / URL), shown alongside the owner in the participant list.
          // Trusted only as a display string; capped so a peer can't flood it.
          title: z.string().trim().max(120).optional(),
        })
        .parse(data);

      // Audio-first, enforced server-side: video is only ever routed in a
      // VIDEO room, and the kind must match the source (a "camera" producer is
      // video, everything else is audio) so a client can't smuggle a video
      // track under an audio label or vice versa.
      const isVideoSource = source === "camera" || source === "screen";
      if (kind === "video" && !currentRoom.isVideo) {
        cb({ ok: false, error: "not_video_room" });
        return;
      }
      if ((kind === "video") !== isVideoSource) {
        cb({ ok: false, error: "kind_source_mismatch" });
        return;
      }

      const producer = await currentPeer.sendTransport!.produce({
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
      // streaming each consume the producer independently. Recording takes
      // picture as well in a video room (the download renders it as MP4);
      // Icecast streaming stays audio-only everywhere — it's an Opus/MP3 feed.
      const producerInfo: ProducerInfo = {
        producerId: producer.id,
        peerId: socket.id,
        label: currentPeer.displayName,
        source: source ?? "voice",
        kind: producer.kind === "video" ? "video" : "audio",
      };
      if (recordingManager.isRecording(currentRoom.name)) {
        void recordingManager
          .addProducer(currentRoom.name, producerInfo)
          .catch((err) => console.error("[recording] addProducer failed:", err));
      }
      if (producer.kind === "audio" && streamManager.isStreaming(currentRoom.name)) {
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
      if (!session.currentRoom || !session.currentPeer?.recvTransport) {
        cb({ ok: false, error: "No recv transport" });
        return;
      }
      const { currentRoom, currentPeer } = session;

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

      const consumer = await currentPeer.recvTransport!.consume({
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
    if (!session.currentPeer) return cb({ ok: false });
    const { currentRoom, currentPeer } = session;
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
    if (!session.currentPeer) return cb({ ok: false });
    const { currentRoom, currentPeer } = session;
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
}
