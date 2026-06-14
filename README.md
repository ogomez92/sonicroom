# SonicRoom

**Low-latency, screen-reader-first browser audio conferencing — with hi-fi stereo music casting.**

## What is SonicRoom?

SonicRoom is a website where a group of people can **talk to each other live, with really good sound** — like a phone call or a voice chat, but in your web browser, with nothing to install. You open a link, type a name for your "room" and your own name, and you're in.

In plain terms, it lets you:

- **Talk together** with very little delay, so conversation feels natural.
- **Play music in hi-fi stereo** to everyone in the room (great for listening parties or DJ sets), and the music automatically gets quieter when someone speaks.
- **Type in a text chat** instead of (or as well as) talking — so people **without a microphone, or who can't or prefer not to speak, can still take part.**
- **Record the call** or **broadcast it live** to an internet radio server.
- **Open a room to the public** so others can find and join it, with the group itself deciding who gets in and who gets removed (there are no admins).

It's built to work really well with **screen readers and keyboards**: everything that happens is announced out loud and written into the chat, and you can drive the whole thing without a mouse.

You can use a SonicRoom that someone else is hosting, or **run your own server** — see ["Set up your own server"](#set-up-your-own-server) below for a step-by-step guide.

---

## Table of contents

**For everyone**

- [What is SonicRoom?](#what-is-sonicroom)
- [Features](#features)
- [Set up your own server](#set-up-your-own-server)

**For developers**

- [Tech stack](#tech-stack)
- [Run it locally (development)](#run-it-locally-development)
- [Repository layout](#repository-layout)
- [Architecture](#architecture)
  - [Hybrid P2P ↔ SFU transport](#hybrid-p2p--sfu-transport)
  - [Client audio graph](#client-audio-graph)
  - [Auto-ducking](#auto-ducking)
  - [Music caster (Ecobox)](#music-caster-ecobox)
  - [Server-side recording](#server-side-recording)
  - [Live Icecast streaming](#live-icecast-streaming)
  - [Public rooms & moderation](#public-rooms--moderation)
  - [Accessibility](#accessibility)
  - [Client routing & URL parameters](#client-routing--url-parameters)
  - [Internationalization](#internationalization-i18n)
- [HTTP API](#http-api)
- [Commands](#commands)
- [Testing](#testing)
- [Deployment & runtime](#deployment--runtime)
- [Ports](#ports)
- [Environment variables](#environment-variables)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Hybrid transport** — direct WebRTC mesh for ≤2 peers, mediasoup SFU for 3+, switched live without dropping the call.
- **Hi-fi music casting** — a send-only "caster" peer streams stereo audio at up to 256 kbps while voice stays a lean mono 64 kbps.
- **Automatic music ducking** — music dips smoothly whenever someone speaks, driven by server-side voice-level detection.
- **Server-side recording** — capture every participant to a single mixed Ogg/Opus file or per-track `.zip`, downloadable while the call is still live.
- **Live Icecast streaming** — broadcast a room's mix to any Icecast mount in MP3 or Opus.
- **Public rooms** — list a room in the lobby, with **knock-to-join** admission and **vote-to-kick** moderation (no privileged moderators).
- **Text chat + mic-less join** — anyone can join with **no microphone** (listen and type only); a missing or blocked mic falls back to this automatically instead of failing. Useful for people who can't or prefer not to speak.
- **Accessibility first** — every room event is spoken on an ARIA live region and logged to chat; screen-reader readback, keyboard-driven UI. Incoming/outgoing chat messages can be announced via a **polite** or **assertive** live region, **read aloud by the browser's voice**, or turned off — each person chooses.
- **Localized** — English, Spanish, and French, switchable mid-call without a reload.

## Set up your own server

This guide is for someone who is comfortable copying and pasting commands but is **not** a developer. By the end you'll have your own SonicRoom running that you and your friends can connect to.

> Just want to try it on your own laptop first, without making it public? Jump to [Run it locally](#run-it-locally-development) — it's simpler and skips the networking parts.

### What you'll need

- **A server that's on all the time and reachable from the internet.** This is usually a cheap "VPS" (virtual server) you rent by the month from a cloud host. Linux is the normal choice. You connect to it with a tool called SSH and type commands.
- **Node.js** — the program that actually runs SonicRoom. Free, from [nodejs.org](https://nodejs.org) (pick the "LTS" version).
- **pnpm** — a helper that downloads and assembles SonicRoom's parts. You don't install it separately; it comes with Node through a built-in tool called `corepack` (step 2 below switches it on).
- **ffmpeg** _(optional)_ — only needed if you want the **recording** or **live broadcast** features. Everything else works without it.

### Step by step

Run these on your server, one line at a time.

1. **Install Node.js** (version 20 or newer). On most Linux servers the cleanest way is [nodejs.org's instructions](https://nodejs.org/en/download). Check it worked:

   ```bash
   node --version
   ```

2. **Turn on pnpm:**

   ```bash
   corepack enable
   ```

3. **Download SonicRoom and go into its folder:**

   ```bash
   git clone <this-repository-url> sonicroom
   cd sonicroom
   ```

4. **Install all of SonicRoom's parts:**

   ```bash
   pnpm install
   ```

5. _(Optional)_ **Install ffmpeg** if you want recording / live broadcasting. On Debian/Ubuntu:

   ```bash
   sudo apt install ffmpeg
   ```

6. **Build the website:**

   ```bash
   pnpm build
   ```

7. **Tell SonicRoom your server's public address.** For people's audio to actually connect, the server has to advertise the public IP address others reach it on. Set it like this (replace the example with your server's real public IP — your host shows it in their dashboard, or run `curl ifconfig.me`):

   ```bash
   export ANNOUNCED_IP=203.0.113.10
   export NODE_ENV=production
   ```

8. **Start it:**

   ```bash
   pnpm start
   ```

   SonicRoom is now running and listening on **port 3100**.

9. **Open it in a browser:** `http://YOUR-SERVER-ADDRESS:3100`.

### Two things that trip people up

- **Microphones need a secure (HTTPS) page.** Browsers only allow microphone access on `https://…` pages (or on `localhost`). For a real public server you'll want a domain name and HTTPS. The easy route is to put a **reverse proxy** in front of SonicRoom — [Caddy](https://caddyserver.com) gets you automatic HTTPS in about three lines of config and forwards traffic to port 3100. (Until then, people **can still join with the "Join without a microphone" option and use text chat.**)
- **Open the audio ports in your firewall.** Voice/music travels over **UDP ports 40000–40100**. With [`ufw`](https://help.ubuntu.com/community/UFW) (the common Debian/Ubuntu firewall) you can open the whole range in one line — note the **colon** for the range and the `/udp` (both are required):

  ```bash
  sudo ufw allow 40000:40100/udp     # the audio range, in a single rule
  sudo ufw allow 3100/tcp            # the web port (or: sudo ufw allow 80,443/tcp behind a reverse proxy)
  ```

  Check it with `sudo ufw status`. The recording/streaming ports (50000–50998, 51000–51998) stay on loopback inside the server and don't need opening.

### Rename your instance

Want it to show your own name instead of "SonicRoom" in the lobby and the browser tab? Create a `.env` file in the project folder (copy the example with `cp .env.example .env`) and set:

```bash
INSTANCE_NAME=Acme Voice Rooms
```

Then restart the server (`pnpm start`, or `systemctl restart sonicroom` if you set up the service). **No rebuild needed** — the name is applied when the page loads. (The small "Powered by SonicRoom" credit in the footer stays, like a "Made with" badge.)

### Keeping it running

`pnpm start` stops when you close your SSH session. To keep SonicRoom running in the background and restart it automatically, run it as a service — see [Deployment & runtime](#deployment--runtime) for a ready-made `systemd` setup. Optional settings (like notifications) live in a `.env` file — see [Environment variables](#environment-variables).

---

# For developers

The sections below are reference material for working on SonicRoom's code.

## Tech stack

| Layer       | Technology                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| **Client**  | React 19, Vite 6, Tailwind CSS v4, Zustand, `mediasoup-client`, `socket.io-client`, Paraglide JS (i18n) |
| **Server**  | Node + Express 5, Socket.IO, `mediasoup` (SFU), Zod — TypeScript run directly via `tsx` (no build step) |
| **Media**   | WebRTC (Opus), ffmpeg for recording/streaming, external coturn (TURN/TURNS) and optional Icecast        |
| **Tooling** | pnpm workspaces, ESLint (flat config), Prettier, `node:test`                                            |

## Run it locally (development)

For hacking on SonicRoom on your own machine (no public server, no HTTPS needed — `localhost` is treated as secure, so microphones work).

### Prerequisites

- **Node.js** 20+ and **[pnpm](https://pnpm.io/)** (this is a pnpm workspace — **do not use npm**; `corepack enable` gives you pnpm).
- **ffmpeg** on `PATH` — required only for the recording and streaming features.
- For media to traverse NAT in production you'll want a TURN server (an external coturn is assumed) and, optionally, an Icecast server for live streaming. Neither is needed for local development.

### Install & run

```bash
pnpm install        # workspace install — also builds the native mediasoup worker
pnpm dev            # server (tsx watch :3100) + client (Vite :5173) together
```

Open <http://localhost:5173>. Vite proxies `/socket.io` and `/api` to the server on `:3100`, so the client and server talk to each other out of the box.

> **Heads-up on installs:** `onlyBuiltDependencies` (in `pnpm-workspace.yaml`) builds esbuild and mediasoup's native worker. If the server later fails to start with a worker error after a reinstall, run `pnpm install` again to rebuild the `mediasoup-worker` binary. If `pnpm` starts failing with `ERR_PNPM_IGNORED_BUILDS`, check `pnpm-workspace.yaml` for a malformed `allowBuilds:` stub and restore it (esbuild and mediasoup must be `true`).

### Production

```bash
pnpm build          # builds the CLIENT only -> client/dist
pnpm start          # server runs signaling AND serves client/dist statically on :3100
```

The server needs no build — it runs TypeScript live via `tsx`. Only the client is bundled.

## Repository layout

```
.
├── client/                 # React + Vite single-page app
│   ├── messages/           # i18n source strings (en/es/fr JSON)
│   └── src/
│       ├── components/      # Lobby, Room, ParticipantCard, Chat, JoinRequests, …
│       ├── hooks/           # useMediasoup.ts — the WebRTC/SFU engine + audio graph
│       ├── lib/             # i18n, chat, sdp-munger, audio-devices, sounds
│       └── stores/          # room.ts — single Zustand store
├── server/                 # Express + Socket.IO + mediasoup signaling server
│   └── src/
│       ├── index.ts             # entry: workers, HTTP routes, static serving
│       ├── signaling.ts         # Socket.IO room signaling & mode switching
│       ├── room-manager.ts      # room/peer state, public-room directory
│       ├── recording.ts/-util   # server-side recording (PlainTransport → ffmpeg)
│       ├── streaming.ts/-util   # live Icecast streaming
│       ├── kick-util.ts         # vote-to-kick threshold (pure, unit-tested)
│       ├── mediasoup-config.ts  # worker/router/transport options
│       └── notify.ts            # off-box "noty" notifications for public rooms
├── pnpm-workspace.yaml
└── CLAUDE.md               # deep contributor notes (this README's source of truth)
```

## Architecture

### Hybrid P2P ↔ SFU transport

A room dynamically picks its transport based on size and needs. The decision lives in one pure function — `decideMode(peerCount, currentMode, forceSfu)` in `server/src/recording-util.ts` — which both the join and leave handlers re-evaluate:

- **≤2 peers → P2P mesh.** Clients connect WebRTC directly; the server only relays signaling (`p2p-signal`). Media never touches the server.
- **3+ peers → mediasoup SFU.**
- **`forceSfu`** pins the SFU even for small rooms when the server _must_ see the media: while **recording**, while a **music caster** is present, or when **`?p2p=off`** is set.

On a transition the server emits `switch-to-sfu` / `switch-to-p2p`; the client (`useMediasoup.ts`) tears down one transport stack and builds the other. The outgoing audio graph survives the switch — only the senders/producers are rebuilt.

### Client audio graph

All audio runs through one module-scoped, shared `AudioContext` (resumed on first user gesture for iOS).

- **Outgoing:** `mic → micGain → soft limiter → outDest`. The track sent to peers / produced to the SFU is **always `outDest`'s track**, so tracks are never swapped on switches. Shared system/tab audio (`getDisplayMedia`) is mixed **straight into `outDest`**, bypassing the mic gain/limiter so music keeps its dynamics.
- **Incoming:** per-peer `MediaStreamSource → gainNode → destination`. `effectiveGain(peerId)` composes per-peer volume × deafen × music ducking; gain changes always ramp via `setTargetAtTime`.

### Auto-ducking

The server's `AudioLevelObserver` watches **voice producers only** — music/caster producers are deliberately excluded. It emits `duck {active}` on each on/off transition. The **client** performs the actual gain ramp: music-peer gain → `volume × DUCK_FACTOR` with attack/release time-constants. Ducking timing lives in client constants, not the caster, which just sends raw stereo.

### Music caster (Ecobox)

A send-only peer joins with `role: "caster"`. It produces a stereo track but never consumes or sets up P2P, so its presence forces the room onto the SFU. Voice self-limits to **mono 64 kbps** (`forceOpusParams` in `client/src/lib/sdp-munger.ts` plus `opusStereo:false`). The router's `maxaveragebitrate: 256000` is a **ceiling** that lets the caster negotiate hi-fi — it does not inflate voice.

### Server-side recording

Recording is server-side and forces the SFU. Per producer, a mediasoup `PlainTransport` pushes RTP to a local UDP port where an ffmpeg process captures it to a streamable Ogg/Opus file with `-c:a copy` (no re-encode). Downloads spawn a **second** ffmpeg that `amix`es all captures (aligning late joiners with `adelay`) and streams to the HTTP response — the live captures are never interrupted. Recordings are keyed by a `recordingId` capability token, not the room name.

- `GET /api/recordings/:id/download` — single mixed Ogg/Opus file.
- `GET /api/recordings/:id/tracks` — every participant's capture as separate files in one streamed `.zip`.

### Live Icecast streaming

`StreamManager` mirrors recording but is fully independent — a room can record, stream, both, or neither. Each producer gets its own `PlainTransport` + consumer → local UDP port; one **live mixer ffmpeg per room** `amix`es them and pushes to `icecast://user:pass@host:port/mount` (MP3 via `libmp3lame` or Opus via `libopus`). A permanent silent stereo **anchor** keeps the Icecast source alive when no one is producing.

The Icecast target is supplied by whoever starts streaming (in the in-call **Streaming** panel, persisted to `localStorage`), validated server-side, and **never broadcast** to the room — only `streaming-started`/`streaming-stopped`/`streaming-failed` events go out. Because a muted (paused) producer sends no RTP and would stall `amix`, the mixer is rebuilt (debounced) whenever the active producer set changes; configure an Icecast `<fallback-mount>` for seamless listening across rebuilds.

### Public rooms & moderation

Rooms are **private by default** and become **sticky-public** once any joiner enables it. Public rooms are listed in the lobby and can ping an operator notification daemon on activity. There are **no moderators** — admission and removal are collective:

- **Knock-to-join.** A newcomer to an already-public, occupied room is held pending and shows participants a request modal + knock cue. Allowing records an admission token (so reconnects skip the gate); denying **IP-bans** them from that room. Casters and already-admitted sessions skip the gate.
- **Vote-to-kick.** Only in public rooms with **3+ votable peers** (humans, non-casters). The threshold is the single pure function `kickThreshold(n)` in `server/src/kick-util.ts`: disabled below 3, otherwise "at least half" (`ceil(n/2)`). Votes are re-evaluated on every vote **and** every membership change, so a departure can tip an already-half-voted target over the line. A kick IP-bans the target and force-disconnects them. Anti-spam rate limiting charges only real vote toggles.

### Accessibility

The core rule: **announcements go to chat.** Every room-event announcement (recording, audio-share, caster, mute/unmute, …) flows through the store's `announceEvent()`, which speaks it on an ARIA live region **and** appends it to chat history as a `system` entry — so chat is a single readable timeline, available later via the panel or the Alt+1..0 readback. Peer join/leave have their own entry kinds; transient per-vote notices use a bare `announce()`.

**Configurable chat announcements.** Chat messages (incoming and the echo of your own) are announced through `announceChat()`, which routes by a persisted per-user preference (`chatAnnounceMode`, set from the Chat panel's "Announce new messages" picker): a **polite** live region (default), an **assertive** one (`role="alert"`), the browser's **speech synthesis** (`client/src/lib/tts.ts` — for users who don't run a screen reader; running both would double-speak), or **off**. The two live regions (`#sr-chat-polite`, `#sr-chat-assertive` in `Room.tsx`) are always mounted; only the one for the active mode is filled.

**Mic-less / text-only participation.** `join()` in `useMediasoup.ts` never blocks on a microphone: the user can opt out ("Join without a microphone" / `?mic=off`), and a missing or denied mic falls back to the same mode rather than throwing. The outgoing track is always `outDest`'s (valid but silent with no mic), so a mic-less peer produces silence and is then paused — appearing to everyone as a normal muted participant — while they listen and use text chat. The store's `hasMic` flag gates the mute control and mic-level slider and shows a "Text only" indicator on their own card.

### Client routing & URL parameters

Two routes: `/` → Lobby, `/room/:roomName` → Room. Supported room URL params:

| Param           | Effect                                                                                  |
| --------------- | --------------------------------------------------------------------------------------- |
| `?p2p=off`      | Pin the SFU even for small rooms (also `false`/`0`/`no`/`disable…`).                    |
| `?public=true`  | List the room publicly (also `1`/`yes`/`on`/`enable…`).                                 |
| `?mic=off`      | Join without a microphone — listen + text chat only (also `false`/`0`/`no`/`disable…`). |
| `?displayName=` | Deep-link past the lobby name prompt.                                                   |
| `?lang=`        | Override the UI language for this session.                                              |

State lives in a single Zustand store (`client/src/stores/room.ts`); mic gain persists to `localStorage`.

### Internationalization (i18n)

UI strings live in `client/messages/{en,es,fr}.json` and are compiled by the inlang Vite plugin into tree-shakeable, type-safe functions under `client/src/paraglide/` (**generated, gitignored, never hand-edit**). Locale resolves in order: `localStorage` (the picker) → browser preference → `en`, with a `?lang=` override applied first. Switching language re-renders the whole tree **in place** — an active call survives a mid-session language change.

**To add a language:** add the code to `client/project.inlang/settings.json`, add `messages/<code>.json` at key parity with `en.json`, and add its native name to `LOCALE_NAMES` in `client/src/lib/i18n.ts`. The picker and detection pick it up automatically.

## HTTP API

Besides the WebSocket signaling, the server exposes a few HTTP endpoints:

| Method & path                        | Purpose                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                        | Liveness check: `{ status, workers }`.                                                                                                 |
| `GET /api/public-rooms`              | Lobby directory of live, publicly-listed rooms and their occupants.                                                                    |
| `POST /api/rooms/:roomName/messages` | Post a chat message into a live room from outside the browser (e.g. Ecobox announcing a now-playing track). Body: `{ text, sender? }`. |
| `GET /api/recordings/:id/download`   | Stream the mixed Ogg/Opus recording.                                                                                                   |
| `GET /api/recordings/:id/tracks`     | Stream per-track recordings as a `.zip`.                                                                                               |

## Commands

```bash
pnpm install            # workspace install (builds the mediasoup worker)
pnpm dev                # server (:3100) + client (:5173) together
pnpm dev:server         # server only
pnpm dev:client         # client only (Vite proxies /socket.io and /api to :3100)
pnpm build              # build the client -> client/dist (server needs no build)
pnpm start              # production: signaling + static client on :3100
pnpm lint               # ESLint across the whole workspace
pnpm format             # Prettier --write (printWidth 100)
pnpm format:check       # Prettier in check mode

pnpm --filter server test                 # server tests (node:test via tsx)
pnpm --filter client exec tsc --noEmit    # typecheck the client
pnpm --filter server exec tsc --noEmit    # typecheck the server (its only type gate)
```

Run a single server test file or test:

```bash
pnpm --filter server exec node --import tsx --test src/recording-util.test.ts
pnpm --filter server exec node --import tsx --test --test-name-pattern="PortAllocator" "src/**/*.test.ts"
```

## Testing

Only the server has tests (`node:test`, run via `tsx`). They cover both the pure helpers (`recording-util`, `chat-util`, `zip-stream`, `streaming-util`, `kick-util`) **and** the stateful managers (`recording`, `streaming`). Each manager takes injected dependencies, so tests drive it with fakes — a fake `spawn` (no real ffmpeg), structural mediasoup objects, and fake clock/timers — asserting on args, SDP, ports, and lifecycle without launching a process or touching real media.

## Deployment & runtime

In production the server runs the signaling **and** serves the built client statically, so a single Node process is all you need.

- A reference setup runs it under systemd as `sonicroom.service` (`ExecStart=/usr/bin/pnpm start`) with `NODE_ENV=production`.
- **Client-only changes need just `pnpm build`** — `express.static(client/dist)` serves the new bundle on the next page load, with no restart and no dropped calls. **Restart the service only for server-code changes** (the server runs TS live via `tsx`).
- ICE is **UDP-only** by design; TCP/TLS fallback is delegated to an external coturn. TURN credentials live in client code intentionally (WebRTC requires them browser-side).

## Ports

| Range / port  | Use                                                             |
| ------------- | --------------------------------------------------------------- |
| `3100`        | HTTP signaling + static client (override with `PORT`).          |
| `5173`        | Vite dev server (development only).                             |
| `40000–40100` | WebRTC media (UDP) — **open on the firewall**.                  |
| `50000–50998` | Recording RTP (loopback only, mediasoup → ffmpeg on 127.0.0.1). |
| `51000–51998` | Icecast-streaming RTP (loopback only).                          |

Only the WebRTC media range and the signaling port need to be reachable; the recording/streaming RTP ranges are local. The only outbound connection that leaves the box is to your Icecast server, if streaming is used.

## Environment variables

The server loads a gitignored `.env` from the repo root at startup (see `.env.example`). All of these are operator-only and never surfaced in the UI; an absent `.env` simply leaves the optional features off.

| Variable                                  | Purpose                                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSTANCE_NAME`                           | Display name of your instance (lobby heading + browser tab). Defaults to `SonicRoom`; change it to rebrand — see [Rename your instance](#rename-your-instance). |
| `PORT`                                    | HTTP/signaling port (default `3100`).                                                                                                                           |
| `ANNOUNCED_IP` / `ANNOUNCED_IP6`          | The VPS public IPv4/IPv6 announced to ICE — **required in production** for media to connect.                                                                    |
| `NODE_ENV`                                | Set to `production` for production runs.                                                                                                                        |
| `NOTY_ENABLED`                            | `true` to enable off-box notifications for public-room activity.                                                                                                |
| `NOTY_HOST` / `NOTY_PORT` / `NOTY_SENDER` | Target and identity for the optional "noty" notification daemon.                                                                                                |

To get started locally: `cp .env.example .env` and edit as needed (the defaults are a no-op).

## Contributing

- **Use pnpm**, never npm — this is a pnpm workspace and npm will break the native builds.
- Before opening a PR, run `pnpm lint`, `pnpm format:check`, the server tests, and the typechecks (the server runs untyped via `tsx`, so `tsc --noEmit` is the only type gate).
- Keep i18n at parity: any new UI string belongs in all of `messages/{en,es,fr}.json`.
- The pure decision functions — `decideMode` (transport) and `kickThreshold` (moderation) — are the single sources of truth for their behavior and are unit-tested; change them there, not at call sites.
- `CLAUDE.md` holds the deeper architectural rationale and gotchas; it's worth a read before larger changes.

## License

No license file is currently included in this repository. Until one is added, all rights are reserved by the authors — open an issue if you need clarification on usage or want to propose a license.
