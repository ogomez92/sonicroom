import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Video, VideoOff, ScanFace, KeyRound } from "lucide-react";
import { useRoomStore } from "../../stores/room";
import {
  centeringAdvice,
  GuidanceAnnouncer,
  type CenteringAdvice,
} from "../../lib/video/face-centering";
import { m } from "../../paraglide/messages.js";

// Video-room-only toolbar (lazy-loaded by Room next to the audio controls):
// camera on/off, the face-centering guidance toggle right beside it, and the
// Claude API key used by "Describe … video". Also hosts the guidance loop + its
// ASSERTIVE live region: while your camera is on and guidance is enabled it
// keeps detecting your face as fast as the detector allows and tells you which
// way to move, throttled by GuidanceAnnouncer so you're nudged, not buried.
interface VideoControlsProps {
  onToggleVideo: () => void;
  getLocalStream: () => MediaStream | null;
}

// Floor between detector runs (ms) so a fast native detector doesn't peg a core;
// MediaPipe on a slow machine is the real limiter and runs slower than this.
const DETECT_MIN_INTERVAL_MS = 120;

function guidanceText(advice: CenteringAdvice): string {
  if (advice.status === "centered") return m.guidance_centered();
  if (advice.status === "none") return m.guidance_no_face();
  const dirs: string[] = [];
  if (advice.horizontal === "left") dirs.push(m.guidance_dir_left());
  if (advice.horizontal === "right") dirs.push(m.guidance_dir_right());
  if (advice.vertical === "up") dirs.push(m.guidance_dir_up());
  if (advice.vertical === "down") dirs.push(m.guidance_dir_down());
  return dirs.length === 2
    ? m.guidance_move_two({ dir1: dirs[0], dir2: dirs[1] })
    : m.guidance_move_one({ dir: dirs[0] });
}

// The detection loop. Owns a hidden <video> on the local stream (independent of
// the visible tile), loads a face locator lazily, polls, and hands throttled
// advice to `onAdvice`. Reports `onUnavailable` when no detector can be set up.
function useFaceCentering(
  active: boolean,
  localVideoSeq: number,
  getLocalStream: () => MediaStream | null,
  onAdvice: (advice: CenteringAdvice) => void,
  onUnavailable: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const stream = getLocalStream();
    if (!stream) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.play().catch(() => {});
    const announcer = new GuidanceAnnouncer();
    let close = () => {};

    void (async () => {
      const { createFaceLocator } = await import("../../lib/video/face-locator");
      const locator = await createFaceLocator();
      if (cancelled) {
        locator?.close();
        return;
      }
      if (!locator) {
        onUnavailable();
        return;
      }
      close = () => locator.close();
      while (!cancelled) {
        const started = performance.now();
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            const face = await locator.detect(video);
            const advice = centeringAdvice(face, {
              width: video.videoWidth,
              height: video.videoHeight,
            });
            const due = announcer.next(advice, performance.now());
            if (due && !cancelled) onAdvice(due);
          } catch (err) {
            console.warn("[video] face detection failed:", err);
          }
        }
        const wait = Math.max(0, DETECT_MIN_INTERVAL_MS - (performance.now() - started));
        await new Promise((r) => setTimeout(r, wait));
      }
    })();

    return () => {
      cancelled = true;
      close();
      video.pause();
      video.srcObject = null;
    };
    // localVideoSeq re-runs the loop when the local stream is replaced.
  }, [active, localVideoSeq, getLocalStream, onAdvice, onUnavailable]);
}

