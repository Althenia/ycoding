# SC — Web source ranking

At `96c6b644`: 253 tracked paths; 116 eligible operational source files, 26,822 physical lines. The S1 classifier covers only `packages/`; its fork class is **unknown/out of scope** for every Web path below, and the verified upstream snapshot has no `apps/web` tree.

| Rank | Module under `apps/web/src/` | Lines × touches = score | Fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `remote/store.ts` | 3,429 × 51 = 174,879 | unknown | `remote/context.tsx:7,36` creates the remote store for the app route. |
| 2 | `styles/remote.css` | 2,296 × 31 = 71,176 | unknown | `main.tsx:11` imports remote styles. |
| 3 | `remote/ui/shell.tsx` | 1,651 × 40 = 66,040 | unknown | `app.tsx:10` imports `RemoteShell`. |
| 4 | `remote/projection.ts` | 1,895 × 24 = 45,480 | unknown | `remote/store.ts:55` and `remote/ui/shell.tsx:21` import projections. |
| 5 | `remote/ui/conversation.tsx` | 619 × 25 = 15,475 | unknown | `remote/ui/shell.tsx:53` imports `RequestCard`. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated files, fixtures, declarations and `src/content/` product copy; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Fork-class ranking is unrankable for this out-of-classifier surface. D14 duplication, CSS/design ownership, real display checks and connection/relay contracts are not assessed by this score; no removal is implied.
