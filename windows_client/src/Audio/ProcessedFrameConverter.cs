using System;
using System.Collections.Generic;
using NAudio.Dsp;

namespace SonicRoom.Windows.Audio;

/// <summary>
/// Aggregates 16 kHz mono S16 DSP output, resamples it with NAudio's WDL resampler, and emits
/// exact 10 ms 48 kHz frames using the client's existing interleaved-stereo contract. 10 ms
/// matches the voice path's Opus frame (see RoomSession.VoiceFrameSamples): a 20 ms frame
/// cannot be sent until 20 ms of speech has been captured.
/// </summary>
internal sealed class ProcessedFrameConverter
{
    internal const int InputSamplesPerFrame = 160;
    internal const int OutputSamplesPerChannel = 480;
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
                throw new InvalidOperationException($"WDL requested {requested} samples instead of {InputSamplesPerFrame}.");

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
