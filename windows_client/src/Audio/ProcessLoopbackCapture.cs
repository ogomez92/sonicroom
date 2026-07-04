using System;
using System.Runtime.InteropServices;
using System.Threading;
using NAudio.Wave;

namespace SonicRoom.Windows.Audio;

/// <summary>
/// Captures audio rendered by a specific process tree (include mode) — or everything EXCEPT it
/// (exclude mode) — via the Windows Process Loopback API. Delivers 48 kHz/16-bit/stereo PCM.
///
/// EVERYTHING (activation, Initialize, the capture loop) runs on ONE dedicated MTA thread so the
/// WASAPI COM objects never cross apartments. This matters because the caller is usually the STA
/// WinUI UI thread; activating on one thread and using the IAudioClient on another (STA) marshals
/// across apartments and fails. Requires Windows 10 build 20348+ (Win11 = fine).
/// </summary>
public sealed class ProcessLoopbackCapture : IDisposable
{
    private readonly uint _targetPid;
    private readonly bool _includeMode;

    private Thread? _thread;
    private ManualResetEventSlim? _stop;
    private readonly ManualResetEventSlim _ready = new(false);
    private Exception? _startError;
    private int _blockAlign;

    public WaveFormat WaveFormat { get; } = new WaveFormat(48000, 16, 2);

    /// <summary>Raised on the capture thread with a filled PCM buffer + valid byte count.</summary>
    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public event EventHandler<Exception>? CaptureFaulted;

    public static bool IsSupported => Environment.OSVersion.Version.Build >= 20348;

    public ProcessLoopbackCapture(uint targetPid, bool includeMode)
    {
        _targetPid = targetPid;
        _includeMode = includeMode;
    }

    public void Start()
    {
        if (_thread != null) throw new InvalidOperationException("Already started.");
        _stop = new ManualResetEventSlim(false);
        _thread = new Thread(CaptureThreadMain) { IsBackground = true, Name = "ProcessLoopbackCapture" };
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();

        if (!_ready.Wait(TimeSpan.FromSeconds(6)))
            throw new TimeoutException("Process loopback capture did not initialize.");
        if (_startError != null) throw _startError;
    }

    private void CaptureThreadMain()
    {
        IAudioClient? audioClient = null;
        IAudioCaptureClient? captureClient = null;
        AutoResetEvent? bufferReady = null;
        try
        {
            audioClient = ProcessLoopbackActivation.ActivateAsync(_targetPid, _includeMode).GetAwaiter().GetResult();

            var fmt = new WAVEFORMATEX
            {
                wFormatTag = LoopbackConstants.WAVE_FORMAT_PCM,
                nChannels = (ushort)WaveFormat.Channels,
                nSamplesPerSec = (uint)WaveFormat.SampleRate,
                wBitsPerSample = (ushort)WaveFormat.BitsPerSample,
                nBlockAlign = (ushort)(WaveFormat.Channels * WaveFormat.BitsPerSample / 8),
                nAvgBytesPerSec = (uint)(WaveFormat.SampleRate * WaveFormat.Channels * WaveFormat.BitsPerSample / 8),
                cbSize = 0,
            };
            _blockAlign = fmt.nBlockAlign;

            var flags = (uint)(AudioClientStreamFlags.Loopback
                             | AudioClientStreamFlags.EventCallback
                             | AudioClientStreamFlags.AutoConvertPcm
                             | AudioClientStreamFlags.SrcDefaultQuality);

            Marshal.ThrowExceptionForHR(audioClient.Initialize(
                LoopbackConstants.AUDCLNT_SHAREMODE_SHARED, flags,
                hnsBufferDuration: 2_000_000, hnsPeriodicity: 0, ref fmt, IntPtr.Zero));

            bufferReady = new AutoResetEvent(false);
            Marshal.ThrowExceptionForHR(audioClient.SetEventHandle(bufferReady.SafeWaitHandle.DangerousGetHandle()));

            var iid = LoopbackConstants.IID_IAudioCaptureClient;
            Marshal.ThrowExceptionForHR(audioClient.GetService(ref iid, out var svc));
            captureClient = (IAudioCaptureClient)svc;

            Marshal.ThrowExceptionForHR(audioClient.Start());
        }
        catch (Exception ex)
        {
            _startError = ex;
            _ready.Set();
            Release(ref captureClient, ref audioClient);
            return;
        }

        _ready.Set(); // init succeeded

        WaitHandle[] handles = { bufferReady!, _stop!.WaitHandle };
        try
        {
            while (true)
            {
                var idx = WaitHandle.WaitAny(handles, 200);
                if (idx == 1) break; // stop requested
                DrainPackets(captureClient!);
            }
        }
        catch (Exception ex) { CaptureFaulted?.Invoke(this, ex); }
        finally
        {
            try { audioClient?.Stop(); } catch { /* ignore */ }
            bufferReady?.Dispose();
            Release(ref captureClient, ref audioClient);
        }
    }

    private void DrainPackets(IAudioCaptureClient cc)
    {
        while (cc.GetNextPacketSize(out var framesAvail) == 0 && framesAvail > 0)
        {
            var hr = cc.GetBuffer(out var data, out var frames, out var bufFlags, out _, out _);
            if (hr == LoopbackConstants.AUDCLNT_S_BUFFER_EMPTY) break;
            Marshal.ThrowExceptionForHR(hr);

            var bytes = (int)frames * _blockAlign;
            var managed = new byte[bytes];
            if ((bufFlags & AudioClientBufferFlags.Silent) == 0 && data != IntPtr.Zero)
                Marshal.Copy(data, managed, 0, bytes);

            cc.ReleaseBuffer(frames);
            DataAvailable?.Invoke(this, new WaveInEventArgs(managed, bytes));
        }
    }

    private static void Release(ref IAudioCaptureClient? cc, ref IAudioClient? ac)
    {
        if (cc != null) { Marshal.FinalReleaseComObject(cc); cc = null; }
        if (ac != null) { Marshal.FinalReleaseComObject(ac); ac = null; }
    }

    public void Stop()
    {
        _stop?.Set();
        _thread?.Join(1500);
        _thread = null;
    }

    public void Dispose()
    {
        Stop();
        _stop?.Dispose();
        _ready.Dispose();
    }
}
