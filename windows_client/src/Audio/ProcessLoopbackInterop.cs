using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace SonicRoom.Windows.Audio;

// Minimal WASAPI Process Loopback interop (Win10 20348+/Win11). Lets us activate an IAudioClient
// bound to a specific process tree (include) or everything-except it (exclude), via
// ActivateAudioInterfaceAsync + VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK. Modeled on Microsoft's
// ApplicationLoopback C++ sample. All IIDs / struct layouts verified against the Win32 headers.

internal enum AudioClientActivationType { Default = 0, ProcessLoopback = 1 }

internal enum ProcessLoopbackMode { IncludeTargetProcessTree = 0, ExcludeTargetProcessTree = 1 }

[Flags]
internal enum AudioClientStreamFlags : uint
{
    Loopback = 0x00020000,
    EventCallback = 0x00040000,
    AutoConvertPcm = 0x80000000,
    SrcDefaultQuality = 0x08000000,
}

[Flags]
internal enum AudioClientBufferFlags
{
    None = 0,
    DataDiscontinuity = 0x1,
    Silent = 0x2,
    TimestampError = 0x4,
}

internal static class LoopbackConstants
{
    public const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback";
    public const int AUDCLNT_SHAREMODE_SHARED = 0;
    public const int AUDCLNT_S_BUFFER_EMPTY = unchecked((int)0x08890001);
    public const ushort VT_BLOB = 0x0041;
    public const ushort WAVE_FORMAT_PCM = 1;

    public static readonly Guid IID_IAudioClient = new("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    public static readonly Guid IID_IAudioCaptureClient = new("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
internal struct WAVEFORMATEX
{
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
}

[StructLayout(LayoutKind.Sequential)]
internal struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
{
    public uint TargetProcessId;
    public ProcessLoopbackMode ProcessLoopbackMode;
}

[StructLayout(LayoutKind.Sequential)]
internal struct AUDIOCLIENT_ACTIVATION_PARAMS
{
    public AudioClientActivationType ActivationType;
    public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
}

// Enough of PROPVARIANT for a VT_BLOB. Default sequential packing reproduces the real 24-byte
// x64 PROPVARIANT (4 bytes padding land before the 8-aligned blobData pointer).
[StructLayout(LayoutKind.Sequential)]
internal struct PROPVARIANT_BLOB
{
    public ushort vt;
    public ushort wReserved1;
    public ushort wReserved2;
    public ushort wReserved3;
    public uint blobSize;
    public IntPtr blobData;
}

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IActivateAudioInterfaceCompletionHandler
{
    // The operation arrives as a raw pointer: the CLR's typed-interface marshaling QIs for the
    // operation IID and fails (E_NOINTERFACE) in this callback context. We instead call the
    // operation's GetActivateResult (vtable slot 3, after IUnknown) directly, bypassing QI.
    [PreserveSig] int ActivateCompleted(IntPtr activateOperation);
}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioClient
{
    [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration,
        long hnsPeriodicity, [In] ref WAVEFORMATEX pFormat, IntPtr audioSessionGuid);
    [PreserveSig] int GetBufferSize(out uint bufferFrameCount);
    [PreserveSig] int GetStreamLatency(out long hnsLatency);
    [PreserveSig] int GetCurrentPadding(out uint numPaddingFrames);
    [PreserveSig] int IsFormatSupported(int shareMode, [In] ref WAVEFORMATEX pFormat, out IntPtr closestMatch);
    [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr eventHandle);
    [PreserveSig] int GetService([In] ref Guid interfaceId, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioCaptureClient
{
    [PreserveSig] int GetBuffer(out IntPtr dataBuffer, out uint numFramesToRead,
        out AudioClientBufferFlags bufferFlags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint numFramesRead);
    [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
}

internal static class MmDeviceApi
{
    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
    public static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IntPtr activationOperation);
}

internal sealed class ActivationCompletionHandler : IActivateAudioInterfaceCompletionHandler
{
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetActivateResultFn(IntPtr thisPtr, out int activateResult, out IntPtr activateInterface);

    private readonly TaskCompletionSource<IAudioClient> _tcs = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public Task<IAudioClient> Task => _tcs.Task;

    public int ActivateCompleted(IntPtr activateOperation)
    {
        try
        {
            // IActivateAudioInterfaceAsyncOperation::GetActivateResult is vtable slot 3 (0-2 = IUnknown).
            var vtbl = Marshal.ReadIntPtr(activateOperation);
            var fnPtr = Marshal.ReadIntPtr(vtbl, 3 * IntPtr.Size);
            var getResult = Marshal.GetDelegateForFunctionPointer<GetActivateResultFn>(fnPtr);

            var hr = getResult(activateOperation, out var activateResult, out var pUnknown);
            Marshal.ThrowExceptionForHR(hr);
            Marshal.ThrowExceptionForHR(activateResult); // AUDCLNT_E_* if activation itself failed

            var client = (IAudioClient)Marshal.GetObjectForIUnknown(pUnknown);
            Marshal.Release(pUnknown);
            _tcs.TrySetResult(client);
        }
        catch (Exception ex) { _tcs.TrySetException(ex); }
        return 0; // S_OK
    }
}

internal static class ProcessLoopbackActivation
{
    /// <summary>Activate an IAudioClient for a process tree (include) or all-except it (exclude).</summary>
    public static async Task<IAudioClient> ActivateAsync(uint targetPid, bool includeProcessTree)
    {
        var activationParams = new AUDIOCLIENT_ACTIVATION_PARAMS
        {
            ActivationType = AudioClientActivationType.ProcessLoopback,
            ProcessLoopbackParams = new AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
            {
                TargetProcessId = targetPid,
                ProcessLoopbackMode = includeProcessTree
                    ? ProcessLoopbackMode.IncludeTargetProcessTree
                    : ProcessLoopbackMode.ExcludeTargetProcessTree,
            },
        };

        var paramsSize = Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>();
        var pParams = Marshal.AllocHGlobal(paramsSize);
        var pPropVar = IntPtr.Zero;
        var pOp = IntPtr.Zero;
        try
        {
            Marshal.StructureToPtr(activationParams, pParams, false);
            var propVar = new PROPVARIANT_BLOB
            {
                vt = LoopbackConstants.VT_BLOB,
                blobSize = (uint)paramsSize,
                blobData = pParams,
            };
            pPropVar = Marshal.AllocHGlobal(Marshal.SizeOf<PROPVARIANT_BLOB>());
            Marshal.StructureToPtr(propVar, pPropVar, false);

            var handler = new ActivationCompletionHandler();
            var hr = MmDeviceApi.ActivateAudioInterfaceAsync(
                LoopbackConstants.VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                LoopbackConstants.IID_IAudioClient, pPropVar, handler, out pOp);
            Marshal.ThrowExceptionForHR(hr); // surface the REAL activation error (not a marshaling artifact)

            // The IAudioClient comes from the completion callback; the operation ptr is just a ref to release.
            return await handler.Task.ConfigureAwait(false);
        }
        finally
        {
            if (pOp != IntPtr.Zero) Marshal.Release(pOp);
            Marshal.DestroyStructure(pParams, typeof(AUDIOCLIENT_ACTIVATION_PARAMS));
            Marshal.FreeHGlobal(pParams);
            if (pPropVar != IntPtr.Zero) Marshal.FreeHGlobal(pPropVar);
        }
    }
}
