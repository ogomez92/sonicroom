// Video backgrounds: what you can choose, and the pure geometry/validation the
// picker and the compositor both need. NO rendering and NO MediaPipe here — the
// segmentation pipeline lives in ./background-fx, which is dynamically imported
// only when someone actually turns a background on. This module is safe to load
// from the lobby (the picker needs the preset list and the custom-image store).
//
// The choice is made in the LOBBY, before the call, and read once at
// startCamera(): the call window never grows a background switcher. That's a
// deliberate constraint, and it buys the pipeline a lot — the produced track is
// decided before the first produce and never has to be swapped mid-call.
import { m } from "../../paraglide/messages.js";

// A preset ships two files under /backgrounds: the full 1280×720 image drawn
// behind the person, and a 256×144 thumbnail for the picker (the ONLY thing the
// picker downloads — six thumbs together are ~41 KB). See CREDITS.md there.
export interface BackgroundPreset {
  id: string;
  // Localized at call time, not at module load, so a language switch relabels
  // the picker in place like every other string in the app.
  label: () => string;
}

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  { id: "bookshelves", label: () => m.background_preset_bookshelves() },
  { id: "studio", label: () => m.background_preset_studio() },
  { id: "meeting-room", label: () => m.background_preset_meeting_room() },
  { id: "living-room", label: () => m.background_preset_living_room() },
  { id: "beach", label: () => m.background_preset_beach() },
  { id: "mountains", label: () => m.background_preset_mountains() },
] as const;

// "none" (send the camera as-is — the pipeline doesn't even start), "blur"
// (blur whatever is really there), "custom" (the user's own stored image), or a
// preset id.
export type BackgroundChoice = "none" | "blur" | "custom" | string;

export const DEFAULT_BACKGROUND: BackgroundChoice = "none";

export function presetUrl(id: string): string {
  return `/backgrounds/${id}.jpg`;
}

export function presetThumbUrl(id: string): string {
  return `/backgrounds/${id}-thumb.jpg`;
}

export function isPresetId(value: string): boolean {
  return BACKGROUND_PRESETS.some((p) => p.id === value);
}

// Fold anything (a stored string, a stale preset id from an older build, a
// "custom" with no image behind it) down to a choice the compositor can honour.
// Falling back to "none" is the safe direction: it sends the real camera, which
// is exactly what the user gets today.
export function normalizeBackgroundChoice(
  value: unknown,
  opts: { hasCustomImage: boolean },
): BackgroundChoice {
  if (typeof value !== "string") return DEFAULT_BACKGROUND;
  if (value === "none" || value === "blur") return value;
  if (value === "custom") return opts.hasCustomImage ? "custom" : DEFAULT_BACKGROUND;
  return isPresetId(value) ? value : DEFAULT_BACKGROUND;
}

// The human-readable name of a choice, for the picker and for announcements.
export function backgroundLabel(choice: BackgroundChoice): string {
  if (choice === "none") return m.background_none();
  if (choice === "blur") return m.background_blur();
  if (choice === "custom") return m.background_custom();
  return BACKGROUND_PRESETS.find((p) => p.id === choice)?.label() ?? m.background_none();
}

// --- Geometry (pure) ---

// Source rectangle that fills a dstW×dstH box with a srcW×srcH image without
// distorting it — CSS `object-fit: cover`, as drawImage's 9-argument source
// crop. Presets are already 16:9 (so this is a no-op for them); a custom image
// can be any shape, and stretching someone's photo to 16:9 looks broken.
export interface CoverRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function fitCover(srcW: number, srcH: number, dstW: number, dstH: number): CoverRect {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
    return { sx: 0, sy: 0, sw: Math.max(srcW, 0), sh: Math.max(srcH, 0) };
  }
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    // Source is wider — crop its sides.
    const sw = srcH * dstAspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  // Source is taller — crop top and bottom.
  const sh = srcW / dstAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

// Largest size that fits inside maxW×maxH keeping the aspect ratio, never
// scaling up (`object-fit: contain`, downscale-only). Used to cap a picked
// image before it's re-encoded for storage.
export function containSize(
  srcW: number,
  srcH: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxW / srcW, maxH / srcH);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

