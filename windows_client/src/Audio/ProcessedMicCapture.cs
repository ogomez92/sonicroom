using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace SonicRoom.Windows.Audio;

/// <summary>
/// Captures through Windows' built-in Voice Capture DSP (AEC, NS, and AGC) in source mode.
/// Every COM operation and release happens on the dedicated capture thread.
/// </summary>
internal sealed class ProcessedMicCapture : IMicrophoneCapture
{
    private static readonly Guid VoiceCaptureClsid = new("745057c7-f353-4f2d-a7ee-58434477730e");
    private static readonly Guid VoicePropertySet = new("6f52c567-0360-4bd2-9617-ccbf1421c939");
    private const uint PidFirstUsable = 2;
    private const int RpcChangedMode = unchecked((int)0x80010106);

    private readonly int _captureEndpointIndex;
    private readonly int _renderEndpointIndex;
    private readonly object _gate = new();
    private CancellationTokenSource? _cts;
    private Thread? _thread;
    private TaskCompletionSource _started = NewCompletion();

    public event Action<short[]>? FrameReady;
    public event Action<Exception>? CaptureFailed;

    public ProcessedMicCapture(int captureEndpointIndex, int renderEndpointIndex)
    {
        _captureEndpointIndex = captureEndpointIndex;
        _renderEndpointIndex = renderEndpointIndex;
    }

    public void Start()
    {
        lock (_gate)
        {
            if (_thread is not null) return;
            _cts = new CancellationTokenSource();
            _started = NewCompletion();
            _thread = new Thread(CaptureThread)
            {
                IsBackground = true,
                Name = "SonicRoom voice processing capture",
            };
            _thread.Start(_cts.Token);
        }

        // Initialization is synchronous to the caller so RoomSession can immediately fall back.
        try
        {
            _started.Task.WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
        }
        catch
        {
            Stop();
            throw;
        }
    }

    private void CaptureThread(object? state)
    {
        var token = (CancellationToken)state!;
        object? comObject = null;
        IMediaObjectNative? mediaObject = null;
        var initialized = false;
        try
        {
            var hr = CoInitializeEx(IntPtr.Zero, 0); // COINIT_MULTITHREADED
            if (hr < 0 && hr != RpcChangedMode) Marshal.ThrowExceptionForHR(hr);
            initialized = hr >= 0;

            var type = Type.GetTypeFromCLSID(VoiceCaptureClsid, throwOnError: true)!;
            comObject = Activator.CreateInstance(type)
                ?? throw new COMException("Could not create the Windows Voice Capture DSP.");

            var store = (IPropertyStoreNative)comObject;
            SetInt(store, PidFirstUsable + 0, 0); // SINGLE_CHANNEL_AEC; NS/AGC are enabled too.
            SetBool(store, PidFirstUsable + 1, true); // source mode
            SetInt(store, PidFirstUsable + 2,
                (_renderEndpointIndex << 16) | (_captureEndpointIndex & 0xffff));
            SetBool(store, PidFirstUsable + 3, true); // feature mode permits overrides below
            SetInt(store, PidFirstUsable + 6, 1); // noise suppression uses VT_I4, unlike AGC
            SetBool(store, PidFirstUsable + 7, true); // automatic gain control
            // This DSP applies SetValue immediately and its IPropertyStore::Commit returns
            // E_NOTIMPL on current Windows builds.

            mediaObject = (IMediaObjectNative)comObject;
            var mediaType = DmoMediaTypeNative.CreatePcm16Mono(16000);
            try { Marshal.ThrowExceptionForHR(mediaObject.SetOutputType(0, ref mediaType, 0)); }
            finally { mediaType.Free(); }
            Marshal.ThrowExceptionForHR(mediaObject.AllocateStreamingResources());

            using var output = new MediaBuffer(32000); // one second reduces glitch risk
            var buffers = new[] { new DmoOutputDataBufferNative { Buffer = output } };
            var bytes = new byte[32000];
            var converter = new ProcessedFrameConverter();
            _started.TrySetResult();

            while (!token.IsCancellationRequested)
            {
                output.SetLength(0);
                var processHr = mediaObject.ProcessOutput(0, 1, buffers, out _);
                if (processHr < 0) Marshal.ThrowExceptionForHR(processHr);
                var length = output.Length;
                if (length > 0)
                {
                    output.RetrieveData(bytes, length);
                    foreach (var frame in converter.AddPcm16(bytes, length))
                        FrameReady?.Invoke(frame);
                }
                if (length == 0) Thread.Sleep(2);
            }
        }
        catch (Exception ex)
        {
            if (!_started.TrySetException(ex) && !token.IsCancellationRequested)
                CaptureFailed?.Invoke(ex);
        }
        finally
        {
            try { if (mediaObject is not null) mediaObject.FreeStreamingResources(); } catch { }
            if (comObject is not null && Marshal.IsComObject(comObject))
                try { Marshal.FinalReleaseComObject(comObject); } catch { }
            if (initialized) CoUninitialize();
        }
    }

