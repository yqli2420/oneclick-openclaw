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
    const isWin = process.platform === "win32";
    const sep = isWin ? ";" : ":";
    const pathKey = isWin ? "Path" : "PATH";
    const pathDirs = (env[pathKey] || env.PATH || "").split(sep);
    const home = env.HOME || env.USERPROFILE || "";

    if (isWin) {
      // Windows: add common install paths
      const winPaths = [
        path.join(home, "AppData", "Roaming", "npm"),
        path.join(home, "AppData", "Local", "pnpm"),
        "C:\\Program Files\\Git\\cmd",
        "C:\\Program Files\\nodejs",
      ];
      for (const p of winPaths) {
        if (fs.existsSync(p) && !pathDirs.includes(p)) pathDirs.push(p);
      }
      env[pathKey] = pathDirs.join(sep);
      return env;
    }

    if (process.platform !== "darwin" && process.platform !== "linux") return env;

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

  private hasHomebrew(): boolean {
    return this.findExecutable("brew") !== null;
  }

  private getNodeMajor(): number | null {
    const nodePath = this.findExecutable("node");
    if (!nodePath) return null;
    try {
      const version = execSync(`"${nodePath}" --version`, {
        encoding: "utf-8",
        env: this.getShellEnv(),
        timeout: 5000,
      }).trim();
      return parseInt(version.replace("v", "").split(".")[0], 10);
    } catch { return null; }
  }

  private hasWinget(): boolean {
    return process.platform === "win32" && this.findExecutable("winget") !== null;
  }

  private hasChoco(): boolean {
    return process.platform === "win32" && this.findExecutable("choco") !== null;
  }

  async checkPrerequisites(): Promise<{ ok: boolean; missing: string[]; canAutoInstall: boolean }> {
    const missing: string[] = [];

    if (!this.getGitPath()) missing.push("git");

    const major = this.getNodeMajor();
    if (major === null) {
      missing.push("node (>= 22)");
    } else if (major < 22) {
      missing.push(`node >= 22 (found v${major})`);
    }

    if (!this.getPnpmPath()) missing.push("pnpm");

    // Auto-install is possible on all platforms
    const canAutoInstall = missing.length > 0;

    return { ok: missing.length === 0, missing, canAutoInstall };
  }

  async autoInstallPrerequisites(onProgress: ProgressCallback): Promise<boolean> {
    const platform = process.platform;

    // ── Step 1: Package manager setup ──
    if (platform === "darwin" && !this.hasHomebrew()) {
      onProgress({ stage: "checking", message: "Installing Homebrew...", detail: "This may take a minute", percent: 2 });
      const r = await this.runCommand(
        "/bin/bash",
        ["-c", 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'],
        process.cwd(),
        (line) => onProgress({ stage: "checking", message: "Installing Homebrew...", detail: line.slice(0, 100), percent: 3 })
      );
      if (r.code !== 0 && !this.hasHomebrew()) {
        onProgress({ stage: "error", message: "Failed to install Homebrew", detail: r.output.slice(-200) });
        return false;
      }
    }

    // ── Step 2: Git ──
    if (!this.getGitPath()) {
      onProgress({ stage: "checking", message: "Installing Git...", percent: 4 });
      const ok = await this.installGit(onProgress);
      if (!ok && !this.getGitPath()) {
        onProgress({ stage: "error", message: "Failed to install Git", detail: this.manualInstallHint("git") });
        return false;
      }
    }

    // ── Step 3: Node.js ──
    const major = this.getNodeMajor();
    if (major === null || major < 22) {
      onProgress({ stage: "checking", message: "Installing Node.js 22...", percent: 5 });
      const ok = await this.installNode(onProgress);
      if (!ok) {
        const newMajor = this.getNodeMajor();
        if (newMajor === null || newMajor < 22) {
          onProgress({ stage: "error", message: "Failed to install Node.js >= 22", detail: this.manualInstallHint("node") });
          return false;
        }
      }
    }

    // ── Step 4: pnpm ──
    if (!this.getPnpmPath()) {
      onProgress({ stage: "checking", message: "Installing pnpm...", percent: 8 });
      const ok = await this.installPnpm(onProgress);
      if (!ok && !this.getPnpmPath()) {
        onProgress({ stage: "error", message: "Failed to install pnpm", detail: this.manualInstallHint("pnpm") });
        return false;
      }
    }

    onProgress({ stage: "checking", message: "All prerequisites installed!", percent: 10 });
    return true;
  }

  private async installGit(onProgress: ProgressCallback): Promise<boolean> {
    const progress = (line: string) =>
      onProgress({ stage: "checking", message: "Installing Git...", detail: line.slice(0, 100), percent: 4 });

    if (process.platform === "darwin") {
      if (this.hasHomebrew()) {
        const r = await this.runCommand("brew", ["install", "git"], process.cwd(), progress);
        if (r.code === 0 || this.getGitPath()) return true;
      }
      await this.runCommand("xcode-select", ["--install"], process.cwd(), progress);
      return this.getGitPath() !== null;
    }

    if (process.platform === "win32") {
      if (this.hasWinget()) {
        const r = await this.runCommand("winget", ["install", "--id", "Git.Git", "-e", "--accept-source-agreements", "--accept-package-agreements"], process.cwd(), progress);
        return r.code === 0 || this.getGitPath() !== null;
      }
      if (this.hasChoco()) {
        const r = await this.runCommand("choco", ["install", "git", "-y"], process.cwd(), progress);
        return r.code === 0 || this.getGitPath() !== null;
      }
    }

    if (process.platform === "linux") {
      // Try common package managers (may need sudo)
      for (const [cmd, args] of [
        ["apt-get", ["install", "-y", "git"]],
        ["dnf", ["install", "-y", "git"]],
        ["pacman", ["-S", "--noconfirm", "git"]],
        ["apk", ["add", "git"]],
      ] as [string, string[]][]) {
        if (this.findExecutable(cmd)) {
          const r = await this.runCommand("sudo", [cmd, ...args], process.cwd(), progress);
          if (r.code === 0 || this.getGitPath()) return true;
        }
      }
    }

    return false;
  }

  private async installNode(onProgress: ProgressCallback): Promise<boolean> {
    const progress = (line: string) =>
      onProgress({ stage: "checking", message: "Installing Node.js...", detail: line.slice(0, 100), percent: 6 });

    if (process.platform === "darwin") {
      if (this.hasHomebrew()) {
        let r = await this.runCommand("brew", ["install", "node@22"], process.cwd(), progress);
        if (r.code !== 0) {
          r = await this.runCommand("brew", ["install", "node"], process.cwd(), progress);
        }
        await this.runCommand("brew", ["link", "--overwrite", "node@22"], process.cwd());
        if (this.getNodeMajor() !== null && this.getNodeMajor()! >= 22) return true;
      }
      // Fallback to nvm
      return this.installNodeViaNvm(progress);
    }

    if (process.platform === "win32") {
      if (this.hasWinget()) {
        const r = await this.runCommand("winget", ["install", "--id", "OpenJS.NodeJS", "-e", "--accept-source-agreements", "--accept-package-agreements"], process.cwd(), progress);
        if (r.code === 0) return true;
      }
      if (this.hasChoco()) {
        const r = await this.runCommand("choco", ["install", "nodejs", "--version=22", "-y"], process.cwd(), progress);
        if (r.code === 0) return true;
      }
      // Fallback: download Node.js MSI via PowerShell
      onProgress({ stage: "checking", message: "Downloading Node.js installer...", detail: "This may take a minute", percent: 6 });
      const downloadScript = `
        $url = "https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi"
        $out = "$env:TEMP\\node-install.msi"
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
        Start-Process msiexec.exe -Wait -ArgumentList "/i $out /passive /norestart"
        Remove-Item $out -Force
      `;
      const r = await this.runCommand("powershell", ["-Command", downloadScript], process.cwd(), progress);
      return r.code === 0;
    }

    if (process.platform === "linux") {
      // Try distro package manager first
      for (const [cmd, args] of [
        ["apt-get", ["install", "-y", "nodejs", "npm"]],
        ["dnf", ["install", "-y", "nodejs", "npm"]],
        ["pacman", ["-S", "--noconfirm", "nodejs", "npm"]],
      ] as [string, string[]][]) {
        if (this.findExecutable(cmd)) {
          const r = await this.runCommand("sudo", [cmd, ...args], process.cwd(), progress);
          if (r.code === 0 && this.getNodeMajor() !== null && this.getNodeMajor()! >= 22) return true;
        }
      }
      // Fallback to nvm
      return this.installNodeViaNvm(progress);
    }

    return false;
  }

  private async installNodeViaNvm(progress: (line: string) => void): Promise<boolean> {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const nvmDir = path.join(home, ".nvm");

    if (!fs.existsSync(nvmDir)) {
      await this.runCommand(
        "/bin/bash",
        ["-c", "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"],
        process.cwd(),
        progress
      );
    }

    const r = await this.runCommand(
      "/bin/bash",
      ["-c", `export NVM_DIR="${nvmDir}" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm install 22 && nvm alias default 22`],
      process.cwd(),
      progress
    );

    return r.code === 0 || (this.getNodeMajor() !== null && this.getNodeMajor()! >= 22);
  }

  private async installPnpm(onProgress: ProgressCallback): Promise<boolean> {
    const progress = (line: string) =>
      onProgress({ stage: "checking", message: "Installing pnpm...", detail: line.slice(0, 100), percent: 9 });

    // Method 1: npm install -g pnpm
    const npm = this.findExecutable("npm");
    if (npm) {
      const r = await this.runCommand(npm, ["install", "-g", "pnpm"], process.cwd(), progress);
      if (r.code === 0 && this.getPnpmPath()) return true;
    }

    // Method 2: corepack
    const corepack = this.findExecutable("corepack");
    if (corepack) {
      await this.runCommand(corepack, ["enable"], process.cwd(), progress);
      const r = await this.runCommand(corepack, ["prepare", "pnpm@latest", "--activate"], process.cwd(), progress);
      if (r.code === 0 && this.getPnpmPath()) return true;
    }

    // Method 3: Standalone install script
    if (process.platform === "win32") {
      const r = await this.runCommand(
        "powershell",
        ["-Command", "iwr https://get.pnpm.io/install.ps1 -useb | iex"],
        process.cwd(), progress
      );
      return r.code === 0;
    } else {
      const r = await this.runCommand(
        "/bin/bash",
        ["-c", "curl -fsSL https://get.pnpm.io/install.sh | sh -"],
        process.cwd(), progress
      );
      return r.code === 0;
    }
  }

  private manualInstallHint(tool: string): string {
    const p = process.platform;
    switch (tool) {
      case "git":
        if (p === "darwin") return "Run: brew install git";
        if (p === "win32") return "Run: winget install Git.Git\nOr download from https://git-scm.com";
        return "Run: sudo apt install git (Ubuntu) or sudo dnf install git (Fedora)";
      case "node":
        if (p === "darwin") return "Run: brew install node@22";
        if (p === "win32") return "Run: winget install OpenJS.NodeJS\nOr download from https://nodejs.org";
        return "Run: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22";
      case "pnpm":
        return "Run: npm install -g pnpm\nOr visit https://pnpm.io/installation";
      default:
        return `Install ${tool} manually`;
    }
  }

  async setup(onProgress: ProgressCallback): Promise<boolean> {
    try {
      // Step 1: Check and auto-install prerequisites
      onProgress({ stage: "checking", message: "Checking environment...", percent: 2 });

      const prereqs = await this.checkPrerequisites();
      if (!prereqs.ok) {
        onProgress({
          stage: "checking",
          message: `Auto-installing: ${prereqs.missing.join(", ")}...`,
          percent: 3,
        });

        const installed = await this.autoInstallPrerequisites(onProgress);
        if (!installed) return false;
      }

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
        } else if (key === "dmPolicy") {
          config.channels[channel].dmPolicy = value;
          if (value === "open") {
            const existing = config.channels[channel].allowFrom || [];
            if (!existing.includes("*")) {
              config.channels[channel].allowFrom = ["*", ...existing];
            }
          }
        } else if (key === "appId" || key === "appSecret") {
          if (!config.channels[channel].accounts) config.channels[channel].accounts = {};
          if (!config.channels[channel].accounts.main) config.channels[channel].accounts.main = {};
          if (value === "") {
            delete config.channels[channel].accounts.main[key];
          } else {
            config.channels[channel].accounts.main[key] = value;
          }
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
