using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SocketIO.Core;
using SocketIOClient;
using SocketIOClient.Transport;

namespace SonicRoom.Windows.Signaling;

/// <summary>
/// C# socket.io client speaking SonicRoom's signaling protocol. Websocket-only, SFU-only.
/// Server RPCs use an ack envelope <c>{ ok, error?, ... }</c>; <see cref="EmitAckAsync{T}"/>
/// resolves on <c>ok:true</c> and throws <see cref="SignalingException"/> on <c>ok:false</c>,
/// with a 10s timeout (matching the web client's <c>socket.timeout(10_000)</c>).
///
/// Phase 1 wires the join handshake plus the core presence/producer/duck/chat events; the
/// transport RPCs (create-transport / connect-transport / produce / consume) land in Phase 2.
/// </summary>
public sealed class SignalingClient : IAsyncDisposable
{
    private const int DefaultAckTimeoutMs = 10_000;

    // Fully qualified: `using SocketIO.Core` introduces a root `SocketIO` namespace that would
    // otherwise shadow the SocketIOClient.SocketIO class name.
    private SocketIOClient.SocketIO? _io;

    public event Action<string>? Log;
    public event Action? Connected;
    public event Action<string>? Disconnected;

    public event Action<PeerJoined>? OnPeerJoined;
    public event Action<PeerLeft>? OnPeerLeft;
    public event Action<NewProducer>? OnNewProducer;
    public event Action<PeerMuteState>? OnPeerMuted;
    public event Action<PeerMuteState>? OnPeerUnmuted;
    public event Action<DuckState>? OnDuck;
    public event Action<DuckingChanged>? OnDuckingChanged;
    public event Action<ChatMessage>? OnChatMessage;
    public event Action<SwitchToSfu>? OnSwitchToSfu;

    public event Action<RecordingStarted>? OnRecordingStarted;
    public event Action<RecordingStopped>? OnRecordingStopped;
    public event Action<ByEvent>? OnStreamingStarted;
    public event Action? OnStreamingStopped;
    public event Action<StreamingFailed>? OnStreamingFailed;

    public event Action<KickVote>? OnKickVote;
    public event Action<PeerKicked>? OnPeerKicked;
    public event Action? OnYouWereKicked;
    public event Action<JoinRequestsMsg>? OnJoinRequests;
    public event Action? OnJoinApproved;
    public event Action<JoinDenied>? OnJoinDenied;
    public event Action? OnRoomPublic;

    public event Action<StreamPresence>? OnShareStarted;
    public event Action<StreamPresence>? OnShareStopped;
    public event Action<StreamPresence>? OnFileStarted;
    public event Action<StreamPresence>? OnFileStopped;
    public event Action<StreamPresence>? OnMicStarted;
    public event Action<MicStreamStopped>? OnMicStopped;
    public event Action<PeerStreamStopped>? OnPeerStreamStopped;
    public event Action<ProducerTitleUpdated>? OnProducerTitleUpdated;
    public event Action<RecordingExpired>? OnRecordingExpired;

    public bool IsConnected => _io?.Connected ?? false;

    /// <summary>The current socket id (this client's peer id), once connected.</summary>
    public string? Id => _io?.Id;

    public async Task ConnectAsync(string serverUrl, CancellationToken ct = default)
    {
        _io = new SocketIOClient.SocketIO(new Uri(serverUrl), new SocketIOOptions
        {
            Transport = TransportProtocol.WebSocket, // server is websocket-only
            EIO = EngineIO.V4,                        // socket.io v4 server
            Reconnection = true,
            ReconnectionDelayMax = 5000,
        });

        WireEvents();

        _io.OnConnected += (_, _) =>
        {
            Log?.Invoke($"connected (id={_io.Id})");
            Connected?.Invoke();
        };
        _io.OnDisconnected += (_, reason) =>
        {
            Log?.Invoke($"disconnected: {reason}");
            Disconnected?.Invoke(reason);
        };

        await _io.ConnectAsync();
    }