export default function VideoControls({ onToggleVideo, getLocalStream }: VideoControlsProps) {
  const isVideoOn = useRoomStore((s) => s.isVideoOn);
  const localVideoSeq = useRoomStore((s) => s.localVideoSeq);
  const guidanceEnabled = useRoomStore((s) => s.videoGuidanceEnabled);
  const setGuidanceEnabled = useRoomStore((s) => s.setVideoGuidanceEnabled);
  const claudeApiKey = useRoomStore((s) => s.claudeApiKey);
  const setClaudeApiKey = useRoomStore((s) => s.setClaudeApiKey);
  const announce = useRoomStore((s) => s.announce);

  const [guidanceUnavailable, setGuidanceUnavailable] = useState(false);
  // The latest guidance line + a sequence so an identical repeat re-announces.
  const [guidance, setGuidance] = useState("");
  const [guidanceSeq, setGuidanceSeq] = useState(0);
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState(claudeApiKey);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const keyButtonRef = useRef<HTMLButtonElement>(null);
  const keyHelpId = useId();

  const onAdvice = useCallback((advice: CenteringAdvice) => {
    setGuidance(guidanceText(advice));
    setGuidanceSeq((n) => n + 1);
  }, []);
  const onUnavailable = useCallback(() => setGuidanceUnavailable(true), []);

  useFaceCentering(
    isVideoOn && guidanceEnabled && !guidanceUnavailable,
    localVideoSeq,
    getLocalStream,
    onAdvice,
    onUnavailable,
  );

  // Clear the last hint when the camera goes off or guidance is turned off.
  useEffect(() => {
    if (!isVideoOn || !guidanceEnabled) setGuidance("");
  }, [isVideoOn, guidanceEnabled]);

  useEffect(() => {
    if (keyOpen) {
      setKeyDraft(useRoomStore.getState().claudeApiKey);
      keyInputRef.current?.focus();
    }
  }, [keyOpen]);

  const closeKey = useCallback(() => {
    setKeyOpen(false);
    keyButtonRef.current?.focus();
  }, []);

  const saveKey = () => {
    const next = keyDraft.trim();
    setClaudeApiKey(next);
    announce(next ? m.video_api_key_saved() : m.video_api_key_cleared());
    closeKey();
  };

  // Roving tabindex toolbar (same pattern as AudioControls).
  const ids = ["video", "guidance", "apikey"];
  const [activeId, setActiveId] = useState("video");
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) itemRefs.current.set(id, el);
    else itemRefs.current.delete(id);
  };
  const item = (id: string) => ({ ref: register(id), tabIndex: activeId === id ? 0 : -1 });
  const onToolbarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const { key } = e;
    if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
    e.preventDefault();
    const idx = ids.indexOf(activeId);
    const last = ids.length - 1;
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? last
          : key === "ArrowRight"
            ? (idx + 1) % ids.length
            : (idx - 1 + ids.length) % ids.length;
    setActiveId(ids[next]);
    itemRefs.current.get(ids[next])?.focus();
  };

  return (
    <div
      className="relative flex flex-col items-center gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape" && keyOpen) {
          e.stopPropagation();
          closeKey();
        }
      }}
    >
      {keyOpen && (
        <div
          className="absolute bottom-full left-1/2 z-10 mb-3 w-80 -translate-x-1/2 rounded-xl border border-sonic-600 bg-sonic-800 p-4 shadow-2xl"
          role="dialog"
          aria-label={m.video_api_key_heading()}
        >
          <h2 className="mb-2 text-sm font-semibold text-sonic-100">{m.video_api_key_heading()}</h2>
          <p id={keyHelpId} className="mb-3 text-xs text-sonic-400">
            {m.video_api_key_help()}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveKey();
            }}
            className="flex flex-col gap-2"
          >
            <input
              ref={keyInputRef}
              type="password"
              autoComplete="off"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={m.video_api_key_placeholder()}
              aria-label={m.video_api_key_heading()}
              aria-describedby={keyHelpId}
              className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-3 py-2 text-sm text-sonic-100 placeholder-sonic-400 focus:border-sonic-accent focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setKeyDraft("")}
                className="rounded-lg bg-sonic-700 px-3 py-1.5 text-sm text-sonic-200 hover:bg-sonic-600"
              >
                {m.video_api_key_clear()}
              </button>
              <button
                type="submit"
                className="rounded-lg bg-sonic-accent px-3 py-1.5 text-sm text-white hover:bg-sonic-accent/90"
              >
                {m.video_api_key_save()}
              </button>
            </div>
          </form>
        </div>
      )}

      <div
        className="flex items-center justify-center gap-3 rounded-2xl border border-sonic-600 bg-sonic-800 p-3"
        role="toolbar"
        aria-label={m.video_controls_label()}
        onKeyDown={onToolbarKeyDown}
      >
        <button
          {...item("video")}
          onClick={onToggleVideo}
          aria-pressed={isVideoOn}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
            isVideoOn
              ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
              : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-label={isVideoOn ? m.video_turn_off() : m.video_turn_on()}
          title={m.video_toggle_title()}
        >
          {isVideoOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </button>

        {/* Guidance toggle sits right beside the camera button. aria-pressed
            carries its state; when no detector exists it stays focusable but
            aria-disabled with the reason as its name. */}
        <button
          {...item("guidance")}
          onClick={guidanceUnavailable ? undefined : () => setGuidanceEnabled(!guidanceEnabled)}
          aria-pressed={guidanceUnavailable ? undefined : guidanceEnabled}
          aria-disabled={guidanceUnavailable}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
            guidanceUnavailable
              ? "cursor-not-allowed bg-sonic-700 text-sonic-500"
              : guidanceEnabled
                ? "bg-sonic-accent/20 text-sonic-accent hover:bg-sonic-accent/30"
                : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-label={
            guidanceUnavailable ? m.video_guidance_unavailable() : m.video_guidance_label()
          }
          title={guidanceUnavailable ? m.video_guidance_unavailable() : m.video_guidance_title()}
        >
          <ScanFace className="h-5 w-5" />
        </button>

        <button
          tabIndex={activeId === "apikey" ? 0 : -1}
          ref={(el) => {
            register("apikey")(el);
            keyButtonRef.current = el;
          }}
          onClick={() => setKeyOpen((o) => !o)}
          aria-expanded={keyOpen}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
            claudeApiKey
              ? "bg-sonic-accent/20 text-sonic-accent hover:bg-sonic-accent/30"
              : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-label={m.video_api_key_button()}
          title={m.video_api_key_button()}
        >
          <KeyRound className="h-5 w-5" />
        </button>
      </div>

      {/* Face-centering guidance: visible caption + ASSERTIVE live region (it
          must interrupt — the user is actively adjusting). Keyed so the same hint
          repeated after REPEAT_MS is announced again. */}
      {guidance && (
        <p className="text-xs text-sonic-300" aria-hidden="true">
          {guidance}
        </p>
      )}
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        <span key={guidanceSeq}>{guidance}</span>
      </div>
    </div>
  );
}
