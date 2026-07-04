using System;
using System.Collections.Generic;
using NAudio.Wave;

namespace SonicRoom.Windows.Audio;

/// <summary>
/// Captures the microphone as 48 kHz/16-bit/stereo and emits fixed 20 ms frames (960 samples per
/// channel = 1920 interleaved shorts) ready for Opus encoding. Uses <see cref="WaveInEvent"/> so
/// the OS/driver converts the device's native format to the requested one (WASAPI/process-loopback
/// capture arrives in a later phase).
/// </summary>
public sealed class MicCapture : IDisposable
{
    private const int FrameShorts = 960 * 2;

    private readonly WaveInEvent _in;
    private readonly Queue<short> _acc = new();
    private readonly object _lock = new();

    /// <summary>Raised per 20 ms frame (1920 interleaved S16 stereo samples @ 48 kHz).</summary>
    public event Action<short[]>? FrameReady;

    /// <param name="deviceNumber">WaveIn device index; 0 = default input.</param>
    public MicCapture(int deviceNumber = 0)
    {
        _in = new WaveInEvent
        {
            WaveFormat = new WaveFormat(48000, 16, 2),
            BufferMilliseconds = 20,
            NumberOfBuffers = 4,
            DeviceNumber = deviceNumber,
        };
        _in.DataAvailable += OnData;
    }

    private void OnData(object? sender, WaveInEventArgs e)
    {
        lock (_lock)
        {
            for (var i = 0; i + 1 < e.BytesRecorded; i += 2)
                _acc.Enqueue((short)(e.Buffer[i] | (e.Buffer[i + 1] << 8)));

            while (_acc.Count >= FrameShorts)
            {
                var frame = new short[FrameShorts];
                for (var i = 0; i < FrameShorts; i++) frame[i] = _acc.Dequeue();
                FrameReady?.Invoke(frame);
            }
        }
    }

    public void Start() => _in.StartRecording();
    public void Stop() { try { _in.StopRecording(); } catch { /* ignore */ } }
    public void Dispose() { Stop(); _in.Dispose(); }
}
