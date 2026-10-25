using System.Collections.Generic;
using SonicRoom.Windows.Session;
using SonicRoom.Windows.Signaling;
using Xunit;

namespace SonicRoom.Windows.Tests;

/// <summary>
/// The <c>join</c> payload's exact wire shape. Two failure modes matter and neither is caught by
/// the compiler: a field the server's zod schema REJECTS (it treats <c>.optional()</c> as
/// "undefined ok, null rejected"), and a field sent when it should be omitted (which would make
/// every join into an existing room try to re-create its policy).
/// </summary>
public sealed class JoinRequestWireTests
{
    private static Dictionary<string, object?> Minimal() => new JoinRequest
    {
        RoomName = "test",
        DisplayName = "Alice",
    }.ToWire();

    [Fact]
    public void MinimalJoinOmitsEveryOptionalField()
    {
        var wire = Minimal();
        Assert.Equal("test", wire["roomName"]);
        Assert.Equal("Alice", wire["displayName"]);
        Assert.Equal(true, wire["disableP2p"]);   // this client is SFU-only, always
        // Undefined, not null: the server's zod schema rejects an explicit null.
        foreach (var key in new[] { "isPublic", "joinToken", "hostKey", "moderation", "sharing",
                                    "fileStreaming", "extraMic" })
            Assert.False(wire.ContainsKey(key), $"{key} must be omitted when unset");
    }

    [Fact]
    public void HostKeyIsSentWhenPresent()
    {
        var wire = new JoinRequest
        {
            RoomName = "r", DisplayName = "A", HostKey = "secret-key",
        }.ToWire();
        Assert.Equal("secret-key", wire["hostKey"]);
    }

    [Fact]
    public void EmptyHostKeyIsOmittedNotSentAsEmptyString()
    {
        // An empty string would still pass zod's min(1) as a failure, or worse be treated as a
        // presented-but-wrong key. Omit it so the join is an ordinary one.
        foreach (var key in new[] { null, "", "   " })
        {
            var wire = new JoinRequest
            {
                RoomName = "r", DisplayName = "A", HostKey = key,
            }.ToWire();
            Assert.False(wire.ContainsKey("hostKey"), $"hostKey '{key}' must be omitted");
        }
    }

    [Fact]
    public void ModerationPolicyIsSentOnlyWhenSupplied()
    {
        Assert.False(Minimal().ContainsKey("moderation"));

        var policy = ModerationPolicy.Default;
        policy.MultipleAdmins = true;
        policy.Chat = "nobody";
        var wire = new JoinRequest
        {
            RoomName = "r", DisplayName = "A", Moderation = policy,
        }.ToWire();
        Assert.True(wire.ContainsKey("moderation"));
    }

    [Fact]
    public void JoinTokenAndPublicFlagAreOmittedWhenUnset()
    {
        var wire = Minimal();
        Assert.False(wire.ContainsKey("joinToken"));
        Assert.False(wire.ContainsKey("isPublic"));

        var withToken = new JoinRequest
        {
            RoomName = "r", DisplayName = "A", JoinToken = "abc", IsPublic = true,
        }.ToWire();
        Assert.Equal("abc", withToken["joinToken"]);
        Assert.Equal(true, withToken["isPublic"]);
    }
}
