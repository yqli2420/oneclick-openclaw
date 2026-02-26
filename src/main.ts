import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  nativeTheme,
  ipcMain,
  net,
  dialog,
  type MenuItemConstructorOptions,
} from "electron";
import * as path from "path";
import { OpenClawManager, type SetupProgress } from "./openclaw-manager";

const APP_NAME = "OpenClaw Desktop";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let manager: OpenClawManager;
let isQuitting = false;

function getAssetPath(...segments: string[]): string {
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, "assets")
    : path.join(__dirname, "..", "assets");
  return path.join(basePath, ...segments);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1100,
    height: 750,
    minWidth: 700,
    minHeight: 500,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f0f1a" : "#f8f9fc",
    titleBarStyle: "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
    icon: getAssetPath("icon.png"),
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.on("close", (event) => {
    if (!isQuitting && process.platform === "darwin") {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Inject toolbar on every gateway page load
  mainWindow.webContents.on("did-finish-load", () => {
    const url = mainWindow?.webContents.getURL() || "";
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      injectDesktopToolbar();
    }
  });

  // Start with setup page
  mainWindow.loadFile(path.join(__dirname, "setup.html"));
}

function createTray(): void {
  try {
    tray = new Tray(getAssetPath("tray-iconTemplate.png"));
  } catch {
    try {
      tray = new Tray(getAssetPath("tray-icon.png"));
    } catch {
      return;
    }
  }

  tray.setToolTip(APP_NAME);
  updateTrayMenu();

  tray.on("click", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow?.show();
    }
  });
}

