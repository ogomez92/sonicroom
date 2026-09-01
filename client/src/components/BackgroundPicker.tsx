import { useCallback, useId, useMemo, useRef, useState } from "react";
import { ImageOff, Aperture, Upload, Trash2 } from "lucide-react";
import { useRoomStore } from "../stores/room";
import {
  BACKGROUND_PRESETS,
  BackgroundImageError,
  CUSTOM_MAX_INPUT_BYTES,
  backgroundLabel,
  canvasCaptureSupported,
  canvasFilterSupported,
  fileToBackgroundDataUrl,
  presetThumbUrl,
  type BackgroundChoice,
} from "../lib/video/backgrounds";
import { m } from "../paraglide/messages.js";

// The camera-background chooser, shown in the LOBBY under "Video call" — this
// is the only place a background is ever picked. Deciding before the call keeps
// the call window uncluttered, and it means the produced camera track is
// settled before the first produce and never has to be swapped mid-call.
//
// A radio group, because the choices are exclusive: no background (the
// default), blur, one of the shipped presets, or the user's own image. The
// thumbnails are decoration — every option's accessible name is its text label,
// so the list reads exactly as well without sight of the pictures.

// Nothing is downloaded here but the six ~7 KB thumbnails, and only once
// someone chooses "Video call": the full 1280×720 image is fetched by the
// compositor, in the call, for the ONE background that was actually picked.
export function BackgroundPicker() {
  const groupId = useId();
  const choice = useRoomStore((s) => s.videoBackground);
  const customImage = useRoomStore((s) => s.videoBackgroundImage);
  const setChoice = useRoomStore((s) => s.setVideoBackground);
  const setCustomImage = useRoomStore((s) => s.setVideoBackgroundImage);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // Probed once. captureStream is what the whole feature stands on; ctx.filter
  // is what blur specifically stands on (Safari only got it in 17), and a blur
  // we can't apply would send the real room — so the option is disabled and
  // labelled rather than silently ignored.
  const supported = useMemo(() => canvasCaptureSupported(), []);
  const blurSupported = useMemo(() => canvasFilterSupported(), []);

  const announce = useCallback((text: string) => {
    setStatus(text);
    setError("");
  }, []);

  const pick = useCallback(
    (next: BackgroundChoice) => {
      setChoice(next);
      announce(m.background_selected({ name: backgroundLabel(next) }));
    },
    [setChoice, announce],
  );

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setStatus("");
      try {
        const dataUrl = await fileToBackgroundDataUrl(file);
        const persisted = setCustomImage(dataUrl);
        setChoice("custom");
        announce(m.background_custom_chosen());
        // It's applied either way — the store holds it for this session, which
        // is all this call needs. Say so plainly rather than pretending it
        // failed (it didn't) or that it was saved (it wasn't).
        if (!persisted) setError(m.background_error_storage());
      } catch (err) {
        setStatus("");
        setError(backgroundErrorMessage(err));
      } finally {
        setBusy(false);
        // Clear the input so re-picking the same file fires change again.
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [setCustomImage, setChoice, announce],
  );

  const removeCustom = useCallback(() => {
    // The store drops a "custom" selection with the image, so this can't leave
    // the compositor pointed at a picture that no longer exists.
    setCustomImage("");
    announce(m.background_custom_removed());
  }, [setCustomImage, announce]);

  if (!supported) {
    return <p className="text-xs text-sonic-400">{m.lobby_background_unsupported()}</p>;
  }

  const option = (
    value: BackgroundChoice,
    label: string,
    tile: React.ReactNode,
    opts: { disabled?: boolean; describedBy?: string } = {},
  ) => (
    <label
      key={value}
      className={`group relative flex flex-col gap-1 ${
        opts.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      }`}
    >
      <input
        type="radio"
        name={`${groupId}-background`}
        value={value}
        checked={choice === value}
        disabled={opts.disabled}
        onChange={() => pick(value)}
        aria-describedby={opts.describedBy}
        className="peer sr-only"
      />
      {/* The tile is decoration: the radio's accessible name is the text below,
          so this list is fully usable with the pictures unseen. */}
      <span
        aria-hidden="true"
        className="flex aspect-video items-center justify-center overflow-hidden rounded-lg border-2 border-sonic-600 bg-sonic-700 transition-colors peer-checked:border-sonic-accent peer-focus-visible:ring-2 peer-focus-visible:ring-sonic-accent/60 group-hover:border-sonic-500 peer-checked:group-hover:border-sonic-accent"
      >
        {tile}
      </span>
      <span className="truncate text-xs font-medium text-sonic-300 peer-checked:text-sonic-100">
        {label}
      </span>
    </label>
  );

  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-sonic-200">
        {m.lobby_background_legend()}
      </legend>
      <p id={`${groupId}-help`} className="mb-2.5 text-xs text-sonic-400">
        {m.lobby_background_help()}
      </p>

      <div className="grid grid-cols-3 gap-2.5">
        {option("none", m.background_none(), <ImageOff className="h-5 w-5 text-sonic-400" />, {
          describedBy: `${groupId}-help`,
        })}
        {option("blur", m.background_blur(), <Aperture className="h-5 w-5 text-sonic-accent" />, {
          disabled: !blurSupported,
          describedBy: blurSupported ? undefined : `${groupId}-blur-unsupported`,
        })}
        {BACKGROUND_PRESETS.map((preset) =>
          option(
            preset.id,
            preset.label(),
            <img
              src={presetThumbUrl(preset.id)}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />,
          ),
        )}
        {customImage &&
          option(
            "custom",
            m.background_custom(),
            <img
              src={customImage}
              alt=""
              decoding="async"
              className="h-full w-full object-cover"
            />,
          )}
      </div>

      {!blurSupported && (
        <p id={`${groupId}-blur-unsupported`} className="mt-2 text-xs text-sonic-400">
          {m.background_blur_unsupported()}
        </p>
      )}

      {/* Own image. The file input is the labelled control; the button just
          opens it, so keyboard and screen-reader users get the native picker. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          id={`${groupId}-file`}
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(e) => void onFile(e.target.files?.[0])}
          className="sr-only"
        />
        <label
          htmlFor={`${groupId}-file`}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-sonic-600 bg-sonic-700 px-3 py-1.5 text-xs font-medium text-sonic-200 transition-colors hover:border-sonic-accent hover:text-sonic-100 focus-within:ring-2 focus-within:ring-sonic-accent/60"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          {customImage ? m.background_custom_replace() : m.background_custom_choose()}
        </label>
        {customImage && (
          <button
            type="button"
            onClick={removeCustom}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sonic-600 px-3 py-1.5 text-xs font-medium text-sonic-300 transition-colors hover:border-muted hover:text-sonic-100"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {m.background_custom_remove()}
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-muted" role="alert">
          {error}
        </p>
      )}
      {/* Selection and image changes are silent to the eye but not to a screen
          reader — the lobby's own live region only covers room picking. */}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </fieldset>
  );
}

function backgroundErrorMessage(err: unknown): string {
  const code = err instanceof BackgroundImageError ? err.code : "decode";
  switch (code) {
    case "type":
      return m.background_error_type();
    case "too_large":
      return m.background_error_too_large({
        max: Math.round(CUSTOM_MAX_INPUT_BYTES / (1024 * 1024)),
      });
    case "storage":
      return m.background_error_storage();
    default:
      return m.background_error_decode();
  }
}
