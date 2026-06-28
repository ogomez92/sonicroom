// Fakes for getUserMedia / getDisplayMedia and the MediaStream/track objects the
// client touches. Tests can make acquisition fail (no mic, denied permission, a
// busy extra mic) by toggling the controller flags.

export class FakeMediaStreamTrack {
  enabled = true;
  readyState: "live" | "ended" = "live";
  readonly listeners = new Map<string, Set<() => void>>();
  constructor(
    public kind: "audio" | "video",
    public label = "",
  ) {}
  stop() {
    this.readyState = "ended";
  }
  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }
  // Test helper: fire e.g. the display track's "ended" (user hit "stop sharing").
  emit(type: string) {
    this.listeners.get(type)?.forEach((cb) => cb());
  }
}

export class FakeMediaStream {
  private tracks: FakeMediaStreamTrack[];
  constructor(tracks: FakeMediaStreamTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(t: FakeMediaStreamTrack) {
    this.tracks.push(t);
  }
}

class MediaController {
  // Flip these to simulate failures.
  failUserMedia = false;
  failExtraMics = new Set<string>();
  displayHasAudio = true;
  failDisplay = false;
  // Records of what was requested, for assertions.
  readonly userMediaCalls: MediaStreamConstraints[] = [];
  readonly displayCalls: unknown[] = [];

  getUserMedia = (constraints: MediaStreamConstraints): Promise<FakeMediaStream> => {
    this.userMediaCalls.push(constraints);
    const audio = constraints.audio as { deviceId?: { exact?: string } } | undefined;
    const exact = audio?.deviceId?.exact;
    if (this.failUserMedia && !exact) {
      return Promise.reject(new DOMException("denied", "NotAllowedError"));
    }
    if (exact && this.failExtraMics.has(exact)) {
      return Promise.reject(new DOMException("busy", "NotReadableError"));
    }
    const label = exact ? `device-${exact}` : "Default Mic";
    return Promise.resolve(new FakeMediaStream([new FakeMediaStreamTrack("audio", label)]));
  };

  getDisplayMedia = (opts: unknown): Promise<FakeMediaStream> => {
    this.displayCalls.push(opts);
    if (this.failDisplay) return Promise.reject(new DOMException("cancelled", "NotAllowedError"));
    const tracks = [new FakeMediaStreamTrack("video", "screen")];
    if (this.displayHasAudio) tracks.push(new FakeMediaStreamTrack("audio", "System Audio"));
    return Promise.resolve(new FakeMediaStream(tracks));
  };

  reset() {
    this.failUserMedia = false;
    this.failExtraMics.clear();
    this.displayHasAudio = true;
    this.failDisplay = false;
    this.userMediaCalls.length = 0;
    this.displayCalls.length = 0;
  }
}

export const mediaController = new MediaController();

export function installMediaMock() {
  const g = globalThis as Record<string, unknown>;
  g.MediaStream = FakeMediaStream;
  if (!g.navigator) g.navigator = {};
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: (c: MediaStreamConstraints) => mediaController.getUserMedia(c),
      getDisplayMedia: (o: unknown) => mediaController.getDisplayMedia(o),
      enumerateDevices: () => Promise.resolve([]),
    },
  });
}
