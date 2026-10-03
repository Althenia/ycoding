# SC — CLI source ranking

At `96c6b644`: 89 tracked paths; 86 eligible operational source files, 10,207 physical lines. Current classifier: 31 unchanged / 44 modified / 93 new across all tracked CLI paths.

| Rank | Module under `packages/cli/src/` | Lines × touches = score | Current fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `remote-operations.ts` | 1,777 × 26 = 46,202 | new | `remote-bridge.ts:27` imports it for the local relay bridge. |
| 2 | `remote-bridge.ts` | 820 × 15 = 12,300 | new | `commands/handlers/remote/connect.ts:3` imports `RemoteAgent`. |
| 3 | `remote-local.ts` | 493 × 16 = 7,888 | new | Remote connect/status/session handlers import `RemoteLocal`. |
| 4 | `update/update.ts` | 454 × 7 = 3,178 | new | `services/updater.ts:11` imports `latestRelease`. |
| 5 | `run/noninteractive.ts` | 625 × 4 = 2,500 | modified | `run/run.ts` selects the noninteractive run implementation. |
| S1 anchor | `ui/timeline.tsx` | 242 × 1 = 242 | unchanged | `commands/handlers/console/login.ts:8` imports `createTimelineHost`. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated files, fixtures and declarations; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Current classifier/snapshot supplies exact classes; S1 anchor is outside score order. D14 duplication results, installer/update contracts and the CLI lean-suite gates remain to be measured, not inferred from size.

## D14 duplication (`bunx jscpd@4`, min 70 tokens, at `2e585dce`)

86 files, 8962 lines; 12 clone groups, 119 duplicated lines (1.33%). Excludes tests, generated clients, `*.gen.ts`, and vendored `cursor/provider`. A clone group is a candidate for one owner only when both copies implement the same rule; matching text alone does not justify a merge.

| Lines | First | Second |
|---:|---|---|
| 21 | `packages/cli/src/commands/commands.ts:13-33` | `packages/cli/src/commands/tui.ts:32-52` |
| 14 | `packages/cli/src/ui/timeline.tsx:221-234` | `packages/cli/src/ui/timeline.tsx:146-161` |
| 14 | `packages/cli/src/run/noninteractive.ts:393-406` | `packages/cli/src/run/noninteractive.ts:345-358` |
| 13 | `packages/cli/src/commands/commands.ts:121-133` | `packages/cli/src/commands/run.ts:22-34` |
| 12 | `packages/cli/src/commands/handlers/default.ts:7-18` | `packages/cli/src/commands/handlers/tui.ts:7-18` |
| 11 | `packages/cli/src/index.ts:39-49` | `packages/cli/src/tui.ts:11-21` |
| 10 | `packages/cli/src/run/noninteractive.ts:410-419` | `packages/cli/src/run/noninteractive.ts:365-374` |
| 9 | `packages/cli/src/commands/handlers/mcp/auth.ts:19-27` | `packages/cli/src/commands/handlers/mcp/logout.ts:14-21` |
| 8 | `packages/cli/src/commands/commands.ts:160-167` | `packages/cli/src/commands/tui.ts:12-21` |
| 7 | `packages/cli/src/commands/handlers/remote/connect.ts:62-68` | `packages/cli/src/commands/handlers/remote/disconnect.ts:13-19` |
| 6 | `packages/cli/src/commands/handlers/mcp/list.ts:11-16` | `packages/cli/src/commands/handlers/plugin/list.ts:11-16` |
| 6 | `packages/cli/src/commands/handlers/debug/agents.ts:11-16` | `packages/cli/src/commands/handlers/plugin/list.ts:11-16` |
