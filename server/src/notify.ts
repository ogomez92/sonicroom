import net from "node:net";

// Fire-and-forget notifications to a "noty" daemon — a raw-TCP service that
// speaks notifications aloud (screen-reader / TTS) and pops a system sound.
// Used to ping the operator's home machine whenever a PUBLIC room is created or
// someone joins one, so room activity is audible off-box.
//
// All config lives in .env (NOTY_*), never in the app UI, so it stays hidden
// from users and is trivial to disable. With NOTY_ENABLED unset/false (e.g. no
// .env at all, as in local dev) the whole feature is a no-op.
//
// Wire protocol (see /home/noty README): a single JSON object terminated by a
// newline — { messageTitle, messageUrgency (1 notice | 2 alert | 3 error),
// senderMachine, message? }. The daemon replies {"ok":true}\n then closes; we
// don't need the reply, so we just write the line and half-close.

type Urgency = 1 | 2 | 3;

interface NotyConfig {
  enabled: boolean;
  host: string;
  port: number;
  sender: string;
}

let cached: NotyConfig | null = null;

// Read once, lazily — .env is loaded at startup (see index.ts) before any room
// event can fire, so the first read already sees the configured values.
function config(): NotyConfig {
  if (cached) return cached;
  cached = {
    enabled: /^(1|true|yes|on)$/i.test(process.env.NOTY_ENABLED ?? ""),
    host: process.env.NOTY_HOST || "win.gomsen.com",
    port: parseInt(process.env.NOTY_PORT || "1337", 10),
    sender: process.env.NOTY_SENDER || "sonicroom",
  };
  return cached;
}

function send(title: string, message: string, urgency: Urgency = 1): void {
  const cfg = config();
  if (!cfg.enabled) return;

  const line =
    JSON.stringify({
      messageTitle: title,
      messageUrgency: urgency,
      senderMachine: cfg.sender,
      message,
    }) + "\n";

  // A down/unreachable noty daemon must NEVER affect a room join — open the
  // socket, write the line, and swallow every error (warn only). A short
  // timeout caps a black-holed host so attempts can't pile up.
  const sock = net.createConnection({ host: cfg.host, port: cfg.port });
  sock.setTimeout(4000);
  sock.on("connect", () => sock.end(line));
  sock.on("timeout", () => sock.destroy());
  sock.on("error", (err) =>
    console.warn(`[noty] notify failed: ${err instanceof Error ? err.message : String(err)}`),
  );
}

// A public room came into existence (a fresh room joined as public, or an
// existing private room flipped to public for the first time).
export function notifyPublicRoomCreated(roomName: string, displayName: string): void {
  send("New public room", `${displayName} created public room "${roomName}"`);
}

// Someone joined an already-public room.
export function notifyPublicRoomJoin(
  roomName: string,
  displayName: string,
  peerCount: number,
): void {
  send("Public room join", `${displayName} joined "${roomName}" — ${peerCount} now in room`);
}
