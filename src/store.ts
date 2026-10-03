import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const TASK_STATUSES = ["open", "in_progress", "reported", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PROJECT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TASK_ID_RE = /^P\d{3,}$/;

const TASK_FILE_RE = /^(P\d{3,})-task\.md$/;
const REPORT_FILE_RE = /^(P\d{3,})-report\.md$/;

export interface TaskMeta {
  id: string;
  project: string;
  title: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface Task extends TaskMeta {
  body: string;
}

export interface Report {
  task_id: string;
  project: string;
  submitted_at: string;
  body: string;
}

export class StoreError extends Error {}

/** File-based task/report store. One sub-directory per project. */
export class HandoffStore {
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  async createTask(project: string, title: string, body: string): Promise<Task> {
    const dir = this.projectDir(project);
    await fs.mkdir(dir, { recursive: true });
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new StoreError("Title must not be empty.");

    // Exclusive create: if another process grabbed the same number, try the next one.
    let next = (await this.maxTaskNumber(project)) + 1;
    for (let attempt = 0; attempt < 20; attempt++, next++) {
      const now = new Date().toISOString();
      const task: Task = {
        id: formatTaskId(next),
        project,
        title: cleanTitle,
        status: "open",
        created_at: now,
        updated_at: now,
        body,
      };
      if (await writeFileAtomic(this.taskPath(project, task.id), serializeTask(task), { exclusive: true })) {
        return task;
      }
    }
    throw new StoreError("Could not allocate a task ID; too many concurrent writers.");
  }

  async getTask(project: string, taskId: string): Promise<Task | null> {
    const raw = await readIfExists(this.taskPath(project, taskId));
    return raw === null ? null : parseTask(raw);
  }

  async listTasks(project: string): Promise<TaskMeta[]> {
    const ids = await this.listIds(project, TASK_FILE_RE);
    const tasks: TaskMeta[] = [];
    for (const id of ids) {
      const task = await this.getTask(project, id);
      if (task) {
        const { body: _body, ...meta } = task;
        tasks.push(meta);
      }
    }
    return tasks;
  }

  /** Claims the oldest open task (lowest ID) and marks it in_progress. */
  async claimNextTask(project: string): Promise<Task | null> {
    for (const id of await this.listIds(project, TASK_FILE_RE)) {
      const task = await this.getTask(project, id);
      if (task?.status === "open") {
        return this.saveTask({ ...task, status: "in_progress" });
      }
    }
    return null;
  }

  async submitReport(project: string, taskId: string, body: string): Promise<{ task: Task; report: Report }> {
    const task = await this.getTask(project, taskId);
    if (!task) throw new StoreError(`Task ${taskId} not found in project "${project}".`);
    if (task.status === "closed") throw new StoreError(`Task ${taskId} is closed; reports are no longer accepted.`);

    const report: Report = { task_id: taskId, project, submitted_at: new Date().toISOString(), body };
    await writeFileAtomic(this.reportPath(project, taskId), serializeReport(report));
    const updated = await this.saveTask({ ...task, status: "reported" });
    return { task: updated, report };
  }

  async getReport(project: string, taskId: string): Promise<Report | null> {
    const raw = await readIfExists(this.reportPath(project, taskId));
    return raw === null ? null : parseReport(raw);
  }

  /** Most recently submitted report in the project (ties broken by higher task ID). */
  async getLatestReport(project: string): Promise<Report | null> {
    let latest: Report | null = null;
    for (const id of await this.listIds(project, REPORT_FILE_RE)) {
      const report = await this.getReport(project, id);
      if (report && (!latest || report.submitted_at >= latest.submitted_at)) latest = report;
    }
    return latest;
  }

  private async saveTask(task: Task): Promise<Task> {
    const updated = { ...task, updated_at: new Date().toISOString() };
    await writeFileAtomic(this.taskPath(task.project, task.id), serializeTask(updated));
    return updated;
  }

  private async maxTaskNumber(project: string): Promise<number> {
    const ids = await this.listIds(project, TASK_FILE_RE);
    return ids.reduce((max, id) => Math.max(max, taskNumber(id)), 0);
  }

  /** IDs of files in the project dir matching `re`, sorted by task number. */
  private async listIds(project: string, re: RegExp): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.projectDir(project));
    } catch (err) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
    return names
      .map((name) => re.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort((a, b) => taskNumber(a) - taskNumber(b));
  }

  private projectDir(project: string): string {
    if (!PROJECT_SLUG_RE.test(project)) {
      throw new StoreError(`Invalid project "${project}": use lowercase letters, digits and hyphens only.`);
    }
    const dir = path.resolve(this.baseDir, project);
    if (path.dirname(dir) !== this.baseDir) throw new StoreError(`Invalid project "${project}".`);
    return dir;
  }

  private taskPath(project: string, taskId: string): string {
    assertTaskId(taskId);
    return path.join(this.projectDir(project), `${taskId}-task.md`);
  }

  private reportPath(project: string, taskId: string): string {
    assertTaskId(taskId);
    return path.join(this.projectDir(project), `${taskId}-report.md`);
  }
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) throw new StoreError(`Invalid task ID "${taskId}": expected a form like P001.`);
}

