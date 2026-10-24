# SonicRoom — Windows client (WinUI 3)

A **fully native Windows** client for SonicRoom. Unlike the web/Electron clients it is a real
WinUI 3 desktop app — **no browser, no WebView, no Chromium, no JavaScript**. Native global
keyboard shortcuts, and the headline feature: **per-application audio sharing** (include/exclude
specific apps' audio), which a browser simply cannot do.

## Architecture (fully native)

Everything is C#/.NET:

- **UI** — WinUI 3 / XAML (participant list, controls, chat, moderation, settings).
- **Signaling** — a C# **socket.io** client speaks the same protocol the web client uses.
- **Transport** — **[SIPSorcery](https://github.com/sipsorcery-org/sipsorcery)** provides pure-C#
  WebRTC (ICE, DTLS-SRTP, RTP/RTCP) and **Opus** (via Concentus). On top of it sits a
  hand-rolled **mediasoup client handshake** (device load → create/connect WebRtcTransport →
  produce/consume), modeled on the pure-client `pymediasoup` design. The client is **SFU-only**:
  it always joins with `disableP2p:true`, so there is a single transport code path.
- **Audio** — native **WASAPI**: mic capture → Opus → RTP producer; incoming RTP → Opus decode →
  per-peer gain mix (client-side ducking/volume/deafen, mirroring the web `PeerAudioRegistry`) →
  WASAPI render.
- **Per-app share** — the **WASAPI Process Loopback API** (`ActivateAudioInterfaceAsync` +
  `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`) captures a chosen app (or everything-except an app),
  mixes it, encodes Opus, and produces it as a `source:"share"` track.

The server needs **no changes** — this is just another SFU peer. Server URL / ICE / branding come
from a native Settings store.

## Requirements

- Windows 10 build 20348+ or Windows 11 (per-app loopback capture needs this).
- .NET 9 SDK.
- The Windows App SDK runtime (installed with the VS "Windows App SDK" component, or run a
  self-contained build — see Packaging, later phase).
- [FFmpeg](https://ffmpeg.org/) for media playback (`winget install Gyan.FFmpeg.Essentials`).
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube watch-link playback
  (`winget install yt-dlp.yt-dlp`).

## Layout

```
windows_client/
├─ SonicRoom.Windows.sln
└─ src/                         WinUI 3 app (C#)
   ├─ SonicRoom.Windows.csproj
   ├─ App.xaml(.cs)             application entry
   ├─ MainWindow.xaml(.cs)      host window (currently a diagnostics shell)
   ├─ Signaling/                (Phase 1) socket.io client + protocol
   ├─ Transport/                (Phase 2) SIPSorcery + mediasoup handshake
   └─ Audio/                    (Phase 3+) WASAPI capture/render, Opus, per-app loopback
```

## Build / run

```powershell
# From windows_client/src
dotnet restore
dotnet build -p:Platform=x64
# Run from Visual Studio (F5) or:
dotnet run -p:Platform=x64
```

## Features (all implemented)

- **Voice call** over the SFU: join/leave, participant list, per-peer volume + one-click
  per-peer **local mute**, mute, deafen, master volume, listen-only, mic-less join.
- **Voice quality matches the web client**: mono ~64 kbps by default, with a persisted
  **hi-fi voice** opt-in (stereo ~128 kbps, applied at the next call). A send-side
  **mic gain** (0–4×) runs through a soft limiter, like the web's boost + compressor.
- **Voice processing** is a persisted, default-off option for the primary microphone. It uses
  Windows' built-in Voice Capture DSP for acoustic echo cancellation and noise suppression; no
  cloud service or additional native binary is involved. The DSP's automatic gain control and
  microphone gain bounder are deliberately left off — the DSP would otherwise adjust the
  Windows microphone level itself (observed driving it way down); level control stays with the
  user's mic gain slider. It can
  be changed live without leaving the room and is also used by the microphone test. Processing
  produces mono 16 kHz speech-band audio (resampled to the call's 48 kHz frame contract), so it
  is mutually exclusive with hi-fi voice. Extra microphones and shared/media audio stay raw.
- **Speaking indicators** — a per-peer dot lights while a voice is active (RMS detection in
  the mixer), and **Ctrl+W / "Who's speaking"** announces the current talkers on demand.
- **Global keyboard shortcuts** (work when unfocused): Ctrl+Shift+M mute, Ctrl+Shift+D deafen,
  push-to-talk (`src/Input/GlobalHotkeys.cs`).
- **Per-application audio share** — pick apps to include, or exclude one; each share is its own
  `source:"share"` producer (WASAPI Process Loopback, `src/Audio/ProcessLoopback*.cs`).
- **Extra microphones** — stream additional input devices, each its own `mic` producer, with a
  per-device **mono/stereo** choice (persisted by device name; flipping it on a live mic
  restarts that producer, since a codec layout can't be renegotiated).
- **Media playback** — play the audio track from any FFmpeg-supported local media file, a direct
  HTTP/HTTPS media stream, or a YouTube watch link into the call as a `file` producer. **Change
  media** swaps content on the live producer (no stop/start — listeners just see the title update
  via `update-stream-title`, like the web client). Outgoing media is also monitored through the
  selected local speaker and follows master volume, deafen, and auto-ducking. A persisted media
  volume slider controls both the local monitor and the audio sent to remote listeners.
- **Recording** with **download** (mixed OGG or per-track ZIP via the recording token; the
  link survives stop and clears on `recording-expired`) and **Icecast live streaming** —
  start/stop, room-wide LIVE state.
- **Room-wide auto-ducking toggle** (`set-ducking` / `ducking-changed`), seeded from the join
  ack and applied in the native mixer.
- **Text chat** with history.
- **Moderation** — knock-to-join (admit/deny) with a **looping knock cue**, vote-to-kick with
  tally (casters excluded from the votable count), kicked screen, "make room public", plus the
  anti-troll tools: **Stop stream** on any peer's share/file/extra-mic (`stop-peer-stream`)
  and **Remove** on a music caster (`kick-caster`).
- **Earcons** — native ports of the web client's cues (FM-bell doorbell join, door-shut leave,
  chat chime, mute/unmute slides, share arpeggios, knock) mixed over the call audio
  (`src/Audio/Cues.cs`); audible even while deafened, so a knock can't be missed.
- **Output device picker** (speaker selection) alongside the microphone picker.
- **Localized UI + announcements** — English / Español / Français (`src/I18n.cs`, the same
  locales as the web client), switchable live from the connect screen.
- **Accessibility** (screen-reader-first — see below) — announcements spoken through
  **Prism**, a permanent read-only chat transcript, Alt+number chat readback, and UIA
  labels on every control.
- **Persisted settings** (`%LOCALAPPDATA%\SonicRoom\settings.json`: server/room/name, mic +
  speaker device, language, hi-fi voice, voice processing, mic gain) and a diagnostics log
  (`%LOCALAPPDATA%\SonicRoom\log.txt`).

If a remembered input or output endpoint is unavailable, voice processing uses the current
Windows communications default and announces the fallback. If `Mfwmaaec.dll` or the DSP cannot
initialize, the client logs the HRESULT, turns Voice processing off, announces the failure, and
immediately restores ordinary NAudio microphone capture.

The hardware DSP smoke test uses the default microphone and speaker, validates exact nonzero
20 ms frames, and verifies clean shutdown:

```powershell
dotnet run --project tools/VoiceCaptureHarness/VoiceCaptureHarness.csproj -- 10
```

The whole engine is `src/Session/RoomSession.cs`; the transport is `src/Transport/` (SIPSorcery +
a hand-rolled mediasoup handshake — see the repo memory notes). Opus is always signaled as
`opus/48000/2` (mediasoup requires the router's channel count exactly); mono vs stereo travels in
the encoded packets plus `stereo`/`sprop-stereo` fmtp hints, exactly as browsers do. A headless
test harness lives in `tools/SignalingHarness` (modes: `observe`, `probe`, `call`, `live`,
`mono`, `multi`, `share`, `loopback`).

## Accessibility

The app is built for screen-reader users (the same rules as the web client, natively):

- **Announcements speak through [Prism]** (`src/Accessibility/PrismSpeech.cs`, binaries vendored
  under `libs/prism/`): joins, leaves, chat, mute state, recording/streaming, moderation — spoken
  directly by the running screen reader (NVDA/JAWS/Narrator/SAPI via Prism's best-backend
  registry). All prism calls run on one dedicated background thread; if prism can't load
  (e.g. ARM64) each message falls back to a UIA `RaiseNotificationEvent`, so exactly one channel
  speaks. `prism.dll`/`tolk.dll` are copied next to the exe at build time (x64).
- **The chat is the timeline of everything announced** (web-client rule): room events
  (recording, streaming, kicks, shares…) are logged as system entries alongside messages and
  join/leave lines, in a **permanent read-only transcript TextBox** right beside the composer —
  walk it with the caret, select and copy from it.
- **Alt+1..9, Alt+0 read the last ten timeline entries** (1 = newest … 0 = tenth); pressing the
  **same number again within 600 ms copies** that message's body to the clipboard. Formatting
  matches the web client ("Alice: hi — sent 2 minutes ago"). A one-time hint is appended to the
  first live chat announcement.
- **Every control carries a UIA name**: per-peer volume sliders ("Volume for Alice"), the kick
  button is a ToggleButton (UIA pressed = your vote, the aria-pressed equivalent) whose name
  carries the tally ("Kick Alice (2 votes)"), dialogs label every field, and pickers use
  checkbox lists (multi-select ListView selection doesn't register in NVDA).

## Packaging / distribution

For a build that runs on any Windows 10 20348+/11 machine without installing the Windows App SDK
runtime, publish **self-contained**:

```powershell
dotnet publish src/SonicRoom.Windows.csproj -c Release -r win-x64 --self-contained `
  -p:Platform=x64 -p:WindowsAppSDKSelfContained=true -p:WindowsPackageType=None
```

The output folder is xcopy-deployable (`SonicRoom.exe` + dependencies). For a signed MSIX installer,
add a Windows Application Packaging project and build on a machine/CI with a signing certificate.
