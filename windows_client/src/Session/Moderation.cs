using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace SonicRoom.Windows.Session;

/// <summary>
/// The client's twin of the server's <c>moderation-util.ts</c>. The server is the authority —
/// it re-checks every one of these on the event — but mirroring the rules here lets the client
/// HIDE a control the user cannot use instead of offering one that always fails.
///
/// An ordinary room has a <c>null</c> policy and behaves exactly as before (every action
/// allowed), which is why every admin path is gated on the policy being present.
/// </summary>
public sealed class ModerationPolicy
{
    [JsonPropertyName("multipleAdmins")] public bool MultipleAdmins { get; set; }
    [JsonPropertyName("recording")] public string Recording { get; set; } = "admins";
    [JsonPropertyName("shareAudio")] public string ShareAudio { get; set; } = "everyone";
    [JsonPropertyName("streamAudio")] public string StreamAudio { get; set; } = "everyone";
    [JsonPropertyName("ducking")] public string Ducking { get; set; } = "everyone";
    [JsonPropertyName("liveStreaming")] public string LiveStreaming { get; set; } = "admins";
    [JsonPropertyName("approveJoins")] public string ApproveJoins { get; set; } = "admins";
    [JsonPropertyName("chat")] public string Chat { get; set; } = "everyone";
    [JsonPropertyName("notes")] public string Notes { get; set; } = "everyone";
    [JsonPropertyName("mutePeer")] public string MutePeer { get; set; } = "admins";
    [JsonPropertyName("muteAll")] public string MuteAll { get; set; } = "admins";
    [JsonPropertyName("kick")] public string Kick { get; set; } = "admins";
    [JsonPropertyName("hidePoweredBy")] public bool HidePoweredBy { get; set; }

    /// <summary>Set on the wire to <c>"admins"</c>/<c>"everyone"</c>/<c>"nobody"</c>.</summary>
    public static ModerationPolicy Default => new();
}

/// <summary>The pure permission checks, mirroring <c>moderation-util.ts</c> exactly.</summary>
public static class Moderation
{
    /// <summary>Actions gated by a plain who-may-do-it setting.</summary>
    public const string Recording = "recording";
    public const string ShareAudio = "shareAudio";
    public const string StreamAudio = "streamAudio";
    public const string Ducking = "ducking";
    public const string LiveStreaming = "liveStreaming";
    public const string ApproveJoins = "approveJoins";
    public const string Chat = "chat";
    public const string Notes = "notes";
    public const string MutePeer = "mutePeer";
    public const string MuteAll = "muteAll";

    /// <summary>Read one action's setting off a policy (null policy = ordinary room).</summary>
    private static string Setting(ModerationPolicy? policy, string action) => action switch
    {
        Recording => policy!.Recording,
        ShareAudio => policy!.ShareAudio,
        StreamAudio => policy!.StreamAudio,
        Ducking => policy!.Ducking,
        LiveStreaming => policy!.LiveStreaming,
        ApproveJoins => policy!.ApproveJoins,
        Chat => policy!.Chat,
        Notes => policy!.Notes,
        MutePeer => policy!.MutePeer,
        MuteAll => policy!.MuteAll,
        _ => "everyone",
    };

    /// <summary>May this peer perform <paramref name="action"/>? A null policy allows everything.</summary>
    public static bool Allowed(ModerationPolicy? policy, bool isAdmin, string action)
    {
        if (policy is null) return true;                       // ordinary room: unchanged behaviour
        return Setting(policy, action) switch
        {
            "everyone" => true,
            "admins" => isAdmin,
            _ => false,
        };
    }

    /// <summary>How this peer may remove people: "direct" | "vote" | "none".</summary>
    public static string KickMode(ModerationPolicy policy, bool isAdmin) => policy.Kick switch
    {
        "admins" => isAdmin ? "direct" : "none",
        "admins_vote" => isAdmin ? "vote" : "none",
        "everyone" => "direct",
        "everyone_vote" => "vote",
        _ => "none",
    };

    /// <summary>Whether a vote-kick electorate in a moderated room is admins-only.</summary>
    public static bool VoteIsAdminsOnly(ModerationPolicy policy) => policy.Kick == "admins_vote";
}

/// <summary>One admin, from the join snapshot's <c>admins</c> list / <c>admins-changed</c>.</summary>
public sealed class AdminInfo
{
    [JsonPropertyName("peerId")] public string PeerId { get; set; } = "";
    [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
}

/// <summary>The <c>admins-changed</c> broadcast: the current set plus who changed how.</summary>
public sealed class AdminsChanged
{
    [JsonPropertyName("admins")] public List<AdminInfo> Admins { get; set; } = new();
    [JsonPropertyName("change")] public AdminChange? Change { get; set; }
}

public sealed class AdminChange
{
    [JsonPropertyName("peerId")] public string PeerId { get; set; } = "";
    [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
    [JsonPropertyName("isAdmin")] public bool IsAdmin { get; set; }
    [JsonPropertyName("reason")] public string Reason { get; set; } = "named"; // named|revoked
    [JsonPropertyName("by")] public string? By { get; set; }
}

/// <summary>Server told us our voice was force-muted by an admin (soft mute — we may unmute).</summary>
public sealed class YouWereMuted
{
    [JsonPropertyName("by")] public string? By { get; set; }
}

/// <summary>Everyone else was force-muted by an admin.</summary>
public sealed class AllMuted
{
    [JsonPropertyName("by")] public string? By { get; set; }
    [JsonPropertyName("count")] public int Count { get; set; }
}
