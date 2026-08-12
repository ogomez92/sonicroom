import type { Room } from "./room-manager.js";

// Shared per-room notes backed by a NoteLab instance (accessible realtime
// collaborative markdown — https://notelab.gomsen.com). The in-call "Notes"
// button / Alt+N creates ONE collaborative note the first time anyone in a room
// asks for it; everyone else then opens that same note for the room's lifetime.
// The URL is stored on the Room (see room-manager) so it dies with the room —
// no persistence, no note keyed to a room name across sessions.
//
// Configured by NOTELAB_URL in .env (operator-only, hidden from the UI like the
// NOTY_* target). Unset disables the feature: notesEnabled() is false, the
// client hides the button, and open-notes returns `notes_disabled`.

// Trailing slashes stripped so `${base}/n/${token}` is always well-formed.
function notesBase(): string | null {
  const raw = process.env.NOTELAB_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

export function notesEnabled(): boolean {
  return notesBase() !== null;
}

// POST /api/notes on the NoteLab instance -> { editToken, readToken }. We build
// the EDIT link (`/n/<editToken>`) and hand it to everyone, so the whole room
// can co-write the note (not read-only). A short timeout keeps a hung/unreachable
// NoteLab from stalling the ack.
async function createNote(base: string): Promise<string> {
  const res = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`NoteLab responded ${res.status}`);
  const data = (await res.json()) as { editToken?: string };
  if (!data.editToken) throw new Error("NoteLab returned no edit token");
  return `${base}/n/${data.editToken}`;
}

// In-flight creations, keyed by the room object, so two people hitting the
// button at the same instant share ONE note instead of racing to create two.
const inFlight = new WeakMap<Room, Promise<string>>();

// Resolve the room's note URL, creating it on first request. `created` is true
// only for the caller that actually minted the note (not those that found an
// existing one or joined an in-flight creation), so the handler broadcasts and
// announces the new note exactly once.
export async function getOrCreateRoomNote(room: Room): Promise<{ url: string; created: boolean }> {
  if (room.notesUrl) return { url: room.notesUrl, created: false };

  const pending = inFlight.get(room);
  if (pending) return pending.then((url) => ({ url, created: false }));

  const base = notesBase();
  if (!base) throw new Error("notes_disabled");

  const p = createNote(base)
    .then((url) => {
      room.notesUrl = url;
      return url;
    })
    .finally(() => inFlight.delete(room));
  inFlight.set(room, p);
  return p.then((url) => ({ url, created: true }));
}
