import { useEffect, useRef, type KeyboardEvent } from "react";
import { Play, Pause, X, FileMusic, Volume2 } from "lucide-react";
import { m } from "../paraglide/messages.js";

interface FileStreamPlayerProps {
  // The name of the file currently being streamed.
  name: string;
  playing: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  // The streamer's LOCAL monitor volume (0–1) and its setter. Only affects how
  // loud the stream is for THEM — the track others hear is always full level.
  volume: number;
  onVolumeChange: (volume: number) => void;
}

// Floating mini-window for the local-file stream: shows the file name, a
// play/pause toggle (autofocused when the window appears, so Space toggles it
// straight away), a local volume slider and a stop button. Escape anywhere
// inside stops the stream and closes the window. Independent of the audio share
// and the music caster.
export function FileStreamPlayer({
  name,
  playing,
  onTogglePlay,
  onStop,
  volume,
  onVolumeChange,
}: FileStreamPlayerProps) {
  const playRef = useRef<HTMLButtonElement>(null);

  // Autofocus the play/pause control the moment the window opens (i.e. as soon
  // as a file is picked), so keyboard/SR users land on it without tabbing.
  useEffect(() => {
    playRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onStop();
    }
  };

  return (
    <div
      role="dialog"
      aria-label={m.file_player_heading()}
      onKeyDown={onKeyDown}
      className="fixed bottom-28 right-4 z-20 w-72 rounded-xl border border-sonic-600 bg-sonic-800 p-3 shadow-2xl"
    >
      <div className="mb-2 flex items-center gap-2">
        <FileMusic className="h-4 w-4 shrink-0 text-sonic-accent" />
        <span className="truncate text-sm font-medium text-sonic-100" title={name}>
          {name}
        </span>
        <button
          onClick={onStop}
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sonic-700 text-sonic-200 transition-all hover:bg-sonic-600"
          aria-label={m.file_player_stop()}
          title={m.controls_stop_file_title()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          ref={playRef}
          onClick={onTogglePlay}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-sonic-accent text-white transition-all hover:bg-sonic-accent/90"
          aria-label={playing ? m.file_player_pause() : m.file_player_play()}
          aria-describedby="file-player-hint"
          aria-pressed={playing}
        >
          {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </button>
        {/* Keyboard guidance for the autofocused play button (Space toggles,
            Escape stops) — tied to it via aria-describedby. */}
        <p id="file-player-hint" className="text-xs text-sonic-400">
          {m.file_player_hint()}
        </p>
      </div>

      {/* Local monitor volume — only changes how loud the stream is for YOU; the
          track everyone else hears stays at full level. Persisted, so the next
          stream starts at the same volume. */}
      <div className="mt-3 flex items-center gap-2">
        <Volume2 className="h-4 w-4 shrink-0 text-sonic-400" aria-hidden="true" />
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={Math.round(volume * 100)}
          onChange={(e) => onVolumeChange(parseInt(e.target.value, 10) / 100)}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
          aria-label={m.file_player_volume_label()}
          aria-valuetext={`${Math.round(volume * 100)}%`}
        />
      </div>
    </div>
  );
}
