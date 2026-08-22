// Short WebAudio cues for UI events (mute/unmute, peer join/leave, chat…).
// These play locally through the given context's destination — they are never
// routed into the outgoing mic graph, so peers don't hear them. Every voice
// uses a click-free gain envelope (fast fade-in, exponential fade-out).
//
// Timbres are deliberately NOT chiptune: presence cues are FM bells (doorbell),
// leave is a fully synthesised door (filtered-noise whoosh → wood thud → latch
// click), and mute/unmute are sustained pitch slides — all richer and a touch
// louder so they're noticeable over a call.

export type Cue =
  | "mute"
  | "unmute"
  | "join"
  | "leave"
  | "message"
  | "thunk"
  | "share-start"
  | "share-stop"
  | "knock"
  | "peer-mute"
  | "peer-unmute"
  | "video-on"
  | "video-off";

interface ToneSpec {
  freq: number;
  // Optional glide target — the pitch ramps from `freq` to `glideTo` over `dur`.
  glideTo?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  // Seconds to wait before this tone starts (lets cues chain notes).
  delay?: number;
  // Fade-in time. Longer = softer onset.
  attack?: number;
  // If set, the tone holds at full gain until `dur - release`, then fades out —
  // turning a percussive pluck into a sustained sweep (used for the slides).
  release?: number;
}

function tone(ctx: BaseAudioContext, spec: ToneSpec) {
  const {
    freq,
    glideTo,
    dur,
    type = "sine",
    gain = 0.14,
    delay = 0,
    attack = 0.012,
    release,
  } = spec;
  const t0 = ctx.currentTime + delay;

  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  if (release !== undefined) {
    g.gain.setValueAtTime(gain, t0 + Math.max(attack, dur - release));
  }
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

interface BellSpec {
  freq: number;
  dur: number;
  gain?: number;
  delay?: number;
  // Modulator:carrier frequency ratio. ~√2 (1.41) = inharmonic, metallic
  // doorbell; 2 = harmonic, glassy chime.
  ratio?: number;
  // Modulation index — how bright the strike is before it mellows.
  index?: number;
}

// 2-operator FM bell: a sine carrier whose pitch is modulated by a second sine.
// The modulation depth decays fast (bright metallic strike that settles into a
// pure ring) while the amplitude decays slowly — that's what reads as a "bell".
function bell(ctx: BaseAudioContext, spec: BellSpec) {
  const { freq, dur, gain = 0.2, delay = 0, ratio = 1.41, index = 4 } = spec;
  const t0 = ctx.currentTime + delay;

  const carrier = ctx.createOscillator();
  carrier.type = "sine";
  carrier.frequency.setValueAtTime(freq, t0);

  const mod = ctx.createOscillator();
  mod.type = "sine";
  mod.frequency.setValueAtTime(freq * ratio, t0);

  const modGain = ctx.createGain();
  const depth = freq * ratio * index;
  modGain.gain.setValueAtTime(depth, t0);
  modGain.gain.exponentialRampToValueAtTime(depth * 0.02, t0 + dur * 0.5);
  mod.connect(modGain);
  modGain.connect(carrier.frequency);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  carrier.connect(g);
  g.connect(ctx.destination);
  carrier.start(t0);
  mod.start(t0);
  carrier.stop(t0 + dur + 0.02);
  mod.stop(t0 + dur + 0.02);
}

interface NoiseSpec {
  dur: number;
  gain?: number;
  delay?: number;
  type?: BiquadFilterType;
  freq: number;
  // Optional cutoff sweep target (e.g. a door swinging shut).
  freqEnd?: number;
  q?: number;
  attack?: number;
}

// Filtered white-noise burst — the raw material for non-pitched sounds (the
// door's air whoosh, wood thud, and latch click).
function noise(ctx: BaseAudioContext, spec: NoiseSpec) {
  const {
    dur,
    gain = 0.2,
    delay = 0,
    type = "lowpass",
    freq,
    freqEnd,
    q = 1,
    attack = 0.005,
  } = spec;
  const t0 = ctx.currentTime + delay;

  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t0);
  if (freqEnd) filter.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  filter.Q.value = q;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

interface CreakSpec {
  freq: number;
  glideTo?: number;
  dur: number;
  gain?: number;
  delay?: number;
  // Stick-slip graininess rate (Hz). The creak speeds up over its length.
  lfoRate?: number;
  // Modulation depth of that graininess (0..0.5). Higher = harder ratchet.
  depth?: number;
  filterFreq?: number;
  q?: number;
}

// A hinge creak: a sawtooth (rich in harmonics) glides in pitch through a
// bandpass for the "eee" vowel, while a fast square LFO chops its amplitude —
// that ratchety amplitude modulation is the wood's stick-slip "creeeak".
function creak(ctx: BaseAudioContext, spec: CreakSpec) {
  const {
    freq,
    glideTo,
    dur,
    gain = 0.16,
    delay = 0,
    lfoRate = 24,
    depth = 0.45,
    filterFreq = 760,
    q = 5,
  } = spec;
  const t0 = ctx.currentTime + delay;

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.linearRampToValueAtTime(glideTo, t0 + dur);

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = filterFreq;
  filter.Q.value = q;

  // Amplitude modulation around a base level — the grain of the creak. The LFO
  // accelerates so the creak quickens as the door swings.
  const am = ctx.createGain();
  am.gain.setValueAtTime(1 - depth, t0);
  const lfo = ctx.createOscillator();
  lfo.type = "square";
  lfo.frequency.setValueAtTime(lfoRate, t0);
  lfo.frequency.linearRampToValueAtTime(lfoRate * 1.8, t0 + dur);
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = depth;
  lfo.connect(lfoDepth);
  lfoDepth.connect(am.gain);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.04);
  env.gain.setValueAtTime(gain, t0 + Math.max(0.04, dur - 0.06));
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(filter);
  filter.connect(am);
  am.connect(env);
  env.connect(ctx.destination);
  osc.start(t0);
  lfo.start(t0);
  osc.stop(t0 + dur + 0.02);
  lfo.stop(t0 + dur + 0.02);
}

