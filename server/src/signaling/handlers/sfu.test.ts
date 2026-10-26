import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerSfuHandlers } from "./sfu.js";
import type { ConnectionContext } from "../context.js";

// Structural fakes: create-transport only needs the room's router and the peer.
function setup() {
  const handlers = new Map<string, (data: unknown, cb: (res: unknown) => void) => unknown>();
  let n = 0;
  const transports: { id: string; closed: boolean }[] = [];
  const router = {
    createWebRtcTransport: async () => {
      const t = {
        id: `t${++n}`,
        closed: false,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
        close() {
          this.closed = true;
        },
        setMaxIncomingBitrate: async () => {},
      };
      transports.push(t);
      return t;
    },
  };
  const peer = {
    sendTransport: null,
    recvTransport: null,
    producers: new Map([["p1", {}]]),
    consumers: new Map([["c1", {}]]),
  };
  const ctx = {
    socket: { id: "me", on: (e: string, fn: never) => handlers.set(e, fn) },
    session: { currentRoom: { router }, currentPeer: peer, pendingRequest: null },
  } as unknown as ConnectionContext;
  registerSfuHandlers(ctx);
  const create = (direction: "send" | "recv") =>
    new Promise((resolve) => handlers.get("create-transport")!({ direction }, resolve));
  return { create, transports, peer };
}

describe("create-transport", () => {
  it("closes the transport it replaces instead of leaking it", async () => {
    const { create, transports, peer } = setup();
    await create("send");
    await create("send");
    await create("recv");
    await create("recv");
    assert.deepEqual(
      transports.map((t) => t.closed),
      [true, false, true, false],
    );
    assert.equal(peer.producers.size, 0);
    assert.equal(peer.consumers.size, 0);
  });
});
