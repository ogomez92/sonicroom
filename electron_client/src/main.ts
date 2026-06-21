// SonicRoom desktop client — Electron main process.
//
// This is a *thin client*: it bundles the SonicRoom web client (client/dist) and
// connects to a user-configurable remote instance. It runs no server and bundles
// no ffmpeg/yt-dlp — recording, streaming and URL/library playback all happen on
// the remote server, exactly as in a browser.
//
// Responsibilities:
//   • serve the bundled client over a stable, secure `app://` origin (so getUserMedia
//     works and localStorage persists across launches);
//   • inject the configured serverUrl / ICE servers / branding into the client via
//     the preload (window.__SONICROOM_CONFIG__);
//   • relax cross-origin restrictions so the client can reach the remote server;
//   • grant microphone + screen/system-audio (display-capture) permissions;
//   • own the Settings window and the app menu.
import {
  app,
  BrowserWindow,
  session,
  protocol,
  ipcMain,
  Menu,
  desktopCapturer,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, saveConfig, type AppConfig } from "./config";

const APP_SCHEME = "app";
const APP_HOST = "sonicroom";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const SETTINGS_PREFIX = "/__electron/";

// Settings-window renderer assets live next to this bundle (dist-electron/renderer);
// the built web client is an extra resource in production and ../../client/dist in dev.
const rendererDir = path.join(__dirname, "renderer");
const clientDist = app.isPackaged
  ? path.join(process.resourcesPath, "client-dist")
  : path.resolve(__dirname, "../../client/dist");

let currentConfig: AppConfig = loadConfig();
let clientWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

// Custom scheme must be privileged BEFORE app `ready`: `secure` makes it a secure
// context (required for getUserMedia/WebRTC); `standard` enables DOM storage with a
// stable origin; the rest let fetch()/streamed responses work.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

