using System;
using System.Collections.Generic;

namespace SonicRoom.Windows.Audio;

/// <summary>Which UI cue (earcon) to play. Mirrors the web client's <c>lib/sounds.ts</c> set.</summary>
public enum Cue
{
    Mute,
    Unmute,
    Join,
    Leave,
    Message,
    ShareStart,
    ShareStop,
    Knock,
    PeerMute,
    PeerUnmute,
}

/// <summary>
/// Offline synthesizer for the UI cues, porting the web client's WebAudio voices
/// (<c>client/src/lib/sounds.ts</c>) to plain sample math: sine/triangle tones with pitch
/// glides and click-free envelopes, 2-operator FM bells, and filtered white-noise bursts.
/// Each cue renders once (mono, 48 kHz) into a cached interleaved-stereo S16 buffer that
/// <see cref="PeerMixer.PlayCue"/> mixes over the call audio.
/// </summary>
public static class Cues
{
    private const int Rate = 48000;

    private static readonly Dictionary<Cue, short[]> Cache = new();
    private static readonly object Lock = new();

    public static short[] Render(Cue cue)
    {
        lock (Lock)
        {
            if (Cache.TryGetValue(cue, out var cached)) return cached;
            var mono = RenderMono(cue);
            var stereo = new short[mono.Length * 2];
            for (var i = 0; i < mono.Length; i++)
            {
                var s = (short)Math.Clamp((int)(mono[i] * 32767f), short.MinValue, short.MaxValue);
                stereo[i * 2] = s;
                stereo[i * 2 + 1] = s;
            }
            Cache[cue] = stereo;
            return stereo;
        }
    }

