import { useState, useCallback, useRef, useEffect, type SyntheticEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Headphones, ArrowRight, Globe, DoorOpen, Video, ShieldCheck } from "lucide-react";
import { MicPreview } from "./MicPreview";
import { LanguageSelect } from "./LanguageSelect";
import { BackgroundPicker } from "./BackgroundPicker";
import { Footer } from "./Footer";
import { getLocale } from "../lib/i18n";
import { getInstanceName, getDefaultDisplayName } from "../lib/branding";
import { apiUrl } from "../lib/runtime-config";
import { iosForcedByUrl } from "../lib/microphone";
import { roomTypeFromParam, type RoomType } from "../lib/video/room-type";
import {
  fetchRoomStatus,
  hasStoredHostKey,
  lobbyMode,
  showsRoomOptions,
  type LobbyMode,
  type RoomStatus,
} from "../lib/room-lookup";
import {
  loadLastPolicy,
  saveRoomPolicy,
  type KickPolicy,
  type ModerationPolicy,
  type Who,
  type WhoNoNobody,
} from "../lib/moderation";
import { m } from "../paraglide/messages.js";

// Room names are case-insensitive; lowercase is the canonical form (the
// server normalizes too — see roomNameSchema), so the link we navigate to is
// already the one everyone else shares.
function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
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
  isVideo?: boolean;
  isModerated?: boolean;
}

// The "who may do it" comboboxes of the admin options, one per policy field.
// `nobody` is only offered where the server accepts it (see moderation-util).
type WhoField =
  | "recording"
  | "shareAudio"
  | "streamAudio"
  | "liveStreaming"
  | "chat"
  | "notes"
  | "mutePeer"
  | "muteAll";
type WhoNoNobodyField = "ducking" | "approveJoins";
const WHO_OPTIONS: readonly Who[] = ["admins", "everyone", "nobody"];
const WHO_NO_NOBODY_OPTIONS: readonly WhoNoNobody[] = ["admins", "everyone"];
const KICK_OPTIONS: readonly KickPolicy[] = [
  "admins",
  "admins_vote",
  "everyone",
  "everyone_vote",
  "nobody",
];

// Poll the public room directory so the lobby list stays fresh — the visitor
// isn't on a socket yet, so there's no push channel.
const PUBLIC_ROOMS_POLL_MS = 5000;

// "Does the room I typed already exist?" — asked once the visitor pauses
// typing, then re-asked while they sit on the form (a room can open or empty
// under them). Exported as an object so tests can shorten the timings.
export const roomLookupTiming = { debounceMs: 400, pollMs: 5000 };

