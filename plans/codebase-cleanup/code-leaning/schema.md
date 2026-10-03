# SC — Schema source ranking

At `96c6b644`: 83 tracked paths; 83 eligible operational source files, 5,785 physical lines. Current classifier: 53 unchanged / 25 modified / 28 new across all tracked Schema paths.

| Rank | Module under `packages/schema/src/` | Lines × touches = score | Current fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `session-event.ts` | 902 × 11 = 9,922 | modified | `event-manifest.ts:29` assembles its definitions; Protocol `groups/session.ts:40` imports it. |
| 2 | `session-message.ts` | 356 × 5 = 1,780 | modified | `session.ts:11` and Protocol `groups/session.ts:1` import message schemas. |
| 3 | `provider-request.ts` | 202 × 8 = 1,616 | new | Protocol `groups/session.ts:44` and `session-cache-diagnostics.ts:7` import it. |
| 4 | `browser.ts` | 207 × 5 = 1,035 | new | Protocol `groups/browser.ts:1` imports browser schemas. |
| 5 | `session.ts` | 88 × 6 = 528 | modified | `index.ts` exports Session and Core Session consumers use its public shape. |
| S1 anchor | `form.ts` | 164 × 1 = 164 | unchanged | Protocol `groups/form.ts:1` imports Form; `event-manifest.ts:11` includes its events. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated files, fixtures and declarations; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Current classifier/snapshot supplies classes; S1 anchor is separate from score order. D14 duplication and durable-event/public-schema consumer integrity are not established by this score; no schema transition follows from it.

S1 hand-off (E78): `src/ide-event.ts` is a public subpath with no producer and absent from the event manifest; any removal is a public-contract change needing approval.

## D14 duplication (`bunx jscpd@4`, min 70 tokens, at `2e585dce`)

83 files, 5785 lines; 1 clone groups, 6 duplicated lines (0.10%). Excludes tests, generated clients, `*.gen.ts`, and vendored `cursor/provider`. A clone group is a candidate for one owner only when both copies implement the same rule; matching text alone does not justify a merge.

| Lines | First | Second |
|---:|---|---|
| 7 | `packages/schema/src/integration.ts:147-153` | `packages/schema/src/integration.ts:131-137` |
