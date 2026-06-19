import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { RtpParameters, RtpCapabilities } from "mediasoup/types";
import {
  RecordingManager,
  type RecordingDeps,
  type SpawnedProcess,
  type RecordingRouter,
  type RtpPlainTransport,
  type RtpConsumer,
} from "./recording.js";
import { PortAllocator } from "./recording-util.js";

// --- Fakes ----------------------------------------------------------------

class FakeProcess extends EventEmitter implements SpawnedProcess {
  pid = Math.floor(1); // constant; randomness not allowed in some harnesses
  stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  killed = false;
  lastSignal: NodeJS.Signals | number | undefined;
  command: string;
  args: string[];
  constructor(command: string, args: string[]) {
    super();
    this.command = command;
    this.args = args;
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.lastSignal = signal;
    return true;
  }
}

const RTP: RtpParameters = {
  codecs: [
    {
      mimeType: "audio/opus",
      payloadType: 100,
      clockRate: 48000,
      channels: 2,
      parameters: { minptime: 10 },
      rtcpFeedback: [],
    },
  ],
  encodings: [{ ssrc: 111 }],
  headerExtensions: [],
  rtcp: {},
} as unknown as RtpParameters;

class FakeConsumer implements RtpConsumer {
  kind = "audio";
  rtpParameters = RTP;
  closed = false;
  resumed = false;
  constructor(public id: string) {}
  async resume() {
    this.resumed = true;
  }
  close() {
    this.closed = true;
  }
}

class FakeTransport implements RtpPlainTransport {
  closed = false;
  connected?: { ip: string; port: number };
  consumer?: FakeConsumer;
  constructor(public id: string) {}
  async connect(params: { ip: string; port: number }) {
    this.connected = params;
  }
  async consume(params: { producerId: string }) {
    this.consumer = new FakeConsumer(`consumer-${params.producerId}`);
    return this.consumer;
  }
  close() {
    this.closed = true;
  }
}

class FakeRouter implements RecordingRouter {
  rtpCapabilities = { codecs: [], headerExtensions: [] } as unknown as RtpCapabilities;
  transports: FakeTransport[] = [];
  async createPlainTransport() {
    const t = new FakeTransport(`transport-${this.transports.length}`);
    this.transports.push(t);
    return t;
  }
}

interface Harness {
  manager: RecordingManager;
  router: FakeRouter;
  spawned: FakeProcess[];
  mkdirCalls: string[];
  rmCalls: string[];
  writes: { file: string; data: string }[];
  ports: PortAllocator;
  clock: { t: number };
  timers: Array<{ fn: () => void; ms: number }>;
  missingFiles: Set<string>;
  // capture files that exist but hold only an Opus header (a silent/muted
  // producer that received no RTP): a tiny ~158-byte file, below MIN_CAPTURE_BYTES.
  headerOnlyFiles: Set<string>;
}

function makeHarness(): Harness {
  const spawned: FakeProcess[] = [];
  const mkdirCalls: string[] = [];
  const rmCalls: string[] = [];
  const writes: { file: string; data: string }[] = [];
  const router = new FakeRouter();
  const ports = new PortAllocator(50000, 50020, 2);
  const clock = { t: 1000 };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const missingFiles = new Set<string>();
  const headerOnlyFiles = new Set<string>();

  const deps: Partial<RecordingDeps> = {
    spawn: (command, args) => {
      const p = new FakeProcess(command, args);
      spawned.push(p);
      return p;
    },
    now: () => clock.t,
    mkdir: async (dir) => {
      mkdirCalls.push(dir);
    },
    writeFile: async (file, data) => {
      writes.push({ file, data });
    },
    rm: async (dir) => {
      rmCalls.push(dir);
    },
    // pretend capture files exist with real audio (well above MIN_CAPTURE_BYTES)
    // unless explicitly marked missing (0 bytes) or header-only (a silent
    // producer's ~158-byte Ogg, which must be skipped so it can't break the mix)
    fileSize: (file) => (missingFiles.has(file) ? 0 : headerOnlyFiles.has(file) ? 158 : 100_000),
    sleep: async () => {},
    setTimer: (fn, ms) => {
      const entry = { fn, ms };
      timers.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      const i = timers.indexOf(handle as { fn: () => void; ms: number });
      if (i >= 0) timers.splice(i, 1);
    },
    tmpRoot: "/tmp/test-rec",
    ports,
    ffmpegPath: "ffmpeg",
    rtpListenIp: "127.0.0.1",
    resumeDelayMs: 0,
    finishedTtlMs: 60000,
    log: () => {},
  };

  return {
    manager: new RecordingManager(deps),
    router,
    spawned,
    mkdirCalls,
    rmCalls,
    writes,
    ports,
    clock,
    timers,
    missingFiles,
    headerOnlyFiles,
  };
}

