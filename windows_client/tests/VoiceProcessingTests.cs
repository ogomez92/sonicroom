using System;
using System.Collections.Generic;
using System.IO;
using SonicRoom.Windows.Audio;
using Xunit;

namespace SonicRoom.Windows.Tests;

public sealed class VoiceProcessingTests
{
    [Fact]
    public void SettingsDefaultVoiceProcessingOff()
        => Assert.False(new AppSettings().VoiceProcessingEnabled);

    [Fact]
    public void SettingsRoundTripVoiceProcessing()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SonicRoomTests", Guid.NewGuid().ToString("N"));
        var path = Path.Combine(directory, "settings.json");
        try
        {
            new AppSettings { VoiceProcessingEnabled = true, HifiVoice = false }.SaveTo(path);
            var loaded = AppSettings.LoadFrom(path);
            Assert.True(loaded.VoiceProcessingEnabled);
            Assert.False(loaded.HifiVoice);
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void EnablingVoiceProcessingDisablesHifi()
    {
        var result = VoiceProcessingSelection.SetVoiceProcessing(currentHifi: true, enabled: true);
        Assert.True(result.VoiceProcessing);
        Assert.False(result.HifiVoice);
        Assert.True(result.OtherModeDisabled);
    }

    [Fact]
    public void EnablingHifiDisablesVoiceProcessing()
    {
        var result = VoiceProcessingSelection.SetHifiVoice(currentVoiceProcessing: true, enabled: true);
        Assert.False(result.VoiceProcessing);
        Assert.True(result.HifiVoice);
        Assert.True(result.OtherModeDisabled);
    }

    [Fact]
    public void ConverterEmitsExactDuplicatedStereoFrames()
    {
        var converter = new ProcessedFrameConverter();
        var frames = new List<short[]>();
        var input = new byte[ProcessedFrameConverter.InputSamplesPerFrame * 2];
        for (var i = 0; i < ProcessedFrameConverter.InputSamplesPerFrame; i++)
        {
            var sample = (short)(1000 + i);
            input[2 * i] = (byte)sample;
            input[2 * i + 1] = (byte)(sample >> 8);
        }

        for (var i = 0; i < 6; i++) frames.AddRange(converter.AddPcm16(input, input.Length));

        Assert.True(frames.Count >= 4);
        foreach (var frame in frames)
        {
            Assert.Equal(ProcessedFrameConverter.OutputShorts, frame.Length);
            for (var sample = 0; sample < ProcessedFrameConverter.OutputSamplesPerChannel; sample++)
                Assert.Equal(frame[2 * sample], frame[2 * sample + 1]);
        }
    }
}
