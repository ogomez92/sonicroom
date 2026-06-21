// Persistent app configuration (the "boot-critical" settings that must be present
// before the client app boots: which server to connect to, branding, ICE servers,
// the lobby's default name and the UI language). Stored as JSON in Electron's
// per-user data dir. Audio/voice/Icecast *preferences* are NOT here — those live
// in the renderer's localStorage under the stable app:// origin, edited directly
// by the settings page (see settings.ts).
import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface AppConfig {
  // Absolute origin of the remote SonicRoom instance, e.g. "https://sonic.example.com".
  // Empty until the user configures it (first run opens Settings).
  serverUrl: string;
  // Optional branding override; empty falls back to the client's default ("SonicRoom").
  instanceName: string;
  // ICE/TURN servers; empty array means "use the client's built-in default list".
  iceServers: IceServer[];
  // Prefilled name in the lobby's "Your name" field.
  defaultDisplayName: string;
  // UI language code ("en" | "es" | "fr" | ...); empty means auto-detect.
  language: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  serverUrl: "",
  instanceName: "",
  iceServers: [],
  defaultDisplayName: "",
  language: "",
};

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

function coerceIceServers(value: unknown): IceServer[] {
  if (!Array.isArray(value)) return [];
  const out: IceServer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const urls = e.urls;
    const ok =
      typeof urls === "string" || (Array.isArray(urls) && urls.every((u) => typeof u === "string"));
    if (!ok || (typeof urls === "string" && !urls.trim())) continue;
    const server: IceServer = { urls: urls as string | string[] };
    if (typeof e.username === "string" && e.username) server.username = e.username;
    if (typeof e.credential === "string" && e.credential) server.credential = e.credential;
    out.push(server);
  }
  return out;
}

// Read config from disk, filling in defaults and defending against malformed JSON
// or partial/garbage values (the file is user-editable).
export function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl.trim() : "",
      instanceName: typeof parsed.instanceName === "string" ? parsed.instanceName.trim() : "",
      iceServers: coerceIceServers(parsed.iceServers),
      defaultDisplayName:
        typeof parsed.defaultDisplayName === "string" ? parsed.defaultDisplayName.trim() : "",
      language: typeof parsed.language === "string" ? parsed.language.trim() : "",
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Merge a partial update over the current config and persist it. Returns the
// resulting full config.
export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next: AppConfig = { ...loadConfig() };
  if (typeof patch.serverUrl === "string") next.serverUrl = patch.serverUrl.trim();
  if (typeof patch.instanceName === "string") next.instanceName = patch.instanceName.trim();
  if (patch.iceServers !== undefined) next.iceServers = coerceIceServers(patch.iceServers);
  if (typeof patch.defaultDisplayName === "string")
    next.defaultDisplayName = patch.defaultDisplayName.trim();
  if (typeof patch.language === "string") next.language = patch.language.trim();

  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}
