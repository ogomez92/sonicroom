using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Concentus.Enums;
using Concentus.Structs;
using NAudio.Wave;
using SIPSorcery.Net;
using SonicRoom.Windows.Audio;
using SonicRoom.Windows.Signaling;
using SonicRoom.Windows.Transport;
using Cue = SonicRoom.Windows.Audio.Cue; // NAudio.Wave also has a Cue type

namespace SonicRoom.Windows.Session;

/// <summary>Immutable view of a remote participant for the UI.</summary>
public sealed record PeerView(string PeerId, string DisplayName);

/// <summary>One remote share/file/mic stream a peer is sending (for the stop-stream UI).</summary>
public sealed record PeerStream(string ProducerId, string Source, string? Title);

/// <summary>
/// The whole native call, as one object the UI drives: connect/leave, mute/deafen/volume, and
/// events for presence + connection state. Wires SignalingClient → MediasoupDevice →
/// send/recv transports → MicCapture/PeerMixer/Opus. All the pieces proven in Phases 1–3.
///
/// Events may fire off the UI thread — subscribers must marshal to their dispatcher.
/// </summary>
public sealed class RoomSession : IAsyncDisposable
{
    private readonly SignalingClient _sig = new();
    private readonly MediasoupDevice _device = new();
    private readonly PeerMixer _mixer = new();
    private readonly SonicRoom.Windows.Audio.ShareBus _shareBus = new();

    private MediasoupRpc? _rpc;
    private MediasoupSendTransport? _send;
    private MediasoupRecvTransport? _recv;
    private IMicrophoneCapture? _mic;
    private OpusEncoder? _encoder;
    private WaveOutEvent? _output;
    private byte[] _encodeBuf = new byte[4000];
    private readonly short[] _monoBuf = new short[960]; // downmix scratch for the default mono voice

    private MediasoupSendTransport.Producer? _voiceProducer;
    private MediasoupSendTransport.Producer? _shareProducer;
    private OpusEncoder? _shareEncoder;
    private System.Threading.CancellationTokenSource? _sharePumpCts;

    private readonly Dictionary<string, (MicCapture Cap, MediasoupSendTransport.Producer Prod)> _extraMics = new();
    private MediasoupSendTransport.Producer? _fileProducer;
    private System.Threading.CancellationTokenSource? _filePumpCts;

    private readonly object _map = new();
    private readonly Dictionary<string, string> _peerNames = new();          // peerId → name
    private readonly Dictionary<string, (string PeerId, string Source, uint Ssrc, string? Title)> _producers = new();
    private readonly Dictionary<string, List<uint>> _peerSsrcs = new();       // peerId → ssrcs
    private readonly Dictionary<string, int> _kickVotes = new();              // targetId → votes
    private readonly Dictionary<string, float> _peerVolumes = new();          // sticks across late producers
    private readonly HashSet<string> _peerLocalMuted = new();

    private bool _listenOnly;
    private bool _muted;
    private bool _deafened;
    private bool _voiceEncoderStereo;
    private readonly SemaphoreSlim _micSwitch = new(1, 1);
    private long _lastVoiceActiveMs; // Environment.TickCount64 of my last loud mic frame

    public event Action<string>? Log;
    public event Action<PeerView>? PeerJoined;
    public event Action<string>? PeerLeft;                 // peerId
    public event Action<string, bool>? PeerMuteChanged;    // peerId, muted
    public event Action<RTCPeerConnectionState>? SendConnectionChanged;
    public event Action<ChatMessage>? ChatReceived;
    public event Action<bool, string?>? RecordingChanged;   // active, by
    public event Action? RecordingExpiredEvent;
    public event Action<bool, string?>? StreamingChanged;   // active, by
    public event Action<string?>? StreamingFailed;
    public event Action? JoinPending;
    public event Action<IReadOnlyList<JoinRequestItem>>? JoinRequestsChanged;
    public event Action<KickVote>? KickVoteChanged;              // full payload: target/voter names + tally
    public event Action<string, string>? PeerKickedEvent;        // displayName, reason ("vote"|"caster")
    public event Action? YouWereKicked;
    public event Action? RoomBecamePublic;
    public event Action? Joined;
    public event Action<string, bool>? PeerShareChanged;         // displayName, started
    public event Action<string, bool>? PeerFileChanged;          // displayName, started
    public event Action<string>? PeerMicStreamStarted;           // displayName
    public event Action<string, bool>? PeerMicStreamStopped;     // displayName, last
    /// <summary>A peer's consumable share/file/mic/music producer set changed — refresh their row.</summary>
    public event Action<string>? PeerStreamsChanged;             // peerId
    /// <summary>Someone force-stopped a stream (<c>peer-stream-stopped</c>): owner name (empty
    /// when it was mine), the source, whether it was my own stream, and the producerId.</summary>
    public event Action<string, string, bool, string>? StreamForceStopped;
    /// <summary>A file streamer swapped files in place — owner display name + the new title.</summary>
    public event Action<string, string?>? FileTitleChanged;
    public event Action<string?>? FilePlaybackEnded;             // null = EOF, otherwise decoder error
    public event Action<bool, string?>? DuckingChangedEvent;     // enabled, by
    /// <summary>Processed capture failed and the primary microphone was restored raw.</summary>
    public event Action<int>? VoiceProcessingUnavailable;
    /// <summary>A selected legacy Wave device could not be mapped and the default was used.</summary>
    public event Action<string>? VoiceDeviceFallback;

    public bool IsRecording { get; private set; }
    /// <summary>Capability token for the download endpoints. Kept after the recording stops
    /// (the file stays downloadable) and dropped only on <c>recording-expired</c>.</summary>
    public string? RecordingId { get; private set; }
    public bool IsStreaming { get; private set; }
    public bool RoomIsPublic { get; private set; }
    public bool DuckingEnabled { get; private set; } = true;
    public string? MyPeerId { get; private set; }

