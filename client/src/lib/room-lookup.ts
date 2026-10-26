import { apiUrl } from "./runtime-config";

// What the lobby needs to know about the room name in its field, from
// `GET /api/rooms/:name` (which answers for private rooms too — count only).
export interface RoomStatus {
  // The (canonical, lowercase) name this answer is FOR — the lobby keeps the
  // last answer on screen while the next lookup is in flight, so every reader
  // has to check it still matches what's typed.
  name: string;
  // Live right now, i.e. someone is inside.
  exists: boolean;
  // The name is held for a host (reservations): it opens only with the host key.
  reserved: boolean;
  isVideo: boolean;
}

// One lookup. `null` = no answer (network error, non-JSON, a name the server
// rejects) — the caller keeps whatever it already knew rather than guessing.
// A 404 is a real answer ("nobody is in a room by that name"), and carries
// `reserved` like the 200 does.
export async function fetchRoomStatus(
  name: string,
  signal?: AbortSignal,
): Promise<RoomStatus | null> {
  try {
    const res = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(name)}`), { signal });
    if (res.status !== 200 && res.status !== 404) return null;
    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data.exists !== "boolean") return null;
    return {
      name,
      exists: data.exists,
      reserved: data.reserved === true,
      isVideo: data.isVideo === true,
    };
  } catch {
    return null;
  }
}

// Which parts of the lobby form apply to this room name.
//  - "create": nobody is there — you'd be creating it, so every room option
//    is yours to set.
//  - "join": the room is live — its type, P2P pin, public flag and admin policy
//    were settled by whoever created it, so only your own settings are shown.
//  - "reserved-wait": held for a host and not open yet, and this tab doesn't
//    hold the host key — you'll wait, and nothing here is yours to choose.
//  - "reserved-host": this tab holds the host key for a reserved room that
//    isn't open yet — you open it (type / P2P / public are yours), but the
//    admin policy comes from the reservation, so that fieldset is dropped.
export type LobbyMode = "create" | "join" | "reserved-wait" | "reserved-host";

export function lobbyMode(status: RoomStatus | null, hasHostKey: boolean): LobbyMode {
  if (!status) return "create";
  if (status.exists) return "join";
  if (status.reserved) return hasHostKey ? "reserved-host" : "reserved-wait";
  return "create";
}

// The room-level options (type, P2P, public) are creation-time choices — but
// all three are STICKY server-side and settable by any joiner, so when they're
// hidden they must not be sent either, or a stale tick would flip someone
// else's room.
export function showsRoomOptions(mode: LobbyMode): boolean {
  return mode === "create" || mode === "reserved-host";
}

// The host key Room.tsx stashed for this room (from the `?host=` link).
export function hasStoredHostKey(roomName: string): boolean {
  try {
    return !!sessionStorage.getItem(`sonicroom:hostKey:${roomName}`);
  } catch {
    return false;
  }
}
