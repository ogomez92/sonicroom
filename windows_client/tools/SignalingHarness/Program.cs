using System.Text.Json;
using Concentus;
using Concentus.Enums;
using Concentus.Structs;
using NAudio.Wave;
using SIPSorcery.Net;
using SonicRoom.Windows.Audio;
using SonicRoom.Windows.Signaling;
using SonicRoom.Windows.Transport;

// Headless validation / probe harness.
//   dotnet run -- <serverUrl> [room] [displayName] [mode]
//   mode = "observe" (default): join, print ack, watch events 20s.
//   mode = "probe": join, then dump routerRtpCapabilities + create-transport params (the
//                   ground-truth JSON the Phase 2 mediasoup handshake is built against).

var url = args.Length > 0 ? args[0] : "http://localhost:3100";
var room = args.Length > 1 ? args[1] : "wintest";
var name = args.Length > 2 ? args[2] : "WinNative";
var mode = args.Length > 3 ? args[3] : "observe";

if (mode == "loopback")
{
    // Standalone test of the WASAPI Process Loopback capture (no server needed).
    // Usage: dotnet run -- x x x loopback [targetPid]
    Console.WriteLine($"IsSupported (Win build >= 20348): {ProcessLoopbackCapture.IsSupported}");
    Console.WriteLine("Apps with an audio session:");
    var apps = AudioAppEnumerator.List();
    foreach (var a in apps) Console.WriteLine($"  pid={a.ProcessId,-8} active={a.Active,-5} {a.Name}");

    uint target = args.Length > 4 && uint.TryParse(args[4], out var pv) ? pv
        : apps.FirstOrDefault(a => a.Active)?.ProcessId ?? apps.FirstOrDefault()?.ProcessId ?? 0;
    if (target == 0) { Console.WriteLine("No target app found."); return; }

    Console.WriteLine($"\nCapturing pid {target} (include) for 6s — make sure it's PLAYING audio…");
    long bytes = 0; var packets = 0; Exception? fault = null;
    var cap = new ProcessLoopbackCapture(target, includeMode: true);
    cap.DataAvailable += (_, e) => { Interlocked.Add(ref bytes, e.BytesRecorded); Interlocked.Increment(ref packets); };
    cap.CaptureFaulted += (_, ex) => fault = ex;
    try { cap.Start(); }
    catch (Exception ex) { Console.WriteLine($"[loopback] Start FAILED: {ex}"); return; }

    for (var t = 0; t < 6; t++) { await Task.Delay(1000); Console.WriteLine($"  t={t + 1}s  bytes={Interlocked.Read(ref bytes)} packets={packets}"); }
    cap.Dispose();
    Console.WriteLine($"[loopback] total {bytes} bytes in {packets} packets. fault={fault?.Message ?? "none"}");
    return;
}

Console.WriteLine($"→ connecting to {url}  room='{room}'  name='{name}'  mode={mode}");

await using var client = new SignalingClient();
client.Log += m => Console.WriteLine($"[log] {m}");
client.OnPeerJoined += p => Console.WriteLine($"[peer-joined] {p.DisplayName} ({p.PeerId})");
client.OnPeerLeft += p => Console.WriteLine($"[peer-left] {p.PeerId}");
client.OnNewProducer += np => Console.WriteLine($"[new-producer] peer={np.PeerId} source={np.Source} title={np.Title}");
client.OnPeerMuted += p => Console.WriteLine($"[peer-muted] {p.PeerId}");
client.OnPeerUnmuted += p => Console.WriteLine($"[peer-unmuted] {p.PeerId}");
client.OnChatMessage += c => Console.WriteLine($"[chat] {c.Sender}: {c.Text}");
client.OnDuck += d => Console.WriteLine($"[duck] active={d.Active}");
client.OnSwitchToSfu += _ => Console.WriteLine("[switch-to-sfu]");

static string Pretty(JsonElement el) =>
    JsonSerializer.Serialize(el, new JsonSerializerOptions { WriteIndented = true });

