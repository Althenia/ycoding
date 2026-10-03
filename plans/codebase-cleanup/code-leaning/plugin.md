# SC — Plugin source ranking

At `96c6b644`: 39 tracked paths; 36 eligible operational source files, 1,228 physical lines. Current classifier: 3 unchanged / 3 modified / 41 new across all tracked Plugin paths. None of the ranked `src/` paths is upstream-unchanged.

| Rank | Module under `packages/plugin/src/` | Lines × touches = score | Current fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `tui/context.ts` | 208 × 2 = 416 | new | TUI `plugin/context.tsx:17` and keymap import its contract types. |
| 2 | `effect/tool.ts` | 314 × 1 = 314 | new | Core `tool/tool.ts:1–2` re-exports it; CLI `node/plugin-runtime.effect.ts:13` imports `Tool`. |
| 3 | `promise/tool.ts` | 47 × 2 = 94 | new | Promise package root `promise/index.ts` exports `AnyTool` from it. |
| 4 | `effect/integration.ts` | 82 × 1 = 82 | new | Core provider plugins and `config/plugin/provider.ts:4` import integration contract types. |
| 5 | `tui/attention.ts` | 61 × 1 = 61 | new | `tui/context.ts:26` imports its `TuiAttention` type; `tui/index.ts:2` re-exports types. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated files, fixtures and declarations; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Current classifier/snapshot supplies exact classes, not historical package totals. Several paths are type-only public contracts; runtime deletion cannot be inferred from that. D14 duplication and plugin ABI/consumer checks are not measured here.
