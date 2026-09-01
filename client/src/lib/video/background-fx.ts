// The camera background compositor: segment the person out of each camera
// frame and put something else behind them, entirely inside this browser. The
// room only ever receives the finished picture — the raw capture never leaves
// the machine, which is the whole point for someone who doesn't want their room
// on show.
//
// Only ever reached through a dynamic import from video-media.ts, and only when
// the user actually chose a background in the lobby. "No background" never
// loads this file, never downloads the model, and produces the raw camera track
// exactly as it always did — zero cost for the default.
//
// WHY IT ISN'T EXPENSIVE (the design is the answer):
//  - We segment at the camera's own size (640×360 by CAMERA_CONSTRAINTS), and
//    the model works at 144×256 regardless. Background blur has a reputation for
//    eating a core; that reputation is earned at 720p/1080p, not here.
//  - MediaPipe runs on the GPU delegate, same as the face-centering detector.
//  - The only per-frame JS pixel work is one multiply per MASK pixel (~37k of
//    them, at 144×256 — not at frame resolution). Everything at full
//    resolution — the upscale, the edge softening, the blur, the composite —
//    is three drawImage calls on a hardware-accelerated 2D context. Reading
//    full-res pixels back into JS is what makes these pipelines slow, so we
//    never do it.
//  - The loop is driven by real camera frames (requestVideoFrameCallback), not
//    a free-running rAF, so we do exactly as much work as the camera gives us
//    and none at all while the tab is hidden.
import {
  fitCover,
  loadBackgroundImage,
  canvasFilterSupported,
  type BackgroundChoice,
} from "./backgrounds";

// Landscape variant (144×256 input) — matches our 16:9 capture, so no pixels
// are spent on letterbox bars. Sits beside the BlazeFace model that the
// face-centering guidance uses; both are served from /models.
export const SELFIE_SEGMENTER_MODEL_URL = "/models/selfie_segmenter_landscape.tflite";
export const MEDIAPIPE_WASM_URL = "/mediapipe/wasm";

// How hard to blur the real room for the "blur" choice. Generous on purpose:
// the point is that nothing behind you is readable.
const BACKGROUND_BLUR_PX = 14;
// Feathering on the person's outline. The confidence mask is already soft, so
// this only has to smooth the upscale from 144×256 to the frame — a much
// smaller job than cleaning up a hard binary cut-out. Cheap: a GPU filter.
const MASK_FEATHER_PX = 2;
// Output rate when the camera doesn't report one of its own.
const FALLBACK_FPS = 24;
// How long to wait for the hidden <video> to produce its first sized frame.
const VIDEO_READY_TIMEOUT_MS = 10_000;

export interface CameraBackgroundFx {
  // The track to produce and to preview. Stays the same object for the whole
  // life of the effect — mirrors the audio graph's outDest contract, so a mode
  // rebuild re-produces without ever swapping a track on the producer.
  readonly stream: MediaStream;
  close(): void;
}

// One inference's worth of mask, at the model's own resolution: per-pixel
// CONFIDENCE that the pixel is the person, in [0, 1].
interface MaskFrame {
  data: Float32Array;
  width: number;
  height: number;
}

interface Segmenter {
  segment(video: HTMLVideoElement, timestampMs: number): MaskFrame | null;
  close(): void;
}

