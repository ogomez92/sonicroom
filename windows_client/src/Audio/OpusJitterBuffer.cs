using System;
using System.Collections.Generic;
using Concentus.Structs;

namespace SonicRoom.Windows.Audio;

/// <summary>
/// Per-source Opus jitter buffer: reorders by RTP sequence number, rebuilds lost
/// packets (in-band FEC from the next packet when present, otherwise Opus packet
/// loss concealment), and keeps the playout delay small and bounded.
///
/// It replaces a plain PCM queue that had no target depth: when a sender's clock
/// ran slightly fast the queue grew to 400 ms and was then cleared in one go —
/// latency that crept up to 400 ms followed by a 400 ms dropout, over and over —
/// and a late or lost packet was simply a hole of silence.
///
/// Delay policy (all time is counted in samples pulled, so it is deterministic
/// and testable): start a talk spurt once <see cref="TargetMs"/> is buffered;
/// an underrun mid-stream raises the target by 20 ms (max 200 ms); 15 s without
/// one lowers it by 10 ms (min 20 ms). Audio more than 60 ms above target is
/// trimmed ONE frame per pull, never in a block.
///
/// Not thread-safe: the owner (<see cref="PeerMixer"/>) serialises Push and Pull.
/// </summary>
public sealed class OpusJitterBuffer
{
    public const int SampleRate = 48000;
    public const int Channels = 2;
    public const int MinTargetMs = 20;
    public const int MaxTargetMs = 200;
    public const int StartTargetMs = 40;
    private const int TrimMarginMs = 60;
    private const int StableSamples = SampleRate * 15;
    private const int MaxConcealFrames = 3;        // then treat the source as stopped
    private const int MaxFrameSamples = 5760;      // 120 ms, the Opus maximum
    // A dry spell shorter than this was network jitter; a longer one was the sender
    // pausing (mute pauses the voice producer) and must not raise the target.
    private const int MaxJitterGapSamples = SampleRate / 4;

    private readonly OpusDecoder _decoder = new(SampleRate, Channels);
    private readonly SortedDictionary<long, byte[]> _packets = new();
    private readonly short[] _scratch = new short[MaxFrameSamples * Channels];
    private short[] _pcm = new short[SampleRate * Channels];   // decoded, not yet played
    private int _pcmLen;                                        // interleaved shorts

    private bool _playing;
    private long _nextSeq;
    private long _highestSeq = -1;
    private int _frameSamples = 480;   // last decoded frame size (10 ms default)
    private int _emptyPulls;
    private long _samplesSinceUnderrun;
    private bool _dry;
    private long _drySamples;

    public int TargetMs { get; private set; } = StartTargetMs;
    public long Concealed { get; private set; }
    public long FecRecovered { get; private set; }
    public long LatePackets { get; private set; }
    public long Trimmed { get; private set; }
    public long Underruns { get; private set; }

    /// <summary>Buffered audio (decoded + queued packets) in milliseconds.</summary>
    public int BufferedMs =>
        (_pcmLen / Channels + _packets.Count * _frameSamples) * 1000 / SampleRate;

    /// <summary>Queue one RTP payload. <paramref name="seq"/> is the 16-bit RTP sequence.</summary>
    public void Push(ushort seq, byte[] payload)
    {
        if (payload.Length == 0) return;
        var ext = Extend(seq);
        if (_dry)
        {
            _dry = false;
            if (_drySamples <= MaxJitterGapSamples) OnUnderrun();
        }
        if (_playing && ext < _nextSeq) { LatePackets++; return; }   // already concealed
        if (ext > _highestSeq) _highestSeq = ext;
        _packets[ext] = payload;
    }

    // Unwrap a 16-bit sequence number to the 64-bit one nearest the highest seen.
    private long Extend(ushort seq)
    {
        if (_highestSeq < 0) return seq;
        var cycle = _highestSeq & ~0xFFFFL;
        var cand = cycle | seq;
        if (cand - _highestSeq > 0x8000) cand -= 0x10000;
        else if (_highestSeq - cand > 0x8000) cand += 0x10000;
        return cand;
    }

