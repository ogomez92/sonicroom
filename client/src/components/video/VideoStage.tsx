import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Video as VideoIcon, Pin, PinOff, Maximize, Minimize } from "lucide-react";
import { useRoomStore, isPinned, type VideoTile } from "../../stores/room";
import { bestGrid } from "../../lib/video/stage-layout";
import {
  canFullscreen,
  exitFullscreen,
  isFullscreen,
  onFullscreenChange,
  requestFullscreen,
} from "../../lib/video/fullscreen";
import { m } from "../../paraglide/messages.js";

// The video grid for a VIDEO room: our own camera (mirrored, like a mirror —
// never audible: the mic goes through the audio graph) plus one tile per
// incoming camera/screen producer. This component is lazy-loaded by Room ONLY
// when the room is a video room, so audio rooms never ship or mount it. The
// MediaStreams come from the video controller via the getters; the store holds
// the tile records.
//
// SIZE (the thing a low-vision user actually feels): the stage FILLS the space
// Room gives it and the grid is chosen by measurement — `bestGrid` picks the
// column count whose tiles come out biggest in the box we actually have. A
// hardcoded `grid-cols-4` used to draw a one-on-one call as a small square in
// the middle of an empty page, which reads as "the video is tiny and there are
// bands above and below it". Cameras are `object-cover` so a tile is filled
// edge to edge (no letterbox bars); screens stay `object-contain` because
// cropping a shared screen loses content.
//
// FULLSCREEN: the section itself is the fullscreen element (button in the stage
// toolbar, or E in a video room). Escape leaves it like any other page.
//
// PINNING (store `pinnedVideo`, a purely local view choice): when a pinned
// camera/screen is live it fills the stage and everyone else drops to a
// thumbnail strip underneath. While the pinned picture is off (camera toggled
// off, share stopped) the pin is KEPT and the stage simply falls back to the
// even grid — it fills the screen again by itself when that producer returns.
interface VideoStageProps {
  getLocalStream: () => MediaStream | null;
  getStream: (producerId: string) => MediaStream | null;
  // Pin/unpin a camera or screen. Comes from Room (the SAME handler the
  // participant list's Pin option uses) so the tile button and the menu take
  // one code path — including the announcement.
  onTogglePin: (peerId: string, source: "camera" | "screen") => void;
  // Bumped by Room's E shortcut to toggle fullscreen — the room's single
  // keydown handler can't reach this section's element, so it signals instead
  // (same shape as Chat's focusSignal).
  fullscreenSignal: number;
}

// One renderable picture — an incoming tile or our own camera — flattened so
// pinning treats "my video" exactly like anyone else's.
interface Entry {
  key: string;
  peerId: string;
  source: VideoTile["source"];
  stream: MediaStream | null;
  label: string;
  mirrored: boolean;
  isScreen: boolean;
}

