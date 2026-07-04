using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SonicRoom.Windows.Signaling;

// Wire contract for the SonicRoom socket.io protocol. Field names mirror the server exactly
// (see server/src/signaling/*). Opaque mediasoup objects (rtpCapabilities, rtpParameters,
// ice/dtls params) are held as JsonElement here and parsed by the transport layer in Phase 2.

/// <summary>Thrown when a server ack returns <c>{ ok: false, error }</c>.</summary>
public sealed class SignalingException : System.Exception
{
    public SignalingException(string message) : base(message) { }
}

// ---- join handshake ---------------------------------------------------------------------

/// <summary>Outgoing <c>join</c> payload. Always SFU-only (<c>disableP2p:true</c>).</summary>
public sealed class JoinRequest
{
    public required string RoomName { get; init; }
    public required string DisplayName { get; init; }
    public bool? IsPublic { get; init; }
    public string? JoinToken { get; init; }
    public bool Sharing { get; init; }
    public bool FileStreaming { get; init; }
    public bool ExtraMic { get; init; }

    /// <summary>
    /// Build the exact wire object. Optional fields are OMITTED (not sent as null) because the
    /// server's zod schema treats them as <c>.optional()</c> (undefined ok, null rejected).
    /// </summary>
    public Dictionary<string, object?> ToWire() =>
        BuildWire(this);

    private static Dictionary<string, object?> BuildWire(JoinRequest r)
    {
        var d = new Dictionary<string, object?>
        {
            ["roomName"] = r.RoomName,
            ["displayName"] = r.DisplayName,
            ["disableP2p"] = true, // native client is SFU-only
        };
        if (r.IsPublic is bool p) d["isPublic"] = p;
        if (!string.IsNullOrEmpty(r.JoinToken)) d["joinToken"] = r.JoinToken;
        if (r.Sharing) d["sharing"] = true;
        if (r.FileStreaming) d["fileStreaming"] = true;
        if (r.ExtraMic) d["extraMic"] = true;
        return d;
    }
}

/// <summary>The <c>join</c> ack. Three outcomes: banned (ok:false), pending, or joined.</summary>
public sealed class JoinAck
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("status")] public string? Status { get; set; } // "joined" | "pending"

    [JsonPropertyName("rtpCapabilities")] public JsonElement RtpCapabilities { get; set; }
    [JsonPropertyName("peers")] public List<PeerInfo> Peers { get; set; } = new();
    [JsonPropertyName("mode")] public string? Mode { get; set; }     // "sfu" | "p2p"
    [JsonPropertyName("isPublic")] public bool IsPublic { get; set; }
    [JsonPropertyName("recording")] public RecordingState? Recording { get; set; }
    [JsonPropertyName("streaming")] public bool Streaming { get; set; }
    [JsonPropertyName("voiceActive")] public bool VoiceActive { get; set; }
    [JsonPropertyName("duckingEnabled")] public bool DuckingEnabled { get; set; }
    [JsonPropertyName("kickVotes")] public List<KickVoteTally>? KickVotes { get; set; }
    [JsonPropertyName("messages")] public List<ChatMessage>? Messages { get; set; }

    public bool IsPending => Status == "pending";
}

