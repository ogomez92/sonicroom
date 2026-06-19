// System text-to-speech for chat + room announcements. This is an OPT-IN
// alternative to the ARIA live regions: a user who does NOT run a screen reader
// (so the live regions are never spoken) can still have incoming chat and room
// events read aloud by the browser's built-in speech synthesis. Screen-reader
// users should leave it on the polite/assertive live-region modes instead —
// running both at once would double every message.
//
// Deliberately tiny and best-effort: if SpeechSynthesis is unavailable or
// throws, it's a no-op (the message is still in the chat list + live regions).

let warmed = false;

// Some engines (notably Chrome) drop the very first utterance unless the voice
// list has been touched at least once. Calling getVoices() in a prior user
// gesture primes it; harmless everywhere else.
export function warmUpTts(): void {
  if (warmed) return;
  warmed = true;
  try {
    window.speechSynthesis?.getVoices();
  } catch {
    /* speech synthesis unavailable — ignore */
  }
}

// The voices the browser/OS offers, for the voice picker. May be empty until
// the engine has loaded them — callers should also listen for `voiceschanged`.
export function getVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  try {
    return window.speechSynthesis.getVoices();
  } catch {
    return [];
  }
}

export interface SpeakOptions {
  // The UI language — steers the default voice when no specific voice is chosen.
  lang?: string;
  // The user's chosen voice; wins over `lang` when it matches an installed one.
  voiceURI?: string;
  // SpeechSynthesisUtterance rate (≈0.1–10, 1 = normal) and pitch (0–2, 1 =
  // normal). Out-of-range values are clamped by the platform.
  rate?: number;
  pitch?: number;
  // Cancel any queued/ongoing speech first — used for previews so repeated
  // presses don't stack behind each other.
  interrupt?: boolean;
}

// Speak `text` with the given options.
export function speak(text: string, opts: SpeakOptions = {}): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    if (opts.interrupt) window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(trimmed);
    const voice = opts.voiceURI
      ? window.speechSynthesis.getVoices().find((v) => v.voiceURI === opts.voiceURI)
      : undefined;
    if (voice) {
      // A chosen voice carries its own language — let it pick pronunciation.
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else if (opts.lang) {
      // No (or unavailable) chosen voice: match the UI language so the right
      // default voice/pronunciation is picked.
      utterance.lang = opts.lang;
    }
    if (typeof opts.rate === "number") utterance.rate = opts.rate;
    if (typeof opts.pitch === "number") utterance.pitch = opts.pitch;
    // Queue messages rather than cancelling: in a lively chat you want to hear
    // each line, not just the latest. (A runaway backlog is the user's cue to
    // switch the mode to a live region or Off.)
    window.speechSynthesis.speak(utterance);
  } catch {
    /* construction/speak failed — ignore, the message is still shown + in the live region */
  }
}
