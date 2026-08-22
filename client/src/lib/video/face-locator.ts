// Finds the (largest) face in a live <video> frame, for the centering guidance.
// Two backends behind one tiny interface:
//  1. The browser's native Shape Detection `FaceDetector` when present (Chrome on
//     Android/ChromeOS, some desktop builds) — zero download, hardware-backed.
//  2. MediaPipe's BlazeFace (short-range) via @mediapipe/tasks-vision, loaded
//     lazily: the wasm runtime is served from /mediapipe/wasm (copied out of
//     node_modules by the vite plugin) and the ~230 KB model from /models.
// Neither is touched unless a user in a VIDEO room has their camera on AND the
// guidance toggle enabled — this module is only ever dynamically imported.
import type { FaceBox } from "./face-centering";

export interface FaceLocator {
  // The largest face in the current frame, in raw video pixels, or null.
  detect(video: HTMLVideoElement): Promise<FaceBox | null>;
  close(): void;
}

export const MEDIAPIPE_WASM_URL = "/mediapipe/wasm";
export const BLAZEFACE_MODEL_URL = "/models/blaze_face_short_range.tflite";

// The Shape Detection API isn't in lib.dom yet.
interface NativeFaceDetector {
  detect(source: HTMLVideoElement): Promise<Array<{ boundingBox: DOMRectReadOnly }>>;
}
type NativeFaceDetectorCtor = new (opts?: {
  fastMode?: boolean;
  maxDetectedFaces?: number;
}) => NativeFaceDetector;

function largest<T extends { width: number; height: number }>(boxes: T[]): T | null {
  let best: T | null = null;
  for (const b of boxes) if (!best || b.width * b.height > best.width * best.height) best = b;
  return best;
}

async function createNativeLocator(): Promise<FaceLocator | null> {
  const Ctor = (globalThis as { FaceDetector?: NativeFaceDetectorCtor }).FaceDetector;
  if (!Ctor) return null;
  try {
    const detector = new Ctor({ fastMode: true, maxDetectedFaces: 3 });
    return {
      async detect(video) {
        const faces = await detector.detect(video);
        const box = largest(faces.map((f) => f.boundingBox));
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      },
      close() {},
    };
  } catch {
    return null;
  }
}

async function createMediaPipeLocator(): Promise<FaceLocator | null> {
  try {
    const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
    const detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: BLAZEFACE_MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.5,
    });
    return {
      async detect(video) {
        const result = detector.detectForVideo(video, performance.now());
        const box = largest(
          result.detections
            .map((d) => d.boundingBox)
            .filter((b): b is NonNullable<typeof b> => b != null)
            .map((b) => ({ x: b.originX, y: b.originY, width: b.width, height: b.height })),
        );
        return box;
      },
      close() {
        detector.close();
      },
    };
  } catch (err) {
    console.warn("[video] MediaPipe face detector unavailable:", err);
    return null;
  }
}

// Native first (free), MediaPipe second; null when neither can be set up, in
// which case the guidance toggle is shown disabled with an explanation.
export async function createFaceLocator(): Promise<FaceLocator | null> {
  return (await createNativeLocator()) ?? (await createMediaPipeLocator());
}
