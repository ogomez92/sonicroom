// Face-centering guidance for a user with their camera on: where their face sits
// in the frame, what to tell them, and how often. The geometry + the announce
// throttling are pure (unit-tested); the detectors themselves live in
// face-locator.ts and the polling loop in the VideoControls component.

// A detected face's bounding box in RAW frame pixels (unmirrored camera space).
export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

export type Horizontal = "left" | "right";
export type Vertical = "up" | "down";

export type CenteringAdvice =
  | { status: "none" }
  | { status: "centered" }
  | { status: "off"; horizontal: Horizontal | null; vertical: Vertical | null };

// How far (as a fraction of the frame's width/height) the face centre may sit
// from the frame centre and still count as centred. A touch generous so normal
// head movement doesn't flip-flop the guidance.
export const CENTER_TOLERANCE = 0.14;

// Which way the USER should move, from the face's position in the RAW frame.
// A webcam faces the user, so the raw image is like a photo taken by someone
// looking at them: the user's right-hand side lands on the image's LEFT. A face
// sitting on the image's right (cx > centre) is therefore on the user's left,
// and they centre by moving to their RIGHT. Vertically there is no flip: a face
// low in the frame (cy > centre) means "move up". Detectors report raw
// coordinates (the CSS mirror on the self-view doesn't affect them), so this is
// the mapping regardless of how the preview is drawn.
export function centeringAdvice(
  face: FaceBox | null,
  frame: FrameSize,
  tolerance: number = CENTER_TOLERANCE,
): CenteringAdvice {
  if (!face || frame.width <= 0 || frame.height <= 0) return { status: "none" };
  const dx = (face.x + face.width / 2 - frame.width / 2) / frame.width;
  const dy = (face.y + face.height / 2 - frame.height / 2) / frame.height;
  const horizontal: Horizontal | null = dx > tolerance ? "right" : dx < -tolerance ? "left" : null;
  const vertical: Vertical | null = dy > tolerance ? "up" : dy < -tolerance ? "down" : null;
  if (!horizontal && !vertical) return { status: "centered" };
  return { status: "off", horizontal, vertical };
}

// A stable identity for an advice value, so "same advice as last time" is a
// string comparison.
export function adviceKey(advice: CenteringAdvice): string {
  return advice.status === "off"
    ? `off:${advice.horizontal ?? "-"}:${advice.vertical ?? "-"}`
    : advice.status;
}

// Re-announce an UNCHANGED off-centre direction this often, so the user keeps
// getting nudged without being buried (a changed direction is spoken at once).
export const REPEAT_MS = 3000;
// Don't call "face not visible" on a single dropped detection — wait this long.
export const NO_FACE_GRACE_MS = 1500;
// And once it's been said, repeat it this often while still nothing is found.
export const NO_FACE_REPEAT_MS = 6000;

// Decides WHEN to speak: the loop runs as fast as the detector allows, but the
// user hears (a) a new direction immediately, (b) the same direction again only
// every REPEAT_MS, (c) "centred" exactly once when they get back to centre after
// being off / unseen (never on a quiet start — they were already fine), and
// (d) "not visible" after a grace period, then every NO_FACE_REPEAT_MS.
export class GuidanceAnnouncer {
  private lastKey: string | null = null;
  private lastAt = -Infinity;
  private noFaceSince: number | null = null;

  // Returns the advice to announce now, or null to stay quiet.
  next(advice: CenteringAdvice, now: number): CenteringAdvice | null {
    if (advice.status === "none") {
      if (this.noFaceSince == null) this.noFaceSince = now;
      if (now - this.noFaceSince < NO_FACE_GRACE_MS) return null;
      return this.emitIfDue(advice, now, NO_FACE_REPEAT_MS);
    }
    this.noFaceSince = null;
    if (advice.status === "centered") {
      // Only worth saying as a recovery — after we'd told them to move or that
      // we couldn't see them. A session that starts centred stays silent.
      if (this.lastKey == null || this.lastKey === "centered") {
        this.lastKey = "centered";
        return null;
      }
      this.lastKey = "centered";
      this.lastAt = now;
      return advice;
    }
    return this.emitIfDue(advice, now, REPEAT_MS);
  }

  private emitIfDue(advice: CenteringAdvice, now: number, repeatMs: number) {
    const key = adviceKey(advice);
    if (key !== this.lastKey || now - this.lastAt >= repeatMs) {
      this.lastKey = key;
      this.lastAt = now;
      return advice;
    }
    return null;
  }
}
