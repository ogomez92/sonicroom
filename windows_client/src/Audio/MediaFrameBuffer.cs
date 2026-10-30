using System.Collections.Generic;

namespace SonicRoom.Windows.Audio;

/// <summary>Outcome of a paced <see cref="MediaFrameBuffer.TryRead"/>.</summary>
public enum MediaFrameRead
{
    /// <summary>A frame was returned — play/send it now.</summary>
    Frame,
    /// <summary>A frame was returned after (re)buffering — play/send it AND re-anchor the
    /// pacing clock, so the stall doesn't register as accumulated lag to "catch up" on.</summary>
    Resumed,
    /// <summary>(Re)buffering — the prebuffer hasn't filled yet. Send nothing and poll again.</summary>
    Buffering,
    /// <summary>End of stream: the producer completed and every frame has been drained.</summary>
    Ended,
}

/// <summary>
/// Bounded decode-ahead buffer between the media decoder and the paced sender: FFmpeg fills it
/// with 20 ms PCM frames as fast as it can decode (network reads included), while the real-time
/// pacing loop drains it. Playback gates on a prebuffer threshold both at start and after a
/// mid-stream underrun, so a network hiccup or slow decoder warm-up becomes a clean silent pause
/// instead of an audible stutter — locally and for remote listeners alike.
/// </summary>
public sealed class MediaFrameBuffer
{
    /// <summary>Decode-ahead cap: ~5 s at 20 ms/frame (≈960 KB of stereo S16 @48 kHz).</summary>
    public const int MaxFrames = 250;
    /// <summary>Frames buffered before playback (re)starts: ~2 s, or EOF for shorter media.</summary>
    public const int PrebufferFrames = 100;

    private readonly Queue<short[]> _frames = new();
    private readonly object _lock = new();
    private bool _buffering = true; // gate playback until the prebuffer fills (or EOF)
    private bool _completed;

    /// <summary>Producer backpressure: once true, pause decoding until playback drains a bit.</summary>
    public bool IsFull { get { lock (_lock) return _frames.Count >= MaxFrames; } }

    /// <summary>The producer finished (EOF or error) — no more frames are coming.</summary>
    public bool IsCompleted { get { lock (_lock) return _completed; } }

    /// <summary>Frames currently buffered ahead of playback (for diagnostics/tests).</summary>
    public int Count { get { lock (_lock) return _frames.Count; } }

    /// <summary>Add one decoded 20 ms frame (producer side).</summary>
    public void Enqueue(short[] frame) { lock (_lock) _frames.Enqueue(frame); }

    /// <summary>Mark the stream finished — buffered frames still drain, then reads end.</summary>
    public void Complete() { lock (_lock) _completed = true; }

    /// <summary>Take the next frame for paced playback (consumer side). While (re)buffering
    /// this returns <see cref="MediaFrameRead.Buffering"/> with no frame — send nothing rather
    /// than garbage — until ~2 s has re-accumulated (or the stream completed).</summary>
    public MediaFrameRead TryRead(out short[]? frame)
    {
        frame = null;
        lock (_lock)
        {
            if (_buffering)
            {
                if (_frames.Count < PrebufferFrames && !_completed) return MediaFrameRead.Buffering;
                _buffering = false;
                if (_frames.Count == 0) return MediaFrameRead.Ended; // completed while empty
                frame = _frames.Dequeue();
                return MediaFrameRead.Resumed;
            }
            if (_frames.Count > 0)
            {
                frame = _frames.Dequeue();
                return MediaFrameRead.Frame;
            }
            if (_completed) return MediaFrameRead.Ended;
            _buffering = true; // mid-stream underrun: go quiet until headroom returns
            return MediaFrameRead.Buffering;
        }
    }
}