function formatTaskId(n: number): string {
  return `P${String(n).padStart(3, "0")}`;
}

function taskNumber(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

// --- Frontmatter -------------------------------------------------------------
// Plain identifiers are written bare; everything else as a JSON string, which is
// also a valid YAML double-quoted scalar. No YAML library needed.

function serializeFrontmatter(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${formatValue(value)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/\s+$/, "")}\n`;
}

function formatValue(value: string): string {
  const bare = /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !/^(true|false|yes|no|on|off|null)$/i.test(value);
  return bare ? value : JSON.stringify(value);
}

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new StoreError("File is missing YAML frontmatter.");
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    fields[key] = value.startsWith('"') ? JSON.parse(value) : value.replace(/^'(.*)'$/, "$1");
  }
  return { fields, body: match[2].replace(/^\n/, "").replace(/\s+$/, "") };
}

function serializeTask(task: Task): string {
  const { body, ...meta } = task;
  return serializeFrontmatter({ ...meta }, body);
}

function parseTask(raw: string): Task {
  const { fields, body } = parseFrontmatter(raw);
  const status = fields.status as TaskStatus;
  if (!TASK_STATUSES.includes(status)) throw new StoreError(`Unknown task status "${fields.status}".`);
  return {
    id: fields.id,
    project: fields.project,
    title: fields.title,
    status,
    created_at: fields.created_at,
    updated_at: fields.updated_at,
    body,
  };
}

function serializeReport(report: Report): string {
  const { body, ...meta } = report;
  return serializeFrontmatter({ ...meta }, body);
}

function parseReport(raw: string): Report {
  const { fields, body } = parseFrontmatter(raw);
  return { task_id: fields.task_id, project: fields.project, submitted_at: fields.submitted_at, body };
}

// --- File helpers ------------------------------------------------------------

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

/**
 * Writes via a temp file in the same directory, then renames it into place.
 * With `exclusive`, the temp file is hard-linked instead, which fails if the
 * target exists; returns false in that case.
 */
export async function writeFileAtomic(
  file: string,
  content: string,
  opts: { exclusive?: boolean } = {},
): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  try {
    if (opts.exclusive) {
      try {
        await fs.link(tmp, file);
      } catch (err) {
        if (isErrno(err, "EEXIST")) return false;
        throw err;
      }
    } else {
      await renameWithRetry(tmp, file);
    }
    return true;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// On Windows, rename can briefly fail while another process (editor, antivirus) has the target open.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      const transient = isErrno(err, "EPERM") || isErrno(err, "EACCES") || isErrno(err, "EBUSY");
      if (!transient || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}
