import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { RateLimiter } from "./chat-util.js";
import { moderationPolicySchema } from "./moderation-util.js";
import { roomNameSchema } from "./signaling/schemas.js";
import {
  buildReservation,
  buildReservationLinks,
  generateHostKey,
  readReservationsFile,
  removeReservation,
  upsertReservation,
  writeReservationsFile,
  type ReservationStore,
} from "./reservations.js";

// Operator admin UI at /admin (+ its JSON API under /api/admin): reserve room
// names for hosts, rotate/remove reservations, and see which rooms are live.
// The same actions as `pnpm reserve`, for operators who'd rather not ssh in.
//
// Gated by ADMIN_UI_PASSWORD in .env: unset = the whole thing is OFF (/admin is
// a 404 like any unknown SPA route, and none of the API routes exist). It is
// deliberately NOT linked from the client — but obscurity is not the gate, the
// password is: login is constant-time, rate-limited per client IP (5 tries a
// minute), and yields an HttpOnly, SameSite=Strict session cookie (a random
// token held in memory — a restart logs everyone out, which is fine) that is
// Secure whenever the request came over HTTPS (directly or via the proxy's
// X-Forwarded-Proto). Mutating routes additionally require a custom header so a
// cross-site form post can't drive them even if a browser ignored SameSite.
// Pages are no-store + noindex.
//
// The reservations file is the one the server's ReservationStore watches, so
// an edit here is live at once (same as the CLI). Under the systemd unit's
// ProtectSystem=strict the file's directory (<repo>/data by default) must be
// listed in ReadWritePaths.

const SESSION_COOKIE = "sonicroom_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
const MUTATION_HEADER = "x-sonicroom-admin";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_PAGE_PATH = path.resolve(here, "admin/index.html");

// --- Pure helpers (unit-tested) ---

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function passwordMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  // Compare fixed-length digests? Not needed: length leak of the configured
  // password is acceptable and the compare is constant-time for equal lengths.
  return a.length === b.length && timingSafeEqual(a, b);
}

// The origin the printed links should use: PUBLIC_URL if configured, else what
// the request came in on (behind the proxy: X-Forwarded-Proto/Host).
export function requestBaseUrl(
  headers: Record<string, string | string[] | undefined>,
  secure: boolean,
  publicUrl?: string,
): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, "");
  const first = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
  const proto = first(headers["x-forwarded-proto"]) || (secure ? "https" : "http");
  const host = first(headers["x-forwarded-host"]) || first(headers["host"]) || "localhost";
  return `${proto}://${host}`;
}

// The client address for bans and rate limits. Only a request arriving from
// loopback (our reverse proxy) has its X-Forwarded-For trusted, and then only
// the RIGHT-most entry — the one the proxy appended. Left-most entries are
// whatever the client sent, so trusting them let a banned user walk back in.
export function clientIpFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  remote: string | undefined,
): string {
  const direct = (remote ?? "").trim();
  const viaProxy = direct === "127.0.0.1" || direct === "::1" || direct === "::ffff:127.0.0.1";
  const xff = headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.join(",") : xff)?.split(",").pop()?.trim();
  return (viaProxy && last) || direct;
}

export class AdminSessions {
  private readonly tokens = new Map<string, number>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = SESSION_TTL_MS,
  ) {}
  create(): string {
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, this.now() + this.ttlMs);
    return token;
  }
  valid(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.tokens.get(token);
    if (exp == null) return false;
    if (exp <= this.now()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }
  revoke(token: string | undefined): void {
    if (token) this.tokens.delete(token);
  }
}

const reserveBodySchema = z.object({
  name: roomNameSchema,
  days: z.number().min(0).max(3650).optional(),
  policy: moderationPolicySchema.optional(),
  note: z.string().trim().max(200).optional(),
});

