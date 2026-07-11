using System;
using System.Collections.Generic;
using NAudio.Dsp;

namespace SonicRoom.Windows.Audio;

/// <summary>
/// Aggregates 16 kHz mono S16 DSP output, resamples it with NAudio's WDL resampler, and emits
/// exact 20 ms 48 kHz frames using the client's existing interleaved-stereo contract.
/// </summary>
internal sealed class ProcessedFrameConverter
{
    internal const int InputSamplesPerFrame = 320;
    internal const int OutputSamplesPerChannel = 960;
    internal const int OutputShorts = OutputSamplesPerChannel * 2;

    private readonly Queue<short> _input = new();
    private readonly Queue<float> _output = new();
    private readonly WdlResampler _resampler = new();
    private readonly float[] _resampled = new float[1024];

    public ProcessedFrameConverter()
    {
        _resampler.SetMode(interp: true, filtercnt: 2, sinc: false);
        _resampler.SetFeedMode(wantInputDriven: true);
        _resampler.SetRates(16000, 48000);
    }

    public IEnumerable<short[]> AddPcm16(byte[] buffer, int count)
    {
        for (var i = 0; i + 1 < count; i += 2)
            _input.Enqueue((short)(buffer[i] | buffer[i + 1] << 8));

        while (_input.Count >= InputSamplesPerFrame)
        {
            var requested = _resampler.ResamplePrepare(InputSamplesPerFrame, 1,
                out var input, out var offset);
            if (requested != InputSamplesPerFrame)
                throw new InvalidOperationException($"WDL requested {requested} samples instead of 320.");

            for (var i = 0; i < InputSamplesPerFrame; i++)
                input[offset + i] = _input.Dequeue() / 32768f;

            var produced = _resampler.ResampleOut(_resampled, 0, InputSamplesPerFrame,
                _resampled.Length, 1);
            for (var i = 0; i < produced; i++) _output.Enqueue(_resampled[i]);

            while (_output.Count >= OutputSamplesPerChannel)
            {
                var frame = new short[OutputShorts];
                for (var i = 0; i < OutputSamplesPerChannel; i++)
                {
                    var sample = (short)Math.Clamp(
                        (int)MathF.Round(_output.Dequeue() * 32768f), short.MinValue, short.MaxValue);
                    frame[2 * i] = sample;
                    frame[2 * i + 1] = sample;
                }
                yield return frame;
            }
        }
    }
}
