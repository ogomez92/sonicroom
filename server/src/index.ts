import express from "express";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createWorker } from "mediasoup";
import type { Worker } from "mediasoup/types";
import { workerSettings, numWorkers } from "./mediasoup-config.js";
import { setWorkers, getPublicRooms } from "./room-manager.js";
import { createSignalingServer } from "./signaling.js";
import { RecordingManager, type SpawnedProcess } from "./recording.js";
import { StreamManager } from "./streaming.js";
import { createZipStream } from "./zip-stream.js";
import {
  assertPublicAudioUrl,
  classifyLibraryEntries,
  fetchPublicAudio,
  isAudioContentType,
  isAudioFileName,
  looksLikeStreamContentType,
  resolveLibraryPath,
  streamFallbackAudio,
  TranscodeBusyError,
} from "./audio-sources.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load local secrets/config from the repo-root .env (NOTY_* notification target,
// etc.) before anything reads process.env. tsx/Node don't auto-load it, and it's
// gitignored + hidden from the app UI on purpose; an absent file is fine (the
// .env-gated features simply stay off). Resolved from this file, not cwd, since
// `pnpm --filter server start` runs with the server package as cwd.
try {
  process.loadEnvFile(path.resolve(__dirname, "../../.env"));
} catch {
  /* no .env present — fine */
}

const PORT = parseInt(process.env.PORT || "3100", 10);
const AUDIO_LIBRARY_DIR = process.env.AUDIO_LIBRARY_DIR || "/var/lib/sonicroom/media";

// Display name of this instance, shown as the app title (lobby heading + browser
// tab). Operators rebrand a deployment by setting INSTANCE_NAME in .env; it's
// injected into the served index.html at runtime (see below), so a pre-built
// client is rebranded without a rebuild. Defaults to "SonicRoom".
const INSTANCE_NAME = process.env.INSTANCE_NAME?.trim() || "SonicRoom";

