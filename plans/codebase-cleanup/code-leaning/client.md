# SC — Client source ranking

At `96c6b644`: 20 tracked paths; 9 eligible hand-authored operational source files, 945 physical lines. Current classifier: 15 unchanged / 17 modified / 4 new across all tracked Client paths.

| Rank | Module under `packages/client/src/` | Lines × touches = score | Current fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `effect/service.ts` | 330 × 2 = 660 | modified | CLI `services/server-connection.ts:1` and TUI `app.tsx:4` import `Service`. |
| 2 | `promise/service.ts` | 289 × 2 = 578 | modified | The `./service` package export maps here for Promise service consumers. |
| 3 | `file-change-summary.ts` | 177 × 2 = 354 | new | CLI `remote-operations.ts:10` and TUI `routes/session/index.tsx:45` import summaries. |
| 4 | `service.ts` | 55 × 2 = 110 | modified | `effect/service.ts:8` and `promise/service.ts:7` import its service contract types. |
| 5 | `effect/index.ts` | 47 × 2 = 94 | modified | The package `./effect` export maps here; Effect Client consumers load it. |
| S1 anchor | `promise/index.ts` | 16 × 1 = 16 | unchanged | The package root and `./promise` exports map here; CLI and TUI use the Promise Client. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding generated clients/API declarations, tests, fixtures and declarations; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Current classifier/snapshot supplies classes; S1 anchor is separate from score order. The generated Effect API is excluded even though large and churned; its owning generator is `packages/client/script/build.ts`. D14 duplication and generated-contract parity are not measured here.

S1 hand-off (E78): `src/contract.ts` is outside the `exports` map with no importer; dead-code candidate for SC-client.
