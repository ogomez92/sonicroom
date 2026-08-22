import { useEffect, useRef } from "react";
import { Video as VideoIcon } from "lucide-react";
import { useRoomStore, type VideoTile } from "../../stores/room";
import { m } from "../../paraglide/messages.js";

// The video grid for a VIDEO room: our own camera (mirrored, like a mirror —
// never audible: the mic goes through the audio graph) plus one tile per
// incoming camera/screen producer. Shared screens get a bigger cell. This
// component is lazy-loaded by Room ONLY when the room is a video room, so audio
// rooms never ship or mount it. The MediaStreams come from the video controller
// via the getters; the store holds the tile records.
interface VideoStageProps {
  getLocalStream: () => MediaStream | null;
  getStream: (producerId: string) => MediaStream | null;
}

function VideoTileView({
  stream,
  label,
  mirrored,
  large,
}: {
  stream: MediaStream | null;
  label: string;
  mirrored: boolean;
  large: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return (
    <figure
      className={`relative overflow-hidden rounded-xl border border-sonic-700 bg-black ${
        large ? "col-span-2 row-span-2 aspect-video" : "aspect-video"
      }`}
    >
      {/* Muted: every tile's AUDIO is already played through the shared Web
          Audio graph (per-peer gain/ducking/deafen); the <video> only draws. */}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        aria-label={label}
        className={`h-full w-full object-cover ${mirrored ? "-scale-x-100" : ""}`}
      />
      <figcaption className="absolute bottom-0 left-0 right-0 truncate bg-gradient-to-t from-black/80 to-transparent px-3 py-1.5 text-xs font-medium text-white">
        {label}
      </figcaption>
    </figure>
  );
}

export default function VideoStage({ getLocalStream, getStream }: VideoStageProps) {
  const isVideoOn = useRoomStore((s) => s.isVideoOn);
  const localVideoSeq = useRoomStore((s) => s.localVideoSeq);
  const videoTiles = useRoomStore((s) => s.videoTiles);
  const peers = useRoomStore((s) => s.peers);

  // Re-read the local stream whenever the controller says it changed.
  const localStream = isVideoOn ? getLocalStream() : null;
  void localVideoSeq;

  const tiles: VideoTile[] = Array.from(videoTiles.values());
  // Screens first (they're the thing being shown), then cameras.
  tiles.sort((a, b) => (a.source === b.source ? 0 : a.source === "screen" ? -1 : 1));

  if (!localStream && tiles.length === 0) {
    return (
      <section
        aria-label={m.room_video_stage_label()}
        className="flex w-full max-w-3xl items-center justify-center gap-2 rounded-xl border border-dashed border-sonic-700 px-4 py-6 text-sm text-sonic-400"
      >
        <VideoIcon className="h-4 w-4" aria-hidden="true" />
        {m.room_video_empty()}
      </section>
    );
  }

  const nameOf = (peerId: string) => peers.get(peerId)?.displayName ?? "";

  return (
    <section
      aria-label={m.room_video_stage_label()}
      className="grid w-full max-w-5xl grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4"
    >
      {tiles.map((tile) => (
        <VideoTileView
          key={tile.producerId}
          stream={getStream(tile.producerId)}
          label={
            tile.source === "screen"
              ? m.video_tile_screen({ name: nameOf(tile.peerId) })
              : m.video_tile_camera({ name: nameOf(tile.peerId) })
          }
          mirrored={false}
          large={tile.source === "screen"}
        />
      ))}
      {localStream && (
        <VideoTileView
          key={`self-${localVideoSeq}`}
          stream={localStream}
          label={m.video_tile_self()}
          mirrored
          large={false}
        />
      )}
    </section>
  );
}