export function Lobby() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillRoom = searchParams.get("room") || "";
  const [roomName, setRoomName] = useState(sanitize(prefillRoom));
  const [displayName, setDisplayName] = useState(getDefaultDisplayName);
  const [disableP2p, setDisableP2p] = useState(() => isP2pDisabled(searchParams.get("p2p")));
  const [makePublic, setMakePublic] = useState(() => isPublicEnabled(searchParams.get("public")));
  const [joinWithoutMic, setJoinWithoutMic] = useState(() =>
    isMicDisabled(searchParams.get("mic")),
  );
  // Room TYPE — audio call is ALWAYS the default; "Video call" must be picked
  // (or carried in by `?video=on` from a shared link). See lib/video/room-type.
  const [roomType, setRoomType] = useState<RoomType>(() =>
    roomTypeFromParam(searchParams.get("video")),
  );
  // "Admin options": create a MODERATED room (you become its admin) with this
  // privilege policy. Off by default; the policy itself starts from the last
  // one this browser used, so a regular host doesn't re-pick every combobox.
  const [moderated, setModerated] = useState(false);
  const [policy, setPolicy] = useState<ModerationPolicy>(loadLastPolicy);
  const setPolicyField = <K extends keyof ModerationPolicy>(key: K, value: ModerationPolicy[K]) =>
    setPolicy((p) => ({ ...p, [key]: value }));
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
  const announce = useCallback((text: string) => {
    setAnnouncement(text);
    setAnnounceSeq((s) => s + 1);
  }, []);

  // What the server says about the name in the field (null = not asked / no
  // answer yet). It decides which half of the form applies: someone JOINING a
  // live room only sees what is theirs to change (name, mic, background in a
  // video room); the room options belong to whoever creates it. The last
  // answer stays up while the next lookup is in flight so the form doesn't
  // flicker on every keystroke — `status.name` says which name it is for.
  const [status, setStatus] = useState<RoomStatus | null>(null);
  const lookupName = sanitize(roomName.trim());
  const mode: LobbyMode = lobbyMode(status, hasStoredHostKey(status?.name ?? ""));
  // Arriving by link (`/?room=…`) we hold the room options back until the
  // first answer, instead of showing the whole form and then yanking most of
  // it away from under a screen reader.
  const awaitingFirstAnswer = status == null && prefillRoom !== "" && lookupName !== "";
  const roomOptionsShown = showsRoomOptions(mode) && !awaitingFirstAnswer;
  // Mirrors for the lookup callbacks, which outlive the render they start in.
  const roomOptionsShownRef = useRef(roomOptionsShown);
  roomOptionsShownRef.current = roomOptionsShown;
  const statusRef = useRef(status);
  statusRef.current = status;

  // Swap in a new answer and SAY what it did to the form. Only a change in
  // what's on screen is announced — plus the first answer for a linked room,
  // which changes nothing visible but tells the visitor what they walked into.
  const applyStatus = useCallback(
    (next: RoomStatus | null) => {
      const wasShown = roomOptionsShownRef.current;
      const first = statusRef.current == null;
      const nextMode = lobbyMode(next, hasStoredHostKey(next?.name ?? ""));
      const willShow = showsRoomOptions(nextMode);
      // Hiding a control that holds focus would drop focus on <body>.
      const focused = document.activeElement;
      const focusLost =
        (!willShow && focused?.closest("[data-room-options]") != null) ||
        (nextMode !== "create" && focused?.closest("[data-admin-options]") != null);
      setStatus(next);
      if (focusLost) nameInputRef.current?.focus();
      const name = next?.name ?? "";
      if (!willShow && (wasShown || first)) {
        const what =
          nextMode === "join"
            ? m.lobby_room_exists_announce({ name })
            : m.lobby_room_reserved_announce({ name });
        announce(wasShown ? `${what} ${m.lobby_room_options_hidden()}` : what);
      } else if (willShow && !wasShown) {
        announce(
          next
            ? `${m.lobby_room_new_announce({ name })} ${m.lobby_room_options_shown()}`
            : m.lobby_room_options_shown(),
        );
      }
    },
    [announce],
  );

  useEffect(() => {
    if (!lookupName) {
      applyStatus(null);
      return;
    }
    let active = true;
    const ctrl = new AbortController();
    const run = async () => {
      const answer = await fetchRoomStatus(lookupName, ctrl.signal);
      if (!active) return;
      if (answer) return applyStatus(answer);
      // No answer (offline, server down). A blip mid-poll keeps what we knew
      // about this name; with nothing known, fall back to the full form rather
      // than leaving a linked visitor stuck on the held-back one.
      if (statusRef.current?.name === lookupName) return;
      applyStatus({
        name: lookupName,
        exists: false,
        reserved: false,
        isVideo: false,
      });
    };
    // The linked room is looked up at once; typing is debounced.
    const delay = lookupName === sanitize(prefillRoom) ? 0 : roomLookupTiming.debounceMs;
    const timer = setTimeout(run, delay);
    const poll = setInterval(run, roomLookupTiming.pollMs);
    return () => {
      active = false;
      ctrl.abort();
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, [lookupName, prefillRoom, applyStatus]);

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
        const res = await fetch(apiUrl("/api/public-rooms"));
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
  const selectPublicRoom = useCallback(
    (name: string, isVideo?: boolean) => {
      setRoomName(name);
      setMakePublic(true);
      // A listed video room is already a video room (sticky server-side) — reflect
      // that so the visitor isn't surprised; it never flips a room the other way.
      if (isVideo) setRoomType("video");
      setError("");
      // A listed room is live by definition, so switch the form to "joining"
      // right away instead of a debounce later (the lookup then just confirms
      // it) — and say so in the same breath as the selection.
      const wasShown = roomOptionsShownRef.current;
      setStatus({ name, exists: true, reserved: false, isVideo: !!isVideo });
      const selected = m.lobby_public_room_selected({ name });
      announce(wasShown ? `${selected} ${m.lobby_room_options_hidden()}` : selected);
      nameInputRef.current?.focus();
    },
    [announce],
  );

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
          const room = publicRooms[activeRoomIdx];
          selectPublicRoom(room.name, room.isVideo);
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
      // Only what was on screen is sent. The room options are hidden when
      // joining a live room, and all of them are sticky server-side for ANY
      // joiner — a leftover tick would otherwise flip someone else's room to
      // public/video. (A lookup still in flight for a just-typed name counts
      // as "creating": the options were visible when Enter was pressed.)
      const joinMode =
        status?.name === sanitizedRoom
          ? lobbyMode(status, hasStoredHostKey(sanitizedRoom))
          : "create";
      const sendRoomOptions = showsRoomOptions(joinMode);
      // Hand the moderated-room policy (or none) to the Room, keyed by room name
      // — the server applies it only if this join actually creates the room.
      saveRoomPolicy(sanitizedRoom, moderated && joinMode === "create" ? policy : null);
      // Carry the room options into the room URL: `?p2p=off` pins the SFU and
      // `?public=true` lists the room in the lobby's public directory.
      const params = new URLSearchParams();
      if (sendRoomOptions && disableP2p) params.set("p2p", "off");
      if (sendRoomOptions && makePublic) params.set("public", "true");
      // Listen + text-chat only — no mic prompt (see Room's ?mic=off handling).
      if (joinWithoutMic) params.set("mic", "off");
      // Video call: only ever set explicitly — audio is the default, so the
      // param is simply absent for an audio room.
      if (sendRoomOptions && roomType === "video") params.set("video", "on");
      // Carry a forced iOS audio path through to the room URL so it survives a
      // reload there. It has no toggle — it's a manual override read at module
      // load in lib/microphone.ts, not lobby state.
      if (iosForcedByUrl) params.set("ios", "on");
      const qs = params.toString();
      navigate(`/room/${sanitizedRoom}${qs ? `?${qs}` : ""}`);
    },
    [
      roomName,
      displayName,
      navigate,
      disableP2p,
      makePublic,
      joinWithoutMic,
      roomType,
      moderated,
      policy,
      status,
    ],
  );

  // Visible explanation of the current form shape, under the room field.
  const roomNote = awaitingFirstAnswer
    ? ""
    : mode === "join"
      ? m.lobby_room_exists_note()
      : mode === "reserved-wait"
        ? m.lobby_room_reserved_note()
        : mode === "reserved-host"
          ? m.lobby_room_reserved_host_note()
          : "";

  // One labelled combobox of the privileges fieldset.
  const whoLabel = (v: string) =>
    v === "admins"
      ? m.lobby_who_admins()
      : v === "everyone"
        ? m.lobby_who_everyone()
        : v === "nobody"
          ? m.lobby_who_nobody()
          : v === "admins_vote"
            ? m.lobby_kick_admins_vote()
            : m.lobby_kick_everyone_vote();
  const whoSelect = (
    key: WhoField | WhoNoNobodyField | "kick",
    label: string,
    options: readonly string[],
    helpId?: string,
  ) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`priv-${key}`} className="text-sm text-sonic-200">
        {label}
      </label>
      <select
        id={`priv-${key}`}
        value={policy[key]}
        onChange={(e) => setPolicyField(key, e.target.value as never)}
        aria-describedby={helpId}
        className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-3 py-2 text-sm text-sonic-100 focus:border-sonic-accent focus:outline-none"
      >
        {options.map((v) => (
          <option key={v} value={v}>
            {whoLabel(v)}
          </option>
        ))}
      </select>
    </div>
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
                name="room-name"
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
                aria-describedby={
                  [error && "lobby-error", roomNote && "room-status-note"]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
              />
              {/* Why the form just got shorter (or lost its admin options) — the
                  visible twin of the live-region announcement, and the room
                  field's description so it's re-read on focus. */}
              {roomNote && (
                <p id="room-status-note" className="mt-1.5 text-xs text-sonic-300">
                  {roomNote}
                </p>
              )}
            </div>

            {/* Room type. A radio group (fieldset/legend) with "Audio call"
                ALWAYS selected by default — SonicRoom is audio-first, and video
                is a deliberate per-room choice (also `?video=on`). Like the
                public flag it's sticky server-side once any joiner sets it. */}
            {roomOptionsShown && (
              <fieldset data-room-options>
                <legend className="mb-1.5 text-sm font-medium text-sonic-200">
                  {m.lobby_room_type_legend()}
                </legend>
                <div className="space-y-2">
                  <div>
                    <label className="flex cursor-pointer select-none items-start gap-2.5">
                      <input
                        type="radio"
                        name="room-type"
                        value="audio"
                        checked={roomType === "audio"}
                        onChange={() => setRoomType("audio")}
                        aria-describedby="room-type-audio-help"
                        className="mt-0.5 h-4 w-4 border-sonic-600 bg-sonic-700 accent-sonic-accent"
                      />
                      <span className="text-sm font-medium text-sonic-200">
                        {m.lobby_room_type_audio()}
                      </span>
                    </label>
                    <p id="room-type-audio-help" className="mt-1 pl-[26px] text-xs text-sonic-400">
                      {m.lobby_room_type_audio_help()}
                    </p>
                  </div>
                  <div>
                    <label className="flex cursor-pointer select-none items-start gap-2.5">
                      <input
                        type="radio"
                        name="room-type"
                        value="video"
                        checked={roomType === "video"}
                        onChange={() => setRoomType("video")}
                        aria-describedby="room-type-video-help"
                        className="mt-0.5 h-4 w-4 border-sonic-600 bg-sonic-700 accent-sonic-accent"
                      />
                      <span className="flex items-center gap-1.5 text-sm font-medium text-sonic-200">
                        <Video className="h-4 w-4 text-sonic-accent" aria-hidden="true" />
                        {m.lobby_room_type_video()}
                      </span>
                    </label>
                    <p id="room-type-video-help" className="mt-1 pl-[26px] text-xs text-sonic-400">
                      {m.lobby_room_type_video_help()}
                    </p>
                  </div>
                </div>
              </fieldset>
            )}

            {/* The camera background is chosen here, before the call, and only
                for a video room — the call window deliberately has no switcher.
                Mounting it under the room-type choice is what makes that read
                as one decision; it also means the picker's thumbnails are only
                ever fetched by someone who actually picked "Video call". Joining
                a live room, the room's own type decides instead — the background
                is one of the few things that IS the joiner's to choose. */}
            {(roomOptionsShown ? roomType === "video" : mode === "join" && status?.isVideo) && (
              <BackgroundPicker />
            )}

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
                name="display-name"
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
                    const baseLabel =
                      room.participants.length > 0
                        ? m.lobby_public_room_with_participants({
                            name: room.name,
                            participants: participantsText,
                          })
                        : m.lobby_public_room_empty({ name: room.name });
                    let label = room.isVideo
                      ? `${baseLabel}, ${m.lobby_public_room_video_fragment()}`
                      : baseLabel;
                    if (room.isModerated) label += `, ${m.lobby_public_room_moderated_fragment()}`;
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
                        onClick={() => selectPublicRoom(room.name, room.isVideo)}
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
                          <span className="flex items-center gap-1.5 truncate text-sm font-medium text-sonic-100">
                            {room.name}
                            {room.isVideo && (
                              <Video
                                className="h-3.5 w-3.5 shrink-0 text-sonic-accent"
                                aria-hidden="true"
                              />
                            )}
                            {room.isModerated && (
                              <ShieldCheck
                                className="h-3.5 w-3.5 shrink-0 text-amber-300"
                                aria-hidden="true"
                              />
                            )}
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

            {/* Each option's longer help text is a described-by sibling of the
              label (id + aria-describedby) rather than nested inside it, so a
              screen reader reads the short title as the checkbox's accessible
              name and the help as a separate description — instead of folding
              the whole paragraph into the name. Indented to line up under the
              label text (checkbox 16px + gap 10px = 26px). */}
            {roomOptionsShown && (
              <div data-room-options>
                <label className="flex cursor-pointer select-none items-start gap-2.5">
                  <input
                    type="checkbox"
                    id="disable-p2p"
                    name="disable-p2p"
                    checked={disableP2p}
                    onChange={(e) => setDisableP2p(e.target.checked)}
                    aria-describedby="disable-p2p-help"
                    className="mt-0.5 h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
                  />
                  <span className="text-sm font-medium text-sonic-200">
                    {m.lobby_disable_p2p()}
                  </span>
                </label>
                <p id="disable-p2p-help" className="mt-1 pl-[26px] text-xs text-sonic-400">
                  {m.lobby_disable_p2p_help()}
                </p>
              </div>
            )}

            {roomOptionsShown && (
              <div data-room-options>
                <label className="flex cursor-pointer select-none items-start gap-2.5">
                  <input
                    type="checkbox"
                    id="make-public"
                    name="make-public"
                    checked={makePublic}
                    onChange={(e) => setMakePublic(e.target.checked)}
                    aria-describedby="make-public-help make-public-sticky"
                    className="mt-0.5 h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
                  />
                  <span className="text-sm font-medium text-sonic-200">
                    {m.lobby_make_public()}
                  </span>
                </label>
                <p id="make-public-help" className="mt-1 pl-[26px] text-xs text-sonic-400">
                  {m.lobby_make_public_help()}
                </p>
                {/* Sticky-behaviour note (mirrors the selectPublicRoom comment):
                once any joiner makes a room public it stays public for its
                session — unticking this can't un-public an existing room. A
                second described-by sibling so screen readers get it as another
                description rather than folding it into the accessible name. */}
                <p id="make-public-sticky" className="mt-1 pl-[26px] text-xs italic text-sonic-400">
                  {m.lobby_make_public_sticky()}
                </p>
              </div>
            )}

            {/* Admin options — creates a MODERATED room: the creator is its
                administrator and this policy (fixed for the room's lifetime)
                says what participants may do. Ticking it unfolds the
                privileges fieldset; the policy is handed to the Room via
                sessionStorage on join (see lib/moderation.ts). Not offered for
                a reserved room: its policy comes from the reservation. */}
            {roomOptionsShown && mode === "create" && (
              <div data-admin-options>
                <label className="flex cursor-pointer select-none items-start gap-2.5">
                  <input
                    type="checkbox"
                    id="admin-options"
                    name="admin-options"
                    checked={moderated}
                    onChange={(e) => setModerated(e.target.checked)}
                    aria-describedby="admin-options-help"
                    aria-controls="admin-privileges"
                    aria-expanded={moderated}
                    className="mt-0.5 h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
                  />
                  <span className="flex items-center gap-1.5 text-sm font-medium text-sonic-200">
                    <ShieldCheck className="h-4 w-4 text-amber-300" aria-hidden="true" />
                    {m.lobby_admin_options()}
                  </span>
                </label>
                <p id="admin-options-help" className="mt-1 pl-[26px] text-xs text-sonic-400">
                  {m.lobby_admin_options_help()}
                </p>
                {moderated && (
                  <fieldset
                    id="admin-privileges"
                    className="mt-3 space-y-3 rounded-lg border border-sonic-600 p-3"
                  >
                    <legend className="px-1 text-sm font-medium text-sonic-200">
                      {m.lobby_privileges_legend()}
                    </legend>
                    <div>
                      <label className="flex cursor-pointer select-none items-start gap-2.5">
                        <input
                          type="checkbox"
                          id="priv-multiple-admins"
                          checked={policy.multipleAdmins}
                          onChange={(e) => setPolicyField("multipleAdmins", e.target.checked)}
                          aria-describedby="priv-multiple-admins-help"
                          className="mt-0.5 h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
                        />
                        <span className="text-sm text-sonic-200">
                          {m.lobby_priv_multiple_admins()}
                        </span>
                      </label>
                      <p
                        id="priv-multiple-admins-help"
                        className="mt-1 pl-[26px] text-xs text-sonic-400"
                      >
                        {m.lobby_priv_multiple_admins_help()}
                      </p>
                    </div>
                    {whoSelect("recording", m.lobby_priv_recording(), WHO_OPTIONS)}
                    {whoSelect("shareAudio", m.lobby_priv_share_audio(), WHO_OPTIONS)}
                    {whoSelect("streamAudio", m.lobby_priv_stream_audio(), WHO_OPTIONS)}
                    {whoSelect("ducking", m.lobby_priv_ducking(), WHO_NO_NOBODY_OPTIONS)}
                    {whoSelect("liveStreaming", m.lobby_priv_live_streaming(), WHO_OPTIONS)}
                    {whoSelect("approveJoins", m.lobby_priv_approve_joins(), WHO_NO_NOBODY_OPTIONS)}
                    {whoSelect("chat", m.lobby_priv_chat(), WHO_OPTIONS)}
                    {whoSelect("notes", m.lobby_priv_notes(), WHO_OPTIONS)}
                    {whoSelect("mutePeer", m.lobby_priv_mute_peer(), WHO_OPTIONS)}
                    {whoSelect("muteAll", m.lobby_priv_mute_all(), WHO_OPTIONS)}
                    {whoSelect("kick", m.lobby_priv_kick(), KICK_OPTIONS, "priv-kick-help")}
                    <p id="priv-kick-help" className="text-xs text-sonic-400">
                      {m.lobby_priv_kick_help()}
                    </p>
                    <div>
                      <label className="flex cursor-pointer select-none items-start gap-2.5">
                        <input
                          type="checkbox"
                          id="priv-hide-powered-by"
                          checked={policy.hidePoweredBy}
                          onChange={(e) => setPolicyField("hidePoweredBy", e.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
                        />
                        <span className="text-sm text-sonic-200">
                          {m.lobby_priv_hide_powered_by()}
                        </span>
                      </label>
                    </div>
                  </fieldset>
                )}
              </div>
            )}

            {/* Join without a microphone — for people who have no mic or can't /
                won't speak. They listen and use text chat only; no mic prompt is
                shown. (A missing or denied mic also falls back to this mode.) */}
            <div>
              <label className="flex cursor-pointer select-none items-start gap-2.5">
                <input
                  type="checkbox"
                  id="join-without-mic"
                  name="join-without-mic"
                  checked={joinWithoutMic}
                  onChange={(e) => setJoinWithoutMic(e.target.checked)}
                  aria-describedby="join-without-mic-help"
                  className="mt-0.5 h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
                />
                <span className="text-sm font-medium text-sonic-200">
                  {m.lobby_join_without_mic()}
                </span>
              </label>
              <p id="join-without-mic-help" className="mt-1 pl-[26px] text-xs text-sonic-400">
                {m.lobby_join_without_mic_help()}
              </p>
            </div>

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
        </div>
      </div>

      {/* Screen-reader live region — announces the room picked from the public
          list. key changes per announcement so identical text re-announces. */}
      <div id="lobby-announcer" aria-live="polite" role="status" className="sr-only">
        <span key={announceSeq}>{announcement}</span>
      </div>

      <Footer />
    </div>
  );
}
