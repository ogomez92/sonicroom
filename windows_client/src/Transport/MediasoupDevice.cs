using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace SonicRoom.Windows.Transport;

/// <summary>
/// Parses the router's RTP capabilities and derives the capabilities this (audio-only) client
/// advertises when consuming. Equivalent to mediasoup-client's <c>Device.load()</c> +
/// <c>device.rtpCapabilities</c>, but hand-rolled and scoped to audio/Opus.
/// </summary>
public sealed class MediasoupDevice
{
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    public bool Loaded { get; private set; }

    /// <summary>Full router capabilities as received.</summary>
    public RtpCapabilities RouterCapabilities { get; private set; } = new();

    /// <summary>The router's Opus codec (audio/opus). Throws if the router has no Opus.</summary>
    public RtpCodecCapability OpusCodec { get; private set; } = new();

    /// <summary>
    /// Capabilities we send on <c>consume</c>. Audio-only: the router's audio codecs plus the
    /// audio header extensions, so <c>router.canConsume</c> succeeds and the server picks a PT/ext
    /// layout we can decode.
    /// </summary>
    public RtpCapabilities RecvRtpCapabilities { get; private set; } = new();

    public void Load(JsonElement routerRtpCapabilities)
    {
        var caps = JsonSerializer.Deserialize<RtpCapabilities>(routerRtpCapabilities.GetRawText(), JsonOpts)
                   ?? throw new InvalidOperationException("routerRtpCapabilities did not parse.");
        Load(caps);
    }

    public void Load(RtpCapabilities routerRtpCapabilities)
    {
        RouterCapabilities = routerRtpCapabilities;

        OpusCodec = routerRtpCapabilities.Codecs.FirstOrDefault(c => c.IsOpus)
            ?? throw new InvalidOperationException("Router advertises no audio/opus codec.");

        RecvRtpCapabilities = new RtpCapabilities
        {
            Codecs = routerRtpCapabilities.Codecs
                .Where(c => c.Kind == "audio")
                .ToList(),
            HeaderExtensions = routerRtpCapabilities.HeaderExtensions
                .Where(e => e.Kind == "audio")
                .ToList(),
        };

        Loaded = true;
    }

    /// <summary>Audio header extensions advertised by the router (uri → id), for SDP/RTP building.</summary>
    public IReadOnlyList<RtpHeaderExtensionCapability> AudioHeaderExtensions =>
        RouterCapabilities.HeaderExtensions.Where(e => e.Kind == "audio").ToList();

    /// <summary>Look up a header extension id by URI, or null if the router doesn't offer it.</summary>
    public int? HeaderExtensionId(string uri) =>
        RouterCapabilities.HeaderExtensions.FirstOrDefault(e => e.Kind == "audio" && e.Uri == uri)?.PreferredId;
}
