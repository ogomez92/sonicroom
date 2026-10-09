using System.Collections.Generic;
using SonicRoom.Windows.Session;
using Xunit;

namespace SonicRoom.Windows.Tests;

/// <summary>
/// The client-side moderation gate, mirroring the server's <c>moderation-util.ts</c>. These
/// guard the rule that matters most: an ORDINARY room (no policy) must behave exactly as it did
/// before moderated rooms existed — every action allowed, for everyone.
/// </summary>
public sealed class ModerationTests
{
    private static ModerationPolicy AdminsOnly(params string[] actions)
    {
        var p = ModerationPolicy.Default;
        foreach (var a in actions)
            switch (a)
            {
                case Moderation.Recording: p.Recording = "admins"; break;
                case Moderation.LiveStreaming: p.LiveStreaming = "admins"; break;
                case Moderation.Chat: p.Chat = "admins"; break;
                case Moderation.Notes: p.Notes = "admins"; break;
                case Moderation.MutePeer: p.MutePeer = "admins"; break;
                case Moderation.MuteAll: p.MuteAll = "admins"; break;
                case Moderation.ShareAudio: p.ShareAudio = "admins"; break;
                case Moderation.StreamAudio: p.StreamAudio = "admins"; break;
                case Moderation.ApproveJoins: p.ApproveJoins = "admins"; break;
                case Moderation.Ducking: p.Ducking = "admins"; break;
            }
        return p;
    }

    [Fact]
    public void NullPolicyAllowsEverythingForEveryone()
    {
        // The regression that matters: no policy = today's behaviour, byte-for-byte.
        foreach (var action in new[]
                 {
                     Moderation.Recording, Moderation.ShareAudio, Moderation.StreamAudio,
                     Moderation.Ducking, Moderation.LiveStreaming, Moderation.ApproveJoins,
                     Moderation.Chat, Moderation.Notes, Moderation.MutePeer, Moderation.MuteAll,
                 })
        {
            Assert.True(Moderation.Allowed(null, isAdmin: true, action));
            Assert.True(Moderation.Allowed(null, isAdmin: false, action));
        }
    }

    [Fact]
    public void AdminsOnlySettingGatesOnTheAdminFlag()
    {
        var policy = AdminsOnly(Moderation.Recording, Moderation.Chat);
        Assert.True(Moderation.Allowed(policy, isAdmin: true, Moderation.Recording));
        Assert.False(Moderation.Allowed(policy, isAdmin: false, Moderation.Recording));
        Assert.True(Moderation.Allowed(policy, isAdmin: true, Moderation.Chat));
        Assert.False(Moderation.Allowed(policy, isAdmin: false, Moderation.Chat));
    }

    [Fact]
    public void SettingIsReadPerActionNotShared()
    {
        // Recording is admins-only, chat stays everyone: the two must not interfere.
        var policy = AdminsOnly(Moderation.Recording);
        Assert.False(Moderation.Allowed(policy, isAdmin: false, Moderation.Recording));
        Assert.True(Moderation.Allowed(policy, isAdmin: false, Moderation.Chat));
        Assert.True(Moderation.Allowed(policy, isAdmin: false, Moderation.ShareAudio));
    }

    [Theory]
    [InlineData("nobody", false)]
    [InlineData("nobody", true)]
    public void NobodyIsDeniedEvenForAnAdmin(string who, bool isAdmin)
    {
        var policy = ModerationPolicy.Default;
        policy.Chat = who;
        Assert.False(Moderation.Allowed(policy, isAdmin, Moderation.Chat));
    }

    [Theory]
    [InlineData("admins", true, "direct")]
    [InlineData("admins", false, "none")]
    [InlineData("admins_vote", true, "vote")]
    [InlineData("admins_vote", false, "none")]
    [InlineData("everyone", true, "direct")]
    [InlineData("everyone", false, "direct")]
    [InlineData("everyone_vote", true, "vote")]
    [InlineData("everyone_vote", false, "vote")]
    [InlineData("nobody", true, "none")]
    [InlineData("nobody", false, "none")]
    public void KickModeMatchesTheServerTable(string kick, bool isAdmin, string expected)
    {
        var policy = ModerationPolicy.Default;
        policy.Kick = kick;
        Assert.Equal(expected, Moderation.KickMode(policy, isAdmin));
    }

    [Fact]
    public void VoteIsAdminsOnlyOnlyForAdminsVote()
    {
        var policy = ModerationPolicy.Default;
        policy.Kick = "admins_vote";
        Assert.True(Moderation.VoteIsAdminsOnly(policy));
        policy.Kick = "everyone_vote";
        Assert.False(Moderation.VoteIsAdminsOnly(policy));
    }

    [Fact]
    public void DefaultsMatchTheServerPolicySchema()
    {
        // If these drift from moderation-util.ts the client hides the wrong controls.
        var p = ModerationPolicy.Default;
        Assert.Equal("admins", p.Recording);
        Assert.Equal("everyone", p.ShareAudio);
        Assert.Equal("everyone", p.StreamAudio);
        Assert.Equal("everyone", p.Ducking);
        Assert.Equal("admins", p.LiveStreaming);
        Assert.Equal("admins", p.ApproveJoins);
        Assert.Equal("everyone", p.Chat);
        Assert.Equal("everyone", p.Notes);
        Assert.Equal("admins", p.MutePeer);
        Assert.Equal("admins", p.MuteAll);
        Assert.Equal("admins", p.Kick);
        Assert.False(p.MultipleAdmins);
        Assert.False(p.HidePoweredBy);
    }
}
