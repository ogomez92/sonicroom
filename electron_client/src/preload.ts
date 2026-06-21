// Client-window preload. Runs before the bundled web client's scripts, so it can
// inject window.__SONICROOM_CONFIG__ (the same global the server injects on the
// web) with the configured remote serverUrl, ICE servers and branding. The client
// reads these through client/src/lib/runtime-config.ts + branding.ts.
import { contextBridge, ipcRenderer } from "electron";

interface InjectedConfig {
  instanceName?: string;
  serverUrl?: string;
  iceServers?: unknown[];
  defaultDisplayName?: string;
}

const cfg = ipcRenderer.sendSync("sonicroom:get-config-sync") as InjectedConfig;

// Only define the keys that are actually set, so empty values fall back to the
// client's own defaults (same-origin, built-in ICE list, default instance name).
const injected: InjectedConfig = {};
if (cfg.instanceName) injected.instanceName = cfg.instanceName;
if (cfg.serverUrl) injected.serverUrl = cfg.serverUrl;
if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) injected.iceServers = cfg.iceServers;
if (cfg.defaultDisplayName) injected.defaultDisplayName = cfg.defaultDisplayName;

try {
  contextBridge.exposeInMainWorld("__SONICROOM_CONFIG__", injected);
} catch {
  // exposeInMainWorld throws if the key already exists; harmless here.
}

contextBridge.exposeInMainWorld("sonicroom", {
  openSettings: () => ipcRenderer.send("sonicroom:open-settings"),
});