    private static float[] RenderMono(Cue cue)
    {
        switch (cue)
        {
            // Self mute/unmute: sustained pitch SLIDES — a mellow triangle sweeping the whole
            // range with a faint octave on top. Up = unmute, down = mute.
            case Cue.Unmute:
            {
                var buf = NewBuf(0.26);
                Tone(buf, freq: 320, glideTo: 680, dur: 0.22, Wave.Triangle, gain: 0.22, attack: 0.02, release: 0.06);
                Tone(buf, freq: 640, glideTo: 1360, dur: 0.22, Wave.Sine, gain: 0.06, attack: 0.02, release: 0.06);
                return buf;
            }
            case Cue.Mute:
            {
                var buf = NewBuf(0.26);
                Tone(buf, freq: 680, glideTo: 300, dur: 0.22, Wave.Triangle, gain: 0.22, attack: 0.02, release: 0.06);
                Tone(buf, freq: 1360, glideTo: 600, dur: 0.22, Wave.Sine, gain: 0.06, attack: 0.02, release: 0.06);
                return buf;
            }
            // Someone enters → doorbell: descending two-tone "ding-dong" of inharmonic FM bells.
            case Cue.Join:
            {
                var buf = NewBuf(1.0);
                Bell(buf, freq: 660, dur: 0.5, gain: 0.24, ratio: 1.41f, index: 4);
                Bell(buf, freq: 523, dur: 0.62, gain: 0.24, ratio: 1.41f, index: 4, delay: 0.32);
                return buf;
            }
            // Someone leaves → a door easing shut: hard wooden thunk + latch click + rattle
            // (the web's hinge creak is simplified to a short descending grind).
            case Cue.Leave:
            {
                var buf = NewBuf(0.55);
                Tone(buf, freq: 300, glideTo: 150, dur: 0.42, Wave.Triangle, gain: 0.12, attack: 0.04, release: 0.06);
                Tone(buf, freq: 175, glideTo: 70, dur: 0.09, Wave.Sine, gain: 0.32, delay: 0.42, attack: 0.002);
                Noise(buf, dur: 0.06, freq: 320, gain: 0.22, Filter.LowPass, q: 0.8f, delay: 0.42, attack: 0.002);
                Noise(buf, dur: 0.018, freq: 2900, gain: 0.3, Filter.BandPass, q: 3f, delay: 0.43);
                Noise(buf, dur: 0.03, freq: 1850, gain: 0.2, Filter.BandPass, q: 2f, delay: 0.46);
                return buf;
            }
            // Incoming chat: two-note glassy chime (ascending fifth), harmonic FM.
            case Cue.Message:
            {
                var buf = NewBuf(0.6);
                Bell(buf, freq: 880, dur: 0.32, gain: 0.18, ratio: 2f, index: 2);
                Bell(buf, freq: 1320, dur: 0.42, gain: 0.18, ratio: 2f, index: 2, delay: 0.1);
                return buf;
            }
            // Audio share toggled: soft triangle arpeggio — rising when a share starts,
            // falling when it stops (C5-E5-G5 and back).
            case Cue.ShareStart:
            {
                var buf = NewBuf(0.35);
                Tone(buf, freq: 523, glideTo: 0, dur: 0.09, Wave.Triangle, gain: 0.12);
                Tone(buf, freq: 659, glideTo: 0, dur: 0.09, Wave.Triangle, gain: 0.12, delay: 0.08);
                Tone(buf, freq: 784, glideTo: 0, dur: 0.13, Wave.Triangle, gain: 0.12, delay: 0.16);
                return buf;
            }
            case Cue.ShareStop:
            {
                var buf = NewBuf(0.35);
                Tone(buf, freq: 784, glideTo: 0, dur: 0.09, Wave.Triangle, gain: 0.12);
                Tone(buf, freq: 659, glideTo: 0, dur: 0.09, Wave.Triangle, gain: 0.12, delay: 0.08);
                Tone(buf, freq: 523, glideTo: 0, dur: 0.13, Wave.Triangle, gain: 0.12, delay: 0.16);
                return buf;
            }
            // Someone is asking to be let in → three hard, rapid raps on the door: each a
            // low pitch-dropping thud + wooden lowpass body + bright knuckle crack.
            case Cue.Knock:
            {
                var buf = NewBuf(0.45);
                foreach (var d in new[] { 0.0, 0.13, 0.26 })
                {
                    Tone(buf, freq: 220, glideTo: 80, dur: 0.08, Wave.Sine, gain: 0.34, delay: d, attack: 0.001);
                    Noise(buf, dur: 0.06, freq: 800, gain: 0.26, Filter.LowPass, q: 0.8f, delay: d, attack: 0.001);
                    Noise(buf, dur: 0.02, freq: 2600, gain: 0.22, Filter.BandPass, q: 2f, delay: d, attack: 0.001);
                }
                return buf;
            }
            // A REMOTE peer toggled their mic — short, soft blip (down = muted, up = unmuted),
            // quieter/briefer than the self mute/unmute slides.
            case Cue.PeerMute:
            {
                var buf = NewBuf(0.16);
                Tone(buf, freq: 520, glideTo: 340, dur: 0.12, Wave.Triangle, gain: 0.1, release: 0.05);
                return buf;
            }
            case Cue.PeerUnmute:
            default:
            {
                var buf = NewBuf(0.16);
                Tone(buf, freq: 340, glideTo: 520, dur: 0.12, Wave.Triangle, gain: 0.1, release: 0.05);
                return buf;
            }
        }
    }

    // ---- the mini synth ----------------------------------------------------------------

    private enum Wave { Sine, Triangle }
    private enum Filter { LowPass, BandPass }

    private static float[] NewBuf(double seconds) => new float[(int)(Rate * seconds)];

    /// <summary>Oscillator with optional exponential pitch glide and click-free envelope
    /// (fast fade-in; exponential fade-out, or hold-then-release when <paramref name="release"/>
    /// is set — the web's sustained-slide shape).</summary>
    private static void Tone(float[] buf, double freq, double glideTo, double dur, Wave wave,
        double gain, double delay = 0, double attack = 0.012, double release = -1)
    {
        var start = (int)(delay * Rate);
        var n = (int)(dur * Rate);
        var phase = 0.0;
        for (var i = 0; i < n && start + i < buf.Length; i++)
        {
            var t = (double)i / n;
            var f = glideTo > 0 ? freq * Math.Pow(glideTo / freq, t) : freq;
            phase += 2 * Math.PI * f / Rate;
            var raw = wave == Wave.Sine
                ? Math.Sin(phase)
                : 2.0 / Math.PI * Math.Asin(Math.Sin(phase)); // triangle
            buf[start + i] += (float)(raw * gain * Envelope(i / (double)Rate, dur, attack, release));
        }
    }

