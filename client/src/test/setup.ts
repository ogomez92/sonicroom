// Global test setup (vitest `setupFiles`). Runs before every test module — and,
// crucially, before useMediasoup.ts is imported, since that module creates a
// `new AudioContext()` at load time. Installs the browser-API fakes the client
// relies on but jsdom does not provide (Web Audio, WebRTC, getUserMedia, …).
import { installWebAudioMock } from "./webaudio-mock";
import { installMediaMock } from "./media-mock";
import { installWebRtcMock } from "./webrtc-mock";

installWebAudioMock();
installMediaMock();
installWebRtcMock();

const g = globalThis as Record<string, unknown>;

// jsdom doesn't implement HTMLMediaElement playback or srcObject — stub them so
// `new Audio()` graphs (file streaming, per-peer pipelines) don't throw.
const proto = globalThis.HTMLMediaElement?.prototype;
if (proto) {
  // Track a paused flag so toggleFilePlayback (which reads `el.paused`) behaves.
  proto.play = function play(this: { _paused?: boolean }) {
    this._paused = false;
    return Promise.resolve();
  };
  proto.pause = function pause(this: { _paused?: boolean }) {
    this._paused = true;
  };
  Object.defineProperty(proto, "paused", {
    configurable: true,
    get(this: { _paused?: boolean }) {
      return this._paused ?? true;
    },
  });
  if (!Object.getOwnPropertyDescriptor(proto, "srcObject")) {
    Object.defineProperty(proto, "srcObject", {
      configurable: true,
      get() {
        return this._srcObject ?? null;
      },
      set(v) {
        this._srcObject = v;
      },
    });
  }
}

// Object URLs (file streaming creates/revokes them).
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => "blob:fake";
}
if (!globalThis.URL.revokeObjectURL) {
  globalThis.URL.revokeObjectURL = () => {};
}

// Speech synthesis (tts.ts) — a benign default; the tts test overrides it.
class FakeSpeechSynthesisUtterance {
  text: string;
  lang = "";
  constructor(text: string) {
    this.text = text;
  }
}
g.SpeechSynthesisUtterance = FakeSpeechSynthesisUtterance;
if (!("speechSynthesis" in window)) {
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { getVoices: () => [], speak: () => {} },
  });
}

// jsdom's localStorage in this runner is unreliable (no .clear); install a clean
// in-memory Storage for both local and session storage so persistence round-trips
// are deterministic and resettable between tests.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  key(i: number) {
    return Array.from(this.map.keys())[i] ?? null;
  }
}
for (const name of ["localStorage", "sessionStorage"]) {
  const store = new MemoryStorage();
  Object.defineProperty(globalThis, name, { configurable: true, value: store });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, name, { configurable: true, value: store });
  }
}

// startAudioShare alerts when no audio track is shared; keep tests quiet.
g.alert = () => {};

// crypto.randomUUID fallback (the join flow mints a per-room token).
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      ...globalThis.crypto,
      randomUUID: () => `uuid-${Math.random().toString(36).slice(2)}`,
    },
  });
}
