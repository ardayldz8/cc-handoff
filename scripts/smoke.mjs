// End-to-end smoke test: starts the built server over stdio and runs one
// task -> report cycle through all five tools with the MCP SDK client.
// Uses a throwaway HANDOFF_DIR so it never touches ~/.cc-handoff.

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "dist", "index.js");
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-handoff-smoke-"));
const project = "smoke-test";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, HANDOFF_DIR: dataDir },
  stderr: "pipe",
});
const client = new Client({ name: "cc-handoff-smoke", version: "0.0.0" });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => c.text).join("\n");
  return { text, isError: Boolean(result.isError) };
}

function step(label, detail) {
  console.log(`ok  ${label}${detail ? `  ->  ${detail.split("\n")[0]}` : ""}`);
}

try {
  await client.connect(transport);
  step("connected to server over stdio");

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["create_task", "get_next_task", "get_report", "list_tasks", "submit_report"]);
  step("listTools", names.join(", "));

  let r = await call("create_task", { project, title: "Smoke task", body: "Say hello in the report." });
  assert.ok(!r.isError && r.text.includes("P001"), r.text);
  step("create_task", r.text);

  r = await call("list_tasks", { project });
  assert.equal(r.text, "P001 [open] Smoke task");
  step("list_tasks", r.text);

  r = await call("get_next_task", { project });
  assert.ok(r.text.includes("P001: Smoke task") && r.text.includes("status: in_progress"), r.text);
  assert.ok(r.text.includes("Say hello in the report."), r.text);
  step("get_next_task", r.text);

  r = await call("get_next_task", { project });
  assert.equal(r.text, `No open tasks in project ${project}.`);
  step("get_next_task (queue empty)", r.text);

  r = await call("submit_report", { project, task_id: "P001", body: "Hello from Claude Code." });
  assert.ok(!r.isError && r.text.includes("status: reported"), r.text);
  step("submit_report", r.text);

  r = await call("get_report", { project });
  assert.ok(r.text.includes("Report for P001: Smoke task") && r.text.includes("Hello from Claude Code."), r.text);
  step("get_report (latest)", r.text);

  r = await call("get_report", { project, task_id: "P001" });
  assert.ok(r.text.includes("Hello from Claude Code."), r.text);
  step("get_report (by id)", r.text);

  r = await call("list_tasks", { project });
  assert.equal(r.text, "P001 [reported] Smoke task");
  step("list_tasks", r.text);

  r = await call("list_tasks", { project: "../escape" });
  assert.ok(r.isError, "path traversal should be rejected");
  step("list_tasks rejects ../escape", r.text.replace(/\s+/g, " ").slice(0, 80));

  const files = (await fs.readdir(path.join(dataDir, project))).sort();
  assert.deepEqual(files, ["P001-report.md", "P001-task.md"]);
  step("files on disk", files.join(", "));

  console.log("\nSMOKE PASSED");
} catch (err) {
  console.error("\nSMOKE FAILED");
  console.error(err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
}
