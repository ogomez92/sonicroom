import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { speak } from "./tts";

// `window.speechSynthesis` is installed (configurable) by the global test setup.
// Each test swaps in its own fake and restores the original afterwards.
let originalDescriptor: PropertyDescriptor | undefined;

function setSpeechSynthesis(value: unknown) {
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value });
}

beforeEach(() => {
  originalDescriptor = Object.getOwnPropertyDescriptor(window, "speechSynthesis");
});

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(window, "speechSynthesis", originalDescriptor);
  } else {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("warmUpTts", () => {
  it("calls getVoices once and is idempotent", async () => {
    vi.resetModules();
    const getVoices = vi.fn(() => []);
    setSpeechSynthesis({ getVoices, speak: vi.fn() });
    const { warmUpTts } = await import("./tts");

    warmUpTts();
    warmUpTts();
    warmUpTts();

    expect(getVoices).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (no throw) when speechSynthesis is undefined", async () => {
    vi.resetModules();
    setSpeechSynthesis(undefined);
    const { warmUpTts } = await import("./tts");
    expect(() => warmUpTts()).not.toThrow();
  });

  it("swallows errors thrown by getVoices", async () => {
    vi.resetModules();
    const getVoices = vi.fn(() => {
      throw new Error("voices unavailable");
    });
    setSpeechSynthesis({ getVoices, speak: vi.fn() });
    const { warmUpTts } = await import("./tts");
    expect(() => warmUpTts()).not.toThrow();
    expect(getVoices).toHaveBeenCalledTimes(1);
  });

  it("stays warmed even if the first call hit no synthesis", async () => {
    vi.resetModules();
    setSpeechSynthesis(undefined);
    const mod = await import("./tts");
    mod.warmUpTts(); // marks warmed, getVoices never reachable

    // Now provide a synthesis: a second call must NOT touch it (already warmed).
    const getVoices = vi.fn(() => []);
    setSpeechSynthesis({ getVoices, speak: vi.fn() });
    mod.warmUpTts();
    expect(getVoices).not.toHaveBeenCalled();
  });
});

describe("speak", () => {
  it("constructs an utterance and queues it via speechSynthesis.speak", () => {
    const speakSpy = vi.fn();
    setSpeechSynthesis({ getVoices: vi.fn(() => []), speak: speakSpy });

    speak("hello world");

    expect(speakSpy).toHaveBeenCalledTimes(1);
    const utterance = speakSpy.mock.calls[0][0];
    expect(utterance).toBeInstanceOf(SpeechSynthesisUtterance);
    expect(utterance.text).toBe("hello world");
  });

  it("sets the utterance lang when provided", () => {
    const speakSpy = vi.fn();
    setSpeechSynthesis({ getVoices: vi.fn(() => []), speak: speakSpy });

    speak("hola", "es");

    const utterance = speakSpy.mock.calls[0][0];
    expect(utterance.lang).toBe("es");
  });

  it("leaves lang unset when none is provided", () => {
    const speakSpy = vi.fn();
    setSpeechSynthesis({ getVoices: vi.fn(() => []), speak: speakSpy });

    speak("plain");

    const utterance = speakSpy.mock.calls[0][0];
    expect(utterance.lang).toBe(""); // FakeSpeechSynthesisUtterance default
  });

  it("trims surrounding whitespace before speaking", () => {
    const speakSpy = vi.fn();
    setSpeechSynthesis({ getVoices: vi.fn(() => []), speak: speakSpy });

    speak("   spaced   ");

    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(speakSpy.mock.calls[0][0].text).toBe("spaced");
  });

  it("skips empty text without calling speak", () => {
    const speakSpy = vi.fn();
    setSpeechSynthesis({ getVoices: vi.fn(() => []), speak: speakSpy });

    speak("");

    expect(speakSpy).not.toHaveBeenCalled();
  });

  it("skips whitespace-only text without calling speak", () => {
    const speakSpy = vi.fn();
    setSpeechSynthesis({ getVoices: vi.fn(() => []), speak: speakSpy });

    speak("   \n\t  ");

    expect(speakSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when speechSynthesis is absent from window", () => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    expect("speechSynthesis" in window).toBe(false);
    expect(() => speak("hi")).not.toThrow();
  });

  it("swallows errors thrown by speak", () => {
    const speakSpy = vi.fn(() => {
      throw new Error("synthesis boom");
    });
    setSpeechSynthesis({ getVoices: vi.fn(() => []), speak: speakSpy });

    expect(() => speak("boom")).not.toThrow();
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows errors thrown while constructing the utterance", () => {
    const speakSpy = vi.fn();
    setSpeechSynthesis({ getVoices: vi.fn(() => []), speak: speakSpy });

    const OriginalUtterance = globalThis.SpeechSynthesisUtterance;
    try {
      // Replace the constructor with one that throws.
      (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
        class {
          constructor() {
            throw new Error("cannot construct");
          }
        };
      expect(() => speak("text")).not.toThrow();
      expect(speakSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
        OriginalUtterance;
    }
  });
});