// --- The custom image ---

// A picked image is downscaled to this box and re-encoded before it's stored.
// It's only ever drawn behind a 640×360 camera picture, so anything larger is
// bytes in localStorage for nothing — and localStorage is a ~5 MB budget shared
// with every other preference, so this cap is what keeps the feature honest.
export const CUSTOM_MAX_WIDTH = 1280;
export const CUSTOM_MAX_HEIGHT = 720;
export const CUSTOM_JPEG_QUALITY = 0.82;
// Refuse absurd files before decoding them — a 100 MP photo would otherwise be
// fully decoded into memory just to be thrown away.
export const CUSTOM_MAX_INPUT_BYTES = 24 * 1024 * 1024;

export class BackgroundImageError extends Error {
  constructor(readonly code: "type" | "too_large" | "decode" | "storage") {
    super(code);
    this.name = "BackgroundImageError";
  }
}

// Decode a picked file, cap it to CUSTOM_MAX_*, and re-encode as a JPEG data
// URL (~150–250 KB, which localStorage holds comfortably). Throws
// BackgroundImageError so the picker can show a localized reason.
export async function fileToBackgroundDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new BackgroundImageError("type");
  if (file.size > CUSTOM_MAX_INPUT_BYTES) throw new BackgroundImageError("too_large");

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    const { width, height } = containSize(
      img.naturalWidth,
      img.naturalHeight,
      CUSTOM_MAX_WIDTH,
      CUSTOM_MAX_HEIGHT,
    );
    if (width === 0 || height === 0) throw new BackgroundImageError("decode");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new BackgroundImageError("decode");
    ctx.drawImage(img, 0, 0, width, height);
    // JPEG, not PNG: a photo as PNG is several megabytes and would blow the
    // storage quota. A background is a photo, so JPEG is the right codec.
    return canvas.toDataURL("image/jpeg", CUSTOM_JPEG_QUALITY);
  } catch (err) {
    if (err instanceof BackgroundImageError) throw err;
    throw new BackgroundImageError("decode");
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Load an <img> and wait until it's actually decodable — `decode()` where it
// exists, else the load event. Used for both the custom-image re-encode and the
// compositor's background source.
export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Same-origin (a /backgrounds asset or a data: URL), but be explicit: a
    // tainted canvas would break the re-encode.
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (typeof img.decode === "function") {
        img.decode().then(
          () => resolve(img),
          // Decoded-but-unhappy still draws in practice; don't fail the load.
          () => resolve(img),
        );
      } else {
        resolve(img);
      }
    };
    img.onerror = () => reject(new BackgroundImageError("decode"));
    img.src = src;
  });
}

// The image a choice should draw, or null for "none"/"blur" (which need no
// image). Presets come from /backgrounds; "custom" comes from the stored data
// URL the caller passes in.
export async function loadBackgroundImage(
  choice: BackgroundChoice,
  customDataUrl: string,
): Promise<HTMLImageElement | null> {
  if (choice === "none" || choice === "blur") return null;
  if (choice === "custom") {
    if (!customDataUrl) return null;
    return loadImageElement(customDataUrl);
  }
  if (!isPresetId(choice)) return null;
  return loadImageElement(presetUrl(choice));
}

// --- Browser capability probes ---
//
// Both are cheap and synchronous, so the LOBBY can call them to disable options
// it can't honour. That matters most for blur: if `ctx.filter` is missing, a
// silently-ignored blur would send the real room to everyone — a privacy
// failure, not a cosmetic one. Better to grey the option out and say why.

// canvas.captureStream() — no output track without it, so no backgrounds at all.
export function canvasCaptureSupported(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return typeof (canvas as HTMLCanvasElement).captureStream === "function";
  } catch {
    return false;
  }
}

// 2D ctx.filter — Chrome/Firefox for years, Safari only since 17. Assigning an
// unsupported filter is silently ignored, so probe by reading it back.
export function canvasFilterSupported(): boolean {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return false;
    ctx.filter = "blur(1px)";
    return ctx.filter === "blur(1px)";
  } catch {
    return false;
  }
}
