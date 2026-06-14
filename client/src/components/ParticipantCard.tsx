import { useCallback } from "react";
import { Mic, MicOff, Volume2, Music, UserX } from "lucide-react";
import type { PeerState } from "../stores/room";
import { m } from "../paraglide/messages.js";

interface ParticipantCardProps {
  peer: PeerState;
  isLocal: boolean;
  onVolumeChange?: (volume: number) => void;
  // Local card only: you joined without a microphone (listen + text chat only).
  // Shows a "Text only" indicator and hides the mic-level slider.
  textOnly?: boolean;
  // Local card only: your outgoing mic gain (send-side), and its setter.
  micGain?: number;
  onMicGainChange?: (gain: number) => void;
  // Vote-to-kick (public rooms): whether to show the kick button for this peer,
  // and the toggle for our own vote. peer.kickVotes / peer.iVotedKick supply the
  // tally + our pressed state.
  canKick?: boolean;
  onToggleKick?: () => void;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function ParticipantCard({
  peer,
  isLocal,
  onVolumeChange,
  textOnly,
  micGain,
  onMicGainChange,
  canKick,
  onToggleKick,
}: ParticipantCardProps) {
  const handleVolume = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onVolumeChange?.(parseFloat(e.target.value));
    },
    [onVolumeChange],
  );

  const handleMicGain = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onMicGainChange?.(parseFloat(e.target.value));
    },
    [onMicGainChange],
  );

  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-xl border bg-sonic-800 p-4 transition-all ${
        canKick && peer.kickVotes > 0
          ? "border-red-500/70 ring-1 ring-red-500/40"
          : "border-sonic-600 hover:border-sonic-500"
      }`}
      role="listitem"
      // aria-selected marks a peer the room is currently voting to remove (has
      // at least one kick vote against them); only meaningful where a kick is
      // possible, so it's left off non-votable cards.
      aria-selected={canKick ? peer.kickVotes > 0 : undefined}
      aria-label={`${peer.displayName}${isLocal ? ` (${m.card_you()})` : ""}${
        textOnly ? `, ${m.card_text_only()}` : peer.isMuted ? `, ${m.card_muted_fragment()}` : ""
      }${peer.isSpeaking ? `, ${m.card_speaking_fragment()}` : ""}`}
    >
      {/* Avatar */}
      <div
        className={`flex h-16 w-16 items-center justify-center rounded-full text-lg font-bold transition-all ${
          peer.isMusic
            ? "border-2 border-sonic-accent bg-sonic-accent/20 text-sonic-accent"
            : peer.isSpeaking
              ? "speaking-ring border-2 border-speaking bg-speaking/20 text-speaking"
              : peer.isMuted
                ? "border-2 border-sonic-600 bg-sonic-700 text-sonic-400"
                : "border-2 border-sonic-500 bg-sonic-700 text-sonic-200"
        }`}
      >
        {peer.isMusic ? <Music className="h-7 w-7" /> : getInitials(peer.displayName)}
      </div>

      {/* Name + status */}
      <div className="flex items-center gap-1.5">
        <span className="max-w-[120px] truncate text-sm font-medium text-sonic-100">
          {peer.displayName}
        </span>
        {isLocal && (
          <span className="rounded bg-sonic-accent/20 px-1.5 py-0.5 text-xs text-sonic-accent">
            {m.card_you()}
          </span>
        )}
        {isLocal && textOnly && (
          <span className="rounded bg-sonic-700 px-1.5 py-0.5 text-xs text-sonic-300">
            {m.card_text_only()}
          </span>
        )}
        {peer.isMusic ? (
          <Music className="h-3.5 w-3.5 text-sonic-accent" aria-label={m.card_music_stream()} />
        ) : textOnly ? (
          <MicOff className="h-3.5 w-3.5 text-sonic-400" aria-label={m.card_text_only_status()} />
        ) : peer.isMuted ? (
          <MicOff className="h-3.5 w-3.5 text-muted" aria-label={m.card_muted_status()} />
        ) : (
          <Mic className="h-3.5 w-3.5 text-sonic-300" aria-label={m.card_unmuted_status()} />
        )}
      </div>

      {/* Volume slider (remote peers): how loud you hear them — receive-side. */}
      {!isLocal && (
        <div className="flex w-full items-center gap-2">
          <Volume2 className="h-3.5 w-3.5 shrink-0 text-sonic-400" />
          <input
            type="range"
            min="0"
            max="4"
            step="0.01"
            value={peer.volume}
            onChange={handleVolume}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
            aria-label={m.card_volume_for({ name: peer.displayName })}
          />
        </div>
      )}

      {/* Vote-to-kick (public rooms): a toggle for our own vote. aria-pressed
          reflects whether we've voted; the accessible name carries the running
          tally ("Kick {name} (2 votes)") so it's announced on press/refresh. */}
      {canKick && (
        <button
          type="button"
          onClick={onToggleKick}
          aria-pressed={peer.iVotedKick}
          aria-label={
            peer.kickVotes > 0
              ? m.card_kick_with_votes({
                  name: peer.displayName,
                  votes:
                    peer.kickVotes === 1
                      ? m.card_votes_one()
                      : m.card_votes_many({ count: peer.kickVotes }),
                })
              : m.card_kick({ name: peer.displayName })
          }
          title={
            peer.iVotedKick
              ? m.card_kick_withdraw_title({ name: peer.displayName })
              : m.card_kick_title({ name: peer.displayName })
          }
          className={`flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            peer.iVotedKick
              ? "bg-red-600 text-white hover:bg-red-500"
              : "bg-sonic-700 text-sonic-300 hover:bg-red-600/80 hover:text-white"
          }`}
        >
          <UserX className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{m.card_kick_label()}</span>
          {peer.kickVotes > 0 && (
            <span aria-hidden="true" className="font-semibold">
              ({peer.kickVotes})
            </span>
          )}
        </button>
      )}

      {/* Mic-level slider (your own card): your outgoing gain — send-side, so it
          changes how loud everyone hears you. Distinct from the volume sliders. */}
      {isLocal && onMicGainChange && (
        <div className="flex w-full items-center gap-2">
          <Mic className="h-3.5 w-3.5 shrink-0 text-sonic-400" />
          <input
            type="range"
            min="0"
            max="4"
            step="0.01"
            value={micGain ?? 1}
            onChange={handleMicGain}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
            aria-label={m.card_your_mic_level()}
            title={m.card_mic_level_title({ gain: (micGain ?? 1).toFixed(1) })}
          />
        </div>
      )}
    </div>
  );
}
