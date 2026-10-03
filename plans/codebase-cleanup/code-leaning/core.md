# SC — Core source ranking

At `96c6b644`: 591 tracked paths; 426 eligible operational source files, 88,203 physical lines. Current classifier: 220 unchanged / 275 modified / 273 new / 137 vendored across all tracked Core paths.

| Rank | Module under `packages/core/src/` | Lines × touches = score | Current fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `session.ts` | 2,324 × 28 = 65,072 | modified | Server `handlers/session.ts:1` and `routes.ts:20` import `SessionV2`. |
| 2 | `session/runner/llm.ts` | 1,226 × 20 = 24,520 | modified | `location-services.ts:51,126` installs `SessionRunnerLLM.node`. |
| 3 | `session/projector.ts` | 1,317 × 12 = 15,804 | modified | `session.ts:35,2314` imports and installs `SessionProjector.node`. |
| 4 | `aisdk.ts` | 1,268 × 11 = 13,948 | modified | `location-services.ts:3` and `session/runner/model.ts:17` import `AISDK`. |
| 5 | `session/compaction.ts` | 1,221 × 11 = 13,431 | modified | `session.ts:25` and Server `routes.ts:21` import `SessionCompaction`. |
| S1 anchor | `github-copilot/chat/openai-compatible-chat-language-model.ts` | 815 × 1 = 815 | unchanged | `github-copilot/copilot-provider.ts` imports the chat model; `plugin/provider/github-copilot.ts:199` lazily imports that provider. |

Method: tracked `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated/declarations, fixtures and the classifier's vendored `cursor/provider` tree. Lines are current physical lines; touches are commit-path appearances in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z` over this source scope. Score is lines × touches; the S1 anchor is shown separately rather than promoted above higher scores. Per-file class uses the current classifier/snapshot, not the historical baseline table. Static linkage is not evidence of a redundant behavior. D14 duplication results, full public-subpath/consumer mapping, and lean-suite gates remain unmeasured here; no deletion or contract change follows from rank.

S1 hand-off (E78): no product caller — `control-plane/move-session.ts` (test-only), `plugin/layer-map.example.ts`, `util/path.ts`. Dead-code candidates for SC-core; remove with their tests after the reference search in `checklist.md` SC.
