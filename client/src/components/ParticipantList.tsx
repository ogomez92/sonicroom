import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Music,
  UserX,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";
import type { PeerState } from "../stores/room";
import { m } from "../paraglide/messages.js";

interface ParticipantListProps {
  // The local user, synthesized as a PeerState (peerId === localPeerId).
  selfPeer: PeerState;
  // Everyone (and every stream) else, straight from the store's peers map.
  peerList: PeerState[];
  // Whether we have a mic (drives the self row's only option: mic level).
  hasMic: boolean;
  micGain: number;
  onMicGainChange?: (gain: number) => void;
  onVolumeChange: (peerId: string, volume: number) => void;
  onLocalMuteChange: (peerId: string, muted: boolean) => void;
  // Vote-to-kick is offered (public room with 3+ votable people). Per-peer
  // gating still excludes streams (isMusic) and ourself.
  kickEnabled: boolean;
  onToggleKick: (peerId: string) => void;
  // Transient, listener-only announcements (per CLAUDE.md: NOT announceEvent).
  announce: (message: string) => void;
  // peerId → rank (1-based) for the most recent talkers, shown as a transient
  // numbered badge on the tile (set by the W shortcut / button, auto-cleared).
  speakerBadges: Record<string, number>;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Two-level, keyboard-navigable participants UI (replaces the old per-card grid
 * of inline volume + kick controls):
 *
 *  - Level 1 — a listbox of everyone (self first). Arrow up/down + Home/End move
 *    the active row; Enter/Space drills into that participant's options.
 *  - Level 2 — that participant's options REPLACE the list (drill-down): another
 *    listbox of role="option" items (see ParticipantOptions).
 *
 * Both levels are aria-activedescendant listboxes, matching the app's existing
 * lists (Chat / AudioSourceDialog / Lobby).
 */
export function ParticipantList({
  selfPeer,
  peerList,
  hasMic,
  micGain,
  onMicGainChange,
  onVolumeChange,
  onLocalMuteChange,
  kickEnabled,
  onToggleKick,
  announce,
  speakerBadges,
}: ParticipantListProps) {
  const rows = useMemo(() => [selfPeer, ...peerList], [selfPeer, peerList]);
  const isSelf = (peerId: string) => peerId === selfPeer.peerId;

  // Level-1 active option (roving via aria-activedescendant). -1 = none yet.
  const [activeIdx, setActiveIdx] = useState(-1);
  // Level-2 drill-down target, keyed by peerId (NOT index) so a peer/stream
  // leaving while their options are open is detectable.
  const [openPeerId, setOpenPeerId] = useState<string | null>(null);

  const listRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  // Set when leaving Level 2 so we know to pull focus back to the listbox.
  const restoreFocusRef = useRef(false);

  const openPeer = openPeerId != null ? (rows.find((r) => r.peerId === openPeerId) ?? null) : null;
  const openPeerMissing = openPeerId != null && openPeer == null;

  // Keep the active option in bounds as the room grows/shrinks.
  useEffect(() => {
    setActiveIdx((i) => (i < 0 ? -1 : Math.min(i, rows.length - 1)));
  }, [rows.length]);

  // Keep the active row visible while navigating.
  useEffect(() => {
    if (activeIdx >= 0 && rows[activeIdx]) {
      optionRefs.current.get(rows[activeIdx].peerId)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIdx, rows]);

  // The open participant left (or their stream ended): drill back out.
  useEffect(() => {
    if (openPeerMissing) {
      restoreFocusRef.current = true;
      setOpenPeerId(null);
    }
  }, [openPeerMissing]);

  // Restore focus to the listbox after the options view closes.
  useEffect(() => {
    if (openPeerId == null && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      listRef.current?.focus();
    }
  }, [openPeerId]);

  const closeOptions = () => {
    restoreFocusRef.current = true;
    setOpenPeerId(null);
  };

  const rowAriaLabel = (peer: PeerState): string => {
    const self = isSelf(peer.peerId);
    const textOnly = self && !hasMic;
    let label = peer.displayName;
    if (self) label += ` (${m.card_you()})`;
    if (textOnly) label += `, ${m.card_text_only()}`;
    else if (peer.isMuted) label += `, ${m.card_muted_fragment()}`;
    if (peer.isSpeaking) label += `, ${m.card_speaking_fragment()}`;
    if (peer.localMuted) label += `, ${m.participants_muted_fragment()}`;
    if (kickEnabled && !peer.isMusic && !peer.isMicStream && !self && peer.kickVotes > 0) {
      label += `, ${peer.kickVotes === 1 ? m.card_votes_one() : m.card_votes_many({ count: peer.kickVotes })}`;
    }
    // Affordance hint last, so the name/status is heard first.
    label += `, ${m.participants_open_hint()}`;
    return label;
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (rows.length === 0) return;
    const last = rows.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((i) => Math.min((i < 0 ? -1 : i) + 1, last));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => Math.max((i < 0 ? rows.length : i) - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActiveIdx(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIdx(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIdx >= 0 && rows[activeIdx]) setOpenPeerId(rows[activeIdx].peerId);
        break;
    }
  };

  const openRow = (i: number) => {
    setActiveIdx(i);
    setOpenPeerId(rows[i].peerId);
  };

  if (openPeer) {
    return (
      <ParticipantOptions
        peer={openPeer}
        isSelf={isSelf(openPeer.peerId)}
        hasMic={hasMic}
        micGain={micGain}
        onMicGainChange={onMicGainChange}
        onVolumeChange={onVolumeChange}
        onLocalMuteChange={onLocalMuteChange}
        showKick={
          kickEnabled && !openPeer.isMusic && !openPeer.isMicStream && !isSelf(openPeer.peerId)
        }
        onToggleKick={onToggleKick}
        announce={announce}
        onClose={closeOptions}
      />
    );
  }

  const activeId =
    activeIdx >= 0 && rows[activeIdx] ? `participant-opt-${rows[activeIdx].peerId}` : undefined;

  return (
    <ul
      ref={listRef}
      role="listbox"
      tabIndex={0}
      aria-label={m.room_participants_label()}
      aria-activedescendant={activeId}
      onKeyDown={onListKeyDown}
      onFocus={() => setActiveIdx((i) => (i < 0 && rows.length ? 0 : i))}
      className="max-h-[70vh] w-full max-w-md space-y-1 overflow-y-auto rounded-xl border border-sonic-700 bg-sonic-800/40 p-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-sonic-accent/60"
    >
      {rows.map((peer, i) => {
        const self = isSelf(peer.peerId);
        const textOnly = self && !hasMic;
        const flaggedForKick =
          kickEnabled && !peer.isMusic && !peer.isMicStream && !self && peer.kickVotes > 0;
        // Transient recent-talker rank (1, 2, 3) from the W readout, if any.
        const speakerRank = speakerBadges[peer.peerId];
        return (
          <li
            key={peer.peerId}
            id={`participant-opt-${peer.peerId}`}
            role="option"
            aria-selected={i === activeIdx}
            aria-label={rowAriaLabel(peer)}
            ref={(el) => {
              if (el) optionRefs.current.set(peer.peerId, el);
              else optionRefs.current.delete(peer.peerId);
            }}
            onClick={() => openRow(i)}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
              i === activeIdx
                ? "border-sonic-accent bg-sonic-accent/15"
                : flaggedForKick
                  ? "border-red-500/50 hover:border-red-500/70"
                  : "border-transparent hover:bg-sonic-700/60"
            }`}
          >
            {/* Avatar */}
            <div
              aria-hidden="true"
              className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                peer.isMusic || peer.isMicStream
                  ? "border-2 border-sonic-accent bg-sonic-accent/20 text-sonic-accent"
                  : peer.isSpeaking
                    ? "speaking-ring border-2 border-speaking bg-speaking/20 text-speaking"
                    : "border-2 border-sonic-500 bg-sonic-700 text-sonic-200"
              }`}
            >
              {peer.isMusic ? (
                <Music className="h-4 w-4" />
              ) : peer.isMicStream ? (
                <Mic className="h-4 w-4" />
              ) : (
                getInitials(peer.displayName)
              )}
              {/* Recent-talker rank badge — visual only; the SR path is the
                  spoken readout (announce_speakers_list). */}
              {speakerRank != null && (
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-sonic-accent text-[10px] font-bold text-white ring-2 ring-sonic-800">
                  {speakerRank}
                </span>
              )}
            </div>

            {/* Name + badges */}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-sonic-100">
                {peer.displayName}
                {self && (
                  <span className="ml-1.5 rounded bg-sonic-accent/20 px-1.5 py-0.5 text-xs text-sonic-accent">
                    {m.card_you()}
                  </span>
                )}
              </span>
              {(peer.localMuted || flaggedForKick) && (
                <span className="truncate text-xs text-sonic-400">
                  {peer.localMuted && m.participants_muted_fragment()}
                  {peer.localMuted && flaggedForKick && " · "}
                  {flaggedForKick &&
                    (peer.kickVotes === 1
                      ? m.card_votes_one()
                      : m.card_votes_many({ count: peer.kickVotes }))}
                </span>
              )}
            </div>

            {/* Status icon */}
            {peer.localMuted ? (
              <VolumeX className="h-4 w-4 shrink-0 text-sonic-400" aria-hidden="true" />
            ) : peer.isMusic ? (
              <Music className="h-4 w-4 shrink-0 text-sonic-accent" aria-hidden="true" />
            ) : peer.isMicStream ? (
              <Mic className="h-4 w-4 shrink-0 text-sonic-accent" aria-hidden="true" />
            ) : textOnly ? (
              <MicOff className="h-4 w-4 shrink-0 text-sonic-400" aria-hidden="true" />
            ) : peer.isMuted ? (
              <MicOff className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            ) : (
              <Mic className="h-4 w-4 shrink-0 text-sonic-300" aria-hidden="true" />
            )}

            {/* Expand affordance — visibly indicates the row opens options on
                click / Enter (the aria-label says the same). */}
            <ChevronRight
              className={`h-4 w-4 shrink-0 transition-colors ${
                i === activeIdx ? "text-sonic-accent" : "text-sonic-300"
              }`}
              aria-hidden="true"
            />
          </li>
        );
      })}
    </ul>
  );
}

interface ParticipantOptionsProps {
  peer: PeerState;
  isSelf: boolean;
  hasMic: boolean;
  micGain: number;
  onMicGainChange?: (gain: number) => void;
  onVolumeChange: (peerId: string, volume: number) => void;
  onLocalMuteChange: (peerId: string, muted: boolean) => void;
  showKick: boolean;
  onToggleKick: (peerId: string) => void;
  announce: (message: string) => void;
  onClose: () => void;
}

const SLIDER_MIN = 0;
const SLIDER_MAX = 4;
// Keyboard step for value options. Coarser than the continuous mouse drag so a
// few Left/Right presses cover the range (10% per press).
const SLIDER_STEP = 0.1;
const clampVol = (v: number) =>
  Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(v * 100) / 100));
