using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace SonicRoom.Windows.Transport;

/// <summary>
/// Recv transport: one SIPSorcery <see cref="RTCPeerConnection"/> that consumes every remote
/// producer. A single recvonly Opus/PT-100 m-line is used for all consumers — SIPSorcery's
/// payload-type fallback routes every (unknown) consumer SSRC to that stream, so no per-consumer
/// renegotiation is needed. We demux by SSRC in <see cref="OpusPacketReceived"/>.
///
/// Ordering that matters: the server requires <c>create-transport("recv")</c> to exist BEFORE
/// <c>consume</c>. So we (1) create the transport + pc + connect-transport, (2) consume, then
/// (3) negotiate SDP from the first consumer's params. DTLS: fabricated offer has
/// <c>a=setup:actpass</c> ⇒ SIPSorcery answers active (DTLS client) ⇒ <c>connect-transport role:"client"</c>.
/// </summary>
public sealed class MediasoupRecvTransport
{
    private const int OpusPt = 100;

    private readonly MediasoupRpc _rpc;
    private readonly MediasoupDevice _device;
    private RTCPeerConnection? _pc;
    private TransportParams? _tp;
    private bool _sdpNegotiated;
    private readonly Dictionary<uint, string> _consumerBySsrc = new(); // ssrc → consumerId

    public event Action<string>? Log;

    /// <summary>Raised per incoming RTP packet: (ssrc, opusPayload). Decode/mix downstream.</summary>
    public event Action<uint, byte[]>? OpusPacketReceived;

    public MediasoupRecvTransport(MediasoupRpc rpc, MediasoupDevice device)
    {
        _rpc = rpc;
        _device = device;
    }

    /// <summary>Consume one producer. Establishes the recv transport lazily on the first call.</summary>
    public async Task<ConsumeResult> ConsumeAsync(string producerId)
    {
        await EnsureTransportAsync();

        var consumer = await _rpc.ConsumeAsync(producerId, _device.RecvRtpCapabilities);
        var ssrc = consumer.RtpParameters.Encodings?.FirstOrDefault()?.Ssrc ?? 0;
        _consumerBySsrc[ssrc] = consumer.ConsumerId;
        Log?.Invoke($"consume {producerId} → consumerId={consumer.ConsumerId} ssrc={ssrc}");

        if (!_sdpNegotiated)
        {
            NegotiateFromFirstConsumer(consumer);
            await _pc!.setLocalDescription(_pendingAnswer!); // triggers ICE → DTLS
            _sdpNegotiated = true;
        }

        return consumer;
    }

    private RTCSessionDescriptionInit? _pendingAnswer;

    /// <summary>create-transport + pc + connect-transport (once), before any consume.</summary>
    private async Task EnsureTransportAsync()
    {
        if (_pc is not null) return;

        _tp = await _rpc.CreateTransportAsync("recv");
        Log?.Invoke($"recv transport {_tp.Id} iceLite={_tp.IceParameters.IceLite}");

        var pc = new RTCPeerConnection(new RTCConfiguration { X_UseRsaForDtlsCertificate = false });
        _pc = pc;
        pc.onconnectionstatechange += s => Log?.Invoke($"recv pc → {s}");
        pc.OnRtpPacketReceived += (System.Net.IPEndPoint ep, SDPMediaTypesEnum kind, RTPPacket pkt) =>
            OpusPacketReceived?.Invoke(pkt.Header.SyncSource, pkt.Payload);

        var opus = new SDPAudioVideoMediaFormat(SDPMediaTypesEnum.audio, OpusPt, "opus", 48000, 2, RemoteSdp.OpusFmtp);
        var track = new MediaStreamTrack(SDPMediaTypesEnum.audio, false,
            new List<SDPAudioVideoMediaFormat> { opus }, MediaStreamStatusEnum.RecvOnly, null, null);
        pc.addTrack(track);

        var fp = pc.DtlsCertificateFingerprint
                 ?? throw new InvalidOperationException("No local DTLS fingerprint.");
        await _rpc.ConnectTransportAsync("recv", new
        {
            role = "client", // SIPSorcery is DTLS client ⇒ mediasoup takes server
            fingerprints = new[] { new { algorithm = fp.algorithm, value = fp.value } },
        });
    }

    private void NegotiateFromFirstConsumer(ConsumeResult first)
    {
        var offerSdp = RemoteSdp.BuildRecvOffer(_tp!, first.RtpParameters);
        var setRes = _pc!.setRemoteDescription(new RTCSessionDescriptionInit
        {
            type = RTCSdpType.offer,
            sdp = offerSdp,
        });
        Log?.Invoke($"recv setRemoteDescription(offer) → {setRes}");
        _pendingAnswer = _pc.createAnswer(null);
    }

    public void Close() => _pc?.close();
}
