# SC — CodeMode source ranking

At `96c6b644`: 34 tracked paths; 33 eligible operational source files, 8,161 physical lines. Current classifier: 53 unchanged / 7 modified / 2 new across all tracked CodeMode paths.

| Rank | Module under `packages/codemode/src/` | Lines × touches = score | Current fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `interpreter/runtime.ts` | 2,201 × 1 = 2,201 | unchanged | `interpreter/execute.ts` invokes the runtime; Core `tool/execute.ts:3` imports CodeMode. |
| 2 | `openapi/spec.ts` | 729 × 2 = 1,458 | modified | `openapi/runtime.ts:4` and `openapi/index.ts` reach the public OpenAPI converter. |
| 3 | `interpreter/methods.ts` | 1,147 × 1 = 1,147 | unchanged | `interpreter/runtime.ts` imports method dispatch. |
| 4 | `tool-runtime.ts` | 724 × 1 = 724 | unchanged | `codemode.ts:3` and `interpreter/execute.ts:5` import tool runtime. |
| 5 | `tool-schema.ts` | 244 × 2 = 488 | modified | `tool-runtime.ts:10` imports schema decoding/projection. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated files, fixtures and declarations; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Classes use the current classifier/snapshot, not historical baseline blobs. OpenAPI is eagerly linked by the public root but no production `fromSpec` invocation was established in S1; runtime linkage is not a deletion decision. D14 duplication and confinement/security checks are not measured here.

## D14 duplication (`bunx jscpd@4`, min 70 tokens, at `2e585dce`)

31 files, 4833 lines; 2 clone groups, 20 duplicated lines (0.41%). Excludes tests, generated clients, `*.gen.ts`, and vendored `cursor/provider`. A clone group is a candidate for one owner only when both copies implement the same rule; matching text alone does not justify a merge.

| Lines | First | Second |
|---:|---|---|
| 11 | `packages/codemode/src/interpreter/references.ts:65-75` | `packages/codemode/src/interpreter/references.ts:46-56` |
| 11 | `packages/codemode/src/interpreter/references.ts:90-100` | `packages/codemode/src/interpreter/references.ts:46-56` |
