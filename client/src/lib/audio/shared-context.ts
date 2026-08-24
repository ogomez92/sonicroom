// The single AudioContext for the whole session, plus the keep-alive plumbing
// that resumes it after the browser suspends/interrupts it. Extracted from
// useMediasoup so the audio controllers (peer-audio registry, outgoing graph)
// can take a context by injection and be unit-tested against a fresh fake.
import { isIOS } from "../microphone";

// Default setTargetAtTime time-constant (seconds) for gain ramps — short enough
// to feel instant, long enough to avoid zipper noise. Shared by the per-peer
// gain ramps and the outgoing mic/monitor gains.
export const GAIN_RAMP = 0.03;

let shared: AudioContext | null = null;

// Shared AudioContext — single output buffer for all peers (lower latency than
// one per peer).
//
// On iOS the context is created LAZILY — on first use, which the hook arranges
// to be right after the microphone is acquired — instead of at module load.
// WebKit fixes an AudioContext's rate to the hardware rate at creation time,
// and opening the mic reconfigures the iOS audio session (typically 44.1 kHz →
// 48 kHz). A context created before that keeps the old rate and WebKit then
// resamples both the mic → outDest path and playback against a clock it no
// longer matches: the outgoing voice's pitch sags and snaps back every few
// seconds and remote audio comes out smeared. Creating the context after the
// mic is open lets it adopt the rate the session actually runs at. We still
// don't pin 48 kHz on iOS (a route the hardware can't honour garbles capture);
// other browsers honour the pin cleanly, so they keep the eager, pinned context.
function create(): AudioContext {
  const ctx = new AudioContext({
    ...(isIOS ? {} : { sampleRate: 48000 }),
    latencyHint: "interactive",
  });
  ctx.addEventListener("statechange", () => resumeContext(ctx));
  return ctx;
}

export function getSharedAudioContext(): AudioContext {
  if (!shared) shared = create();
  return shared;
}

// True once the context exists. Lets mount-time effects (speaker sink) avoid
// forcing an early creation on iOS.
export function hasSharedAudioContext(): boolean {
  return shared != null;
}

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

const resumeShared = () => {
  if (shared) resumeContext(shared);
};
document.addEventListener("touchstart", resumeShared);
document.addEventListener("click", resumeShared);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeShared();
});

if (!isIOS) getSharedAudioContext();
