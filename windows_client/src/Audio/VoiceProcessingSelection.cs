namespace SonicRoom.Windows.Audio;

/// <summary>Pure setting transition used by both lobby and in-call controls.</summary>
internal static class VoiceProcessingSelection
{
    public static (bool VoiceProcessing, bool HifiVoice, bool OtherModeDisabled) SetVoiceProcessing(
        bool currentHifi, bool enabled) => (enabled, enabled ? false : currentHifi, enabled && currentHifi);

    public static (bool VoiceProcessing, bool HifiVoice, bool OtherModeDisabled) SetHifiVoice(
        bool currentVoiceProcessing, bool enabled) => (enabled ? false : currentVoiceProcessing, enabled,
            enabled && currentVoiceProcessing);
}
