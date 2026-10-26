import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchRoomStatus, hasStoredHostKey, lobbyMode, showsRoomOptions } from "./room-lookup";

const realFetch = globalThis.fetch;
function stubFetch(status: number, body: unknown) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return { status, json: async () => body };
  }) as unknown as typeof fetch;
  return calls;
}

describe("fetchRoomStatus", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reads a live room", async () => {
    const calls = stubFetch(200, { exists: true, reserved: false, isVideo: true, participants: 2 });
    expect(await fetchRoomStatus("studio")).toEqual({
      name: "studio",
      exists: true,
      reserved: false,
      isVideo: true,
    });
    expect(calls[0]).toContain("/api/rooms/studio");
  });

  it("treats a 404 as a real answer, keeping `reserved`", async () => {
    stubFetch(404, { exists: false, reserved: true, error: "Room not found" });
    expect(await fetchRoomStatus("studio")).toEqual({
      name: "studio",
      exists: false,
      reserved: true,
      isVideo: false,
    });
  });

  it("gives no answer for a rejected name, a bad body or a network error", async () => {
    stubFetch(400, { error: "Invalid room name" });
    expect(await fetchRoomStatus("x")).toBeNull();
    stubFetch(200, { nope: 1 });
    expect(await fetchRoomStatus("x")).toBeNull();
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchRoomStatus("x")).toBeNull();
  });
});

describe("lobbyMode", () => {
  const base = { name: "studio", exists: false, reserved: false, isVideo: false };

  it("creates when nothing is known or nobody is there", () => {
    expect(lobbyMode(null, false)).toBe("create");
    expect(lobbyMode(base, false)).toBe("create");
  });

  it("joins a live room — even a reserved one, even for the host", () => {
    expect(lobbyMode({ ...base, exists: true }, false)).toBe("join");
    expect(lobbyMode({ ...base, exists: true, reserved: true }, true)).toBe("join");
  });

  it("splits a reserved, not-yet-open room on the host key", () => {
    expect(lobbyMode({ ...base, reserved: true }, false)).toBe("reserved-wait");
    expect(lobbyMode({ ...base, reserved: true }, true)).toBe("reserved-host");
  });

  it("shows the room options only to whoever opens the room", () => {
    expect(showsRoomOptions("create")).toBe(true);
    expect(showsRoomOptions("reserved-host")).toBe(true);
    expect(showsRoomOptions("join")).toBe(false);
    expect(showsRoomOptions("reserved-wait")).toBe(false);
  });
});

describe("hasStoredHostKey", () => {
  beforeEach(() => sessionStorage.clear());

  it("is keyed by room", () => {
    sessionStorage.setItem("sonicroom:hostKey:studio", "k");
    expect(hasStoredHostKey("studio")).toBe(true);
    expect(hasStoredHostKey("other")).toBe(false);
    expect(hasStoredHostKey("")).toBe(false);
  });
});