// Build the effect over a raw camera stream. Returns null when it can't be done
// here (no canvas.captureStream, no ctx.filter for a blur, MediaPipe or WebGL
// unavailable, the model won't load, the camera never produces a frame) — the
// caller then produces the raw camera and tells the user, rather than quietly
// sending a picture that isn't the one they asked for.
export async function createCameraBackgroundFx(
  source: MediaStream,
  choice: BackgroundChoice,
  customImageDataUrl: string,
): Promise<CameraBackgroundFx | null> {
  if (choice === "none") return null;

  const sourceTrack = source.getVideoTracks()[0];
  if (!sourceTrack) return null;

  const canFilter = canvasFilterSupported();
  // A blur we can't actually apply would show the real room to everyone — a
  // privacy failure, not a cosmetic one. Refuse rather than approximate.
  if (choice === "blur" && !canFilter) {
    console.warn("[video] background blur needs canvas ctx.filter — unsupported here");
    return null;
  }

  let backgroundImage: HTMLImageElement | null;
  try {
    backgroundImage = await loadBackgroundImage(choice, customImageDataUrl);
  } catch (err) {
    console.warn("[video] background image failed to load:", err);
    return null;
  }
  // Every choice except "blur" needs a picture to put back there.
  if (choice !== "blur" && !backgroundImage) return null;

  const canvas = document.createElement("canvas");
  // `desynchronized` lets the compositor skip a frame of latency; alpha is
  // required because the mask lives in this canvas's alpha channel mid-composite.
  const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  if (!ctx || typeof canvas.captureStream !== "function") return null;

  // A hidden <video> is the only way to get decoded frames out of a MediaStream
  // that works in every browser we care about (MediaStreamTrackProcessor is
  // Chromium-only, and Safari matters here).
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source;

  let segmenter: Segmenter | null = null;
  try {
    await playAndSize(video);
    segmenter = await createSegmenter();
  } catch (err) {
    console.warn("[video] background segmentation unavailable:", err);
    segmenter?.close();
    stopVideoElement(video);
    return null;
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  // The mask's resolution is the model's, and we only learn it from the first
  // inference — so the surface sizes itself on demand and then reuses one
  // canvas and one ImageData for the rest of the session.
  const maskSurface = new MaskSurface();

  const fps = Math.round(sourceTrack.getSettings().frameRate ?? FALLBACK_FPS) || FALLBACK_FPS;
  const stream = canvas.captureStream(fps);
  let stopped = false;
  // Until the first mask lands we pass the camera through untouched. A black
  // first frame reads as "my camera is broken", and the model needs a moment.
  let haveMask = false;

  const drawFrame = () => {
    if (video.readyState < 2 || video.videoWidth === 0) return;

    // A camera can renegotiate its resolution mid-stream (a device change, a
    // constraint the OS revises). Follow it rather than stretching.
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const w = canvas.width;
    const h = canvas.height;

    const mask = segmenter!.segment(video, performance.now());
    if (mask && maskSurface.update(mask)) haveMask = true;

    if (!haveMask) {
      ctx.globalCompositeOperation = "copy";
      ctx.filter = "none";
      ctx.drawImage(video, 0, 0, w, h);
      return;
    }

    // Three GPU composites, no pixel readback:
    //  1. the person's silhouette, upscaled and feathered, into the alpha channel
    ctx.globalCompositeOperation = "copy";
    ctx.filter = canFilter ? `blur(${MASK_FEATHER_PX}px)` : "none";
    ctx.drawImage(maskSurface.canvas, 0, 0, w, h);
    //  2. the camera frame, kept only where that silhouette is opaque
    ctx.globalCompositeOperation = "source-in";
    ctx.filter = "none";
    ctx.drawImage(video, 0, 0, w, h);
    //  3. the background, painted underneath what's already there
    ctx.globalCompositeOperation = "destination-over";
    if (backgroundImage) {
      const { sx, sy, sw, sh } = fitCover(
        backgroundImage.naturalWidth,
        backgroundImage.naturalHeight,
        w,
        h,
      );
      ctx.drawImage(backgroundImage, sx, sy, sw, sh, 0, 0, w, h);
    } else {
      // Blur: the background IS the camera frame, just unreadable. Drawn
      // oversized so the blur kernel doesn't pull transparent pixels in from
      // beyond the edges and leave a pale border around the picture.
      ctx.filter = `blur(${BACKGROUND_BLUR_PX}px)`;
      const bleed = BACKGROUND_BLUR_PX * 2;
      ctx.drawImage(video, -bleed, -bleed, w + bleed * 2, h + bleed * 2);
    }
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
  };

  // Drive off real camera frames where the browser offers it (Chrome, Safari,
  // Firefox 130+): exactly one composite per captured frame, no duplicated
  // work, and nothing at all while the tab is hidden. rAF is the fallback and
  // self-throttles the same way.
  const hasVfc = typeof video.requestVideoFrameCallback === "function";
  let handle = 0;
  const loop = () => {
    if (stopped) return;
    try {
      drawFrame();
    } catch (err) {
      // One bad frame (a GPU context loss, a mid-teardown race) must not kill
      // the camera: log once per frame at most and keep the loop alive.
      console.warn("[video] background frame failed:", err);
    }
    handle = hasVfc ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
  };
  loop();

  return {
    stream,
    close() {
      if (stopped) return;
      stopped = true;
      if (handle) {
        if (hasVfc) video.cancelVideoFrameCallback(handle);
        else cancelAnimationFrame(handle);
      }
      // Only the canvas track — the raw camera capture belongs to VideoMedia,
      // which stops it itself (the same ownership split as stopTracks:false).
      stream.getTracks().forEach((t) => t.stop());
      segmenter!.close();
      stopVideoElement(video);
    },
  };
}

// --- The mask surface ---

// Holds the segmentation mask as a drawable canvas. Sizes itself from the first
// mask it sees (the model's resolution isn't known before then) and afterwards
// rewrites only the alpha bytes of a single reused ImageData — RGB is painted
// white once, at allocation. Confidence maps straight onto alpha: fully
// confident person = opaque, fully confident background = transparent, and the
// uncertain band in between becomes exactly the soft edge we want.
class MaskSurface {
  readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;

  // Returns false if the mask can't be drawn (no 2D context) — the caller then
  // keeps passing the camera through rather than showing a broken composite.
  update(mask: MaskFrame): boolean {
    if (mask.width <= 0 || mask.height <= 0) return false;
    if (!this.ctx || this.canvas.width !== mask.width || this.canvas.height !== mask.height) {
      this.canvas.width = mask.width;
      this.canvas.height = mask.height;
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: false });
      if (!this.ctx) return false;
      this.image = this.ctx.createImageData(mask.width, mask.height);
      const data = this.image.data;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
      }
    }
    const image = this.image!;
    const data = image.data;
    // Uint8ClampedArray clamps for us, so this is one multiply per mask pixel.
    for (let i = 0, a = 3; i < mask.data.length; i++, a += 4) {
      data[a] = mask.data[i] * 255;
    }
    this.ctx!.putImageData(image, 0, 0);
    return true;
  }
}

