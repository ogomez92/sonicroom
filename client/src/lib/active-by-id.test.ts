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

describe("useActiveById", () => {
  it("re-attaches to the row that took over, then follows it by id", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { useActiveById } = await import("./active-by-id");
    const { result, rerender } = renderHook(({ items }) => useActiveById(items, (x) => x), {
      initialProps: { items: ["a", "b", "c", "d", "e"] },
    });
    act(() => result.current[1](2)); // on "c"
    rerender({ items: ["a", "b", "d", "e"] }); // "c" left: "d" takes over row 2
    expect(result.current[0]).toBe(2);
    rerender({ items: ["b", "d", "e"] }); // "a" left above: stay on "d", not "e"
    expect(result.current[0]).toBe(1);
    rerender({ items: [] });
    expect(result.current[0]).toBe(-1);
    rerender({ items: ["z"] }); // emptied list does not come back pre-activated
    expect(result.current[0]).toBe(-1);
  });
});