async function main() {
  // Create mediasoup workers
  const workers: Worker[] = [];
  for (let i = 0; i < numWorkers; i++) {
    const worker = await createWorker(workerSettings);
    worker.on("died", () => {
      console.error(`Worker ${worker.pid} died, exiting...`);
      process.exit(1);
    });
    workers.push(worker);
  }
  setWorkers(workers);
  console.log(`Created ${workers.length} mediasoup worker(s)`);

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const httpServer = createServer(app);

  const recordingManager = new RecordingManager();
  const streamManager = new StreamManager();
  const { postChatMessage } = createSignalingServer(httpServer, recordingManager, streamManager);
  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", workers: workers.length });
  });

  // Post a chat message into a live room from outside the browser (e.g. Ecobox
  // announcing the now-playing track). Body: { text, sender? }. Rate-limited
  // and validated identically to an in-room peer; 404 if the room isn't live.
  app.post("/api/rooms/:roomName/messages", (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown; sender?: unknown };
    if (typeof body.text !== "string") {
      res.status(400).json({ error: "Body must include a string `text`" });
      return;
    }
    const sender = typeof body.sender === "string" ? body.sender : "System";
    const result = postChatMessage(req.params.roomName, sender, body.text);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({ ok: true, message: result.message });
  });

  // Public room directory for the lobby: the live, publicly-listed rooms and who
  // is currently in each. Private rooms are never included. Polled by the lobby
  // (the visitor isn't connected to a socket yet), so it's a plain GET.
  app.get("/api/public-rooms", (_req, res) => {
    res.json({ rooms: getPublicRooms() });
  });

  // Audio sources for the in-call music/file streamer. The library is a
  // browsable tree of folders + audio files under AUDIO_LIBRARY_DIR; URL
  // playback goes through the same-origin proxy below so Web Audio can consume
  // sources whose origin does not provide CORS headers. `?path=` is a relative
  // subfolder, validated by resolveLibraryPath (no traversal out of the root).
  app.get("/api/audio-library", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const resolved = resolveLibraryPath(AUDIO_LIBRARY_DIR, rel);
    if (!resolved) {
      res.status(400).json({ error: "Invalid library path" });
      return;
    }
    try {
      const dirents = await readdir(resolved.abs, { withFileTypes: true });
      const entries = classifyLibraryEntries(
        dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile() })),
      );
      res.json({ path: resolved.rel, entries });
    } catch (err) {
      // An absent/unconfigured library dir is the common case (the default
      // /var/lib/sonicroom/media may not exist) — report it as empty rather
      // than an error so the picker just shows "no server files".
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.json({ path: resolved.rel, entries: [] });
        return;
      }
      console.error(`[audio-library] list failed: ${String(err)}`);
      res.status(500).json({ error: "Could not list server audio files" });
    }
  });

  // Serve one library file. `?path=` is the relative path (may include
  // subfolders), validated the same way and required to name an audio file.
  app.get("/api/audio-library/file", (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const resolved = resolveLibraryPath(AUDIO_LIBRARY_DIR, rel);
    if (!resolved || resolved.rel === "" || !isAudioFileName(path.basename(resolved.rel))) {
      res.status(404).json({ error: "Audio file not found" });
      return;
    }
    res.sendFile(resolved.rel, { root: AUDIO_LIBRARY_DIR, dotfiles: "deny" }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Audio file not found" });
    });
  });

  app.get("/api/audio-proxy", async (req, res) => {
    const raw = typeof req.query.url === "string" ? req.query.url : "";
    if (!raw) {
      res.status(400).json({ error: "Missing audio URL" });
      return;
    }

    // Validate up front: blocks private/SSRF targets for both the direct proxy
    // and the yt-dlp fallback, and gives a clean 400 for an unusable URL.
    try {
      await assertPublicAudioUrl(raw);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Audio URL failed" });
      return;
    }

    // Whether the failed direct fetch looked like a media stream (IPTV/HLS/DASH/
    // octet-stream) rather than a web page — routes the fallback to ffmpeg first.
    let preferFfmpeg = false;

    // 1) Direct path: a plain audio file or Icecast/HTTP radio stream. Kept for
    //    these because it preserves Range requests (seeking) with no transcode.
    try {
      const upstream = await fetchPublicAudio(raw, req.headers.range);
      const status = upstream.statusCode ?? 502;
      const contentType = upstream.headers["content-type"] || "";
      if (status >= 200 && status < 300 && isAudioContentType(contentType)) {
        res.status(status);
        res.setHeader("Content-Type", contentType);
        for (const header of [
          "accept-ranges",
          "content-length",
          "content-range",
          "icy-br",
          "icy-name",
        ]) {
          const value = upstream.headers[header];
          if (value) res.setHeader(header, value);
        }
        res.on("close", () => upstream.destroy());
        upstream.on("error", (err) => {
          console.error(`[audio-proxy] stream failed: ${String(err)}`);
          res.destroy(err);
        });
        upstream.pipe(res);
        return;
      }
      // Not directly playable (an HTML page, a player redirect, a hotlink block,
      // an IPTV `.ts`/octet-stream, …) — fall through to the transcoder. Note
      // whether it smelled like a media stream so the fallback prefers ffmpeg.
      preferFfmpeg = looksLikeStreamContentType(contentType);
      upstream.destroy();
    } catch (err) {
      console.error(`[audio-proxy] direct fetch failed, trying transcode fallback: ${String(err)}`);
    }

    // 2) Fallback: transcode to a progressive Opus/WebM stream the <audio>
    //    element can play. Direct media streams (IPTV `.ts`, HLS, DASH) go
    //    through ffmpeg; sites (YouTube, SoundCloud, …) through yt-dlp. No Range
    //    support here — it's a live transcode.
    try {
      const extracted = await streamFallbackAudio(raw, { preferFfmpeg });
      res.status(200);
      res.setHeader("Content-Type", extracted.contentType);
      res.setHeader("Cache-Control", "no-store");
      res.on("close", () => extracted.destroy());
      extracted.stream.on("error", (err) => {
        console.error(`[audio-proxy] transcode stream failed: ${String(err)}`);
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      });
      extracted.stream.pipe(res);
    } catch (err) {
      console.error(`[audio-proxy] transcode fallback failed: ${String(err)}`);
      if (!res.headersSent) {
        // Slot exhaustion is transient (503 + Retry-After); anything else is an
        // upstream/extraction failure for this URL (502).
        if (err instanceof TranscodeBusyError) {
          res.setHeader("Retry-After", "5");
          res.status(503).json({ error: "Server busy transcoding audio, try again shortly" });
        } else {
          res.status(502).json({ error: "Could not get audio from that URL" });
        }
      } else {
        res.destroy();
      }
    }
  });

  // Recording download — mixes all participants' captured audio into a single
  // Ogg/Opus file and streams it. Works at any time while recording continues;
  // the capture processes are never interrupted. Keyed by the recording id
  // (a capability token handed to clients), not the room name.
  app.get("/api/recordings/:id/download", (req, res) => {
    const proc = recordingManager.mixByRecordingId(req.params.id);
    if (!proc || !proc.stdout) {
      res.status(404).json({ error: "No active recording with that id, or nothing captured yet" });
      return;
    }
    res.setHeader("Content-Type", "audio/ogg");
    res.setHeader("Content-Disposition", `attachment; filename="sonicroom-${req.params.id}.ogg"`);

    proc.stderr?.on("data", (d: Buffer) => console.error(`[mix] ${d.toString().trim()}`));
    proc.stdout.pipe(res);

    // If the client aborts the download, kill the mixing ffmpeg.
    const kill = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    res.on("close", kill);
    proc.on("exit", (code) => {
      if (code) console.error(`[mix] ffmpeg exited with code ${code}`);
    });
  });

  // Per-track download — packs each participant's captured audio into its own
  // file inside one streamed .zip (no mixing). Each track is padded to the full
  // recording span: leading silence equal to its start offset + trailing
  // silence to a shared length, so the unzipped files are all the same length
  // and aligned on the same time boundaries (drop them straight into a DAW).
  // Includes tracks whose peer already left, since their captures are kept on
  // disk. Like the mix above, works while still recording and never interrupts
  // the live captures (the padding ffmpeg only reads each capture file).
  app.get("/api/recordings/:id/tracks", (req, res) => {
    const tracks = recordingManager.paddedTracksByRecordingId(req.params.id);
    if (!tracks || tracks.length === 0) {
      res.status(404).json({ error: "No recording with that id, or nothing captured yet" });
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="sonicroom-${req.params.id}-tracks.zip"`,
    );

    // The zip streams entries one at a time, so at most one padding ffmpeg runs
    // at once. Track them so we can kill the in-flight one if the client aborts.
    const procs: SpawnedProcess[] = [];
    const killProcs = () => {
      for (const p of procs) {
        try {
          p.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    };

    const zip = createZipStream(
      tracks.map((t) => ({
        name: t.name,
        open: () => {
          const proc = recordingManager.spawnPaddedTrack(t);
          procs.push(proc);
          proc.stderr?.on("data", (d: Buffer) => console.error(`[tracks] ${d.toString().trim()}`));
          if (!proc.stdout) throw new Error(`ffmpeg produced no stdout for track ${t.name}`);
          return proc.stdout;
        },
      })),
    );
    zip.on("error", (err) => {
      console.error(`[tracks] zip error: ${String(err)}`);
      killProcs();
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    });
    // If the client aborts the download, stop the zip and the live ffmpeg.
    res.on("close", () => {
      zip.destroy();
      killProcs();
    });
    zip.pipe(res);
  });

  // Serve built client in production. Hashed assets (JS/CSS) are served
  // statically, but NOT index.html (`index: false`) — every page / SPA-route
  // request falls through to the handler below, which injects this instance's
  // runtime config into the HTML.
  const clientDist = path.resolve(__dirname, "../../client/dist");
  const indexHtmlPath = path.join(clientDist, "index.html");
  app.use(express.static(clientDist, { index: false }));

  // Inject the operator-configurable instance name into the served index.html so
  // the pre-built static client can be rebranded via INSTANCE_NAME in .env with
  // no rebuild: an inline config script the client reads before it mounts (see
  // client/src/lib/branding.ts), plus the static <title>. Read fresh per request
  // (not cached) so a client-only `pnpm build` — which changes the asset hashes
  // referenced in index.html — is picked up on the next load without a restart.
  const renderIndexHtml = (): string | null => {
    let html: string;
    try {
      html = readFileSync(indexHtmlPath, "utf8");
    } catch {
      return null; // client not built yet
    }
    // JS object literal; escape "<" so a name containing "</script>" can't break
    // out of the inline <script>. Injected right after <head> so it runs before
    // the (deferred) app bundle.
    const configJson = JSON.stringify({ instanceName: INSTANCE_NAME }).replace(/</g, "\\u003c");
    html = html.replace(
      "<head>",
      `<head><script>window.__SONICROOM_CONFIG__=${configJson};</script>`,
    );
    const safeTitle = INSTANCE_NAME.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`);
    return html;
  };

  app.get("/{*splat}", (_req, res) => {
    const html = renderIndexHtml();
    if (html == null) {
      res.status(404).type("text/plain").send("Client not built. Run `pnpm build`.");
      return;
    }
    res.type("html").send(html);
  });

  httpServer.listen(PORT, () => {
    console.log(`SonicRoom server listening on port ${PORT}`);
  });

  // Clean up recordings and live streams (ffmpeg processes, temp files) on
  // shutdown.
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, cleaning up recordings and streams...`);
    Promise.allSettled([recordingManager.stopAll(), streamManager.stopAll()]).finally(() =>
      process.exit(0),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
