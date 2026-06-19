import { useCallback, useEffect, useId, useState } from "react";
import {
  useRoomStore,
  TTS_RATE_MIN,
  TTS_RATE_MAX,
  TTS_PITCH_MIN,
  TTS_PITCH_MAX,
} from "../stores/room";
import { canSelectSpeaker } from "../lib/audio-devices";
import { speak, warmUpTts } from "../lib/tts";
import { m } from "../paraglide/messages.js";

// Mic/speaker pickers. This component only reads/writes the store — the
// consumers react to the change: the lobby's MicPreview restarts its preview
// on the new mic and re-sinks its context, and useMediasoup re-acquires the
// in-call mic / re-sinks the shared context. So the same control works in the
// lobby and mid-call, and the choice (localStorage-backed) carries between.
export function DeviceSettings() {
  const micDeviceId = useRoomStore((s) => s.micDeviceId);
  const speakerDeviceId = useRoomStore((s) => s.speakerDeviceId);
  const voiceProcessingEnabled = useRoomStore((s) => s.voiceProcessingEnabled);
  const hifiVoiceEnabled = useRoomStore((s) => s.hifiVoiceEnabled);
  // announceMode (gates the speed/pitch controls) and the chosen voice are set
  // in the chat panel header; here we only tune that voice's speed/pitch.
  const announceMode = useRoomStore((s) => s.announceMode);
  const ttsVoiceURI = useRoomStore((s) => s.ttsVoiceURI);
  const ttsRate = useRoomStore((s) => s.ttsRate);
  const ttsPitch = useRoomStore((s) => s.ttsPitch);
  const locale = useRoomStore((s) => s.locale);
  const setMicDeviceId = useRoomStore((s) => s.setMicDeviceId);
  const setSpeakerDeviceId = useRoomStore((s) => s.setSpeakerDeviceId);
  const setVoiceProcessingEnabled = useRoomStore((s) => s.setVoiceProcessingEnabled);
  const setHifiVoiceEnabled = useRoomStore((s) => s.setHifiVoiceEnabled);
  const setTtsRate = useRoomStore((s) => s.setTtsRate);
  const setTtsPitch = useRoomStore((s) => s.setTtsPitch);

  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const micSelectId = useId();
  const micHintId = useId();
  const speakerSelectId = useId();
  const voiceProcessingId = useId();
  const hifiVoiceId = useId();
  const ttsRateId = useId();
  const ttsPitchId = useId();

  const refresh = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Pre-permission entries come back with empty ids/labels — drop them;
      // the explicit "Default" option covers that case.
      setMics(devices.filter((d) => d.kind === "audioinput" && d.deviceId));
      setSpeakers(devices.filter((d) => d.kind === "audiooutput" && d.deviceId));
    } catch {
      // enumerateDevices unavailable — leave the lists empty (Default only).
    }
  }, []);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [refresh]);

  // The speed/pitch controls + preview only matter when announcements are
  // actually spoken — i.e. in TTS mode and the browser supports speech
  // synthesis. (The mode and voice themselves are chosen in the chat header.)
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const showTtsTuning = announceMode === "tts" && ttsSupported;

  // Speak a short sample with the current voice/speed/pitch so the user can hear
  // the effect (these can't be judged visually). Interrupts any prior preview.
  const previewVoice = () => {
    warmUpTts();
    speak(m.settings_announce_voice_preview_text(), {
      lang: locale,
      voiceURI: ttsVoiceURI || undefined,
      rate: ttsRate,
      pitch: ttsPitch,
      interrupt: true,
    });
  };

  // A stored device that's gone (unplugged) renders as Default; the media
  // constraints use `ideal`, so capture falls back to the default device too.
  const micValue = mics.some((d) => d.deviceId === micDeviceId) ? micDeviceId : "";
  const speakerValue = speakers.some((d) => d.deviceId === speakerDeviceId) ? speakerDeviceId : "";

  const selectClass =
    "w-full rounded-lg border border-sonic-600 bg-sonic-700 px-2.5 py-1.5 text-sm text-sonic-100 transition-colors focus:border-sonic-accent focus:outline-none";

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={micSelectId} className="mb-1 block text-xs font-medium text-sonic-300">
          {m.settings_mic_label()}
        </label>
        <select
          id={micSelectId}
          value={micValue}
          onChange={(e) => setMicDeviceId(e.target.value)}
          onFocus={() => void refresh()}
          aria-describedby={mics.length === 0 ? micHintId : undefined}
          className={selectClass}
        >
          <option value="">{m.settings_default_device()}</option>
          {mics.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || m.settings_mic_fallback({ n: i + 1 })}
            </option>
          ))}
        </select>
      </div>

      {canSelectSpeaker() && (
        <div>
          <label
            htmlFor={speakerSelectId}
            className="mb-1 block text-xs font-medium text-sonic-300"
          >
            {m.settings_speaker_label()}
          </label>
          <select
            id={speakerSelectId}
            value={speakerValue}
            onChange={(e) => setSpeakerDeviceId(e.target.value)}
            onFocus={() => void refresh()}
            className={selectClass}
          >
            <option value="">{m.settings_default_device()}</option>
            {speakers.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || m.settings_speaker_fallback({ n: i + 1 })}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Each toggle's hint was a `title` tooltip — invisible to keyboard/SR
          users and only shown on hover. Promote it to visible help text tied to
          the checkbox via aria-describedby (the Lobby checkbox pattern). The
          hint id is derived from the checkbox's useId. Indented to line up under
          the label text (checkbox 16px + gap 10px = 26px). */}
      <div>
        <label
          htmlFor={voiceProcessingId}
          className="flex cursor-pointer select-none items-center gap-2.5"
        >
          <input
            id={voiceProcessingId}
            type="checkbox"
            checked={voiceProcessingEnabled}
            onChange={(e) => setVoiceProcessingEnabled(e.target.checked)}
            aria-describedby={`${voiceProcessingId}-hint`}
            className="h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
          />
          <span className="text-xs font-medium text-sonic-300">
            {m.settings_voice_processing_label()}
          </span>
        </label>
        <p id={`${voiceProcessingId}-hint`} className="mt-1 pl-[26px] text-xs text-sonic-400">
          {m.settings_voice_processing_hint()}
        </p>
      </div>

      <div>
        <label
          htmlFor={hifiVoiceId}
          className="flex cursor-pointer select-none items-center gap-2.5"
        >
          <input
            id={hifiVoiceId}
            type="checkbox"
            checked={hifiVoiceEnabled}
            onChange={(e) => setHifiVoiceEnabled(e.target.checked)}
            aria-describedby={`${hifiVoiceId}-hint`}
            className="h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
          />
          <span className="text-xs font-medium text-sonic-300">
            {m.settings_hifi_voice_label()}
          </span>
        </label>
        <p id={`${hifiVoiceId}-hint`} className="mt-1 pl-[26px] text-xs text-sonic-400">
          {m.settings_hifi_voice_hint()}
        </p>
      </div>

      {/* Speed / pitch for spoken announcements, plus a preview button to hear
          the combination. Shown only while TTS mode is selected (set in the chat
          panel header, alongside the voice picker) and the browser supports
          speech synthesis. */}
      {showTtsTuning && (
        <>
          <div>
            <label
              htmlFor={ttsRateId}
              className="mb-1 flex items-center justify-between text-xs font-medium text-sonic-300"
            >
              <span>{m.settings_announce_voice_rate_label()}</span>
              <span className="tabular-nums text-sonic-400">{ttsRate.toFixed(1)}×</span>
            </label>
            <input
              id={ttsRateId}
              type="range"
              min={TTS_RATE_MIN}
              max={TTS_RATE_MAX}
              step={0.1}
              value={ttsRate}
              onChange={(e) => setTtsRate(parseFloat(e.target.value))}
              aria-valuetext={`${ttsRate.toFixed(1)}×`}
              className="w-full accent-sonic-accent"
            />
          </div>

          <div>
            <label
              htmlFor={ttsPitchId}
              className="mb-1 flex items-center justify-between text-xs font-medium text-sonic-300"
            >
              <span>{m.settings_announce_voice_pitch_label()}</span>
              <span className="tabular-nums text-sonic-400">{ttsPitch.toFixed(1)}</span>
            </label>
            <input
              id={ttsPitchId}
              type="range"
              min={TTS_PITCH_MIN}
              max={TTS_PITCH_MAX}
              step={0.1}
              value={ttsPitch}
              onChange={(e) => setTtsPitch(parseFloat(e.target.value))}
              aria-valuetext={ttsPitch.toFixed(1)}
              className="w-full accent-sonic-accent"
            />
          </div>

          <button
            type="button"
            onClick={previewVoice}
            className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-2.5 py-1.5 text-sm text-sonic-100 transition-colors hover:bg-sonic-600 focus:border-sonic-accent focus:outline-none"
          >
            {m.settings_announce_voice_preview()}
          </button>
        </>
      )}

      {/* Browsers hide device names until mic permission is granted (e.g. in
          the lobby before the first test) — explain the bare lists. Tied to the
          mic select via aria-describedby (only while it's shown). */}
      {mics.length === 0 && (
        <p id={micHintId} className="text-xs text-sonic-400">
          {m.settings_labels_hint()}
        </p>
      )}
    </div>
  );
}
