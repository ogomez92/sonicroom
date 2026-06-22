// Pure, side-effect-free chat helpers for the socket path. Kept here (mirroring
// recording-util.ts) so the spam logic is unit-testable without sockets or
// timers — callers always pass `now`.

export const CHAT_RATE_LIMIT = 5; // messages...
export const CHAT_RATE_WINDOW_MS = 10_000; // ...per this window
export const CHAT_TEXT_MAX = 2000; // max chars in a single message
export const CHAT_HISTORY_MAX = 100; // messages retained per room for late joiners

export interface ChatMessage {
  id: string;
  // Display name of whoever sent it (a peer, or an API caller's `sender`).
  sender: string;
  // The message body.
  text: string;
  // Epoch ms when the server accepted it (clients render this relative).
  ts: number;
}

// Sliding-window rate limiter keyed by an arbitrary string (a socket id).
// Blocked attempts deliberately do NOT count against the window — once 10s pass
// since the 5 accepted sends, the sender is free again. Deterministic: the
// caller passes `now`, so it's testable without real time.
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit = CHAT_RATE_LIMIT,
    private readonly windowMs = CHAT_RATE_WINDOW_MS,
  ) {}

  // Returns true and records the hit if within the limit; false if the sender
  // has already used up its budget in the current window (nothing recorded).
  tryConsume(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent); // keep the pruned window; reject the send
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  // Drop a key's history (call when a socket disconnects to avoid leaks).
  forget(key: string): void {
    this.hits.delete(key);
  }
}
