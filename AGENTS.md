# AGENTS.md

## Commands

```bash
pnpm install                 # workspace install (builds mediasoup worker)
pnpm dev                     # server (tsx watch :3100) + client (vite :5173)
pnpm dev:server / dev:client # one side only
pnpm build                   # CLIENT only -> client/dist (server has no build)
pnpm start                   # prod: server on :3100 serving client/dist
pnpm lint                    # eslint (flat config)
pnpm format                  # prettier --write (printWidth 100)
pnpm format:check            # prettier CI mode
```

**Single server test:**

```bash
pnpm --filter server exec node --import tsx --test src/recording-util.test.ts
pnpm --filter server exec node --import tsx --test --test-name-pattern="PortAllocator" "src/**/*.test.ts"
```

**Client tests** (vitest, jsdom):

```bash
pnpm --filter client test
```

**Typechecks** (server runs untyped via tsx — tsc is the only type gate):

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter server exec tsc --noEmit
```

**Before opening a PR, run in order:** `pnpm lint` → `pnpm format:check` → `pnpm --filter server test` → `pnpm --filter client test` → typechecks (both above).

## Architecture quick-reference

- **`pnpm` only** — never npm. It's a pnpm workspace; `allowBuilds` in `pnpm-workspace.yaml` trusts esbuild + mediasoup. If `pnpm` breaks with `ERR_PNPM_IGNORED_BUILDS`, restore that file.
- **Server runs TS live** via `tsx` — no compile step. Only `tsc --noEmit` for type-checking.
- **Transport mode** is decided by one pure function `decideMode()` in `server/src/recording-util.ts`. Don't duplicate that logic at call sites.
- **Vote threshold** is `kickThreshold(n)` in `server/src/kick-util.ts` — same pattern.
- **Client audio graph**: single shared `AudioContext`. Outgoing track is always `outDest`'s stream track (never swap on senders/producers across mode switches).
- **i18n**: Paraglide JS compiles `client/messages/{en,es,fr}.json` → `client/src/paraglide/` (generated, gitignored, never hand-edit). Add strings to all three locale files at parity.
- **Client has no `CLAUDE.md`-mentioned tests** but actually does now — vitest + jsdom + `src/test/setup.ts` with Web Audio/WebRTC fakes. Config: `client/vitest.config.ts`.

## Key gotchas

- After `pnpm install`, the mediasoup worker binary can get dropped. If server fails with a worker error, re-run `pnpm install`.
- Client build produces `client/dist/`; server serves it statically via `express.static`. Client-only changes need just `pnpm build`, no server restart.
- Recording/streaming RTP ports (50000–51998) are loopback-only. Only UDP 40000–40100 (WebRTC media) and TCP 3100 need firewall openings.
- `ANNOUNCED_IP` / `ANNOUNCED_IP6` must be set in production or ICE won't connect.
- `maxaveragebitrate: 256000` in `server/src/mediasoup-config.ts` is a **ceiling** — do not lower it to 64000 (that clamps music to voice quality).
- `extraMicConstraints` uses `{ exact: deviceId }` intentionally — changing to `{ ideal }` causes silent aliasing to the default device.

## Files to read first

- `CLAUDE.md` — the deep architectural rationale (read before large changes).
- `README.md` — commands, architecture, deployment reference.
- `server/src/signaling.ts` — room signaling, mode switching, all socket events.
- `server/src/recording-util.ts` — `decideMode()` pure function.
- `client/src/hooks/useMediasoup.ts` — the WebRTC/SFU engine and audio graph.
- `client/src/stores/room.ts` — the single Zustand store.
