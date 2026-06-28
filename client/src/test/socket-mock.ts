// Fake socket.io client + a small in-memory "server" that answers the request/ack
// events useMediasoup sends (join, create-transport, produce, consume, …) and
// lets tests push server→client events (switch-to-sfu, new-producer, peer-joined,
// …). The real module is swapped via vi.mock("socket.io-client", () => ({ io })).
//
// Two emit shapes are modelled, matching socket.io:
//   socket.emit(event, data)                       — fire-and-forget (recorded)
//   socket.timeout(ms).emit(event, data, ack)      — request/response (answered)

type Ack = (err: Error | null, res?: unknown) => void;
type Handler = (...args: unknown[]) => unknown;
type Responder = (data: unknown) => unknown | Promise<unknown>;

export interface JoinResponse {
  ok: boolean;
  status?: "joined" | "pending";
  rtpCapabilities: Record<string, unknown>;
  peers: Array<{
    peerId: string;
    displayName: string;
    muted?: boolean;
    producers: Array<{ producerId: string; source: string; title?: string }>;
  }>;
  mode: "p2p" | "sfu";
  recording: { recordingId: string } | null;
  streaming?: boolean;
  voiceActive?: boolean;
  duckingEnabled?: boolean;
  isPublic?: boolean;
  kickVotes?: Array<{ targetId: string; votes: number }>;
  messages: unknown[];
}

export class FakeSocket {
  id: string | undefined;
  connected = false;
  private readonly handlers = new Map<string, Handler[]>();
  // Every client→server emit, in order, for assertions.
  readonly sent: Array<{ event: string; data: unknown }> = [];

  constructor(private readonly server: FakeServer) {}

  on(event: string, cb: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(cb);
    return this;
  }
  off(event: string) {
    this.handlers.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    const maybeAck = args[args.length - 1];
    if (typeof maybeAck === "function") {
      this.sent.push({ event, data: args[0] });
      void this.server.respond(event, args[0]).then(
        (res) => (maybeAck as Ack)(null, res),
        (err) => (maybeAck as Ack)(err as Error),
      );
    } else {
      this.sent.push({ event, data: args[0] });
    }
    return this;
  }

  timeout() {
    return {
      emit: (event: string, data: unknown, ack: Ack) => this.emit(event, data, ack),
    };
  }

  disconnect() {
    this.connected = false;
    this.fire("disconnect");
    return this;
  }

  // --- test helpers (server → client, and lifecycle) ---

  // Fire a registered handler and return a promise that settles once every
  // (possibly async) handler has resolved.
  fire(event: string, ...args: unknown[]): Promise<unknown[]> {
    const cbs = this.handlers.get(event) ?? [];
    return Promise.all(cbs.map((cb) => Promise.resolve(cb(...args))));
  }

  hasHandler(event: string) {
    return (this.handlers.get(event)?.length ?? 0) > 0;
  }

  // Simulate the socket connecting (sets the id, then runs the "connect" chain).
  async connect(id = "id-self") {
    this.id = id;
    this.connected = true;
    await this.fire("connect");
  }

  // Convenience: all events of a given name the client sent, newest last.
  sentEvents(event: string) {
    return this.sent.filter((s) => s.event === event).map((s) => s.data);
  }
  lastSent(event: string) {
    const all = this.sentEvents(event);
    return all[all.length - 1];
  }
}

export class FakeServer {
  lastSocket: FakeSocket | null = null;
  readonly sockets: FakeSocket[] = [];
  private readonly responders = new Map<string, Responder>();
  private producerSeq = 0;
  private consumerSeq = 0;

  // The join payload the next "join" ack returns. Tests tweak mode/peers/etc.
  joinResponse: JoinResponse = FakeServer.defaultJoin();

  static defaultJoin(): JoinResponse {
    return {
      ok: true,
      status: "joined",
      rtpCapabilities: {},
      peers: [],
      mode: "p2p",
      recording: null,
      streaming: false,
      voiceActive: false,
      duckingEnabled: true,
      isPublic: false,
      kickVotes: [],
      messages: [],
    };
  }

  newSocket() {
    const s = new FakeSocket(this);
    this.lastSocket = s;
    this.sockets.push(s);
    return s;
  }

  // Override (or stub) the response for one event.
  on(event: string, responder: Responder) {
    this.responders.set(event, responder);
  }

  async respond(event: string, data: unknown): Promise<unknown> {
    const custom = this.responders.get(event);
    if (custom) return await custom(data);
    return this.defaultRespond(event, data);
  }

  private defaultRespond(event: string, data: unknown): unknown {
    switch (event) {
      case "join":
        return this.joinResponse;
      case "create-transport":
        return {
          ok: true,
          params: {
            id: `transport-${(data as { direction: string }).direction}`,
            iceParameters: {},
            iceCandidates: [],
            dtlsParameters: {},
          },
        };
      case "connect-transport":
        return { ok: true };
      case "produce":
        return { ok: true, producerId: `srv-producer-${this.producerSeq++}` };
      case "consume":
        return {
          ok: true,
          consumerId: `srv-consumer-${this.consumerSeq++}`,
          producerId: (data as { producerId: string }).producerId,
          kind: "audio",
          rtpParameters: {},
        };
      case "start-recording":
        return { ok: true, recordingId: "rec-1" };
      default:
        return { ok: true };
    }
  }

  reset() {
    this.lastSocket = null;
    this.sockets.length = 0;
    this.responders.clear();
    this.producerSeq = 0;
    this.consumerSeq = 0;
    this.joinResponse = FakeServer.defaultJoin();
  }
}

export const fakeServer = new FakeServer();

// The io() replacement. Ignores its args (target/options) and hands back a fresh
// socket bound to the shared fake server. The hook calls io() once per join().
export function ioMock() {
  return fakeServer.newSocket();
}
