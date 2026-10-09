using System;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace SonicRoom.Windows.Audio;

/// <summary>
/// Opens a speaker for low-latency playback: WASAPI shared mode, event-driven, with a
/// <see cref="BufferMs"/> buffer. The previous WaveOut (MME) path asked for 120 ms and
/// MME adds its own mixing delay on top — the single largest fixed delay in the client.
///
/// The selection is still the WaveOut index the device pickers store (index -1 = the
/// Windows default device), mapped to an endpoint by name. If WASAPI cannot open the
/// device for any reason, playback falls back to the old WaveOut path rather than going
/// silent.
/// </summary>
internal static class LowLatencyOutput
{
    public const int BufferMs = 30;
    private const int FallbackWaveOutLatencyMs = 120;

    public static IWavePlayer Open(int waveOutIndex, IWaveProvider source, Action<string>? log = null)
    {
        WasapiOut? output = null;
        try
        {
            var device = ResolveRender(waveOutIndex);
            output = new WasapiOut(device, AudioClientShareMode.Shared, useEventSync: true, BufferMs);
            output.Init(source);
            log?.Invoke($"speaker: WASAPI shared {BufferMs} ms on \"{device.FriendlyName}\"");
            return output;
        }
        catch (Exception ex)
        {
            output?.Dispose();
            Diag.Log("WASAPI output unavailable, falling back to WaveOut", ex);
            log?.Invoke($"speaker: WASAPI failed ({ex.Message}); using WaveOut {FallbackWaveOutLatencyMs} ms");
            var fallback = new WaveOutEvent { DesiredLatency = FallbackWaveOutLatencyMs, DeviceNumber = waveOutIndex };
            fallback.Init(source);
            return fallback;
        }
    }

    // WaveOut index -> MMDevice. -1 (and a remembered device that is gone) means the
    // default render device for multimedia, which is what WaveOut's wave mapper plays to.
    private static MMDevice ResolveRender(int waveOutIndex)
    {
        using var enumerator = new MMDeviceEnumerator();
        if (waveOutIndex >= 0)
        {
            var mapping = VoiceDeviceMapper.MapRender(waveOutIndex);
            if (!mapping.FellBack && mapping.EndpointIndex >= 0)
            {
                var endpoints = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);
                if (mapping.EndpointIndex < endpoints.Count) return endpoints[mapping.EndpointIndex];
            }
        }
        return enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
    }
}
