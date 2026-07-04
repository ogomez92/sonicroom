using System;
using System.Collections.Generic;
using System.Linq;
using NAudio.Wave;

namespace SonicRoom.Windows.Audio;

/// <summary>
/// Per-app audio share bus. Include mode: one <see cref="ProcessLoopbackCapture"/> per target PID,
/// mixed together. Exclude mode: a single capture of everything-except one PID. All sources are
/// 48 kHz/16-bit/stereo; <see cref="MixInto"/> sums them into the outgoing 20 ms frame just before
/// Opus encoding, so the shared audio rides the voice producer (v1 — a separate share tile is a
/// later enhancement).
/// </summary>
public sealed class ShareBus : IDisposable
{
    private const int MaxQueueShorts = 48000 * 2 * 400 / 1000; // ~400 ms cap

    private sealed class Src
    {
        public required ProcessLoopbackCapture Capture;
        public readonly Queue<short> Pcm = new();
    }

    private readonly List<Src> _sources = new();
    private readonly object _lock = new();

    public bool Active { get; private set; }
    public float Gain { get; set; } = 1f;
    public event Action<string>? Log;

    /// <summary>Include the given PIDs (a capture each), or exclude a single PID (one capture).</summary>
    public void Start(IReadOnlyList<uint> pids, bool includeMode)
    {
        Stop();
        if (!ProcessLoopbackCapture.IsSupported) { Log?.Invoke("process loopback requires Windows 10 build 20348+"); return; }

        lock (_lock)
        {
            var targets = includeMode ? pids : pids.Take(1).ToList(); // exclude targets exactly one tree
            foreach (var pid in targets)
            {
                var cap = new ProcessLoopbackCapture(pid, includeMode);
                var src = new Src { Capture = cap };
                cap.DataAvailable += (_, e) => OnData(src, e);
                cap.CaptureFaulted += (_, ex) => Log?.Invoke($"capture {pid} faulted: {ex.Message}");
                try { cap.Start(); _sources.Add(src); Log?.Invoke($"capturing pid {pid} ({(includeMode ? "include" : "exclude")})"); }
                catch (Exception ex) { Log?.Invoke($"capture {pid} start failed: {ex.Message}"); cap.Dispose(); }
            }
            Active = _sources.Count > 0;
        }
    }

    private void OnData(Src src, WaveInEventArgs e)
    {
        lock (_lock)
        {
            if (src.Pcm.Count > MaxQueueShorts) src.Pcm.Clear();
            for (var i = 0; i + 1 < e.BytesRecorded; i += 2)
                src.Pcm.Enqueue((short)(e.Buffer[i] | (e.Buffer[i + 1] << 8)));
        }
    }

    /// <summary>Sum available app audio into an existing 20 ms stereo frame (1920 interleaved shorts).</summary>
    public void MixInto(short[] frame)
    {
        if (!Active) return;
        lock (_lock)
        {
            for (var i = 0; i < frame.Length; i++)
            {
                int sum = frame[i];
                foreach (var s in _sources)
                    if (s.Pcm.Count > 0) sum += (int)(s.Pcm.Dequeue() * Gain);
                frame[i] = (short)Math.Clamp(sum, short.MinValue, short.MaxValue);
            }
        }
    }

    public void Stop()
    {
        lock (_lock)
        {
            foreach (var s in _sources) s.Capture.Dispose();
            _sources.Clear();
            Active = false;
        }
    }

    public void Dispose() => Stop();
}
