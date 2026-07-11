using System;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace SonicRoom.Windows.Audio;

internal readonly record struct VoiceDeviceMapping(int EndpointIndex, string Name, bool FellBack);

/// <summary>Maps legacy WaveIn/WaveOut selections to the indexes used by IMMDeviceCollection.</summary>
internal static class VoiceDeviceMapper
{
    public static VoiceDeviceMapping MapCapture(int waveInIndex) => Map(
        DataFlow.Capture,
        waveInIndex < 0 ? null : WaveInEvent.GetCapabilities(waveInIndex).ProductName);

    public static VoiceDeviceMapping MapRender(int waveOutIndex) => Map(
        DataFlow.Render,
        waveOutIndex < 0 ? null : WaveOut.GetCapabilities(waveOutIndex).ProductName);

    private static VoiceDeviceMapping Map(DataFlow flow, string? selectedName)
    {
        using var enumerator = new MMDeviceEnumerator();
        var endpoints = enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active);
        if (endpoints.Count == 0)
            throw new InvalidOperationException($"No active {flow} audio endpoint is available.");

        if (!string.IsNullOrWhiteSpace(selectedName))
        {
            for (var i = 0; i < endpoints.Count; i++)
            {
                var friendly = endpoints[i].FriendlyName;
                if (NamesMatch(selectedName, friendly))
                    return new VoiceDeviceMapping(i, friendly, false);
            }
        }

        using var fallback = enumerator.GetDefaultAudioEndpoint(flow, Role.Communications);
        for (var i = 0; i < endpoints.Count; i++)
            if (string.Equals(endpoints[i].ID, fallback.ID, StringComparison.OrdinalIgnoreCase))
                return new VoiceDeviceMapping(i, fallback.FriendlyName, selectedName is not null);

        // The collection can change between enumeration calls. -1 is the DSP's documented
        // default-device sentinel and remains deterministic in that race.
        return new VoiceDeviceMapping(-1, fallback.FriendlyName, selectedName is not null);
    }

    private static bool NamesMatch(string waveName, string endpointName) =>
        string.Equals(waveName, endpointName, StringComparison.OrdinalIgnoreCase) ||
        endpointName.StartsWith(waveName, StringComparison.OrdinalIgnoreCase) ||
        endpointName.Contains(waveName, StringComparison.OrdinalIgnoreCase);
}
