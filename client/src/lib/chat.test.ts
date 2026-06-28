import { describe, it, expect } from "vitest";
import {
  relativeTime,
  messageContent,
  formatMessage,
  RateLimiter,
  META_SEP,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_MS,
  CHAT_TEXT_MAX,
  type ChatMessage,
} from "./chat";
import { chat_joined, chat_left, chat_announcement, chat_just_now } from "../paraglide/messages.js";
import { getLocale } from "./i18n";

// Build the same RelativeTimeFormat the module uses, in the currently-active
// locale (resolves to "en" in the test env). Asserting against its output rather
// than hardcoded English keeps these tests locale-robust.
const fmt = (n: number, unit: Intl.RelativeTimeFormatUnit) =>
  new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" }).format(n, unit);

const NOW = 1_700_000_000_000; // fixed clock so every case is deterministic.

describe("relativeTime", () => {
  it('reads "just now" within ±30s of now', () => {
    expect(relativeTime(NOW, NOW)).toBe(chat_just_now());
    expect(relativeTime(NOW - 29_000, NOW)).toBe(chat_just_now()); // 29s in the past
    expect(relativeTime(NOW + 29_000, NOW)).toBe(chat_just_now()); // 29s skew ahead
  });

  it("leaves the just-now window at exactly 30s", () => {
    // diffSec rounds to ±30 → no longer < 30, so it falls through to minutes.
    expect(relativeTime(NOW - 30_000, NOW)).not.toBe(chat_just_now());
    expect(relativeTime(NOW + 30_000, NOW)).not.toBe(chat_just_now());
  });

  it("formats minutes in the past and the clock-skew future", () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe(fmt(-5, "minute"));
    expect(relativeTime(NOW + 5 * 60_000, NOW)).toBe(fmt(5, "minute"));
  });

  it("formats hours past and future", () => {
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe(fmt(-2, "hour"));
    expect(relativeTime(NOW + 2 * 3_600_000, NOW)).toBe(fmt(2, "hour"));
  });

  it("formats days past and future", () => {
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe(fmt(-3, "day"));
    expect(relativeTime(NOW + 3 * 86_400_000, NOW)).toBe(fmt(3, "day"));
  });
});

describe("messageContent", () => {
  it("renders a join row as the localized join line", () => {
    const msg: ChatMessage = { id: "1", sender: "Alice", text: "", ts: NOW, kind: "join" };
    expect(messageContent(msg)).toBe(chat_joined({ name: "Alice" }));
  });

  it("renders a leave row as the localized left line", () => {
    const msg: ChatMessage = { id: "2", sender: "Bob", text: "", ts: NOW, kind: "leave" };
    expect(messageContent(msg)).toBe(chat_left({ name: "Bob" }));
  });

  it("returns the raw text for a normal message", () => {
    const msg: ChatMessage = { id: "3", sender: "Alice", text: "see you in 5", ts: NOW };
    expect(messageContent(msg)).toBe("see you in 5");
  });

  it("returns the (already-localized) text for a system event", () => {
    const msg: ChatMessage = {
      id: "4",
      sender: "",
      text: "Recording started",
      ts: NOW,
      kind: "system",
    };
    expect(messageContent(msg)).toBe("Recording started");
  });
});

describe("formatMessage", () => {
  it("composes a normal message via chat_announcement", () => {
    const msg: ChatMessage = { id: "1", sender: "Alice", text: "hi", ts: NOW - 5 * 60_000 };
    const time = relativeTime(msg.ts, NOW);
    expect(formatMessage(msg, NOW)).toBe(chat_announcement({ sender: "Alice", text: "hi", time }));
  });

  it("composes a join row as join-line + META_SEP + time", () => {
    const msg: ChatMessage = {
      id: "2",
      sender: "Alice",
      text: "",
      ts: NOW - 5 * 60_000,
      kind: "join",
    };
    const time = relativeTime(msg.ts, NOW);
    expect(formatMessage(msg, NOW)).toBe(`${chat_joined({ name: "Alice" })}${META_SEP}${time}`);
  });

  it("composes a leave row as left-line + META_SEP + time", () => {
    const msg: ChatMessage = {
      id: "3",
      sender: "Bob",
      text: "",
      ts: NOW - 5 * 60_000,
      kind: "leave",
    };
    const time = relativeTime(msg.ts, NOW);
    expect(formatMessage(msg, NOW)).toBe(`${chat_left({ name: "Bob" })}${META_SEP}${time}`);
  });

  it("composes a system row as text + META_SEP + time", () => {
    const msg: ChatMessage = {
      id: "4",
      sender: "",
      text: "Recording started",
      ts: NOW - 5 * 60_000,
      kind: "system",
    };
    const time = relativeTime(msg.ts, NOW);
    expect(formatMessage(msg, NOW)).toBe(`Recording started${META_SEP}${time}`);
  });

  it("uses META_SEP (a spaced em-dash) as the metadata separator", () => {
    expect(META_SEP).toBe(" — ");
    const msg: ChatMessage = { id: "5", sender: "Sys", text: "x", ts: NOW, kind: "system" };
    expect(formatMessage(msg, NOW)).toContain(META_SEP);
  });
});

describe("RateLimiter", () => {
  it("exposes the chat budget constants", () => {
    expect(CHAT_RATE_LIMIT).toBe(5);
    expect(CHAT_RATE_WINDOW_MS).toBe(10_000);
    expect(CHAT_TEXT_MAX).toBe(2000);
  });

  it("allows up to `limit` within the window, then blocks", () => {
    const rl = new RateLimiter(); // default 5 / 10s
    for (let i = 0; i < CHAT_RATE_LIMIT; i++) {
      expect(rl.tryConsume(NOW)).toBe(true);
    }
    expect(rl.tryConsume(NOW)).toBe(false); // 6th in the same window
  });

  it("does not let blocked attempts consume budget", () => {
    const rl = new RateLimiter(1, 100);
    expect(rl.tryConsume(0)).toBe(true); // budget spent
    expect(rl.tryConsume(50)).toBe(false); // blocked — must NOT be recorded
    // If the blocked t=50 had counted, it would still be inside the window at
    // t=120 (120-50 < 100) and block again. It frees because it never counted.
    expect(rl.tryConsume(120)).toBe(true);
  });

  it("frees budget once the window slides forward", () => {
    const rl = new RateLimiter(); // 5 / 10s
    for (let i = 0; i < CHAT_RATE_LIMIT; i++) expect(rl.tryConsume(1_000)).toBe(true);
    expect(rl.tryConsume(1_000)).toBe(false); // full
    expect(rl.tryConsume(10_999)).toBe(false); // 9999ms later — still inside window
    expect(rl.tryConsume(11_000)).toBe(true); // exactly 10s after the first hit
  });

  it("honours a custom (limit, windowMs)", () => {
    const rl = new RateLimiter(2, 1_000);
    expect(rl.tryConsume(0)).toBe(true);
    expect(rl.tryConsume(0)).toBe(true);
    expect(rl.tryConsume(0)).toBe(false); // over the limit of 2
    expect(rl.tryConsume(1_000)).toBe(true); // window (1s) has slid past the first two
  });
});
