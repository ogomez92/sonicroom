# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SonicRoom — low-latency browser audio conferencing (voice) with hi-fi stereo music casting. pnpm monorepo:

- `client/` — React 19 + Vite + Tailwind v4 + zustand, using `mediasoup-client` and `socket.io-client`.
- `server/` — Express 5 + socket.io + `mediasoup` (SFU) + `zod`. Runs TypeScript **directly via `tsx`** (no build artifact).

**Use pnpm, never npm.** It's a pnpm workspace, and `onlyBuiltDependencies` (in `pnpm-workspace.yaml`) builds esbuild and mediasoup's native worker. Reinstalling/adding deps can purge `node_modules` and drop the prebuilt `mediasoup-worker` binary — if the server then fails with a worker error on startup, run `pnpm install` to rebuild it. Also: `pnpm add` (v11) may write a malformed `allowBuilds:` stub into `pnpm-workspace.yaml` that then breaks every `pnpm` run with `ERR_PNPM_IGNORED_BUILDS` on the deps-status check — **delete that stub** (esbuild/mediasoup are already approved via `onlyBuiltDependencies`).

## Commands

```bash
pnpm install                 # workspace install (builds mediasoup worker)
pnpm dev                     # server (tsx watch :3100) + client (vite :5173) together
pnpm dev:server              # server only
pnpm dev:client              # client only — vite proxies /socket.io and /api to :3100
pnpm build                   # builds the CLIENT only -> client/dist (server needs no build)
pnpm start                   # prod: server runs signaling AND serves client/dist statically
pnpm --filter server test    # server tests (node:test via tsx)
pnpm lint                    # eslint (flat config in eslint.config.mjs, whole workspace)
pnpm format                  # prettier --write (printWidth 100; generated/dist ignored)
pnpm format:check            # prettier in CI/check mode
```

Run a single server test file / single test:

```bash
pnpm --filter server exec node --import tsx --test src/recording-util.test.ts
pnpm --filter server exec node --import tsx --test --test-name-pattern="PortAllocator" "src/**/*.test.ts"
pnpm --filter client exec tsc --noEmit     # typecheck the client
pnpm --filter server exec tsc --noEmit     # typecheck the server (it runs untyped via tsx, so this is the only type gate)
```

Only the server has tests (the client has none). They cover the pure helpers (`recording-util.ts`, `chat-util.ts`, `zip-stream.ts`, `streaming-util.ts`) **and** the stateful managers (`recording.ts`, `streaming.ts`): each manager takes injected deps (`RecordingDeps` / `StreamDeps`) so the tests drive it with fakes — a fake `spawn` (no real ffmpeg), structural mediasoup Router/Transport/Consumer, a fake clock and fake timers — asserting on the args/SDP/ports/lifecycle without launching a process or touching media.

## Architecture

### Hybrid P2P ↔ SFU transport (the core idea)

A room dynamically switches transport based on size and needs. **`decideMode(peerCount, currentMode, forceSfu)` in `server/src/recording-util.ts` is the single, pure source of truth** — both the join and leave handlers in `signaling.ts` re-evaluate through it:

- ≤2 peers → **P2P mesh**: clients connect WebRTC directly; the server only relays signaling (`p2p-signal`). Media never touches the server.
- 3+ peers → **mediasoup SFU**.
- `forceSfu` pins the SFU even with ≤2 peers when the server _must_ see the media: while **recording** (P2P media is invisible to the server), when a **music caster** is present, or when **`?p2p=off`** was set (`shouldForceSfu` in `signaling.ts`).

On transitions the server emits `switch-to-sfu` / `switch-to-p2p`; the client (`useMediasoup.ts`) tears down one transport stack and builds the other. The outgoing audio graph (below) survives the switch — only senders/producers are rebuilt.

### Client audio graph (`client/src/hooks/useMediasoup.ts`)

One module-scoped shared `AudioContext` for the whole session (resumed on first user gesture for iOS).

