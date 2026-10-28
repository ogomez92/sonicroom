import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Minus, Plus } from "lucide-react";
import { useRoomStore, MAX_MIC_GAIN } from "../stores/room";
import { applySpeakerToContext } from "../lib/audio-devices";
import { microphoneConstraints } from "../lib/microphone";
import { DeviceSettings } from "./DeviceSettings";
import { m } from "../paraglide/messages.js";

// Mirror the room's outgoing soft limiter so the previewed level matches what
// peers will actually hear (see MIC_LIMITER in useMediasoup).
const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 };

// Qualitative bands so the meter is usable without sight: the precise value is
// exposed on the role="meter" element, and band *changes* are announced to a
// live region (throttled + change-only, so it never chatters frame-to-frame).
type Band = "silent" | "low" | "good" | "high";
function levelBand(level: number): Band {
  if (level < 0.05) return "silent";
  if (level < 0.2) return "low";
  if (level <= 0.9) return "good";
  return "high";
}
// Spoken band feedback, resolved at call time so it tracks the active locale.
// Empty for "silent" — not spoken (you hear your own silence via the monitor).
function bandMessage(band: Band): string {
  switch (band) {
    case "low":
      return m.mic_band_low();
    case "good":
      return m.mic_band_good();
    case "high":
      return m.mic_band_high();
    default:
      return "";
  }
}

// Short, localized band name used in the meter's aria-valuetext.
function bandName(band: Band): string {
  switch (band) {
    case "silent":
      return m.mic_band_name_silent();
    case "low":
      return m.mic_band_name_low();
    case "good":
      return m.mic_band_name_good();
    default:
      return m.mic_band_name_high();
  }
}

