using System;
using SonicRoom.Windows;
using Xunit;

namespace SonicRoom.Windows.Tests;

/// <summary>
/// Launch-argument parsing, so a reserved room can be opened from a host link without touching the
/// UI. The important behaviour is that an unknown or valueless flag is IGNORED rather than fatal:
/// a stray argument must never stop the client from starting.
/// </summary>
public sealed class LaunchArgsTests
{
    [Fact]
    public void NoArgumentsMeansNoOverrides()
    {
        var args = LaunchArgs.Parse(Array.Empty<string>());
        Assert.Null(args.ServerUrl);
        Assert.Null(args.Room);
        Assert.Null(args.DisplayName);
        Assert.Null(args.HostKey);
    }

    [Fact]
    public void HostLinkArgumentsAreRead()
    {
        var args = LaunchArgs.Parse(new[]
        {
            "--server", "https://calls.example", "--room", "my-room",
            "--name", "Alice", "--host", "abc123",
        });
        Assert.Equal("https://calls.example", args.ServerUrl);
        Assert.Equal("my-room", args.Room);
        Assert.Equal("Alice", args.DisplayName);
        Assert.Equal("abc123", args.HostKey);
    }

    [Fact]
    public void FlagsAreCaseInsensitiveAndOrderIndependent()
    {
        var args = LaunchArgs.Parse(new[] { "--HOST", "k", "--Room", "r" });
        Assert.Equal("k", args.HostKey);
        Assert.Equal("r", args.Room);
    }

    [Fact]
    public void TrailingFlagWithNoValueIsIgnored()
    {
        // "--host" at the end must not throw or produce an empty host key.
        var args = LaunchArgs.Parse(new[] { "--room", "r", "--host" });
        Assert.Equal("r", args.Room);
        Assert.Null(args.HostKey);
    }

    [Fact]
    public void UnknownFlagsAreIgnored()
    {
        var args = LaunchArgs.Parse(new[] { "--nonsense", "x", "--room", "r", "/flag" });
        Assert.Equal("r", args.Room);
    }

    [Fact]
    public void RepeatedFlagTakesTheLastValue()
    {
        var args = LaunchArgs.Parse(new[] { "--room", "first", "--room", "second" });
        Assert.Equal("second", args.Room);
    }
}