function VideoTileView({
  stream,
  label,
  mirrored,
  isScreen,
  pinned,
  style,
  onTogglePin,
  pinLabel,
}: {
  stream: MediaStream | null;
  label: string;
  mirrored: boolean;
  isScreen: boolean;
  // `pinned` renders this as THE stage tile (the one you chose to look at)
  // rather than a grid cell — it only changes the border.
  pinned?: boolean;
  style?: CSSProperties;
  onTogglePin?: () => void;
  pinLabel?: string;
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
      style={style}
      className={`relative h-full min-h-0 w-full overflow-hidden rounded-xl border bg-black ${
        pinned ? "border-sonic-accent" : "border-sonic-700"
      }`}
    >
      {/* Muted: every tile's AUDIO is already played through the shared Web
          Audio graph (per-peer gain/ducking/deafen); the <video> only draws.
          Cameras COVER their cell — filling it is the whole point, and the grid
          cells are close to 16:9 anyway so the crop is slight. A screen share
          CONTAINS instead: cropping it would cut off exactly the edges of the
          thing being shown. */}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        aria-label={pinned ? `${label}, ${m.video_pinned_fragment()}` : label}
        className={`h-full w-full ${isScreen ? "object-contain" : "object-cover"} ${
          mirrored ? "-scale-x-100" : ""
        }`}
      />
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={!!pinned}
          aria-label={pinLabel}
          title={pinLabel}
          className={`absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sonic-accent/60 ${
            pinned
              ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
              : "bg-black/50 text-white hover:bg-black/70"
          }`}
        >
          {pinned ? (
            <PinOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Pin className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      )}
      <figcaption className="absolute bottom-0 left-0 right-0 flex items-center gap-2 truncate bg-gradient-to-t from-black/80 to-transparent px-3 py-1.5 text-xs font-medium text-white">
        <span className="truncate">{label}</span>
        {pinned && (
          <span
            aria-hidden="true"
            className="shrink-0 rounded bg-sonic-accent/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sonic-accent"
          >
            {m.video_pinned_fragment()}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

export default function VideoStage({
  getLocalStream,
  getStream,
  onTogglePin,
  fullscreenSignal,
}: VideoStageProps) {
  const isVideoOn = useRoomStore((s) => s.isVideoOn);
  const localVideoSeq = useRoomStore((s) => s.localVideoSeq);
  const localPeerId = useRoomStore((s) => s.localPeerId);
  const videoTiles = useRoomStore((s) => s.videoTiles);
  const peers = useRoomStore((s) => s.peers);
  const pinnedVideo = useRoomStore((s) => s.pinnedVideo);
  const announce = useRoomStore((s) => s.announce);

  // Re-read the local stream whenever the controller says it changed.
  const localStream = isVideoOn ? getLocalStream() : null;
  void localVideoSeq;

  const nameOf = (peerId: string) => peers.get(peerId)?.displayName ?? "";

  const tiles: VideoTile[] = Array.from(videoTiles.values());
  // Screens and media files first (they're the thing being shown), then cameras.
  tiles.sort((a, b) =>
    a.source === b.source ? 0 : a.source === "camera" ? 1 : b.source === "camera" ? -1 : 0,
  );

  const entries: Entry[] = tiles.map((tile) => ({
    key: tile.producerId,
    peerId: tile.peerId,
    source: tile.source,
    stream: getStream(tile.producerId),
    label:
      tile.source === "screen"
        ? m.video_tile_screen({ name: nameOf(tile.peerId) })
        : tile.source === "file-video"
          ? m.file_stream_name({ name: nameOf(tile.peerId) })
          : m.video_tile_camera({ name: nameOf(tile.peerId) }),
    mirrored: false,
    isScreen: tile.source !== "camera",
  }));
  if (localStream && localPeerId) {
    entries.push({
      key: `self-${localVideoSeq}`,
      peerId: localPeerId,
      source: "camera",
      stream: localStream,
      label: m.video_tile_self(),
      mirrored: true,
      isScreen: false,
    });
  }

  // The pin resolves only while its producer is live; otherwise it just waits.
  const pinnedIdx = pinnedVideo
    ? entries.findIndex(
        (e) => e.source !== "file-video" && isPinned(pinnedVideo, e.peerId, e.source),
      )
    : -1;
  const pinnedEntry = pinnedIdx >= 0 ? entries[pinnedIdx] : null;
  const rest = pinnedEntry ? entries.filter((_, i) => i !== pinnedIdx) : entries;

  // --- Fullscreen -----------------------------------------------------------
  // The stage section is the fullscreen element. `full` is driven by the
  // browser's own event (never optimistically), so Escape and the OS chrome
  // keep it honest — and both directions are announced from one place.
  const sectionRef = useRef<HTMLElement>(null);
  const [full, setFull] = useState(false);
  const fullRef = useRef(false);
  useEffect(
    () =>
      onFullscreenChange(() => {
        const now = isFullscreen(sectionRef.current);
        if (fullRef.current === now) return;
        fullRef.current = now;
        setFull(now);
        announce(now ? m.announce_video_fullscreen_on() : m.announce_video_fullscreen_off());
      }),
    [announce],
  );

  const toggleFullscreen = useCallback(() => {
    const el = sectionRef.current;
    if (!el) return;
    if (isFullscreen(el)) {
      void exitFullscreen().catch(() => {});
      return;
    }
    // iOS Safari has no element fullscreen at all — say so rather than having
    // the button quietly do nothing.
    if (!canFullscreen(el)) {
      announce(m.announce_video_fullscreen_unavailable());
      return;
    }
    void requestFullscreen(el).catch(() => announce(m.announce_video_fullscreen_unavailable()));
  }, [announce]);

  // The E shortcut lives in Room (one keydown handler for the whole room), so
  // it reaches us as a bumped signal — same pattern as the chat focus signal.
  const seenSignal = useRef(fullscreenSignal);
  useEffect(() => {
    if (seenSignal.current === fullscreenSignal) return;
    seenSignal.current = fullscreenSignal;
    toggleFullscreen();
  }, [fullscreenSignal, toggleFullscreen]);

  // --- Measured layout ------------------------------------------------------
  // The grid box measures itself so `bestGrid` can pick the column count that
  // makes the tiles biggest here, in this window, at this participant count.
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!gridEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((observed) => {
      const rect = observed[0]?.contentRect;
      if (rect) setBox({ w: rect.width, h: rect.height });
    });
    ro.observe(gridEl);
    return () => ro.disconnect();
  }, [gridEl]);

  // A screen share among other tiles keeps its double-size cell — but only if
  // the chosen grid has the room for it (it costs 3 extra cells), otherwise it
  // would push tiles into implicit rows and overflow the stage.
  const largeIdx = !pinnedEntry && rest.length > 1 ? rest.findIndex((e) => e.isScreen) : -1;
  let grid = bestGrid(rest.length + (largeIdx >= 0 ? 3 : 0), box.w, box.h);
  const spanLarge = largeIdx >= 0 && grid.cols >= 2 && grid.rows >= 2;
  if (largeIdx >= 0 && !spanLarge) grid = bestGrid(rest.length, box.w, box.h);

  // Tell the room when a pin stops (or starts) resolving — otherwise the stage
  // silently swaps between "one big picture" and "the grid" with nothing said.
  // Only for a pin that is still the SAME one, so pinning/unpinning itself
  // (announced by the action) doesn't get announced twice.
  const pinKey = pinnedVideo ? `${pinnedVideo.peerId}:${pinnedVideo.source}` : null;
  const live = pinnedEntry != null;
  const prevPin = useRef<{ key: string | null; live: boolean }>({ key: null, live: false });
  useEffect(() => {
    const prev = prevPin.current;
    prevPin.current = { key: pinKey, live };
    if (!pinnedVideo || prev.key !== pinKey || prev.live === live) return;
    const self = pinnedVideo.peerId === localPeerId;
    const name = nameOf(pinnedVideo.peerId);
    if (live) {
      announce(
        self
          ? m.announce_pin_restored_self()
          : pinnedVideo.source === "screen"
            ? m.announce_pin_restored_screen({ name })
            : m.announce_pin_restored_video({ name }),
      );
    } else {
      announce(
        self
          ? m.announce_pin_waiting_self()
          : pinnedVideo.source === "screen"
            ? m.announce_pin_waiting_screen({ name })
            : m.announce_pin_waiting_video({ name }),
      );
    }
    // nameOf/announce are stable enough; this fires on pin identity/liveness only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey, live]);

  const pinLabelFor = (e: Entry, isPinnedNow: boolean): string => {
    if (e.peerId === localPeerId && e.source === "camera") {
      return isPinnedNow ? m.card_unpin_my_video() : m.card_pin_my_video();
    }
    const name = nameOf(e.peerId);
    if (e.source === "screen") {
      return isPinnedNow ? m.card_unpin_screen({ name }) : m.card_pin_screen({ name });
    }
    return isPinnedNow ? m.card_unpin_video({ name }) : m.card_pin_video({ name });
  };

  const renderTile = (e: Entry, pinned: boolean, style?: CSSProperties) => {
    const source = e.source;
    return (
    <VideoTileView
      key={e.key}
      stream={e.stream}
      label={e.label}
      mirrored={e.mirrored}
      isScreen={e.isScreen}
      pinned={pinned}
      style={style}
      onTogglePin={
        source === "file-video" ? undefined : () => onTogglePin(e.peerId, source)
      }
      pinLabel={pinLabelFor(e, pinned)}
    />
    );
  };

  const empty = entries.length === 0;
  return (
    <section
      ref={sectionRef}
      aria-label={m.room_video_stage_label()}
      className={`flex w-full min-w-0 flex-col gap-2 ${
        full ? "h-full bg-sonic-900 p-3" : empty ? "shrink-0 items-center" : "min-h-0 flex-1"
      }`}
    >
      {/* Stage toolbar. Lives INSIDE the section so it is still there (and
          still the way out) once the section is the fullscreen element. */}
      {(!empty || full) && (
        <div className="flex shrink-0 items-center justify-end">
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-pressed={full}
            title={full ? m.video_fullscreen_exit() : m.video_fullscreen_title()}
            className="flex items-center gap-1.5 rounded-lg bg-sonic-700 px-3 py-1.5 text-sm font-medium text-sonic-100 transition-colors hover:bg-sonic-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-sonic-accent/60"
          >
            {full ? (
              <Minimize className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize className="h-4 w-4" aria-hidden="true" />
            )}
            {full ? m.video_fullscreen_exit() : m.video_fullscreen_enter()}
          </button>
        </div>
      )}

      {empty ? (
        <div className="flex w-full max-w-3xl items-center justify-center gap-2 rounded-xl border border-dashed border-sonic-700 px-4 py-6 text-sm text-sonic-400">
          <VideoIcon className="h-4 w-4" aria-hidden="true" />
          {m.room_video_empty()}
        </div>
      ) : pinnedEntry ? (
        <>
          <div className="min-h-0 flex-1">{renderTile(pinnedEntry, true)}</div>
          {rest.length > 0 && (
            <div className="flex h-20 shrink-0 gap-2 overflow-x-auto md:h-24">
              {rest.map((e) => (
                <div key={e.key} className="aspect-video h-full shrink-0">
                  {renderTile(e, false)}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div
          ref={setGridEl}
          className="grid min-h-0 flex-1 grid-flow-row-dense gap-2"
          style={{
            gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
          }}
        >
          {rest.map((e, i) =>
            renderTile(
              e,
              false,
              spanLarge && i === largeIdx ? { gridColumn: "span 2", gridRow: "span 2" } : undefined,
            ),
          )}
        </div>
      )}
    </section>
  );
}