export function playCue(ctx: AudioContext, cue: Cue) {
  if (ctx.state === "suspended") ctx.resume();

  switch (cue) {
    // Mute/unmute are sustained pitch SLIDES (portamento), not blips: a mellow
    // triangle sweeps the whole range while it sounds, with a faint octave on
    // top for body. Up = unmute, down = mute.
    case "unmute":
      tone(ctx, {
        freq: 320,
        glideTo: 680,
        dur: 0.22,
        type: "triangle",
        gain: 0.22,
        attack: 0.02,
        release: 0.06,
      });
      tone(ctx, {
        freq: 640,
        glideTo: 1360,
        dur: 0.22,
        type: "sine",
        gain: 0.06,
        attack: 0.02,
        release: 0.06,
      });
      break;
    case "mute":
      tone(ctx, {
        freq: 680,
        glideTo: 300,
        dur: 0.22,
        type: "triangle",
        gain: 0.22,
        attack: 0.02,
        release: 0.06,
      });
      tone(ctx, {
        freq: 1360,
        glideTo: 600,
        dur: 0.22,
        type: "sine",
        gain: 0.06,
        attack: 0.02,
        release: 0.06,
      });
      break;
    // Someone enters → doorbell. Classic descending two-tone "ding-dong",
    // inharmonic FM bells with a long ring.
    case "join":
      bell(ctx, { freq: 660, dur: 0.5, gain: 0.24, ratio: 1.41, index: 4 });
      bell(ctx, { freq: 523, dur: 0.62, gain: 0.24, ratio: 1.41, index: 4, delay: 0.32 });
      break;
    // Someone leaves → a door easing shut: a loud hinge CREAK swinging down in
    // pitch (high → low) and quickening, then a pronounced latch HIT — a hard
    // wooden thunk of the door meeting the frame plus a bright metallic latch
    // click and the strike-plate rattle.
    case "leave":
      creak(ctx, {
        freq: 300,
        glideTo: 150,
        dur: 0.42,
        gain: 0.26,
        lfoRate: 22,
        depth: 0.5,
        filterFreq: 900,
        q: 6,
      });
      // The hit, landing as the creak ends (t≈0.42):
      // hard wooden thunk (door into frame)…
      tone(ctx, {
        freq: 175,
        glideTo: 70,
        dur: 0.09,
        type: "sine",
        gain: 0.32,
        delay: 0.42,
        attack: 0.002,
      });
      noise(ctx, {
        dur: 0.06,
        freq: 320,
        gain: 0.22,
        type: "lowpass",
        q: 0.8,
        delay: 0.42,
        attack: 0.002,
      });
      // …bright latch click…
      noise(ctx, { dur: 0.018, freq: 2900, gain: 0.3, type: "bandpass", q: 3, delay: 0.43 });
      // …and the strike-plate rattle.
      noise(ctx, { dur: 0.03, freq: 1850, gain: 0.2, type: "bandpass", q: 2, delay: 0.46 });
      break;
    // Incoming chat: a brighter, fuller two-note glassy chime (ascending fifth)
    // with a bell ring — clearly a "notification" and hard to miss.
    case "message":
      bell(ctx, { freq: 880, dur: 0.32, gain: 0.18, ratio: 2, index: 2 });
      bell(ctx, { freq: 1320, dur: 0.42, gain: 0.18, ratio: 2, index: 2, delay: 0.1 });
      break;
    // Blocked (rate-limited) send: one low, short, dull "thunk" — a soft "nope".
    case "thunk":
      tone(ctx, { freq: 170, glideTo: 120, dur: 0.13, type: "square", gain: 0.1 });
      break;
    // Audio share toggled: a soft triangle arpeggio — rising (C-E-G) when a
    // share starts, falling when it stops.
    case "share-start":
      tone(ctx, { freq: 523, dur: 0.09, type: "triangle", gain: 0.12 });
      tone(ctx, { freq: 659, dur: 0.09, type: "triangle", gain: 0.12, delay: 0.08 });
      tone(ctx, { freq: 784, dur: 0.13, type: "triangle", gain: 0.12, delay: 0.16 });
      break;
    case "share-stop":
      tone(ctx, { freq: 784, dur: 0.09, type: "triangle", gain: 0.12 });
      tone(ctx, { freq: 659, dur: 0.09, type: "triangle", gain: 0.12, delay: 0.08 });
      tone(ctx, { freq: 523, dur: 0.13, type: "triangle", gain: 0.12, delay: 0.16 });
      break;
    // Someone is asking to be let in → a hard triple rap on the door (see `knock`).
    case "knock":
      knock(ctx, 0);
      break;
    // A REMOTE peer toggled their mic — a short, soft pitch blip (down = muted,
    // up = unmuted). Deliberately quieter/briefer than the sustained self
    // mute/unmute slides so you can tell "someone else" from "me".
    case "peer-mute":
      tone(ctx, { freq: 520, glideTo: 340, dur: 0.12, type: "triangle", gain: 0.1, release: 0.05 });
      break;
    case "peer-unmute":
      tone(ctx, { freq: 340, glideTo: 520, dur: 0.12, type: "triangle", gain: 0.1, release: 0.05 });
      break;
    // A camera turned on/off (ours or a peer's, VIDEO rooms only): a camera
    // "shutter" — a short bright click plus a two-note sine blip, rising for on
    // and falling for off. Distinct from the share arpeggio and the mute slides.
    case "video-on":
      noise(ctx, { dur: 0.02, freq: 2400, gain: 0.16, type: "bandpass", q: 2.5 });
      tone(ctx, { freq: 587, dur: 0.1, type: "sine", gain: 0.13, delay: 0.03 });
      tone(ctx, { freq: 880, dur: 0.16, type: "sine", gain: 0.13, delay: 0.12 });
      break;
    case "video-off":
      noise(ctx, { dur: 0.02, freq: 2400, gain: 0.16, type: "bandpass", q: 2.5 });
      tone(ctx, { freq: 880, dur: 0.1, type: "sine", gain: 0.13, delay: 0.03 });
      tone(ctx, { freq: 587, dur: 0.16, type: "sine", gain: 0.13, delay: 0.12 });
      break;
  }
}

