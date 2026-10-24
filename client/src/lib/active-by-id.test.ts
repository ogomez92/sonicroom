import { describe, it, expect } from "vitest";
import { resolveActiveIndex } from "./active-by-id";

describe("resolveActiveIndex", () => {
  it("is -1 when nothing is active or the list is empty", () => {
    expect(resolveActiveIndex(["a"], null)).toBe(-1);
    expect(resolveActiveIndex([], { id: "a", idx: 0 })).toBe(-1);
  });

  it("follows the item when a row above it disappears", () => {
    // "c" was row 2; "a" left, so "c" is now row 1 — not whoever slid into 2.
    expect(resolveActiveIndex(["b", "c", "d"], { id: "c", idx: 2 })).toBe(1);
  });

  it("falls back to the nearest index when the active item vanished", () => {
    expect(resolveActiveIndex(["a", "c", "d"], { id: "b", idx: 1 })).toBe(1);
    expect(resolveActiveIndex(["a"], { id: "z", idx: 3 })).toBe(0);
  });
});