try
{
    await client.ConnectAsync(url);
    await Task.Delay(500);

    var ack = await client.JoinAsync(new JoinRequest { RoomName = room, DisplayName = name });
    if (ack.IsPending) { Console.WriteLine("[join] PENDING — knock-to-join."); return; }

    Console.WriteLine($"[join] OK  status={ack.Status}  mode={ack.Mode}  isPublic={ack.IsPublic}  " +
                      $"peers={ack.Peers.Count}  streaming={ack.Streaming}  ducking={ack.DuckingEnabled}");
    foreach (var p in ack.Peers)
        Console.WriteLine($"   · {p.DisplayName} ({p.PeerId}) muted={p.Muted} producers={p.Producers.Count} " +
                          $"[{string.Join(", ", p.Producers.ConvertAll(x => $"{x.Source}:{x.ProducerId}"))}]");

    if (mode == "probe")
    {
        Console.WriteLine("\n=====ROUTER_RTP_CAPABILITIES=====");
        Console.WriteLine(Pretty(ack.RtpCapabilities));

        var send = await client.EmitAckRawAsync("create-transport", new { direction = "send" });
        Console.WriteLine("\n=====CREATE_TRANSPORT_SEND=====");
        Console.WriteLine(Pretty(send));

        var recv = await client.EmitAckRawAsync("create-transport", new { direction = "recv" });
        Console.WriteLine("\n=====CREATE_TRANSPORT_RECV=====");
        Console.WriteLine(Pretty(recv));

        // --- verify the Phase 2 models parse the real JSON correctly ---
        Console.WriteLine("\n=====PARSE_CHECK=====");
        var device = new MediasoupDevice();
        device.Load(ack.RtpCapabilities);
        Console.WriteLine($"[device] loaded={device.Loaded} OpusPT={device.OpusCodec.PreferredPayloadType} " +
                          $"clock={device.OpusCodec.ClockRate} ch={device.OpusCodec.Channels} " +
                          $"opusParams={device.OpusCodec.Parameters?.Count} fb={device.OpusCodec.RtcpFeedback?.Count}");
        Console.WriteLine($"[device] recvCaps: audioCodecs={device.RecvRtpCapabilities.Codecs.Count} " +
                          $"audioExts={device.RecvRtpCapabilities.HeaderExtensions.Count}");
        Console.WriteLine($"[device] extIds: mid={device.HeaderExtensionId("urn:ietf:params:rtp-hdrext:sdes:mid")} " +
                          $"audioLevel={device.HeaderExtensionId("urn:ietf:params:rtp-hdrext:ssrc-audio-level")} " +
                          $"transportCc={device.HeaderExtensionId("http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01")}");

        var webOpts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var tp = JsonSerializer.Deserialize<TransportParams>(send.GetProperty("params").GetRawText(), webOpts)!;
        Console.WriteLine($"[transport] id={tp.Id} iceLite={tp.IceParameters.IceLite} ufragLen={tp.IceParameters.UsernameFragment.Length} " +
                          $"candidates={tp.IceCandidates.Count} dtlsRole={tp.DtlsParameters.Role} " +
                          $"fps=[{string.Join(",", tp.DtlsParameters.Fingerprints.Select(f => f.Algorithm))}]");
        foreach (var c in tp.IceCandidates)
            Console.WriteLine($"   cand {c.Protocol} {c.Ip}:{c.Port} {c.Type} prio={c.Priority}");

        Console.WriteLine("\n=====END_PROBE=====");
        return;
    }

    if (mode == "chat")
    {
        // Join, drop a chat line, linger, leave — for exercising another client's
        // join/chat/leave announcements end to end. Usage: ... <url> <room> <name> chat [text]
        var text = args.Length > 4 ? string.Join(' ', args[4..]) : "Hello from the harness";
        await Task.Delay(2000);
        await client.EmitAckRawAsync("chat-message", new { text });
        Console.WriteLine($"[chat] sent: {text}");
        await Task.Delay(4000);
        return;
    }

    if (mode == "call")
    {
        // ---- Phase 2/3 tracer bullet: produce a tone + consume remote producers over the real handshake ----
        var device = new MediasoupDevice();
        device.Load(ack.RtpCapabilities);
        var rpc = new MediasoupRpc(client);

        // SEND: produce a 440 Hz tone as our voice.
        var send = new MediasoupSendTransport(rpc);
        send.Log += m => Console.WriteLine($"[send] {m}");
        var voiceProducer = await send.ProduceAsync("voice", "WinNative tone");

        // RECV: consume every existing remote producer, decode, and meter levels.
        var recv = new MediasoupRecvTransport(rpc, device);
        recv.Log += m => Console.WriteLine($"[recv] {m}");
        var decoders = new Dictionary<uint, OpusDecoder>();
        var rtpIn = 0;
        long levelAccum = 0;
        recv.OpusPacketReceived += (ssrc, payload) =>
        {
            Interlocked.Increment(ref rtpIn);
            try
            {
                if (!decoders.TryGetValue(ssrc, out var dec)) { dec = new OpusDecoder(48000, 2); decoders[ssrc] = dec; }
                var pcm = new short[960 * 2];
                var n = dec.Decode(payload, 0, payload.Length, pcm, 0, 960, false);
                long s = 0; for (var i = 0; i < n * 2; i++) s += Math.Abs(pcm[i]);
                if (n > 0) Interlocked.Add(ref levelAccum, s / (n * 2));
            }
            catch { /* ignore decode hiccups in the tracer */ }
        };

        foreach (var p in ack.Peers)
            foreach (var pr in p.Producers)
            {
                try { await recv.ConsumeAsync(pr.ProducerId); }
                catch (Exception e) { Console.WriteLine($"[recv] consume {pr.ProducerId} FAILED: {e.Message}"); }
            }
        client.OnNewProducer += np => { _ = SafeConsume(recv, np.ProducerId); };

        // Tone pump: 20 ms stereo Opus frames.
        var enc = new OpusEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = 64000 };
        using var cts = new CancellationTokenSource();
        var pump = Task.Run(async () =>
        {
            var pcm = new short[960 * 2];
            var outBuf = new byte[4000];
            double phase = 0;
            while (!cts.IsCancellationRequested)
            {
                for (var i = 0; i < 960; i++)
                {
                    var v = (short)(Math.Sin(phase) * 8000);
                    pcm[i * 2] = v; pcm[i * 2 + 1] = v;
                    phase += 2 * Math.PI * 440 / 48000; if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
                }
                var len = enc.Encode(pcm, 0, 960, outBuf, 0, outBuf.Length);
                send.SendOpusFrame(voiceProducer, outBuf[..len]);
                await Task.Delay(20);
            }
        });

        for (var t = 0; t < 20; t++)
        {
            await Task.Delay(1000);
            var lvl = Interlocked.Exchange(ref levelAccum, 0);
            Console.WriteLine($"[call] t={t + 1}s sendState={send.State} rtpIn={rtpIn} recvLevel={lvl}");
        }

        cts.Cancel();
        send.Close();
        recv.Close();
        Console.WriteLine("call done.");
        return;
    }

    if (mode == "live")
    {
        // ---- Phase 3: a REAL call — mic → produce, consume → mix → speakers ----
        var device = new MediasoupDevice();
        device.Load(ack.RtpCapabilities);
        var rpc = new MediasoupRpc(client);

        var send = new MediasoupSendTransport(rpc);
        send.Log += m => Console.WriteLine($"[send] {m}");
        var voiceProducer = await send.ProduceAsync("voice", "WinNative mic");

        // Mic → Opus → produce.
        var enc = new OpusEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = 32000 };
        var outBuf = new byte[4000];
        using var mic = new MicCapture();
        mic.FrameReady += frame =>
        {
            try { var len = enc.Encode(frame, 0, 960, outBuf, 0, outBuf.Length); send.SendOpusFrame(voiceProducer, outBuf[..len]); }
            catch { /* ignore encode hiccup */ }
        };

        // Consume everyone → mix → speakers.
        var mixer = new PeerMixer();
        var recv = new MediasoupRecvTransport(rpc, device);
        recv.Log += m => Console.WriteLine($"[recv] {m}");
        recv.OpusPacketReceived += mixer.OnOpusPacket;
        foreach (var p in ack.Peers)
            foreach (var pr in p.Producers)
                try { await recv.ConsumeAsync(pr.ProducerId); }
                catch (Exception e) { Console.WriteLine($"[recv] consume {pr.ProducerId} FAILED: {e.Message}"); }
        client.OnNewProducer += np => { _ = SafeConsume(recv, np.ProducerId); };

        using var outDev = new WaveOutEvent { DesiredLatency = 120 };
        outDev.Init(mixer);
        outDev.Play();
        mic.Start();

        Console.WriteLine("LIVE — talk into the Windows mic (heard in the browser); browser audio plays on the");
        Console.WriteLine("Windows speakers. USE HEADPHONES to avoid an echo loop. Running 60s…");
        for (var t = 0; t < 60; t++)
        {
            await Task.Delay(1000);
            if ((t + 1) % 5 == 0) Console.WriteLine($"[live] t={t + 1}s send={send.State}");
        }

        mic.Stop();
        outDev.Stop();
        send.Close();
        recv.Close();
        Console.WriteLine("live done.");
        return;
    }

    if (mode == "mono")
    {
        // Validate the DEFAULT-voice produce shape: mono content signaled as opus/48000/2 with
        // stereo=0/sprop-stereo=0 fmtp hints + maxaveragebitrate (mediasoup's codec matching
        // requires channels==2 exactly; mono-ness lives in the packets + hints, as in browsers).
        var device = new MediasoupDevice();
        device.Load(ack.RtpCapabilities);
        var rpc = new MediasoupRpc(client);
        var send = new MediasoupSendTransport(rpc);
        send.Log += m => Console.WriteLine($"[send] {m}");

        var voice = await send.ProduceAsync("voice", null, stereo: false, maxAverageBitrate: 64000);
        Console.WriteLine($"[mono] voice producer={voice.ProducerId} ssrc={voice.Ssrc} (stereo=0 accepted)");

        await client.EmitAckRawAsync("start-extra-mic", new { });
        var mic = await send.ProduceAsync("mic", "Mono probe", stereo: false, maxAverageBitrate: 48000);
        Console.WriteLine($"[mono] extra-mic producer={mic.ProducerId} ssrc={mic.Ssrc} (stereo=0 accepted)");

        // Push a few real mono Opus frames so the transport path is exercised end to end.
        var enc = new OpusEncoder(48000, 1, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = 64000 };
        var pcm = new short[960]; var outb = new byte[4000]; double ph = 0;
        for (var f = 0; f < 150; f++)
        {
            for (var i = 0; i < 960; i++)
            {
                pcm[i] = (short)(Math.Sin(ph) * 8000);
                ph += 2 * Math.PI * 440 / 48000; if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
            }
            var len = enc.Encode(pcm, 0, 960, outb, 0, outb.Length);
            send.SendOpusFrame(voice, outb[..len]);
            await Task.Delay(20);
        }
        Console.WriteLine($"[mono] sent 150 mono frames, sendState={send.State}");

        await client.EmitAckRawAsync("stop-extra-mic", new { producerId = mic.ProducerId });
        send.Close();
        Console.WriteLine("mono done.");
        return;
    }

    if (mode == "multi")
    {
        // Prove multiple independent producers on ONE send transport (voice + share tones).
        var device = new MediasoupDevice();
        device.Load(ack.RtpCapabilities);
        var rpc = new MediasoupRpc(client);
        var send = new MediasoupSendTransport(rpc);
        send.Log += m => Console.WriteLine($"[send] {m}");

        using var cts = new CancellationTokenSource();
        Task Pump(MediasoupSendTransport.Producer p, int bitrate, double freq) => Task.Run(async () =>
        {
            var enc = new OpusEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = bitrate };
            var pcm = new short[1920]; var outb = new byte[4000]; double ph = 0;
            while (!cts.IsCancellationRequested)
            {
                for (var i = 0; i < 960; i++)
                {
                    var v = (short)(Math.Sin(ph) * 8000); pcm[i * 2] = v; pcm[i * 2 + 1] = v;
                    ph += 2 * Math.PI * freq / 48000; if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
                }
                var len = enc.Encode(pcm, 0, 960, outb, 0, outb.Length);
                send.SendOpusFrame(p, outb[..len]);
                await Task.Delay(20);
            }
        });

        var voice = await send.ProduceAsync("voice", "WinNative voice");
        Console.WriteLine($"[multi] voice producer={voice.ProducerId} ssrc={voice.Ssrc}");
        _ = Pump(voice, 32000, 440);

        Console.WriteLine("[multi] voice only for 5s (expect a 440 tone)…");
        for (var t = 0; t < 5; t++) { await Task.Delay(1000); Console.WriteLine($"[multi] t={t + 1}s send={send.State}"); }

        // Mid-call: add the share producer while voice is already connected (the real 'click Share' path).
        Console.WriteLine("[multi] adding SHARE producer mid-call…");
        var share = await send.ProduceAsync("share", "WinNative share");
        Console.WriteLine($"[multi] share producer={share.ProducerId} ssrc={share.Ssrc}");
        _ = Pump(share, 96000, 660);

        Console.WriteLine("[multi] voice+share for 8s (expect a 440+660 chord; voice must NOT drop)…");
        for (var t = 0; t < 8; t++) { await Task.Delay(1000); Console.WriteLine($"[multi] t={t + 1}s send={send.State}"); }

        cts.Cancel();
        send.Close();
        Console.WriteLine("multi done — 440 first, then a 440+660 chord + a separate share tile.");
        return;
    }

    if (mode == "share")
    {
        // Replicate RoomSession.StartShareAsync headlessly: voice producer + a real per-app
        // capture as a SEPARATE share producer, mid-call. Usage: ... share [pid]
        var device = new MediasoupDevice();
        device.Load(ack.RtpCapabilities);
        var rpc = new MediasoupRpc(client);
        var send = new MediasoupSendTransport(rpc);
        send.Log += m => Console.WriteLine($"[send] {m}");

        using var cts = new CancellationTokenSource();
        Task Pump(MediasoupSendTransport.Producer p, int bitrate, Func<short[], bool> fill) => Task.Run(async () =>
        {
            var enc = new OpusEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = bitrate };
            var pcm = new short[1920]; var outb = new byte[4000];
            while (!cts.IsCancellationRequested)
            {
                if (fill(pcm)) { var len = enc.Encode(pcm, 0, 960, outb, 0, outb.Length); send.SendOpusFrame(p, outb[..len]); }
                await Task.Delay(20);
            }
        });

        var voice = await send.ProduceAsync("voice", "WinNative voice");
        double vph = 0;
        _ = Pump(voice, 32000, f => { for (var i = 0; i < 960; i++) { var v = (short)(Math.Sin(vph) * 5000); f[i * 2] = v; f[i * 2 + 1] = v; vph += 2 * Math.PI * 440 / 48000; if (vph > 2 * Math.PI) vph -= 2 * Math.PI; } return true; });
        Console.WriteLine("[share] voice connecting…");
        await Task.Delay(3000);

        var pid = args.Length > 4 && uint.TryParse(args[4], out var pv) ? pv
            : AudioAppEnumerator.List().FirstOrDefault(a => a.Active)?.ProcessId ?? 0;
        Console.WriteLine($"[share] starting capture of pid {pid}…");
        var shareBus = new ShareBus();
        shareBus.Log += m => Console.WriteLine($"[sharebus] {m}");
        shareBus.Start(new[] { pid }, includeMode: true);
        Console.WriteLine($"[share] shareBus.Active={shareBus.Active}");

        if (shareBus.Active)
        {
            await client.EmitAckRawAsync("start-share", new { });
            var shareProducer = await send.ProduceAsync("share", "App audio");
            Console.WriteLine($"[share] share producer={shareProducer.ProducerId} ssrc={shareProducer.Ssrc}");
            _ = Pump(shareProducer, 128000, f => { Array.Clear(f, 0, f.Length); shareBus.MixInto(f); return true; });
        }

        for (var t = 0; t < 12; t++) { await Task.Delay(1000); Console.WriteLine($"[share] t={t + 1}s send={send.State}"); }
        cts.Cancel(); shareBus.Dispose(); send.Close();
        Console.WriteLine("share done — expect a 440 tone (voice) + the app's audio as a separate share tile.");
        return;
    }

    Console.WriteLine("Observing events for 20s…");
    await Task.Delay(20_000);
    Console.WriteLine("done.");
}
catch (Exception ex)
{
    Console.WriteLine($"[FAIL] {ex.GetType().Name}: {ex.Message}");
    Environment.ExitCode = 1;
}

static async Task SafeConsume(MediasoupRecvTransport recv, string producerId)
{
    try { await recv.ConsumeAsync(producerId); }
    catch (Exception e) { Console.WriteLine($"[recv] consume {producerId} FAILED: {e.Message}"); }
}
