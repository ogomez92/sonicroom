// `?ios=on` (also 1/true/yes/on/enable/enabled/force/ios) forces the iOS audio
// path on ANY browser: no sample-rate pin on capture or on the shared
// AudioContext, and voice processing on by default. Detection below is UA-based,
// so it misses WebKit-shaped browsers it doesn't recognise — and any browser
// whose device fights a pinned 48 kHz hits the same garbled/interrupted capture.
// This is the manual override for those: put it on the room link.
// Read once here, at module load, because `isIOS` is a const that the shared
// AudioContext (`lib/audio/shared-context.ts`) and the store's voice-processing
// default consume the moment they import this file — a later read would be too
// late to change either.
export const iosForcedByUrl = ((): boolean => {
  if (typeof window === "undefined") return false;
  try {
    const value = new URLSearchParams(window.location.search).get("ios");
    if (value == null) return false;
    return ["on", "1", "true", "yes", "enable", "enabled", "force", "ios"].includes(
      value.toLowerCase(),
    );
  } catch {
    return false;
  }
})();

// iOS/iPadOS Safari (iPadOS now reports as "MacIntel" + touch). WebKit's audio
// stack should use the device-native sample rate because hardware route changes
// can otherwise interrupt or garble capture. `?ios=on` forces the same path.
export const isIOS =
  iosForcedByUrl ||
  (typeof navigator !== "undefined" &&
    (/iP(hone|ad|od)/.test(navigator.userAgent) ||
      (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)));

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
// producer alongside the primary voice mic. Three differences from the voice path:
//   - `exact` device matching, NOT `ideal`. An unavailable/busy extra mic must
//     fail cleanly rather than silently aliasing to the *default* device (which
//     `ideal` does) and doubling that capture into the room. The caller only ever
//     passes a concrete deviceId (the picker excludes the empty "Default" id and
//     the primary voice mic).
//   - captured RAW (no echo cancel / noise suppress / auto gain), so instruments
//     and line-in keep their dynamics — matching the share/file philosophy.
//   - NO sample-rate hint (not even off-iOS, unlike the voice path). Forcing 48 kHz
//     on a clockless virtual device (e.g. a virtual audio cable carrying music)
//     makes Chrome insert a capture-side resampler; letting the device capture at
//     its native rate avoids it. (Kept as a low-risk default. The extra mic is also
//     reclocked through a Web Audio destination before produce — see `extraMicsRef`
//     in useMediasoup.ts — which is the path that proved stable against the stereo
//     drift; the exact cause was never pinned down, so neither change is claimed as
//     the definitive fix.)
// `stereo` is the per-device opt-in (default mono); a mono source is unaffected.
export function extraMicConstraints(deviceId: string, stereo: boolean): MediaTrackConstraints {
  return {
    channelCount: stereo ? 2 : 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    deviceId: { exact: deviceId },
  };
}
