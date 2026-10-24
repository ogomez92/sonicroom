using System;
using System.Linq;

namespace SonicRoom.Windows;

/// <summary>
/// Launch arguments, so a room can be opened without touching the UI — the Windows equivalent of
/// the web client's URL params, and the natural fit for a host link
/// (<c>--room NAME --host KEY</c>).
///
/// Each flag is optional and independent; anything not given keeps the persisted/typed value.
/// <c>--host</c> wins over the Host key box, so a one-shot launch from a script always opens the
/// reserved room as its host.
/// </summary>
public sealed class LaunchArgs
{
    public string? ServerUrl { get; init; }
    public string? Room { get; init; }
    public string? DisplayName { get; init; }
    public string? HostKey { get; init; }

    /// <summary>Parse <c>--server URL --room NAME --name NAME --host KEY</c>. Unknown flags are
    /// ignored rather than fatal, so a stray argument can never stop the app from starting.</summary>
    public static LaunchArgs Parse(string[] args)
    {
        // FindLastIndex: a repeated flag takes its LAST value, so a later "--room x" wins over an
        // earlier one instead of being silently ignored.
        string? Value(string flag)
        {
            var i = Array.FindLastIndex(args, x => string.Equals(x, flag, StringComparison.OrdinalIgnoreCase));
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        return new LaunchArgs
        {
            ServerUrl = Value("--server"),
            Room = Value("--room"),
            DisplayName = Value("--name"),
            HostKey = Value("--host"),
        };
    }

    /// <summary>Parse this process's command line (argv after the executable).</summary>
    public static LaunchArgs Current =>
        Parse(Environment.GetCommandLineArgs().Skip(1).ToArray());
}
