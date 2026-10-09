using System;
using System.Threading;
using NAudio.Wave;
using SonicRoom.Windows.Audio;

var seconds = args.Length > 0 && int.TryParse(args[0], out var parsed) ? Math.Clamp(parsed, 2, 60) : 10;
var renderBuffer = new BufferedWaveProvider(new WaveFormat(48000, 16, 2))
{
    ReadFully = true,
    BufferDuration = TimeSpan.FromSeconds(1),
};
using var render = new WaveOutEvent { DesiredLatency = 100, DeviceNumber = -1 };
render.Init(renderBuffer);
render.Play();

var captureDevice = VoiceDeviceMapper.MapCapture(-1);
var renderDevice = VoiceDeviceMapper.MapRender(-1);
using var capture = new ProcessedMicCapture(captureDevice.EndpointIndex, renderDevice.EndpointIndex);
using var completed = new ManualResetEventSlim();
var frames = 0;
var nonzeroFrames = 0;
Exception? failure = null;

capture.FrameReady += frame =>
{
    if (frame.Length != ProcessedFrameConverter.OutputShorts)
    {
        failure = new InvalidOperationException($"Unexpected frame size: {frame.Length} shorts.");
        completed.Set();
        return;
    }
    for (var i = 0; i < ProcessedFrameConverter.OutputSamplesPerChannel; i++)
        if (frame[2 * i] != frame[2 * i + 1])
        {
            failure = new InvalidOperationException("Processed frame is not mono-equivalent stereo.");
            completed.Set();
            return;
        }
    frames++;
    if (Array.Exists(frame, sample => sample != 0)) nonzeroFrames++;
    if (frames >= 5 && nonzeroFrames > 0) completed.Set();
};

Console.WriteLine($"Capture: {captureDevice.Name}");
Console.WriteLine($"Render:  {renderDevice.Name}");
capture.Start();
completed.Wait(TimeSpan.FromSeconds(seconds));
capture.Stop();
render.Stop();

if (failure is not null) throw failure;
if (frames < 5 || nonzeroFrames == 0)
    throw new InvalidOperationException($"DSP validation failed: {frames} frames, {nonzeroFrames} nonzero.");
Console.WriteLine($"PASS: {frames} correctly sized frames, {nonzeroFrames} nonzero; shutdown completed.");