    /// <summary>Hi-fi voice opt-in: stereo ~128 kbps instead of the default mono ~64 kbps.
    /// Read at call start (the live producer's codec can't be renegotiated) — set before Connect.</summary>
    public bool HifiVoice { get; set; }

    /// <summary>Desired voice-processing state before connect; active state thereafter.</summary>
    public bool VoiceProcessingEnabled { get; set; }
    public bool ActiveVoiceProcessing { get; private set; }

    /// <summary>Send-side mic boost (0–4×), applied before the soft limiter. Live-adjustable.</summary>
    public float MicGain { get; set; } = 1f;

    /// <summary>Outgoing media gain (0–2×), applied before local monitoring and Opus encoding.</summary>
    public float MediaVolume { get; set; } = 1f;

    /// <summary>Number of votable (human) participants including me — vote-to-kick needs ≥ 3.
    /// Casters are infrastructure, not people: they're excluded (matching the web's gate).</summary>
    public int VotableCount
    {
        get { lock (_map) return _peerNames.Keys.Count(p => !IsCasterLocked(p)) + 1; }
    }
    public int KickVotesFor(string peerId) { lock (_map) return _kickVotes.TryGetValue(peerId, out var v) ? v : 0; }

    public bool Muted => _muted;
    public bool Deafened => _deafened;
    public IReadOnlyDictionary<string, string> PeerNames => _peerNames;

    private int _micDeviceNumber = -1; // -1 = wave mapper (the Windows default input)
    private int _speakerDeviceNumber = -1;

    public async Task ConnectAsync(string serverUrl, string room, string displayName,
        bool listenOnly = false, bool makePublic = false, int micDeviceNumber = -1,
        int speakerDeviceNumber = -1)
    {
        _listenOnly = listenOnly;
        _micDeviceNumber = micDeviceNumber;
        _speakerDeviceNumber = speakerDeviceNumber;
        _shareBus.Log += m => Log?.Invoke($"[share] {m}");

        _output = new WaveOutEvent { DesiredLatency = 120, DeviceNumber = speakerDeviceNumber };
        _output.Init(_mixer);
        _output.Play();

        WireSignaling();
        await _sig.ConnectAsync(serverUrl);

        // Stable per-session token so a knock-approval + re-join is recognized as the same person.
        var req = new JoinRequest
        {
            RoomName = room,
            DisplayName = displayName,
            JoinToken = Guid.NewGuid().ToString("N"),
            IsPublic = makePublic ? true : null,
        };

        var ack = await _sig.JoinAsync(req);
        if (ack.IsPending)
        {
            JoinPending?.Invoke(); // UI shows "waiting to be let in…"
            var decision = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            void Approved() => decision.TrySetResult(true);
            void Denied(JoinDenied _) => decision.TrySetResult(false);
            _sig.OnJoinApproved += Approved;
            _sig.OnJoinDenied += Denied;
            try { if (!await decision.Task) throw new InvalidOperationException(I18n.T("join_denied")); }
            finally { _sig.OnJoinApproved -= Approved; _sig.OnJoinDenied -= Denied; }

            ack = await _sig.JoinAsync(req); // re-join with the same token, now admitted
            if (ack.IsPending) throw new InvalidOperationException("Still pending after approval.");
        }

        RoomIsPublic = ack.IsPublic;
        MyPeerId = _sig.Id;
        if (ack.KickVotes is not null)
            foreach (var kv in ack.KickVotes) _kickVotes[kv.TargetId] = kv.Votes;

        _device.Load(ack.RtpCapabilities);
        IsRecording = ack.Recording is not null;
        RecordingId = ack.Recording?.RecordingId;
        IsStreaming = ack.Streaming;
        DuckingEnabled = ack.DuckingEnabled;
        _mixer.DuckingEnabled = ack.DuckingEnabled;
        _mixer.DuckActive = ack.VoiceActive;
        _rpc = new MediasoupRpc(_sig);
        _recv = new MediasoupRecvTransport(_rpc, _device);
        _recv.Log += m => Log?.Invoke($"[recv] {m}");
        _recv.OpusPacketReceived += _mixer.OnOpusPacket;

        if (!listenOnly)
            await StartMicAsync();

        foreach (var peer in ack.Peers)
        {
            lock (_map) _peerNames[peer.PeerId] = peer.DisplayName;
            PeerJoined?.Invoke(new PeerView(peer.PeerId, peer.DisplayName));
            foreach (var pr in peer.Producers)
                await ConsumeAsync(peer.PeerId, pr.ProducerId, pr.Source, pr.Title);
        }

        if (ack.Messages is not null)
            foreach (var m in ack.Messages) ChatReceived?.Invoke(m);

        Joined?.Invoke();
        Log?.Invoke($"joined '{room}' as '{displayName}' (mode={ack.Mode}, peers={ack.Peers.Count})");
    }

