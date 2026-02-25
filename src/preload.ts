import { contextBridge, ipcRenderer } from "electron";

// Listen for postMessage from injected toolbar buttons
addEventListener("message", (event: MessageEvent) => {
  if (event.data?.type === "openclaw-desktop-action") {
    const action = event.data.action;
    if (action === "open-settings") {
      ipcRenderer.invoke("open-settings");
    } else if (action === "open-channels") {
      ipcRenderer.invoke("open-channels");
    }
  }
});

contextBridge.exposeInMainWorld("openclaw", {
  startSetup: (): Promise<boolean> => ipcRenderer.invoke("start-setup"),
  checkPrerequisites: (): Promise<{ ok: boolean; missing: string[]; canAutoInstall: boolean }> =>
    ipcRenderer.invoke("check-prerequisites"),
  getStatus: (): Promise<{
    installed: boolean;
    built: boolean;
    gatewayRunning: boolean;
    gatewayUrl: string;
    installDir: string;
  }> => ipcRenderer.invoke("get-status"),
  getLogs: (): Promise<string[]> => ipcRenderer.invoke("get-logs"),
  openGateway: (): Promise<void> => ipcRenderer.invoke("open-gateway"),
  updateOpenClaw: (): Promise<boolean> => ipcRenderer.invoke("update-openclaw"),
  openInstallDir: (): Promise<void> => ipcRenderer.invoke("open-install-dir"),
  getAppInfo: (): Promise<{ version: string; platform: string; arch: string }> =>
    ipcRenderer.invoke("get-app-info"),

  getConfig: (): Promise<{ model: string | null; envKeys: Record<string, string> }> =>
    ipcRenderer.invoke("get-config"),
  saveEnvKey: (envVar: string, value: string): Promise<boolean> =>
    ipcRenderer.invoke("save-env-key", envVar, value),
  saveModel: (modelRef: string): Promise<boolean> =>
    ipcRenderer.invoke("save-model", modelRef),
  chooseInstallDir: (): Promise<string | null> =>
    ipcRenderer.invoke("choose-install-dir"),
  getInstallDir: (): Promise<string> =>
    ipcRenderer.invoke("get-install-dir"),
  checkForUpdates: (): Promise<{
    hasUpdate: boolean;
    localVersion: string | null;
    remoteVersion: string | null;
    localCommit: string | null;
    remoteCommit: string | null;
  }> => ipcRenderer.invoke("check-for-updates"),
  doUpdate: (): Promise<boolean> => ipcRenderer.invoke("do-update"),
  openSettings: (): Promise<void> => ipcRenderer.invoke("open-settings"),
  openChannels: (): Promise<void> => ipcRenderer.invoke("open-channels"),
  getChannelsConfig: (): Promise<Record<string, any>> =>
    ipcRenderer.invoke("get-channels-config"),
  saveChannelConfig: (channel: string, config: Record<string, string>): Promise<boolean> =>
    ipcRenderer.invoke("save-channel-config", channel, config),
  goBack: (): Promise<void> => ipcRenderer.invoke("go-back"),

  onProgress: (callback: (progress: any) => void) => {
    ipcRenderer.on("setup-progress", (_event, progress) => callback(progress));
  },
});
