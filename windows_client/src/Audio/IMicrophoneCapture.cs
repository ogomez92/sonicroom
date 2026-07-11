using System;

namespace SonicRoom.Windows.Audio;

/// <summary>The fixed-frame contract shared by raw and Windows-processed microphone capture.</summary>
internal interface IMicrophoneCapture : IDisposable
{
    event Action<short[]>? FrameReady;
    void Start();
    void Stop();
}
