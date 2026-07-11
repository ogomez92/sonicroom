using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO; // WindowsRuntimeStorageExtensions.OpenStreamForWriteAsync
using System.Linq;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using NAudio.Wave;
using SonicRoom.Windows.Accessibility;
using SonicRoom.Windows.Audio;
using SonicRoom.Windows.Input;
using SonicRoom.Windows.Session;
using SonicRoom.Windows.Signaling;
using SonicRoom.Windows.ViewModels;
using Windows.System;
using Cue = SonicRoom.Windows.Audio.Cue; // NAudio.Wave also has a Cue type

namespace SonicRoom.Windows;

public sealed partial class MainWindow : Window
{
    private const int ChatCap = 500;
    private const double PercentScale = 100.0;
    // Max gap between two Alt+<same number> presses for the second to count as a
    // "copy that message" double-press rather than a fresh readback (mirrors the web client).
    private const int DoublePressMs = 600;

    private readonly ObservableCollection<PeerItem> _peers = new();
    // The chat timeline: messages plus join/leave/system events, exactly what the
    // transcript box shows and what Alt+number reads back.
    private readonly List<ChatLine> _chatLines = new();
    private readonly GlobalHotkeys _hotkeys = new();
    private readonly PrismSpeech _speech = new();
    // WaveIn device index → (producerId, channel layout) of a live extra mic.
    private readonly Dictionary<int, (string ProducerId, bool Stereo)> _extraMicProducers = new();
    // Persisted per-device mono/stereo preference, keyed by device product name.
    private Dictionary<string, bool> _micStereoByDevice = new();
    private RoomSession? _session;
    private bool _inCall;
    private bool _chatHintGiven;
    private bool _uiReady;
    private bool _syncingVoiceMode;
    private bool _rememberedMicUnavailable;
    private bool _rememberedSpeakerUnavailable;
    private string _serverUrl = "";
    private string _roomName = "";
    // The last Alt+number readback (digit + when), so a quick second press of the
    // SAME number copies that message instead of just re-reading it.
    private int _lastAltDigit = -1;
    private DateTimeOffset _lastAltAt;

    // Speaking-indicator poll (250 ms, in-call only) + the knock-to-join cue loop (the web
    // loops the knock while requests are pending — a dialog you don't notice is a joiner
    // left waiting).
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _speakTimer;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _knockTimer;
    private int _pendingJoinRequests;

    private static readonly (string Code, string Name)[] Languages =
    {
        ("en", "English"), ("es", "Español"), ("fr", "Français"),
    };

    public MainWindow()
    {
        var settings = AppSettings.Load();
        I18n.Lang = settings.Language;

        InitializeComponent();
        Title = "SonicRoom";
        PeersList.ItemsSource = _peers;

        // Name each participant row for UIA ("Alice, muted, 2 votes to kick") — without this
        // the ListViewItem falls back to the data object's type name for screen readers.
        PeersList.ContainerContentChanging += (_, args) =>
        {
            if (!args.InRecycleQueue && args.ItemContainer is not null && args.Item is PeerItem p)
                AutomationProperties.SetName(args.ItemContainer, p.RowLabel);
        };

        // Prism speaks through the running screen reader; if it can't (missing DLL,
        // no backend), each queued message falls back to a UIA notification instead.
        _speech.Fallback = msg => Enqueue(() => RaiseUiaNotification(msg));

        foreach (var (_, name) in Languages) LanguageSelect.Items.Add(name);
        var langIdx = Array.FindIndex(Languages, l => l.Code == settings.Language);
        LanguageSelect.SelectedIndex = langIdx >= 0 ? langIdx : 0;

        ServerBox.Text = settings.ServerUrl;
        RoomBox.Text = settings.Room;
        NameBox.Text = settings.DisplayName;
        var voiceProcessing = settings.VoiceProcessingEnabled;
        HifiCheck.IsChecked = settings.HifiVoice && !voiceProcessing;
        VoiceProcessingLobbyCheck.IsChecked = voiceProcessing;
        VoiceProcessingCallCheck.IsChecked = voiceProcessing;
        MicGainSlider.Value = ToPercent(settings.MicGain);
        MediaVolumeSlider.Value = ToPercent(settings.MediaVolume);
        _micStereoByDevice = settings.MicStereoByDevice ?? new();

        // Land the keyboard where the next action is: the room name when a server is already
        // configured, the server field when it still needs to be set up.
        RootGrid.Loaded += (_, _) =>
        {
            var target = string.IsNullOrWhiteSpace(ServerBox.Text) ? ServerBox : RoomBox;
            target.Focus(FocusState.Programmatic);
            if (_rememberedMicUnavailable) Announce(I18n.T("remembered_mic_unavailable"));
            if (_rememberedSpeakerUnavailable) Announce(I18n.T("remembered_speaker_unavailable"));
        };
        PopulateMicList(settings.MicDevice);
        PopulateSpeakerList(settings.SpeakerDevice);
        ApplyStrings();
        _ = RefreshPublicRoomsAsync(announceResult: false);

        InstallChatReadbackAccelerators();
        InstallToolbarFocusMemory();

        _speakTimer = DispatcherQueue.CreateTimer();
        _speakTimer.Interval = TimeSpan.FromMilliseconds(250);
        _speakTimer.Tick += (_, _) => UpdateSpeakingIndicators();

        _knockTimer = DispatcherQueue.CreateTimer();
        _knockTimer.Interval = TimeSpan.FromSeconds(1.7);
        _knockTimer.Tick += (_, _) =>
        {
            if (_session is not null && _pendingJoinRequests > 0) _session.PlayCue(Cue.Knock);
            else _knockTimer!.Stop();
        };

        // System-wide shortcuts: Ctrl+Shift+M mute, Ctrl+Shift+D deafen (work unfocused).
        _hotkeys.ToggleMute += () => Enqueue(ToggleMuteFromHotkey);
        _hotkeys.ToggleDeafen += () => Enqueue(ToggleDeafenFromHotkey);
        // Alt+digit readback rides the same hook: it swallows the keystroke before Windows
        // turns it into a WM_SYSCHAR (whose unhandled default is the system beep). The XAML
        // accelerators above only ever fire if this hook failed to install.
        _hotkeys.AltDigitHwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        _hotkeys.AltDigit += d => Enqueue(() => ChatReadback(d));
        _hotkeys.PushToTalk += down => Enqueue(() =>
        {
            if (_session is null) return;
            MuteButton.IsChecked = !down; // held = talking = unmuted
            _session.SetMuted(!down);
        });
        _hotkeys.Install();
        _uiReady = true;

        Closed += async (_, _) =>
        {
            StopMicTest();
            SaveSettings();
            _hotkeys.Dispose();
            _speech.Dispose();
            if (_session is not null) await _session.DisposeAsync();
        };
    }

    // ---- settings + language ---------------------------------------------------------------

    private void SaveSettings()
    {
        new AppSettings
        {
            ServerUrl = ServerBox.Text.Trim(),
            Room = RoomBox.Text.Trim(),
            DisplayName = NameBox.Text.Trim(),
            MicDevice = MicSelect.SelectedIndex == 0 ? "System default" : (MicSelect.SelectedItem as string ?? "System default"),
            SpeakerDevice = SpeakerSelect.SelectedIndex == 0 ? "System default" : (SpeakerSelect.SelectedItem as string ?? "System default"),
            Language = I18n.Lang,
            HifiVoice = HifiCheck.IsChecked == true,
            VoiceProcessingEnabled = VoiceProcessingLobbyCheck.IsChecked == true,
            MicGain = ToGain(MicGainSlider.Value),
            MediaVolume = ToGain(MediaVolumeSlider.Value),
            MicStereoByDevice = _micStereoByDevice,
        }.Save();
    }