public sealed class PeerInfo
{
    [JsonPropertyName("peerId")] public string PeerId { get; set; } = "";
    [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
    [JsonPropertyName("muted")] public bool Muted { get; set; }
    [JsonPropertyName("producers")] public List<ProducerInfo> Producers { get; set; } = new();
}

public sealed class ProducerInfo
{
    [JsonPropertyName("producerId")] public string ProducerId { get; set; } = "";
    [JsonPropertyName("source")] public string Source { get; set; } = "voice"; // voice|music|share|file|mic
    [JsonPropertyName("title")] public string? Title { get; set; }
}

public sealed class RecordingState
{
    [JsonPropertyName("recordingId")] public string RecordingId { get; set; } = "";
}

public sealed class KickVoteTally
{
    [JsonPropertyName("targetId")] public string TargetId { get; set; } = "";
    [JsonPropertyName("votes")] public int Votes { get; set; }
}

// ---- server -> client event payloads ----------------------------------------------------

public sealed class PeerJoined
{
    [JsonPropertyName("peerId")] public string PeerId { get; set; } = "";
    [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
}

public sealed class PeerLeft
{
    [JsonPropertyName("peerId")] public string PeerId { get; set; } = "";
}

public sealed class NewProducer
{
    [JsonPropertyName("peerId")] public string PeerId { get; set; } = "";
    [JsonPropertyName("producerId")] public string ProducerId { get; set; } = "";
    [JsonPropertyName("kind")] public string Kind { get; set; } = "audio";
    [JsonPropertyName("source")] public string Source { get; set; } = "voice";
    [JsonPropertyName("title")] public string? Title { get; set; }
}

/// <summary>Shared shape for <c>peer-muted</c> / <c>peer-unmuted</c>.</summary>
public sealed class PeerMuteState
{
    [JsonPropertyName("peerId")] public string PeerId { get; set; } = "";
}

public sealed class DuckState
{
    [JsonPropertyName("active")] public bool Active { get; set; }
}

public sealed class DuckingChanged
{
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("by")] public string? By { get; set; }
}

public sealed class SwitchToSfu
{
    [JsonPropertyName("rtpCapabilities")] public JsonElement RtpCapabilities { get; set; }
}

/// <summary>Shared shape for share/file/mic start+stop presence events.</summary>
public sealed class StreamPresence
{
    [JsonPropertyName("peerId")] public string PeerId { get; set; } = "";
    [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
}

/// <summary>One extra-mic producer stopped; <c>last</c> = it was that peer's final mic stream.</summary>
public sealed class MicStreamStopped
{
    [JsonPropertyName("peerId")] public string PeerId { get; set; } = "";
    [JsonPropertyName("producerId")] public string ProducerId { get; set; } = "";
    [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
    [JsonPropertyName("last")] public bool Last { get; set; }
}

/// <summary>A share/file/mic stream was force-stopped (anti-troll <c>stop-peer-stream</c>).
/// Broadcast to the whole room including the stream's owner, who cleans up locally.</summary>
public sealed class PeerStreamStopped
{
    [JsonPropertyName("ownerId")] public string OwnerId { get; set; } = "";
    [JsonPropertyName("producerId")] public string ProducerId { get; set; } = "";
    [JsonPropertyName("source")] public string Source { get; set; } = "";
}

/// <summary>A file streamer swapped files on a live producer — only the title changed.</summary>
public sealed class ProducerTitleUpdated
{
    [JsonPropertyName("producerId")] public string ProducerId { get; set; } = "";
    [JsonPropertyName("title")] public string? Title { get; set; }
}

/// <summary>The finished recording was cleaned up server-side (TTL) — drop the download link.</summary>
public sealed class RecordingExpired
{
    [JsonPropertyName("recordingId")] public string? RecordingId { get; set; }
}

public sealed class ChatMessage
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("sender")] public string Sender { get; set; } = "";
    [JsonPropertyName("text")] public string Text { get; set; } = "";
    [JsonPropertyName("ts")] public long Ts { get; set; }
}

// ---- recording / streaming ---------------------------------------------------------------

public sealed class RecordingStarted
{
    [JsonPropertyName("recordingId")] public string RecordingId { get; set; } = "";
    [JsonPropertyName("by")] public string? By { get; set; }
}

public sealed class RecordingStopped
{
    [JsonPropertyName("recordingId")] public string? RecordingId { get; set; }
}

public sealed class ByEvent
{
    [JsonPropertyName("by")] public string? By { get; set; }
}

public sealed class StreamingFailed
{
    [JsonPropertyName("error")] public string? Error { get; set; }
}

// ---- moderation --------------------------------------------------------------------------

public sealed class KickVote
{
    [JsonPropertyName("targetId")] public string TargetId { get; set; } = "";
    [JsonPropertyName("targetName")] public string? TargetName { get; set; }
    [JsonPropertyName("votes")] public int Votes { get; set; }
    [JsonPropertyName("voterId")] public string? VoterId { get; set; }
    [JsonPropertyName("voterName")] public string? VoterName { get; set; }
    [JsonPropertyName("action")] public string Action { get; set; } = ""; // cast|withdraw|recount
}

public sealed class PeerKicked
{
    [JsonPropertyName("peerId")] public string PeerId { get; set; } = "";
    [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
    [JsonPropertyName("reason")] public string Reason { get; set; } = "vote"; // vote|caster
}

public sealed class JoinRequestsMsg
{
    [JsonPropertyName("requests")] public List<JoinRequestItem> Requests { get; set; } = new();
}

public sealed class JoinRequestItem
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("displayName")] public string DisplayName { get; set; } = "";
}

public sealed class JoinDenied
{
    [JsonPropertyName("by")] public string? By { get; set; }
}
