using System.Text.Json;
using SonicRoom.Windows.Session;
using SonicRoom.Windows.Signaling;
using Xunit;

namespace SonicRoom.Windows.Tests;

/// <summary>
/// Parsing the join ack's new fields. A wrong or missing field here means a moderated room looks
/// like an ordinary one (admin controls vanish) or a reserved room never waits for its host, so
/// these are parsed straight from representative server JSON.
/// </summary>
public sealed class JoinAckTests
{
    private static JoinAck Parse(string json) =>
        JsonSerializer.Deserialize<JoinAck>(json)!;

    [Fact]
    public void OrdinaryRoomHasNoModerationAndIsNotAdmin()
    {
        var ack = Parse("""{"ok":true,"status":"joined","isPublic":false}""");
        Assert.True(ack.Ok);
        Assert.False(ack.IsPending);
        Assert.Null(ack.Moderation);
        Assert.False(ack.IsAdmin);
        Assert.False(ack.IsModerated);
    }

    [Fact]
    public void ModeratedRoomCarriesPolicyAdminListAndFlag()
    {
        var ack = Parse("""
        {
          "ok": true, "status": "joined", "isPublic": false,
          "moderation": {
            "multipleAdmins": true, "recording": "admins", "shareAudio": "everyone",
            "streamAudio": "everyone", "ducking": "everyone", "liveStreaming": "admins",
            "approveJoins": "admins", "chat": "nobody", "notes": "admins",
            "mutePeer": "admins", "muteAll": "admins", "kick": "admins_vote",
            "hidePoweredBy": true
          },
          "isAdmin": true,
          "admins": [ { "peerId": "s1", "displayName": "Alice" } ]
        }
        """);

        Assert.True(ack.IsModerated);
        Assert.True(ack.IsAdmin);
        var policy = ack.Moderation!;
        Assert.True(policy.MultipleAdmins);
        Assert.True(policy.HidePoweredBy);
        Assert.Equal("nobody", policy.Chat);
        Assert.Equal("admins", policy.Notes);
        Assert.Equal("admins_vote", policy.Kick);
        var admin = Assert.Single(ack.Admins!);
        Assert.Equal("s1", admin.PeerId);
        Assert.Equal("Alice", admin.DisplayName);
    }

    [Fact]
    public void NotesFieldsAreReadFromTheSnapshot()
    {
        var off = Parse("""{"ok":true,"notesEnabled":false,"notesUrl":null}""");
        Assert.False(off.NotesEnabled);
        Assert.Null(off.NotesUrl);

        var on = Parse("""{"ok":true,"notesEnabled":true,"notesUrl":"https://notelab.example/n/tok"}""");
        Assert.True(on.NotesEnabled);
        Assert.Equal("https://notelab.example/n/tok", on.NotesUrl);
    }

    [Fact]
    public void ReservedFlagIsReadFromTheSnapshot()
    {
        Assert.True(Parse("""{"ok":true,"reserved":true}""").Reserved);
        Assert.False(Parse("""{"ok":true}""").Reserved);
    }

    [Fact]
    public void PendingStatusIsRecognised()
    {
        Assert.True(Parse("""{"ok":true,"status":"pending"}""").IsPending);
        Assert.False(Parse("""{"ok":true,"status":"joined"}""").IsPending);
    }

    [Fact]
    public void AdminsChangedBroadcastIsParsed()
    {
        var msg = JsonSerializer.Deserialize<AdminsChanged>("""
        {
          "admins": [ { "peerId": "s2", "displayName": "Bob" } ],
          "change": { "peerId": "s2", "displayName": "Bob", "isAdmin": true,
                      "reason": "named", "by": "Alice" }
        }
        """)!;

        Assert.Single(msg.Admins);
        Assert.Equal("Bob", msg.Admins[0].DisplayName);
        Assert.NotNull(msg.Change);
        Assert.True(msg.Change!.IsAdmin);
        Assert.Equal("named", msg.Change.Reason);
        Assert.Equal("Alice", msg.Change.By);
    }

    [Fact]
    public void AdminKickCarriesReasonAndWho()
    {
        var kicked = JsonSerializer.Deserialize<PeerKicked>(
            """{"peerId":"s3","displayName":"Carol","reason":"admin","by":"Alice"}""")!;
        Assert.Equal("admin", kicked.Reason);
        Assert.Equal("Alice", kicked.By);

        // The older public-room vote kick has no "by" — it must not become null-vs-empty trouble.
        var vote = JsonSerializer.Deserialize<PeerKicked>(
            """{"peerId":"s4","displayName":"Dan","reason":"vote"}""")!;
        Assert.Equal("vote", vote.Reason);
        Assert.Null(vote.By);
    }
}
