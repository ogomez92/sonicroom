using System.Collections.Generic;
using NAudio.Wave;

namespace SonicRoom.Windows.Audio;

/// <summary>Enumerates WaveOut render devices (index + name) for the speaker picker —
/// the render-side twin of <see cref="InputDevices"/>.</summary>
public static class OutputDevices
{
    public static IReadOnlyList<(int Index, string Name)> List()
    {
        var list = new List<(int, string)>();
        for (var i = 0; i < WaveOut.DeviceCount; i++)
        {
            try { list.Add((i, WaveOut.GetCapabilities(i).ProductName)); }
            catch { /* skip an inaccessible device */ }
        }
        return list;
    }
}
