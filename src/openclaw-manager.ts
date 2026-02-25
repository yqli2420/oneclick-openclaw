import { app, net } from "electron";
import { spawn, execSync, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const REPO_URL = "https://github.com/openclaw/openclaw.git";
const DEFAULT_GATEWAY_PORT = 18789;

export type SetupStage =
  | "checking"
  | "cloning"
  | "installing"
  | "building"
  | "building-ui"
  | "starting"
  | "ready"
  | "error";

export type SetupProgress = {
  stage: SetupStage;
  message: string;
  detail?: string;
  percent?: number;
};

type ProgressCallback = (progress: SetupProgress) => void;

export class OpenClawManager {
  private gatewayProcess: ChildProcess | null = null;
  private _gatewayRunning = false;
  private openclawDir: string;
  private logLines: string[] = [];
  private settingsPath: string;

  constructor() {
    this.settingsPath = path.join(app.getPath("userData"), "desktop-settings.json");
    this.openclawDir = this.loadInstallDir();
  }

  private loadInstallDir(): string {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const raw = fs.readFileSync(this.settingsPath, "utf-8");
        const settings = JSON.parse(raw);
        if (settings.installDir && fs.existsSync(settings.installDir)) {
          return settings.installDir;
        }
      }
    } catch { /* ignore */ }
    return path.join(app.getPath("userData"), "openclaw");
  }

  private saveInstallDir(dir: string): void {
    try {
      let settings: Record<string, unknown> = {};
      if (fs.existsSync(this.settingsPath)) {
        settings = JSON.parse(fs.readFileSync(this.settingsPath, "utf-8"));
      }
      settings.installDir = dir;
      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
    } catch { /* ignore */ }
  }

  setInstallDir(dir: string): void {
    this.openclawDir = dir;
    this.saveInstallDir(dir);
  }

  get gatewayPort(): number {
    return this.readPortFromConfig() ?? DEFAULT_GATEWAY_PORT;
  }

  get gatewayUrl(): string {
    return `http://127.0.0.1:${this.gatewayPort}`;
  }

  private readPortFromConfig(): number | null {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    try {
      if (!fs.existsSync(configPath)) return null;
      const raw = fs.readFileSync(configPath, "utf-8");
      const cleaned = raw
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1");
      const config = JSON.parse(cleaned);
      const port = config?.gateway?.port;
      if (typeof port === "number" && port > 0) return port;
    } catch { /* ignore */ }
    return null;
  }

  get isGatewayRunning(): boolean {
    return this._gatewayRunning;
  }

  get installDir(): string {
    return this.openclawDir;
  }

  get recentLogs(): string[] {
    return this.logLines.slice(-100);
  }

  isInstalled(): boolean {
    return (
      fs.existsSync(path.join(this.openclawDir, "package.json")) &&
      fs.existsSync(path.join(this.openclawDir, "node_modules"))
    );
  }

  isBuilt(): boolean {
    return fs.existsSync(path.join(this.openclawDir, "dist", "entry.js"));
  }

  private hasControlUi(): boolean {
    return fs.existsSync(
      path.join(this.openclawDir, "dist", "control-ui", "index.html")
    );
  }

  /**
   * Read the gateway auth token from ~/.openclaw/openclaw.json
   */
  getGatewayToken(): string | null {
    const candidates = [
      path.join(os.homedir(), ".openclaw", "openclaw.json"),
      path.join(os.homedir(), ".clawdbot", "clawdbot.json"),
    ];

    for (const configPath of candidates) {
      try {
        if (!fs.existsSync(configPath)) continue;
        const raw = fs.readFileSync(configPath, "utf-8");
        // openclaw.json uses JSON5 (relaxed JSON with comments/trailing commas)
        // but gateway.auth.token is typically a clean string, so simple parsing works
        const cleaned = raw
          .replace(/\/\/.*$/gm, "")          // strip line comments
          .replace(/\/\*[\s\S]*?\*\//g, "")  // strip block comments
          .replace(/,(\s*[}\]])/g, "$1");     // strip trailing commas
        const config = JSON.parse(cleaned);
        const token = config?.gateway?.auth?.token;
        if (typeof token === "string" && token.trim()) {
          return token.trim();
        }
      } catch {
        continue;
      }
    }

    // Also check from gateway stdout for "token:" pattern
    for (const line of this.logLines) {
      const tokenMatch = line.match(/token[:\s]+([0-9a-f]{48})/i);
      if (tokenMatch) return tokenMatch[1];
    }

    return null;
  }

  private findExecutable(name: string): string | null {
    try {
      const result = execSync(
        process.platform === "win32" ? `where ${name}` : `which ${name}`,
        { encoding: "utf-8", env: this.getShellEnv(), timeout: 5000 }
      );
      return result.trim().split("\n")[0] || null;
    } catch {
      return null;
    }
  }

  private getNodePath(): string {
    return this.findExecutable("node") || "node";
  }

  private getPnpmPath(): string | null {
    return this.findExecutable("pnpm");
  }

  private getNpmPath(): string {
    return this.findExecutable("npm") || "npm";
  }

  private getGitPath(): string | null {
    return this.findExecutable("git");
  }

  private getShellEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (process.platform !== "darwin" && process.platform !== "linux") return env;

    const pathDirs = (env.PATH || "").split(":");
    const home = env.HOME || "";

    const extraPaths = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
    ];

    // NVM support
    try {
      const nvmDir = env.NVM_DIR || path.join(home, ".nvm");
      if (fs.existsSync(nvmDir)) {
        const versionsDir = path.join(nvmDir, "versions", "node");
        if (fs.existsSync(versionsDir)) {
          const versions = fs.readdirSync(versionsDir).sort().reverse();
          for (const v of versions) {
            const bin = path.join(versionsDir, v, "bin");
            if (fs.existsSync(bin)) extraPaths.unshift(bin);
          }
        }
      }
    } catch { /* ignore */ }

    // fnm support
    try {
      const fnmDir = path.join(home, ".local", "share", "fnm", "node-versions");
      if (fs.existsSync(fnmDir)) {
        const versions = fs.readdirSync(fnmDir).sort().reverse();
        for (const v of versions) {
          const bin = path.join(fnmDir, v, "installation", "bin");
          if (fs.existsSync(bin)) extraPaths.unshift(bin);
        }
      }
    } catch { /* ignore */ }

    // n support
    const nPrefix = path.join(home, "n", "bin");
    if (fs.existsSync(nPrefix)) extraPaths.unshift(nPrefix);

    // pnpm global bin
    try {
      const pnpmHome = env.PNPM_HOME || path.join(home, "Library", "pnpm");
      if (fs.existsSync(pnpmHome)) extraPaths.push(pnpmHome);
    } catch { /* ignore */ }

    // npm global
    extraPaths.push(path.join(home, ".npm-global", "bin"));

    for (const p of extraPaths) {
      if (!pathDirs.includes(p)) pathDirs.unshift(p);
    }
    env.PATH = pathDirs.join(":");
    return env;
  }

  private runCommand(
    command: string,
    args: string[],
    cwd: string,
    onOutput?: (line: string) => void
  ): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: this.getShellEnv(),
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";

      const handleData = (data: Buffer) => {
        const text = data.toString();
        output += text;
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.logLines.push(trimmed);
          if (this.logLines.length > 1000) this.logLines.shift();
          onOutput?.(trimmed);
        }
      };

      child.stdout?.on("data", handleData);
      child.stderr?.on("data", handleData);
      child.on("error", (err) => resolve({ code: 1, output: err.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, output }));
    });
  }

  async checkPrerequisites(): Promise<{ ok: boolean; missing: string[] }> {
    const missing: string[] = [];

    if (!this.getGitPath()) missing.push("git");

    const nodePath = this.findExecutable("node");
    if (!nodePath) {
      missing.push("node (>= 22)");
    } else {
      try {
        const version = execSync(`"${nodePath}" --version`, {
          encoding: "utf-8",
          env: this.getShellEnv(),
          timeout: 5000,
        }).trim();
        const major = parseInt(version.replace("v", "").split(".")[0], 10);
        if (major < 22) missing.push(`node >= 22 (found ${version})`);
      } catch {
        missing.push("node (>= 22)");
      }
    }

    // pnpm is required for openclaw build
    if (!this.getPnpmPath()) missing.push("pnpm");

    return { ok: missing.length === 0, missing };
  }

  private async ensurePnpm(onProgress: ProgressCallback): Promise<boolean> {
    if (this.getPnpmPath()) return true;

    onProgress({
      stage: "checking",
      message: "Installing pnpm...",
      detail: "npm install -g pnpm",
      percent: 8,
    });

    const npm = this.getNpmPath();
    const result = await this.runCommand(npm, ["install", "-g", "pnpm"], process.cwd());
    if (result.code !== 0) {
      onProgress({
        stage: "error",
        message: "Failed to install pnpm",
        detail: `Run manually: npm install -g pnpm\n${result.output.slice(-200)}`,
      });
      return false;
    }

    // Verify
    if (!this.getPnpmPath()) {
      onProgress({
        stage: "error",
        message: "pnpm installed but not found in PATH",
        detail: "Try restarting your terminal, then retry",
      });
      return false;
    }
    return true;
  }

  async setup(onProgress: ProgressCallback): Promise<boolean> {
    try {
      // Step 1: Check prerequisites
      onProgress({ stage: "checking", message: "Checking environment...", percent: 5 });

      if (!this.getGitPath()) {
        onProgress({ stage: "error", message: "Git not found", detail: "Please install git" });
        return false;
      }

      const nodePath = this.findExecutable("node");
      if (!nodePath) {
        onProgress({ stage: "error", message: "Node.js not found", detail: "Install Node.js >= 22" });
        return false;
      }

      // Check node version
      try {
        const version = execSync(`"${nodePath}" --version`, {
          encoding: "utf-8",
          env: this.getShellEnv(),
          timeout: 5000,
        }).trim();
        const major = parseInt(version.replace("v", "").split(".")[0], 10);
        if (major < 22) {
          onProgress({
            stage: "error",
            message: `Node.js too old: ${version}`,
            detail: "OpenClaw requires Node.js >= 22",
          });
          return false;
        }
      } catch {
        onProgress({ stage: "error", message: "Cannot detect Node.js version" });
        return false;
      }

      // Ensure pnpm is available (required by openclaw build)
      if (!(await this.ensurePnpm(onProgress))) return false;

      onProgress({ stage: "checking", message: "Environment OK", percent: 10 });

      // Step 2: Clone repo
      if (!fs.existsSync(path.join(this.openclawDir, "package.json"))) {
        onProgress({ stage: "cloning", message: "Downloading OpenClaw...", percent: 12 });

        const git = this.getGitPath()!;
        if (fs.existsSync(this.openclawDir)) {
          fs.rmSync(this.openclawDir, { recursive: true, force: true });
        }

        const cloneResult = await this.runCommand(
          git,
          ["clone", "--depth", "1", REPO_URL, this.openclawDir],
          path.dirname(this.openclawDir),
          (line) => {
            onProgress({ stage: "cloning", message: "Downloading OpenClaw...", detail: line, percent: 20 });
          }
        );

        if (cloneResult.code !== 0) {
          onProgress({
            stage: "error",
            message: "Failed to download OpenClaw",
            detail: cloneResult.output.slice(-300),
          });
          return false;
        }
      }
      onProgress({ stage: "cloning", message: "Source code ready", percent: 25 });

      // Step 3: Install dependencies with pnpm
      const pnpm = this.getPnpmPath()!;

      if (!fs.existsSync(path.join(this.openclawDir, "node_modules"))) {
        onProgress({ stage: "installing", message: "Installing dependencies (this may take a few minutes)...", percent: 30 });

        const installResult = await this.runCommand(
          pnpm,
          ["install", "--no-frozen-lockfile"],
          this.openclawDir,
          (line) => {
            onProgress({ stage: "installing", message: "Installing dependencies...", detail: line.slice(0, 120), percent: 45 });
          }
        );

        if (installResult.code !== 0) {
          onProgress({
            stage: "error",
            message: "Failed to install dependencies",
            detail: installResult.output.slice(-300),
          });
          return false;
        }
      }
      onProgress({ stage: "installing", message: "Dependencies installed", percent: 55 });

      // Step 4: Build openclaw (pnpm build)
      if (!this.isBuilt()) {
        onProgress({ stage: "building", message: "Building OpenClaw...", percent: 58 });

        const buildResult = await this.runCommand(
          pnpm,
          ["run", "build"],
          this.openclawDir,
          (line) => {
            onProgress({ stage: "building", message: "Building...", detail: line.slice(0, 120), percent: 68 });
          }
        );

        if (buildResult.code !== 0) {
          onProgress({
            stage: "error",
            message: "Failed to build OpenClaw",
            detail: buildResult.output.slice(-300),
          });
          return false;
        }
      }
      onProgress({ stage: "building", message: "Build complete", percent: 72 });

      // Step 5: Build Control UI (pnpm ui:build) - THIS IS CRITICAL
      if (!this.hasControlUi()) {
        onProgress({ stage: "building-ui", message: "Building Control UI...", percent: 75 });

        const uiResult = await this.runCommand(
          pnpm,
          ["run", "ui:build"],
          this.openclawDir,
          (line) => {
            onProgress({ stage: "building-ui", message: "Building UI...", detail: line.slice(0, 120), percent: 85 });
          }
        );

        if (uiResult.code !== 0) {
          onProgress({
            stage: "error",
            message: "Failed to build Control UI",
            detail: uiResult.output.slice(-300),
          });
          return false;
        }

        if (!this.hasControlUi()) {
          onProgress({
            stage: "error",
            message: "Control UI build succeeded but index.html is missing",
            detail: "dist/control-ui/index.html not found after build",
          });
          return false;
        }
      }
      onProgress({ stage: "building-ui", message: "Control UI ready", percent: 90 });

      onProgress({ stage: "starting", message: "Setup complete!", percent: 92 });
      return true;
    } catch (err: any) {
      onProgress({ stage: "error", message: "Setup failed", detail: err.message });
      return false;
    }
  }

  async startGateway(onProgress?: ProgressCallback): Promise<boolean> {
    if (this._gatewayRunning) return true;

    onProgress?.({ stage: "starting", message: "Starting gateway...", percent: 93 });

    const nodePath = this.getNodePath();
    const entryScript = path.join(this.openclawDir, "openclaw.mjs");

    if (!fs.existsSync(entryScript)) {
      onProgress?.({
        stage: "error",
        message: "OpenClaw entry point not found",
        detail: `Expected: ${entryScript}`,
      });
      return false;
    }

    this.gatewayProcess = spawn(
      nodePath,
      [entryScript, "gateway"],
      {
        cwd: this.openclawDir,
        env: this.getShellEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      }
    );

    const handleOutput = (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.logLines.push(trimmed);
        if (this.logLines.length > 1000) this.logLines.shift();
      }
    };

    this.gatewayProcess.stdout?.on("data", handleOutput);
    this.gatewayProcess.stderr?.on("data", handleOutput);

    this.gatewayProcess.on("close", (code) => {
      this._gatewayRunning = false;
      this.logLines.push(`[desktop] gateway exited with code ${code}`);
    });

    // Poll the HTTP endpoint until the UI actually serves HTML
    onProgress?.({ stage: "starting", message: "Waiting for gateway to be ready...", percent: 95 });

    const maxWait = 60_000;
    const pollInterval = 2000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      await this.sleep(pollInterval);

      // Check if process died
      if (this.gatewayProcess?.exitCode !== null && this.gatewayProcess?.exitCode !== undefined) {
        onProgress?.({
          stage: "error",
          message: `Gateway exited with code ${this.gatewayProcess.exitCode}`,
          detail: this.logLines.slice(-5).join("\n"),
        });
        return false;
      }

      const ready = await this.isGatewayServingUI();
      if (ready) {
        this._gatewayRunning = true;
        onProgress?.({ stage: "ready", message: "Gateway is running!", percent: 100 });
        return true;
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      onProgress?.({
        stage: "starting",
        message: `Waiting for gateway... (${elapsed}s)`,
        detail: this.logLines.slice(-1)[0],
        percent: Math.min(95 + Math.floor(elapsed / 6), 99),
      });
    }

    // Timed out but process is still alive - gateway might still work
    this._gatewayRunning = true;
    onProgress?.({
      stage: "ready",
      message: "Gateway started (UI may still be loading)",
      percent: 100,
    });
    return true;
  }

  private async isGatewayServingUI(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await net.fetch(this.gatewayUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) return false;

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) return false;

      const body = await res.text();
      // The real Control UI contains <openclaw-app> web component
      return body.includes("openclaw-app") || body.includes("<script");
    } catch {
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  stopGateway(): void {
    if (this.gatewayProcess) {
      this._gatewayRunning = false;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(this.gatewayProcess.pid), "/f", "/t"]);
        } else {
          this.gatewayProcess.kill("SIGTERM");
          setTimeout(() => {
            try { this.gatewayProcess?.kill("SIGKILL"); } catch { /* already dead */ }
          }, 5000);
        }
      } catch { /* process already exited */ }
      this.gatewayProcess = null;
    }
  }

  private getEnvFilePath(): string {
    return path.join(os.homedir(), ".openclaw", ".env");
  }

  private getConfigFilePath(): string {
    return path.join(os.homedir(), ".openclaw", "openclaw.json");
  }

  readEnvKeys(): Record<string, string> {
    const envPath = this.getEnvFilePath();
    const result: Record<string, string> = {};
    try {
      if (!fs.existsSync(envPath)) return result;
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        result[key] = value;
      }
    } catch { /* ignore */ }
    return result;
  }

  saveEnvKey(envVar: string, value: string): boolean {
    const envPath = this.getEnvFilePath();
    try {
      const dir = path.dirname(envPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let lines: string[] = [];
      if (fs.existsSync(envPath)) {
        lines = fs.readFileSync(envPath, "utf-8").split("\n");
      }

      let found = false;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith(envVar + "=")) {
          lines[i] = `${envVar}=${value}`;
          found = true;
          break;
        }
      }
      if (!found) {
        lines.push(`${envVar}=${value}`);
      }

      // Remove trailing empty lines, ensure final newline
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      fs.writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  readCurrentModel(): string | null {
    const configPath = this.getConfigFilePath();
    try {
      if (!fs.existsSync(configPath)) return null;
      const raw = fs.readFileSync(configPath, "utf-8");
      const cleaned = raw
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1");
      const config = JSON.parse(cleaned);
      return config?.agents?.defaults?.model?.primary || null;
    } catch {
      return null;
    }
  }

  saveModel(modelRef: string): boolean {
    const configPath = this.getConfigFilePath();
    try {
      if (!fs.existsSync(configPath)) return false;
      const raw = fs.readFileSync(configPath, "utf-8");
      const cleaned = raw
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1");
      const config = JSON.parse(cleaned);

      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!config.agents.defaults.model) config.agents.defaults.model = {};
      config.agents.defaults.model.primary = modelRef;

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  readChannelsConfig(): Record<string, any> {
    const configPath = this.getConfigFilePath();
    try {
      if (!fs.existsSync(configPath)) return {};
      const raw = fs.readFileSync(configPath, "utf-8");
      const cleaned = raw
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1");
      const config = JSON.parse(cleaned);
      return config?.channels || {};
    } catch { return {}; }
  }

  saveChannelConfig(channel: string, settings: Record<string, string>): boolean {
    const configPath = this.getConfigFilePath();
    try {
      if (!fs.existsSync(configPath)) return false;
      const raw = fs.readFileSync(configPath, "utf-8");
      const cleaned = raw
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1");
      const config = JSON.parse(cleaned);

      if (!config.channels) config.channels = {};
      if (!config.channels[channel]) config.channels[channel] = {};

      for (const [key, value] of Object.entries(settings)) {
        if (key === "enabled") {
          config.channels[channel].enabled = value === "true";
        } else if (value === "") {
          delete config.channels[channel][key];
        } else {
          config.channels[channel][key] = value;
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      return true;
    } catch { return false; }
  }

  getLocalVersion(): string | null {
    const pkgPath = path.join(this.openclawDir, "package.json");
    try {
      if (!fs.existsSync(pkgPath)) return null;
      const raw = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      return pkg.version || null;
    } catch { return null; }
  }

  private getLocalCommitHash(): string | null {
    const headPath = path.join(this.openclawDir, ".git", "refs", "heads", "main");
    try {
      if (fs.existsSync(headPath)) {
        return fs.readFileSync(headPath, "utf-8").trim().slice(0, 12);
      }
      const packedRef = path.join(this.openclawDir, ".git", "packed-refs");
      if (fs.existsSync(packedRef)) {
        const lines = fs.readFileSync(packedRef, "utf-8").split("\n");
        for (const line of lines) {
          if (line.includes("refs/heads/main")) {
            return line.trim().split(" ")[0].slice(0, 12);
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  async checkForUpdates(): Promise<{
    hasUpdate: boolean;
    localVersion: string | null;
    remoteVersion: string | null;
    localCommit: string | null;
    remoteCommit: string | null;
  }> {
    const localVersion = this.getLocalVersion();
    const localCommit = this.getLocalCommitHash();

    if (!localVersion) {
      return { hasUpdate: false, localVersion: null, remoteVersion: null, localCommit: null, remoteCommit: null };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(
        "https://raw.githubusercontent.com/openclaw/openclaw/main/package.json",
        { signal: controller.signal }
      );
      clearTimeout(timeout);

      if (!res.ok) {
        return { hasUpdate: false, localVersion, remoteVersion: null, localCommit, remoteCommit: null };
      }

      const remotePkg = JSON.parse(await res.text());
      const remoteVersion = remotePkg.version || null;

      // Also try to get remote commit hash via GitHub API
      let remoteCommit: string | null = null;
      try {
        const commitRes = await fetch(
          "https://api.github.com/repos/openclaw/openclaw/commits/main",
          { signal: AbortSignal.timeout(5000), headers: { "Accept": "application/vnd.github.v3+json" } }
        );
        if (commitRes.ok) {
          const commitData = JSON.parse(await commitRes.text());
          remoteCommit = commitData.sha?.slice(0, 12) || null;
        }
      } catch { /* ignore */ }

      const hasUpdate =
        (remoteVersion && localVersion && remoteVersion !== localVersion) ||
        (remoteCommit && localCommit && remoteCommit !== localCommit) ||
        false;

      return { hasUpdate, localVersion, remoteVersion, localCommit, remoteCommit };
    } catch {
      return { hasUpdate: false, localVersion, remoteVersion: null, localCommit, remoteCommit: null };
    }
  }

  async updateOpenClaw(onProgress: ProgressCallback): Promise<boolean> {
    const git = this.getGitPath();
    if (!git) {
      onProgress({ stage: "error", message: "Git not found" });
      return false;
    }

    onProgress({ stage: "cloning", message: "Updating OpenClaw...", percent: 10 });

    const pullResult = await this.runCommand(
      git,
      ["pull", "--rebase"],
      this.openclawDir,
      (line) => {
        onProgress({ stage: "cloning", message: "Pulling latest...", detail: line, percent: 20 });
      }
    );

    if (pullResult.code !== 0) {
      onProgress({ stage: "error", message: "Failed to update", detail: pullResult.output.slice(-300) });
      return false;
    }

    // Remove stale build artifacts, keep node_modules for faster reinstall
    try { fs.rmSync(path.join(this.openclawDir, "dist"), { recursive: true, force: true }); } catch { /* ok */ }

    return this.setup(onProgress);
  }
}