    /// <summary>
    /// Perform the <c>join</c> handshake. Returns the ack; caller must check
    /// <see cref="JoinAck.IsPending"/> (knock-to-join) and, on approval, re-join with the token.
    /// Throws <see cref="SignalingException"/> if the ack is <c>ok:false</c> (e.g. "banned").
    /// </summary>
    public Task<JoinAck> JoinAsync(JoinRequest request, int timeoutMs = DefaultAckTimeoutMs)
        => EmitAckAsync<JoinAck>("join", request.ToWire(), timeoutMs);

    /// <summary>Emit an event with an ack, enforcing the <c>{ok,error}</c> envelope + timeout.</summary>
    public async Task<T> EmitAckAsync<T>(string eventName, object payload,
        int timeoutMs = DefaultAckTimeoutMs) where T : class
    {
        if (_io is null) throw new InvalidOperationException("SignalingClient is not connected.");

        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);

        await _io.EmitAsync(eventName, resp =>
        {
            try
            {
                // Peek at the envelope's ok/error first, then materialize the full type.
                var env = resp.GetValue<JsonElement>(0);
                if (env.ValueKind == JsonValueKind.Object
                    && env.TryGetProperty("ok", out var okEl)
                    && okEl.ValueKind == JsonValueKind.False)
                {
                    var error = env.TryGetProperty("error", out var errEl) && errEl.ValueKind == JsonValueKind.String
                        ? errEl.GetString()!
                        : "request failed";
                    tcs.TrySetException(new SignalingException(error));
                }
                else
                {
                    tcs.TrySetResult(resp.GetValue<T>(0));
                }
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }
        }, payload);