    /// <summary>
    /// Fill <paramref name="dest"/> with <paramref name="frames"/> stereo frames.
    /// Returns how many frames were real or concealed audio; the rest are zeros.
    /// </summary>
    public int Pull(short[] dest, int frames)
    {
        var need = frames * Channels;
        while (_pcmLen < need && Produce()) { }

        var have = Math.Min(need, _pcmLen);
        Array.Copy(_pcm, 0, dest, 0, have);
        Array.Clear(dest, have, need - have);
        Array.Copy(_pcm, have, _pcm, 0, _pcmLen - have);
        _pcmLen -= have;

        _samplesSinceUnderrun += frames;
        if (_dry) _drySamples += frames;
        if (_samplesSinceUnderrun >= StableSamples && TargetMs > MinTargetMs)
        {
            TargetMs = Math.Max(MinTargetMs, TargetMs - 10);
            _samplesSinceUnderrun = 0;
        }
        TrimExcess();
        return have / Channels;
    }

    // Decode (or conceal) one frame into _pcm. False when there is nothing to add.
    private bool Produce()
    {
        if (!_playing)
        {
            if (_packets.Count == 0 || BufferedMs < TargetMs) return false;
            _playing = true;
            _emptyPulls = 0;
            foreach (var k in _packets.Keys) { _nextSeq = k; break; }
        }

        if (_packets.Remove(_nextSeq, out var payload))
        {
            _emptyPulls = 0;
            _nextSeq++;
            return Decode(payload, fec: false);
        }

        if (_packets.Count > 0)
        {
            // A gap with later packets behind it: the packet is lost (or so late
            // that waiting would stall everyone). Rebuild it from the next
            // packet's FEC data if it carries any, otherwise conceal.
            var recovered = _packets.TryGetValue(_nextSeq + 1, out var next)
                            && Decode(next, fec: true);
            if (recovered) FecRecovered++;
            else { Conceal(); Concealed++; }
            _nextSeq++;
            return true;
        }

        // Nothing queued at all: the buffer ran dry mid-stream. Bridge a short
        // gap, then treat it as the end of the stream and rebuffer to the target
        // before playing again. Whether it was jitter (raise the target) or the
        // sender pausing (mute — don't) is only known when packets resume: Push.
        if (_emptyPulls == 0) { _dry = true; _drySamples = 0; }
        if (++_emptyPulls <= MaxConcealFrames)
        {
            Conceal();
            Concealed++;
            _nextSeq++;
            return true;
        }
        _playing = false;
        return false;
    }

    private bool Decode(byte[] payload, bool fec)
    {
        try
        {
            var size = fec ? _frameSamples
                : Math.Clamp(OpusPacketInfo.GetNumSamples(_decoder, payload, 0, payload.Length),
                             120, MaxFrameSamples);
            var n = _decoder.Decode(payload, 0, payload.Length, _scratch, 0, size, fec);
            if (n <= 0) return false;
            if (!fec) _frameSamples = n;
            Append(n);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private void Conceal()
    {
        int n;
        try { n = _decoder.Decode(null, 0, 0, _scratch, 0, _frameSamples, false); }
        catch { n = 0; }
        if (n <= 0)
        {
            n = _frameSamples;
            Array.Clear(_scratch, 0, n * Channels);
        }
        Append(n);
    }

    private void Append(int frames)
    {
        var len = frames * Channels;
        if (_pcmLen + len > _pcm.Length) Array.Resize(ref _pcm, (_pcmLen + len) * 2);
        Array.Copy(_scratch, 0, _pcm, _pcmLen, len);
        _pcmLen += len;
    }

    private void OnUnderrun()
    {
        Underruns++;
        TargetMs = Math.Min(MaxTargetMs, TargetMs + 20);
        _samplesSinceUnderrun = 0;
    }

    // Keep the delay near the target: drop the oldest queued packet (one frame)
    // per pull when far above it, so a fast sender clock cannot build latency.
    private void TrimExcess()
    {
        if (!_playing || BufferedMs <= TargetMs + TrimMarginMs) return;
        if (_packets.Count > 0)
        {
            foreach (var k in _packets.Keys)
            {
                _packets.Remove(k);
                if (k >= _nextSeq) _nextSeq = k + 1;
                break;
            }
        }
        else
        {
            var drop = Math.Min(_pcmLen, _frameSamples * Channels);
            Array.Copy(_pcm, drop, _pcm, 0, _pcmLen - drop);
            _pcmLen -= drop;
        }
        Trimmed++;
    }
}
