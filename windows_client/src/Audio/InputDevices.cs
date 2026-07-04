using System.Collections.Generic;
using NAudio.Wave;

namespace SonicRoom.Windows.Audio;

/// <summary>Enumerates WaveIn capture devices (index + name) for the extra-mic picker.</summary>
public static class InputDevices
{
    public static IReadOnlyList<(int Index, string Name)> List()
    {
        var list = new List<(int, string)>();
        for (var i = 0; i < WaveInEvent.DeviceCount; i++)
        {
            try { list.Add((i, WaveInEvent.GetCapabilities(i).ProductName)); }
            catch { /* skip an inaccessible device */ }
        }
        return list;
    }
}
