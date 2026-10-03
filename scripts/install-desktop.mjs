// Registers cc-handoff in Claude Desktop's config (Windows).
//
// Claude Desktop keeps its config in memory and rewrites the whole file on
// every settings change, so edits made while it runs are lost. This script
// waits until Desktop is fully closed, then edits the file, verifies it and
// relaunches the app. Usage: node scripts/install-desktop.mjs [--dry-run] [--config <path>]
// No dependencies: process detection uses PowerShell, which ships with Windows.

import { execFile, spawn } from "node:child_process";
import { promises as fsp, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

export const SERVER_NAME = "cc-handoff";
export const CONFIG_FILE = "claude_desktop_config.json";
export const WAIT_TIMEOUT_MS = 5 * 60 * 1000;
export const POLL_INTERVAL_MS = 3000;

// Package family folders look like Claude_pzs8sxrjxfjjc (13-char publisher ID).
// The app bundle also references an AnthropicPBC.Claude_ family, so accept both.
const PACKAGE_DIR_RE = /^(?:AnthropicPBC\.)?Claude_[a-z0-9]{13}$/i;
// MSIX installs run from WindowsApps; the classic (Squirrel) installer uses %LOCALAPPDATA%\AnthropicClaude.
const CLAUDE_APP_PATH_RE = /\\windowsapps\\(?:anthropicpbc\.)?claude_|\\appdata\\local\\anthropicclaude\\/i;

export class ConfigError extends Error {}

// --- Pure helpers ------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adds or updates mcpServers[name] = entry, keeping every other key as-is.
 * Returns { changed, before, after, text }; throws ConfigError on invalid input.
 */
export function mergeServerConfig(rawText, name, entry) {
  let before;
  try {
    before = JSON.parse(rawText.replace(/^﻿/, ""));
  } catch (err) {
    throw new ConfigError(`Config is not valid JSON: ${err.message}`);
  }
  if (!isPlainObject(before)) throw new ConfigError("Config root is not a JSON object.");
  if (before.mcpServers !== undefined && !isPlainObject(before.mcpServers)) {
    throw new ConfigError('"mcpServers" in the config is not an object.');
  }

  const changed = !isDeepStrictEqual(before.mcpServers?.[name], entry);
  const after = { ...before, mcpServers: { ...(before.mcpServers ?? {}), [name]: entry } };
  const text = JSON.stringify(after, null, 2) + (/\n\s*$/.test(rawText) ? "\n" : "");
  return { changed, before, after, text };
}

/** Throws unless writtenText holds the entry and everything else from `before` unchanged. */
export function verifyWrittenConfig(before, writtenText, name, entry) {
  let written;
  try {
    written = JSON.parse(writtenText.replace(/^﻿/, ""));
  } catch (err) {
    throw new ConfigError(`Written config is not valid JSON: ${err.message}`);
  }
  if (!isDeepStrictEqual(written.mcpServers?.[name], entry)) {
    throw new ConfigError(`Written config does not contain the expected "${name}" entry.`);
  }
  const { mcpServers: writtenServers, ...writtenRest } = written;
  const { mcpServers: beforeServers = {}, ...beforeRest } = before;
  const { [name]: _ignored, ...otherBefore } = beforeServers;
  const { [name]: _entry, ...otherWritten } = writtenServers;
  if (!isDeepStrictEqual(writtenRest, beforeRest) || !isDeepStrictEqual(otherWritten, otherBefore)) {
    throw new ConfigError("Written config differs from the original outside the cc-handoff entry.");
  }
}

export function isClaudeAppPath(executablePath) {
  return typeof executablePath === "string" && CLAUDE_APP_PATH_RE.test(executablePath);
}

/** Running Claude Desktop processes (matched by install path, not by name). */
export function findClaudeAppProcesses(processes) {
  return processes.filter((p) => isClaudeAppPath(p.ExecutablePath));
}

/** True if any ancestor of `pid` is a Claude Desktop process. */
export function isInsideClaude(processes, pid) {
  const byPid = new Map(processes.map((p) => [p.ProcessId, p]));
  const seen = new Set();
  let current = byPid.get(pid);
  while (current && !seen.has(current.ProcessId)) {
    seen.add(current.ProcessId);
    const parent = byPid.get(current.ParentProcessId);
    if (parent && isClaudeAppPath(parent.ExecutablePath)) return true;
    current = parent;
  }
  return false;
}

/**
 * Finds the config Claude Desktop actually reads, using the app's own rule:
 * an MSIX install redirects %APPDATA%\Claude to <package>\LocalCache\Roaming\Claude
 * only if that folder exists; otherwise (e.g. upgraded from the classic installer)
 * it reads the real %APPDATA%\Claude. Non-MSIX installs always use %APPDATA%\Claude.
 * Returns { configPath, packageFamily | null } or throws ConfigError describing what was found.
 */
export function locateConfig(env) {
  const openOnce = "Open Claude Desktop once so it creates its config, quit it, then run this again.";
  const packagesDir = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Packages") : null;
  const packages = packagesDir && existsSync(packagesDir) ? readdirSync(packagesDir).filter((n) => PACKAGE_DIR_RE.test(n)) : [];
  const classic = env.APPDATA ? path.join(env.APPDATA, "Claude", CONFIG_FILE) : null;
  const describe = (p) => `${p} (${existsSync(p) ? "exists" : "missing"})`;

  const virtualized = packages
    .map((name) => ({ packageFamily: name, dir: path.join(packagesDir, name, "LocalCache", "Roaming", "Claude") }))
    .filter((p) => existsSync(p.dir))
    .map((p) => ({ ...p, configPath: path.join(p.dir, CONFIG_FILE) }));
  const listing = virtualized.map((p) => describe(p.configPath)).join("\n  ");

  if (virtualized.length > 0) {
    const withConfig = virtualized.filter((p) => existsSync(p.configPath));
    if (withConfig.length === 1) return { configPath: withConfig[0].configPath, packageFamily: withConfig[0].packageFamily };
    if (withConfig.length > 1 || virtualized.length > 1) {
      throw new ConfigError(`Found more than one Claude Desktop config location; not sure which one to edit:\n  ${listing}`);
    }
    // Virtualized MSIX install without a config yet: %APPDATA%\Claude would not be read.
    throw new ConfigError(`Claude Desktop (MSIX) has no config yet:\n  ${listing}\n${openOnce}`);
  }

  // No package, or an MSIX package without virtualization: the app reads the real %APPDATA%\Claude.
  const packageFamily = packages.length === 1 ? packages[0] : null;
  if (classic && existsSync(classic)) return { configPath: classic, packageFamily };
  throw new ConfigError(
    "No Claude Desktop config found. Checked:\n  " +
      `${packagesDir ?? "%LOCALAPPDATA%\\Packages"}\\Claude_*\\LocalCache\\Roaming\\Claude (${packages.length ? "absent" : "no package"})\n  ` +
      `${classic ? describe(classic) : "%APPDATA% (not set)"}\n${openOnce}`,
  );
}

export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// --- Side effects ------------------------------------------------------------

/** All processes with parent and executable path, via PowerShell (built into Windows). */
export function listProcesses() {
  const command =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error(`Could not list processes with PowerShell: ${err.message}`));
        try {
          const parsed = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (parseErr) {
          reject(new Error(`Could not parse the process list: ${parseErr.message}`));
        }
      },
    );
  });
}

