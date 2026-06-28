// Fake mediasoup-client Device/Transport/Producer/Consumer. The real library is
// replaced via vi.mock("mediasoup-client") in the hook test; this provides the
// surface useMediasoup uses: load(), createSend/RecvTransport(), produce(),
// consume(), and producer pause/resume/close. Every produced track and produce
// call is recorded so tests can assert what the client sent (source/codec) and
// that producers are torn down on a mode switch.

let producerSeq = 0;
let consumerSeq = 0;

export interface ProduceOptions {
  track: { label?: string };
  codecOptions?: Record<string, unknown>;
  codec?: unknown;
  appData?: { source?: string; title?: string };
  stopTracks?: boolean;
}

export class FakeProducer {
  readonly id = `producer-${producerSeq++}`;
  closed = false;
  paused = false;
  constructor(readonly options: ProduceOptions) {}
  get source() {
    return this.options.appData?.source ?? "voice";
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  close() {
    this.closed = true;
  }
}

export class FakeConsumer {
  readonly id = `consumer-${consumerSeq++}`;
  closed = false;
  track = { kind: "audio", label: "remote-consumer", stop() {} };
  constructor(readonly params: { id: string; producerId: string; kind: string }) {}
  close() {
    this.closed = true;
  }
}

type TransportHandlers = Record<string, (...args: unknown[]) => void>;

export class FakeTransport {
  closed = false;
  readonly handlers: TransportHandlers = {};
  readonly producers: FakeProducer[] = [];
  readonly consumers: FakeConsumer[] = [];

  constructor(
    readonly direction: "send" | "recv",
    readonly params: Record<string, unknown>,
  ) {}

  on(event: string, cb: (...args: unknown[]) => void) {
    this.handlers[event] = cb;
  }

  async produce(options: ProduceOptions): Promise<FakeProducer> {
    // Drive the "produce" handler the hook registered, like mediasoup-client
    // does — it emits to the server and calls back with the server producer id.
    const produceCb = this.handlers["produce"];
    if (produceCb) {
      await new Promise<void>((resolve, reject) => {
        produceCb(
          {
            kind: "audio",
            rtpParameters: {},
            appData: options.appData ?? {},
          },
          () => resolve(),
          (e: Error) => reject(e),
        );
      });
    }
    const producer = new FakeProducer(options);
    this.producers.push(producer);
    return producer;
  }

  async consume(params: { id: string; producerId: string; kind: string }): Promise<FakeConsumer> {
    const consumer = new FakeConsumer(params);
    this.consumers.push(consumer);
    return consumer;
  }

  close() {
    this.closed = true;
  }

  // Test helper: trigger the transport "connect" handshake.
  async fireConnect() {
    await new Promise<void>((resolve, reject) => {
      this.handlers["connect"]?.({ dtlsParameters: {} }, () => resolve(), reject);
    });
  }
}

export class FakeDevice {
  static instances: FakeDevice[] = [];
  loaded = false;
  recvRtpCapabilities = {
    codecs: [{ mimeType: "audio/opus", kind: "audio" }],
  };
  readonly sendTransports: FakeTransport[] = [];
  readonly recvTransports: FakeTransport[] = [];

  constructor() {
    FakeDevice.instances.push(this);
  }

  async load() {
    this.loaded = true;
  }

  createSendTransport(params: Record<string, unknown>) {
    const t = new FakeTransport("send", params);
    this.sendTransports.push(t);
    return t;
  }
  createRecvTransport(params: Record<string, unknown>) {
    const t = new FakeTransport("recv", params);
    this.recvTransports.push(t);
    return t;
  }
}

export function resetMediasoupMock() {
  FakeDevice.instances.length = 0;
  producerSeq = 0;
  consumerSeq = 0;
}
