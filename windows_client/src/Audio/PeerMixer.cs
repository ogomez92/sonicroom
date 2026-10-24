using System;
using System.Collections.Generic;
using Concentus.Structs;
using NAudio.Wave;

namespace SonicRoom.Windows.Audio;

/// <summary>
/// Decodes each consumer's incoming Opus (keyed by SSRC), buffers the PCM, and mixes all sources
/// into one 48 kHz/16-bit/stereo stream for the speaker output. Per-source gain composes
/// volume × local-mute × music-duck, plus a master gain and global deafen — mirroring the web
/// client's <c>PeerAudioRegistry.effectiveGain</c>. Implements <see cref="IWaveProvider"/> so an
/// NAudio output device can pull from it directly.
///
/// Also mixes short UI cue buffers (earcons) into the output. Cues bypass master gain AND deafen
/// on purpose — a deafened user must still hear the knock-to-join loop, same as the web client
/// where cues play straight to the destination, not through the per-peer gains.
/// </summary>
public sealed class PeerMixer : IWaveProvider
{
    public WaveFormat WaveFormat { get; } = new WaveFormat(48000, 16, 2);

    // ~400 ms jitter cap: if a source runs far ahead (we fell behind), drop to bound latency.
    private const int MaxQueueShorts = 48000 * 2 * 400 / 1000;
    // WaveOut requests more than one 20 ms frame at a time. Prime enough outgoing media to fill
    // its callback instead of playing one frame followed by silence until the next callback.
    private const int LocalMediaPrebufferShorts = 960 * 2 * 6; // 120 ms

    // Peak (absolute S16) above which a decoded frame counts as "active" for the
    // speaking indicator, and how long a source stays "speaking" after its last
    // loud frame (bridges the gaps between words, like the web detector's hold).
    private const int SpeakingPeak = 700;
    private const long SpeakingHoldMs = 350;

    private sealed class Source
    {
        public required OpusDecoder Decoder;
        public readonly Queue<short> Pcm = new();
        public float Volume = 1f;
        public bool IsMusic;
        public bool LocalMuted;
        public long LastActiveMs; // Environment.TickCount64 of the last loud frame
    }

    private readonly Dictionary<uint, Source> _sources = new();
    private readonly object _lock = new();
    // Outgoing file/URL media is not echoed back by the SFU, so keep a bounded local-monitor
    // queue and mix it into the selected speaker output alongside incoming peers.
    private readonly Queue<short> _localMedia = new();
    private bool _localMediaPrimed;

    // Currently-playing cue buffers (interleaved S16 stereo @48k) with a play cursor each.
    // A List because cues can overlap (a chat chime during the knock loop).
    private readonly List<(short[] Pcm, int Pos)> _cues = new();

    public float MasterGain { get; set; } = 1f;
    public bool Deafened { get; set; }
    public bool DuckActive { get; set; }
    /// <summary>Room-wide auto-ducking toggle: with it off, music never dips under voice.</summary>
    public bool DuckingEnabled { get; set; } = true;
    public float DuckFactor { get; set; } = 0.22f;

    // Get-or-create so per-source state (volume/music/local-mute) set at consume time
    // sticks even before the first RTP packet arrives and creates the decoder path.
    private Source GetOrAdd(uint ssrc)
    {
        if (!_sources.TryGetValue(ssrc, out var src))
        {
            src = new Source { Decoder = new OpusDecoder(48000, 2) };
            _sources[ssrc] = src;
        }
        return src;
    }

    /// <summary>Decode one incoming Opus packet and enqueue its PCM (call from the RTP thread).</summary>
    public void OnOpusPacket(uint ssrc, byte[] payload)
    {
        Source src;
        lock (_lock) src = GetOrAdd(ssrc);

        var pcm = new short[960 * 2];
        int n;
        try { n = src.Decoder.Decode(payload, 0, payload.Length, pcm, 0, 960, false); }
        catch { return; }

        var peak = 0;
        for (var i = 0; i < n * 2; i++) { var a = Math.Abs((int)pcm[i]); if (a > peak) peak = a; }

        lock (_lock)
        {
            if (peak > SpeakingPeak) src.LastActiveMs = Environment.TickCount64;
            if (src.Pcm.Count > MaxQueueShorts) src.Pcm.Clear();
            for (var i = 0; i < n * 2; i++) src.Pcm.Enqueue(pcm[i]);
        }
    }

