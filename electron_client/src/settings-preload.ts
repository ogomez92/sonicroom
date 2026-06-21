// Settings-window preload. Exposes a tiny typed bridge for the settings page to
// read/save the boot-critical config (serverUrl, ICE servers, branding, default
// name, language) over IPC. Audio/voice/Icecast preferences are NOT handled here —
// the settings page writes those straight to localStorage, which it shares with
// the client window via the common app:// origin.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("settingsAPI", {
  getConfig: () => ipcRenderer.invoke("sonicroom:get-config"),
  saveConfig: (config: unknown) => ipcRenderer.invoke("sonicroom:save-config", config),
  close: () => ipcRenderer.send("sonicroom:close-settings"),
});
