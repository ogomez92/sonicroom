import { useState, useCallback, useRef, useEffect, type SyntheticEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Headphones, ArrowRight, Globe, DoorOpen } from "lucide-react";
import { MicPreview } from "./MicPreview";
import { LanguageSelect } from "./LanguageSelect";
import { Footer } from "./Footer";
import { getLocale } from "../lib/i18n";
import { getInstanceName } from "../lib/branding";
import { m } from "../paraglide/messages.js";

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "");
}

// `?p2p=off` (also accepts false/0/no/disable/disabled) means P2P is disabled —
// used to seed the checkbox from a shared link.
function isP2pDisabled(value: string | null): boolean {
  if (value == null) return false;
  return ["off", "false", "0", "no", "disable", "disabled"].includes(value.toLowerCase());
}

// `?public=true` (also accepts 1/yes/on/enable/enabled/public) pre-ticks the
// "Make this room public" toggle from a shared link.
function isPublicEnabled(value: string | null): boolean {
  if (value == null) return false;
  return ["true", "1", "yes", "on", "enable", "enabled", "public"].includes(value.toLowerCase());
}

// `?mic=off` (also accepts false/0/no/disable/disabled) pre-ticks the "Join
// without a microphone" toggle from a shared link.
function isMicDisabled(value: string | null): boolean {
  if (value == null) return false;
  return ["off", "false", "0", "no", "disable", "disabled"].includes(value.toLowerCase());
}

interface PublicRoom {
  name: string;
  participants: string[];
}

// Poll the public room directory so the lobby list stays fresh — the visitor
// isn't on a socket yet, so there's no push channel.
const PUBLIC_ROOMS_POLL_MS = 5000;

