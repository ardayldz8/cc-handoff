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

**Claude Desktop on Windows**: after `npm run build`, quit Claude Desktop and
double-click `install-desktop.cmd` in the repo folder. See
[Windows: Claude Desktop install](#windows-claude-desktop-install) below.

**Claude Desktop on macOS**: with the app fully quit, add this to
`~/Library/Application Support/Claude/claude_desktop_config.json`, then start it:

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

## Windows: Claude Desktop install

Claude Desktop must be **fully closed** while its config is edited. The running
app keeps `claude_desktop_config.json` in memory and rewrites the whole file
whenever a setting changes, so anything added while it runs is silently lost.

1. Quit Claude Desktop from the system tray (right-click the icon → Quit).
   Closing the window is not enough.
2. Double-click `install-desktop.cmd` in the repo folder. If Claude is still
   running, the script asks you to quit it and waits (up to 5 minutes).
3. The script backs up the config (`claude_desktop_config.json.bak-<timestamp>`),
   adds `mcpServers.cc-handoff`, verifies that nothing else changed, and starts
   Claude again. Check **Settings → Developer** for `cc-handoff`.

Running it again is safe: if the entry is already there, nothing is written.
Preview without changing anything:

```bash
install-desktop.cmd --dry-run
```

Notes:

- **Where the config really is.** Claude Desktop from the Microsoft Store / MSIX
  installer reads
  `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json`.
  Inside the app (and in terminals it starts) `%APPDATA%\Claude` is redirected
  there, but from a normal terminal that folder does not exist, so a file created
  at `%APPDATA%\Claude` is never read. The script finds the right file and only
  uses `%APPDATA%\Claude` for non-MSIX installs.
- **Run it outside Claude.** Claude Code sessions in the desktop app are child
  processes of Claude Desktop and are closed with it, so the script refuses to
  install from inside one. Use Explorer or a normal terminal.
- The entry stores the full path of the `node.exe` that ran the script. If you
  move or reinstall Node.js elsewhere, or move this repo, run the installer again.

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
npm test        # store and installer unit tests (vitest)
npm run smoke   # builds, starts the server over stdio, runs a full task -> report cycle
```

To try the Windows installer against a copy of a config file:

```bash
node scripts/install-desktop.mjs --dry-run --config path/to/copy/claude_desktop_config.json
```

## License

MIT