    private void OnLanguageChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_uiReady) return; // ctor sets the initial selection before fields are populated
        if (LanguageSelect.SelectedIndex < 0 || LanguageSelect.SelectedIndex >= Languages.Length) return;
        var code = Languages[LanguageSelect.SelectedIndex].Code;
        if (code == I18n.Lang) return;
        I18n.Lang = code;
        ApplyStrings();
        foreach (var p in _peers) p.RaiseLabels();
        SaveSettings();
    }

    private async void OnHifiChanged(object sender, RoutedEventArgs e)
    {
        if (_syncingVoiceMode) return;
        var result = VoiceProcessingSelection.SetHifiVoice(
            VoiceProcessingLobbyCheck.IsChecked == true, HifiCheck.IsChecked == true);
        SyncVoiceProcessingChecks(result.VoiceProcessing);
        if (result.OtherModeDisabled) Announce(I18n.T("voice_processing_disabled_for_hifi"));
        SaveSettings();
        // Like the web toggle: the live producer's codec can't be renegotiated mid-call.
        if (_inCall) Announce(I18n.T("hifi_next_call"));
        if (_session is not null && result.OtherModeDisabled)
            await _session.SwitchVoiceProcessingAsync(false);
    }

    private async void OnVoiceProcessingChanged(object sender, RoutedEventArgs e)
    {
        if (_syncingVoiceMode) return;
        var enabled = sender is CheckBox check && check.IsChecked == true;
        var result = VoiceProcessingSelection.SetVoiceProcessing(HifiCheck.IsChecked == true, enabled);
        _syncingVoiceMode = true;
        HifiCheck.IsChecked = result.HifiVoice;
        _syncingVoiceMode = false;
        SyncVoiceProcessingChecks(result.VoiceProcessing);
        if (result.OtherModeDisabled) Announce(I18n.T("hifi_disabled_for_voice_processing"));
        SaveSettings();

        if (_testCap is not null)
        {
            StopMicTest();
            StartMicTest(announceStart: false);
        }
        if (_session is not null)
            await _session.SwitchVoiceProcessingAsync(enabled);
    }

    private void SyncVoiceProcessingChecks(bool enabled)
    {
        _syncingVoiceMode = true;
        VoiceProcessingLobbyCheck.IsChecked = enabled;
        VoiceProcessingCallCheck.IsChecked = enabled;
        _syncingVoiceMode = false;
    }

    /// <summary>(Re)apply every localized string. Called at startup and on language switch, so
    /// the whole UI re-renders in place; state-dependent button texts respect current state.</summary>
    private void ApplyStrings()
    {
        if (!_inCall) Title = "SonicRoom";
        SubtitleText.Text = I18n.T("app_subtitle");
        LanguageSelect.Header = I18n.T("header_language");
        AutomationProperties.SetName(LanguageSelect, I18n.T("header_language"));
        ServerBox.Header = I18n.T("header_server");
        AutomationProperties.SetName(ServerBox, I18n.T("header_server"));
        RoomBox.Header = I18n.T("header_room");
        AutomationProperties.SetName(RoomBox, I18n.T("header_room"));
        NameBox.Header = I18n.T("header_name");
        AutomationProperties.SetName(NameBox, I18n.T("header_name"));
        MicSelect.Header = I18n.T("header_mic");
        AutomationProperties.SetName(MicSelect, I18n.T("header_mic"));
        SpeakerSelect.Header = I18n.T("header_speaker");
        AutomationProperties.SetName(SpeakerSelect, I18n.T("header_speaker"));
        MicTestButton.Content = _testCap is null ? I18n.T("mic_test") : I18n.T("mic_test_stop");
        AutomationProperties.SetName(MicLevelBar, I18n.T("mic_level"));
        ListenOnlyCheck.Content = I18n.T("listen_only");
        PublicCheck.Content = I18n.T("make_public");
        HifiCheck.Content = I18n.T("hifi_voice");
        AutomationProperties.SetHelpText(HifiCheck, I18n.T("hifi_voice_help"));
        VoiceProcessingLobbyCheck.Content = I18n.T("voice_processing");
        VoiceProcessingCallCheck.Content = I18n.T("voice_processing");
        AutomationProperties.SetName(VoiceProcessingLobbyCheck, I18n.T("voice_processing"));
        AutomationProperties.SetName(VoiceProcessingCallCheck, I18n.T("voice_processing"));
        AutomationProperties.SetHelpText(VoiceProcessingLobbyCheck, I18n.T("voice_processing_help"));
        AutomationProperties.SetHelpText(VoiceProcessingCallCheck, I18n.T("voice_processing_help"));
        ConnectButton.Content = I18n.T("join_call");
        AutomationProperties.SetName(ConnectStatus, I18n.T("connection_status"));
        PublicRoomsHeader.Text = I18n.T("public_rooms");
        RefreshRoomsButton.Content = I18n.T("refresh");
        AutomationProperties.SetName(RefreshRoomsButton, I18n.T("refresh_rooms"));
        AutomationProperties.SetName(PublicRoomsList, I18n.T("public_rooms"));
        PublicRoomsEmpty.Text = I18n.T("no_public_rooms");

        // Device combos: relabel the "System default" slot without losing the selection.
        if (MicSelect.Items.Count > 0) RelabelDefaultSlot(MicSelect);
        if (SpeakerSelect.Items.Count > 0) RelabelDefaultSlot(SpeakerSelect);

        AutomationProperties.SetName(CallStatus, I18n.T("call_status"));
        AutomationProperties.SetName(PeersList, I18n.T("participants"));
        AutomationProperties.SetName(CallControls, I18n.T("call_controls"));
        ChatHistoryBox.Header = I18n.T("chat_header");
        AutomationProperties.SetName(ChatHistoryBox, I18n.T("chat_history"));
        ChatHistoryBox.PlaceholderText = I18n.T("chat_placeholder");
        ChatInput.PlaceholderText = I18n.T("message_placeholder");
        AutomationProperties.SetName(ChatInput, I18n.T("message_placeholder"));
        SendButton.Content = I18n.T("send");
        AutomationProperties.SetName(SendButton, I18n.T("send_message"));

        MuteButton.Content = I18n.T("mute");
        AutomationProperties.SetName(MuteButton, I18n.T("mute_mic"));
        DeafenButton.Content = I18n.T("deafen");
        AutomationProperties.SetName(DeafenButton, I18n.T("deafen"));
        DuckButton.Content = I18n.T("autoduck");
        AutomationProperties.SetName(DuckButton, I18n.T("autoduck_name"));
        SpeakersButton.Content = I18n.T("whos_speaking");
        AutomationProperties.SetName(SpeakersButton, I18n.T("whos_speaking_name"));
        ShareButton.Content = _session?.IsSharing == true ? I18n.T("stop_sharing") : I18n.T("share_app_audio");
        ExtraMicButton.Content = I18n.T("extra_mics");
        FileButton.Content = _session?.IsStreamingFile == true ? I18n.T("stop_file") : I18n.T("play_file");
        ChangeFileButton.Content = I18n.T("change_file");
        RecordButton.Content = _session?.IsRecording == true ? I18n.T("stop_recording") : I18n.T("record");
        DownloadButton.Content = I18n.T("download_recording");
        AutomationProperties.SetName(DownloadButton, I18n.T("download_recording"));
        DownloadMixedItem.Text = I18n.T("download_mixed");
        DownloadTracksItem.Text = I18n.T("download_tracks");
        StreamButton.Content = _session?.IsStreaming == true ? I18n.T("stop_streaming") : I18n.T("stream");
        LeaveButton.Content = I18n.T("leave");
        AutomationProperties.SetName(LeaveButton, I18n.T("leave_call"));
        MicGainLabel.Text = I18n.T("mic_gain");
        AutomationProperties.SetName(MicGainSlider, I18n.T("mic_gain_name"));
        MediaVolumeLabel.Text = I18n.T("media_volume");
        AutomationProperties.SetName(MediaVolumeSlider, I18n.T("media_volume_name"));
        MasterLabel.Text = I18n.T("master");
        AutomationProperties.SetName(MasterVolume, I18n.T("master_volume_name"));
    }

    private static void RelabelDefaultSlot(ComboBox combo)
    {
        var sel = combo.SelectedIndex;
        combo.Items[0] = I18n.T("system_default");
        if (sel == 0) combo.SelectedIndex = 0;
    }

    // ---- public rooms list ----------------------------------------------------------------------

    /// <summary>One row of the lobby's public-rooms list. ToString is the UIA/display name.</summary>
    private sealed record PublicRoomItem(string Name, string Label)
    {
        public override string ToString() => Label;
    }

    private static readonly System.Net.Http.HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(8) };
    // Recordings can be long — no 8s cap on the download client.
    private static readonly System.Net.Http.HttpClient DownloadHttp = new() { Timeout = System.Threading.Timeout.InfiniteTimeSpan };

    private async System.Threading.Tasks.Task RefreshPublicRoomsAsync(bool announceResult)
    {
        try
        {
            var baseUrl = ServerBox.Text.Trim().TrimEnd('/');
            var json = await Http.GetStringAsync($"{baseUrl}/api/public-rooms");
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var items = new List<PublicRoomItem>();
            foreach (var r in doc.RootElement.GetProperty("rooms").EnumerateArray())
            {
                var name = r.GetProperty("name").GetString() ?? "";
                var people = new List<string>();
                if (r.TryGetProperty("participants", out var parts))
                    foreach (var p in parts.EnumerateArray())
                        if (p.GetString() is { Length: > 0 } n) people.Add(n);
                var label = people.Count == 0
                    ? I18n.F("room_empty", name)
                    : I18n.F("room_people", name, people.Count, string.Join(", ", people));
                items.Add(new PublicRoomItem(name, label));
            }
            PublicRoomsList.ItemsSource = items;
            PublicRoomsEmpty.Visibility = items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            if (announceResult)
                Announce(items.Count == 0
                    ? I18n.T("no_public_rooms")
                    : items.Count == 1 ? I18n.T("one_public_room") : I18n.F("n_public_rooms", items.Count));
        }
        catch (Exception ex)
        {
            Diag.Log("public-rooms", ex);
            if (announceResult) Announce(I18n.F("could_not_load_rooms", ex.Message));
        }
    }

    private async void OnRefreshRoomsClick(object sender, RoutedEventArgs e)
        => await RefreshPublicRoomsAsync(announceResult: true);

    private void OnPublicRoomClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not PublicRoomItem room) return;
        RoomBox.Text = room.Name;
        Announce(I18n.F("room_set", room.Name));
    }

    // ---- device selectors + pre-join mic test --------------------------------------------------

    // Combo index → (WaveIn/WaveOut device number, product name); slot 0 is the Windows default.
    private List<(int Index, string Name)> _micDevices = new();
    private List<(int Index, string Name)> _speakerDevices = new();
    private IMicrophoneCapture? _testCap;
    private WaveOutEvent? _testOut;
    private BufferedWaveProvider? _testBuf;
    private int _testFrameCount;

    private void PopulateMicList(string? preferName)
    {
        _micDevices = new List<(int, string)> { (-1, "System default") };
        foreach (var d in InputDevices.List()) _micDevices.Add(d);
        MicSelect.Items.Clear();
        MicSelect.Items.Add(I18n.T("system_default"));
        foreach (var (_, name) in _micDevices.Skip(1)) MicSelect.Items.Add(name);
        var idx = preferName is null or "System default" ? 0 : _micDevices.FindIndex(d => d.Name == preferName);
        _rememberedMicUnavailable = preferName is not null and not "System default" && idx < 0;
        MicSelect.SelectedIndex = idx >= 0 ? idx : 0;
    }

    private void PopulateSpeakerList(string? preferName)
    {
        _speakerDevices = new List<(int, string)> { (-1, "System default") };
        foreach (var d in OutputDevices.List()) _speakerDevices.Add(d);
        SpeakerSelect.Items.Clear();
        SpeakerSelect.Items.Add(I18n.T("system_default"));
        foreach (var (_, name) in _speakerDevices.Skip(1)) SpeakerSelect.Items.Add(name);
        var idx = preferName is null or "System default" ? 0 : _speakerDevices.FindIndex(d => d.Name == preferName);
        _rememberedSpeakerUnavailable = preferName is not null and not "System default" && idx < 0;
        SpeakerSelect.SelectedIndex = idx >= 0 ? idx : 0;
    }

    /// <summary>Refresh on open so a just-plugged device shows up without restarting.</summary>
    private void OnMicDropDownOpened(object? sender, object e)
    {
        var current = SelectedMic().Name;
        PopulateMicList(current);
    }

    private void OnSpeakerDropDownOpened(object? sender, object e)
    {
        var current = SelectedSpeaker().Name;
        PopulateSpeakerList(current);
    }

    private (int Index, string Name) SelectedMic()
        => MicSelect.SelectedIndex >= 0 && MicSelect.SelectedIndex < _micDevices.Count
            ? _micDevices[MicSelect.SelectedIndex]
            : (-1, "System default");

    private (int Index, string Name) SelectedSpeaker()
        => SpeakerSelect.SelectedIndex >= 0 && SpeakerSelect.SelectedIndex < _speakerDevices.Count
            ? _speakerDevices[SpeakerSelect.SelectedIndex]
            : (-1, "System default");

    /// <summary>
    /// Audible self-monitor: capture the selected device and play it straight back, so the
    /// mic can be verified by ear before joining (a visual level bar alone is useless to a
    /// screen-reader user). The bar still shows the live peak level for sighted users.
    /// </summary>
    private void OnMicTestClick(object sender, RoutedEventArgs e)
    {
        if (_testCap is not null)
        {
            StopMicTest();
            Announce(I18n.T("mic_test_stopped"));
            return;
        }

        StartMicTest(announceStart: true);
    }

    private void StartMicTest(bool announceStart)
    {
        var (dev, name) = SelectedMic();
        try
        {
            _testBuf = new BufferedWaveProvider(new WaveFormat(48000, 16, 2))
            { DiscardOnBufferOverflow = true, BufferDuration = TimeSpan.FromSeconds(1) };
            _testOut = new WaveOutEvent { DesiredLatency = 120, DeviceNumber = SelectedSpeaker().Index };
            _testOut.Init(_testBuf);
            _testOut.Play();
            if (VoiceProcessingLobbyCheck.IsChecked == true)
            {
                try
                {
                    var capture = VoiceDeviceMapper.MapCapture(dev);
                    var render = VoiceDeviceMapper.MapRender(SelectedSpeaker().Index);
                    if (capture.FellBack) Announce(I18n.T("remembered_mic_unavailable"));
                    if (render.FellBack) Announce(I18n.T("remembered_speaker_unavailable"));
                    _testCap = new ProcessedMicCapture(capture.EndpointIndex, render.EndpointIndex);
                    _testCap.FrameReady += OnTestFrame;
                    _testCap.Start();
                }
                catch (Exception ex)
                {
                    var hr = System.Runtime.InteropServices.Marshal.GetHRForException(ex);
                    Diag.Log($"Mic test voice processing unavailable (HRESULT 0x{hr:X8})", ex);
                    _testCap?.Dispose();
                    _testCap = null;
                    SyncVoiceProcessingChecks(false);
                    SaveSettings();
                    Announce(I18n.T("voice_processing_unavailable"));
                }
            }
            if (_testCap is null)
            {
                _testCap = new MicCapture(dev);
                _testCap.FrameReady += OnTestFrame;
                _testCap.Start();
            }
            MicTestButton.Content = I18n.T("mic_test_stop");
            MicTestButton.IsChecked = true;
            if (announceStart) Announce(I18n.F("testing_mic", name));
        }
        catch (Exception ex)
        {
            Diag.Log("MicTest", ex);
            StopMicTest();
            Announce(I18n.F("mic_test_failed", ex.Message));
        }
    }

    private void OnTestFrame(short[] frame)
    {
        var buf = _testBuf;
        if (buf is null) return;
        var bytes = new byte[frame.Length * 2];
        Buffer.BlockCopy(frame, 0, bytes, 0, bytes.Length);
        buf.AddSamples(bytes, 0, bytes.Length);

        if (++_testFrameCount % 5 != 0) return; // level bar ~10×/s is plenty
        var peak = 0;
        foreach (var s in frame) { var a = Math.Abs((int)s); if (a > peak) peak = a; }
        var pct = Math.Min(100.0, peak * 100.0 / short.MaxValue);
        Enqueue(() => MicLevelBar.Value = pct);
    }

    private void StopMicTest()
    {
        _testCap?.Dispose(); _testCap = null;
        _testOut?.Dispose(); _testOut = null;
        _testBuf = null;
        MicTestButton.Content = I18n.T("mic_test");
        MicTestButton.IsChecked = false;
        MicLevelBar.Value = 0;
    }

    // ---- announcements ------------------------------------------------------------------

    /// <summary>
    /// Speak a transient message through the screen reader (Prism) and mirror it to the
    /// visible status line. Use <see cref="AnnounceEvent"/> for room events that belong in
    /// the chat timeline.
    /// </summary>
    private void Announce(string message, bool interrupt = false)
    {
        _speech.Speak(message, interrupt);
        (CallPanel.Visibility == Visibility.Visible ? CallStatus : ConnectStatus).Text = message;
        Diag.Log($"[announce] {message}");
    }

    /// <summary>
    /// A room event: spoken AND logged to the chat timeline as a system entry, so it can be
    /// re-read later via the transcript or Alt+number — the chat is the single timeline of
    /// everything announced (same rule as the web client).
    /// </summary>
    private void AnnounceEvent(string message)
    {
        AppendChat(new ChatLine("", message, DateTimeOffset.UtcNow, ChatKind.System));
        Announce(message);
    }

    /// <summary>UIA notification fallback used only when Prism has no backend.</summary>
    private void RaiseUiaNotification(string message)
    {
        try
        {
            var peer = Microsoft.UI.Xaml.Automation.Peers.FrameworkElementAutomationPeer.FromElement(CallStatus)
                     ?? Microsoft.UI.Xaml.Automation.Peers.FrameworkElementAutomationPeer.CreatePeerForElement(CallStatus);
            peer?.RaiseNotificationEvent(
                Microsoft.UI.Xaml.Automation.Peers.AutomationNotificationKind.Other,
                Microsoft.UI.Xaml.Automation.Peers.AutomationNotificationProcessing.MostRecent,
                message, "sonicroom");
        }
        catch { /* announcements must never throw */ }
    }

    // ---- chat timeline + Alt+number readback ----------------------------------------------

    /// <summary>Append to the timeline and re-render the read-only transcript box. The caret
    /// follows the newest line unless the user is inside the box reading history.</summary>
    private void AppendChat(ChatLine line)
    {
        _chatLines.Add(line);
        if (_chatLines.Count > ChatCap) _chatLines.RemoveAt(0);

        var reading = ChatHistoryBox.FocusState != FocusState.Unfocused;
        var selStart = ChatHistoryBox.SelectionStart;
        var selLen = ChatHistoryBox.SelectionLength;

        ChatHistoryBox.Text = string.Join(Environment.NewLine, _chatLines.Select(ChatFormat.TranscriptLine));
        var len = ChatHistoryBox.Text.Length; // TextBox may normalize newlines — re-measure

        if (reading)
        {
            // Don't yank the caret from under someone arrow-keying through the history.
            var start = Math.Min(selStart, len);
            ChatHistoryBox.Select(start, Math.Min(selLen, len - start));
        }
        else
        {
            ChatHistoryBox.Select(len, 0); // caret parks on the newest message
            ChatHistoryBox.UpdateLayout();
            if (FindScrollViewer(ChatHistoryBox) is { } sv)
                sv.ChangeView(null, sv.ScrollableHeight, null, disableAnimation: true);
        }
    }

    /// <summary>
    /// Alt+1..9 and Alt+0 read the last 10 timeline entries aloud: 1 = newest, 2 = next,
    /// … 0 = the 10th most recent. Pressing the SAME number again within
    /// <see cref="DoublePressMs"/> copies that message's body to the clipboard — same
    /// behavior and numbering as the web client.
    ///
    /// FALLBACK path only: the primary route is GlobalHotkeys.AltDigit, which swallows the
    /// keystroke pre-window so no WM_SYSCHAR is generated (an unhandled Alt+char WM_SYSCHAR
    /// makes DefWindowProc play the system beep — accelerators can't mark it handled). These
    /// window-wide accelerators only see the key if that hook failed to install; they beep,
    /// but the readback still works.
    /// </summary>
    private void InstallChatReadbackAccelerators()
    {
        for (var d = 0; d <= 9; d++)
        {
            var digit = d;
            foreach (var key in new[]
                     {
                         (VirtualKey)((int)VirtualKey.Number0 + d),
                         (VirtualKey)((int)VirtualKey.NumberPad0 + d),
                     })
            {
                var acc = new KeyboardAccelerator { Key = key, Modifiers = VirtualKeyModifiers.Menu };
                acc.Invoked += (_, args) =>
                {
                    args.Handled = true;
                    ChatReadback(digit);
                };
                RootGrid.KeyboardAccelerators.Add(acc);
            }
        }
    }

    private void ChatReadback(int digit)
    {
        // The knock-to-join dialog owns the keyboard while it's up (web parity).
        if (!_inCall || _knockOpen) return;

        var n = digit == 0 ? 10 : digit;
        var line = n <= _chatLines.Count ? _chatLines[^n] : null;
        var now = DateTimeOffset.UtcNow;

        // Second quick press of the same digit on an existing message → copy its body.
        if (line is not null && _lastAltDigit == digit && (now - _lastAltAt).TotalMilliseconds < DoublePressMs)
        {
            _lastAltDigit = -1;
            try
            {
                var dp = new global::Windows.ApplicationModel.DataTransfer.DataPackage();
                dp.SetText(ChatFormat.MessageContent(line));
                global::Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(dp);
                Announce(I18n.T("copied"), interrupt: true);
            }
            catch (Exception ex) { Announce(I18n.F("copy_failed", ex.Message), interrupt: true); }
            return;
        }

        _lastAltDigit = digit;
        _lastAltAt = now;
        Announce(line is not null ? ChatFormat.FormatMessage(line, now) : I18n.F("no_message", n), interrupt: true);
    }

    // ---- toolbar focus memory -------------------------------------------------------------

    private Control? _lastToolbarControl;

    /// <summary>
    /// Tabbing into the "Call controls" toolbar should land on the last button used (Mute on
    /// first entry) — by default the framework may drop focus on whichever child it likes
    /// (observed: Leave, the most destructive one). Arrow-key moves inside the toolbar are
    /// left alone; only keyboard ENTRY from outside is redirected.
    /// </summary>
    private void InstallToolbarFocusMemory()
    {
        foreach (var child in CallControls.Children)
            if (child is Control c)
                c.GotFocus += (_, _) => _lastToolbarControl = c;

        CallControls.GettingFocus += (_, e) =>
        {
            if (e.InputDevice is not (FocusInputDeviceKind.Keyboard or FocusInputDeviceKind.GameController))
                return; // don't hijack mouse clicks
            if (e.OldFocusedElement is DependencyObject old && IsInToolbar(old))
                return; // arrow-key / tab movement within the group
            var target = _lastToolbarControl ?? MuteButton;
            if (!ReferenceEquals(e.NewFocusedElement, target))
                e.TrySetNewFocusedElement(target);
        };
    }

    private bool IsInToolbar(DependencyObject element)
    {
        for (var d = element; d is not null; d = VisualTreeHelper.GetParent(d))
            if (ReferenceEquals(d, CallControls)) return true;
        return false;
    }

    // ---- hotkeys ----------------------------------------------------------------------------

    private void ToggleMuteFromHotkey()
    {
        if (_session is null) return;
        MuteButton.IsChecked = MuteButton.IsChecked != true;
        ApplyMuteState();
    }

    private void ToggleDeafenFromHotkey()
    {
        if (_session is null) return;
        DeafenButton.IsChecked = DeafenButton.IsChecked != true;
        _session.SetDeafened(DeafenButton.IsChecked == true);
        Announce(DeafenButton.IsChecked == true ? I18n.T("deafened") : I18n.T("undeafened"));
    }

    // ---- connect / leave ----------------------------------------------------------------------

    private async void OnConnectClick(object sender, RoutedEventArgs e)
    {
        StopMicTest();
        ConnectButton.IsEnabled = false;
        Announce(I18n.T("connecting"));

        var session = new RoomSession();
        _session = session;
        session.Log += s => { Diag.Log($"[session] {s}"); Enqueue(() => CallStatus.Text = s); };
        session.VoiceProcessingUnavailable += _ => Enqueue(() =>
        {
            SyncVoiceProcessingChecks(false);
            SaveSettings();
            Announce(I18n.T("voice_processing_unavailable"));
        });
        session.VoiceDeviceFallback += device => Enqueue(() => Announce(I18n.T(
            device == "microphone" ? "remembered_mic_unavailable" : "remembered_speaker_unavailable")));
        session.PeerJoined += p => Enqueue(() =>
        {
            if (Find(p.PeerId) is null) _peers.Add(TrackRowLabel(new PeerItem(p.PeerId, p.DisplayName)));
            UpdateKickVisibility();
            if (_inCall)
            {
                session.PlayCue(Cue.Join);
                AppendChat(new ChatLine(p.DisplayName, "", DateTimeOffset.UtcNow, ChatKind.Join));
                Announce(I18n.F("joined_the_room", p.DisplayName));
            }
        });
        session.PeerLeft += id => Enqueue(() =>
        {
            if (Find(id) is { } it)
            {
                if (_inCall)
                {
                    session.PlayCue(Cue.Leave);
                    AppendChat(new ChatLine(it.DisplayName, "", DateTimeOffset.UtcNow, ChatKind.Leave));
                    Announce(I18n.F("left_the_room", it.DisplayName));
                }
                _peers.Remove(it);
                UpdateKickVisibility();
            }
        });
        session.PeerMuteChanged += (id, muted) => Enqueue(() =>
        {
            if (Find(id) is { } it)
            {
                it.Muted = muted;
                if (_inCall)
                {
                    session.PlayCue(muted ? Cue.PeerMute : Cue.PeerUnmute);
                    Announce(muted ? I18n.F("peer_muted_announce", it.DisplayName)
                                   : I18n.F("peer_unmuted_announce", it.DisplayName));
                }
            }
        });
        session.Joined += () => Enqueue(() => _inCall = true);
        session.ChatReceived += m => Enqueue(() =>
        {
            var ts = m.Ts > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(m.Ts) : DateTimeOffset.UtcNow;
            var line = new ChatLine(m.Sender, m.Text, ts);
            AppendChat(line);
            if (_inCall) // the join snapshot's history replays silently
            {
                session.PlayCue(Cue.Message);
                var announcement = ChatFormat.FormatMessage(line, DateTimeOffset.UtcNow);
                if (!_chatHintGiven)
                {
                    // First live message of the call: one-time pointer at the readback keys.
                    _chatHintGiven = true;
                    announcement += ChatFormat.MetaSep + I18n.T("chat_hint");
                }
                Announce(announcement);
            }
        });
        session.RecordingChanged += (active, by) => Enqueue(() =>
        {
            RecordButton.Content = active ? I18n.T("stop_recording") : I18n.T("record");
            UpdateDownloadVisibility();
            AnnounceEvent(active
                ? (string.IsNullOrEmpty(by) ? I18n.T("recording_started") : I18n.F("recording_started_by", by))
                : I18n.T("recording_stopped"));
        });
        session.RecordingExpiredEvent += () => Enqueue(() =>
        {
            UpdateDownloadVisibility();
            AnnounceEvent(I18n.T("recording_expired_announce"));
        });
        session.StreamingChanged += (active, by) => Enqueue(() =>
        {
            StreamButton.Content = active ? I18n.T("stop_streaming") : I18n.T("stream");
            AnnounceEvent(active
                ? (string.IsNullOrEmpty(by) ? I18n.T("streaming_started") : I18n.F("streaming_started_by", by))
                : I18n.T("streaming_stopped"));
        });
        session.StreamingFailed += err => Enqueue(() =>
        {
            StreamButton.Content = I18n.T("stream");
            AnnounceEvent(string.IsNullOrEmpty(err)
                ? I18n.T("streaming_stopped_unexpected")
                : I18n.F("streaming_failed", err));
        });
        session.DuckingChangedEvent += (enabled, by) => Enqueue(() =>
        {
            DuckButton.IsChecked = enabled;
            var name = string.IsNullOrEmpty(by) ? I18n.T("a_participant") : by!;
            AnnounceEvent(I18n.F(enabled ? "ducking_on_by" : "ducking_off_by", name));
        });
        session.PeerShareChanged += (name, started) => Enqueue(() =>
        {
            if (_inCall)
            {
                session.PlayCue(started ? Cue.ShareStart : Cue.ShareStop);
                AnnounceEvent(started ? I18n.F("share_started_peer", name) : I18n.F("share_stopped_peer", name));
            }
        });
        session.PeerFileChanged += (name, started) => Enqueue(() =>
        {
            if (_inCall)
            {
                session.PlayCue(started ? Cue.ShareStart : Cue.ShareStop);
                AnnounceEvent(started ? I18n.F("file_started_peer", name) : I18n.F("file_stopped_peer", name));
            }
        });
        session.PeerMicStreamStarted += name => Enqueue(() =>
        {
            if (_inCall) AnnounceEvent(I18n.F("mic_stream_started_peer", name));
        });
        session.PeerMicStreamStopped += (name, _) => Enqueue(() =>
        {
            if (_inCall) AnnounceEvent(I18n.F("mic_stream_stopped_peer", name));
        });
        session.PeerStreamsChanged += peerId => Enqueue(() =>
        {
            if (Find(peerId) is { } it)
            {
                it.HasStreams = session.GetPeerStreams(peerId).Count > 0;
                it.IsCaster = session.IsCaster(peerId);
            }
            UpdateKickVisibility(); // caster status changes the votable count
        });
        session.StreamForceStopped += (ownerName, source, wasMine, producerId) => Enqueue(() =>
        {
            if (wasMine)
            {
                // Server already closed the producer; reflect it in my own controls.
                foreach (var kv in _extraMicProducers.Where(kv => kv.Value.ProducerId == producerId).ToList())
                    _extraMicProducers.Remove(kv.Key);
                if (source == "share") ShareButton.Content = I18n.T("share_app_audio");
                if (source == "file") { FileButton.Content = I18n.T("play_file"); ChangeFileButton.Visibility = Visibility.Collapsed; }
                AnnounceEvent(I18n.F("stream_stopped_yours", SourceName(source)));
            }
            else
            {
                AnnounceEvent(I18n.F("stream_stopped_of", ownerName, SourceName(source)));
            }
        });
        session.FileTitleChanged += (name, title) => Enqueue(() =>
        {
            if (_inCall && !string.IsNullOrEmpty(title))
                AnnounceEvent(I18n.F("now_streaming", name, title!));
        });
        session.FilePlaybackEnded += error => Enqueue(() =>
        {
            FileButton.Content = I18n.T("play_file");
            ChangeFileButton.Visibility = Visibility.Collapsed;
            if (!_inCall) return;
            if (string.IsNullOrEmpty(error)) AnnounceEvent(I18n.T("media_finished"));
            else Announce(I18n.F("file_failed", error));
        });
        session.JoinPending += () => Enqueue(() => Announce(I18n.T("waiting_admit")));
        session.RoomBecamePublic += () => Enqueue(() =>
        {
            UpdateKickVisibility();
            AnnounceEvent(I18n.T("room_now_public"));
        });
        session.KickVoteChanged += v => Enqueue(() =>
        {
            if (Find(v.TargetId) is { } it)
            {
                it.Votes = v.Votes;
                // Server-authoritative pressed state for MY kick button on this peer.
                if (v.VoterId is not null && v.VoterId == session.MyPeerId)
                    it.MyVote = v.Action == "cast";
            }
            var target = v.TargetName ?? Find(v.TargetId)?.DisplayName ?? I18n.T("a_participant");
            var voter = string.IsNullOrEmpty(v.VoterName) ? I18n.T("someone") : v.VoterName!;
            if (v.Action == "cast") Announce(I18n.F("voted_kick", voter, target));
            else if (v.Action == "withdraw") Announce(I18n.F("withdrew_kick", voter, target));
            // "recount" (membership change) stays silent, like the web client.
        });
        session.PeerKickedEvent += (name, reason) => Enqueue(() =>
            AnnounceEvent(reason == "caster" ? I18n.F("caster_removed", name) : I18n.F("removed_by_vote", name)));
        session.YouWereKicked += () => Enqueue(ShowKicked);
        session.JoinRequestsChanged += reqs => Enqueue(() =>
        {
            _pendingJoinRequests = reqs.Count;
            if (reqs.Count > 0)
            {
                session.PlayCue(Cue.Knock);
                if (_knockTimer is { IsRunning: false } t) t.Start();
            }
            ShowJoinRequests(reqs);
        });

        var mic = SelectedMic();
        var speaker = SelectedSpeaker();
        SaveSettings();

        session.HifiVoice = HifiCheck.IsChecked == true;
        session.VoiceProcessingEnabled = VoiceProcessingLobbyCheck.IsChecked == true;
        session.MicGain = (float)ToGain(MicGainSlider.Value);
        session.MediaVolume = (float)ToGain(MediaVolumeSlider.Value);

        var room = RoomBox.Text.Trim();
        try
        {
            await session.ConnectAsync(
                ServerBox.Text.Trim(), room, NameBox.Text.Trim(),
                ListenOnlyCheck.IsChecked == true, PublicCheck.IsChecked == true,
                mic.Index, speaker.Index);

            _serverUrl = ServerBox.Text.Trim().TrimEnd('/');
            _roomName = room;
            Title = $"{room} — SonicRoom";
            CallTitle.Text = I18n.F("room_title", room);
            RecordButton.Content = session.IsRecording ? I18n.T("stop_recording") : I18n.T("record");
            StreamButton.Content = session.IsStreaming ? I18n.T("stop_streaming") : I18n.T("stream");
            DuckButton.IsChecked = session.DuckingEnabled;
            MicGainSlider.IsEnabled = ListenOnlyCheck.IsChecked != true;
            VoiceProcessingCallCheck.IsEnabled = ListenOnlyCheck.IsChecked != true;
            UpdateDownloadVisibility();
            ConnectScroll.Visibility = Visibility.Collapsed;
            CallPanel.Visibility = Visibility.Visible;
            UpdateKickVisibility();
            _speakTimer?.Start();

            var others = session.PeerNames.Count;
            Announce(others == 0
                ? I18n.F("joined_room_alone", room)
                : others == 1 ? I18n.F("joined_room_one", room) : I18n.F("joined_room_n", room, others));
            if (ListenOnlyCheck.IsChecked == true)
                Announce(I18n.T("joined_no_mic"));
            else
                Announce(I18n.F("mic_in_use", mic.Name));
        }
        catch (Exception ex)
        {
            Diag.Log("Join failed", ex);
            Announce(I18n.F("failed_join", ex.Message));
            ConnectButton.IsEnabled = true;
            _session = null;
            await session.DisposeAsync();
        }
    }

    private async void OnLeaveClick(object sender, RoutedEventArgs e)
    {
        await DoLeave();
        Announce(I18n.T("left_room"));
    }

    private async System.Threading.Tasks.Task DoLeave()
    {
        _inCall = false;
        _speakTimer?.Stop();
        _knockTimer?.Stop();
        _pendingJoinRequests = 0;
        if (_session is not null)
        {
            await _session.LeaveAsync();
            _session = null;
        }
        _peers.Clear();
        _chatLines.Clear();
        ChatHistoryBox.Text = "";
        _chatHintGiven = false;
        Title = "SonicRoom";
        CallPanel.Visibility = Visibility.Collapsed;
        ConnectScroll.Visibility = Visibility.Visible;
        ConnectButton.IsEnabled = true;
        MuteButton.IsChecked = false;
        DeafenButton.IsChecked = false;
        ShareButton.Content = I18n.T("share_app_audio");
        RecordButton.Content = I18n.T("record");
        StreamButton.Content = I18n.T("stream");
        FileButton.Content = I18n.T("play_file");
        ChangeFileButton.Visibility = Visibility.Collapsed;
        DownloadButton.Visibility = Visibility.Collapsed;
        _extraMicProducers.Clear();
        _ = RefreshPublicRoomsAsync(announceResult: false); // back at the lobby — fresh list
    }

    // ---- toolbar -----------------------------------------------------------------------------

    private void OnMuteClick(object sender, RoutedEventArgs e) => ApplyMuteState();

    /// <summary>Apply MuteButton's state to the session, with cue + announcement.</summary>
    private void ApplyMuteState()
    {
        if (_session is null) return;
        var muted = MuteButton.IsChecked == true;
        _session.SetMuted(muted);
        _session.PlayCue(muted ? Cue.Mute : Cue.Unmute);
        Announce(muted ? I18n.T("mic_muted") : I18n.T("mic_unmuted"));
    }

    private void OnDeafenClick(object sender, RoutedEventArgs e)
    {
        _session?.SetDeafened(DeafenButton.IsChecked == true);
        Announce(DeafenButton.IsChecked == true ? I18n.T("deafened") : I18n.T("undeafened"));
    }

    private async void OnDuckClick(object sender, RoutedEventArgs e)
    {
        if (_session is null) return;
        var want = DuckButton.IsChecked == true;
        try
        {
            // Server-authoritative: the ducking-changed echo updates state + announces.
            await _session.SetDuckingAsync(want);
        }
        catch (Exception ex)
        {
            DuckButton.IsChecked = !want;
            Announce(I18n.F("ducking_toggle_failed", ex.Message));
        }
    }

    private void OnSpeakersClick(object sender, RoutedEventArgs e) => AnnounceSpeakers();

    /// <summary>The accessible twin of the visual speaking dots: list who's talking right now.</summary>
    private void AnnounceSpeakers()
    {
        if (_session is null) return;
        var names = new List<string>();
        if (_session.SelfSpeaking) names.Add(I18n.T("speaking_you"));
        foreach (var id in _session.SpeakingPeerIds())
            if (Find(id) is { } it) names.Add(it.DisplayName);
        Announce(names.Count == 0
            ? I18n.T("speaking_none")
            : I18n.F("speaking_list", string.Join(", ", names)), interrupt: true);
    }

    private void UpdateSpeakingIndicators()
    {
        if (_session is null || !_inCall) return;
        var ids = _session.SpeakingPeerIds();
        foreach (var p in _peers) p.IsSpeaking = ids.Contains(p.PeerId);
    }

    private void OnMasterVolumeChanged(object sender, RangeBaseValueChangedEventArgs e)
        => _session?.SetMasterVolume((float)ToGain(e.NewValue));

    private void OnMicGainChanged(object sender, RangeBaseValueChangedEventArgs e)
    {
        if (_session is not null) _session.MicGain = (float)ToGain(e.NewValue);
    }

    private void OnMediaVolumeChanged(object sender, RangeBaseValueChangedEventArgs e)
    {
        if (_session is not null) _session.MediaVolume = (float)ToGain(e.NewValue);
    }

    private void OnPeerVolumeChanged(object sender, RangeBaseValueChangedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is PeerItem item)
            _session?.SetPeerVolume(item.PeerId, (float)ToGain(e.NewValue));
    }

    private static double ToPercent(double gain) => gain * PercentScale;
    private static double ToGain(double percent) => percent / PercentScale;

    private void OnLocalMuteClick(object sender, RoutedEventArgs e)
    {
        if (_session is null || (sender as FrameworkElement)?.DataContext is not PeerItem item) return;
        _session.SetPeerLocalMute(item.PeerId, item.LocalMuted);
        Announce(item.LocalMuted
            ? I18n.F("local_muted_announce", item.DisplayName)
            : I18n.F("local_unmuted_announce", item.DisplayName));
    }

    // ---- moderation ---------------------------------------------------------------------------

    private async void OnKickPeerClick(object sender, RoutedEventArgs e)
    {
        if (_session is null || (sender as FrameworkElement)?.DataContext is not PeerItem item) return;
        // The ToggleButton has already flipped; treat its state as the desired vote and let
        // the kick-vote broadcast (server-authoritative) settle MyVote + the tally.
        var want = (sender as ToggleButton)?.IsChecked == true;
        item.MyVote = want;
        try { await _session.VoteKickAsync(item.PeerId, want); }
        catch (Exception ex)
        {
            item.MyVote = !want; // rejected (private room / too few peers / rate limit) — revert
            Announce(I18n.F("cannot_vote", ex.Message));
        }
    }

    private async void OnRemoveCasterClick(object sender, RoutedEventArgs e)
    {
        if (_session is null || (sender as FrameworkElement)?.DataContext is not PeerItem item) return;
        var dlg = new ContentDialog
        {
            Title = I18n.T("remove_caster_title"),
            Content = new TextBlock { Text = I18n.F("remove_caster_confirm", item.DisplayName), TextWrapping = TextWrapping.Wrap },
            PrimaryButtonText = I18n.T("remove"),
            CloseButtonText = I18n.T("cancel"),
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = ((FrameworkElement)Content).XamlRoot,
        };
        if (await dlg.ShowAsync() != ContentDialogResult.Primary) return;
        try { await _session.KickCasterAsync(item.PeerId); }
        catch (Exception ex) { Announce(I18n.F("remove_caster_failed", ex.Message)); }
        // Success announces via the peer-kicked broadcast (reason "caster").
    }

    private void OnStopStreamClick(object sender, RoutedEventArgs e)
    {
        if (_session is null || (sender as FrameworkElement)?.DataContext is not PeerItem item) return;
        var streams = _session.GetPeerStreams(item.PeerId);
        if (streams.Count == 0) return;
        if (streams.Count == 1)
        {
            _ = StopPeerStreamAsync(streams[0].ProducerId);
            return;
        }
        // Several streams (e.g. multiple extra mics): pick which one from a flyout.
        var flyout = new MenuFlyout();
        foreach (var s in streams)
        {
            var mi = new MenuFlyoutItem
            {
                Text = string.IsNullOrEmpty(s.Title) ? SourceName(s.Source) : $"{SourceName(s.Source)} — {s.Title}",
            };
            var pid = s.ProducerId;
            mi.Click += (_, _) => _ = StopPeerStreamAsync(pid);
            flyout.Items.Add(mi);
        }
        flyout.ShowAt(sender as FrameworkElement);
    }

    private async System.Threading.Tasks.Task StopPeerStreamAsync(string producerId)
    {
        if (_session is null) return;
        try { await _session.StopPeerStreamAsync(producerId); }
        catch (Exception ex) { Announce(I18n.F("stop_stream_failed", ex.Message)); }
        // Success announces via the peer-stream-stopped broadcast.
    }

    private static string SourceName(string source) => source switch
    {
        "share" => I18n.T("source_share"),
        "file" => I18n.T("source_file"),
        _ => I18n.T("source_mic"),
    };

    private void ShowKicked()
    {
        Announce(I18n.T("you_removed"));
        _ = DoLeave();
    }

    private bool _knockOpen;

    private async void ShowJoinRequests(IReadOnlyList<JoinRequestItem> requests)
    {
        if (_session is null || _knockOpen || requests.Count == 0) return;
        var req = requests[0];
        Announce(I18n.F("wants_join", req.DisplayName));

        _knockOpen = true;
        var dlg = new ContentDialog
        {
            Title = I18n.T("someone_wants_join"),
            Content = new TextBlock { Text = I18n.F("let_them_in", req.DisplayName), TextWrapping = TextWrapping.Wrap },
            PrimaryButtonText = I18n.T("admit"),
            CloseButtonText = I18n.T("deny"),
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = ((FrameworkElement)Content).XamlRoot,
        };
        var result = await dlg.ShowAsync();
        _knockOpen = false;

        try
        {
            if (result == ContentDialogResult.Primary) { await _session.AdmitAsync(req.Id); AnnounceEvent(I18n.F("admitted", req.DisplayName)); }
            else { await _session.DenyAsync(req.Id); AnnounceEvent(I18n.F("denied", req.DisplayName)); }
        }
        catch (Exception ex) { Announce(I18n.F("join_decision_failed", ex.Message)); }
    }

    // ---- chat composer --------------------------------------------------------------------------

    private async void OnSendChatClick(object sender, RoutedEventArgs e) => await SendChatAsync();

    private async void OnChatKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter) { e.Handled = true; await SendChatAsync(); }
    }

    private async System.Threading.Tasks.Task SendChatAsync()
    {
        var text = ChatInput.Text?.Trim();
        if (string.IsNullOrEmpty(text) || _session is null) return;
        ChatInput.Text = "";
        await _session.SendChatAsync(text);
    }

    // ---- share / sources ------------------------------------------------------------------------

    private async void OnShareClick(object sender, RoutedEventArgs e)
    {
        if (_session is null) return;

        if (_session.IsSharing)
        {
            await _session.StopShareAsync();
            ShareButton.Content = I18n.T("share_app_audio");
            _session.PlayCue(Cue.ShareStop);
            AnnounceEvent(I18n.T("you_stopped_sharing"));
            return;
        }

        // Accessible picker: a checkbox per app (keyboard + screen-reader friendly), not a
        // multi-select ListView (whose selection often doesn't register via NVDA).
        var apps = AudioAppEnumerator.List();
        var checks = new List<CheckBox>();
        var listPanel = new StackPanel { Spacing = 2 };
        foreach (var a in apps)
        {
            var cb = new CheckBox { Content = a.Active ? I18n.F("app_playing", a.Name) : a.Name, Tag = a.ProcessId };
            checks.Add(cb);
            listPanel.Children.Add(cb);
        }

        var include = new RadioButton { Content = I18n.T("share_only_checked"), IsChecked = true };
        var exclude = new RadioButton { Content = I18n.T("share_all_except") };

        var panel = new StackPanel { Spacing = 8, MinWidth = 380 };
        panel.Children.Add(new TextBlock { Text = I18n.T("share_dialog_text") });
        panel.Children.Add(new ScrollViewer { Content = listPanel, MaxHeight = 320 });
        panel.Children.Add(include);
        panel.Children.Add(exclude);

        var dialog = new ContentDialog
        {
            Title = I18n.T("share_dialog_title"),
            Content = panel,
            PrimaryButtonText = I18n.T("start_sharing"),
            CloseButtonText = I18n.T("cancel"),
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = ((FrameworkElement)Content).XamlRoot,
        };

        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;

        var pids = checks.Where(c => c.IsChecked == true).Select(c => (uint)c.Tag!).ToList();
        if (pids.Count == 0) { Announce(I18n.T("no_app_checked")); return; }

        try
        {
            await _session.StartShareAsync(pids, include.IsChecked == true);
            if (_session.IsSharing)
            {
                ShareButton.Content = I18n.T("stop_sharing");
                _session.PlayCue(Cue.ShareStart);
                AnnounceEvent(I18n.T("you_started_sharing"));
            }
            else Announce(I18n.T("share_capture_failed"));
        }
        catch (Exception ex)
        {
            Diag.Log("StartShare", ex);
            Announce(I18n.F("share_failed", ex.Message));
        }
    }

    private async void OnRecordClick(object sender, RoutedEventArgs e)
    {
        if (_session is null) return;
        try
        {
            if (_session.IsRecording) await _session.StopRecordingAsync();
            else await _session.StartRecordingAsync();
        }
        catch (Exception ex) { Announce(I18n.F("recording_action_failed", ex.Message)); }
    }

    // ---- recording download ---------------------------------------------------------------------

    private void UpdateDownloadVisibility()
        => DownloadButton.Visibility = _session?.RecordingId is not null ? Visibility.Visible : Visibility.Collapsed;

    private async void OnDownloadMixedClick(object sender, RoutedEventArgs e)
        => await SaveRecordingAsync(tracks: false);

    private async void OnDownloadTracksClick(object sender, RoutedEventArgs e)
        => await SaveRecordingAsync(tracks: true);

    /// <summary>
    /// Fetch <c>/api/recordings/{id}/download</c> (server-mixed OGG) or <c>/tracks</c> (ZIP of
    /// per-participant captures) to a user-picked file. The id is the capability token from
    /// recording-started / the join snapshot — kept after stop, dropped on recording-expired.
    /// </summary>
    private async System.Threading.Tasks.Task SaveRecordingAsync(bool tracks)
    {
        var id = _session?.RecordingId;
        if (id is null) { Announce(I18n.T("no_recording")); return; }

        var picker = new global::Windows.Storage.Pickers.FileSavePicker
        {
            SuggestedFileName = $"{_roomName}-recording",
        };
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        if (tracks) picker.FileTypeChoices.Add("ZIP", new List<string> { ".zip" });
        else picker.FileTypeChoices.Add("Ogg Opus", new List<string> { ".ogg" });

        var file = await picker.PickSaveFileAsync();
        if (file is null) return;

        var url = $"{_serverUrl}/api/recordings/{Uri.EscapeDataString(id)}/{(tracks ? "tracks" : "download")}";
        Announce(I18n.T("download_started"));
        try
        {
            using var resp = await DownloadHttp.GetAsync(url, System.Net.Http.HttpCompletionOption.ResponseHeadersRead);
            resp.EnsureSuccessStatusCode();
            using (var src = await resp.Content.ReadAsStreamAsync())
            using (var dst = await file.OpenStreamForWriteAsync())
            {
                dst.SetLength(0);
                await src.CopyToAsync(dst);
            }
            AnnounceEvent(I18n.F("download_done", file.Name));
        }
        catch (Exception ex)
        {
            Diag.Log("Download recording", ex);
            Announce(I18n.F("download_failed", ex.Message));
        }
    }

    // ---- Icecast streaming ------------------------------------------------------------------------

    private async void OnStreamClick(object sender, RoutedEventArgs e)
    {
        if (_session is null) return;
        if (_session.IsStreaming)
        {
            try { await _session.StopStreamingAsync(); }
            catch (Exception ex) { Announce(I18n.F("stop_streaming_failed", ex.Message)); }
            return;
        }

        var host = Named(new TextBox { Header = I18n.T("icecast_host") }, I18n.T("icecast_host"));
        var port = Named(new TextBox { Header = I18n.T("port"), Text = "8000" }, I18n.T("port"));
        var mount = Named(new TextBox { Header = I18n.T("mount"), Text = "/sonicroom" }, I18n.T("mount"));
        var user = Named(new TextBox { Header = I18n.T("username"), Text = "source" }, I18n.T("username"));
        var pass = Named(new PasswordBox { Header = I18n.T("password") }, I18n.T("password"));
        var format = Named(new ComboBox { Header = I18n.T("format"), SelectedIndex = 0 }, I18n.T("format"));
        format.Items.Add("mp3");
        format.Items.Add("opus");

        var panel = new StackPanel { Spacing = 8, MinWidth = 320 };
        foreach (var c in new FrameworkElement[] { host, port, mount, user, pass, format })
            panel.Children.Add(c);

        var dlg = new ContentDialog
        {
            Title = I18n.T("icecast_title"),
            Content = panel,
            PrimaryButtonText = I18n.T("start"),
            CloseButtonText = I18n.T("cancel"),
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = ((FrameworkElement)Content).XamlRoot,
        };
        if (await dlg.ShowAsync() != ContentDialogResult.Primary) return;
        if (!int.TryParse(port.Text, out var portNum)) { Announce(I18n.T("invalid_port")); return; }

        var config = new
        {
            host = host.Text.Trim(),
            port = portNum,
            mount = mount.Text.Trim(),
            username = string.IsNullOrWhiteSpace(user.Text) ? "source" : user.Text.Trim(),
            password = pass.Password,
            format = format.SelectedItem as string ?? "mp3",
            bitrateKbps = 160,
        };
        try { await _session.StartStreamingAsync(config); }
        catch (Exception ex) { Announce(I18n.F("start_streaming_failed", ex.Message)); }
    }

    private async void OnExtraMicClick(object sender, RoutedEventArgs e)
    {
        if (_session is null) return;

        // One row per input device: checkbox (stream it?) + a mono/stereo radio pair (the
        // web's per-device layout choice, persisted by device name in MicStereoByDevice).
        var devices = InputDevices.List();
        var rows = new List<(int Idx, string Name, CheckBox Cb, RadioButton Stereo)>();
        var panel = new StackPanel { Spacing = 6, MinWidth = 420 };
        panel.Children.Add(new TextBlock { Text = I18n.T("extra_mics_text") });
        foreach (var d in devices)
        {
            var live = _extraMicProducers.TryGetValue(d.Index, out var lp);
            var prefStereo = live ? lp.Stereo
                : _micStereoByDevice.TryGetValue(d.Name, out var s) && s;
            var cb = new CheckBox { Content = d.Name, IsChecked = live, VerticalAlignment = VerticalAlignment.Center };
            var mono = Named(new RadioButton
            {
                Content = I18n.T("mono_label"), GroupName = $"ch{d.Index}", IsChecked = !prefStereo,
                MinWidth = 0, VerticalAlignment = VerticalAlignment.Center,
            }, I18n.F("mono_for", d.Name));
            var stereo = Named(new RadioButton
            {
                Content = I18n.T("stereo_label"), GroupName = $"ch{d.Index}", IsChecked = prefStereo,
                MinWidth = 0, VerticalAlignment = VerticalAlignment.Center,
            }, I18n.F("stereo_for", d.Name));
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
            row.Children.Add(cb);
            row.Children.Add(mono);
            row.Children.Add(stereo);
            panel.Children.Add(row);
            rows.Add((d.Index, d.Name, cb, stereo));
        }

        var dlg = new ContentDialog
        {
            Title = I18n.T("extra_mics_title"),
            Content = new ScrollViewer { Content = panel, MaxHeight = 320 },
            PrimaryButtonText = I18n.T("apply"),
            CloseButtonText = I18n.T("cancel"),
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = ((FrameworkElement)Content).XamlRoot,
        };
        if (await dlg.ShowAsync() != ContentDialogResult.Primary) return;

        foreach (var (idx, name, cb, stereoRb) in rows)
        {
            var want = cb.IsChecked == true;
            var wantStereo = stereoRb.IsChecked == true;
            _micStereoByDevice[name] = wantStereo;
            var have = _extraMicProducers.TryGetValue(idx, out var liveProd);
            try
            {
                if (want && have && liveProd.Stereo != wantStereo)
                {
                    // The channel layout can't be renegotiated on a live producer — restart this
                    // mic with the new layout. (No SFU-pin dance needed: this client always joins
                    // disableP2p:true, which alone pins the room to the SFU.)
                    _extraMicProducers.Remove(idx);
                    await _session.StopExtraMicAsync(liveProd.ProducerId);
                    var pid = await _session.StartExtraMicAsync(idx, name, wantStereo);
                    if (pid != null)
                    {
                        _extraMicProducers[idx] = (pid, wantStereo);
                        AnnounceEvent(I18n.F(wantStereo ? "streaming_extra_mic_stereo" : "streaming_extra_mic", name));
                    }
                    else Announce(I18n.F("extra_mic_failed_start", name));
                }
                else if (want && !have)
                {
                    var pid = await _session.StartExtraMicAsync(idx, name, wantStereo);
                    if (pid != null)
                    {
                        _extraMicProducers[idx] = (pid, wantStereo);
                        AnnounceEvent(I18n.F(wantStereo ? "streaming_extra_mic_stereo" : "streaming_extra_mic", name));
                    }
                    else Announce(I18n.F("extra_mic_failed_start", name));
                }
                else if (!want && have)
                {
                    _extraMicProducers.Remove(idx);
                    await _session.StopExtraMicAsync(liveProd.ProducerId);
                    AnnounceEvent(I18n.F("stopped_extra_mic", name));
                }
            }
            catch (Exception ex) { Announce(I18n.F("extra_mic_failed", name, ex.Message)); }
        }
        SaveSettings();
    }

    private async void OnFileClick(object sender, RoutedEventArgs e)
    {
        if (_session is null) return;
        if (_session.IsStreamingFile)
        {
            await _session.StopFileAsync();
            FileButton.Content = I18n.T("play_file");
            ChangeFileButton.Visibility = Visibility.Collapsed;
            AnnounceEvent(I18n.T("you_stopped_file"));
            return;
        }
        await PickAndStreamMediaAsync(swap: false);
    }

    /// <summary>Swap the streamed file on the LIVE producer — listeners keep one continuous
    /// stream; only the title updates (update-stream-title → producer-title-updated).</summary>
    private async void OnChangeFileClick(object sender, RoutedEventArgs e)
    {
        if (_session is null || !_session.IsStreamingFile) return;
        await PickAndStreamMediaAsync(swap: true);
    }

    private async System.Threading.Tasks.Task PickAndStreamMediaAsync(bool swap)
    {
        var urlBox = Named(new TextBox
        {
            Header = I18n.T("media_url"),
            PlaceholderText = "https://example.com/media.mp4",
        }, I18n.T("media_url"));
        var panel = new StackPanel { Spacing = 8, MinWidth = 420 };
        panel.Children.Add(new TextBlock { Text = I18n.T("media_url_hint"), TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(urlBox);
        var dialog = new ContentDialog
        {
            Title = I18n.T("media_dialog_title"),
            Content = panel,
            PrimaryButtonText = I18n.T("choose_file"),
            SecondaryButtonText = I18n.T("play_file"),
            CloseButtonText = I18n.T("cancel"),
            DefaultButton = ContentDialogButton.Secondary,
            XamlRoot = ((FrameworkElement)Content).XamlRoot,
        };

        var result = await dialog.ShowAsync();
        if (result == ContentDialogResult.None || _session is null) return;

        string source;
        string title;
        if (result == ContentDialogResult.Primary)
        {
            var picker = new global::Windows.Storage.Pickers.FileOpenPicker();
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            picker.FileTypeFilter.Add("*");
            var file = await picker.PickSingleFileAsync();
            if (file is null || _session is null) return;
            source = file.Path;
            title = file.Name;
        }
        else
        {
            var value = urlBox.Text.Trim();
            if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                Announce(I18n.T("invalid_media_url"));
                return;
            }
            source = uri.AbsoluteUri;
            title = Uri.UnescapeDataString(Path.GetFileName(uri.AbsolutePath));
            if (string.IsNullOrWhiteSpace(title)) title = uri.Host;
        }

        try
        {
            title = await _session.StartFileAsync(source, title);
            FileButton.Content = I18n.T("stop_file");
            ChangeFileButton.Visibility = Visibility.Visible;
            AnnounceEvent(swap ? I18n.F("you_swapped_file", title) : I18n.F("playing_file", title));
        }
        catch (Exception ex) { Announce(I18n.F("file_failed", ex.Message)); }
    }

    // ---- helpers -------------------------------------------------------------------------------

    /// <summary>Set the UIA name on a code-built dialog control (Header alone isn't reliably
    /// exposed to screen readers on all control types).</summary>
    private static T Named<T>(T element, string name) where T : DependencyObject
    {
        AutomationProperties.SetName(element, name);
        return element;
    }

    private static ScrollViewer? FindScrollViewer(DependencyObject root)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is ScrollViewer sv) return sv;
            if (FindScrollViewer(child) is { } nested) return nested;
        }
        return null;
    }

    /// <summary>Kick controls exist only in public rooms with 3+ votable people (me included) —
    /// the web client's gate. Casters aren't votable (they have their own remove button).
    /// Re-evaluated on join, membership changes, caster detection, and room-went-public.</summary>
    private void UpdateKickVisibility()
    {
        var can = _session is { RoomIsPublic: true } && _session.VotableCount >= 3;
        foreach (var p in _peers) p.CanKick = can;
    }

    /// <summary>Keep the row's UIA name in sync as mute/vote state changes after realization.</summary>
    private PeerItem TrackRowLabel(PeerItem item)
    {
        item.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(PeerItem.RowLabel)
                && PeersList.ContainerFromItem(item) is ListViewItem container)
                AutomationProperties.SetName(container, item.RowLabel);
        };
        return item;
    }

    private void Enqueue(Microsoft.UI.Dispatching.DispatcherQueueHandler handler) => DispatcherQueue.TryEnqueue(handler);

    private PeerItem? Find(string peerId)
    {
        foreach (var p in _peers)
            if (p.PeerId == peerId) return p;
        return null;
    }
}