    /// <summary>2-operator FM bell: sine carrier modulated by a sine at <c>freq*ratio</c> whose
    /// depth decays fast (bright strike settling into a pure ring) while the amplitude decays
    /// slowly — the web's <c>bell()</c>.</summary>
    private static void Bell(float[] buf, double freq, double dur, double gain, float ratio,
        float index, double delay = 0)
    {
        var start = (int)(delay * Rate);
        var n = (int)(dur * Rate);
        double carrierPhase = 0, modPhase = 0;
        var depth0 = freq * ratio * index;
        for (var i = 0; i < n && start + i < buf.Length; i++)
        {
            var t = (double)i / n;
            // Modulation depth: exponential decay to 2% over the first half, then flat.
            var depth = depth0 * Math.Pow(0.02, Math.Min(1.0, t * 2));
            modPhase += 2 * Math.PI * freq * ratio / Rate;
            var instFreq = freq + Math.Sin(modPhase) * depth;
            carrierPhase += 2 * Math.PI * instFreq / Rate;
            // Amplitude: 6 ms attack then exponential ring-down over the full duration.
            var sec = i / (double)Rate;
            var env = sec < 0.006 ? sec / 0.006 : Math.Pow(0.0005, (sec - 0.006) / dur);
            buf[start + i] += (float)(Math.Sin(carrierPhase) * gain * env);
        }
    }

    /// <summary>Filtered white-noise burst (biquad low/band-pass) — thuds, clicks, rattles.</summary>
    private static void Noise(float[] buf, double dur, double freq, double gain, Filter type,
        float q, double delay = 0, double attack = 0.005)
    {
        var start = (int)(delay * Rate);
        var n = (int)(dur * Rate);
        var rng = new Random(unchecked((int)(freq * 31 + dur * 1e6))); // deterministic per voice
        // Biquad coefficients (RBJ cookbook).
        var w0 = 2 * Math.PI * freq / Rate;
        var alpha = Math.Sin(w0) / (2 * q);
        var cosw0 = Math.Cos(w0);
        double b0, b1, b2;
        if (type == Filter.LowPass)
        {
            b0 = (1 - cosw0) / 2; b1 = 1 - cosw0; b2 = (1 - cosw0) / 2;
        }
        else
        {
            b0 = alpha; b1 = 0; b2 = -alpha;
        }
        double a0 = 1 + alpha, a1 = -2 * cosw0, a2 = 1 - alpha;
        double x1 = 0, x2 = 0, y1 = 0, y2 = 0;

        for (var i = 0; i < n && start + i < buf.Length; i++)
        {
            var x0 = rng.NextDouble() * 2 - 1;
            var y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
            x2 = x1; x1 = x0; y2 = y1; y1 = y0;
            buf[start + i] += (float)(y0 * gain * Envelope(i / (double)Rate, dur, attack, -1));
        }
    }

    /// <summary>Click-free gain envelope: linear-ish fast attack, exponential decay to silence —
    /// or hold at full level until <c>dur - release</c> when a release is given.</summary>
    private static double Envelope(double sec, double dur, double attack, double release)
    {
        if (sec < attack) return sec / attack;
        if (release > 0)
        {
            var holdEnd = Math.Max(attack, dur - release);
            if (sec < holdEnd) return 1;
            return Math.Pow(0.001, (sec - holdEnd) / release);
        }
        return Math.Pow(0.001, (sec - attack) / Math.Max(0.001, dur - attack));
    }
}
