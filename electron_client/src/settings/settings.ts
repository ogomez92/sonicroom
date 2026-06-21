// Settings-window logic. Boot-critical config (server URL, branding, ICE servers,
// default name, language) round-trips through the main process via `settingsAPI`.
// Audio/voice/Icecast preferences are read from and written straight to
// localStorage — the same keys the web client uses — which this window shares with
// the client window through the common app:// origin. Saving reloads the client.

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface AppConfig {
  serverUrl: string;
  instanceName: string;
  iceServers: IceServer[];
  defaultDisplayName: string;
  language: string;
}

interface SettingsAPI {
  getConfig(): Promise<AppConfig>;
  saveConfig(config: Partial<AppConfig>): Promise<AppConfig>;
  close(): void;
}

declare global {
  interface Window {
    settingsAPI: SettingsAPI;
  }
}

// Mirrors client/src/lib/runtime-config.ts so "Reset to defaults" matches what the
// client would use when no override is set.
const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: "stun:turn.oriolgomez.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:turn.oriolgomez.com:3478?transport=udp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
  {
    urls: "turn:turn.oriolgomez.com:3478?transport=tcp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
  {
    urls: "turns:turn.oriolgomez.com:5349?transport=tcp",
    username: "gamesturn",
    credential: "sin6V0gFokHz78gM0GDfXmat",
  },
];

interface StreamConfig {
  host: string;
  port: number;
  mount: string;
  username: string;
  password: string;
  format: "mp3" | "opus";
  bitrateKbps: number;
}

const DEFAULT_STREAM_CONFIG: StreamConfig = {
  host: "",
  port: 8000,
  mount: "/sonicroom",
  username: "source",
  password: "",
  format: "mp3",
  bitrateKbps: 128,
};

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function getString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable; ignore */
  }
}

function setStatus(message: string, kind: "" | "ok" | "error"): void {
  const el = $("status");
  el.textContent = message;
  el.className = kind;
}

function loadStreamConfig(): StreamConfig {
  const raw = getString("sonicroom:streamConfig");
  if (!raw) return { ...DEFAULT_STREAM_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<StreamConfig>;
    return { ...DEFAULT_STREAM_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_STREAM_CONFIG };
  }
}

async function init(): Promise<void> {
  const cfg = await window.settingsAPI.getConfig();

  ($("serverUrl") as HTMLInputElement).value = cfg.serverUrl;
  ($("instanceName") as HTMLInputElement).value = cfg.instanceName;
  ($("displayName") as HTMLInputElement).value = cfg.defaultDisplayName;
  ($("language") as HTMLSelectElement).value = cfg.language;
  const ice = cfg.iceServers.length ? cfg.iceServers : DEFAULT_ICE_SERVERS;
  ($("iceServers") as HTMLTextAreaElement).value = JSON.stringify(ice, null, 2);

  // Audio/voice prefs from localStorage (shared origin with the client).
  ($("micGain") as HTMLInputElement).value = getString("sonicroom:micGain") ?? "1";
  ($("hifiVoice") as HTMLInputElement).checked = getString("sonicroom:hifiVoice") === "true";
  ($("voiceProcessing") as HTMLInputElement).checked =
    getString("sonicroom:voiceProcessing") === "true";
  ($("announceMode") as HTMLSelectElement).value =
    getString("sonicroom:chatAnnounceMode") ?? "polite";

  const sc = loadStreamConfig();
  ($("ic_host") as HTMLInputElement).value = sc.host;
  ($("ic_port") as HTMLInputElement).value = String(sc.port);
  ($("ic_mount") as HTMLInputElement).value = sc.mount;
  ($("ic_username") as HTMLInputElement).value = sc.username;
  ($("ic_password") as HTMLInputElement).value = sc.password;
  ($("ic_format") as HTMLSelectElement).value = sc.format;
  ($("ic_bitrate") as HTMLInputElement).value = String(sc.bitrateKbps);
}

function persistPrefs(): void {
  setString("sonicroom:micGain", ($("micGain") as HTMLInputElement).value || "1");
  setString("sonicroom:hifiVoice", String(($("hifiVoice") as HTMLInputElement).checked));
  setString(
    "sonicroom:voiceProcessing",
    String(($("voiceProcessing") as HTMLInputElement).checked),
  );
  setString("sonicroom:chatAnnounceMode", ($("announceMode") as HTMLSelectElement).value);

  const streamConfig: StreamConfig = {
    host: ($("ic_host") as HTMLInputElement).value.trim(),
    port: Number(($("ic_port") as HTMLInputElement).value) || DEFAULT_STREAM_CONFIG.port,
    mount: ($("ic_mount") as HTMLInputElement).value.trim() || DEFAULT_STREAM_CONFIG.mount,
    username: ($("ic_username") as HTMLInputElement).value.trim(),
    password: ($("ic_password") as HTMLInputElement).value,
    format: ($("ic_format") as HTMLSelectElement).value === "opus" ? "opus" : "mp3",
    bitrateKbps:
      Number(($("ic_bitrate") as HTMLInputElement).value) || DEFAULT_STREAM_CONFIG.bitrateKbps,
  };
  setString("sonicroom:streamConfig", JSON.stringify(streamConfig));
}

async function save(): Promise<void> {
  let iceServers: IceServer[];
  const iceText = ($("iceServers") as HTMLTextAreaElement).value.trim();
  try {
    const parsed = iceText ? (JSON.parse(iceText) as unknown) : [];
    if (!Array.isArray(parsed)) throw new Error("not an array");
    iceServers = parsed as IceServer[];
  } catch {
    setStatus("ICE servers must be a valid JSON array.", "error");
    return;
  }

  const serverUrl = ($("serverUrl") as HTMLInputElement).value.trim();
  if (serverUrl && !/^https?:\/\//i.test(serverUrl)) {
    setStatus("Server URL must start with http:// or https://", "error");
    return;
  }

  persistPrefs();
  await window.settingsAPI.saveConfig({
    serverUrl,
    instanceName: ($("instanceName") as HTMLInputElement).value.trim(),
    iceServers,
    defaultDisplayName: ($("displayName") as HTMLInputElement).value.trim(),
    language: ($("language") as HTMLSelectElement).value,
  });
  setStatus("Saved.", "ok");
  window.settingsAPI.close();
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  void save();
});
$("resetIce").addEventListener("click", () => {
  ($("iceServers") as HTMLTextAreaElement).value = JSON.stringify(DEFAULT_ICE_SERVERS, null, 2);
});
$("cancel").addEventListener("click", () => window.settingsAPI.close());

void init().catch((err) => setStatus(`Failed to load settings: ${String(err)}`, "error"));

export {};
