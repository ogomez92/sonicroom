using System;
using System.Runtime.InteropServices;

namespace SonicRoom.Windows.Input;

/// <summary>
/// System-wide keyboard shortcuts via a low-level keyboard hook (<c>WH_KEYBOARD_LL</c>) — they work
/// even when the app isn't focused, and the hook sees key up/down so it can drive push-to-talk.
/// Install on the UI thread (which has a message pump); callbacks then arrive on the UI thread.
///
/// Defaults: Ctrl+Shift+M = toggle mute, Ctrl+Shift+D = toggle deafen. Push-to-talk is opt-in via
/// <see cref="PushToTalkVk"/> (a virtual-key code; 0 = disabled). Fully rebindable later (Phase 8).
/// </summary>
public sealed class GlobalHotkeys : IDisposable
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
    private const int VK_CONTROL = 0x11, VK_SHIFT = 0x10, VK_MENU = 0x12, VK_M = 0x4D, VK_D = 0x44;

    private readonly LowLevelKeyboardProc _proc;
    private IntPtr _hook;
    private bool _pttDown;

    public event Action? ToggleMute;
    public event Action? ToggleDeafen;
    public event Action<bool>? PushToTalk; // true = key down (talk), false = released

    /// <summary>
    /// Alt+digit (0–9, top row or numpad) pressed while <see cref="AltDigitHwnd"/> is the
    /// foreground window. The keystroke is SWALLOWED here so it never becomes a
    /// WM_SYSKEYDOWN/WM_SYSCHAR — XAML KeyboardAccelerators can't suppress the WM_SYSCHAR,
    /// and DefWindowProc beeps on it (no menu mnemonic). AltGr+digit (Ctrl+Alt) is left
    /// alone so European layouts can still type their symbols.
    /// </summary>
    public event Action<int>? AltDigit;

    /// <summary>Our top-level window handle: Alt+digit is only intercepted while it's foreground.</summary>
    public IntPtr AltDigitHwnd { get; set; }

    /// <summary>Virtual-key code for push-to-talk; 0 disables it.</summary>
    public int PushToTalkVk { get; set; }

    public GlobalHotkeys() => _proc = HookProc;

    public void Install()
    {
        if (_hook == IntPtr.Zero)
            _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
    }

    private IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var msg = (int)wParam;
            var vk = Marshal.ReadInt32(lParam); // KBDLLHOOKSTRUCT.vkCode is the first field
            var down = msg is WM_KEYDOWN or WM_SYSKEYDOWN;
            var up = msg is WM_KEYUP or WM_SYSKEYUP;

            if (PushToTalkVk != 0 && vk == PushToTalkVk)
            {
                if (down && !_pttDown) { _pttDown = true; PushToTalk?.Invoke(true); }
                else if (up && _pttDown) { _pttDown = false; PushToTalk?.Invoke(false); }
            }
            else if (down)
            {
                var ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
                var shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
                var alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
                if (ctrl && shift && vk == VK_M) ToggleMute?.Invoke();
                else if (ctrl && shift && vk == VK_D) ToggleDeafen?.Invoke();
                else if (alt && !ctrl && AltDigit is { } handler
                         && AltDigitHwnd != IntPtr.Zero && GetForegroundWindow() == AltDigitHwnd)
                {
                    var digit = vk switch
                    {
                        >= 0x30 and <= 0x39 => vk - 0x30, // top row 0-9
                        >= 0x60 and <= 0x69 => vk - 0x60, // numpad 0-9
                        _ => -1,
                    };
                    if (digit >= 0)
                    {
                        handler(digit);
                        return (IntPtr)1; // eat it: no WM_SYSCHAR, no default-beep
                    }
                }
            }
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    public void Dispose()
    {
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);
}
