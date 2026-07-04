using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SonicRoom.Windows.Transport;

// mediasoup wire models. Field names match mediasoup exactly (camelCase). These are primarily
// for READING (router capabilities, create-transport params, consumer rtpParameters). Outgoing
// produce/consume payloads are assembled from these + values we choose (ssrc, cname, mid).

// ---- RTP capabilities (router caps / our recv caps) -------------------------------------

public sealed class RtpCapabilities
{
    [JsonPropertyName("codecs")] public List<RtpCodecCapability> Codecs { get; set; } = new();
    [JsonPropertyName("headerExtensions")] public List<RtpHeaderExtensionCapability> HeaderExtensions { get; set; } = new();
}

public sealed class RtpCodecCapability
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("mimeType")] public string MimeType { get; set; } = "";
    [JsonPropertyName("clockRate")] public int ClockRate { get; set; }
    [JsonPropertyName("channels"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Channels { get; set; }
    [JsonPropertyName("preferredPayloadType"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? PreferredPayloadType { get; set; }
    [JsonPropertyName("rtcpFeedback"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<RtcpFeedback>? RtcpFeedback { get; set; }
    [JsonPropertyName("parameters"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, JsonElement>? Parameters { get; set; }

    [JsonIgnore] public bool IsOpus => MimeType.Equals("audio/opus", System.StringComparison.OrdinalIgnoreCase);
}

public sealed class RtcpFeedback
{
    [JsonPropertyName("type")] public string Type { get; set; } = "";
    [JsonPropertyName("parameter")] public string Parameter { get; set; } = "";
}

public sealed class RtpHeaderExtensionCapability
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("uri")] public string Uri { get; set; } = "";
    [JsonPropertyName("preferredId")] public int PreferredId { get; set; }
    [JsonPropertyName("preferredEncrypt")] public bool PreferredEncrypt { get; set; }
    [JsonPropertyName("direction"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Direction { get; set; }
}

// ---- RTP parameters (produce we build / consume the server sends) ------------------------

public sealed class RtpParameters
{
    [JsonPropertyName("mid"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Mid { get; set; }
    [JsonPropertyName("codecs")] public List<RtpCodecParameters> Codecs { get; set; } = new();
    [JsonPropertyName("headerExtensions"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<RtpHeaderExtensionParameters>? HeaderExtensions { get; set; }
    [JsonPropertyName("encodings"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<RtpEncoding>? Encodings { get; set; }
    [JsonPropertyName("rtcp"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public RtcpParameters? Rtcp { get; set; }
}

public sealed class RtpCodecParameters
{
    [JsonPropertyName("mimeType")] public string MimeType { get; set; } = "";
    [JsonPropertyName("payloadType")] public int PayloadType { get; set; }
    [JsonPropertyName("clockRate")] public int ClockRate { get; set; }
    [JsonPropertyName("channels"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Channels { get; set; }
    [JsonPropertyName("rtcpFeedback"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<RtcpFeedback>? RtcpFeedback { get; set; }
    [JsonPropertyName("parameters"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, JsonElement>? Parameters { get; set; }
}

public sealed class RtpHeaderExtensionParameters
{
    [JsonPropertyName("uri")] public string Uri { get; set; } = "";
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("encrypt"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Encrypt { get; set; }
}

public sealed class RtpEncoding
{
    [JsonPropertyName("ssrc")] public uint Ssrc { get; set; }
    [JsonPropertyName("dtx"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Dtx { get; set; }
}

public sealed class RtcpParameters
{
    [JsonPropertyName("cname"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Cname { get; set; }
    [JsonPropertyName("reducedSize"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? ReducedSize { get; set; }
}

// ---- create-transport params ------------------------------------------------------------

public sealed class TransportParams
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("iceParameters")] public IceParameters IceParameters { get; set; } = new();
    [JsonPropertyName("iceCandidates")] public List<IceCandidate> IceCandidates { get; set; } = new();
    [JsonPropertyName("dtlsParameters")] public DtlsParameters DtlsParameters { get; set; } = new();
}

public sealed class IceParameters
{
    [JsonPropertyName("usernameFragment")] public string UsernameFragment { get; set; } = "";
    [JsonPropertyName("password")] public string Password { get; set; } = "";
    [JsonPropertyName("iceLite")] public bool IceLite { get; set; }
}

public sealed class IceCandidate
{
    [JsonPropertyName("foundation")] public string Foundation { get; set; } = "";
    [JsonPropertyName("priority")] public long Priority { get; set; }
    [JsonPropertyName("ip")] public string Ip { get; set; } = "";
    [JsonPropertyName("address")] public string? Address { get; set; }
    [JsonPropertyName("protocol")] public string Protocol { get; set; } = "udp";
    [JsonPropertyName("port")] public int Port { get; set; }
    [JsonPropertyName("type")] public string Type { get; set; } = "host";
    [JsonPropertyName("tcpType"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? TcpType { get; set; }
}

public sealed class DtlsParameters
{
    [JsonPropertyName("fingerprints")] public List<DtlsFingerprint> Fingerprints { get; set; } = new();
    [JsonPropertyName("role")] public string Role { get; set; } = "auto"; // "auto" | "client" | "server"
}

public sealed class DtlsFingerprint
{
    [JsonPropertyName("algorithm")] public string Algorithm { get; set; } = "";
    [JsonPropertyName("value")] public string Value { get; set; } = "";
}
