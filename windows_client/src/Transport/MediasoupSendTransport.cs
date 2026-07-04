using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using SIPSorcery.Net;

namespace SonicRoom.Windows.Transport;

/// <summary>
/// Send transport: one SIPSorcery <see cref="RTCPeerConnection"/> carrying MULTIPLE producers
/// (voice, share, mic, file) as separate bundled sendonly audio m-lines — mirroring the web client.
/// Each producer gets its own <see cref="MediaStreamTrack"/> / <c>AudioStreamList</c> entry (distinct
/// SSRC + payload type) and is produced independently after renegotiating the PC.
///
/// DTLS: the fabricated answer uses <c>a=setup:active</c> so SIPSorcery is the DTLS server and we tell
/// mediasoup <c>connect-transport role:"server"</c> (done once, up front).
/// </summary>
public sealed class MediasoupSendTransport
{
    private readonly MediasoupRpc _rpc;
    private RTCPeerConnection? _pc;
    private TransportParams? _tp;
    private int _nextIndex; // 0-based producer index == AudioStreamList slot (primary is 0)

    public event Action<string>? Log;
    public event Action<RTCPeerConnectionState>? ConnectionStateChanged;
    public RTCPeerConnectionState? State => _pc?.connectionState;

    public MediasoupSendTransport(MediasoupRpc rpc) => _rpc = rpc;

    /// <summary>A live producer on this transport — hold it to push frames + stop it.</summary>
    public sealed class Producer
    {
        public required string ProducerId { get; init; }
        public required uint Ssrc { get; init; }
        public required AudioStream? Stream { get; init; }
        public required string Source { get; init; }
    }

    private async Task EnsureTransportAsync()
    {
        if (_pc is not null) return;

        _tp = await _rpc.CreateTransportAsync("send");
        Log?.Invoke($"send transport {_tp.Id} iceLite={_tp.IceParameters.IceLite} candidates={_tp.IceCandidates.Count}");

        var pc = new RTCPeerConnection(new RTCConfiguration { X_UseRsaForDtlsCertificate = false });
        _pc = pc;
        pc.onconnectionstatechange += s => { Log?.Invoke($"send pc → {s}"); ConnectionStateChanged?.Invoke(s); };

        var fp = pc.DtlsCertificateFingerprint
                 ?? throw new InvalidOperationException("No local DTLS fingerprint.");
        await _rpc.ConnectTransportAsync("send", new
        {
            role = "server", // SIPSorcery is DTLS server ⇒ mediasoup takes client (active)
            fingerprints = new[] { new { algorithm = fp.algorithm, value = fp.value } },
        });
    }

    /// <summary>
    /// Add a producer (its own track/SSRC), renegotiate, and produce it to the SFU.
    /// Opus is ALWAYS signaled as <c>opus/48000/2</c> — mediasoup's codec matching requires the
    /// channel count to equal the router's (2) exactly; mono vs stereo travels in the encoded
    /// packets plus the <c>stereo</c>/<c>sprop-stereo</c> fmtp hints, exactly as browsers do.
    /// <paramref name="maxAverageBitrate"/> mirrors the web's <c>opusMaxAverageBitrate</c>.
    /// </summary>
    public async Task<Producer> ProduceAsync(string source, string? title, bool stereo = true,
        int? maxAverageBitrate = null)
    {
        await EnsureTransportAsync();
        var pc = _pc!;

        // Distinct payload type per producer so bundled m-lines don't collide (100, 101, 102, …).
        // The Nth addTrack configures AudioStreamList[N] (index 0 = the pre-existing primary stream).
        var index = _nextIndex++;
        var pt = RemoteSdp.OpusPt + index;

        var opus = new SDPAudioVideoMediaFormat(SDPMediaTypesEnum.audio, pt, "opus", 48000, 2, RemoteSdp.OpusFmtp);
        var track = new MediaStreamTrack(SDPMediaTypesEnum.audio, false,
            new List<SDPAudioVideoMediaFormat> { opus }, MediaStreamStatusEnum.SendOnly, null, null);
        pc.addTrack(track);
        var ssrc = track.Ssrc;

        var offer = pc.createOffer(null);
        await pc.setLocalDescription(offer);

        var sections = RemoteSdp.ParseAudioSections(offer.sdp);
        var answer = RemoteSdp.BuildSendAnswer(_tp!, sections);
        var setRes = pc.setRemoteDescription(new RTCSessionDescriptionInit { type = RTCSdpType.answer, sdp = answer });
        Log?.Invoke($"send setRemoteDescription({sections.Count} m-line(s)) → {setRes}");

        var section = index < sections.Count ? sections[index] : new RemoteSdp.AudioSection(index.ToString(), pt, 2);
        Log?.Invoke($"diag: audioStreamList={pc.AudioStreamList.Count} sections={sections.Count} producingIdx={index} primary={(pc.AudioStream is null ? "null" : "ok")}");
        var stream = index < pc.AudioStreamList.Count ? pc.AudioStreamList[index]
                   : (index == 0 ? pc.AudioStream : null);
        var cname = stream?.RtcpSession?.Cname ?? pc.AudioStream?.RtcpSession?.Cname ?? Guid.NewGuid().ToString("N")[..16];

        var codecParameters = new Dictionary<string, object>
        {
            ["minptime"] = 10,
            ["useinbandfec"] = 1,
            ["usedtx"] = 0,
            ["stereo"] = stereo ? 1 : 0,
            ["sprop-stereo"] = stereo ? 1 : 0,
        };
        if (maxAverageBitrate is int mab) codecParameters["maxaveragebitrate"] = mab;

        var rtpParameters = new
        {
            codecs = new object[]
            {
                new
                {
                    mimeType = "audio/opus",
                    payloadType = section.PayloadType,
                    clockRate = 48000,
                    channels = 2,
                    parameters = codecParameters,
                    rtcpFeedback = new object[] { new { type = "transport-cc", parameter = "" } },
                },
            },
            encodings = new object[] { new { ssrc } },
            rtcp = new { cname, reducedSize = true },
        };

        var producerId = await _rpc.ProduceAsync("audio", rtpParameters, source, title);
        Log?.Invoke($"produced {source} producerId={producerId} ssrc={ssrc} pt={section.PayloadType}");

        return new Producer { ProducerId = producerId, Ssrc = ssrc, Stream = stream, Source = source };
    }

    /// <summary>Send one 20 ms Opus frame on a specific producer's audio stream.</summary>
    public void SendOpusFrame(Producer producer, byte[] opus) => producer.Stream?.SendAudio(960, opus);

    public void Close() => _pc?.close();
}
