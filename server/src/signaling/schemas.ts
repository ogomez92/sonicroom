import { z } from "zod";
import { CHAT_TEXT_MAX } from "../chat-util.js";

// --- Validation schemas ---
export const roomNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "Room name must be alphanumeric, hyphens, or underscores");

export const displayNameSchema = z
  .string()
  .min(1)
  .max(256)
  .transform((s) => s.replace(/[<>"'&]/g, ""));

// A chat message body: trimmed, non-empty, capped. React escapes it on render
// and it's only ever used as text content (list + ARIA announcement), so the
// content itself isn't sanitized beyond trimming/length.
export const chatTextSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "Message is empty").max(CHAT_TEXT_MAX));

// Icecast target supplied by whoever starts streaming. Host/mount are charset-
// restricted so the icecast:// URL stays well-formed (the password/username are
// percent-encoded in buildIcecastUrl, so they may contain anything). The config
// is only ever used to start the server's own ffmpeg — it's never broadcast to
// other peers (the password would leak), only `streaming-started { by }` is.
export const icecastConfigSchema = z.object({
  host: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9.-]+$/, "Host must be a hostname or IPv4 address"),
  port: z.number().int().min(1).max(65535),
  mount: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\/?[a-zA-Z0-9._/-]+$/, "Invalid mount point")
    .transform((m) => (m.startsWith("/") ? m : `/${m}`)),
  username: z.string().min(1).max(128).default("source"),
  password: z.string().min(1).max(256),
  format: z.enum(["mp3", "opus"]).default("mp3"),
  bitrateKbps: z.number().int().min(32).max(320).default(160),
  name: z.string().max(128).optional(),
});

export const joinSchema = z.object({
  roomName: roomNameSchema,
  displayName: displayNameSchema,
  // A "caster" is a send-only media source (e.g. Ecobox streaming music). It
  // produces a stereo track but never consumes or sets up P2P, so its presence
  // forces the room onto the SFU.
  role: z.enum(["caster"]).optional(),
  // Explicitly disable P2P for this room (the `?p2p=off` room URL param). Pins
  // the room to the SFU even with <=2 peers; sticky once any joiner sets it.
  disableP2p: z.boolean().optional(),
  // List this room publicly in the lobby (the "Make this room public" toggle /
  // `?public=true` URL param). Off by default; sticky once any joiner sets it.
  isPublic: z.boolean().optional(),
  // Set on a reconnect if this peer was sharing audio when it dropped, so the
  // server re-pins SFU for the rejoin (the share producer is rebuilt right
  // after, in setupSfu). On a first join it's always false.
  sharing: z.boolean().optional(),
  // Same as `sharing`, but for an in-progress local-file stream: re-pins SFU on
  // a reconnect so the "file" producer rebuilds. Always false on a first join.
  fileStreaming: z.boolean().optional(),
  // Same as `sharing`, but for in-progress extra-microphone streams: re-pins SFU
  // on a reconnect so the "mic" producer(s) rebuild. Always false on a first join.
  extraMic: z.boolean().optional(),
  // Per-session, per-room random token the client persists (sessionStorage).
  // Identifies an already-admitted session so a reconnect/refresh skips the
  // knock gate, and is what an approval records as "admitted".
  joinToken: z.string().min(1).max(128).optional(),
});
