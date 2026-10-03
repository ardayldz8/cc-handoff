import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HandoffStore, StoreError, writeFileAtomic } from "../src/store.js";

let baseDir: string;
let store: HandoffStore;

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-handoff-test-"));
  store = new HandoffStore(baseDir);
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe("createTask", () => {
  it("assigns sequential IDs with status open", async () => {
    const a = await store.createTask("demo", "First", "body 1");
    const b = await store.createTask("demo", "Second", "body 2");
    expect(a.id).toBe("P001");
    expect(b.id).toBe("P002");
    expect(a.status).toBe("open");
    expect(a.created_at).toBe(a.updated_at);
  });

  it("numbers projects independently", async () => {
    await store.createTask("one", "A", "");
    const other = await store.createTask("two", "B", "");
    expect(other.id).toBe("P001");
  });

  it("writes a task file with YAML frontmatter", async () => {
    await store.createTask("demo", "Add login", "Do the thing.");
    const raw = await fs.readFile(path.join(baseDir, "demo", "P001-task.md"), "utf8");
    expect(raw).toMatch(/^---\nid: P001\nproject: demo\ntitle: "Add login"\nstatus: open\ncreated_at: "[^"]+"\nupdated_at: "[^"]+"\n---\n\nDo the thing.\n$/);
  });

  it("round-trips titles and bodies with special characters", async () => {
    const title = 'Fix: "quotes", colons: and #hash';
    const body = "Line 1\n\n---\nkey: value\n```\ncode\n```";
    await store.createTask("demo", title, body);
    const task = await store.getTask("demo", "P001");
    expect(task?.title).toBe(title);
    expect(task?.body).toBe(body);
  });

  it("keeps IDs unique under concurrent creates", async () => {
    const tasks = await Promise.all(Array.from({ length: 8 }, (_, i) => store.createTask("demo", `T${i}`, "")));
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["P001", "P002", "P003", "P004", "P005", "P006", "P007", "P008"]);
  });

  it("continues numbering after the highest existing ID", async () => {
    await fs.mkdir(path.join(baseDir, "demo"));
    await fs.writeFile(
      path.join(baseDir, "demo", "P041-task.md"),
      `---\nid: P041\nproject: demo\ntitle: "x"\nstatus: closed\ncreated_at: "t"\nupdated_at: "t"\n---\n`,
    );
    const task = await store.createTask("demo", "Next", "");
    expect(task.id).toBe("P042");
  });

  it("rejects an empty title", async () => {
    await expect(store.createTask("demo", "   ", "")).rejects.toThrow(StoreError);
  });
});

describe("project and task ID validation", () => {
  it.each(["../escape", "..", "", "Demo", "a/b", "a\\b", "-x", "x-", "a--b", "a b", "c:"])(
    "rejects project %j",
    async (project) => {
      await expect(store.createTask(project, "t", "")).rejects.toThrow(StoreError);
      await expect(store.listTasks(project)).rejects.toThrow(StoreError);
    },
  );

  it.each(["../P001", "P1", "p001", "P001/../x", ""])("rejects task ID %j", async (id) => {
    await expect(store.getTask("demo", id)).rejects.toThrow(StoreError);
    await expect(store.submitReport("demo", id, "r")).rejects.toThrow(StoreError);
  });

  it("does not create anything outside the base directory", async () => {
    await expect(store.createTask("../outside", "t", "")).rejects.toThrow();
    const parent = await fs.readdir(path.dirname(baseDir));
    expect(parent).not.toContain("outside");
  });
});

describe("claimNextTask", () => {
  it("returns the oldest open task and marks it in_progress", async () => {
    await store.createTask("demo", "First", "b1");
    await store.createTask("demo", "Second", "b2");

    const claimed = await store.claimNextTask("demo");
    expect(claimed?.id).toBe("P001");
    expect(claimed?.status).toBe("in_progress");
    expect(claimed?.body).toBe("b1");
    expect((await store.getTask("demo", "P001"))?.status).toBe("in_progress");

    expect((await store.claimNextTask("demo"))?.id).toBe("P002");
    expect(await store.claimNextTask("demo")).toBeNull();
  });

  it("orders by number, not by string (P010 after P009)", async () => {
    for (let i = 0; i < 10; i++) await store.createTask("demo", `T${i + 1}`, "");
    for (let i = 0; i < 9; i++) await store.claimNextTask("demo");
    expect((await store.claimNextTask("demo"))?.id).toBe("P010");
  });

  it("returns null for an unknown project", async () => {
    expect(await store.claimNextTask("nothing-here")).toBeNull();
  });

  it("updates updated_at but keeps created_at", async () => {
    const created = await store.createTask("demo", "T", "");
    await new Promise((r) => setTimeout(r, 5));
    const claimed = await store.claimNextTask("demo");
    expect(claimed?.created_at).toBe(created.created_at);
    expect(claimed!.updated_at > created.updated_at).toBe(true);
  });
});

