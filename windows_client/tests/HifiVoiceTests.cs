using System;
using Concentus.Enums;
using Concentus.Structs;
using SonicRoom.Windows.Audio;
using Xunit;

namespace SonicRoom.Windows.Tests;

/// <summary>
/// Hi-fi voice round trips: the exact encode RoomSession performs for hi-fi
/// (stereo Opus, 48 kHz, 128 kbps, 960 samples/channel per frame) must survive
/// to the listener with genuine channel separation — both through a bare
/// decoder (what a web listener does) and through PeerMixer (what the Windows
/// client plays). Guards against "hi-fi" silently collapsing to mono or one ear.
/// </summary>
public sealed class HifiVoiceTests
{
    private const int FrameSamples = 960; // 20 ms per channel @ 48 kHz

    /// <summary>Interleaved stereo frame: 440 Hz tone on the left, silence on the right.</summary>
    private static short[] LeftOnlyFrame(int frameIndex)
    {
        var frame = new short[FrameSamples * 2];
        for (var i = 0; i < FrameSamples; i++)
        {
            var t = (frameIndex * FrameSamples + i) / 48000.0;
            frame[2 * i] = (short)(Math.Sin(2 * Math.PI * 440 * t) * 12000);
            frame[2 * i + 1] = 0;
        }
        return frame;
    }

    private static (double Left, double Right) ChannelRms(short[] interleaved, int count)
    {
        double l = 0, r = 0;
        var frames = count / 2;
        for (var i = 0; i + 1 < count; i += 2)
        {
            l += (double)interleaved[i] * interleaved[i];
            r += (double)interleaved[i + 1] * interleaved[i + 1];
        }
        return (Math.Sqrt(l / frames), Math.Sqrt(r / frames));
    }

    // RoomSession's hi-fi encoder settings, verbatim.
    private static OpusEncoder HifiEncoder() =>
        new(48000, 2, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = 128000 };

    [Fact]
    public void StereoEncodeRoundTripKeepsChannelSeparation()
    {
        var encoder = HifiEncoder();
        var decoder = new OpusDecoder(48000, 2);
        var packet = new byte[4000];
        var decoded = new short[FrameSamples * 2];
        (double Left, double Right) rms = default;

        // Encode a run of frames (the first carries codec priming transients)
        // and judge the last one, like a listener mid-stream would hear.
        for (var f = 0; f < 10; f++)
        {
            var len = encoder.Encode(LeftOnlyFrame(f), 0, FrameSamples, packet, 0, packet.Length);
            Assert.True(len > 0);
            var n = decoder.Decode(packet, 0, len, decoded, 0, FrameSamples, false);
            Assert.Equal(FrameSamples, n);
            rms = ChannelRms(decoded, n * 2);
        }

        Assert.True(rms.Left > 4000, $"left channel should carry the tone (rms={rms.Left:F0})");
        Assert.True(rms.Right < rms.Left / 10,
            $"right channel should stay near-silent (L={rms.Left:F0}, R={rms.Right:F0})");
    }

    [Fact]
    public void PeerMixerPlaysHifiPacketsInStereo()
    {
        var encoder = HifiEncoder();
        var mixer = new PeerMixer();
        const uint ssrc = 424242;
        var packet = new byte[4000];

        for (var f = 0; f < 10; f++)
        {
            var len = encoder.Encode(LeftOnlyFrame(f), 0, FrameSamples, packet, 0, packet.Length);
            mixer.OnOpusPacket(ssrc, packet[..len]);
        }

        // Drain a few frames into the middle of the stream, then measure one.
        var buffer = new byte[FrameSamples * 4];
        for (var skip = 0; skip < 5; skip++) mixer.Read(buffer, 0, buffer.Length);
        mixer.Read(buffer, 0, buffer.Length);
        var interleaved = new short[FrameSamples * 2];
        Buffer.BlockCopy(buffer, 0, interleaved, 0, buffer.Length);
        var (left, right) = ChannelRms(interleaved, interleaved.Length);

        Assert.True(left > 4000, $"mixer should play the left-channel tone (rms={left:F0})");
        Assert.True(right < left / 10,
            $"mixer must not bleed the tone into the right channel (L={left:F0}, R={right:F0})");
    }

    [Fact]
    public void MonoVoicePacketsStillPlayOnBothEars()
    {
        // The default (non-hi-fi) voice path: mono encode, and the mixer's stereo
        // decoder up-mixes it to both ears — regression guard for the daily path.
        var encoder = new OpusEncoder(48000, 1, OpusApplication.OPUS_APPLICATION_AUDIO) { Bitrate = 64000 };
        var mixer = new PeerMixer();
        const uint ssrc = 51515;
        var packet = new byte[4000];
        var mono = new short[FrameSamples];

        for (var f = 0; f < 10; f++)
        {
            for (var i = 0; i < FrameSamples; i++)
                mono[i] = (short)(Math.Sin(2 * Math.PI * 440 * ((f * FrameSamples + i) / 48000.0)) * 12000);
            var len = encoder.Encode(mono, 0, FrameSamples, packet, 0, packet.Length);
            mixer.OnOpusPacket(ssrc, packet[..len]);
        }

        var buffer = new byte[FrameSamples * 4];
        for (var skip = 0; skip < 5; skip++) mixer.Read(buffer, 0, buffer.Length);
        mixer.Read(buffer, 0, buffer.Length);
        var interleaved = new short[FrameSamples * 2];
        Buffer.BlockCopy(buffer, 0, interleaved, 0, buffer.Length);
        var (left, right) = ChannelRms(interleaved, interleaved.Length);

        Assert.True(left > 4000 && right > 4000,
            $"mono voice must reach both ears (L={left:F0}, R={right:F0})");
    }
}
