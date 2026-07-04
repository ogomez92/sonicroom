using System;
using System.Collections.Generic;
using System.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

namespace SonicRoom.Windows.Audio;

/// <summary>An application that currently has an audio render session (candidate for per-app share).</summary>
public sealed record AudioApp(uint ProcessId, string Name, bool Active);

/// <summary>
/// Lists processes that have an audio session on the default render device, for the per-app share
/// picker. Uses NAudio's CoreAudioApi session enumeration (no custom interop needed here — only the
/// actual per-process capture needs the Process Loopback API).
/// </summary>
public static class AudioAppEnumerator
{
    public static IReadOnlyList<AudioApp> List()
    {
        var byPid = new Dictionary<uint, AudioApp>();
        try
        {
            using var devices = new MMDeviceEnumerator();
            using var device = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var sessions = device.AudioSessionManager.Sessions;

            for (var i = 0; i < sessions.Count; i++)
            {
                AudioSessionControl session;
                try { session = sessions[i]; }
                catch { continue; }

                uint pid;
                try { pid = session.GetProcessID; }
                catch { continue; }
                if (pid == 0 || byPid.ContainsKey(pid)) continue;

                var active = false;
                try { active = session.State == AudioSessionState.AudioSessionStateActive; }
                catch { /* keep default */ }

                var name = ResolveName(pid, session);
                if (name is null) continue; // system/inaccessible session

                byPid[pid] = new AudioApp(pid, name, active);
            }
        }
        catch (Exception ex) { Diag.Log("AudioAppEnumerator.List", ex); }

        var list = new List<AudioApp>(byPid.Values);
        list.Sort((a, b) => a.Active == b.Active
            ? string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase)
            : (a.Active ? -1 : 1));
        return list;
    }

    private static string? ResolveName(uint pid, AudioSessionControl session)
    {
        try
        {
            using var p = Process.GetProcessById((int)pid);
            var title = p.MainWindowTitle;
            return string.IsNullOrWhiteSpace(title) ? p.ProcessName : $"{p.ProcessName} — {title}";
        }
        catch { /* process gone or access denied — fall back to the session display name */ }

        try
        {
            var display = session.DisplayName;
            return string.IsNullOrWhiteSpace(display) ? null : display;
        }
        catch { return null; }
    }
}