describe("reports", () => {
  it("saves a report and marks the task reported", async () => {
    await store.createTask("demo", "T", "");
    await store.claimNextTask("demo");
    const { task, report } = await store.submitReport("demo", "P001", "All done.");
    expect(task.status).toBe("reported");
    expect(report.body).toBe("All done.");
    expect((await store.getTask("demo", "P001"))?.status).toBe("reported");
    expect((await store.getReport("demo", "P001"))?.body).toBe("All done.");
    await expect(fs.access(path.join(baseDir, "demo", "P001-report.md"))).resolves.toBeUndefined();
  });

  it("fails for an unknown task", async () => {
    await expect(store.submitReport("demo", "P001", "r")).rejects.toThrow(/not found/);
  });

  it("refuses reports for closed tasks", async () => {
    await store.createTask("demo", "T", "");
    const file = path.join(baseDir, "demo", "P001-task.md");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("status: open", "status: closed"));
    await expect(store.submitReport("demo", "P001", "r")).rejects.toThrow(/closed/);
  });

  it("returns null when a task has no report", async () => {
    await store.createTask("demo", "T", "");
    expect(await store.getReport("demo", "P001")).toBeNull();
    expect(await store.getLatestReport("demo")).toBeNull();
  });

  it("latest report is the most recently submitted one", async () => {
    await store.createTask("demo", "A", "");
    await store.createTask("demo", "B", "");
    await store.submitReport("demo", "P002", "report B");
    await new Promise((r) => setTimeout(r, 5));
    await store.submitReport("demo", "P001", "report A");
    expect((await store.getLatestReport("demo"))?.task_id).toBe("P001");
  });

  it("resubmitting overwrites the report", async () => {
    await store.createTask("demo", "T", "");
    await store.submitReport("demo", "P001", "v1");
    await store.submitReport("demo", "P001", "v2");
    expect((await store.getReport("demo", "P001"))?.body).toBe("v2");
  });
});

describe("listTasks", () => {
  it("lists tasks in ID order with metadata only", async () => {
    await store.createTask("demo", "A", "body");
    await store.createTask("demo", "B", "body");
    await store.claimNextTask("demo");
    const list = await store.listTasks("demo");
    expect(list.map((t) => [t.id, t.title, t.status])).toEqual([
      ["P001", "A", "in_progress"],
      ["P002", "B", "open"],
    ]);
    expect(list[0]).not.toHaveProperty("body");
  });

  it("is empty for an unknown project", async () => {
    expect(await store.listTasks("nope")).toEqual([]);
  });

  it("reads files edited with CRLF line endings", async () => {
    await store.createTask("demo", "Edited", "line1\nline2");
    const file = path.join(baseDir, "demo", "P001-task.md");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/\n/g, "\r\n"));
    const task = await store.getTask("demo", "P001");
    expect(task?.title).toBe("Edited");
    expect(task?.body).toBe("line1\nline2");
  });
});

describe("writeFileAtomic", () => {
  it("leaves no temp files behind", async () => {
    await store.createTask("demo", "T", "");
    await store.claimNextTask("demo");
    await store.submitReport("demo", "P001", "r");
    const files = await fs.readdir(path.join(baseDir, "demo"));
    expect(files.sort()).toEqual(["P001-report.md", "P001-task.md"]);
  });

  it("exclusive mode does not overwrite an existing file", async () => {
    const file = path.join(baseDir, "x.md");
    expect(await writeFileAtomic(file, "first", { exclusive: true })).toBe(true);
    expect(await writeFileAtomic(file, "second", { exclusive: true })).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe("first");
    expect(await fs.readdir(baseDir)).toEqual(["x.md"]);
  });

  it("replaces an existing file in normal mode", async () => {
    const file = path.join(baseDir, "x.md");
    await writeFileAtomic(file, "first");
    await writeFileAtomic(file, "second");
    expect(await fs.readFile(file, "utf8")).toBe("second");
  });
});