// Test your mic before joining and set a send-side gain (handy for a quiet or
// cheap mic). The value lives in the room store + localStorage, so it carries
// straight into the room.
export function MicPreview() {
  const micGain = useRoomStore((s) => s.micGain);
  const setMicGain = useRoomStore((s) => s.setMicGain);
  const micDeviceId = useRoomStore((s) => s.micDeviceId);
  const speakerDeviceId = useRoomStore((s) => s.speakerDeviceId);
  const voiceProcessingEnabled = useRoomStore((s) => s.voiceProcessingEnabled);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const meterRef = useRef<HTMLDivElement | null>(null);
  // role="meter" element (precise value, read on demand) + the polite live
  // region that speaks band changes.
  const meterBoxRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  // Band announcements pause until this time (performance.now clock) so they
  // don't talk over the value spoken after a -/+ button press.
  const quietUntilRef = useRef(0);

  // -/+ buttons: a double-tap fallback for touch screen readers (iOS VoiceOver
  // may not adjust the range by swipe). Always enabled, so focus is never lost
  // at a limit; VoiceOver doesn't re-read a pressed button, so speak the value.
  const nudgeMicGain = (delta: number) => {
    const next = Math.round(Math.min(MAX_MIC_GAIN, Math.max(0, micGain + delta)) * 10) / 10;
    setMicGain(next);
    const value = next.toFixed(1);
    const message =
      next >= MAX_MIC_GAIN
        ? m.mic_gain_maximum({ value })
        : next <= 0
          ? m.mic_gain_minimum({ value })
          : m.mic_gain_valuetext({ value });
    quietUntilRef.current = performance.now() + 1500;
    const status = statusRef.current;
    if (!status) return;
    // Clear first so a repeated identical message is still spoken.
    status.textContent = "";
    requestAnimationFrame(() => {
      status.textContent = message;
    });
  };

  // Live-apply slider changes to the preview gain while testing.
  useEffect(() => {
    const ctx = ctxRef.current;
    const gain = gainRef.current;
    if (ctx && gain) gain.gain.setTargetAtTime(micGain, ctx.currentTime, 0.03);
  }, [micGain]);

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    gainRef.current = null;
    const bar = meterRef.current;
    if (bar) {
      bar.style.transform = "scaleX(0)";
      bar.style.backgroundColor = "";
    }
    const box = meterBoxRef.current;
    if (box) {
      box.setAttribute("aria-valuenow", "0");
      box.removeAttribute("aria-valuetext");
    }
    const status = statusRef.current;
    if (status) status.textContent = "";
    setTesting(false);
  }, []);

  const start = useCallback(async () => {
    setError("");
    // Device ids are read at call time (not closed over) so a restart after a
    // picker change always captures/plays on the current selection. `ideal`
    // lets an unplugged remembered mic fall back to the default.
    const { micDeviceId: micId, speakerDeviceId: speakerId } = useRoomStore.getState();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints(
          micId,
          useRoomStore.getState().voiceProcessingEnabled,
          useRoomStore.getState().hifiVoiceEnabled,
        ),
      });
    } catch {
      setError(m.mic_permission_error());
      return;
    }
    streamRef.current = stream;

    const ctx = new AudioContext();
    if (speakerId) applySpeakerToContext(ctx, speakerId);
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = micGain;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    // Monitor: play the (gained + limited) mic back to the speakers so you can
    // hear yourself — this is exactly the post-processing signal peers receive.
    // Use headphones to avoid the open mic feeding back through the speakers.
    const monitor = ctx.createGain();
    monitor.gain.value = 1;
    source.connect(gain);
    gain.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(monitor);
    monitor.connect(ctx.destination);

    ctxRef.current = ctx;
    gainRef.current = gain;

    const buf = new Float32Array(analyser.fftSize);
    // Closure state for the throttled, change-only screen-reader announcements.
    let lastBand: Band | null = null;
    let lastAnnounceAt = 0;
    const loop = (now: number) => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const level = Math.min(1, rms * 4); // ~rms 0.25 fills the bar
      const bar = meterRef.current;
      if (bar) {
        bar.style.transform = `scaleX(${level})`;
        // Warn (red) as the post-gain signal nears clipping.
        bar.style.backgroundColor = level > 0.9 ? "#f43f5e" : "";
      }

      // Expose the precise value on the meter (read on demand by a screen
      // reader) and speak band changes through the live region.
      const pct = Math.round(level * 100);
      const band = levelBand(level);
      const box = meterBoxRef.current;
      if (box) {
        box.setAttribute("aria-valuenow", String(pct));
        box.setAttribute("aria-valuetext", m.mic_valuetext({ pct, band: bandName(band) }));
      }
      if (band !== lastBand && now - lastAnnounceAt > 1200 && now > quietUntilRef.current) {
        lastBand = band;
        lastAnnounceAt = now;
        const status = statusRef.current;
        const message = bandMessage(band);
        if (status && message) status.textContent = message;
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    setTesting(true);
  }, [micGain]);

  // Stop the preview on unmount (e.g. when navigating into the room).
  useEffect(() => () => stop(), [stop]);

  // Restart an active preview on the newly picked mic. Guarded by a prev-ref
  // so unrelated dep identity changes (the gain slider re-creating `start`)
  // never restart the test mid-adjustment.
  const prevMicSettingsRef = useRef({ micDeviceId, voiceProcessingEnabled });
  useEffect(() => {
    const previous = prevMicSettingsRef.current;
    if (
      previous.micDeviceId === micDeviceId &&
      previous.voiceProcessingEnabled === voiceProcessingEnabled
    )
      return;
    prevMicSettingsRef.current = { micDeviceId, voiceProcessingEnabled };
    if (streamRef.current) {
      stop();
      void start();
    }
  }, [micDeviceId, voiceProcessingEnabled, stop, start]);

  // Live-apply a speaker change to an active preview's context.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (ctx) applySpeakerToContext(ctx, speakerDeviceId);
  }, [speakerDeviceId]);

  return (
    <div className="rounded-lg border border-sonic-600 bg-sonic-700/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-sonic-200">{m.mic_level_heading()}</span>
        <span className="font-mono text-xs text-sonic-400">{micGain.toFixed(1)}×</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={testing ? stop : start}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
            testing
              ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
              : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-pressed={testing}
        >
          {testing ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          {testing ? m.mic_stop() : m.mic_test()}
        </button>
        <button
          type="button"
          onClick={() => nudgeMicGain(-0.1)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          aria-label={m.mic_gain_decrease()}
        >
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>
        <input
          type="range"
          min="0"
          max={MAX_MIC_GAIN}
          // One step is one VoiceOver swipe on iOS (WebKit steps by `step`), so a
          // finer step makes each swipe inaudible and the slider seem stuck.
          step="0.1"
          value={micGain}
          onChange={(e) => setMicGain(parseFloat(e.target.value))}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
          aria-label={m.mic_slider_label()}
          aria-valuetext={m.mic_gain_valuetext({ value: micGain.toFixed(1) })}
          aria-describedby="mic-help"
        />
        <button
          type="button"
          onClick={() => nudgeMicGain(0.1)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          aria-label={m.mic_gain_increase()}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Live level meter — only animates while testing. role="meter" lets a
          screen reader read the exact level on demand (value set via ref). */}
      <div
        ref={meterBoxRef}
        role="meter"
        aria-label={m.mic_meter_label()}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sonic-600"
      >
        <div
          ref={meterRef}
          className="h-full w-full origin-left rounded-full bg-sonic-accent"
          style={{ transform: "scaleX(0)" }}
        />
      </div>

      {/* Spoken band changes (good / too low / too high), throttled in the rAF
          loop so it never chatters. */}
      <div ref={statusRef} role="status" aria-live="polite" className="sr-only" />

      {/* Contextual help for the level slider (error / testing / idle), wired to
          the range input above via aria-describedby so a screen reader reads the
          guidance — "boost a quiet mic, you'll hear yourself" — with the control. */}
      <p id="mic-help" className="mt-1.5 text-xs text-sonic-400">
        {error ? error : testing ? m.mic_help_testing() : m.mic_help_idle()}
      </p>

      {/* Device pickers — applied live to the preview and carried into the
          call (the selection persists via the store/localStorage). */}
      <div className="mt-3 border-t border-sonic-600 pt-3">
        <DeviceSettings />
      </div>
    </div>
  );
}
