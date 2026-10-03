import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  findClaudeAppProcesses,
  isInsideClaude,
  locateConfig,
  mergeServerConfig,
  run,
  verifyWrittenConfig,
} from "../scripts/install-desktop.mjs";

const ENTRY = { command: "C:\\nodejs\\node.exe", args: ["C:\\cc-handoff\\dist\\index.js"] };
const CLAUDE_EXE = "C:\\Program Files\\WindowsApps\\Claude_2.19675.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe";

const SAMPLE = {
  coworkUserFilesPath: "C:\\Users\\x\\Documents\\Claude",
  preferences: { chromeExtensionEnabled: true, nested: { list: [1, 2, { a: "ü" }] } },
};

describe("mergeServerConfig", () => {
  it("adds the entry and keeps every other key", () => {
    const { changed, after } = mergeServerConfig(JSON.stringify(SAMPLE, null, 2), "cc-handoff", ENTRY);
    expect(changed).toBe(true);
    expect(after.mcpServers).toEqual({ "cc-handoff": ENTRY });
    const { mcpServers: _m, ...rest } = after;
    expect(rest).toEqual(SAMPLE);
  });

  it("keeps existing mcpServers entries", () => {
    const raw = JSON.stringify({ ...SAMPLE, mcpServers: { other: { command: "npx", args: ["x"] } } });
    const { after } = mergeServerConfig(raw, "cc-handoff", ENTRY);
    expect(after.mcpServers).toEqual({ other: { command: "npx", args: ["x"] }, "cc-handoff": ENTRY });
  });

  it("changes nothing on a second run", () => {
    const first = mergeServerConfig(JSON.stringify(SAMPLE), "cc-handoff", ENTRY);
    const second = mergeServerConfig(first.text, "cc-handoff", ENTRY);
    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
  });

  it("updates an outdated entry", () => {
    const raw = JSON.stringify({ mcpServers: { "cc-handoff": { command: "node", args: ["old.js"] } } });
    const { changed, after } = mergeServerConfig(raw, "cc-handoff", ENTRY);
    expect(changed).toBe(true);
    expect(after.mcpServers["cc-handoff"]).toEqual(ENTRY);
  });

  it("keeps key order and writes 2-space JSON", () => {
    const raw = JSON.stringify({ mcpServers: {}, b: 1, a: 2 });
    const { text } = mergeServerConfig(raw, "cc-handoff", ENTRY);
    expect(Object.keys(JSON.parse(text))).toEqual(["mcpServers", "b", "a"]);
    expect(text).toContain('\n  "b": 1');
  });

  it("preserves whether the file ended with a newline", () => {
    expect(mergeServerConfig("{}", "cc-handoff", ENTRY).text.endsWith("}")).toBe(true);
    expect(mergeServerConfig("{}\n", "cc-handoff", ENTRY).text.endsWith("}\n")).toBe(true);
  });

  it("accepts a UTF-8 BOM", () => {
    expect(mergeServerConfig("\uFEFF{}", "cc-handoff", ENTRY).changed).toBe(true);
  });

  it.each([
    ["broken JSON", '{"preferences": {'],
    ["empty file", ""],
    ["array root", "[]"],
    ["null root", "null"],
    ["mcpServers is an array", '{"mcpServers": []}'],
    ["mcpServers is a string", '{"mcpServers": "x"}'],
  ])("throws ConfigError on %s", (_label, raw) => {
    expect(() => mergeServerConfig(raw, "cc-handoff", ENTRY)).toThrow(ConfigError);
  });
});

describe("verifyWrittenConfig", () => {
  const before = { ...SAMPLE, mcpServers: { other: { command: "x" } } };

  it("passes for a correct write", () => {
    const { text } = mergeServerConfig(JSON.stringify(before), "cc-handoff", ENTRY);
    expect(() => verifyWrittenConfig(before, text, "cc-handoff", ENTRY)).not.toThrow();
  });

  it("fails when the entry is missing", () => {
    expect(() => verifyWrittenConfig(before, JSON.stringify(before), "cc-handoff", ENTRY)).toThrow(ConfigError);
  });

  it("fails when another key changed", () => {
    const tampered = { ...before, preferences: {}, mcpServers: { ...before.mcpServers, "cc-handoff": ENTRY } };
    expect(() => verifyWrittenConfig(before, JSON.stringify(tampered), "cc-handoff", ENTRY)).toThrow(ConfigError);
  });

  it("fails when another server entry was dropped", () => {
    const dropped = { ...SAMPLE, mcpServers: { "cc-handoff": ENTRY } };
    expect(() => verifyWrittenConfig(before, JSON.stringify(dropped), "cc-handoff", ENTRY)).toThrow(ConfigError);
  });
});