    public int Read(byte[] buffer, int offset, int count)
    {
        var frames = count / 4; // stereo 16-bit
        lock (_lock)
        {
            for (var f = 0; f < frames; f++)
            {
                int left = 0, right = 0;
                if (_localMediaPrimed && _localMedia.Count >= 2)
                {
                    var mediaLeft = _localMedia.Dequeue();
                    var mediaRight = _localMedia.Dequeue();
                    if (!Deafened)
                    {
                        var mediaGain = DuckActive && DuckingEnabled ? DuckFactor : 1f;
                        left += (int)(mediaLeft * mediaGain);
                        right += (int)(mediaRight * mediaGain);
                    }
                }
                else if (_localMediaPrimed) _localMediaPrimed = false;
                if (!Deafened)
                {
                    foreach (var s in _sources.Values)
                    {
                        if (s.LocalMuted || s.Pcm.Count < 2) continue;
                        var g = s.Volume;
                        if (s.IsMusic && DuckActive && DuckingEnabled) g *= DuckFactor;
                        left += (int)(s.Pcm.Dequeue() * g);
                        right += (int)(s.Pcm.Dequeue() * g);
                    }
                }

                left = (int)(left * MasterGain);
                right = (int)(right * MasterGain);

                // Cues ride on top, unaffected by master/deafen (see class doc).
                for (var c = _cues.Count - 1; c >= 0; c--)
                {
                    var (pcm, pos) = _cues[c];
                    if (pos + 1 < pcm.Length)
                    {
                        left += pcm[pos];
                        right += pcm[pos + 1];
                        _cues[c] = (pcm, pos + 2);
                    }
                    else _cues.RemoveAt(c);
                }

                var ls = (short)Math.Clamp(left, short.MinValue, short.MaxValue);
                var rs = (short)Math.Clamp(right, short.MinValue, short.MaxValue);

                var p = offset + f * 4;
                buffer[p] = (byte)ls; buffer[p + 1] = (byte)(ls >> 8);
                buffer[p + 2] = (byte)rs; buffer[p + 3] = (byte)(rs >> 8);
            }
        }
        return count; // always full; silence where there's nothing to mix
    }

    /// <summary>Start playing a cue buffer (interleaved S16 stereo @48 kHz) over the mix.</summary>
    public void PlayCue(short[] pcm)
    {
        if (pcm.Length < 2) return;
        lock (_lock) _cues.Add((pcm, 0));
    }

    /// <summary>Queue outgoing media PCM for local monitoring (interleaved S16 stereo @48 kHz).</summary>
    public void QueueLocalMedia(short[] pcm)
    {
        lock (_lock)
        {
            if (_localMedia.Count + pcm.Length > MaxQueueShorts)
            {
                _localMedia.Clear();
                _localMediaPrimed = false;
            }
            for (var i = 0; i < pcm.Length; i++) _localMedia.Enqueue(pcm[i]);
            if (_localMedia.Count >= LocalMediaPrebufferShorts) _localMediaPrimed = true;
        }
    }

    public void ClearLocalMedia()
    {
        lock (_lock)
        {
            _localMedia.Clear();
            _localMediaPrimed = false;
        }
    }

    /// <summary>Whether this source decoded a loud frame within the speaking hold window.</summary>
    public bool IsActive(uint ssrc)
    {
        lock (_lock)
            return _sources.TryGetValue(ssrc, out var s)
                   && Environment.TickCount64 - s.LastActiveMs < SpeakingHoldMs;
    }

    public void SetVolume(uint ssrc, float volume) { lock (_lock) GetOrAdd(ssrc).Volume = volume; }
    public void SetMusic(uint ssrc, bool isMusic) { lock (_lock) GetOrAdd(ssrc).IsMusic = isMusic; }
    public void SetLocalMuted(uint ssrc, bool muted) { lock (_lock) GetOrAdd(ssrc).LocalMuted = muted; }
    public void RemoveSource(uint ssrc) { lock (_lock) { _sources.Remove(ssrc); } }
}
