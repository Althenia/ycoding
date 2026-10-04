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

S1 hand-off (E78): no product caller — `component/dialog-tag.tsx` (test-only), `util/revert-diff.ts`. Dead-code candidates for SC-tui.

## D14 duplication (`bunx jscpd@4`, min 70 tokens, at `2e585dce`)

402 files, 71304 lines; 47 clone groups, 1784 duplicated lines (2.50%). Excludes tests, generated clients, `*.gen.ts`, and vendored `cursor/provider`. A clone group is a candidate for one owner only when both copies implement the same rule; matching text alone does not justify a merge.

| Lines | First | Second |
|---:|---|---|
| 170 | `packages/tui/src/theme/assets/lucent-orng.json:11-180` | `packages/tui/src/theme/assets/orng.json:11-180` |
| 144 | `packages/tui/src/theme/assets/lucent-orng.json:251-394` | `packages/tui/src/theme/assets/orng.json:251-394` |
| 126 | `packages/tui/src/mini/footer.command.tsx:680-805` | `packages/tui/src/mini/footer.command.tsx:381-614` |
| 108 | `packages/tui/src/theme/assets/material.json:274-381` | `packages/tui/src/theme/assets/palenight.json:274-381` |
| 97 | `packages/tui/src/theme/v2/defaults.ts:231-327` | `packages/tui/src/theme/v2/defaults.ts:14-110` |
| 89 | `packages/tui/src/theme/assets/material.json:105-193` | `packages/tui/src/theme/assets/palenight.json:105-193` |
| 85 | `packages/tui/src/mini/footer.command.tsx:879-963` | `packages/tui/src/mini/footer.command.tsx:595-805` |
| 57 | `packages/tui/src/mini/footer.command.tsx:619-675` | `packages/tui/src/mini/footer.command.tsx:595-611` |
| 54 | `packages/tui/src/theme/assets/lucent-orng.json:193-246` | `packages/tui/src/theme/assets/orng.json:193-246` |
| 47 | `packages/tui/src/theme/assets/lucent-orng.json:407-453` | `packages/tui/src/theme/assets/orng.json:407-453` |
| 40 | `packages/tui/src/theme/assets/one-dark.json:429-468` | `packages/tui/src/theme/assets/orng.json:342-381` |
| 40 | `packages/tui/src/theme/assets/material.json:409-448` | `packages/tui/src/theme/assets/palenight.json:409-448` |
| 37 | `packages/tui/src/theme/assets/one-dark.json:115-151` | `packages/tui/src/theme/assets/palenight.json:105-130` |
| 37 | `packages/tui/src/theme/assets/material.json:16-52` | `packages/tui/src/theme/assets/palenight.json:16-52` |
| 36 | `packages/tui/src/theme/assets/orng.json:132-167` | `packages/tui/src/theme/assets/ycoding.json:158-193` |
| 31 | `packages/tui/src/theme/assets/mercury.json:99-129` | `packages/tui/src/theme/assets/vercel.json:100-143` |
| 31 | `packages/tui/src/ui/spinner.ts:337-367` | `packages/tui/src/ui/spinner.ts:275-305` |
| 30 | `packages/tui/src/theme/assets/vercel.json:101-130` | `packages/tui/src/theme/assets/vesper.json:79-143` |
| 30 | `packages/tui/src/theme/assets/orng.json:92-121` | `packages/tui/src/theme/assets/vesper.json:82-146` |
| 30 | `packages/tui/src/theme/assets/cobalt2.json:112-141` | `packages/tui/src/theme/assets/github.json:122-143` |

27 smaller groups are omitted; rerun the same command to list them.
