import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerSessionHandlers } from "./session.js";
import type { ConnectionContext } from "../context.js";

// Minimal fakes: the p2p relay only touches the session's room and io.to().
function setup(roomPeers: string[]) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const sent: { to: string; event: string }[] = [];
  const socket = {
    id: "me",
    on: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, fn),
  };
  const io = {
    to: (to: string) => ({ emit: (event: string) => sent.push({ to, event }) }),
  };
  const ctx = {
    io,
    socket,
    session: {
      currentRoom: { peers: new Map(roomPeers.map((id) => [id, {}])) },
      currentPeer: {},
      pendingRequest: null,
    },
  } as unknown as ConnectionContext;
  registerSessionHandlers(ctx);
  const signal = (targetPeerId: string) =>
    handlers.get("p2p-signal")!({ targetPeerId, type: "offer", payload: {} });
  return { sent, signal };
}

describe("p2p-signal relay", () => {
  it("relays to a peer in the same room", () => {
    const { sent, signal } = setup(["me", "friend"]);
    signal("friend");
    assert.deepEqual(sent, [{ to: "friend", event: "p2p-signal" }]);
  });

  it("drops a target outside the room (another socket or a room name)", () => {
    const { sent, signal } = setup(["me", "friend"]);
    signal("stranger");
    signal("someprivateroom");
    signal("me");
    assert.deepEqual(sent, []);
  });
});
