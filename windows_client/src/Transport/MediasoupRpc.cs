using System.Text.Json;
using System.Threading.Tasks;
using SonicRoom.Windows.Signaling;

namespace SonicRoom.Windows.Transport;

/// <summary>Typed wrappers for the mediasoup transport RPCs over the generic signaling client.</summary>
public sealed class MediasoupRpc
{
    private static readonly JsonSerializerOptions Web = new(System.Text.Json.JsonSerializerDefaults.Web);

    private readonly SignalingClient _sig;
    public MediasoupRpc(SignalingClient sig) => _sig = sig;

    public async Task<TransportParams> CreateTransportAsync(string direction)
    {
        var ack = await _sig.EmitAckRawAsync("create-transport", new { direction });
        var p = ack.GetProperty("params");
        return JsonSerializer.Deserialize<TransportParams>(p.GetRawText(), Web)!;
    }

    public Task ConnectTransportAsync(string direction, object dtlsParameters)
        => _sig.EmitAckRawAsync("connect-transport", new { direction, dtlsParameters });

    /// <param name="rtpParameters">Fully-formed mediasoup rtpParameters object (anonymous/dict).</param>
    public async Task<string> ProduceAsync(string kind, object rtpParameters, string source, string? title)
    {
        // Omit title when absent: the server's zod schema is .optional() (undefined ok, null rejected).
        var payload = new System.Collections.Generic.Dictionary<string, object?>
        {
            ["kind"] = kind,
            ["rtpParameters"] = rtpParameters,
            ["source"] = source,
        };
        if (!string.IsNullOrEmpty(title)) payload["title"] = title;

        var ack = await _sig.EmitAckRawAsync("produce", payload);
        return ack.GetProperty("producerId").GetString()!;
    }

    public async Task<ConsumeResult> ConsumeAsync(string producerId, RtpCapabilities recvCaps)
    {
        var ack = await _sig.EmitAckRawAsync("consume", new { producerId, rtpCapabilities = recvCaps });
        return new ConsumeResult
        {
            ConsumerId = ack.GetProperty("consumerId").GetString()!,
            ProducerId = ack.GetProperty("producerId").GetString()!,
            Kind = ack.TryGetProperty("kind", out var k) ? (k.GetString() ?? "audio") : "audio",
            RtpParameters = JsonSerializer.Deserialize<RtpParameters>(
                ack.GetProperty("rtpParameters").GetRawText(), Web)!,
        };
    }
}

public sealed class ConsumeResult
{
    public string ConsumerId { get; set; } = "";
    public string ProducerId { get; set; } = "";
    public string Kind { get; set; } = "audio";
    public RtpParameters RtpParameters { get; set; } = new();
}
