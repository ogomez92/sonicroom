// Chat formatting + client-side spam guard. The format string here is the
// single source of truth for how a message reads in BOTH the visible list and
// the ARIA announcement, so they never drift apart.
import { chat_announcement, chat_just_now, chat_joined, chat_left } from "../paraglide/messages.js";
import { getLocale } from "./i18n";

export const CHAT_RATE_LIMIT = 5; // messages...
export const CHAT_RATE_WINDOW_MS = 10_000; // ...per this window (mirrors server)
export const CHAT_TEXT_MAX = 2000;

// Separates a message from its trailing metadata (the "sent 2 minutes ago"
// time). A spaced em-dash so the two never run together when the text has no
// end punctuation — visually and as a pause for screen readers. Used by both
// the visible list and the ARIA strings, so they stay in lockstep.
export const META_SEP = " — ";

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  ts: number; // epoch ms
  // Room events rendered inline in the chat list. Absent = a normal chat
  // message; "join"/"leave" use `sender` as the participant name and ignore
  // text; "system" carries an already-localized event line in `text` (the
  // announcement, snapshotted in the locale active when it happened) and
  // ignores sender.
  kind?: "join" | "leave" | "system";
  // "system" only: the locale `text` was written in. The UI language can change
  // mid-call, so an older event line may no longer match <html lang>; renderers
  // tag it with this so a screen reader reads it with the right voice.
  lang?: string;
}

// One RelativeTimeFormat per active locale (constructing them isn't free, and
// the locale can change at runtime via the language picker).
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
function rtf(): Intl.RelativeTimeFormat {
  const locale = getLocale();
  let f = rtfCache.get(locale);
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    rtfCache.set(locale, f);
  }
  return f;
}

// "just now" / "5 minutes ago" / "2 hours ago" / "3 days ago", localized. Past
// timestamps yield "… ago"; the rare clock-skewed future yields "in …".
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diffSec = Math.round((ts - now) / 1000); // negative = in the past
  if (Math.abs(diffSec) < 30) return chat_just_now();
  const mins = Math.round(diffSec / 60);
  if (Math.abs(mins) < 60) return rtf().format(mins, "minute");
  const hours = Math.round(diffSec / 3600);
  if (Math.abs(hours) < 24) return rtf().format(hours, "hour");
  return rtf().format(Math.round(diffSec / 86400), "day");
}

// What "copy this message" puts on the clipboard: the message body only — no
// "sender:" prefix, no trailing "sent …" time. Event rows copy their localized
// line (join/leave/system text). Shared by the chat panel's Ctrl+C and the
// Alt+number double-press copy, so both copy exactly the same thing.
export function messageContent(msg: ChatMessage): string {
  if (msg.kind === "join") return chat_joined({ name: msg.sender });
  if (msg.kind === "leave") return chat_left({ name: msg.sender });
  return msg.text;
}

// e.g. "Alice: see you in 5 sent 2 minutes ago" — used verbatim by the message
// list and the screen-reader announcement, so both stay in lockstep. Presence
// events read as "Alice joined 2 minutes ago".
export function formatMessage(msg: ChatMessage, now: number = Date.now()): string {
  const time = relativeTime(msg.ts, now);
  if (msg.kind === "join") return `${chat_joined({ name: msg.sender })}${META_SEP}${time}`;
  if (msg.kind === "leave") return `${chat_left({ name: msg.sender })}${META_SEP}${time}`;
  if (msg.kind === "system") return `${msg.text}${META_SEP}${time}`;
  return chat_announcement({ sender: msg.sender, text: msg.text, time });
}

// Single-sender sliding-window limiter for instant local feedback (the server
// enforces the same budget authoritatively). Blocked attempts don't count, so
// the sender recovers once the window clears — matching the server.
export class RateLimiter {
  private hits: number[] = [];

  constructor(
    private readonly limit = CHAT_RATE_LIMIT,
    private readonly windowMs = CHAT_RATE_WINDOW_MS,
  ) {}

  tryConsume(now: number = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}