function updateTrayMenu(): void {
  if (!tray) return;

  const running = manager?.isGatewayRunning ?? false;
  const template: MenuItemConstructorOptions[] = [
    {
      label: `Gateway: ${running ? "Running" : "Stopped"}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Show Window",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: running ? "Open Dashboard" : "Start Setup",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
        if (running) {
          mainWindow?.loadURL(manager.gatewayUrl);
        }
      },
    },
    { type: "separator" },
    {
      label: "Restart Gateway",
      enabled: running,
      click: async () => {
        manager.stopGateway();
        updateTrayMenu();
        await manager.startGateway((p) => sendProgress(p));
        if (manager.isGatewayRunning) {
          setTimeout(() => {
            mainWindow?.loadURL(manager.gatewayUrl);
          }, 2000);
        }
        updateTrayMenu();
      },
    },
    {
      label: "Stop Gateway",
      enabled: running,
      click: () => {
        manager.stopGateway();
        updateTrayMenu();
        mainWindow?.loadFile(path.join(__dirname, "setup.html"));
      },
    },
    {
      label: "Settings...",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.loadFile(path.join(__dirname, "settings.html"));
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      accelerator: process.platform === "darwin" ? "Cmd+Q" : "Alt+F4",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function sendProgress(progress: SetupProgress): void {
  mainWindow?.webContents.send("setup-progress", progress);
}

function createAppMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: APP_NAME,
          submenu: [
            { role: "about" as const },
            { type: "separator" as const },
            {
              label: "Settings...",
              accelerator: "Cmd+,",
              click: () => mainWindow?.loadFile(path.join(__dirname, "settings.html")),
            },
            { type: "separator" as const },
            { role: "hide" as const },
            { role: "hideOthers" as const },
            { type: "separator" as const },
            { role: "quit" as const },
          ],
        } as MenuItemConstructorOptions]
      : []),
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
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function loadGatewayUI(): Promise<void> {
  if (!mainWindow) return;

  const token = manager.getGatewayToken();
  const gatewayUrl = manager.gatewayUrl;

  if (token) {
    // Step 1: Load a lightweight resource on the gateway origin
    // so we can access its localStorage context
    try {
      await mainWindow.loadURL(gatewayUrl + "/favicon.svg");
    } catch {
      // favicon might 404, try the config endpoint instead
      try {
        await mainWindow.loadURL(gatewayUrl + "/__openclaw/control-ui-config.json");
      } catch {
        // fall through
      }
    }

    // Step 2: Inject the token into localStorage on this origin
    const injectScript = `
      (function() {
        var KEY = "openclaw.control.settings.v1";
        var raw = localStorage.getItem(KEY);
        var settings = {};
        try { if (raw) settings = JSON.parse(raw); } catch(e) {}
        settings.gatewayUrl = "ws://" + location.host;
        settings.token = ${JSON.stringify(token)};
        if (!settings.sessionKey) settings.sessionKey = "main";
        if (!settings.lastActiveSessionKey) settings.lastActiveSessionKey = "main";
        if (!settings.theme) settings.theme = "system";
        localStorage.setItem(KEY, JSON.stringify(settings));
        return "ok";
      })();
    `;

    try {
      await mainWindow.webContents.executeJavaScript(injectScript);
    } catch {
      // If injection fails, user will need to enter token manually
    }
  }

  // Step 3: Now load the real Control UI - it will find the token in localStorage
  // Toolbar injection is handled by the global did-finish-load listener in createWindow()
  await mainWindow.loadURL(gatewayUrl);
}

function injectDesktopToolbar(): void {
  if (!mainWindow) return;

  const currentModel = manager.readCurrentModel() || "Not set";
  const modelDisplay = currentModel.length > 35 ? currentModel.slice(0, 35) + "..." : currentModel;

  const cssCode = `
    #openclaw-desktop-toolbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
      height: 38px; display: flex; align-items: center; justify-content: flex-end;
      padding: 0 16px; gap: 10px;
      background: #f1f1f4;
      border-bottom: 1px solid #e0e0e6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px; color: #333;
    }
    @media (prefers-color-scheme: dark) {
      #openclaw-desktop-toolbar {
        background: #16162a; border-bottom-color: #2a2a44; color: #ccc;
      }
    }
    #openclaw-desktop-toolbar .tb-label { color: #999; font-size: 11px; margin-right: auto; }
    #openclaw-desktop-toolbar .tb-model {
      color: #6366f1; font-weight: 600; font-size: 11px;
      background: rgba(99,102,241,0.1); padding: 4px 12px; border-radius: 6px;
    }
    #openclaw-desktop-toolbar .tb-btn {
      padding: 5px 14px; border-radius: 6px; border: 1px solid rgba(128,128,128,0.25);
      background: rgba(128,128,128,0.08); color: inherit; font-size: 11px;
      font-weight: 500; cursor: pointer;
    }
    #openclaw-desktop-toolbar .tb-btn:hover { background: rgba(99,102,241,0.15); }
    body { padding-top: 38px !important; }
  `;

  const jsCode = `
    (function inject() {
      if (document.getElementById('openclaw-desktop-toolbar')) return;
      if (!document.body) { setTimeout(inject, 200); return; }
      var s = document.createElement('style');
      s.textContent = ${JSON.stringify(cssCode)};
      document.head.appendChild(s);
      var bar = document.createElement('div');
      bar.id = 'openclaw-desktop-toolbar';
      bar.innerHTML = '<span class="tb-label">OpenClaw Desktop</span>'
        + '<span class="tb-model">${modelDisplay}</span>'
        + '<button class="tb-btn" id="oc-tb-keys">API Keys</button>'
        + '<button class="tb-btn" id="oc-tb-model">Model</button>'
        + '<button class="tb-btn" id="oc-tb-channels">Channels</button>';
      document.body.prepend(bar);
      document.getElementById('oc-tb-keys').addEventListener('click', function(){
        window.postMessage({type:'openclaw-desktop-action',action:'open-settings'}, '*');
      });
      document.getElementById('oc-tb-model').addEventListener('click', function(){
        window.postMessage({type:'openclaw-desktop-action',action:'open-settings'}, '*');
      });
      document.getElementById('oc-tb-channels').addEventListener('click', function(){
        window.postMessage({type:'openclaw-desktop-action',action:'open-channels'}, '*');
      });
    })();
  `;

  mainWindow.webContents.executeJavaScript(jsCode).catch((err) => {
    console.error("Toolbar injection failed:", err);
  });
}

function setupIPC(): void {
  ipcMain.handle("start-setup", async () => {
    const ok = await manager.setup((p) => sendProgress(p));
    if (ok) {
      const started = await manager.startGateway((p) => sendProgress(p));
      updateTrayMenu();
      if (started) {
        await loadGatewayUI();
      }
      return started;
    }
    return false;
  });

  ipcMain.handle("check-prerequisites", async () => {
    return manager.checkPrerequisites();
  });

  ipcMain.handle("get-status", () => ({
    installed: manager.isInstalled(),
    built: manager.isBuilt(),
    gatewayRunning: manager.isGatewayRunning,
    gatewayUrl: manager.gatewayUrl,
    installDir: manager.installDir,
  }));

  ipcMain.handle("get-logs", () => manager.recentLogs);

  ipcMain.handle("open-gateway", async () => {
    if (manager.isGatewayRunning) {
      await loadGatewayUI();
    }
  });

  ipcMain.handle("update-openclaw", async () => {
    manager.stopGateway();
    const ok = await manager.updateOpenClaw((p) => sendProgress(p));
    if (ok) {
      await manager.startGateway((p) => sendProgress(p));
      updateTrayMenu();
      if (manager.isGatewayRunning) {
        await loadGatewayUI();
      }
    }
    return ok;
  });

  ipcMain.handle("open-install-dir", () => {
    shell.openPath(manager.installDir);
  });

  ipcMain.handle("get-app-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  }));

  ipcMain.handle("get-gateway-token", () => manager.getGatewayToken());

  ipcMain.handle("choose-install-dir", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose OpenClaw install directory",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: manager.installDir,
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const chosen = path.join(result.filePaths[0], "openclaw");
    manager.setInstallDir(chosen);
    return chosen;
  });

  ipcMain.handle("get-install-dir", () => manager.installDir);

  ipcMain.handle("check-for-updates", async () => {
    return manager.checkForUpdates();
  });

  ipcMain.handle("do-update", async () => {
    const ok = await manager.updateOpenClaw((p) => sendProgress(p));
    if (ok) {
      await manager.startGateway((p) => sendProgress(p));
      updateTrayMenu();
      if (manager.isGatewayRunning) {
        await loadGatewayUI();
      }
    }
    return ok;
  });

  ipcMain.handle("get-config", () => ({
    model: manager.readCurrentModel(),
    envKeys: manager.readEnvKeys(),
  }));

  ipcMain.handle("save-env-key", (_event, envVar: string, value: string) => {
    return manager.saveEnvKey(envVar, value);
  });

  ipcMain.handle("save-model", (_event, modelRef: string) => {
    return manager.saveModel(modelRef);
  });

  ipcMain.handle("open-settings", () => {
    mainWindow?.loadFile(path.join(__dirname, "settings.html"));
  });

  ipcMain.handle("open-channels", () => {
    mainWindow?.loadFile(path.join(__dirname, "channels.html"));
  });

  ipcMain.handle("get-channels-config", () => {
    return manager.readChannelsConfig();
  });

  ipcMain.handle("save-channel-config", (_event, channel: string, config: Record<string, string>) => {
    return manager.saveChannelConfig(channel, config);
  });

  ipcMain.handle("go-back", async () => {
    try {
      const res = await net.fetch(manager.gatewayUrl, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok || res.status === 426) {
        mainWindow?.loadURL(manager.gatewayUrl);
        return;
      }
    } catch { /* gateway not reachable */ }
    mainWindow?.loadFile(path.join(__dirname, "setup.html"));
  });
}

app.on("ready", () => {
  manager = new OpenClawManager();
  setupIPC();
  createAppMenu();
  createWindow();
  createTray();
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  manager?.stopGateway();
});

nativeTheme.on("updated", () => {
  mainWindow?.setBackgroundColor(
    nativeTheme.shouldUseDarkColors ? "#0f0f1a" : "#f8f9fc"
  );
});
