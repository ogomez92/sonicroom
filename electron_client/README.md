# SonicRoom desktop client (Electron)

A cross-platform (Windows / macOS / Linux) **thin client** for SonicRoom. It bundles
the existing web client (`client/dist`) and connects to a **configurable remote
SonicRoom instance** chosen in a native Settings window. It runs **no server** and
bundles **no ffmpeg/yt-dlp** — recording, Icecast streaming and URL/library playback
all happen on the remote server, exactly as in a browser. Because of that, the app
has **zero native dependencies** and packages the same way on every OS.

## How it works

- The main process serves `client/dist` over a stable, secure custom origin
  `app://sonicroom` (so `getUserMedia`/WebRTC have a secure context and
  `localStorage` persists across launches). The Settings window is served from the
  same origin under `app://sonicroom/__electron/` so it shares that `localStorage`
  with the client.
- A **preload** injects `window.__SONICROOM_CONFIG__` (server URL, ICE servers,
  branding, default name) before the client boots. The web client reads these
  through `client/src/lib/runtime-config.ts` + `branding.ts`; when nothing is
  injected (the plain web build) it falls back to same-origin + the default ICE
  list, so the web deployment is unchanged.
- The main process grants microphone + screen/system-audio permissions, fulfils
  `getDisplayMedia` via `setDisplayMediaRequestHandler` (screen + `loopback` audio),
  and relaxes cross-origin/mixed-content so the `app://` client can reach the remote
  server (`webSecurity:false` on the client window + a CORS header shim).

## Settings

The Settings window (menu **File → Settings…**, or `Ctrl/Cmd+,`) configures:

- **Connection** — remote server URL + instance name (stored in
  `userData/config.json`, injected at boot).
- **ICE / TURN servers** — JSON list, with “reset to defaults”.
- **Audio & voice** — default display name, language, mic gain, chat announcement
  mode, hi-fi voice, voice processing (the localStorage-backed prefs the web client
  already uses).
- **Icecast streaming target** — host/port/mount/credentials/format/bitrate.

Saving reloads the client window so the new config takes effect.

## Develop / build / package

```bash
pnpm install                              # from the repo root (downloads Electron)
pnpm --filter client build                # produce client/dist (served by the app)
pnpm --filter electron_client dev         # build the shell + launch (DevTools open)
pnpm --filter electron_client start       # build the shell + launch (no DevTools)
pnpm --filter electron_client typecheck   # tsc --noEmit

# Packaging (electron-builder):
pnpm --filter electron_client dist        # installers for the current OS → release/
pnpm --filter electron_client dist:dir    # unpacked app dir (fast, for inspection)
```

Notes:

- `dist` always rebuilds the Electron bundle first; it does **not** rebuild the web
  client — run `pnpm --filter client build` whenever the client changes.
- Signed/notarized installers for all three OSes must be built on each OS (or CI):
  Windows `nsis` and macOS `dmg` can’t be properly produced/signed from Linux.
- macOS **system-audio loopback** needs a recent macOS and is best-effort; mic and
  screen video always work. Windows/Linux loopback is solid.
- Dev tip: set `SONICROOM_CLIENT_URL=http://localhost:5173` to point the client
  window at a running `pnpm --filter client dev` (Vite) instead of the bundled
  `app://` build.