const PRODUCERS = [
  { producerId: "p1", peerId: "alice" },
  { producerId: "p2", peerId: "bob" },
];

describe("RecordingManager.start", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("creates a working dir and one capture per producer", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);

    assert.equal(h.mkdirCalls.length, 1);
    assert.equal(h.mkdirCalls[0], rec.dir);
    assert.ok(rec.dir.startsWith("/tmp/test-rec/"));

    assert.equal(rec.recorders.size, 2);
    assert.equal(h.spawned.length, 2);
    assert.equal(h.router.transports.length, 2);

    // SDP written per producer, and each ffmpeg captures to an .ogg
    assert.equal(h.writes.length, 2);
    assert.ok(h.writes.every((w) => w.file.endsWith(".sdp")));
    assert.ok(h.writes.every((w) => w.data.includes("a=rtpmap:100 opus/48000/2")));
    assert.ok(h.spawned.every((p) => p.args.some((a) => a.endsWith(".ogg"))));

    // each consumer was created paused then resumed
    for (const t of h.router.transports) {
      assert.equal(t.consumer?.resumed, true);
      assert.ok(t.connected);
    }
    assert.equal(h.ports.size, 2);
    assert.equal(h.manager.isRecording("room1"), true);
  });

  it("is idempotent — a second start returns the same recording", async () => {
    const rec1 = await h.manager.start("room1", h.router, PRODUCERS);
    const rec2 = await h.manager.start("room1", h.router, PRODUCERS);
    assert.equal(rec1, rec2);
    assert.equal(h.spawned.length, 2);
  });

  it("starts with no producers (e.g. recording forces a P2P→SFU switch first)", async () => {
    const rec = await h.manager.start("room1", h.router, []);
    assert.equal(rec.recorders.size, 0);
    assert.equal(h.spawned.length, 0);
    assert.equal(h.manager.isRecording("room1"), true);
  });
});

describe("RecordingManager.addProducer / removeProducer", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("adds a capture for a producer that comes online mid-recording", async () => {
    await h.manager.start("room1", h.router, []);
    h.clock.t = 4000; // 3s into the recording
    await h.manager.addProducer("room1", { producerId: "p9", peerId: "carol" });

    const rec = h.manager.getRecording("room1")!;
    assert.equal(rec.recorders.size, 1);
    assert.equal(h.spawned.length, 1);

    const inputs = h.manager.getMixInputs("room1");
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].delayMs, 3000); // started 3s after recording began
  });

  it("does not double-record the same producer", async () => {
    await h.manager.start("room1", h.router, []);
    await h.manager.addProducer("room1", { producerId: "p9", peerId: "carol" });
    await h.manager.addProducer("room1", { producerId: "p9", peerId: "carol" });
    assert.equal(h.spawned.length, 1);
  });

  it("is a no-op when the room is not being recorded", async () => {
    await h.manager.addProducer("ghost", { producerId: "p1", peerId: "x" });
    assert.equal(h.spawned.length, 0);
    assert.equal(h.manager.isRecording("ghost"), false);
  });

  it("stops a producer's capture and releases its port, keeping the file", async () => {
    await h.manager.start("room1", h.router, PRODUCERS);
    assert.equal(h.ports.size, 2);
    await h.manager.removeProducer("room1", "p1");

    const rec = h.manager.getRecording("room1")!;
    assert.equal(rec.recorders.size, 1);
    assert.equal(h.ports.size, 1);
    // the capture for p1 was SIGINT'd (clean Ogg finalize)
    const p1Proc = h.spawned.find((p) => p.args.some((a) => a.includes("alice__p1")))!;
    assert.equal(p1Proc.killed, true);
    assert.equal(p1Proc.lastSignal, "SIGINT");
  });

  it("keeps a left producer's track in the mix and per-track inputs", async () => {
    await h.manager.start("room1", h.router, PRODUCERS);
    await h.manager.removeProducer("room1", "p1"); // alice leaves mid-recording

    // alice's already-captured audio is still part of the recording, even
    // though her producer is gone (closedRecorders, not dropped).
    const mixInputs = h.manager.getMixInputs("room1");
    assert.equal(mixInputs.length, 2);
    assert.ok(mixInputs.some((i) => i.path.includes("alice__p1")));
    assert.ok(mixInputs.some((i) => i.path.includes("bob__p2")));

    const tracks = h.manager.getTrackFiles("room1");
    assert.equal(tracks.length, 2);
    assert.ok(tracks.some((t) => t.path.includes("alice__p1")));
  });
});

