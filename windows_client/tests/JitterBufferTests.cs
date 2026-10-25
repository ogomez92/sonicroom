using System;
using System.Collections.Generic;
using Concentus.Enums;
using Concentus.Structs;
using SonicRoom.Windows.Audio;
using Xunit;

namespace SonicRoom.Windows.Tests;

public class JitterBufferTests
{
    private const int Frame = 480;   // 10 ms @ 48 kHz, what SonicRoom's server negotiates

    // Encode N consecutive 10 ms frames of a continuous 440 Hz stereo tone.
    private static List<byte[]> Packets(int count, bool fec = false)
    {
        var enc = new OpusEncoder(48000, 2, OpusApplication.OPUS_APPLICATION_VOIP)
        { Bitrate = 64000, UseInbandFEC = fec, PacketLossPercent = fec ? 20 : 0 };
        var pcm = new short[Frame * 2];
        var buf = new byte[4000];
        var list = new List<byte[]>();
        for (var f = 0; f < count; f++)
        {
            for (var i = 0; i < Frame; i++)
            {
                var v = (short)(Math.Sin(2 * Math.PI * 440 * ((f * Frame + i) / 48000.0)) * 12000);
                pcm[i * 2] = v; pcm[i * 2 + 1] = v;
            }
            var len = enc.Encode(pcm, 0, Frame, buf, 0, buf.Length);
            list.Add(buf[..len]);
        }
        return list;
    }

    // Frames concealed because the test's stream ended (buffer ran dry), as
    // opposed to a lost packet in the middle.
    private static long TailConceal(OpusJitterBuffer jb) => jb.Underruns > 0 ? 3 : 0;

    private static double Rms(short[] s, int n)
    {
        double sum = 0;
        for (var i = 0; i < n; i++) sum += (double)s[i] * s[i];
        return Math.Sqrt(sum / Math.Max(1, n));
    }

    // Real-time feed: one packet ARRIVES per 10 ms (in the given order, null =
    // nothing arrives), and 10 ms is played per tick. Returns each tick's RMS.
    private static List<double> Feed(OpusJitterBuffer jb, IList<(int seq, byte[] pkt)?> arrivals)
    {
        var out10 = new short[Frame * 2];
        var levels = new List<double>();
        foreach (var a in arrivals)
        {
            if (a is { } x) jb.Push(unchecked((ushort)x.seq), x.pkt);
            jb.Pull(out10, Frame);
            levels.Add(Rms(out10, out10.Length));
        }
        return levels;
    }

    private static List<(int, byte[])?> InOrder(List<byte[]> pk, int seqBase = 0)
    {
        var l = new List<(int, byte[])?>();
        for (var i = 0; i < pk.Count; i++) l.Add((seqBase + i, pk[i]));
        return l;
    }

    // Levels from the moment playback started up to (not including) the tail,
    // where the stream legitimately runs out.
    private static List<double> Middle(List<double> levels, int tail = 6)
    {
        var start = levels.FindIndex(l => l > 0);
        return levels.GetRange(start, levels.Count - tail - start);
    }

    [Fact]
    public void InOrderStreamPlaysWithoutGapsAfterTheStartTarget()
    {
        var jb = new OpusJitterBuffer();
        var pk = Packets(60);
        var out10 = new short[Frame * 2];
        var silentAfterStart = 0;
        var started = false;
        for (var i = 0; i < pk.Count; i++)
        {
            jb.Push((ushort)i, pk[i]);                 // one packet arrives per 10 ms
            var real = jb.Pull(out10, Frame);
            if (real > 0) started = true;
            else if (started && i < pk.Count - 1) silentAfterStart++;
        }
        Assert.True(started);
        Assert.Equal(0, silentAfterStart);
        Assert.Equal(0, jb.Concealed);
        Assert.True(jb.BufferedMs <= OpusJitterBuffer.StartTargetMs + 10,
            $"delay should sit near the target, was {jb.BufferedMs} ms");
    }

    [Fact]
    public void ReorderedPacketsArePlayedInSequenceWithoutConcealment()
    {
        var jb = new OpusJitterBuffer();
        var pk = Packets(40);
        var arrivals = new List<(int, byte[])?>();
        for (var i = 0; i < 40; i += 2) { arrivals.Add((i + 1, pk[i + 1])); arrivals.Add((i, pk[i])); }
        var levels = Feed(jb, arrivals);
        Assert.Equal(0, jb.LatePackets);
        Assert.All(Middle(levels), l => Assert.True(l > 3000, $"tone expected, rms {l:F0}"));
        Assert.Equal(0, jb.Underruns);
    }

    [Fact]
    public void LostPacketIsConcealedNotLeftAsSilence()
    {
        var jb = new OpusJitterBuffer();
        var pk = Packets(40);
        var arrivals = InOrder(pk);
        arrivals[20] = null;                       // packet 20 never arrives
        var levels = Feed(jb, arrivals);
        Assert.Equal(1, jb.FecRecovered + jb.Concealed - TailConceal(jb));
        Assert.All(Middle(levels), l => Assert.True(l > 1000, $"no hole expected, rms {l:F0}"));
    }

    [Fact]
    public void LostPacketIsRebuiltFromInBandFecWhenPresent()
    {
        var jb = new OpusJitterBuffer();
        var pk = Packets(40, fec: true);
        var arrivals = InOrder(pk);
        arrivals[20] = null;
        Feed(jb, arrivals);
        Assert.Equal(1, jb.FecRecovered);
        Assert.Equal(0, jb.Concealed - TailConceal(jb));
    }

