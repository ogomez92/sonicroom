import { describe, it, expect } from "vitest";
import {
  centeringAdvice,
  GuidanceAnnouncer,
  REPEAT_MS,
  NO_FACE_GRACE_MS,
  NO_FACE_REPEAT_MS,
} from "./face-centering";

const frame = { width: 640, height: 360 };
const faceAt = (cx: number, cy: number) => ({ x: cx - 50, y: cy - 50, width: 100, height: 100 });

describe("centeringAdvice", () => {
  it("is centred when the face centre is within tolerance of the frame centre", () => {
    expect(centeringAdvice(faceAt(320, 180), frame)).toEqual({ status: "centered" });
    expect(centeringAdvice(faceAt(320 + 640 * 0.1, 180), frame)).toEqual({ status: "centered" });
  });
  it("maps a face on the image's right to 'move right' (the user's own left side)", () => {
    expect(centeringAdvice(faceAt(560, 180), frame)).toEqual({
      status: "off",
      horizontal: "right",
      vertical: null,
    });
    expect(centeringAdvice(faceAt(80, 180), frame)).toEqual({
      status: "off",
      horizontal: "left",
      vertical: null,
    });
  });
  it("maps a low face to 'move up' and a high face to 'move down'", () => {
    expect(centeringAdvice(faceAt(320, 330), frame).status === "off").toBe(true);
    expect(centeringAdvice(faceAt(320, 330), frame)).toMatchObject({ vertical: "up" });
    expect(centeringAdvice(faceAt(320, 30), frame)).toMatchObject({ vertical: "down" });
  });
  it("combines both axes, and reports none without a face or frame", () => {
    expect(centeringAdvice(faceAt(80, 330), frame)).toEqual({
      status: "off",
      horizontal: "left",
      vertical: "up",
    });
    expect(centeringAdvice(null, frame)).toEqual({ status: "none" });
    expect(centeringAdvice(faceAt(1, 1), { width: 0, height: 0 })).toEqual({ status: "none" });
  });
});

describe("GuidanceAnnouncer", () => {
  const off = { status: "off", horizontal: "left", vertical: null } as const;
  const offUp = { status: "off", horizontal: "left", vertical: "up" } as const;
  const centered = { status: "centered" } as const;
  const none = { status: "none" } as const;

  it("says nothing while the user starts out centred", () => {
    const a = new GuidanceAnnouncer();
    expect(a.next(centered, 0)).toBeNull();
    expect(a.next(centered, 1000)).toBeNull();
  });

  it("speaks a direction at once, repeats it only every REPEAT_MS, and changes immediately", () => {
    const a = new GuidanceAnnouncer();
    expect(a.next(off, 0)).toEqual(off);
    expect(a.next(off, 500)).toBeNull();
    expect(a.next(off, REPEAT_MS - 1)).toBeNull();
    expect(a.next(off, REPEAT_MS)).toEqual(off);
    expect(a.next(offUp, REPEAT_MS + 100)).toEqual(offUp); // new direction → now
  });

  it("confirms 'centred' once after being off, then stays quiet", () => {
    const a = new GuidanceAnnouncer();
    a.next(off, 0);
    expect(a.next(centered, 100)).toEqual(centered);
    expect(a.next(centered, 200)).toBeNull();
    expect(a.next(centered, 10_000)).toBeNull();
  });

  it("waits a grace period before 'not visible', then repeats it slowly", () => {
    const a = new GuidanceAnnouncer();
    expect(a.next(none, 0)).toBeNull();
    expect(a.next(none, NO_FACE_GRACE_MS - 1)).toBeNull();
    expect(a.next(none, NO_FACE_GRACE_MS)).toEqual(none);
    expect(a.next(none, NO_FACE_GRACE_MS + 1000)).toBeNull();
    expect(a.next(none, NO_FACE_GRACE_MS + NO_FACE_REPEAT_MS)).toEqual(none);
    // Coming back into view after being unseen counts as a recovery.
    expect(a.next(centered, NO_FACE_GRACE_MS + NO_FACE_REPEAT_MS + 100)).toEqual(centered);
  });

  it("a single dropped detection between two off-centre frames is ignored", () => {
    const a = new GuidanceAnnouncer();
    a.next(off, 0);
    expect(a.next(none, 100)).toBeNull();
    expect(a.next(off, 200)).toBeNull(); // same direction, not due yet
  });
});