describe("process detection", () => {
  const processes = [
    { ProcessId: 1, ParentProcessId: 0, ExecutablePath: "C:\\Windows\\explorer.exe" },
    { ProcessId: 10, ParentProcessId: 1, ExecutablePath: CLAUDE_EXE },
    { ProcessId: 11, ParentProcessId: 10, ExecutablePath: "C:\\Users\\x\\AppData\\Roaming\\Claude\\claude-code\\2.1.286\\claude.exe" },
    { ProcessId: 12, ParentProcessId: 11, ExecutablePath: "C:\\Program Files\\nodejs\\node.exe" },
    { ProcessId: 20, ParentProcessId: 1, ExecutablePath: "C:\\Windows\\System32\\cmd.exe" },
    { ProcessId: 21, ParentProcessId: 20, ExecutablePath: "C:\\Program Files\\nodejs\\node.exe" },
    { ProcessId: 30, ParentProcessId: 1, ExecutablePath: "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.exe" },
    { ProcessId: 40, ParentProcessId: 4, ExecutablePath: null },
  ];

  it("matches Claude Desktop by install path, not by name", () => {
    expect(findClaudeAppProcesses(processes).map((p) => p.ProcessId)).toEqual([10]);
  });

  it("detects running inside Claude's process tree", () => {
    expect(isInsideClaude(processes, 12)).toBe(true);
    expect(isInsideClaude(processes, 21)).toBe(false);
    expect(isInsideClaude(processes, 999)).toBe(false);
  });

  it("does not loop on a parent cycle", () => {
    const cyclic = [
      { ProcessId: 1, ParentProcessId: 2, ExecutablePath: "a.exe" },
      { ProcessId: 2, ParentProcessId: 1, ExecutablePath: "b.exe" },
    ];
    expect(isInsideClaude(cyclic, 1)).toBe(false);
  });
});

