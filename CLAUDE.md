# cc-handoff

Local MCP server (TypeScript, stdio) that passes tasks and reports between a
planner Claude chat and Claude Code. Store logic: `src/store.ts`; tools:
`src/index.ts`. Never write to stdout in the server; it carries the protocol.

Checks before reporting: `npm run build`, `npm test`, `npm run smoke`.

## Report format

End every task with a short report under these three headings:

- **Blocked on me**: decisions or actions only the user can take. Write "Nothing" if none.
- **Changed**: what was changed (files, config, commits), briefly.
- **Found**: notable findings, risks, follow-ups.

Include command output that proves the result (e.g. the smoke test) and links
(repo, PR) where relevant.
