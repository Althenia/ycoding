# SC — TUI source ranking

At `96c6b644`: 321 tracked paths; 280 eligible operational source files, 64,649 physical lines. Current classifier: 143 unchanged / 204 modified / 229 new across all tracked TUI paths.

| Rank | Module under `packages/tui/src/` | Lines × touches = score | Current fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `routes/session/index.tsx` | 4,737 × 34 = 161,058 | modified | `app.tsx:67` mounts `Session` on the Session route. |
| 2 | `component/prompt/index.tsx` | 2,380 × 24 = 57,120 | modified | `routes/session/index.tsx:33` imports `Prompt`. |
| 3 | `context/data.tsx` | 2,295 × 18 = 41,310 | modified | `app.tsx:51` mounts `DataProvider`; Session route reads `useData`. |
| 4 | `app.tsx` | 1,244 × 20 = 24,880 | modified | `src/index.tsx:1` exports `run`; CLI `commands/handlers/tui-shared.ts:4` imports it. |
| 5 | `mini/runtime.ts` | 1,063 × 6 = 6,378 | modified | `mini/index.ts` invokes the deferred runtime; CLI `mini.ts:36` imports the mini subpath. |
| S1 anchor | `mini/demo.ts` | 1,073 × 1 = 1,073 | unchanged | `mini/runtime.ts:719` dynamically imports demo helpers when demo mode is selected. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated files, fixtures and declarations; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Classes use the current fork classifier and verified snapshot. The S1 anchor is separate from score order. D14 duplication results and the required TUI-visible render/lean-suite gates are not measured by this ranking; no visual or public-contract change is authorized by it.
