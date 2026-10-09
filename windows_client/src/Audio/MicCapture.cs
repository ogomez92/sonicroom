using System;
using System.Collections.Generic;
using NAudio.Wave;

namespace SonicRoom.Windows.Audio;

/// <summary>
/// Captures the microphone as 48 kHz/16-bit/stereo and emits fixed frames ready for Opus
/// encoding: 20 ms (960 samples per channel) by default, 10 ms for the voice path. Uses <see cref="WaveInEvent"/> so
/// the OS/driver converts the device's native format to the requested one (WASAPI/process-loopback
/// capture arrives in a later phase).
/// </summary>
internal sealed class MicCapture : IMicrophoneCapture
{
    private readonly int _frameShorts;

    private readonly WaveInEvent _in;
    private readonly Queue<short> _acc = new();
    private readonly object _lock = new();

    /// <summary>Raised per frame (interleaved S16 stereo @ 48 kHz).</summary>
    public event Action<short[]>? FrameReady;

    /// <param name="deviceNumber">WaveIn device index; 0 = default input.</param>
    /// <param name="frameSamples">Samples per channel per emitted frame (960 = 20 ms, 480 = 10 ms).</param>
    public MicCapture(int deviceNumber = 0, int frameSamples = 960)
    {
        _frameShorts = frameSamples * 2;
        var frameMs = frameSamples * 1000 / 48000;
        _in = new WaveInEvent
        {
            WaveFormat = new WaveFormat(48000, 16, 2),
            // One driver buffer per frame, so a frame leaves as soon as it is captured;
            // the same ~80 ms of buffers queued in total either way.
            BufferMilliseconds = frameMs,
            NumberOfBuffers = 80 / frameMs,
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

            while (_acc.Count >= _frameShorts)
            {
                var frame = new short[_frameShorts];
                for (var i = 0; i < _frameShorts; i++) frame[i] = _acc.Dequeue();
                FrameReady?.Invoke(frame);
            }
        }
    }

    public void Start() => _in.StartRecording();
    public void Stop() { try { _in.StopRecording(); } catch { /* ignore */ } }
    public void Dispose() { Stop(); _in.Dispose(); }
}