// The knock timbre — three hard, rapid raps (a fist pounding the door, not a
// polite knuckle-tap): each rap is a low pitch-dropping thud with a wooden
// lowpass body AND a bright bandpass crack on top, scheduled at offset `at`.
// The fast triplet + brighter snap + higher gain read as urgent/insistent.
// Works on a real OR an offline (render) context.
function knock(ctx: BaseAudioContext, at: number) {
  for (const d of [0, 0.13, 0.26]) {
    // The thud — punchier and a touch lower than the old polite tap.
    tone(ctx, {
      freq: 220,
      glideTo: 80,
      dur: 0.08,
      type: "sine",
      gain: 0.34,
      delay: at + d,
      attack: 0.001,
    });
    // Wooden body, opened up brighter so it cuts through.
    noise(ctx, {
      dur: 0.06,
      freq: 800,
      gain: 0.26,
      type: "lowpass",
      q: 0.8,
      delay: at + d,
      attack: 0.001,
    });
    // Hard knuckle/fist crack — the high-frequency snap that makes it bite.
    noise(ctx, {
      dur: 0.02,
      freq: 2600,
      gain: 0.22,
      type: "bandpass",
      q: 2,
      delay: at + d,
      attack: 0.001,
    });
  }
}

// Loop the knock on the AUDIO thread, not a JS timer. setInterval/setTimeout are
// throttled — and can be suspended outright — for hidden/background tabs, which
// is why a timer-driven knock fired once and then went silent when the tab
// wasn't focused. Here we render the knock once into a buffer padded to
// `periodSec`, then play it through a looping AudioBufferSourceNode: that keeps
// repeating on the audio rendering thread regardless of tab focus, as long as
// the context is running (the same reason chat/join cues are audible in a
// background tab). Returns a stop function.
export function startKnockLoop(ctx: AudioContext, periodSec = 1.7): () => void {
  if (ctx.state === "suspended") void ctx.resume();

  let stopped = false;
  let src: AudioBufferSourceNode | null = null;

  const frames = Math.max(1, Math.ceil(ctx.sampleRate * periodSec));
  const offline = new OfflineAudioContext(1, frames, ctx.sampleRate);
  knock(offline, 0);
  void offline.startRendering().then((buffer) => {
    if (stopped) return;
    src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(ctx.destination);
    src.start();
  });

  return () => {
    stopped = true;
    if (src) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
      src = null;
    }
  };
}
