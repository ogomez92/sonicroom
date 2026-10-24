import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";
import {
  AdminSessions,
  clientIpFromHeaders,
  createAdminRouter,
  parseCookies,
  passwordMatches,
  requestBaseUrl,
} from "./admin.js";
import { ReservationStore, verifyHostKey, readReservationsFile } from "./reservations.js";

describe("admin helpers", () => {
  it("parseCookies", () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies("a=1; sonicroom_admin=tok%20x; junk"), {
      a: "1",
      sonicroom_admin: "tok x",
    });
  });

  it("passwordMatches is exact and type-safe", () => {
    assert.equal(passwordMatches("s3cret", "s3cret"), true);
    assert.equal(passwordMatches("s3cret", "s3cre"), false);
    assert.equal(passwordMatches("s3cret", "s3cret "), false);
    assert.equal(passwordMatches("s3cret", 42), false);
    assert.equal(passwordMatches("s3cret", undefined), false);
  });

  it("requestBaseUrl prefers PUBLIC_URL, then the proxy headers, then the socket", () => {
    assert.equal(
      requestBaseUrl({ host: "x" }, false, "https://meet.example/"),
      "https://meet.example",
    );
    assert.equal(
      requestBaseUrl(
        {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "meet.example",
          host: "127.0.0.1:3100",
        },
        false,
      ),
      "https://meet.example",
    );
    assert.equal(requestBaseUrl({ host: "localhost:3100" }, false), "http://localhost:3100");
    assert.equal(requestBaseUrl({ host: "localhost:3100" }, true), "https://localhost:3100");
    assert.equal(requestBaseUrl({}, false), "http://localhost");
  });

  it("clientIpFromHeaders trusts only the proxy-appended (right-most) address", () => {
    // nginx appends the real client after anything the client sent itself.
    assert.equal(
      clientIpFromHeaders({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }, "127.0.0.1"),
      "1.2.3.4",
    );
    // Not from our proxy: the header is the client's own claim — ignore it.
    assert.equal(clientIpFromHeaders({ "x-forwarded-for": "6.6.6.6" }, "5.5.5.5"), "5.5.5.5");
    assert.equal(clientIpFromHeaders({}, "127.0.0.1"), "127.0.0.1");
  });

  it("AdminSessions expire and can be revoked", () => {
    let now = 1000;
    const s = new AdminSessions(() => now, 100);
    const t = s.create();
    assert.equal(s.valid(t), true);
    assert.equal(s.valid("nope"), false);
    assert.equal(s.valid(undefined), false);
    now = 1099;
    assert.equal(s.valid(t), true);
    now = 1100;
    assert.equal(s.valid(t), false);
    const t2 = s.create();
    s.revoke(t2);
    assert.equal(s.valid(t2), false);
  });
});

