using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

namespace SonicRoom.Windows.Accessibility;

/// <summary>
/// Screen-reader speech via the Prism library (prism.dll, vendored under libs/prism/x64).
/// Prism talks to whatever is running — NVDA, JAWS, Narrator (UIA), SAPI — through its
/// "best backend" registry, so announcements are spoken directly by the user's screen
/// reader instead of relying on XAML automation events.
///
/// All prism calls happen on one dedicated background thread (init included): the library
/// owns COM objects/RPC handles that must not be used cross-apartment, and the WinUI caller
/// is an STA thread. <see cref="Speak"/> only enqueues and never throws or blocks.
///
/// If prism can't load or finds no backend (e.g. ARM64 build, or the DLL is missing), every
/// queued message is handed to <see cref="Fallback"/> instead, so exactly one channel speaks
/// each message — callers don't need to know which.
/// </summary>
public sealed class PrismSpeech : IDisposable
{
    private readonly BlockingCollection<(string Text, bool Interrupt)> _queue = new();
    private readonly Thread _thread;

    /// <summary>Invoked (on the speech thread) for each message when prism is unavailable.</summary>
    public Action<string>? Fallback { get; set; }

    /// <summary>Name of the backend prism picked ("nvda", "sapi", …), once initialized.</summary>
    public string? BackendName { get; private set; }

    public PrismSpeech()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "prism-speech" };
        _thread.Start();
    }

    /// <summary>Queue a message for speech. interrupt=true cuts off whatever is being spoken.</summary>
    public void Speak(string text, bool interrupt = false)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        try { _queue.Add((text, interrupt)); }
        catch (InvalidOperationException) { /* disposed mid-shutdown */ }
    }

    public void Dispose()
    {
        try { _queue.CompleteAdding(); } catch { }
        // Don't join: the thread exits when the queue drains, and speech must never block close.
    }

    private void Run()
    {
        IntPtr ctx = IntPtr.Zero, backend = IntPtr.Zero;
        try
        {
            var cfg = new PrismConfig { Version = PRISM_CONFIG_VERSION };
            ctx = prism_init(ref cfg);
            if (ctx != IntPtr.Zero)
            {
                backend = CreateBackend(ctx);
                if (backend != IntPtr.Zero)
                    BackendName = Marshal.PtrToStringUTF8(prism_backend_name(backend));
            }
            Diag.Log(backend != IntPtr.Zero
                ? $"[prism] speaking via backend '{BackendName}'"
                : "[prism] no backend available; using UIA notification fallback");
        }
        catch (Exception ex)
        {
            // DllNotFoundException / BadImageFormatException (ARM64) land here.
            Diag.Log($"[prism] unavailable ({ex.GetType().Name}: {ex.Message}); using fallback");
            backend = IntPtr.Zero;
        }

        foreach (var (text, interrupt) in _queue.GetConsumingEnumerable())
        {
            if (backend == IntPtr.Zero)
            {
                try { Fallback?.Invoke(text); } catch { }
                continue;
            }
            try
            {
                var err = prism_backend_speak(backend, text, interrupt);
                if (err != PrismError.Ok)
                {
                    // Screen reader may have restarted — rebuild the best backend once, then retry.
                    Diag.Log($"[prism] speak failed ({err}); re-acquiring backend");
                    prism_backend_free(backend);
                    backend = CreateBackend(ctx);
                    if (backend != IntPtr.Zero) _ = prism_backend_speak(backend, text, interrupt);
                    else { try { Fallback?.Invoke(text); } catch { } }
                }
            }
            catch (Exception ex)
            {
                Diag.Log($"[prism] speak threw: {ex.Message}");
            }
        }

        if (backend != IntPtr.Zero) { try { prism_backend_free(backend); } catch { } }
        if (ctx != IntPtr.Zero) { try { prism_shutdown(ctx); } catch { } }
    }

    private static IntPtr CreateBackend(IntPtr ctx)
    {
        if (ctx == IntPtr.Zero) return IntPtr.Zero;
        var backend = prism_registry_create_best(ctx);
        if (backend == IntPtr.Zero) return IntPtr.Zero;
        var err = prism_backend_initialize(backend);
        if (err is PrismError.Ok or PrismError.AlreadyInitialized) return backend;
        Diag.Log($"[prism] backend init failed: {err}");
        prism_backend_free(backend);
        return IntPtr.Zero;
    }

    // ---- native interop (see libs/prism headers: include/prism.h) ---------------------------

    private const byte PRISM_CONFIG_VERSION = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct PrismConfig { public byte Version; }

    private enum PrismError
    {
        Ok = 0,
        NotInitialized, InvalidParam, NotImplemented, NoVoices, VoiceNotFound,
        SpeakFailure, MemoryFailure, RangeOutOfBounds, Internal, NotSpeaking,
        NotPaused, AlreadyPaused, InvalidUtf8, InvalidOperation, AlreadyInitialized,
        BackendNotAvailable, Unknown, InvalidAudioFormat, InternalBackendLimitExceeded,
        BackendEnteredUndefinedState,
    }

    private const string Dll = "prism";

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr prism_init(ref PrismConfig cfg);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern void prism_shutdown(IntPtr ctx);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr prism_registry_create_best(IntPtr ctx);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern void prism_backend_free(IntPtr backend);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr prism_backend_name(IntPtr backend);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern PrismError prism_backend_initialize(IntPtr backend);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern PrismError prism_backend_speak(
        IntPtr backend,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string text,
        [MarshalAs(UnmanagedType.I1)] bool interrupt);
}
