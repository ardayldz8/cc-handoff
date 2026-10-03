import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HandoffStore, PROJECT_SLUG_RE, StoreError, TASK_ID_RE, type Task } from "./store.js";

// stdout carries the MCP protocol; log to stderr only.

const baseDir = process.env.HANDOFF_DIR || path.join(os.homedir(), ".cc-handoff");
const store = new HandoffStore(baseDir);

const server = new McpServer({ name: "cc-handoff", version: "0.1.0" });

const project = z
  .string()
  .regex(PROJECT_SLUG_RE, "Use lowercase letters, digits and hyphens only.")
  .describe("Project slug: lowercase letters, digits and hyphens (e.g. my-app).");
const taskId = z.string().regex(TASK_ID_RE, "Expected a task ID like P001.").describe("Task ID, e.g. P001.");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** Turns store errors into tool errors the model can read and act on. */
function tool<A>(handler: (args: A) => Promise<string>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return text(await handler(args));
    } catch (err) {
      if (err instanceof StoreError) return { ...text(err.message), isError: true };
      throw err;
    }
  };
}

function formatTask(task: Task): string {
  return [
    `# ${task.id}: ${task.title}`,
    `project: ${task.project} | status: ${task.status} | created: ${task.created_at}`,
    "",
    task.body,
  ].join("\n");
}

server.registerTool(
  "create_task",
  {
    title: "Create task",
    description:
      "Planner: create a new task for Claude Code in a project. Gets the next ID (P001, P002, ...) and status open.",
    inputSchema: {
      project,
      title: z.string().min(1).describe("Short task title."),
      body: z.string().describe("Full task description in Markdown."),
    },
  },
  tool(async ({ project, title, body }: { project: string; title: string; body: string }) => {
    const task = await store.createTask(project, title, body);
    return `Created ${task.id} "${task.title}" in project ${task.project} (status: open).`;
  }),
);

server.registerTool(
  "get_next_task",
  {
    title: "Get next task",
    description:
      "Claude Code: take the oldest open task in a project. Returns its ID, title and body and marks it in_progress.",
    inputSchema: { project },
  },
  tool(async ({ project }: { project: string }) => {
    const task = await store.claimNextTask(project);
    if (!task) return `No open tasks in project ${project}.`;
    return `${formatTask(task)}\n\n---\nWhen done, call submit_report with project "${project}" and task_id "${task.id}".`;
  }),
);

server.registerTool(
  "submit_report",
  {
    title: "Submit report",
    description: "Claude Code: save the report for a task and mark the task reported.",
    inputSchema: {
      project,
      task_id: taskId,
      body: z.string().min(1).describe("Report in Markdown."),
    },
  },
  tool(async ({ project, task_id, body }: { project: string; task_id: string; body: string }) => {
    const { task } = await store.submitReport(project, task_id, body);
    return `Report saved for ${task.id} "${task.title}" (status: reported).`;
  }),
);

server.registerTool(
  "get_report",
  {
    title: "Get report",
    description:
      "Planner: read a task's report. Without task_id, returns the most recently submitted report in the project.",
    inputSchema: { project, task_id: taskId.optional() },
  },
  tool(async ({ project, task_id }: { project: string; task_id?: string }) => {
    const report = task_id ? await store.getReport(project, task_id) : await store.getLatestReport(project);
    if (!report) {
      if (!task_id) return `No reports yet in project ${project}.`;
      const task = await store.getTask(project, task_id);
      if (!task) throw new StoreError(`Task ${task_id} not found in project "${project}".`);
      return `No report yet for ${task_id} (status: ${task.status}).`;
    }
    const task = await store.getTask(project, report.task_id);
    const heading = task ? `${report.task_id}: ${task.title}` : report.task_id;
    return `# Report for ${heading}\nsubmitted: ${report.submitted_at}\n\n${report.body}`;
  }),
);

server.registerTool(
  "list_tasks",
  {
    title: "List tasks",
    description: "List all tasks in a project with ID, title and status.",
    inputSchema: { project },
  },
  tool(async ({ project }: { project: string }) => {
    const tasks = await store.listTasks(project);
    if (tasks.length === 0) return `No tasks in project ${project}.`;
    return tasks.map((t) => `${t.id} [${t.status}] ${t.title}`).join("\n");
  }),
);

await server.connect(new StdioServerTransport());
console.error(`cc-handoff MCP server running (data dir: ${store.baseDir})`);
