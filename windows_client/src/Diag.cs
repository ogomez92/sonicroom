using System;
using System.IO;

namespace SonicRoom.Windows;

/// <summary>
/// Minimal file logger so runtime errors are diagnosable without a debugger attached (the app is a
/// GUI; there's no console). Writes to <c>%LOCALAPPDATA%\SonicRoom\log.txt</c>.
/// </summary>
public static class Diag
{
    private static readonly object Gate = new();
    public static string LogPath { get; } = BuildPath();

    private static string BuildPath()
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SonicRoom");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, "log.txt");
    }

    public static void Log(string message)
    {
        try
        {
            lock (Gate)
                File.AppendAllText(LogPath, $"{DateTime.Now:HH:mm:ss.fff}  {message}{Environment.NewLine}");
        }
        catch { /* logging must never throw */ }
    }

    public static void Log(string context, Exception ex) => Log($"{context}: {ex}");
}