    [Fact]
    public void FastSenderClockIsTrimmedGraduallyNotClearedInABlock()
    {
        // Sender produces 11 frames per 10 frames played (10% fast, far worse than
        // any real clock). The old queue grew to 400 ms and then dropped all of it.
        var jb = new OpusJitterBuffer();
        var pk = Packets(1100);
        var out10 = new short[Frame * 2];
        var seq = 0;
        var maxBuffered = 0;
        var silentPulls = 0;
        for (var p = 0; p < 1000; p++)
        {
            jb.Push((ushort)seq, pk[seq]); seq++;
            if (p % 10 == 0) { jb.Push((ushort)seq, pk[seq]); seq++; }
            if (jb.Pull(out10, Frame) == 0 && p > 10) silentPulls++;
            maxBuffered = Math.Max(maxBuffered, jb.BufferedMs);
        }
        Assert.True(maxBuffered <= jb.TargetMs + 60 + 20, $"delay crept to {maxBuffered} ms");
        Assert.Equal(0, silentPulls);
        Assert.InRange(jb.Trimmed, 80, 110);   // about one frame per extra frame sent
    }

    [Fact]
    public void UnderrunRaisesTheTargetAndAStableStreamLowersItAgain()
    {
        var jb = new OpusJitterBuffer();
        var pk = Packets(3000);
        var out10 = new short[Frame * 2];
        var seq = 0;
        for (var i = 0; i < 6; i++) jb.Push((ushort)seq, pk[seq++]);
        for (var p = 0; p < 6; p++) jb.Pull(out10, Frame);
        for (var p = 0; p < 10; p++) jb.Pull(out10, Frame);          // sender stalls 100 ms
        jb.Push((ushort)seq, pk[seq++]);                               // ...then resumes
        Assert.True(jb.Underruns >= 1);
        var raised = jb.TargetMs;
        Assert.True(raised > OpusJitterBuffer.StartTargetMs);

        for (var p = 0; p < 2000; p++)                                 // 20 s steady
        {
            jb.Push((ushort)seq, pk[seq]); seq++;
            jb.Pull(out10, Frame);
        }
        Assert.True(jb.TargetMs < raised, $"target should relax, still {jb.TargetMs} ms");
    }

    [Fact]
    public void SenderPauseLikeMuteDoesNotRaiseTheTarget()
    {
        // Muting pauses the voice producer: no RTP for seconds. That is not jitter,
        // and treating it as such grew the delay by 20 ms on every mute.
        var jb = new OpusJitterBuffer();
        var pk = Packets(200);
        var out10 = new short[Frame * 2];
        var seq = 0;
        for (var round = 0; round < 5; round++)
        {
            for (var i = 0; i < 20; i++) { jb.Push((ushort)seq, pk[seq++]); jb.Pull(out10, Frame); }
            for (var i = 0; i < 100; i++) jb.Pull(out10, Frame);       // muted 1 s
        }
        jb.Push((ushort)seq, pk[seq]);
        Assert.Equal(0, jb.Underruns);
        Assert.Equal(OpusJitterBuffer.StartTargetMs, jb.TargetMs);
    }

    [Fact]
    public void SequenceWrapAroundKeepsPlaying()
    {
        var jb = new OpusJitterBuffer();
        var pk = Packets(40);
        var levels = Feed(jb, InOrder(pk, 65520));
        Assert.Equal(0, jb.Underruns);
        Assert.All(Middle(levels), l => Assert.True(l > 3000, $"rms {l:F0}"));
    }

    [Fact]
    public void PacketArrivingAfterItsSlotIsDroppedAsLate()
    {
        var jb = new OpusJitterBuffer();
        var pk = Packets(40);
        var arrivals = InOrder(pk).GetRange(0, 20);
        arrivals[10] = null;
        Feed(jb, arrivals);                        // slot 10 is concealed meanwhile
        jb.Push(10, pk[10]);
        Assert.Equal(1, jb.LatePackets);
    }

    [Fact]
    public void MutedSourceKeepsDrainingSoUnmutingIsLiveNotDelayed()
    {
        // The old mixer skipped muted (and deafened) sources entirely, so their
        // queue filled to 400 ms while muted: unmuting played stale audio, late.
        var mixer = new PeerMixer();
        const uint ssrc = 7;
        var pk = Packets(300);
        var buf = new byte[Frame * 4];
        mixer.SetLocalMuted(ssrc, true);
        for (var i = 0; i < 300; i++)
        {
            mixer.OnOpusPacket(ssrc, (ushort)i, pk[i]);
            mixer.Read(buf, 0, buf.Length);
        }
        mixer.SetLocalMuted(ssrc, false);

        // The sender has stopped. Whatever still plays after unmuting is stale
        // backlog: measure how much of it there is.
        var s16 = new short[Frame * 2];
        var staleMs = 0;
        for (var i = 0; i < 60; i++)
        {
            mixer.Read(buf, 0, buf.Length);
            Buffer.BlockCopy(buf, 0, s16, 0, buf.Length);
            if (Rms(s16, s16.Length) > 1000) staleMs += 10;
        }
        Assert.True(staleMs <= OpusJitterBuffer.StartTargetMs + 60 + 30,
            $"{staleMs} ms of stale audio was queued behind the mute");
    }
}
