// iOS/iPadOS Safari (iPadOS now reports as "MacIntel" + touch). WebKit's audio
// stack should use the device-native sample rate because hardware route changes
// can otherwise interrupt or garble capture.
export const isIOS =
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

// Mic capture constraints. Two independent per-user choices:
//   - voiceProcessingEnabled: echo cancel / noise suppress / auto gain.
//   - hifiVoice: capture 2 channels for the opt-in stereo voice path. Off by
//     default, so the default voice path stays mono (matching the wire codec —
//     see `forceOpusParams` / the produce `opusStereo` flag). A mono mic is
//     unaffected either way; this only matters for a genuinely stereo source.
// On iOS we drop the sample-rate hint so WebKit can use the device-native rate
// (forcing a rate a route can't honour garbles capture); WebRTC/Opus negotiates
// its own rate regardless. The device is `ideal`, not `exact`, so a
// remembered-but-unplugged mic falls back to the default instead of failing.
export function microphoneConstraints(
  deviceId: string,
  voiceProcessingEnabled: boolean,
  hifiVoice: boolean,
): MediaTrackConstraints {
  return {
    channelCount: hifiVoice ? 2 : 1,
    ...(isIOS ? {} : { sampleRate: 48000 }),
    echoCancellation: voiceProcessingEnabled,
    noiseSuppression: voiceProcessingEnabled,
    autoGainControl: voiceProcessingEnabled,
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}

// Constraints for an EXTRA streamed microphone/input device — a separate "mic"
// producer alongside the primary voice mic. Two differences from the voice path:
//   - `exact` device matching, NOT `ideal`. An unavailable/busy extra mic must
//     fail cleanly rather than silently aliasing to the *default* device (which
//     `ideal` does) and doubling that capture into the room. The caller only ever
//     passes a concrete deviceId (the picker excludes the empty "Default" id and
//     the primary voice mic).
//   - captured RAW (no echo cancel / noise suppress / auto gain), so instruments
//     and line-in keep their dynamics — matching the share/file philosophy.
// `stereo` is the per-device opt-in (default mono); a mono source is unaffected.
export function extraMicConstraints(deviceId: string, stereo: boolean): MediaTrackConstraints {
  return {
    channelCount: stereo ? 2 : 1,
    ...(isIOS ? {} : { sampleRate: 48000 }),
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    deviceId: { exact: deviceId },
  };
}