describe("locateConfig", () => {
  let root: string;
  let env: { LOCALAPPDATA: string; APPDATA: string };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-handoff-locate-"));
    env = { LOCALAPPDATA: path.join(root, "Local"), APPDATA: path.join(root, "Roaming") };
    await fs.mkdir(path.join(env.LOCALAPPDATA, "Packages"), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function addPackage(name: string, withConfig = true) {
    const dir = path.join(env.LOCALAPPDATA, "Packages", name, "LocalCache", "Roaming", "Claude");
    await fs.mkdir(dir, { recursive: true });
    if (withConfig) await fs.writeFile(path.join(dir, "claude_desktop_config.json"), "{}");
    return path.join(dir, "claude_desktop_config.json");
  }
  async function addClassic() {
    await fs.mkdir(path.join(env.APPDATA, "Claude"), { recursive: true });
    const file = path.join(env.APPDATA, "Claude", "claude_desktop_config.json");
    await fs.writeFile(file, "{}");
    return file;
  }

  it("finds the MSIX LocalCache config and derives the package family", async () => {
    const file = await addPackage("Claude_pzs8sxrjxfjjc");
    await addClassic();
    expect(locateConfig(env)).toEqual({ configPath: file, packageFamily: "Claude_pzs8sxrjxfjjc" });
  });

  it("ignores Claude-3p and unrelated packages", async () => {
    await fs.mkdir(path.join(env.LOCALAPPDATA, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude-3p"), {
      recursive: true,
    });
    await addPackage("SomethingClaude_abcdefghijklm");
    const classic = await addClassic();
    // The Claude_ package exists, but only with a Claude-3p config: no fallback to %APPDATA%.
    expect(() => locateConfig(env)).toThrow(/no config yet/);
    await fs.rm(path.join(env.LOCALAPPDATA, "Packages", "Claude_pzs8sxrjxfjjc"), { recursive: true });
    expect(locateConfig(env)).toEqual({ configPath: classic, packageFamily: null });
  });

  it("accepts the AnthropicPBC.Claude_ package family", async () => {
    const file = await addPackage("AnthropicPBC.Claude_fnn82j28hfe8t");
    expect(locateConfig(env)).toEqual({ configPath: file, packageFamily: "AnthropicPBC.Claude_fnn82j28hfe8t" });
  });

  it("refuses when more than one MSIX config exists", async () => {
    await addPackage("Claude_pzs8sxrjxfjjc");
    await addPackage("AnthropicPBC.Claude_fnn82j28hfe8t");
    expect(() => locateConfig(env)).toThrow(/more than one/);
  });

  it("uses the package that has a config when others are leftovers", async () => {
    await addPackage("AnthropicPBC.Claude_fnn82j28hfe8t", false);
    const file = await addPackage("Claude_pzs8sxrjxfjjc");
    expect(locateConfig(env).configPath).toBe(file);
  });

  it("falls back to %APPDATA% when there is no MSIX package", async () => {
    const file = await addClassic();
    expect(locateConfig(env)).toEqual({ configPath: file, packageFamily: null });
  });

  it("explains what it checked when nothing is found", () => {
    expect(() => locateConfig(env)).toThrow(/No Claude Desktop config found/);
  });
});

describe("run", () => {
  let root: string;
  let configPath: string;
  let serverPath: string;
  let logs: string[];

  const original = JSON.stringify(SAMPLE, null, 2);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-handoff-run-"));
    configPath = path.join(root, "claude_desktop_config.json");
    serverPath = path.join(root, "index.js");
    await fs.writeFile(configPath, original);
    await fs.writeFile(serverPath, "");
    logs = [];
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function deps(processLists: object[][] = [[]], extra: Record<string, unknown> = {}) {
    let call = 0;
    const launched: string[] = [];
    return {
      launched,
      deps: {
        platform: "win32",
        pid: 500,
        listProcesses: async () => processLists[Math.min(call++, processLists.length - 1)],
        launch: (family: string) => launched.push(family),
        sleep: async () => {},
        log: (msg: string) => logs.push(msg),
        ...extra,
      },
    };
  }
  const opts = (extra = {}) => ({ configPath, serverPath, nodePath: ENTRY.command, ...extra });
  const files = async () => (await fs.readdir(root)).sort();

  it("writes the entry, makes a backup and verifies", async () => {
    expect(await run(opts(), deps().deps)).toBe(0);
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.mcpServers["cc-handoff"]).toEqual({ command: ENTRY.command, args: [serverPath] });
    const backups = (await files()).filter((f) => f.includes(".bak-"));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(root, backups[0]), "utf8")).toBe(original);
    expect(logs.join("\n")).toMatch(/verified/);
  });

  it("is idempotent: a second run writes nothing and makes no new backup", async () => {
    await run(opts(), deps().deps);
    const afterFirst = await fs.readFile(configPath, "utf8");
    const filesAfterFirst = await files();
    expect(await run(opts(), deps().deps)).toBe(0);
    expect(await fs.readFile(configPath, "utf8")).toBe(afterFirst);
    expect(await files()).toEqual(filesAfterFirst);
  });

  it("dry-run changes nothing", async () => {
    const running = [{ ProcessId: 10, ParentProcessId: 1, ExecutablePath: CLAUDE_EXE }];
    expect(await run(opts({ dryRun: true }), deps([running]).deps)).toBe(0);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(await files()).toEqual(["claude_desktop_config.json", "index.js"]);
    expect(logs.join("\n")).toMatch(/would wait/);
  });

  it("does not write when the config is broken JSON", async () => {
    await fs.writeFile(configPath, '{"preferences": {');
    expect(await run(opts(), deps().deps)).toBe(1);
    expect(await fs.readFile(configPath, "utf8")).toBe('{"preferences": {');
    expect(await files()).toEqual(["claude_desktop_config.json", "index.js"]);
  });

  it("waits for Claude to quit and merges against the file Claude wrote on exit", async () => {
    const running = [{ ProcessId: 10, ParentProcessId: 1, ExecutablePath: CLAUDE_EXE }];
    const { deps: d } = deps([running, running, []], {
      // Simulate Claude rewriting its config while quitting.
      sleep: async () => {
        await fs.writeFile(configPath, JSON.stringify({ ...SAMPLE, preferences: { savedOnQuit: true } }));
      },
    });
    expect(await run(opts(), d)).toBe(0);
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.preferences).toEqual({ savedOnQuit: true });
    expect(written.mcpServers["cc-handoff"]).toBeDefined();
    expect(logs.join("\n")).toMatch(/Quit/);
  });

  it("gives up after the timeout without writing", async () => {
    const running = [{ ProcessId: 10, ParentProcessId: 1, ExecutablePath: CLAUDE_EXE }];
    let clock = 0;
    const { deps: d } = deps([running], {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    });
    expect(await run(opts(), d)).toBe(1);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });

  it("refuses to install from inside Claude's process tree", async () => {
    const tree = [
      { ProcessId: 10, ParentProcessId: 1, ExecutablePath: CLAUDE_EXE },
      { ProcessId: 500, ParentProcessId: 10, ExecutablePath: "C:\\nodejs\\node.exe" },
    ];
    expect(await run(opts(), deps([tree]).deps)).toBe(1);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(logs.join("\n")).toMatch(/install-desktop\.cmd/);
  });

  it("relaunches the MSIX app by package family", async () => {
    const env = { LOCALAPPDATA: path.join(root, "Local"), APPDATA: path.join(root, "Roaming") };
    const dir = path.join(env.LOCALAPPDATA, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "claude_desktop_config.json"), "{}");
    const { deps: d, launched } = deps([[]], { env });
    expect(await run({ serverPath, nodePath: ENTRY.command }, d)).toBe(0);
    expect(launched).toEqual(["Claude_pzs8sxrjxfjjc"]);
  });

  it("exits with a clear message on non-Windows platforms", async () => {
    expect(await run(opts(), deps([[]], { platform: "darwin" }).deps)).toBe(1);
    expect(logs[0]).toMatch(/Windows/);
  });

  it("asks for a build when dist/index.js is missing", async () => {
    expect(await run(opts({ serverPath: path.join(root, "missing.js") }), deps().deps)).toBe(1);
    expect(logs.join("\n")).toMatch(/npm run build/);
  });
});