    private async Task StartMicAsync()
    {
        _send = new MediasoupSendTransport(_rpc!);
        _send.Log += m => Log?.Invoke($"[send] {m}");
        _send.ConnectionStateChanged += s => SendConnectionChanged?.Invoke(s);

        // Voice matches the web defaults: mono ~64 kbps unless the user opted into hi-fi
        // (stereo ~128 kbps). 128k voice costs every listener in the SFU fan-out, and most
        // mics are mono — so hi-fi is opt-in, read once at call start.
        _voiceProducer = await _send.ProduceAsync("voice", null,
            stereo: HifiVoice, maxAverageBitrate: HifiVoice ? 128000 : 64000);
        _voiceEncoderStereo = HifiVoice;
        _encoder = _voiceEncoderStereo
            ? new OpusEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = 128000 }
            : new OpusEncoder(48000, 1, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = 64000 };
        await ReplacePrimaryCaptureAsync(VoiceProcessingEnabled);
    }

    /// <summary>
    /// Switches only the primary capture source. The send transport, producer, encoder, and room
    /// connection remain intact; extra microphones are deliberately unaffected.
    /// </summary>
    public async Task SwitchVoiceProcessingAsync(bool enabled)
    {
        VoiceProcessingEnabled = enabled;
        if (_listenOnly || _voiceProducer is null) { ActiveVoiceProcessing = false; return; }
        await ReplacePrimaryCaptureAsync(enabled);
    }

    private async Task ReplacePrimaryCaptureAsync(bool processed)
    {
        await _micSwitch.WaitAsync();
        try
        {
            var previous = _mic;
            _mic = null;
            if (previous is not null)
            {
                previous.FrameReady -= OnMicFrame;
                previous.Dispose();
            }

            IMicrophoneCapture next;
            if (processed)
            {
                ProcessedMicCapture? processedCapture = null;
                try
                {
                    var capture = VoiceDeviceMapper.MapCapture(_micDeviceNumber);
                    var render = VoiceDeviceMapper.MapRender(_speakerDeviceNumber);
                    if (capture.FellBack) VoiceDeviceFallback?.Invoke("microphone");
                    if (render.FellBack) VoiceDeviceFallback?.Invoke("speaker");
                    processedCapture = new ProcessedMicCapture(capture.EndpointIndex, render.EndpointIndex);
                    processedCapture.CaptureFailed += OnProcessedCaptureFailed;
                    next = processedCapture;
                    next.FrameReady += OnMicFrame;
                    next.Start();
                    ActiveVoiceProcessing = true;
                    _mic = next;
                    return;
                }
                catch (Exception ex)
                {
                    processedCapture?.Dispose();
                    var hr = System.Runtime.InteropServices.Marshal.GetHRForException(ex);
                    Diag.Log($"Voice processing unavailable (HRESULT 0x{hr:X8})", ex);
                    VoiceProcessingEnabled = false;
                    ActiveVoiceProcessing = false;
                    VoiceProcessingUnavailable?.Invoke(hr);
                }
            }

            next = new MicCapture(_micDeviceNumber);
            next.FrameReady += OnMicFrame;
            next.Start();
            _mic = next;
            ActiveVoiceProcessing = false;
        }
        finally { _micSwitch.Release(); }
    }

    private void OnProcessedCaptureFailed(Exception ex)
        => _ = RecoverFromProcessedCaptureFailureAsync(ex);

    private async Task RecoverFromProcessedCaptureFailureAsync(Exception ex)
    {
        var hr = System.Runtime.InteropServices.Marshal.GetHRForException(ex);
        Diag.Log($"Voice processing capture failed (HRESULT 0x{hr:X8})", ex);
        VoiceProcessingEnabled = false;
        ActiveVoiceProcessing = false;
        VoiceProcessingUnavailable?.Invoke(hr);
        await ReplacePrimaryCaptureAsync(processed: false);
    }

    private void OnMicFrame(short[] frame)
    {
        if (_send is null || _encoder is null || _voiceProducer is null || _muted) return;
        try
        {
            var gain = MicGain;
            short[] pcm;
            if (_voiceEncoderStereo)
            {
                // Stereo hi-fi: gain + soft limiter in place on the interleaved frame.
                if (gain != 1f)
                    for (var i = 0; i < frame.Length; i++) frame[i] = Limit(frame[i] * gain);
                pcm = frame;
            }
            else
            {
                // Default voice: downmix to mono, then gain + soft limiter.
                for (var i = 0; i < 960; i++)
                    _monoBuf[i] = Limit((frame[2 * i] + frame[2 * i + 1]) * 0.5f * gain);
                pcm = _monoBuf;
            }

            // Self "speaking" for the indicator/announcement (post-gain, so a boosted
            // quiet mic registers the same way peers hear it).
            var peak = 0;
            for (var i = 0; i < pcm.Length; i++) { var a = Math.Abs((int)pcm[i]); if (a > peak) peak = a; }
            if (peak > 700) _lastVoiceActiveMs = Environment.TickCount64;

            var len = _encoder.Encode(pcm, 0, 960, _encodeBuf, 0, _encodeBuf.Length);
            _send.SendOpusFrame(_voiceProducer, _encodeBuf[..len]);
        }
        catch { /* drop a frame on encoder hiccup */ }
    }

    /// <summary>
    /// Soft limiter on the boosted mic (the web's DynamicsCompressor stage): transparent below
    /// the knee, then a smooth tanh squash so a 4× boost saturates instead of hard-clipping.
    /// </summary>
    private static short Limit(float s)
    {
        var f = s / 32768f;
        const float knee = 0.85f;
        var a = Math.Abs(f);
        if (a > knee) a = knee + (1f - knee) * MathF.Tanh((a - knee) / (1f - knee));
        if (a > 1f) a = 1f;
        return (short)(MathF.Sign(f) * a * 32767f);
    }

    private async Task ConsumeAsync(string peerId, string producerId, string source, string? title = null)
    {
        try
        {
            var res = await _recv!.ConsumeAsync(producerId);
            var ssrc = res.RtpParameters.Encodings is { Count: > 0 } e ? e[0].Ssrc : 0u;
            var isMusic = source is "music" or "share" or "file";
            _mixer.SetMusic(ssrc, isMusic);
            lock (_map)
            {
                _producers[producerId] = (peerId, source, ssrc, title);
                if (!_peerSsrcs.TryGetValue(peerId, out var list)) _peerSsrcs[peerId] = list = new();
                list.Add(ssrc);
                // A late producer inherits the listener's existing per-peer volume/local-mute.
                if (_peerVolumes.TryGetValue(peerId, out var vol)) _mixer.SetVolume(ssrc, vol);
                if (_peerLocalMuted.Contains(peerId)) _mixer.SetLocalMuted(ssrc, true);
            }
            PeerStreamsChanged?.Invoke(peerId);
        }
        catch (Exception ex) { Log?.Invoke($"consume {producerId} failed: {ex.Message}"); }
    }

    private void WireSignaling()
    {
        _sig.Log += m => Log?.Invoke($"[sig] {m}");
        _sig.OnPeerJoined += p =>
        {
            lock (_map) _peerNames[p.PeerId] = p.DisplayName;
            PeerJoined?.Invoke(new PeerView(p.PeerId, p.DisplayName));
        };
        _sig.OnPeerLeft += p =>
        {
            CleanupPeer(p.PeerId);
            PeerLeft?.Invoke(p.PeerId);
        };
        _sig.OnNewProducer += np => { _ = ConsumeAsync(np.PeerId, np.ProducerId, np.Source, np.Title); };
        _sig.OnPeerMuted += p => PeerMuteChanged?.Invoke(p.PeerId, true);
        _sig.OnPeerUnmuted += p => PeerMuteChanged?.Invoke(p.PeerId, false);
        _sig.OnDuck += d => _mixer.DuckActive = d.Active;
        _sig.OnDuckingChanged += v =>
        {
            if (DuckingEnabled == v.Enabled) return; // echo of our own change — no-op
            DuckingEnabled = v.Enabled;
            _mixer.DuckingEnabled = v.Enabled;
            DuckingChangedEvent?.Invoke(v.Enabled, v.By);
        };
        _sig.OnChatMessage += m => ChatReceived?.Invoke(m);

        _sig.OnRecordingStarted += v => { IsRecording = true; RecordingId = v.RecordingId; RecordingChanged?.Invoke(true, v.By); };
        // Keep RecordingId: the finished file stays downloadable until recording-expired.
        _sig.OnRecordingStopped += _ => { IsRecording = false; RecordingChanged?.Invoke(false, null); };
        _sig.OnRecordingExpired += _ => { IsRecording = false; RecordingId = null; RecordingExpiredEvent?.Invoke(); };
        _sig.OnStreamingStarted += v => { IsStreaming = true; StreamingChanged?.Invoke(true, v.By); };
        _sig.OnStreamingStopped += () => { IsStreaming = false; StreamingChanged?.Invoke(false, null); };
        _sig.OnStreamingFailed += v => { IsStreaming = false; StreamingFailed?.Invoke(v.Error); };

        _sig.OnRoomPublic += () => { RoomIsPublic = true; RoomBecamePublic?.Invoke(); };
        _sig.OnJoinRequests += v => JoinRequestsChanged?.Invoke(v.Requests);
        _sig.OnKickVote += v => { lock (_map) _kickVotes[v.TargetId] = v.Votes; KickVoteChanged?.Invoke(v); };
        _sig.OnShareStarted += v => PeerShareChanged?.Invoke(v.DisplayName, true);
        _sig.OnShareStopped += v => { RemovePeerProducersBySource(v.PeerId, "share"); PeerShareChanged?.Invoke(v.DisplayName, false); };
        _sig.OnFileStarted += v => PeerFileChanged?.Invoke(v.DisplayName, true);
        _sig.OnFileStopped += v => { RemovePeerProducersBySource(v.PeerId, "file"); PeerFileChanged?.Invoke(v.DisplayName, false); };
        _sig.OnMicStarted += v => PeerMicStreamStarted?.Invoke(v.DisplayName);
        _sig.OnMicStopped += v =>
        {
            RemoveConsumedProducer(v.ProducerId);
            PeerMicStreamStopped?.Invoke(v.DisplayName, v.Last);
        };
        _sig.OnPeerStreamStopped += v =>
        {
            var wasMine = v.OwnerId == MyPeerId;
            var ownerName = "";
            if (wasMine)
            {
                HandleOwnStreamStopped(v.ProducerId, v.Source);
            }
            else
            {
                lock (_map) _peerNames.TryGetValue(v.OwnerId, out ownerName!);
                RemoveConsumedProducer(v.ProducerId);
            }
            StreamForceStopped?.Invoke(ownerName ?? "", v.Source, wasMine, v.ProducerId);
        };
        _sig.OnProducerTitleUpdated += v =>
        {
            string? peerId = null;
            string? ownerName = null;
            lock (_map)
            {
                if (_producers.TryGetValue(v.ProducerId, out var p))
                {
                    _producers[v.ProducerId] = (p.PeerId, p.Source, p.Ssrc, v.Title);
                    peerId = p.PeerId;
                    _peerNames.TryGetValue(p.PeerId, out ownerName);
                }
            }
            if (peerId is not null)
            {
                PeerStreamsChanged?.Invoke(peerId);
                FileTitleChanged?.Invoke(ownerName ?? "", v.Title);
            }
        };
        _sig.OnPeerKicked += v =>
        {
            CleanupPeer(v.PeerId);
            lock (_map) _kickVotes.Remove(v.PeerId);
            PeerKickedEvent?.Invoke(v.DisplayName, v.Reason);
            PeerLeft?.Invoke(v.PeerId);
        };
        _sig.OnYouWereKicked += () => YouWereKicked?.Invoke();
    }

    /// <summary>The server force-closed one of MY producers (anti-troll stop): tear down the
    /// matching local capture/pump WITHOUT re-emitting a stop (the server already reconciled).</summary>
    private void HandleOwnStreamStopped(string producerId, string source)
    {
        switch (source)
        {
            case "share":
                _sharePumpCts?.Cancel();
                _sharePumpCts = null;
                _shareBus.Stop();
                _shareProducer = null;
                break;
            case "file":
                _filePumpCts?.Cancel();
                _filePumpCts = null;
                _fileProducer = null;
                break;
            case "mic":
                if (_extraMics.Remove(producerId, out var m)) m.Cap.Dispose();
                break;
        }
    }

    private void CleanupPeer(string peerId)
    {
        lock (_map)
        {
            _peerNames.Remove(peerId);
            _peerVolumes.Remove(peerId);
            _peerLocalMuted.Remove(peerId);
            if (_peerSsrcs.Remove(peerId, out var ssrcs))
                foreach (var s in ssrcs) _mixer.RemoveSource(s);
            foreach (var id in _producers.Where(kv => kv.Value.PeerId == peerId).Select(kv => kv.Key).ToList())
                _producers.Remove(id);
        }
    }

    private void RemoveConsumedProducer(string producerId)
    {
        string? peerId = null;
        lock (_map)
        {
            if (_producers.Remove(producerId, out var p))
            {
                peerId = p.PeerId;
                _mixer.RemoveSource(p.Ssrc);
                if (_peerSsrcs.TryGetValue(p.PeerId, out var list)) list.Remove(p.Ssrc);
            }
        }
        if (peerId is not null) PeerStreamsChanged?.Invoke(peerId);
    }

    private void RemovePeerProducersBySource(string peerId, string source)
    {
        var changed = false;
        lock (_map)
        {
            foreach (var id in _producers
                         .Where(kv => kv.Value.PeerId == peerId && kv.Value.Source == source)
                         .Select(kv => kv.Key).ToList())
            {
                if (_producers.Remove(id, out var p))
                {
                    _mixer.RemoveSource(p.Ssrc);
                    if (_peerSsrcs.TryGetValue(peerId, out var list)) list.Remove(p.Ssrc);
                    changed = true;
                }
            }
        }
        if (changed) PeerStreamsChanged?.Invoke(peerId);
    }

    // ---- per-peer stream info (stop-stream / remove-caster UI) ------------------------------

    /// <summary>This peer's live share/file/mic streams — what the stop-stream button targets.</summary>
    public IReadOnlyList<PeerStream> GetPeerStreams(string peerId)
    {
        lock (_map)
            return _producers
                .Where(kv => kv.Value.PeerId == peerId &&
                             kv.Value.Source is "share" or "file" or "mic")
                .Select(kv => new PeerStream(kv.Key, kv.Value.Source, kv.Value.Title))
                .ToList();
    }

    /// <summary>A caster (Ecobox) is identified by its send-only "music" producer.</summary>
    public bool IsCaster(string peerId) { lock (_map) return IsCasterLocked(peerId); }

    private bool IsCasterLocked(string peerId)
        => _producers.Values.Any(p => p.PeerId == peerId && p.Source == "music");

    // ---- speaking indicators ------------------------------------------------------------------

    /// <summary>Whether my own mic registered voice within the hold window (and I'm not muted).</summary>
    public bool SelfSpeaking => !_muted && !_listenOnly
                                && Environment.TickCount64 - _lastVoiceActiveMs < 350;

    /// <summary>Peers whose VOICE stream decoded audible frames within the hold window.
    /// Music/share/file streams don't count — a playing song isn't "speaking".</summary>
    public IReadOnlyList<string> SpeakingPeerIds()
    {
        lock (_map)
            return _producers.Values
                .Where(p => p.Source == "voice" && _mixer.IsActive(p.Ssrc))
                .Select(p => p.PeerId)
                .Distinct()
                .ToList();
    }

    // ---- moderation (public rooms) ----------------------------------------------------------

    public Task VoteKickAsync(string targetId, bool vote) => _sig.EmitAckRawAsync("vote-kick", new { targetId, vote });
    public Task AdmitAsync(string requestId) => _sig.EmitAsync("join-decision", new { requestId, allow = true });
    public Task DenyAsync(string requestId) => _sig.EmitAsync("join-decision", new { requestId, allow = false });

    /// <summary>Stop one peer's share/file/mic stream outright (anti-troll; any room). The
    /// server hard-guards the source, closes the producer, and broadcasts peer-stream-stopped.</summary>
    public Task StopPeerStreamAsync(string producerId) => _sig.EmitAckRawAsync("stop-peer-stream", new { producerId });

    /// <summary>Remove a music caster immediately (any room; server hard-guards to casters).</summary>
    public Task KickCasterAsync(string targetId) => _sig.EmitAckRawAsync("kick-caster", new { targetId });

    // ---- room-wide auto-ducking ---------------------------------------------------------------

    public Task SetDuckingAsync(bool enabled) => _sig.EmitAckRawAsync("set-ducking", new { enabled });

    // ---- extra microphones (each is its own "mic" producer) --------------------------------

    public async Task<string?> StartExtraMicAsync(int deviceNumber, string name, bool stereo = false)
    {
        if (_listenOnly || _send is null) { Log?.Invoke("extra mic requires an active mic session"); return null; }

        await _sig.EmitAckRawAsync("start-extra-mic", new { });
        var prod = await _send.ProduceAsync("mic", name, stereo, maxAverageBitrate: stereo ? 96000 : 48000);
        var enc = new OpusEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = stereo ? 96000 : 48000 };
        var buf = new byte[4000];
        var cap = new MicCapture(deviceNumber);
        cap.FrameReady += frame =>
        {
            try { var len = enc.Encode(frame, 0, 960, buf, 0, buf.Length); _send.SendOpusFrame(prod, buf[..len]); }
            catch { /* drop a frame */ }
        };
        cap.Start();
        _extraMics[prod.ProducerId] = (cap, prod);
        Log?.Invoke($"extra mic '{name}' started");
        return prod.ProducerId;
    }

    public async Task StopExtraMicAsync(string producerId)
    {
        if (!_extraMics.Remove(producerId, out var m)) return;
        m.Cap.Dispose();
        try { await _sig.EmitAckRawAsync("stop-extra-mic", new { producerId }); }
        catch (Exception ex) { Log?.Invoke($"stop-extra-mic: {ex.Message}"); }
        Log?.Invoke("extra mic stopped");
    }

    // ---- file audio source (its own "file" producer) ---------------------------------------

    public bool IsStreamingFile => _fileProducer is not null;

    /// <summary>
    /// Start streaming a local file — or, when one is already streaming, SWAP the content on the
    /// live producer (no stop/start, so listeners keep one continuous stream and just see the
    /// title change via <c>update-stream-title</c> → <c>producer-title-updated</c>, like the web).
    /// </summary>
    public async Task<string> StartFileAsync(string source, string title)
    {
        if (_listenOnly || _send is null)
            throw new InvalidOperationException("Media streaming requires an active microphone session.");
        if (!File.Exists(source) &&
            (!Uri.TryCreate(source, UriKind.Absolute, out var uri) ||
             (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)))
        {
            throw new ArgumentException("The media source must be an existing local file or an HTTP/HTTPS URL.", nameof(source));
        }

        var requestedSource = source;
        (source, title) = await ResolveWebMediaWithRetriesAsync(source, title, CancellationToken.None);
        var ffmpeg = ResolveFfmpegPath();
        if (_fileProducer is { } live)
        {
            _filePumpCts?.Cancel();          // the old pump's finally sees the cancel and stays quiet
            _mixer.ClearLocalMedia();
            StartFilePump(live, source, requestedSource, title, ffmpeg);
            try { await _sig.EmitAckRawAsync("update-stream-title", new { producerId = live.ProducerId, title }); }
            catch (Exception ex) { Log?.Invoke($"update-stream-title: {ex.Message}"); }
            Log?.Invoke($"media swapped to '{title}'");
            return title;
        }

        await _sig.EmitAckRawAsync("start-file-stream", new { });
        var prod = await _send.ProduceAsync("file", title, stereo: true, maxAverageBitrate: 128000);
        _fileProducer = prod;
        StartFilePump(prod, source, requestedSource, title, ffmpeg);
        Log?.Invoke($"media streaming '{title}' started");
        return title;
    }

    private static async Task<(string Source, string Title)> ResolveWebMediaAsync(string source, string title)
    {
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri) || !IsYouTubeHost(uri.Host))
            return (source, title);

        var startInfo = new ProcessStartInfo(ResolveYtDlpPath())
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in new[] { "--no-playlist", "--no-warnings", "--format", "bestaudio/best",
                     "--print", "%(title)s", "--get-url", source })
            startInfo.ArgumentList.Add(arg);

        using var resolver = new Process { StartInfo = startInfo };
        if (!resolver.Start()) throw new InvalidOperationException("yt-dlp could not be started.");
        var outputTask = resolver.StandardOutput.ReadToEndAsync();
        var errorTask = resolver.StandardError.ReadToEndAsync();
        await resolver.WaitForExitAsync();
        var output = await outputTask;
        var error = (await errorTask).Trim();
        if (resolver.ExitCode != 0)
            throw new InvalidOperationException(string.IsNullOrEmpty(error)
                ? $"yt-dlp exited with code {resolver.ExitCode}."
                : error.Split('\n', StringSplitOptions.RemoveEmptyEntries).Last().Trim());

        var lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length < 2 || !Uri.TryCreate(lines[^1].Trim(), UriKind.Absolute, out var mediaUri) ||
            (mediaUri.Scheme != Uri.UriSchemeHttp && mediaUri.Scheme != Uri.UriSchemeHttps))
            throw new InvalidOperationException("yt-dlp did not return a playable media URL.");
        return (mediaUri.AbsoluteUri, lines[0].Trim());
    }

    private async Task<(string Source, string Title)> ResolveWebMediaWithRetriesAsync(
        string source, string title, CancellationToken cancellationToken)
    {
        const int maxRetries = 2;
        for (var retry = 0; ; retry++)
        {
            try { return await ResolveWebMediaAsync(source, title); }
            catch (Exception ex) when (retry < maxRetries && IsForbidden(ex))
            {
                Log?.Invoke($"media resolver returned 403; retrying ({retry + 1}/{maxRetries})");
                await Task.Delay(TimeSpan.FromSeconds(retry + 1), cancellationToken);
            }
        }
    }

    private static bool IsYouTubeHost(string host) =>
        host.Equals("youtu.be", StringComparison.OrdinalIgnoreCase) ||
        host.Equals("youtube.com", StringComparison.OrdinalIgnoreCase) ||
        host.EndsWith(".youtube.com", StringComparison.OrdinalIgnoreCase);

    private void StartFilePump(MediasoupSendTransport.Producer prod, string source,
        string requestedSource, string title, string ffmpeg)
    {
        var cts = new CancellationTokenSource();
        _filePumpCts = cts;
        _ = Task.Run(async () =>
        {
            string? failure = null;
            try
            {
                const int maxRetries = 2;
                var currentSource = source;
                for (var retry = 0; ; retry++)
                {
                    try
                    {
                        await RunFileDecoderAsync(prod, currentSource, ffmpeg, cts.Token);
                        break;
                    }
                    catch (Exception ex) when (!cts.IsCancellationRequested && retry < maxRetries && IsForbidden(ex))
                    {
                        Log?.Invoke($"media source returned 403; retrying ({retry + 1}/{maxRetries})");
                        _mixer.ClearLocalMedia();
                        await Task.Delay(TimeSpan.FromSeconds(retry + 1), cts.Token);
                        (currentSource, _) = await ResolveWebMediaWithRetriesAsync(
                            requestedSource, title, cts.Token);
                    }
                }
            }
            catch (OperationCanceledException) when (cts.IsCancellationRequested) { }
            catch (Exception ex)
            {
                failure = ex.Message;
                Log?.Invoke($"media playback error: {ex.Message}");
            }
            finally
            {
                if (!cts.IsCancellationRequested)
                {
                    await StopFileAsync();
                    FilePlaybackEnded?.Invoke(failure);
                }
                cts.Dispose();
            }
        });
    }

    private static bool IsForbidden(Exception ex) =>
        ex.Message.Contains("403", StringComparison.OrdinalIgnoreCase) ||
        ex.Message.Contains("Forbidden", StringComparison.OrdinalIgnoreCase);

    private async Task RunFileDecoderAsync(MediasoupSendTransport.Producer prod, string source,
        string ffmpeg, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo(ffmpeg)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        var arguments = new List<string> { "-nostdin", "-hide_banner", "-loglevel", "error" };
        if (Uri.TryCreate(source, UriKind.Absolute, out var mediaUri) &&
            (mediaUri.Scheme == Uri.UriSchemeHttp || mediaUri.Scheme == Uri.UriSchemeHttps))
        {
            arguments.AddRange(new[] { "-rw_timeout", "15000000", "-reconnect", "1",
                "-reconnect_streamed", "1", "-reconnect_delay_max", "5" });
        }
        arguments.AddRange(new[] { "-i", source, "-map", "0:a:0", "-vn", "-f", "s16le",
            "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", "pipe:1" });
        foreach (var arg in arguments) startInfo.ArgumentList.Add(arg);

        using var decoder = new Process { StartInfo = startInfo };
        if (!decoder.Start()) throw new InvalidOperationException("FFmpeg could not be started.");
        var errorTask = decoder.StandardError.ReadToEndAsync();
        using var cancelDecoder = cancellationToken.Register(() =>
        {
            try { if (!decoder.HasExited) decoder.Kill(entireProcessTree: true); }
            catch { }
        });

        // Decode-ahead: FFmpeg fills a bounded frame buffer as fast as it can decode (network
        // reads included), while the paced loop below drains it in real time. The ~5 s of
        // headroom absorbs network hiccups and slow decoder warm-up that used to underrun the
        // real-time read; playback gates on ~2 s buffered (or EOF) at start and after a stall.
        var buffer = new MediaFrameBuffer();
        var decodeAhead = Task.Run(async () =>
        {
            try
            {
                var byteBuf = new byte[960 * 2 * 2]; // 20 ms stereo 16-bit
                var stdout = decoder.StandardOutput.BaseStream;
                while (!cancellationToken.IsCancellationRequested)
                {
                    if (buffer.IsFull) // cap reached: let playback drain (FFmpeg waits on its pipe)
                    {
                        await Task.Delay(20, cancellationToken);
                        continue;
                    }
                    if (await FillExactAsync(stdout, byteBuf, cancellationToken) == 0) break;
                    var frame = new short[960 * 2];
                    for (var i = 0; i < frame.Length; i++)
                        frame[i] = (short)(byteBuf[i * 2] | (byteBuf[i * 2 + 1] << 8));
                    buffer.Enqueue(frame);
                }
            }
            finally { buffer.Complete(); }
        }, cancellationToken);

        var enc = new OpusEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = 128000 };
        var outBuf = new byte[4000];
        var playbackClock = Stopwatch.StartNew();
        long frameNumber = 0;
        var wasPlaying = false;

        while (!cancellationToken.IsCancellationRequested)
        {
            var read = buffer.TryRead(out var pcm);
            if (read == MediaFrameRead.Ended) break;
            if (read == MediaFrameRead.Buffering)
            {
                // Send nothing rather than garbage; remote and local both go quiet together.
                if (wasPlaying) Log?.Invoke("media rebuffering (decoder stalled)");
                wasPlaying = false;
                await Task.Delay(50, cancellationToken);
                continue;
            }
            if (read == MediaFrameRead.Resumed)
            {
                // Re-anchor the pacing clock so the stall doesn't count as accumulated lag
                // (the loop would otherwise blast frames to catch up).
                playbackClock.Restart();
                frameNumber = 0;
            }
            wasPlaying = true;

            var mediaVolume = MediaVolume;
            if (mediaVolume != 1f)
                for (var i = 0; i < pcm!.Length; i++)
                    pcm[i] = (short)Math.Clamp((int)(pcm[i] * mediaVolume), short.MinValue, short.MaxValue);
            _mixer.QueueLocalMedia(pcm!);
            var len = enc.Encode(pcm!, 0, 960, outBuf, 0, outBuf.Length);
            _send!.SendOpusFrame(prod, outBuf[..len]);
            frameNumber++;
            var delayMs = frameNumber * 20.0 - playbackClock.Elapsed.TotalMilliseconds;
            if (delayMs > 0) await Task.Delay(TimeSpan.FromMilliseconds(delayMs), cancellationToken);
        }

        if (cancellationToken.IsCancellationRequested) return;
        await decodeAhead; // surface read errors (e.g. a 403 mid-stream) to the retry loop
        await decoder.WaitForExitAsync(cancellationToken);
        var error = (await errorTask).Trim();
        if (decoder.ExitCode != 0)
            throw new InvalidOperationException(string.IsNullOrEmpty(error)
                ? $"FFmpeg exited with code {decoder.ExitCode}."
                : error.Split('\n', StringSplitOptions.RemoveEmptyEntries).Last().Trim());
    }

    private static async Task<int> FillExactAsync(Stream source, byte[] buffer, CancellationToken cancellationToken)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var n = await source.ReadAsync(buffer.AsMemory(total, buffer.Length - total), cancellationToken);
            if (n == 0) break;
            total += n;
        }
        Array.Clear(buffer, total, buffer.Length - total); // zero-pad the last partial frame
        return total;
    }

    private static string ResolveFfmpegPath()
    {
        foreach (var candidate in new[]
        {
            Path.Combine(AppContext.BaseDirectory, "ffmpeg.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
        })
            if (File.Exists(candidate)) return candidate;

        var packages = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft", "WinGet", "Packages");
        try
        {
            var installed = Directory.EnumerateDirectories(packages, "Gyan.FFmpeg.Essentials_*")
                .SelectMany(directory => Directory.EnumerateFiles(directory, "ffmpeg.exe", SearchOption.AllDirectories))
                .FirstOrDefault();
            if (installed is not null) return installed;
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }

        return "ffmpeg.exe";
    }

    private static string ResolveYtDlpPath()
    {
        foreach (var candidate in new[]
        {
            Path.Combine(AppContext.BaseDirectory, "yt-dlp.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Microsoft", "WinGet", "Links", "yt-dlp.exe"),
        })
            if (File.Exists(candidate)) return candidate;

        var packages = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft", "WinGet", "Packages");
        try
        {
            var installed = Directory.EnumerateDirectories(packages, "yt-dlp.yt-dlp_*")
                .SelectMany(directory => Directory.EnumerateFiles(directory, "yt-dlp.exe", SearchOption.AllDirectories))
                .FirstOrDefault();
            if (installed is not null) return installed;
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }

        return "yt-dlp.exe";
    }

    public async Task StopFileAsync()
    {
        _filePumpCts?.Cancel();
        _filePumpCts = null;
        _fileProducer = null;
        _mixer.ClearLocalMedia();
        try { await _sig.EmitAckRawAsync("stop-file-stream", new { }); }
        catch (Exception ex) { Log?.Invoke($"stop-file-stream: {ex.Message}"); }
        Log?.Invoke("file streaming stopped");
    }

    // ---- recording / Icecast streaming (room-wide; state comes from broadcast events) -------

    public Task StartRecordingAsync() => _sig.EmitAckRawAsync("start-recording", new { });
    public Task StopRecordingAsync() => _sig.EmitAckRawAsync("stop-recording", new { });

    /// <param name="icecastConfig">host/port/mount/username/password/format/bitrateKbps.</param>
    public Task StartStreamingAsync(object icecastConfig) => _sig.EmitAckRawAsync("start-streaming", icecastConfig);
    public Task StopStreamingAsync() => _sig.EmitAckRawAsync("stop-streaming", new { });

    /// <summary>Send a chat message (rate-limited server-side; failures are logged, not thrown).</summary>
    public async Task SendChatAsync(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        try { await _sig.EmitAckRawAsync("chat-message", new { text }); }
        catch (Exception ex) { Log?.Invoke($"chat send failed: {ex.Message}"); }
    }

    // ---- controls ---------------------------------------------------------------------------

    public bool IsSharing => _shareProducer is not null;

    public void SetMuted(bool muted)
    {
        if (_muted == muted || _listenOnly) return;
        _muted = muted;
        // Voice-only: producer-pause pauses only the "voice" producer server-side; share keeps flowing.
        _ = _sig.EmitAckRawAsync(muted ? "producer-pause" : "producer-resume", new { });
    }

    /// <summary>
    /// Start sharing app audio as its own <c>source:"share"</c> producer (mid-call renegotiation).
    /// Include the given PIDs (one capture each, mixed) or exclude a single PID.
    /// </summary>
    public async Task StartShareAsync(IReadOnlyList<uint> pids, bool includeMode)
    {
        if (_listenOnly || _send is null) { Log?.Invoke("app share requires an active mic session"); return; }
        if (_shareProducer is not null) return;

        _shareBus.Start(pids, includeMode);
        if (!_shareBus.Active) return;

        await _sig.EmitAckRawAsync("start-share", new { });
        _shareProducer = await _send.ProduceAsync("share", I18n.T("share_title"), stereo: true, maxAverageBitrate: 128000);
        _shareEncoder = new OpusEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = 128000 };

        var cts = new System.Threading.CancellationTokenSource();
        _sharePumpCts = cts;
        _ = Task.Run(async () =>
        {
            var frame = new short[960 * 2];
            var outBuf = new byte[4000];
            while (!cts.IsCancellationRequested)
            {
                Array.Clear(frame, 0, frame.Length);
                _shareBus.MixInto(frame); // fills the frame with the mixed app audio
                try
                {
                    var len = _shareEncoder!.Encode(frame, 0, 960, outBuf, 0, outBuf.Length);
                    if (_shareProducer is { } p) _send.SendOpusFrame(p, outBuf[..len]);
                }
                catch { /* drop a frame */ }
                await Task.Delay(20);
            }
        });
        Log?.Invoke("app share started");
    }

    public async Task StopShareAsync()
    {
        _sharePumpCts?.Cancel();
        _sharePumpCts = null;
        _shareBus.Stop();
        _shareProducer = null;
        try { await _sig.EmitAckRawAsync("stop-share", new { }); }
        catch (Exception ex) { Log?.Invoke($"stop-share: {ex.Message}"); }
        Log?.Invoke("app share stopped");
    }

    public void SetDeafened(bool deafened)
    {
        _deafened = deafened;
        _mixer.Deafened = deafened;
    }

    public void SetMasterVolume(float gain) => _mixer.MasterGain = gain;

    public void SetPeerVolume(string peerId, float gain)
    {
        lock (_map)
        {
            _peerVolumes[peerId] = gain;
            if (_peerSsrcs.TryGetValue(peerId, out var ssrcs))
                foreach (var s in ssrcs) _mixer.SetVolume(s, gain);
        }
    }

    /// <summary>Client-side one-click silence of everything a peer sends (my ears only).</summary>
    public void SetPeerLocalMute(string peerId, bool muted)
    {
        lock (_map)
        {
            if (muted) _peerLocalMuted.Add(peerId); else _peerLocalMuted.Remove(peerId);
            if (_peerSsrcs.TryGetValue(peerId, out var ssrcs))
                foreach (var s in ssrcs) _mixer.SetLocalMuted(s, muted);
        }
    }

    /// <summary>Play a UI cue (earcon) over the call audio. Audible even while deafened.</summary>
    public void PlayCue(Cue cue) => _mixer.PlayCue(Cues.Render(cue));

    public async Task LeaveAsync() => await DisposeAsync();

    public async ValueTask DisposeAsync()
    {
        _mic?.Dispose();
        _sharePumpCts?.Cancel();
        _filePumpCts?.Cancel();
        foreach (var m in _extraMics.Values) m.Cap.Dispose();
        _extraMics.Clear();
        _shareBus.Dispose();
        _output?.Dispose();
        _send?.Close();
        _recv?.Close();
        await _sig.DisposeAsync();
    }
}