const toPercent = (v: number) => Math.round(v * 100);

interface OptionDef {
  id: string;
  kind: "slider" | "toggle";
  ariaLabel: string;
  // slider
  baseLabel?: string;
  value?: number;
  setValue?: (v: number) => void;
  // toggle
  activate?: () => void;
}

/**
 * Level-2 options for one participant/stream: an aria-activedescendant listbox
 * (the same pattern as Level 1 and Chat/AudioSourceDialog) whose items are ALL
 * role="option":
 *  - Arrow up/down move the active option.
 *  - On a value option (volume / mic level) Left/Right step it and Home/End jump
 *    to min/max; the new level is spoken via the live region. On a toggle option
 *    Home/End jump to the first/last option.
 *  - Enter/Space activate a toggle. role="option" cannot carry aria-pressed, so a
 *    toggle's state lives in its dynamic, localized label (Mute ↔ Unmute,
 *    vote-to-kick ↔ withdraw).
 *  - Escape/Backspace return to the participant list.
 */
function ParticipantOptions({
  peer,
  isSelf,
  hasMic,
  micGain,
  onMicGainChange,
  onVolumeChange,
  onLocalMuteChange,
  showKick,
  onToggleKick,
  announce,
  onClose,
}: ParticipantOptionsProps) {
  const name = peer.displayName;
  const votesPhrase =
    peer.kickVotes === 1 ? m.card_votes_one() : m.card_votes_many({ count: peer.kickVotes });

  // Options for this participant, in display order. Self gets only the mic level.
  const opts: OptionDef[] = [];
  if (isSelf) {
    if (hasMic) {
      opts.push({
        id: "micgain",
        kind: "slider",
        baseLabel: m.card_your_mic_level(),
        value: micGain,
        setValue: (v) => onMicGainChange?.(v),
        ariaLabel: m.participants_level_value({
          label: m.card_your_mic_level(),
          percent: toPercent(micGain),
        }),
      });
    }
  } else {
    const volLabel = m.card_volume_for({ name });
    opts.push({
      id: "volume",
      kind: "slider",
      baseLabel: volLabel,
      value: peer.volume,
      setValue: (v) => onVolumeChange(peer.peerId, v),
      ariaLabel: m.participants_level_value({ label: volLabel, percent: toPercent(peer.volume) }),
    });
    opts.push({
      id: "mute",
      kind: "toggle",
      // No aria-pressed (role=option doesn't support it): the Mute/Unmute label
      // itself carries the state.
      ariaLabel: peer.localMuted ? m.participants_unmute({ name }) : m.participants_mute({ name }),
      activate: () => {
        const next = !peer.localMuted;
        onLocalMuteChange(peer.peerId, next);
        announce(next ? m.announce_local_muted({ name }) : m.announce_local_unmuted({ name }));
      },
    });
    if (showKick) {
      opts.push({
        id: "kick",
        kind: "toggle",
        // Likewise: the label flips between casting and withdrawing the vote, and
        // carries the running tally.
        ariaLabel: peer.iVotedKick
          ? peer.kickVotes > 0
            ? `${m.card_kick_withdraw_title({ name })}, ${votesPhrase}`
            : m.card_kick_withdraw_title({ name })
          : peer.kickVotes > 0
            ? m.card_kick_with_votes({ name, votes: votesPhrase })
            : m.card_kick({ name }),
        activate: () => onToggleKick(peer.peerId),
      });
    }
  }

  const listRef = useRef<HTMLUListElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  // Keep the active option valid when the set changes (kick appears/vanishes).
  useEffect(() => {
    setActiveIdx((i) => Math.min(Math.max(i, 0), Math.max(0, opts.length - 1)));
  }, [opts.length]);

  // On open, focus the listbox (or Back when there are no options).
  useEffect(() => {
    if (opts.length === 0) backRef.current?.focus();
    else listRef.current?.focus();
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeSlider = (opt: OptionDef, v: number) => {
    const next = clampVol(v);
    opt.setValue?.(next);
    // On each step announce only the value — the name/label was already heard
    // when arriving on the option (it stays in the option's resting aria-label).
    announce(m.participants_level_percent({ percent: toPercent(next) }));
  };

  // Escape / Backspace return to the list (handled on the outer container so it
  // works from the listbox or the Back button). No text inputs live here.
  const onContainerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Backspace") {
      e.preventDefault();
      onClose();
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (opts.length === 0) return;
    const last = opts.length - 1;
    const active = opts[Math.min(activeIdx, last)];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, last));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
        break;
      case "ArrowLeft":
        if (active.kind === "slider") {
          e.preventDefault();
          changeSlider(active, (active.value ?? 0) - SLIDER_STEP);
        }
        break;
      case "ArrowRight":
        if (active.kind === "slider") {
          e.preventDefault();
          changeSlider(active, (active.value ?? 0) + SLIDER_STEP);
        }
        break;
      case "Home":
        e.preventDefault();
        if (active.kind === "slider") changeSlider(active, SLIDER_MIN);
        else setActiveIdx(0);
        break;
      case "End":
        e.preventDefault();
        if (active.kind === "slider") changeSlider(active, SLIDER_MAX);
        else setActiveIdx(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (active.kind === "toggle") active.activate?.();
        break;
    }
  };

  const activeId = opts[activeIdx] ? `popt-${opts[activeIdx].id}` : undefined;

  return (
    <div
      onKeyDown={onContainerKeyDown}
      className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-sonic-700 bg-sonic-800/40 p-3"
    >
      {/* Header: Back + participant name */}
      <div className="flex items-center gap-2 border-b border-sonic-700 pb-2">
        <button
          ref={backRef}
          type="button"
          onClick={onClose}
          aria-label={m.participants_back()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sonic-accent/60"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-sonic-100">{name}</h2>
      </div>

      {opts.length === 0 ? (
        <p className="px-1 py-2 text-sm text-sonic-400">{m.participants_no_options()}</p>
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label={m.participants_options_for({ name })}
          aria-activedescendant={activeId}
          onKeyDown={onListKeyDown}
          className="flex flex-col gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sonic-accent/60"
        >
          {opts.map((opt, i) => {
            const isActive = i === activeIdx;
            const muteOn = opt.id === "mute" && peer.localMuted;
            const kickOn = opt.id === "kick" && peer.iVotedKick;
            return (
              <li
                key={opt.id}
                id={`popt-${opt.id}`}
                role="option"
                aria-selected={isActive}
                aria-label={opt.ariaLabel}
                onMouseDown={() => setActiveIdx(i)}
                onClick={() => {
                  setActiveIdx(i);
                  if (opt.kind === "toggle") opt.activate?.();
                }}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors ${
                  kickOn
                    ? "bg-red-600 text-white"
                    : muteOn
                      ? "bg-sonic-accent/20 text-sonic-accent"
                      : isActive
                        ? "bg-sonic-accent/15 text-sonic-50"
                        : "text-sonic-200"
                }`}
              >
                {opt.kind === "slider" ? (
                  <>
                    {opt.id === "micgain" ? (
                      <Mic className="h-4 w-4 shrink-0 text-sonic-400" aria-hidden="true" />
                    ) : (
                      <Volume2 className="h-4 w-4 shrink-0 text-sonic-400" aria-hidden="true" />
                    )}
                    {/* Native range kept ONLY as a mouse-draggable visual; the
                        role="option" carries all the a11y, keyboard goes through
                        the listbox, so it's aria-hidden and not a tab stop. */}
                    <input
                      type="range"
                      min={SLIDER_MIN}
                      max={SLIDER_MAX}
                      step="0.01"
                      value={opt.value ?? 0}
                      onChange={(e) => opt.setValue?.(clampVol(parseFloat(e.target.value)))}
                      aria-hidden="true"
                      tabIndex={-1}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
                    />
                  </>
                ) : opt.id === "mute" ? (
                  <>
                    {muteOn ? (
                      <VolumeX className="h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <Volume2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate">
                      {muteOn ? m.participants_unmute({ name }) : m.participants_mute({ name })}
                    </span>
                  </>
                ) : (
                  <>
                    <UserX className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{m.card_kick_label()}</span>
                    {peer.kickVotes > 0 && (
                      <span aria-hidden="true" className="font-semibold">
                        ({peer.kickVotes})
                      </span>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