describe("admin router (HTTP)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sonicroom-admin-"));
  const file = path.join(dir, "reservations.json");
  const logs: string[] = [];
  let now = Date.parse("2026-09-15T12:00:00Z");
  let server: Server;
  let base: string;
  const liveRooms: Parameters<typeof createAdminRouter>[0]["liveRooms"] = () => [
    {
      name: "studio",
      participants: 2,
      casters: 1,
      isPublic: false,
      isVideo: false,
      isModerated: true,
      mode: "sfu",
    },
  ];

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      createAdminRouter({
        password: "hunter2",
        reservations: new ReservationStore(
          file,
          () => now,
          () => {},
        ),
        filePath: file,
        liveRooms,
        now: () => now,
        log: (m) => logs.push(m),
      }),
    );
    app.get("/{*splat}", (_req, res) => {
      res.status(200).send("SPA");
    });
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const H = { "content-type": "application/json", "x-sonicroom-admin": "1" };
  let cookie = "";
  const call = (method: string, url: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(base + url, {
      method,
      headers: { ...H, ...(cookie ? { cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("serves the page (no-store, noindex)", async () => {
    const res = await fetch(base + "/admin");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.match(await res.text(), /SonicRoom admin/);
  });

  it("refuses the API without a session", async () => {
    assert.equal((await call("GET", "/api/admin/state")).status, 401);
    assert.equal((await call("GET", "/api/admin/session")).status, 401);
    assert.equal((await call("POST", "/api/admin/reservations", { name: "x" })).status, 401);
  });

  it("refuses a login without the custom header, then a wrong password", async () => {
    const noHeader = await fetch(base + "/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    assert.equal(noHeader.status, 403);
    const wrong = await call("POST", "/api/admin/login", { password: "nope" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);
  });

  it("logs in and sets an HttpOnly SameSite=Strict cookie (Secure behind https)", async () => {
    const res = await call("POST", "/api/admin/login", { password: "hunter2" });
    assert.equal(res.status, 200);
    const sc = res.headers.get("set-cookie") ?? "";
    assert.match(
      sc,
      /^sonicroom_admin=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/,
    );
    cookie = sc.split(";")[0];
    assert.equal((await call("GET", "/api/admin/session")).status, 200);

    const viaProxy = await call(
      "POST",
      "/api/admin/login",
      { password: "hunter2" },
      { "x-forwarded-proto": "https" },
    );
    assert.match(viaProxy.headers.get("set-cookie") ?? "", /; Secure$/);
  });

  it("rate-limits logins per client IP", async () => {
    const ip = { "x-forwarded-for": "9.9.9.9" };
    for (let i = 0; i < 5; i++) {
      assert.equal((await call("POST", "/api/admin/login", { password: "nope" }, ip)).status, 401);
    }
    assert.equal((await call("POST", "/api/admin/login", { password: "hunter2" }, ip)).status, 429);
    now += 60_001;
    assert.equal((await call("POST", "/api/admin/login", { password: "hunter2" }, ip)).status, 200);
  });

  it("reserves a room: writes the file, returns the links once, and lists it", async () => {
    const res = await call(
      "POST",
      "/api/admin/reservations",
      { name: "Studio", days: 7, note: "Ana", policy: { chat: "admins" } },
      { "x-forwarded-proto": "https", "x-forwarded-host": "meet.example" },
    );
    assert.equal(res.status, 200);
    const out = (await res.json()) as {
      name: string;
      replaced: boolean;
      expiresAt: string;
      links: { host: string; public: string };
    };
    assert.equal(out.name, "studio");
    assert.equal(out.replaced, false);
    assert.equal(out.expiresAt, new Date(now + 7 * 86400e3).toISOString());
    assert.equal(out.links.public, "https://meet.example/room/studio");
    assert.match(out.links.host, /^https:\/\/meet\.example\/room\/studio\?host=[A-Za-z0-9_-]{32}$/);
    const key = out.links.host.split("host=")[1];
    const stored = readReservationsFile(file).rooms.studio;
    assert.ok(stored);
    assert.equal(verifyHostKey(stored, key), true);
    assert.equal(stored.moderation.chat, "admins");
    assert.equal(stored.note, "Ana");
    assert.equal(readFileSync(file, "utf8").includes(key), false);

    const state = (await (await call("GET", "/api/admin/state")).json()) as {
      reservations: Array<{ name: string; live: boolean; note: string; publicLink: string }>;
      rooms: Array<{ name: string; reserved: boolean }>;
    };
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].name, "studio");
    assert.equal(state.reservations[0].live, true);
    assert.equal(state.reservations[0].note, "Ana");
    assert.equal(state.rooms[0].reserved, true);
    assert.equal(JSON.stringify(state).includes("hostKeyHash"), false);
  });

  it("rejects a bad name / policy, and a mutation without the header", async () => {
    assert.equal((await call("POST", "/api/admin/reservations", { name: "bad name" })).status, 400);
    assert.equal(
      (await call("POST", "/api/admin/reservations", { name: "ok", policy: { chat: "maybe" } }))
        .status,
      400,
    );
    const noHeader = await fetch(base + "/api/admin/reservations", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "ok" }),
    });
    assert.equal(noHeader.status, 403);
  });

  it("rotates the key (old one dies, policy/note kept) and removes", async () => {
    const before = readReservationsFile(file).rooms.studio;
    const rot = await call("POST", "/api/admin/reservations/studio/rotate");
    assert.equal(rot.status, 200);
    const out = (await rot.json()) as { links: { host: string } };
    const key = out.links.host.split("host=")[1];
    const after = readReservationsFile(file).rooms.studio;
    assert.equal(verifyHostKey(after, key), true);
    assert.notEqual(after.hostKeyHash, before.hostKeyHash);
    assert.equal(after.note, "Ana");
    assert.equal(after.moderation.chat, "admins");
    assert.equal(after.createdAt, before.createdAt);
    assert.equal((await call("POST", "/api/admin/reservations/nope/rotate")).status, 404);

    assert.equal((await call("DELETE", "/api/admin/reservations/studio")).status, 200);
    assert.equal(readReservationsFile(file).rooms.studio, undefined);
    assert.equal((await call("DELETE", "/api/admin/reservations/studio")).status, 404);
  });

  it("logs out: the cookie is cleared and the session is gone", async () => {
    const res = await call("POST", "/api/admin/logout");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((await call("GET", "/api/admin/session")).status, 401);
  });
});
