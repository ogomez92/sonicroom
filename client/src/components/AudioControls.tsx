import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Mic,
  MicOff,
  LogOut,
  ScreenShare,
  ScreenShareOff,
  Circle,
  Square,
  Download,
  FileArchive,
  FileMusic,
  AudioLines,
  Radio,
  Settings,
  Megaphone,
} from "lucide-react";
import { useRoomStore } from "../stores/room";
import { DeviceSettings } from "./DeviceSettings";
import { StreamSettings } from "./StreamSettings";
import { m } from "../paraglide/messages.js";

interface AudioControlsProps {
  onToggleMute: () => void;
  onToggleAudioShare: () => void;
  // Stream audio: opens the source chooser when idle, stops the stream when one
  // is active (the floating player also offers play/pause + stop).
  onToggleFileStream: () => void;
  // Flip the room-wide auto-ducking toggle (music dips under voice, or not).
  onToggleDucking: () => void;
  onToggleRecording: () => void;
  onStartStreaming: () => Promise<void>;
  onStopStreaming: () => Promise<void>;
  // Announce + briefly number the people talking now / who talked recently.
  onAnnounceSpeakers: () => void;
  onLeave: () => void;
}

export function AudioControls({
  onToggleMute,
  onToggleAudioShare,
  onToggleFileStream,
  onToggleDucking,
  onToggleRecording,
  onStartStreaming,
  onStopStreaming,
  onAnnounceSpeakers,
  onLeave,
}: AudioControlsProps) {
  const isMuted = useRoomStore((s) => s.isMuted);
  const hasMic = useRoomStore((s) => s.hasMic);
  const isSharingAudio = useRoomStore((s) => s.isSharingAudio);
  const isStreamingFile = useRoomStore((s) => s.fileStreamName != null);
  const duckingEnabled = useRoomStore((s) => s.duckingEnabled);
  const isRecording = useRoomStore((s) => s.isRecording);
  const recordingId = useRoomStore((s) => s.recordingId);
  const isStreaming = useRoomStore((s) => s.isStreaming);

  // The gear (device pickers) and the streaming button each open a popover.
  // Only one is open at a time — opening one closes the other.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [streamOpen, setStreamOpen] = useState(false);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const streamPanelRef = useRef<HTMLDivElement>(null);

  // Roving tabindex: the toolbar is a single tab stop and left/right arrows
  // move focus between its controls (ARIA toolbar pattern).
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const [activeId, setActiveId] = useState("mute");

  // Dialog focus management: move focus into a panel when it opens (its first
  // enabled control), and return it to the triggering button on close.
  useEffect(() => {
    if (settingsOpen) settingsPanelRef.current?.querySelector("select")?.focus();
  }, [settingsOpen]);
  useEffect(() => {
    if (streamOpen) {
      streamPanelRef.current
        ?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), button")
        ?.focus();
    }
  }, [streamOpen]);

  const openSettings = useCallback(() => {
    setStreamOpen(false);
    setSettingsOpen((o) => !o);
  }, []);
  const openStream = useCallback(() => {
    setSettingsOpen(false);
    setStreamOpen((o) => !o);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    itemRefs.current.get("settings")?.focus();
  }, []);
  const closeStream = useCallback(() => {
    setStreamOpen(false);
    itemRefs.current.get("stream")?.focus();
  }, []);

  const orderedIds = [
    "mute",
    "share",
    "file",
    "duck",
    "record",
    ...(recordingId ? ["download", "download-tracks"] : []),
    "stream",
    "speakers",
    "settings",
    "leave",
  ];
  // If the active control vanished (e.g. the download link), fall back to the first.
  const effectiveActiveId = orderedIds.includes(activeId) ? activeId : orderedIds[0];

  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) itemRefs.current.set(id, el);
    else itemRefs.current.delete(id);
  };

  const item = (id: string) => ({
    ref: register(id),
    tabIndex: effectiveActiveId === id ? 0 : -1,
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const { key } = e;
    if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
    e.preventDefault();
    const idx = orderedIds.indexOf(effectiveActiveId);
    const last = orderedIds.length - 1;
    const nextIdx =
      key === "Home"
        ? 0
        : key === "End"
          ? last
          : key === "ArrowRight"
            ? (idx + 1) % orderedIds.length
            : (idx - 1 + orderedIds.length) % orderedIds.length;
    const nextId = orderedIds[nextIdx];
    setActiveId(nextId);
    itemRefs.current.get(nextId)?.focus();
  };

  return (
    // Escape is handled on the wrapper so it closes whichever popover is open,
    // no matter where focus sits (inside the panel or still on the button).
    <div
      className="relative"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        if (settingsOpen) {
          e.stopPropagation();
          closeSettings();
        } else if (streamOpen) {
          e.stopPropagation();
          closeStream();
        }
      }}
    >
      {/* Mic/speaker pickers — same DeviceSettings as the lobby, so a change
          here applies live to the call and is remembered for next time. */}
      {settingsOpen && (
        <div
          ref={settingsPanelRef}
          className="absolute bottom-full left-1/2 z-10 mb-3 w-72 -translate-x-1/2 rounded-xl border border-sonic-600 bg-sonic-800 p-4 shadow-2xl"
          role="dialog"
          aria-label={m.settings_heading()}
        >
          <h2 className="mb-3 text-sm font-semibold text-sonic-100">{m.settings_heading()}</h2>
          <DeviceSettings />
        </div>
      )}

      {/* Streaming: the Icecast target lives right here, where you press start —
          enter the URL/credentials and Start streaming. */}
      {streamOpen && (
        <div
          ref={streamPanelRef}
          className="absolute bottom-full left-1/2 z-10 mb-3 max-h-[75vh] w-80 -translate-x-1/2 overflow-y-auto rounded-xl border border-sonic-600 bg-sonic-800 p-4 shadow-2xl"
          role="dialog"
          aria-label={m.settings_streaming_heading()}
        >
          <StreamSettings onStartStreaming={onStartStreaming} onStopStreaming={onStopStreaming} />
        </div>
      )}

      <div
        className="flex items-center justify-center gap-3 rounded-2xl border border-sonic-600 bg-sonic-800 p-3"
        role="toolbar"
        aria-label={m.controls_toolbar_label()}
        onKeyDown={onKeyDown}
      >
        {/* Mute. With no microphone (listen/chat-only) there's nothing to mute:
            stays focusable for discoverability but is aria-disabled, relabelled,
            and shows a struck-through mic. */}
        <button
          {...item("mute")}
          onClick={hasMic ? onToggleMute : undefined}
          aria-disabled={!hasMic}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
            !hasMic
              ? "cursor-not-allowed bg-sonic-700 text-sonic-500"
              : isMuted
                ? "bg-muted/20 text-muted hover:bg-muted/30"
                : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-label={
            hasMic ? (isMuted ? m.controls_unmute() : m.controls_mute()) : m.controls_no_mic()
          }
          title={hasMic ? m.controls_mute_title() : m.controls_no_mic_title()}
        >
          {!hasMic || isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>

        <button
          {...item("share")}
          onClick={onToggleAudioShare}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
            isSharingAudio
              ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
              : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-label={isSharingAudio ? m.controls_stop_share() : m.controls_share()}
          aria-pressed={isSharingAudio}
          title={isSharingAudio ? m.controls_stop_share_title() : m.controls_share_title()}
        >
          {isSharingAudio ? (
            <ScreenShareOff className="h-5 w-5" />
          ) : (
            <ScreenShare className="h-5 w-5" />
          )}
        </button>

        <button
          {...item("file")}
          onClick={onToggleFileStream}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
            isStreamingFile
              ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
              : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-label={isStreamingFile ? m.controls_stop_file() : m.controls_stream_file()}
          aria-pressed={isStreamingFile}
          title={isStreamingFile ? m.controls_stop_file_title() : m.controls_stream_file_title()}
        >
          <FileMusic className="h-5 w-5" />
        </button>

        {/* Auto-ducking toggle (room-wide). Default on shows as a normal control;
            turning it OFF tints it amber to flag that music no longer dips under
            voice for anyone in the room. */}
        <button
          {...item("duck")}
          onClick={onToggleDucking}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
            duckingEnabled
              ? "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
              : "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
          }`}
          aria-label={duckingEnabled ? m.controls_ducking_disable() : m.controls_ducking_enable()}
          aria-pressed={duckingEnabled}
          title={duckingEnabled ? m.controls_ducking_on_title() : m.controls_ducking_off_title()}
        >
          <AudioLines className="h-5 w-5" />
        </button>

        <button
          {...item("record")}
          onClick={onToggleRecording}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
            isRecording
              ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
              : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-label={isRecording ? m.controls_stop_recording() : m.controls_record()}
          aria-pressed={isRecording}
          title={isRecording ? m.controls_stop_recording_title() : m.controls_record_title()}
        >
          {isRecording ? (
            <Square className="h-4 w-4 fill-current" />
          ) : (
            <Circle className="h-5 w-5 fill-red-500 text-red-500" />
          )}
        </button>

        {recordingId && (
          <a
            {...item("download")}
            href={`/api/recordings/${encodeURIComponent(recordingId)}/download`}
            download={`sonicroom-${recordingId}.ogg`}
            className="flex h-11 items-center gap-2 rounded-full bg-sonic-700 px-4 text-sonic-200 transition-all hover:bg-sonic-600"
            aria-label={m.controls_download_recording()}
            title={isRecording ? m.controls_download_active_title() : m.controls_download_title()}
          >
            <Download className="h-4 w-4" />
            <span className="text-sm font-medium">{m.controls_download()}</span>
          </a>
        )}

        {recordingId && (
          <a
            {...item("download-tracks")}
            href={`/api/recordings/${encodeURIComponent(recordingId)}/tracks`}
            download={`sonicroom-${recordingId}-tracks.zip`}
            className="flex h-11 items-center gap-2 rounded-full bg-sonic-700 px-4 text-sonic-200 transition-all hover:bg-sonic-600"
            aria-label={m.controls_download_tracks_recording()}
            title={
              isRecording
                ? m.controls_download_tracks_active_title()
                : m.controls_download_tracks_title()
            }
          >
            <FileArchive className="h-4 w-4" />
            <span className="text-sm font-medium">{m.controls_download_tracks()}</span>
          </a>
        )}

        {/* Live streaming: opens the Icecast target popover (where you start). A
            live stream tints it purple to match the header's LIVE badge. */}
        <button
          {...item("stream")}
          onClick={openStream}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
            isStreaming
              ? "bg-purple-500/20 text-purple-300 hover:bg-purple-500/30"
              : streamOpen
                ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
                : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-label={m.settings_streaming_heading()}
          aria-expanded={streamOpen}
          title={isStreaming ? m.room_streaming_title() : m.streaming_start_title()}
        >
          <Radio className={`h-5 w-5 ${isStreaming ? "animate-pulse" : ""}`} />
        </button>

        {/* Announce (and briefly number on their tiles) who's talking now or
            talked recently — a momentary readout, not a toggle. Same action as
            the W shortcut. */}
        <button
          {...item("speakers")}
          onClick={onAnnounceSpeakers}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-sonic-700 text-sonic-200 transition-all hover:bg-sonic-600"
          aria-label={m.controls_speakers()}
          title={m.controls_speakers_title()}
        >
          <Megaphone className="h-5 w-5" />
        </button>

        <button
          {...item("settings")}
          onClick={openSettings}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
            settingsOpen
              ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
              : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-label={m.settings_open()}
          aria-expanded={settingsOpen}
          title={m.settings_open()}
        >
          <Settings className="h-5 w-5" />
        </button>

        <div className="h-8 w-px bg-sonic-600" role="separator" />

        <button
          {...item("leave")}
          onClick={onLeave}
          className="flex h-11 items-center gap-2 rounded-full bg-muted/20 px-4 text-muted transition-all hover:bg-muted/30"
          aria-label={m.controls_leave_room()}
        >
          <LogOut className="h-4 w-4" />
          <span className="text-sm font-medium">{m.controls_leave()}</span>
        </button>
      </div>
    </div>
  );
}