- **Outgoing**: `mic → micGain → soft limiter → outDest`. The track added to peers / produced to the SFU is **always `outDest`'s stream track**, so tracks are never swapped on senders/producer across mode switches or when sharing audio. Shared system/tab audio (`getDisplayMedia`) is mixed **straight into `outDest`**, bypassing the mic gain/limiter so music keeps its dynamics.
- **Incoming**: per-peer `MediaStreamSource → gainNode → destination`. `effectiveGain(peerId)` composes per-peer volume × deafen × music ducking; every place that changes gain ramps via `setTargetAtTime`.

### Auto-ducking (controlled client-side)

The server's `AudioLevelObserver` watches **voice producers only** — music/caster producers are deliberately never added to it. It emits `duck {active}` on each on/off transition (`wireDucking` in `signaling.ts`). The **client** does the actual gain ramp: music-peer gain → `volume * DUCK_FACTOR` with `DUCK_ATTACK` (voice starts) / `DUCK_RELEASE` (voice stops) time-constants. Ecobox/the caster just sends raw stereo; ducking timing lives in the client constants, not the caster.

### Music caster (Ecobox)

A send-only "music caster" peer joins with `role: "caster"` (see `joinSchema`). It produces a stereo track but never consumes or sets up P2P, so its presence forces the room onto the SFU. Voice self-limits to **mono 64 kbps** (`forceOpusParams` in `client/src/lib/sdp-munger.ts`, plus `opusStereo:false` on produce). The router's `maxaveragebitrate: 256000` (`mediasoup-config.ts`) is a **ceiling** that lets the stereo caster negotiate hi-fi — **do not lower it to 64000**, that silently clamps music to voice quality.

### Server-side recording (`server/src/recording.ts` + `recording-util.ts`)

Recording is server-side and forces SFU. Per producer: a mediasoup `PlainTransport` pushes RTP to a local UDP port (`PortAllocator` hands out P/P+1 pairs since ffmpeg also opens an RTCP socket at port+1) where an ffmpeg process captures it to a streamable Ogg/Opus file with `-c:a copy` (no re-encode). The download endpoint (`/api/recordings/:id/download`) spawns a **second** ffmpeg that `amix`es all captures (with `adelay` to align late joiners, `normalize=0`) and streams to HTTP `pipe:1` — captures keep running, never interrupted. Recordings are keyed by a `recordingId` capability token, not room name. `RecordingManager` takes injected `RecordingDeps` so the logic is unit-testable without real ffmpeg/mediasoup.

### Live Icecast streaming (`server/src/streaming.ts` + `streaming-util.ts`)

