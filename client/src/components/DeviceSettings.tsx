import { useCallback, useEffect, useId, useState } from "react";
import { useRoomStore } from "../stores/room";
import { canSelectSpeaker } from "../lib/audio-devices";
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
  const streamedMicDeviceIds = useRoomStore((s) => s.streamedMicDeviceIds);
  const micStereoByDevice = useRoomStore((s) => s.micStereoByDevice);
  const setMicDeviceId = useRoomStore((s) => s.setMicDeviceId);
  const setSpeakerDeviceId = useRoomStore((s) => s.setSpeakerDeviceId);
  const setVoiceProcessingEnabled = useRoomStore((s) => s.setVoiceProcessingEnabled);
  const setHifiVoiceEnabled = useRoomStore((s) => s.setHifiVoiceEnabled);
  const setStreamedMicDeviceIds = useRoomStore((s) => s.setStreamedMicDeviceIds);
  const setMicStereoForDevice = useRoomStore((s) => s.setMicStereoForDevice);

  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const micSelectId = useId();
  const micHintId = useId();
  const speakerSelectId = useId();
  const voiceProcessingId = useId();
  const hifiVoiceId = useId();
  const extraMicsId = useId();

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

  // A stored device that's gone (unplugged) renders as Default; the media
  // constraints use `ideal`, so capture falls back to the default device too.
  const micValue = mics.some((d) => d.deviceId === micDeviceId) ? micDeviceId : "";
  const speakerValue = speakers.some((d) => d.deviceId === speakerDeviceId) ? speakerDeviceId : "";

  // Input devices offered as EXTRA streams: every mic except the primary voice
  // device (and the empty "Default" id), so the same capture can't stream twice.
  const extraMics = mics.filter((d) => d.deviceId && d.deviceId !== micDeviceId);

  // Check/uncheck a device for extra streaming. The in-call graph reconciles
  // producers to match (see useMediasoup's effect); in the lobby it's just saved.
  const toggleExtraMic = (deviceId: string, checked: boolean) => {
    const without = streamedMicDeviceIds.filter((d) => d !== deviceId);
    setStreamedMicDeviceIds(checked ? [...without, deviceId] : without);
  };

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

      {/* Extra microphones: each checked device streams as its OWN audio (a
          separate "mic" producer alongside your main mic), with a per-device
          mono/stereo choice. A real checkbox list — shown once device names are
          known (after mic permission). The primary mic is excluded so the same
          capture can't be streamed twice. */}
      {mics.length > 0 && (
        <div>
          <p id={extraMicsId} className="mb-1 text-xs font-medium text-sonic-300">
            {m.settings_extra_mics_label()}
          </p>
          {extraMics.length === 0 ? (
            <p className="text-xs text-sonic-400">{m.settings_extra_mics_empty()}</p>
          ) : (
            <ul role="list" aria-labelledby={extraMicsId} className="space-y-2">
              {extraMics.map((d, i) => {
                const name = d.label || m.settings_mic_fallback({ n: i + 1 });
                const checked = streamedMicDeviceIds.includes(d.deviceId);
                const stereo = !!micStereoByDevice[d.deviceId];
                const rowName = `${extraMicsId}-ch-${i}`;
                return (
                  <li key={d.deviceId}>
                    <label className="flex cursor-pointer select-none items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleExtraMic(d.deviceId, e.target.checked)}
                        aria-label={m.settings_extra_mic_stream_label({ name })}
                        className="h-4 w-4 shrink-0 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
                      />
                      <span className="truncate text-xs text-sonic-200">{name}</span>
                    </label>
                    {checked && (
                      <fieldset
                        className="mt-1 flex gap-3 pl-[26px]"
                        aria-label={m.settings_extra_mic_channels_label({ name })}
                      >
                        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-sonic-300">
                          <input
                            type="radio"
                            name={rowName}
                            checked={!stereo}
                            onChange={() => setMicStereoForDevice(d.deviceId, false)}
                            className="h-3.5 w-3.5 accent-sonic-accent"
                          />
                          {m.settings_extra_mic_mono()}
                        </label>
                        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-sonic-300">
                          <input
                            type="radio"
                            name={rowName}
                            checked={stereo}
                            onChange={() => setMicStereoForDevice(d.deviceId, true)}
                            className="h-3.5 w-3.5 accent-sonic-accent"
                          />
                          {m.settings_extra_mic_stereo()}
                        </label>
                      </fieldset>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
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