export interface AdminDeps {
  password: string;
  reservations: ReservationStore;
  filePath: string;
  // Live rooms, for the panel's "who's in" table.
  liveRooms: () => Array<{
    name: string;
    participants: number;
    casters: number;
    isPublic: boolean;
    isVideo: boolean;
    isModerated: boolean;
    mode: string;
  }>;
  publicUrl?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

export function createAdminRouter(deps: AdminDeps): Router {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m) => console.log(m));
  const sessions = new AdminSessions(now);
  const loginLimiter = new RateLimiter(LOGIN_LIMIT, LOGIN_WINDOW_MS);
  const router = Router();

  const isSecure = (req: Request) =>
    req.secure ||
    String(req.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      .trim() === "https";
  const cookieOf = (req: Request) => parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const setCookie = (req: Request, res: Response, token: string | null) => {
    const attrs = [
      `${SESSION_COOKIE}=${token ?? ""}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      token ? `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` : "Max-Age=0",
    ];
    if (isSecure(req)) attrs.push("Secure");
    res.setHeader("Set-Cookie", attrs.join("; "));
  };
  const noStore = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  };
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!sessions.valid(cookieOf(req))) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    next();
  };
  // Cross-site request forgery belt-and-braces: a browser only adds a custom
  // header from same-origin script.
  const requireHeader = (req: Request, res: Response, next: NextFunction) => {
    if (req.headers[MUTATION_HEADER] !== "1") {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    next();
  };

  router.use(noStore);

  router.get("/admin", (_req, res) => {
    res.sendFile(ADMIN_PAGE_PATH);
  });

  router.post("/api/admin/login", requireHeader, (req, res) => {
    const ip = clientIpFromHeaders(req.headers, req.socket.remoteAddress);
    if (!loginLimiter.tryConsume(ip, now())) {
      log(`[admin] login rate-limited for ${ip}`);
      res.status(429).json({ ok: false, error: "rate_limited" });
      return;
    }
    const given = (req.body as { password?: unknown } | undefined)?.password;
    if (!passwordMatches(deps.password, given)) {
      log(`[admin] failed login from ${ip}`);
      res.status(401).json({ ok: false, error: "bad_password" });
      return;
    }
    setCookie(req, res, sessions.create());
    log(`[admin] login from ${ip}`);
    res.json({ ok: true });
  });

  router.post("/api/admin/logout", requireHeader, (req, res) => {
    sessions.revoke(cookieOf(req));
    setCookie(req, res, null);
    res.json({ ok: true });
  });

  router.get("/api/admin/session", (req, res) => {
    if (!sessions.valid(cookieOf(req))) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    res.json({ ok: true });
  });

  // Everything the panel shows: reservations (never the key hashes) + live rooms.
  router.get("/api/admin/state", requireAuth, (req, res) => {
    let file;
    try {
      file = readReservationsFile(deps.filePath);
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
      return;
    }
    const rooms = deps.liveRooms();
    const live = new Set(rooms.map((r) => r.name));
    const t = now();
    const reservations = Object.entries(file.rooms)
      .filter(([, r]) => !r.expiresAt || Date.parse(r.expiresAt) > t)
      .map(([name, r]) => ({
        name,
        createdAt: r.createdAt ?? null,
        expiresAt: r.expiresAt ?? null,
        note: r.note ?? "",
        moderation: r.moderation,
        live: live.has(name),
        publicLink: buildReservationLinks(
          requestBaseUrl(req.headers, isSecure(req), deps.publicUrl),
          name,
          "",
        ).public,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      ok: true,
      file: deps.filePath,
      reservations,
      rooms: rooms.map((r) => ({ ...r, reserved: deps.reservations.has(r.name) })),
    });
  });

  const writeOr500 = (res: Response, fn: () => void): boolean => {
    try {
      fn();
      return true;
    } catch (err) {
      log(`[admin] write failed: ${(err as Error).message}`);
      res.status(500).json({ ok: false, error: `could not write ${deps.filePath}` });
      return false;
    }
  };

  // Reserve (or re-reserve with a fresh key) a name. Returns the host link ONCE.
  router.post("/api/admin/reservations", requireAuth, requireHeader, (req, res) => {
    const parsed = reserveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "bad request" });
      return;
    }
    const { name, days, policy, note } = parsed.data;
    const key = generateHostKey();
    const t = now();
    const reservation = buildReservation({
      hostKey: key,
      moderation: policy ?? {},
      ttlDays: days ?? 30,
      note: note || undefined,
      now: t,
    });
    let replaced = false;
    if (
      !writeOr500(res, () => {
        const file = readReservationsFile(deps.filePath);
        replaced = !!file.rooms[name];
        writeReservationsFile(deps.filePath, upsertReservation(file, name, reservation));
      })
    )
      return;
    log(`[admin] ${replaced ? "re-reserved" : "reserved"} ${name}`);
    res.json({
      ok: true,
      name,
      replaced,
      expiresAt: reservation.expiresAt,
      links: buildReservationLinks(
        requestBaseUrl(req.headers, isSecure(req), deps.publicUrl),
        name,
        key,
      ),
    });
  });

  router.post("/api/admin/reservations/:name/rotate", requireAuth, requireHeader, (req, res) => {
    const name = roomNameSchema.safeParse(req.params.name);
    if (!name.success) {
      res.status(400).json({ ok: false, error: "bad room name" });
      return;
    }
    const key = generateHostKey();
    let found = true;
    if (
      !writeOr500(res, () => {
        const file = readReservationsFile(deps.filePath);
        const existing = file.rooms[name.data];
        if (!existing) {
          found = false;
          return;
        }
        const t = now();
        const ttlDays = existing.expiresAt
          ? Math.max(0, (Date.parse(existing.expiresAt) - t) / 86400e3)
          : null;
        const rotated = buildReservation({
          hostKey: key,
          moderation: existing.moderation,
          ttlDays,
          note: existing.note,
          now: t,
        });
        writeReservationsFile(
          deps.filePath,
          upsertReservation(file, name.data, { ...rotated, createdAt: existing.createdAt }),
        );
      })
    )
      return;
    if (!found) {
      res.status(404).json({ ok: false, error: "not reserved" });
      return;
    }
    log(`[admin] rotated host key for ${name.data}`);
    res.json({
      ok: true,
      name: name.data,
      links: buildReservationLinks(
        requestBaseUrl(req.headers, isSecure(req), deps.publicUrl),
        name.data,
        key,
      ),
    });
  });

  router.delete("/api/admin/reservations/:name", requireAuth, requireHeader, (req, res) => {
    const name = roomNameSchema.safeParse(req.params.name);
    if (!name.success) {
      res.status(400).json({ ok: false, error: "bad room name" });
      return;
    }
    let found = true;
    if (
      !writeOr500(res, () => {
        const file = readReservationsFile(deps.filePath);
        if (!file.rooms[name.data]) {
          found = false;
          return;
        }
        writeReservationsFile(deps.filePath, removeReservation(file, name.data));
      })
    )
      return;
    if (!found) {
      res.status(404).json({ ok: false, error: "not reserved" });
      return;
    }
    log(`[admin] removed reservation for ${name.data}`);
    res.json({ ok: true, name: name.data });
  });

  return router;
}