describe("RecordingManager.getTrackFiles / tracksByRecordingId", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("lists one friendly, ordered file per captured track", async () => {
    h.clock.t = 1000;
    const rec = await h.manager.start("room1", h.router, [
      { producerId: "p1", peerId: "sock-alice", label: "Alice" },
    ]);
    h.clock.t = 5000;
    await h.manager.addProducer("room1", {
      producerId: "p2",
      peerId: "sock-bob",
      label: "Bob",
      source: "share",
    });

    const tracks = h.manager.getTrackFiles("room1");
    assert.deepEqual(
      tracks.map((t) => t.name),
      ["01-Alice.ogg", "02-Bob-share.ogg"],
    );
    // names map onto the right on-disk files
    assert.ok(tracks[0].path.startsWith(rec.dir));
    assert.ok(tracks[0].path.includes("sock-alice__p1"));
    assert.ok(tracks[1].path.includes("sock-bob__p2"));
  });

  it("falls back to the peer id when no display name is known", async () => {
    await h.manager.start("room1", h.router, [{ producerId: "p1", peerId: "alice" }]);
    const tracks = h.manager.getTrackFiles("room1");
    assert.deepEqual(
      tracks.map((t) => t.name),
      ["01-alice.ogg"],
    );
  });

  it("skips tracks whose capture file is missing/empty", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    h.missingFiles.add(`${rec.dir}/bob__p2.ogg`);
    const tracks = h.manager.getTrackFiles("room1");
    assert.equal(tracks.length, 1);
    assert.ok(tracks[0].path.includes("alice__p1"));
  });

  it("skips header-only captures (a muted producer that received no RTP)", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    // bob stayed muted: his capture file is just an Opus header, no audio
    h.headerOnlyFiles.add(`${rec.dir}/bob__p2.ogg`);
    const tracks = h.manager.getTrackFiles("room1");
    assert.equal(tracks.length, 1);
    assert.ok(tracks[0].path.includes("alice__p1"));
  });

  it("resolves an active or finished recording by its id", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    assert.equal(h.manager.tracksByRecordingId(rec.id)?.length, 2);
    await h.manager.finalize("room1");
    assert.equal(h.manager.tracksByRecordingId(rec.id)?.length, 2);
    assert.equal(h.manager.tracksByRecordingId("nope"), null);
  });
});

describe("RecordingManager.mix", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("spawns a mixing ffmpeg over the current files without stopping captures", async () => {
    await h.manager.start("room1", h.router, PRODUCERS);
    const captureCount = h.spawned.length;

    const proc = h.manager.mix("room1") as FakeProcess;
    assert.ok(proc);
    // a new ffmpeg was spawned for the mix
    assert.equal(h.spawned.length, captureCount + 1);
    assert.deepEqual(proc.args.slice(-2), ["ogg", "pipe:1"]);
    // captures are untouched (still alive)
    const captures = h.spawned.slice(0, captureCount);
    assert.ok(captures.every((p) => !p.killed));
  });

  it("returns null when nothing has been captured yet", async () => {
    await h.manager.start("room1", h.router, []);
    assert.equal(h.manager.mix("room1"), null);
  });

  it("skips inputs whose capture file is missing/empty (one bad recorder doesn't kill the mix)", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    // simulate bob's capture having failed to produce a file
    const bobFile = `${rec.dir}/bob__p2.ogg`;
    h.missingFiles.add(bobFile);
    const before = h.spawned.length;
    const proc = h.manager.mix("room1") as FakeProcess;
    assert.ok(proc, "should still mix the good stream");
    assert.equal(h.spawned.length, before + 1);
    // only alice's file is fed to the mix
    const inputArgs = proc.args.filter((_, i) => proc.args[i - 1] === "-i");
    assert.ok(inputArgs.some((p) => p.includes("alice__p1")));
    assert.ok(!inputArgs.some((p) => p.includes("bob__p2")));
  });

  it("skips header-only captures so a muted producer can't break the whole mix", async () => {
    // Regression: a silent/muted producer leaves a tiny header-only Ogg. ffmpeg
    // can't open it and aborts the entire mix (exit 187), so the download came
    // back empty whenever anyone in the room was muted.
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    h.headerOnlyFiles.add(`${rec.dir}/bob__p2.ogg`);
    const before = h.spawned.length;
    const proc = h.manager.mix("room1") as FakeProcess;
    assert.ok(proc, "should still mix alice's real audio");
    assert.equal(h.spawned.length, before + 1);
    const inputArgs = proc.args.filter((_, i) => proc.args[i - 1] === "-i");
    assert.ok(inputArgs.some((p) => p.includes("alice__p1")));
    assert.ok(!inputArgs.some((p) => p.includes("bob__p2")), "header-only file is excluded");
  });

  it("returns null when every capture is header-only (all producers silent)", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    h.headerOnlyFiles.add(`${rec.dir}/alice__p1.ogg`);
    h.headerOnlyFiles.add(`${rec.dir}/bob__p2.ogg`);
    assert.equal(h.manager.mix("room1"), null);
  });

  it("can mix a finished recording after stop, by recording id", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    await h.manager.finalize("room1");
    const proc = h.manager.mixByRecordingId(rec.id) as FakeProcess;
    assert.ok(proc, "finished recording is still downloadable");
    assert.deepEqual(proc.args.slice(-2), ["ogg", "pipe:1"]);
  });
});

