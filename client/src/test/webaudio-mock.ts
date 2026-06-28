// A small but faithful Web Audio fake for tests. jsdom has no Web Audio, and the
// client wires almost everything (mic graph, per-peer gain, ducking, cues)
// through a shared AudioContext, so the fake has to cover the node types the app
// actually creates. Nodes record their connections and AudioParams keep their
// last-set value (ramps update `.value`) so tests can assert on gains directly.

export class FakeAudioParam {
  value: number;
  readonly calls: Array<{ method: string; args: number[] }> = [];
  constructor(initial = 0) {
    this.value = initial;
  }
  setValueAtTime(v: number, t: number) {
    this.value = v;
    this.calls.push({ method: "setValueAtTime", args: [v, t] });
    return this;
  }
  setTargetAtTime(v: number, t: number, c: number) {
    // The app reads `.value` after ramping, so reflect the target immediately.
    this.value = v;
    this.calls.push({ method: "setTargetAtTime", args: [v, t, c] });
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.calls.push({ method: "exponentialRampToValueAtTime", args: [v, t] });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.calls.push({ method: "linearRampToValueAtTime", args: [v, t] });
    return this;
  }
  cancelScheduledValues(t: number) {
    this.calls.push({ method: "cancelScheduledValues", args: [t] });
    return this;
  }
}

export class FakeAudioNode {
  readonly connectedTo: FakeAudioNode[] = [];
  channelCount = 2;
  connect(target: FakeAudioNode): FakeAudioNode {
    this.connectedTo.push(target);
    return target;
  }
  disconnect() {
    this.connectedTo.length = 0;
  }
}

export class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam(1);
}

export class FakeOscillatorNode extends FakeAudioNode {
  type = "sine";
  frequency = new FakeAudioParam(440);
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

export class FakeBiquadFilterNode extends FakeAudioNode {
  type = "lowpass";
  frequency = new FakeAudioParam(350);
  Q = new FakeAudioParam(1);
}

export class FakeDynamicsCompressorNode extends FakeAudioNode {
  threshold = new FakeAudioParam(-24);
  knee = new FakeAudioParam(30);
  ratio = new FakeAudioParam(12);
  attack = new FakeAudioParam(0.003);
  release = new FakeAudioParam(0.25);
}

export class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  // Filled by tests that want to simulate a "speaking" peer.
  nextSamples: Float32Array | null = null;
  getFloatTimeDomainData(buf: Float32Array) {
    if (this.nextSamples) {
      buf.set(this.nextSamples.subarray(0, buf.length));
    } else {
      buf.fill(0);
    }
  }
}

export class FakeAudioBuffer {
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  getChannelData() {
    return new Float32Array(this.length);
  }
}

export class FakeAudioBufferSourceNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

export class FakeMediaStreamAudioSourceNode extends FakeAudioNode {}
export class FakeMediaElementAudioSourceNode extends FakeAudioNode {}

export class FakeMediaStreamAudioDestinationNode extends FakeAudioNode {
  stream: { getAudioTracks: () => unknown[] };
  constructor(makeTrack: () => unknown) {
    super();
    const track = makeTrack();
    this.stream = { getAudioTracks: () => [track] };
  }
}

let nodeCounter = 0;
function trackLabel() {
  return `fake-dest-track-${nodeCounter++}`;
}

interface AudioContextOptions {
  sampleRate?: number;
  latencyHint?: unknown;
}

export class FakeAudioContext {
  state: "running" | "suspended" | "closed" | "interrupted" = "running";
  currentTime = 0;
  sampleRate: number;
  destination = new FakeAudioNode();
  sinkId = "";
  readonly listeners = new Map<string, Set<() => void>>();
  readonly created = {
    gain: 0,
    oscillator: 0,
    analyser: 0,
    compressor: 0,
    streamSource: 0,
    streamDest: 0,
    elementSource: 0,
  };
  // setSinkId is added on the prototype below so `"setSinkId" in
  // AudioContext.prototype` (canSelectSpeaker) is true; tests can delete it.
  declare setSinkId: (id: string) => Promise<void>;

  constructor(opts: AudioContextOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 44100;
  }
  createGain() {
    this.created.gain++;
    return new FakeGainNode();
  }
  createOscillator() {
    this.created.oscillator++;
    return new FakeOscillatorNode();
  }
  createBiquadFilter() {
    return new FakeBiquadFilterNode();
  }
  createDynamicsCompressor() {
    this.created.compressor++;
    return new FakeDynamicsCompressorNode();
  }
  createAnalyser() {
    this.created.analyser++;
    return new FakeAnalyserNode();
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
  createBufferSource() {
    return new FakeAudioBufferSourceNode();
  }
  createMediaStreamSource() {
    this.created.streamSource++;
    return new FakeMediaStreamAudioSourceNode();
  }
  createMediaStreamDestination() {
    this.created.streamDest++;
    return new FakeMediaStreamAudioDestinationNode(() => ({
      kind: "audio",
      label: trackLabel(),
      enabled: true,
      readyState: "live",
      stop() {},
    }));
  }
  createMediaElementSource() {
    this.created.elementSource++;
    return new FakeMediaElementAudioSourceNode();
  }
  resume() {
    if (this.state !== "closed") this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }
  // Test helper: fire a registered listener (e.g. "statechange").
  emit(type: string) {
    this.listeners.get(type)?.forEach((cb) => cb());
  }
}

// Put setSinkId on the prototype so canSelectSpeaker() (which probes the
// prototype) is true by default. Tests delete it to exercise the unsupported path.
(FakeAudioContext.prototype as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId =
  function (this: FakeAudioContext, id: string) {
    if (id === "bad-sink") return Promise.reject(new Error("no such sink"));
    this.sinkId = id;
    return Promise.resolve();
  };

export class FakeOfflineAudioContext extends FakeAudioContext {
  constructor(channels: number, length: number, sampleRate: number) {
    super({ sampleRate });
    void channels;
    void length;
  }
  startRendering() {
    return Promise.resolve(new FakeAudioBuffer(1, 1, this.sampleRate));
  }
}

// Install the Web Audio fakes as globals. Returns nothing; call from setup.
export function installWebAudioMock() {
  const g = globalThis as Record<string, unknown>;
  g.AudioContext = FakeAudioContext;
  g.OfflineAudioContext = FakeOfflineAudioContext;
  g.GainNode = FakeGainNode;
}