// --- MediaPipe ---

async function createSegmenter(): Promise<Segmenter> {
  const { ImageSegmenter, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
  const segmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    // CONFIDENCE, not category — and this is a correctness decision, not a
    // quality one. The selfie segmenters output a SINGLE channel (verified:
    // both selfie_segmenter and selfie_segmenter_landscape are [1,H,W,1] with a
    // one-entry label map, "selfie"), and for single-channel models MediaPipe's
    // category mask inverts the usual convention — its own
    // tensors_to_segmentation_calculator writes 0 for the FOREGROUND and 255
    // for the background, the opposite way round from every multi-class model.
    // Getting that backwards would cut the person out and send the real room to
    // the whole call, which is the one failure this feature must not have. The
    // confidence mask has no such convention: it is P(selfie) per pixel, the
    // same on the CPU and the WebGL post-processing paths. It also hands us a
    // soft edge for free.
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });

  return {
    segment(video, timestampMs) {
      // Synchronous in VIDEO mode, so frames can never overlap or queue up: a
      // slow machine simply produces fewer composites, it doesn't fall behind.
      const result = segmenter.segmentForVideo(video, timestampMs);
      try {
        const masks = result.confidenceMasks;
        // Exactly one mask is what a single-class selfie model gives, and it is
        // the person. Anything else means the model was swapped for a
        // multi-class one, where index 0 is background and this code would be
        // inverted — so refuse rather than guess.
        if (!masks || masks.length !== 1) {
          console.warn("[video] unexpected segmentation output; expected one confidence mask");
          return null;
        }
        const mask = masks[0];
        // Copy out — the underlying buffer dies with result.close().
        return {
          data: new Float32Array(mask.getAsFloat32Array()),
          width: mask.width,
          height: mask.height,
        };
      } finally {
        result.close();
      }
    },
    close() {
      segmenter.close();
    },
  };
}

// --- Element plumbing ---

// Resolve once the element is playing AND has real dimensions — the canvas
// sizing and the first segment() both need videoWidth.
function playAndSize(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("camera frames never arrived"));
    }, VIDEO_READY_TIMEOUT_MS);
    const check = () => {
      if (video.videoWidth > 0 && video.readyState >= 2) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("resize", check);
    };
    video.addEventListener("loadeddata", check);
    video.addEventListener("resize", check);
    video.play().then(check, () => {
      // Autoplay refusal on a muted, srcObject-backed element is unusual; the
      // listeners above still resolve us if frames turn up anyway.
      check();
    });
  });
}

function stopVideoElement(video: HTMLVideoElement) {
  try {
    video.pause();
  } catch {
    // Already detached — nothing to do.
  }
  video.srcObject = null;
}