    public void Stop()
    {
        Thread? thread;
        lock (_gate)
        {
            _cts?.Cancel();
            thread = _thread;
            _thread = null;
        }
        if (thread is not null && thread != Thread.CurrentThread) thread.Join(TimeSpan.FromSeconds(3));
        _cts?.Dispose();
        _cts = null;
    }

    public void Dispose() => Stop();

    private static TaskCompletionSource NewCompletion() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static void SetInt(IPropertyStoreNative store, uint pid, int value)
    {
        var key = new PropertyKey(VoicePropertySet, pid);
        var variant = PropVariant.FromInt(value);
        Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref variant));
    }

    private static void SetBool(IPropertyStoreNative store, uint pid, bool value)
    {
        var key = new PropertyKey(VoicePropertySet, pid);
        var variant = PropVariant.FromBool(value);
        Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref variant));
    }

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, uint coInit);

    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey(Guid formatId, uint propertyId)
    {
        public Guid FormatId = formatId;
        public uint PropertyId = propertyId;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort VariantType;
        [FieldOffset(8)] public int IntValue;
        [FieldOffset(8)] public short BoolValue;

        public static PropVariant FromInt(int value) => new() { VariantType = 3, IntValue = value };
        public static PropVariant FromBool(bool value) => new() { VariantType = 11, BoolValue = value ? (short)-1 : (short)0 };
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStoreNative
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("D8AD0F58-5494-4102-97C5-EC798E59BCF4"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMediaObjectNative
    {
        [PreserveSig] int GetStreamCount(out int inputs, out int outputs);
        [PreserveSig] int GetInputStreamInfo(int index, out int flags);
        [PreserveSig] int GetOutputStreamInfo(int index, out int flags);
        [PreserveSig] int GetInputType(int stream, int typeIndex, out DmoMediaTypeNative mediaType);
        [PreserveSig] int GetOutputType(int stream, int typeIndex, out DmoMediaTypeNative mediaType);
        [PreserveSig] int SetInputType(int stream, ref DmoMediaTypeNative mediaType, int flags);
        [PreserveSig] int SetOutputType(int stream, ref DmoMediaTypeNative mediaType, int flags);
        [PreserveSig] int GetInputCurrentType(int stream, out DmoMediaTypeNative mediaType);
        [PreserveSig] int GetOutputCurrentType(int stream, out DmoMediaTypeNative mediaType);
        [PreserveSig] int GetInputSizeInfo(int stream, out int size, out int maxLookahead, out int alignment);
        [PreserveSig] int GetOutputSizeInfo(int stream, out int size, out int alignment);
        [PreserveSig] int GetInputMaxLatency(int stream, out long latency);
        [PreserveSig] int SetInputMaxLatency(int stream, long latency);
        [PreserveSig] int Flush();
        [PreserveSig] int Discontinuity(int stream);
        [PreserveSig] int AllocateStreamingResources();
        [PreserveSig] int FreeStreamingResources();
        [PreserveSig] int GetInputStatus(int stream, out int flags);
        [PreserveSig] int ProcessInput(int stream, [MarshalAs(UnmanagedType.Interface)] object buffer,
            int flags, long timestamp, long duration);
        [PreserveSig] int ProcessOutput(int flags, int outputCount,
            [In, Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] DmoOutputDataBufferNative[] outputs,
            out int status);
        [PreserveSig] int Lock([MarshalAs(UnmanagedType.Bool)] bool acquire);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DmoMediaTypeNative
    {
        public Guid MajorType;
        public Guid SubType;
        [MarshalAs(UnmanagedType.Bool)] public bool FixedSizeSamples;
        [MarshalAs(UnmanagedType.Bool)] public bool TemporalCompression;
        public uint SampleSize;
        public Guid FormatType;
        public IntPtr Unknown;
        public uint FormatSize;
        public IntPtr Format;

        public static DmoMediaTypeNative CreatePcm16Mono(int sampleRate)
        {
            var wave = new WaveFormatExNative
            {
                FormatTag = 1,
                Channels = 1,
                SamplesPerSecond = (uint)sampleRate,
                AverageBytesPerSecond = (uint)(sampleRate * 2),
                BlockAlign = 2,
                BitsPerSample = 16,
                ExtraSize = 0,
            };
            var size = Marshal.SizeOf<WaveFormatExNative>();
            var format = Marshal.AllocCoTaskMem(size);
            Marshal.StructureToPtr(wave, format, false);
            return new DmoMediaTypeNative
            {
                MajorType = new Guid("73647561-0000-0010-8000-00AA00389B71"),
                SubType = new Guid("00000001-0000-0010-8000-00AA00389B71"),
                FixedSizeSamples = true,
                SampleSize = 2,
                FormatType = new Guid("05589F81-C356-11CE-BF01-00AA0055595A"),
                FormatSize = (uint)size,
                Format = format,
            };
        }

        public void Free()
        {
            if (Format != IntPtr.Zero) Marshal.FreeCoTaskMem(Format);
            Format = IntPtr.Zero;
        }
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormatExNative
    {
        public ushort FormatTag;
        public ushort Channels;
        public uint SamplesPerSecond;
        public uint AverageBytesPerSecond;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort ExtraSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DmoOutputDataBufferNative
    {
        [MarshalAs(UnmanagedType.Interface)] public IMediaBufferNative? Buffer;
        public int Status;
        public long Timestamp;
        public long Duration;
    }

    [ComVisible(true), Guid("59EFF8B9-938C-4A26-82F2-95C9C5511ADD"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMediaBufferNative
    {
        [PreserveSig] int SetLength(int length);
        [PreserveSig] int GetMaxLength(out int maxLength);
        [PreserveSig] int GetBufferAndLength(IntPtr bufferPointer, IntPtr validDataLengthPointer);
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    private sealed class MediaBuffer : IMediaBufferNative, IDisposable
    {
        private readonly int _capacity;
        private IntPtr _data;
        public int Length { get; private set; }

        public MediaBuffer(int capacity)
        {
            _capacity = capacity;
            _data = Marshal.AllocHGlobal(capacity);
        }

        public int SetLength(int length)
        {
            if ((uint)length > (uint)_capacity) return unchecked((int)0x80070057);
            Length = length;
            return 0;
        }

        public int GetMaxLength(out int maxLength) { maxLength = _capacity; return 0; }

        public int GetBufferAndLength(IntPtr bufferPointer, IntPtr validDataLengthPointer)
        {
            if (bufferPointer != IntPtr.Zero) Marshal.WriteIntPtr(bufferPointer, _data);
            if (validDataLengthPointer != IntPtr.Zero) Marshal.WriteInt32(validDataLengthPointer, Length);
            return 0;
        }

        public void RetrieveData(byte[] destination, int count) => Marshal.Copy(_data, destination, 0, count);

        public void Dispose()
        {
            if (_data == IntPtr.Zero) return;
            Marshal.FreeHGlobal(_data);
            _data = IntPtr.Zero;
        }
    }
}