function launchClaude(packageFamily) {
  const child = spawn("explorer.exe", [`shell:AppsFolder\\${packageFamily}!Claude`], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

async function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, content, "utf8");
  try {
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

const QUIT_MESSAGE = [
  "Claude Desktop is still running. Quit it completely: right-click the Claude icon",
  "in the system tray and choose Quit (closing the window is not enough).",
  "Claude Desktop hâlâ çalışıyor. Sistem tepsisindeki Claude simgesine sağ tıklayıp",
  "Quit ile tamamen kapat (pencereyi kapatmak yetmez).",
].join("\n");

/**
 * Runs the installer. `deps` lets tests replace process listing, sleeping and launching.
 * Returns an exit code.
 */
export async function run(opts, deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    pid = process.pid,
    listProcesses: list = listProcesses,
    launch = launchClaude,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = console.log,
    now = () => Date.now(),
    pollIntervalMs = POLL_INTERVAL_MS,
    waitTimeoutMs = WAIT_TIMEOUT_MS,
  } = deps;
  const dryRun = Boolean(opts.dryRun);
  const say = (msg) => log(dryRun ? `[dry-run] ${msg}` : msg);

  if (platform !== "win32") {
    log("This installer is for Windows. On macOS, add the server to");
    log("~/Library/Application Support/Claude/claude_desktop_config.json by hand (see README).");
    return 1;
  }

  const serverPath = opts.serverPath;
  if (!existsSync(serverPath)) {
    log(`Server not built: ${serverPath} is missing. Run "npm install" and "npm run build" first.`);
    return 1;
  }
  const entry = { command: opts.nodePath, args: [serverPath] };

  let target;
  try {
    target = opts.configPath ? { configPath: path.resolve(opts.configPath), packageFamily: null } : locateConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
  const { configPath, packageFamily } = target;
  say(`Config: ${configPath}`);
  if (packageFamily) say(`Package: ${packageFamily} (MSIX)`);

  // Read-only pass first: if nothing would change, the user need not quit Claude.
  let merged;
  try {
    merged = mergeServerConfig(await fsp.readFile(configPath, "utf8"), SERVER_NAME, entry);
  } catch (err) {
    if (err instanceof ConfigError) {
      log(`${err.message}\nNothing was written. Fix or restore the file, then run this again.`);
      return 1;
    }
    throw err;
  }
  if (!merged.changed) {
    say(`"${SERVER_NAME}" is already registered with the same settings. Nothing to do.`);
    return 0;
  }
  say(`Will set mcpServers["${SERVER_NAME}"] = ${JSON.stringify(entry)}`);

  const processes = await list();
  const running = findClaudeAppProcesses(processes);
  const inside = isInsideClaude(processes, pid);

  if (dryRun) {
    if (inside) say("Note: this is running inside Claude; the real install must run from install-desktop.cmd.");
    say(
      running.length > 0
        ? `Claude Desktop is running (${running.length} processes); would wait up to ${waitTimeoutMs / 60000} min for it to quit.`
        : "Claude Desktop is not running.",
    );
    say(`Would back up to ${configPath}.bak-${timestamp()}`);
    say("Would write the config atomically and verify it.");
    say(packageFamily ? `Would relaunch: explorer.exe shell:AppsFolder\\${packageFamily}!Claude` : "Would ask you to open Claude Desktop.");
    say("No changes made.");
    return 0;
  }

  if (inside) {
    log("This script is running inside Claude Desktop (for example from a Claude Code session),");
    log("so it would be killed when Claude quits. Double-click install-desktop.cmd in Explorer instead.");
    return 1;
  }

  if (running.length > 0) {
    log(QUIT_MESSAGE);
    log("Waiting for Claude to exit... / Claude'un kapanması bekleniyor...");
    const deadline = now() + waitTimeoutMs;
    let stillRunning = running;
    while (stillRunning.length > 0) {
      if (now() >= deadline) {
        log(`Claude was still running after ${waitTimeoutMs / 60000} minutes. Nothing was changed.`);
        return 1;
      }
      await sleep(pollIntervalMs);
      stillRunning = findClaudeAppProcesses(await list());
    }
    log("Claude has exited. / Claude kapandı.");

    // Claude rewrites the config once more while quitting; merge against that version.
    try {
      merged = mergeServerConfig(await fsp.readFile(configPath, "utf8"), SERVER_NAME, entry);
    } catch (err) {
      if (err instanceof ConfigError) {
        log(`${err.message}\nNothing was written.`);
        return 1;
      }
      throw err;
    }
  }

  if (merged.changed) {
    const backupPath = `${configPath}.bak-${timestamp()}`;
    await fsp.copyFile(configPath, backupPath);
    log(`Backup: ${backupPath}`);
    await writeFileAtomic(configPath, merged.text);
    try {
      verifyWrittenConfig(merged.before, await fsp.readFile(configPath, "utf8"), SERVER_NAME, entry);
    } catch (err) {
      log(`Verification failed: ${err.message}`);
      log(`Restore the backup if Claude misbehaves: ${backupPath}`);
      return 1;
    }
    log(`Added "${SERVER_NAME}" to the Claude Desktop config and verified it.`);
  } else {
    log(`"${SERVER_NAME}" is already registered with the same settings.`);
  }

  if (packageFamily) {
    launch(packageFamily);
    log("Starting Claude Desktop. Check Settings > Developer for cc-handoff.");
    log("Claude Desktop başlatılıyor. Settings > Developer altında cc-handoff görünmeli.");
  } else {
    log("Open Claude Desktop and check Settings > Developer for cc-handoff.");
    log("Claude Desktop'ı açıp Settings > Developer altında cc-handoff'u kontrol et.");
  }
  return 0;
}

function parseArgs(argv) {
  const opts = { dryRun: false, configPath: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--config") opts.configPath = argv[++i];
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.configPath === undefined && argv.includes("--config")) throw new Error("--config needs a path.");
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log("Usage: node scripts/install-desktop.mjs [--dry-run] [--config <path>]");
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = await run({
    ...opts,
    nodePath: process.execPath,
    serverPath: path.join(root, "dist", "index.js"),
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
if (invokedPath === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
