// The single AudioContext for the whole session, plus the keep-alive plumbing
// that resumes it after the browser suspends/interrupts it. Extracted from
// useMediasoup so the audio controllers (peer-audio registry, outgoing graph)
// can take a context by injection and be unit-tested against a fresh fake.
import { isIOS } from "../microphone";

// Shared AudioContext — single output buffer for all peers (lower latency than
// one per peer). On iOS we let it adopt the device-native rate instead of pinning
// 48 kHz, so WebKit doesn't resample/fight the hardware on every route change;
// other browsers honour the pin cleanly.
export const sharedAudioContext = new AudioContext({
  ...(isIOS ? {} : { sampleRate: 48000 }),
  latencyHint: "interactive",
});

// Default setTargetAtTime time-constant (seconds) for gain ramps — short enough
// to feel instant, long enough to avoid zipper noise. Shared by the per-peer
// gain ramps and the outgoing mic/monitor gains.
export const GAIN_RAMP = 0.03;

// Keep a context running. iOS needs a user gesture to start it, and it also
// drops to "suspended" or the WebKit-only "interrupted" state whenever the audio
// route changes / the tab backgrounds — and without re-resuming, audio dies until
// a reload (this is what "keeps fucking up" mid-call). So we resume on the first
// AND every gesture, on each statechange, and when the tab refocuses.
export function resumeContext(ctx: AudioContext) {
  const state = ctx.state as string;
  if (state === "suspended" || state === "interrupted") {
    // iOS rejects resume() while still interrupted (e.g. mid phone call); the
    // statechange/visibility/gesture retries pick it up once it's allowed again.
    ctx.resume().catch(() => {});
  }
}

const resumeShared = () => resumeContext(sharedAudioContext);
document.addEventListener("touchstart", resumeShared);
document.addEventListener("click", resumeShared);
sharedAudioContext.addEventListener("statechange", resumeShared);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeShared();
});
