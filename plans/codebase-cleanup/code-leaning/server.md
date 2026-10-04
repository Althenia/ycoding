# SC — Server source ranking

At `96c6b644`: 55 tracked paths; 55 eligible operational source files, 4,758 physical lines. Current classifier: 28 unchanged / 22 modified / 40 new across all tracked Server paths.

| Rank | Module under `packages/server/src/` | Lines × touches = score | Current fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `handlers/session.ts` | 1,161 × 12 = 13,932 | modified | `handlers.ts:8` includes `SessionHandler` in the mounted handlers. |
| 2 | `process.ts` | 265 × 7 = 1,855 | modified | Its `:16` import of `createRoutes` mounts the Server HTTP routes. |
| 3 | `handlers/browser.ts` | 229 × 4 = 916 | new | `handlers.ts:34` includes `BrowserHandler`. |
| 4 | `routes.ts` | 175 × 5 = 875 | modified | `process.ts:16` calls `createRoutes`. |
| 5 | `handlers/pty.ts` | 344 × 2 = 688 | modified | `handlers.ts:21` includes `PtyHandler`. |
| S1 anchor | `handlers/integration.ts` | 173 × 1 = 173 | unchanged | `handlers.ts:26` includes `IntegrationHandler`. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated files, fixtures and declarations; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Current classifier/snapshot supplies classes; S1 anchor is separate from score order. D14 duplication, Protocol handler compatibility and live flow checks are not measured by this ranking.

## D14 duplication (`bunx jscpd@4`, min 70 tokens, at `2e585dce`)

54 files, 3597 lines; 1 clone groups, 15 duplicated lines (0.42%). Excludes tests, generated clients, `*.gen.ts`, and vendored `cursor/provider`. A clone group is a candidate for one owner only when both copies implement the same rule; matching text alone does not justify a merge.

| Lines | First | Second |
|---:|---|---|
| 16 | `packages/server/src/middleware/form-location.ts:41-56` | `packages/server/src/middleware/session-location.ts:42-58` |