export function Lobby() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillRoom = searchParams.get("room") || "";
  const [roomName, setRoomName] = useState(sanitize(prefillRoom));
  const [displayName, setDisplayName] = useState("");
  const [disableP2p, setDisableP2p] = useState(() => isP2pDisabled(searchParams.get("p2p")));
  const [makePublic, setMakePublic] = useState(() => isPublicEnabled(searchParams.get("public")));
  const [joinWithoutMic, setJoinWithoutMic] = useState(() =>
    isMicDisabled(searchParams.get("mic")),
  );
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  // Roving active option in the public-room listbox (-1 = none yet), mirroring
  // the chat message list's keyboard model. Tracked by index and clamped as the
  // polled list changes.
  const [activeRoomIdx, setActiveRoomIdx] = useState(-1);
  // Lobby's own SR live region (room-selected confirmation). `announceSeq`
  // changes on every announce so React re-renders even when the text repeats.
  const [announcement, setAnnouncement] = useState("");
  const [announceSeq, setAnnounceSeq] = useState(0);
  const roomInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const roomOptionRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  useEffect(() => {
    if (prefillRoom) {
      nameInputRef.current?.focus();
    } else {
      roomInputRef.current?.focus();
    }
  }, [prefillRoom]);

  // Reflect this instance's name in the tab title on the lobby (the Room sets
  // its own "<room> · <instance>" title). Keeps it in sync after the Room's
  // cleanup and on SPA navigation back here.
  useEffect(() => {
    document.title = getInstanceName();
  }, []);

  // Fetch the public room directory on mount and poll it. Failures are ignored
  // (the list just stays empty/stale); the cleanup flag avoids a late setState.
  useEffect(() => {
    let active = true;
    const fetchRooms = async () => {
      try {
        const res = await fetch("/api/public-rooms");
        if (!res.ok) return;
        const data = (await res.json()) as { rooms?: PublicRoom[] };
        if (active && Array.isArray(data.rooms)) setPublicRooms(data.rooms);
      } catch {
        // Network/JSON error — leave the current list untouched.
      }
    };
    void fetchRooms();
    const id = setInterval(fetchRooms, PUBLIC_ROOMS_POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const [error, setError] = useState("");

  // Picking a public room fills the name field, announces the choice, and drops
  // focus back on the display-name field so the visitor just types their name.
  // The room is already public (it's in the list), so tick the box to reflect
  // that — and note that even if the visitor unticks it, the room stays public:
  // the server's isPublic flag is sticky and never downgraded for an existing
  // room (joining a same-named room can only ever keep/turn it public).
  const selectPublicRoom = useCallback((name: string) => {
    setRoomName(name);
    setMakePublic(true);
    setError("");
    setAnnouncement(m.lobby_public_room_selected({ name }));
    setAnnounceSeq((s) => s + 1);
    nameInputRef.current?.focus();
  }, []);

  // Keep the active option valid as the polled list grows/shrinks.
  useEffect(() => {
    setActiveRoomIdx((i) => (i < 0 ? -1 : Math.min(i, publicRooms.length - 1)));
  }, [publicRooms.length]);

  // Keep the active option scrolled into view while arrowing through the list.
  useEffect(() => {
    if (activeRoomIdx >= 0 && publicRooms[activeRoomIdx]) {
      roomOptionRefs.current
        .get(publicRooms[activeRoomIdx].name)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [activeRoomIdx, publicRooms]);

  // Listbox keyboard model, same as the chat message list: arrow/Home/End move
  // the active option; Enter or Space picks it (Space is also swallowed so it
  // doesn't scroll the page).
  const onRoomListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (publicRooms.length === 0) return;
    const last = publicRooms.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveRoomIdx((i) => Math.min((i < 0 ? -1 : i) + 1, last));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveRoomIdx((i) => Math.max((i < 0 ? publicRooms.length : i) - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActiveRoomIdx(0);
        break;
      case "End":
        e.preventDefault();
        setActiveRoomIdx(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeRoomIdx >= 0 && publicRooms[activeRoomIdx]) {
          selectPublicRoom(publicRooms[activeRoomIdx].name);
        }
        break;
    }
  };

  const handleJoin = useCallback(
    (e?: SyntheticEvent) => {
      e?.preventDefault();
      const sanitizedRoom = sanitize(roomName.trim());
      const trimmedName = displayName.trim().replace(/[<>"'&]/g, "");

      if (!sanitizedRoom) {
        setError(m.lobby_error_room_required());
        return;
      }
      if (sanitizedRoom.length > 64) {
        setError(m.lobby_error_room_too_long());
        return;
      }
      if (!trimmedName) {
        setError(m.lobby_error_name_required());
        return;
      }
      if (trimmedName.length > 256) {
        setError(m.lobby_error_name_too_long());
        return;
      }

      // Store display name for the Room component
      sessionStorage.setItem("sonicroom:displayName", trimmedName);
      // Carry the room options into the room URL: `?p2p=off` pins the SFU and
      // `?public=true` lists the room in the lobby's public directory.
      const params = new URLSearchParams();
      if (disableP2p) params.set("p2p", "off");
      if (makePublic) params.set("public", "true");
      // Listen + text-chat only — no mic prompt (see Room's ?mic=off handling).
      if (joinWithoutMic) params.set("mic", "off");
      const qs = params.toString();
      navigate(`/room/${sanitizedRoom}${qs ? `?${qs}` : ""}`);
    },
    [roomName, displayName, navigate, disableP2p, makePublic, joinWithoutMic],
  );

  // Localized participant list ("a, b and c"), so the public room rows read
  // naturally per language. Recreated on each render; cheap and locale-aware.
  const listFmt = new Intl.ListFormat(getLocale(), { style: "long", type: "conjunction" });

  // The listbox's active option id (for aria-activedescendant), or undefined.
  const activeRoomId =
    activeRoomIdx >= 0 && publicRooms[activeRoomIdx]
      ? `public-room-opt-${publicRooms[activeRoomIdx].name}`
      : undefined;

  return (
    <div className="flex min-h-dvh flex-col bg-sonic-900">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-sonic-600 bg-sonic-800 p-8 shadow-2xl">
          <div className="mb-2 flex justify-end">
            <LanguageSelect />
          </div>
          <div className="mb-8 flex items-center justify-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-sonic-accent/20">
              <Headphones className="h-6 w-6 text-sonic-accent" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-sonic-100">
              {getInstanceName()}
            </h1>
          </div>

          <p className="mb-6 text-center text-sm text-sonic-300">{m.lobby_tagline()}</p>

          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label
                htmlFor="room-name"
                className="mb-1.5 block text-sm font-medium text-sonic-200"
              >
                {m.lobby_room_name_label()}
              </label>
              <input
                ref={roomInputRef}
                id="room-name"
                type="text"
                value={roomName}
                onChange={(e) => {
                  setRoomName(e.target.value);
                  setError("");
                }}
                placeholder={m.lobby_room_name_placeholder()}
                maxLength={64}
                className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-4 py-2.5 text-sonic-100 placeholder-sonic-400 transition-colors focus:border-sonic-accent focus:outline-none"
                autoComplete="off"
                aria-describedby={error ? "lobby-error" : undefined}
              />
            </div>

            <div>
              <label
                htmlFor="display-name"
                className="mb-1.5 block text-sm font-medium text-sonic-200"
              >
                {m.lobby_display_name_label()}
              </label>
              <input
                ref={nameInputRef}
                id="display-name"
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setError("");
                }}
                placeholder={m.lobby_display_name_placeholder()}
                maxLength={256}
                className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-4 py-2.5 text-sonic-100 placeholder-sonic-400 transition-colors focus:border-sonic-accent focus:outline-none"
                autoComplete="off"
              />
            </div>

            {/* Public room directory — only shown when at least one public room is
              live. A listbox with the same keyboard model as the chat message
              list: it's a single focus stop; arrow keys / Home / End move the
              active option, and Enter, Space or a click picks it (fills the room
              name above, then moves focus to the display-name field). */}
            {publicRooms.length > 0 && (
              <div>
                <h2
                  id="public-rooms-heading"
                  className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-sonic-200"
                >
                  <Globe className="h-4 w-4 text-sonic-accent" aria-hidden="true" />
                  {m.lobby_public_rooms_label()}
                </h2>
                <ul
                  role="listbox"
                  tabIndex={0}
                  aria-labelledby="public-rooms-heading"
                  aria-activedescendant={activeRoomId}
                  onKeyDown={onRoomListKeyDown}
                  onFocus={() => setActiveRoomIdx((i) => (i < 0 ? 0 : i))}
                  className="max-h-44 space-y-1.5 overflow-y-auto rounded-lg pr-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-sonic-accent/60"
                >
                  {publicRooms.map((room, i) => {
                    const participantsText = listFmt.format(room.participants);
                    const label =
                      room.participants.length > 0
                        ? m.lobby_public_room_with_participants({
                            name: room.name,
                            participants: participantsText,
                          })
                        : m.lobby_public_room_empty({ name: room.name });
                    return (
                      <li
                        key={room.name}
                        id={`public-room-opt-${room.name}`}
                        role="option"
                        aria-selected={i === activeRoomIdx}
                        aria-label={label}
                        ref={(el) => {
                          if (el) roomOptionRefs.current.set(room.name, el);
                          else roomOptionRefs.current.delete(room.name);
                        }}
                        onClick={() => selectPublicRoom(room.name)}
                        className={`group flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                          i === activeRoomIdx
                            ? "border-sonic-accent bg-sonic-accent/15"
                            : "border-sonic-600 bg-sonic-700/40 hover:border-sonic-accent hover:bg-sonic-700"
                        }`}
                      >
                        <DoorOpen
                          className="mt-0.5 h-4 w-4 shrink-0 text-sonic-accent transition-transform group-hover:scale-110"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-sonic-100">
                            {room.name}
                          </span>
                          {participantsText && (
                            <span className="block truncate text-xs text-sonic-400">
                              {participantsText}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <MicPreview />

            <label className="flex cursor-pointer select-none items-start gap-2.5">
              <input
                type="checkbox"
                checked={disableP2p}
                onChange={(e) => setDisableP2p(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
              />
              <span className="text-sm font-medium text-sonic-200">
                {m.lobby_disable_p2p()}
                <span className="mt-0.5 block text-xs font-normal text-sonic-400">
                  {m.lobby_disable_p2p_help()}
                </span>
              </span>
            </label>

            <div>
              <label className="flex cursor-pointer select-none items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={makePublic}
                  onChange={(e) => setMakePublic(e.target.checked)}
                  aria-describedby="make-public-sticky"
                  className="mt-0.5 h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
                />
                <span className="text-sm font-medium text-sonic-200">
                  {m.lobby_make_public()}
                  <span className="mt-0.5 block text-xs font-normal text-sonic-400">
                    {m.lobby_make_public_help()}
                  </span>
                </span>
              </label>
              {/* Sticky-behaviour note (mirrors the selectPublicRoom comment):
                once any joiner makes a room public it stays public for its
                session — unticking this can't un-public an existing room.
                Visible to everyone, and a described-by sibling of the label so
                screen readers get it as a description rather than folding it
                into the checkbox's accessible name. Indented to line up under
                the label text (checkbox 16px + gap 10px). */}
              <p id="make-public-sticky" className="mt-1 pl-[26px] text-xs italic text-sonic-400">
                {m.lobby_make_public_sticky()}
              </p>
            </div>

            {/* Join without a microphone — for people who have no mic or can't /
                won't speak. They listen and use text chat only; no mic prompt is
                shown. (A missing or denied mic also falls back to this mode.) */}
            <label className="flex cursor-pointer select-none items-start gap-2.5">
              <input
                type="checkbox"
                checked={joinWithoutMic}
                onChange={(e) => setJoinWithoutMic(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
              />
              <span className="text-sm font-medium text-sonic-200">
                {m.lobby_join_without_mic()}
                <span className="mt-0.5 block text-xs font-normal text-sonic-400">
                  {m.lobby_join_without_mic_help()}
                </span>
              </span>
            </label>

            {error && (
              <p id="lobby-error" className="text-sm text-muted" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-sonic-accent px-4 py-2.5 font-medium text-white transition-all hover:bg-sonic-accent/90 hover:shadow-lg hover:shadow-sonic-accent/25 active:scale-[0.98]"
            >
              {m.lobby_join_room()}
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          <div className="mt-6 text-center text-xs text-sonic-400">
            <kbd className="rounded border border-sonic-600 bg-sonic-700 px-1.5 py-0.5 font-mono text-sonic-300">
              M
            </kbd>{" "}
            {m.lobby_toggle_mute_hint()}
          </div>
        </div>
      </div>

      {/* Screen-reader live region — announces the room picked from the public
          list. key changes per announcement so identical text re-announces. */}
      <div aria-live="polite" role="status" className="sr-only">
        <span key={announceSeq}>{announcement}</span>
      </div>

      <Footer />
    </div>
  );
}