describe("RecordingManager.finalize", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("stops captures but keeps the recording downloadable (no rm, files retained)", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    const captures = h.spawned.slice();
    await h.manager.finalize("room1");

    // captures finalized (SIGINT), ports released, transports closed
    assert.ok(captures.every((p) => p.killed && p.lastSignal === "SIGINT"));
    assert.equal(h.ports.size, 0);
    assert.ok(h.router.transports.every((t) => t.closed));
    // but NOT discarded: no rm, still resolvable, mix still works
    assert.deepEqual(h.rmCalls, []);
    assert.equal(h.manager.getRecording("room1")?.id, rec.id);
    assert.ok(h.manager.mix("room1"));
    // no longer "recording" — so the room can fall back to P2P
    assert.equal(h.manager.isRecording("room1"), false);
    // a TTL cleanup was scheduled
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 60000);
  });

  it("TTL firing discards the finished recording and notifies via onExpire", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    const expired: Array<{ room: string; id: string }> = [];
    h.manager.onExpire = (room, id) => expired.push({ room, id });
    await h.manager.finalize("room1");

    assert.equal(h.timers.length, 1);
    h.timers[0].fn(); // simulate the TTL elapsing
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(h.manager.getRecording("room1"), undefined);
    assert.deepEqual(h.rmCalls, [rec.dir]);
    assert.deepEqual(expired, [{ room: "room1", id: rec.id }]);
  });

  it("starting a new recording discards a previous finished one first", async () => {
    const rec1 = await h.manager.start("room1", h.router, PRODUCERS);
    await h.manager.finalize("room1");
    assert.equal(h.timers.length, 1);

    const rec2 = await h.manager.start("room1", h.router, []);
    assert.notEqual(rec1.id, rec2.id);
    assert.deepEqual(h.rmCalls, [rec1.dir]); // old one cleaned up
    assert.equal(h.timers.length, 0); // its TTL was cancelled
    assert.equal(h.manager.isRecording("room1"), true);
  });

  it("does not re-capture a producer that leaves after finalize (files preserved)", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    await h.manager.finalize("room1");
    await h.manager.removeProducer("room1", "p1"); // no-op while finished
    // both files still part of the recording
    assert.equal(h.manager.getRecording("room1")?.recorders.size, 2);
    assert.equal(rec.status, "finished");
  });
});

describe("RecordingManager.discard", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("kills every capture, releases all ports, and removes the dir", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    await h.manager.discard("room1");

    assert.equal(h.manager.isRecording("room1"), false);
    assert.equal(h.manager.getRecording("room1"), undefined);
    assert.ok(h.spawned.every((p) => p.killed));
    assert.equal(h.ports.size, 0);
    assert.deepEqual(h.rmCalls, [rec.dir]);
    assert.ok(h.router.transports.every((t) => t.closed));
    assert.ok(h.router.transports.every((t) => t.consumer?.closed));
  });

  it("discards a finished recording and cancels its TTL", async () => {
    const rec = await h.manager.start("room1", h.router, PRODUCERS);
    await h.manager.finalize("room1");
    assert.equal(h.timers.length, 1);
    await h.manager.discard("room1");
    assert.deepEqual(h.rmCalls, [rec.dir]);
    assert.equal(h.timers.length, 0);
    assert.equal(h.manager.getRecording("room1"), undefined);
  });

  it("is a no-op for an unknown room", async () => {
    await h.manager.discard("nope");
    assert.equal(h.rmCalls.length, 0);
  });

  it("stopAll tears down every room", async () => {
    await h.manager.start("room1", h.router, PRODUCERS);
    await h.manager.start("room2", h.router, [{ producerId: "p3", peerId: "dave" }]);
    await h.manager.stopAll();
    assert.equal(h.manager.isRecording("room1"), false);
    assert.equal(h.manager.isRecording("room2"), false);
    assert.equal(h.ports.size, 0);
  });
});
