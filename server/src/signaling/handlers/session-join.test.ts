import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerSessionHandlers } from "./session.js";
import type { ConnectionContext } from "../context.js";

describe("join", () => {
  it("refuses a second join on a connection already in a room", async () => {
    const handlers = new Map<string, (data: unknown, cb: (res: unknown) => void) => unknown>();
    const ctx = {
      socket: { id: "me", on: (e: string, fn: never) => handlers.set(e, fn) },
      session: { currentRoom: { name: "first" }, currentPeer: {}, pendingRequest: null },
    } as unknown as ConnectionContext;
    registerSessionHandlers(ctx);
    const res = await new Promise((resolve) =>
      handlers.get("join")!({ roomName: "second", displayName: "Me" }, resolve),
    );
    assert.deepEqual(res, { ok: false, error: "already_joined" });
  });
});
