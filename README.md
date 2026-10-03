# cc-handoff

A small local MCP server that removes the copy-paste loop between a planning
Claude chat (Claude Desktop) and Claude Code. The chat writes a task, Claude Code
picks it up and leaves a report, and the chat reads the report — all through
plain Markdown files on your disk.

## Install

Requires Node.js 20+.

```bash
git clone https://github.com/ardayldz8/cc-handoff.git
cd cc-handoff
npm install
npm run build
```

Data lives in `~/.cc-handoff/` by default (override with the `HANDOFF_DIR`
environment variable). Each project is a sub-folder holding `P001-task.md`,
`P001-report.md`, and so on. Task files carry YAML frontmatter
(`id`, `project`, `title`, `status`, `created_at`, `updated_at`).

## Configure

Use the absolute path to `dist/index.js`. Point both clients at the same data
directory (the default does that), so they see the same tasks.

**Claude Code** (user scope, available in every project):

```bash
claude mcp add --scope user cc-handoff -- node /absolute/path/to/cc-handoff/dist/index.js
```

**Claude Desktop**: add this to `claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`),
then fully quit and restart the app:

```json
{
  "mcpServers": {
    "cc-handoff": {
      "command": "node",
      "args": ["/absolute/path/to/cc-handoff/dist/index.js"]
    }
  }
}
```

On Windows, write the path with escaped backslashes
(`"C:\\Users\\you\\cc-handoff\\dist\\index.js"`) or forward slashes.

## Tools

| Tool | Who uses it | What it does |
| --- | --- | --- |
| `create_task(project, title, body)` | chat | Creates the next task (`P001`, `P002`, …) with status `open`. |
| `get_next_task(project)` | Claude Code | Returns the oldest `open` task and marks it `in_progress`. |
| `submit_report(project, task_id, body)` | Claude Code | Saves `<id>-report.md` and marks the task `reported`. |
| `get_report(project, task_id?)` | chat | Returns a task's report; without `task_id`, the most recent one. |
| `list_tasks(project)` | both | Lists ID, title and status of every task. |

Statuses: `open` → `in_progress` → `reported` → `closed` (close a task by
editing its file; no tool does that yet).

## Example flow

1. **Chat:** "Create a task in project `my-app`: add a dark-mode toggle." →
   `create_task` → `P001` (open)
2. **Claude Code:** "Get the next task for `my-app`." → `get_next_task` →
   receives P001, which is now `in_progress`, and does the work.
3. **Claude Code:** `submit_report(my-app, P001, "...")` → P001 is `reported`.
4. **Chat:** "Read the latest report for `my-app`." → `get_report` → plans the
   next step.

## Development

```bash
npm test        # store unit tests (vitest)
npm run smoke   # builds, starts the server over stdio, runs a full task -> report cycle
```

## License

MIT
