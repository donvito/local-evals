# Codex project instructions

For complex coding tasks, use the `astra-orchestrator` skill when its trigger conditions match.

The root agent owns architecture, decomposition, integration, and final verification.
Prefer specialized subagents for bounded exploration, implementation, testing, review, and technical research.

Do not delegate trivial work merely for parallelism.
Do not let multiple implementation agents edit the same files without explicit ownership boundaries.
User instructions always take precedence over this orchestration policy.

## Verification

- `npm run lint` (typecheck), `npm test` (vitest), `npm run build` (tsc + vite).
- Visual check: `npx tsx src/cli.ts serve --db <copy-of-.localevals/demo.db> --port 4190` to avoid touching real data or a server already on 4173.
- CLI commands are documented in `src/cli-help.ts`; it drives both `--help` output and the dashboard's Help → Command line page. Update it when adding or changing a command.