`StreamManager` mirrors `RecordingManager` and is **independent of it** — both tap the SFU with their own consumers, so a room can record, stream, both, or neither. It also forces SFU. Per producer it has its own `PlainTransport`+consumer → local UDP port (its own `PortAllocator`, range **51000–51998**, distinct from recording's). One **live mixer ffmpeg per room** reads every active producer's RTP (via SDP files), `amix`es them (`normalize=0`) and pushes to `icecast://user:pass@host:port/mount` (`-c:a libmp3lame`/`-f mp3` or `libopus`/`-f ogg`). A permanent silent stereo **anchor** (`anullsrc`) keeps the Icecast source alive (streaming silence) when there are zero active producers. The Icecast target is supplied by whoever starts streaming (in-call **Streaming** settings panel, persisted in `localStorage`), validated by `icecastConfigSchema`, sent on `start-streaming`, and **never broadcast** — only `streaming-started { by }` / `streaming-stopped` / `streaming-failed` go to the room (state is room-wide, like recording: a `LIVE` badge + `announceEvent`).

Key constraint: a **paused** producer (peer muted) sends no RTP and would stall `amix`, so the mixer is **rebuilt** (debounced, `rebuildDebounceMs`) whenever the _active_ producer set changes — join/leave/share/mute/unmute (`addProducer`/`removeProducer`/`setProducerActive`, wired in `signaling.ts`). Each rebuild kills+respawns the mixer, i.e. a brief Icecast source reconnect; configure an Icecast `<fallback-mount>` for seamless listening. `StreamManager` takes injected `StreamDeps` (reuses recording's structural mediasoup/process interfaces) so it's unit-testable without real ffmpeg/mediasoup.

### Screen-reader announcements (rule: announcements go to chat)

Every room-**event** announcement (recording start/stop, audio-share start/stop, music caster start/stop, mute/unmute, …) must go through the store's `announceEvent()`, which speaks it on the ARIA live region in `Room.tsx` **and** appends it to the chat history as a `kind: "system"` entry — chat is the single timeline of everything announced, readable later via the panel or the Alt+1..0 readback. Peer join/leave keeps its dedicated `kind: "join"/"leave"` entries (localized at render time; `system` entries snapshot the locale active at event time). Bare `announce()` is reserved for re-reading chat content that is already in history: the incoming `chat-message` announcement (which appends a one-time Alt+number hint on the session's first message) and the Alt+number readback itself.

### Public rooms & moderation (knock-to-join, vote-to-kick)

A room is **private by default** and **sticky-public** once any joiner sets it (`isPublic`, via the lobby's "Make this room public" toggle / `?public=true`). Public rooms are listed in the lobby (`getPublicRooms`) and ping the operator's off-box notify daemon on activity (`notify.ts`, target hidden in `.env`). There are **no moderators** — admission and removal are collective:

- **Knock-to-join.** A newcomer to an already-public, occupied room is held in `room.pendingJoins` (keyed by socket id) and gets `{status:"pending"}`; participants see a modal (`JoinRequests.tsx`) + looping knock cue and `join-decision {requestId, allow}`. Allow records an `admittedToken`/`admittedName` (so a reconnect/return skips the gate) and pushes `join-approved`; **deny IP-bans them from this room** (`bannedIps`, checked first on every join) and pushes `join-denied`. Casters and already-admitted sessions skip the gate. The flip private→public broadcasts `room-public` so people already inside update.
- **Vote-to-kick.** Only in public rooms, and only with **3+ votable peers** (humans — non-casters; the target is counted). **`kickThreshold(n)` in `server/src/kick-util.ts` is the single, pure source of truth** (unit-tested): `Infinity` for n<3 (disabled — same as a private room, so no one can be removed unilaterally), else `ceil(n/2)` ("at least half": 3→2, 4→2, 5→3). Votes live in `room.kickVotes` (target peerId → set of voter ids). `vote-kick {targetId, vote}` toggles and broadcasts `kick-vote` to the whole room (incl. the voter — server is authoritative, the client never updates optimistically); `settleKicks` then removes anyone at threshold. **Re-evaluated on every vote AND every membership change** — a leaver shrinks the room and can tip an already-half-voted target over the line. A kick reuses the deny path: room-ban the IP (`bannedIps`), `peer-kicked` to the room + `you-were-kicked` to the target, then `teardownPeer` + force-disconnect (a server-initiated disconnect doesn't auto-reconnect; the client shows a "removed" screen via the `kicked` store flag). `teardownPeer` is the **shared leave/kick path** (the disconnect handler routes through it too); `cleanupKickVotes` drops a departed peer's votes and recounts. Anti-spam: a dedicated `RateLimiter` where **only real toggles cost a slot** (redundant re-vote / empty withdraw is a silent no-op).
- **Client/UI.** Gated on `roomIsPublic && votableCount >= 3` (seeded from the join response + the `room-public` event). The per-peer button (`ParticipantCard.tsx`) uses **`aria-pressed`** for *your* vote and carries the running tally in its accessible name ("Kick {name} (2 votes)"); the card uses **`aria-selected`** when a peer has any votes against them. Per-vote announcements ("X voted to kick Y" / "…withdrew…") are **bare `announce()`** (transient, like mute); the kick itself goes through **`announceEvent()`** (logged to chat, like recording).

### Client routing

Two routes (`client/src/main.tsx`): `/` → `Lobby`, `/room/:roomName` → `Room`. Room URL params: `?p2p=off` (also false/0/no/disable/disabled) pins SFU; `?public=true` (also 1/yes/on/enable/enabled/public) lists the room publicly; `?displayName=…` deep-links past the lobby name prompt; `?lang=` overrides the UI language (see i18n below). State lives in a single zustand store (`client/src/stores/room.ts`); mic gain persists to localStorage. The room name is reflected into `document.title` from the `Room` component.

### Localization / i18n (Paraglide JS)

UI strings live in `client/messages/{en,es,fr}.json` (flat key→string, `{var}` interpolation). The **inlang Vite plugin** (`paraglideVitePlugin` in `vite.config.ts`) compiles them into tree-shakeable, type-safe functions under `client/src/paraglide/` — **generated, gitignored, never hand-edit** (regenerated on every `pnpm dev`/`pnpm build`; or `pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide`). `tsconfig` has `allowJs` on so `tsc` reads the JSDoc-typed output. Import message functions from `../paraglide/messages.js` (`m.some_key(...)` or named exports) and call them at render/event time — they read the active locale, so they work in non-React code too.

- **Locale resolution** (`strategy` in `vite.config.ts`, first hit wins): `localStorage` (the picker's choice) → `preferredLanguage` (browser) → `baseLocale` (`en`). On top of that, a **`?lang=` override** is applied imperatively in `client/src/lib/i18n.ts` _before_ anything reads the locale (so the store/`main.tsx` import `i18n` to force that ordering), then persisted.
- **Switch without reload**: the locale is mirrored in the store (`locale` + `setLanguage`, which calls Paraglide's `setLocale(…, { reload: false })`). `<App>` in `main.tsx` subscribes to `locale` so a change re-renders the whole tree **in place** — every `m.*()` re-evaluates, but nothing remounts, so an active call survives a mid-session language switch. `setLanguage` also updates `<html lang>`.
- Non-component strings are localized via the same functions: SR announcements in `useMediasoup.ts`, and `client/src/lib/chat.ts` (`formatMessage` stays the single source for both the visible message and its ARIA announcement; `relativeTime` builds a per-locale `Intl.RelativeTimeFormat`).
- **Add a language**: add the code to `locales` in `client/project.inlang/settings.json`, add `messages/<code>.json` (keys at parity with `en.json`), and add its native name to `LOCALE_NAMES` in `client/src/lib/i18n.ts`. The picker (`LanguageSelect`) and detection pick it up automatically.

## Deployment / runtime

- Runs under systemd as **`sonicroom.service`** (`ExecStart=/usr/bin/pnpm start`, `WorkingDirectory=/home/sonicroom`). Env: `PORT` (3100), `ANNOUNCED_IP` / `ANNOUNCED_IP6` (the VPS public IPs — required for ICE), `NODE_ENV=production`, optional `INSTANCE_NAME` (rebrands the app title — injected into the served `index.html` at runtime, read client-side via `getInstanceName()` in `client/src/lib/branding.ts`, so no rebuild). Restart with `systemctl restart sonicroom`.
- **Client changes need only `pnpm build`** — `express.static(client/dist)` serves the new bundle on the next page load, so no server restart and no dropped calls. **Restart the service only for server-code changes** (server runs TS live via tsx).
- Ports: WebRTC media UDP **40000–40100**; recording RTP **50000–50998**; Icecast-streaming RTP **51000–51998**. (The recording/streaming RTP ranges are loopback-only — mediasoup→ffmpeg on 127.0.0.1 — so no firewall change; only the outbound Icecast connection leaves the box.) ICE is **UDP-only** by design; TCP/TLS fallback is handled by an external coturn (`turn.oriolgomez.com`). TURN credentials are in client code intentionally (WebRTC requires them browser-side).