function contentType(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// Resolve a requested pathname to a real file inside `baseDir`, guarding against
// path traversal. Returns null if the resolved path escapes the root.
function resolveWithin(baseDir: string, relative: string): string | null {
  const full = path.join(baseDir, relative);
  const rel = path.relative(baseDir, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

// Serves the bundled client (and the settings UI under /__electron/) over app://.
// Unknown client routes fall back to index.html so client-side routing survives a
// reload (e.g. app://sonicroom/room/foo).
async function handleAppRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname);

  let baseDir: string;
  let relative: string;
  if (pathname.startsWith(SETTINGS_PREFIX)) {
    baseDir = rendererDir;
    relative = pathname.slice(SETTINGS_PREFIX.length) || "index.html";
  } else {
    baseDir = clientDist;
    relative = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");
  }

  const filePath = resolveWithin(baseDir, relative);
  if (!filePath) return new Response("Forbidden", { status: 403 });

  try {
    const body = await readFile(filePath);
    return new Response(body, { headers: { "content-type": contentType(filePath) } });
  } catch {
    // SPA fallback: serve the client's index.html for unknown, extensionless routes.
    if (baseDir === clientDist && !path.extname(relative)) {
      try {
        const body = await readFile(path.join(clientDist, "index.html"));
        return new Response(body, { headers: { "content-type": MIME[".html"] } });
      } catch {
        /* fall through to 404 */
      }
    }
    return new Response("Not found", { status: 404 });
  }
}

function buildClientUrl(config: AppConfig): string {
  const base = process.env.SONICROOM_CLIENT_URL || `${APP_ORIGIN}/index.html`;
  // The client honours ?lang= (see client/src/lib/i18n.ts) and persists it, so we
  // only need to pass it through; everything else is injected via the preload.
  if (!config.language) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}lang=${encodeURIComponent(config.language)}`;
}

function windowTitle(config: AppConfig): string {
  return config.instanceName || "SonicRoom";
}

// Cross-origin reach: the client runs on app:// but talks to the remote server.
// We relax CORS at the network layer (belt-and-suspenders alongside the client
// window's webSecurity:false) so fetch()/media to the remote instance succeed.
function installCorsRelaxation(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders["Access-Control-Allow-Origin"] = ["*"];
    responseHeaders["Access-Control-Allow-Headers"] = ["*"];
    responseHeaders["Access-Control-Allow-Methods"] = ["GET, POST, OPTIONS"];
    callback({ responseHeaders });
  });
}

function installPermissionHandlers(): void {
  const allowed = new Set([
    "media",
    "audioCapture",
    "videoCapture",
    "display-capture",
    "clipboard-read",
    "clipboard-sanitized-write",
  ]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

// Screen / system-audio share. The client calls getDisplayMedia({video:true,
// audio:{…}}); Electron requires a handler to fulfil it. We capture the whole
// screen plus loopback (system) audio — the audio is what music-casting needs.
// macOS system-audio loopback needs a recent OS and is best-effort; mic + screen
// video always work.
function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
        const screenSource = sources.find((s) => s.id.startsWith("screen")) ?? sources[0];
        if (!screenSource) {
          callback({});
          return;
        }
        callback({ video: screenSource, audio: "loopback" });
      } catch {
        callback({});
      }
    },
    // Prefer the OS picker where supported (better UX + per-app audio on
    // macOS/Windows); falls back to the callback above on Linux.
    { useSystemPicker: true },
  );
}

function createClientWindow(): void {
  clientWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: windowTitle(currentConfig),
    backgroundColor: "#09090b",
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The client (app://) talks cross-origin to the remote server and taps
      // remote audio through Web Audio; relaxing web security avoids CORS/media
      // tainting friction. Only our own trusted bundle + the user's chosen
      // server are ever loaded here.
      webSecurity: false,
    },
  });

  clientWindow.on("page-title-updated", (e) => e.preventDefault());
  clientWindow.setTitle(windowTitle(currentConfig));

  // Open target=_blank / external links in the system browser, not a child window.
  clientWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  void clientWindow.loadURL(buildClientUrl(currentConfig));

  if (process.env.SONICROOM_DEV) clientWindow.webContents.openDevTools({ mode: "detach" });

  clientWindow.on("closed", () => {
    clientWindow = null;
  });

  // First run (or cleared config): no server yet — open Settings so the user can
  // point the app somewhere.
  if (!currentConfig.serverUrl) openSettingsWindow();
}

function reloadClient(): void {
  if (!clientWindow) {
    createClientWindow();
    return;
  }
  clientWindow.setTitle(windowTitle(currentConfig));
  void clientWindow.loadURL(buildClientUrl(currentConfig));
}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 760,
    minWidth: 520,
    minHeight: 520,
    title: "Settings",
    parent: clientWindow ?? undefined,
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWindow.removeMenu();
  void settingsWindow.loadURL(`${APP_ORIGIN}${SETTINGS_PREFIX}index.html`);
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              {
                label: "Settings…",
                accelerator: "Cmd+,",
                click: () => openSettingsWindow(),
              },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "quit" as const },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Settings…",
          accelerator: "Ctrl+,",
          click: () => openSettingsWindow(),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => reloadClient() },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  // Preload fetches the boot config synchronously (so it can inject
  // window.__SONICROOM_CONFIG__ before the client's scripts run). Re-fetched on
  // every (re)load, so saving + reloading picks up changes with no window churn.
  ipcMain.on("sonicroom:get-config-sync", (event) => {
    event.returnValue = {
      instanceName: currentConfig.instanceName,
      serverUrl: currentConfig.serverUrl,
      iceServers: currentConfig.iceServers,
      defaultDisplayName: currentConfig.defaultDisplayName,
    };
  });

  ipcMain.on("sonicroom:open-settings", () => openSettingsWindow());

  ipcMain.handle("sonicroom:get-config", () => currentConfig);

  ipcMain.handle("sonicroom:save-config", (_event, patch: Partial<AppConfig>) => {
    currentConfig = saveConfig(patch ?? {});
    reloadClient();
    return currentConfig;
  });

  ipcMain.on("sonicroom:close-settings", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  });
}

// Single-instance: focus the existing window instead of launching a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (clientWindow) {
      if (clientWindow.isMinimized()) clientWindow.restore();
      clientWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, handleAppRequest);
    installCorsRelaxation();
    installPermissionHandlers();
    installDisplayMediaHandler();
    registerIpc();
    buildMenu();
    createClientWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createClientWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