        var winner = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs));
        if (winner != tcs.Task)
            throw new TimeoutException($"'{eventName}' ack timed out after {timeoutMs} ms");

        return await tcs.Task;
    }

    /// <summary>
    /// Emit with an ack and return the raw ack object as a <see cref="JsonElement"/> (envelope
    /// included). Used by the transport RPCs (create-transport / connect-transport / produce /
    /// consume) that carry opaque mediasoup params parsed field-by-field. Throws on <c>ok:false</c>.
    /// </summary>
    public async Task<JsonElement> EmitAckRawAsync(string eventName, object payload,
        int timeoutMs = DefaultAckTimeoutMs)
    {
        if (_io is null) throw new InvalidOperationException("SignalingClient is not connected.");

        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        await _io.EmitAsync(eventName, resp =>
        {
            try { tcs.TrySetResult(resp.GetValue<JsonElement>(0)); }
            catch (Exception ex) { tcs.TrySetException(ex); }
        }, payload);

        var winner = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs));
        if (winner != tcs.Task)
            throw new TimeoutException($"'{eventName}' ack timed out after {timeoutMs} ms");

        var ack = await tcs.Task;
        if (ack.ValueKind == JsonValueKind.Object
            && ack.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.False)
        {
            var error = ack.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String
                ? e.GetString()! : "request failed";
            throw new SignalingException(error);
        }
        return ack;
    }

    /// <summary>Fire-and-forget emit (no ack), e.g. producer-pause / join-decision.</summary>
    public async Task EmitAsync(string eventName, object payload)
    {
        if (_io is null) throw new InvalidOperationException("SignalingClient is not connected.");
        await _io.EmitAsync(eventName, payload);
    }

    private void WireEvents()
    {
        Handle<PeerJoined>("peer-joined", v => OnPeerJoined?.Invoke(v));
        Handle<PeerLeft>("peer-left", v => OnPeerLeft?.Invoke(v));
        Handle<NewProducer>("new-producer", v => OnNewProducer?.Invoke(v));
        Handle<PeerMuteState>("peer-muted", v => OnPeerMuted?.Invoke(v));
        Handle<PeerMuteState>("peer-unmuted", v => OnPeerUnmuted?.Invoke(v));
        Handle<DuckState>("duck", v => OnDuck?.Invoke(v));
        Handle<DuckingChanged>("ducking-changed", v => OnDuckingChanged?.Invoke(v));
        Handle<ChatMessage>("chat-message", v => OnChatMessage?.Invoke(v));
        Handle<SwitchToSfu>("switch-to-sfu", v => OnSwitchToSfu?.Invoke(v));

        Handle<RecordingStarted>("recording-started", v => OnRecordingStarted?.Invoke(v));
        Handle<RecordingStopped>("recording-stopped", v => OnRecordingStopped?.Invoke(v));
        Handle<ByEvent>("streaming-started", v => OnStreamingStarted?.Invoke(v));
        HandleBare("streaming-stopped", () => OnStreamingStopped?.Invoke());
        Handle<StreamingFailed>("streaming-failed", v => OnStreamingFailed?.Invoke(v));

        Handle<KickVote>("kick-vote", v => OnKickVote?.Invoke(v));
        Handle<PeerKicked>("peer-kicked", v => OnPeerKicked?.Invoke(v));
        HandleBare("you-were-kicked", () => OnYouWereKicked?.Invoke());
        Handle<JoinRequestsMsg>("join-requests", v => OnJoinRequests?.Invoke(v));
        HandleBare("join-approved", () => OnJoinApproved?.Invoke());
        Handle<JoinDenied>("join-denied", v => OnJoinDenied?.Invoke(v));
        HandleBare("room-public", () => OnRoomPublic?.Invoke());

        Handle<StreamPresence>("share-started", v => OnShareStarted?.Invoke(v));
        Handle<StreamPresence>("share-stopped", v => OnShareStopped?.Invoke(v));
        Handle<StreamPresence>("file-stream-started", v => OnFileStarted?.Invoke(v));
        Handle<StreamPresence>("file-stream-stopped", v => OnFileStopped?.Invoke(v));
        Handle<StreamPresence>("mic-stream-started", v => OnMicStarted?.Invoke(v));
        Handle<MicStreamStopped>("mic-stream-stopped", v => OnMicStopped?.Invoke(v));
        Handle<PeerStreamStopped>("peer-stream-stopped", v => OnPeerStreamStopped?.Invoke(v));
        Handle<ProducerTitleUpdated>("producer-title-updated", v => OnProducerTitleUpdated?.Invoke(v));
        Handle<RecordingExpired>("recording-expired", v => OnRecordingExpired?.Invoke(v));

        // During bring-up, surface every other server event as a raw log line so nothing is
        // silently dropped before its typed handler exists.
        foreach (var name in RawLoggedEvents)
        {
            var ev = name;
            _io!.On(ev, resp => Log?.Invoke($"[evt] {ev} {SafeRaw(resp)}"));
        }
    }

    /// <summary>Register a typed handler; the dispatch lambda reads the event field at call time.</summary>
    private void Handle<T>(string name, Action<T> dispatch)
    {
        _io!.On(name, resp =>
        {
            try
            {
                var value = resp.GetValue<T>(0);
                if (value is not null) dispatch(value);
            }
            catch (Exception ex)
            {
                Log?.Invoke($"[evt] {name} parse error: {ex.Message}");
            }
        });
    }

    /// <summary>Register a handler for a payload-less server event.</summary>
    private void HandleBare(string name, Action dispatch)
    {
        _io!.On(name, _ =>
        {
            try { dispatch(); }
            catch (Exception ex) { Log?.Invoke($"[evt] {name}: {ex.Message}"); }
        });
    }

    private static string SafeRaw(SocketIOResponse resp)
    {
        try { return resp.GetValue<JsonElement>(0).GetRawText(); }
        catch { return "<unreadable>"; }
    }

    // Events not yet given typed handlers — logged verbatim for now. switch-to-p2p can never
    // apply to this client (it always joins disableP2p:true, which pins the room to the SFU).
    private static readonly string[] RawLoggedEvents =
    {
        "switch-to-p2p",
    };

    public async ValueTask DisposeAsync()
    {
        if (_io is not null)
        {
            try { await _io.DisconnectAsync(); } catch { /* best effort */ }
            _io.Dispose();
            _io = null;
        }
    }
}
