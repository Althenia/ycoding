# SC — Protocol source ranking

At `96c6b644`: 40 tracked paths; 40 eligible operational source files, 4,385 physical lines. Current classifier: 23 unchanged / 15 modified / 24 new across all tracked Protocol paths.

| Rank | Module under `packages/protocol/src/` | Lines × touches = score | Current fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `groups/session.ts` | 1,150 × 13 = 14,950 | modified | `api.ts:9` assembles the Session group; Server `handlers/session.ts:6` imports its cursors. |
| 2 | `api.ts` | 260 × 6 = 1,560 | modified | Server `api.ts:1` and Protocol `client.ts:2` import `makeDefaultApi`. |
| 3 | `errors.ts` | 239 × 5 = 1,195 | modified | Server session and other handlers import tagged API errors. |
| 4 | `groups/browser.ts` | 194 × 3 = 582 | new | `api.ts:39` includes the Browser group; Server `handlers/browser.ts` implements it. |
| 5 | `client.ts` | 74 × 7 = 518 | modified | Client `contract.ts` re-exports Protocol client metadata for generated clients. |
| S1 anchor | `groups/integration.ts` | 200 × 1 = 200 | unchanged | `api.ts:32` imports `IntegrationGroup`. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated files, fixtures and declarations; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Current classifier/snapshot supplies classes; S1 anchor is separate from score order. D14 duplication and generated Client/OpenAPI parity are not measured here; changing the public operation contract requires separate approval and owning regeneration.

## D14 duplication (`bunx jscpd@4`, min 70 tokens, at `2e585dce`)

39 files, 3235 lines; 1 clone groups, 18 duplicated lines (0.56%). Excludes tests, generated clients, `*.gen.ts`, and vendored `cursor/provider`. A clone group is a candidate for one owner only when both copies implement the same rule; matching text alone does not justify a merge.

| Lines | First | Second |
|---:|---|---|
| 19 | `packages/protocol/src/groups/browser.ts:2-20` | `packages/protocol/src/groups/isolated-browser.ts:3-21` |
