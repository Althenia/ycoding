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
