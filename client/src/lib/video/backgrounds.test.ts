import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BACKGROUND_PRESETS,
  BackgroundImageError,
  CUSTOM_MAX_INPUT_BYTES,
  DEFAULT_BACKGROUND,
  canvasCaptureSupported,
  canvasFilterSupported,
  containSize,
  fileToBackgroundDataUrl,
  fitCover,
  isPresetId,
  loadBackgroundImage,
  normalizeBackgroundChoice,
  presetThumbUrl,
  presetUrl,
} from "./backgrounds";

describe("fitCover", () => {
  it("is a no-op for a source that already matches the destination aspect", () => {
    expect(fitCover(1280, 720, 640, 360)).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
  });

  it("crops the sides of a source that is wider than the destination", () => {
    // A 2:1 source into a 16:9 box keeps full height and loses width, centred.
    const { sx, sy, sw, sh } = fitCover(1000, 500, 640, 360);
    expect(sh).toBe(500);
    expect(sw).toBeCloseTo(500 * (640 / 360));
    expect(sy).toBe(0);
    expect(sx).toBeCloseTo((1000 - sw) / 2);
  });

  it("crops the top and bottom of a source that is taller than the destination", () => {
    // A portrait phone photo used as a background: full width, centred band.
    const { sx, sy, sw, sh } = fitCover(1080, 1920, 640, 360);
    expect(sw).toBe(1080);
    expect(sh).toBeCloseTo(1080 / (640 / 360));
    expect(sx).toBe(0);
    expect(sy).toBeCloseTo((1920 - sh) / 2);
  });

  it("never returns a crop larger than the source", () => {
    for (const [sw, sh] of [
      [100, 100],
      [4000, 10],
      [10, 4000],
    ]) {
      const r = fitCover(sw, sh, 640, 360);
      expect(r.sw).toBeLessThanOrEqual(sw);
      expect(r.sh).toBeLessThanOrEqual(sh);
    }
  });

  it("degrades safely on zero or negative dimensions instead of dividing by zero", () => {
    expect(fitCover(0, 0, 640, 360)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 });
    expect(fitCover(100, 100, 0, 360).sw).toBe(100);
    expect(Number.isFinite(fitCover(-5, 10, 640, 360).sw)).toBe(true);
  });
});

describe("containSize", () => {
  it("scales a large image down to fit the box, keeping its aspect ratio", () => {
    expect(containSize(4000, 3000, 1280, 720)).toEqual({ width: 960, height: 720 });
    expect(containSize(6000, 3375, 1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it("never scales a small image up — a 320px photo stays 320px", () => {
    expect(containSize(320, 180, 1280, 720)).toEqual({ width: 320, height: 180 });
  });

  it("keeps at least one pixel for extreme aspect ratios", () => {
    const { width, height } = containSize(10000, 3, 1280, 720);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThanOrEqual(1);
  });

  it("returns nothing for a zero-sized source", () => {
    expect(containSize(0, 0, 1280, 720)).toEqual({ width: 0, height: 0 });
  });
});

describe("normalizeBackgroundChoice", () => {
  const withImage = { hasCustomImage: true };
  const withoutImage = { hasCustomImage: false };

  it("passes the built-in choices straight through", () => {
    expect(normalizeBackgroundChoice("none", withoutImage)).toBe("none");
    expect(normalizeBackgroundChoice("blur", withoutImage)).toBe("blur");
  });

  it("keeps a known preset id", () => {
    expect(normalizeBackgroundChoice("beach", withoutImage)).toBe("beach");
  });

  it("keeps 'custom' only while there is actually an image behind it", () => {
    expect(normalizeBackgroundChoice("custom", withImage)).toBe("custom");
    expect(normalizeBackgroundChoice("custom", withoutImage)).toBe(DEFAULT_BACKGROUND);
  });

  it("falls back to none for a preset id this build no longer ships", () => {
    expect(normalizeBackgroundChoice("retired-preset", withImage)).toBe(DEFAULT_BACKGROUND);
  });

  it("falls back to none for junk out of localStorage", () => {
    for (const junk of [null, undefined, 42, {}, [], ""]) {
      expect(normalizeBackgroundChoice(junk, withImage)).toBe(DEFAULT_BACKGROUND);
    }
  });
});

describe("BACKGROUND_PRESETS", () => {
  it("has unique ids", () => {
    const ids = BACKGROUND_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("recognises exactly its own ids", () => {
    for (const p of BACKGROUND_PRESETS) expect(isPresetId(p.id)).toBe(true);
    expect(isPresetId("none")).toBe(false);
    expect(isPresetId("blur")).toBe(false);
    expect(isPresetId("nope")).toBe(false);
  });

  it("has a localized label for every preset", () => {
    for (const p of BACKGROUND_PRESETS) {
      expect(p.label()).toBeTruthy();
      expect(p.label()).not.toBe(p.id);
    }
  });

  // The one thing argv-style unit tests can't catch by inspection: a preset
  // added to the list but not to public/backgrounds ships a broken tile and an
  // unusable background.
  it("ships both a full image and a thumbnail for every preset", () => {
    const publicDir = join(__dirname, "..", "..", "..", "public");
    for (const p of BACKGROUND_PRESETS) {
      expect(existsSync(join(publicDir, presetUrl(p.id)))).toBe(true);
      expect(existsSync(join(publicDir, presetThumbUrl(p.id)))).toBe(true);
    }
  });
});

describe("loadBackgroundImage", () => {
  it("needs no image for the choices that don't draw one", async () => {
    expect(await loadBackgroundImage("none", "")).toBeNull();
    expect(await loadBackgroundImage("blur", "")).toBeNull();
  });

  it("returns nothing for 'custom' with no stored image, rather than throwing", async () => {
    expect(await loadBackgroundImage("custom", "")).toBeNull();
  });

  it("returns nothing for an unknown id", async () => {
    expect(await loadBackgroundImage("not-a-preset", "")).toBeNull();
  });
});

describe("fileToBackgroundDataUrl", () => {
  it("rejects a file that isn't an image before decoding anything", async () => {
    const file = new File(["not a picture"], "notes.txt", { type: "text/plain" });
    await expect(fileToBackgroundDataUrl(file)).rejects.toMatchObject({ code: "type" });
  });

  it("rejects an oversized file before decoding it", async () => {
    const file = new File([""], "huge.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: CUSTOM_MAX_INPUT_BYTES + 1 });
    await expect(fileToBackgroundDataUrl(file)).rejects.toMatchObject({ code: "too_large" });
  });

  it("reports failures as BackgroundImageError so the picker can localize them", async () => {
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    await expect(fileToBackgroundDataUrl(file)).rejects.toBeInstanceOf(BackgroundImageError);
  });
});

describe("capability probes", () => {
  // jsdom has no real 2D context, so both correctly report "can't do it" — the
  // point of the test is that they answer instead of throwing, since the lobby
  // calls them during render.
  it("answer without throwing when the platform has no canvas support", () => {
    expect(typeof canvasCaptureSupported()).toBe("boolean");
    expect(typeof canvasFilterSupported()).toBe("boolean");
  });
});
