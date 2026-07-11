using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace SonicRoom.Windows;

/// <summary>User settings persisted to <c>%LOCALAPPDATA%\SonicRoom\settings.json</c>.</summary>
public sealed class AppSettings
{
    public string ServerUrl { get; set; } = "https://sonic.oriolgomez.com";
    public string Room { get; set; } = "test";
    public string DisplayName { get; set; } = "WinNative";
    /// <summary>Microphone by product name (WaveIn indices shift across replugs).</summary>
    public string MicDevice { get; set; } = "System default";
    /// <summary>Speaker/render device by product name (WaveOut indices shift across replugs).</summary>
    public string SpeakerDevice { get; set; } = "System default";
    /// <summary>UI + announcement language: "en" | "es" | "fr".</summary>
    public string Language { get; set; } = "en";
    /// <summary>Hi-fi voice opt-in: stereo ~128 kbps voice instead of the default mono ~64 kbps.
    /// Same trade-off as the web toggle — most mics are mono, and 128k costs every listener.</summary>
    public bool HifiVoice { get; set; }
    /// <summary>Send-side mic boost (0–4×) applied before the soft limiter, like the web's micGain.</summary>
    public double MicGain { get; set; } = 1.0;
    /// <summary>Outgoing media gain (0–2×), applied to both local monitoring and remote audio.</summary>
    public double MediaVolume { get; set; } = 1.0;
    /// <summary>Per-device extra-mic channel choice, keyed by device product name (WaveIn
    /// indices shift across replugs) — the web's <c>sonicroom:micStereoByDevice</c>.</summary>
    public Dictionary<string, bool> MicStereoByDevice { get; set; } = new();

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SonicRoom", "settings.json");

    public static AppSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath)) ?? new AppSettings();
        }
        catch (Exception ex) { Diag.Log("AppSettings.Load", ex); }
        return new AppSettings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex) { Diag.Log("AppSettings.Save", ex); }
    }
}
