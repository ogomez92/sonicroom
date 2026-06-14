// System text-to-speech for chat announcements. This is an OPT-IN alternative
// to the ARIA live regions: a user who does NOT run a screen reader (so the
// live regions are never spoken) can still have incoming/outgoing chat read
// aloud by the browser's built-in speech synthesis. Screen-reader users should
// leave it on the polite/assertive live-region modes instead — running both at
// once would double every message.
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

export function speak(text: string, lang?: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    const utterance = new SpeechSynthesisUtterance(trimmed);
    // Match the UI language so the right voice/pronunciation is picked.
    if (lang) utterance.lang = lang;
    // Queue messages rather than cancelling: in a lively chat you want to hear
    // each line, not just the latest. (A runaway backlog is the user's cue to
    // switch the mode to a live region or Off.)
    window.speechSynthesis.speak(utterance);
  } catch {
    /* construction/speak failed — ignore, the message is still shown + in the live region */
  }
}
