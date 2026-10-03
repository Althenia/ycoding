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

## D14 duplication (`bunx jscpd@4`, min 70 tokens, at `2e585dce`)

439 files, 67000 lines; 70 clone groups, 955 duplicated lines (1.43%). Excludes tests, generated clients, `*.gen.ts`, and vendored `cursor/provider`. A clone group is a candidate for one owner only when both copies implement the same rule; matching text alone does not justify a merge.

| Lines | First | Second |
|---:|---|---|
| 64 | `packages/core/src/filesystem/fff.bun.ts:52-115` | `packages/core/src/filesystem/fff.node.ts:68-131` |
| 37 | `packages/core/src/database/sqlite.bun.ts:106-142` | `packages/core/src/database/sqlite.node.ts:100-136` |
| 30 | `packages/core/src/database/sqlite.bun.ts:71-100` | `packages/core/src/database/sqlite.node.ts:72-101` |
| 26 | `packages/core/src/session/runner/image-analyzer.ts:220-245` | `packages/core/src/session/runner/image-analyzer.ts:185-210` |
| 23 | `packages/core/src/plugin/system-prompt/trinity.txt:17-39` | `packages/core/src/session/runner/prompt/base.txt:20-42` |
| 23 | `packages/core/src/plugin/system-prompt/trinity.txt:52-74` | `packages/core/src/session/runner/prompt/base.txt:50-72` |
| 23 | `packages/core/src/config/plugin/provider.ts:288-310` | `packages/core/src/plugin/provider/opencode.ts:149-172` |
| 22 | `packages/core/src/plugin/system-prompt/anthropic.txt:25-46` | `packages/core/src/plugin/system-prompt/meta.txt:53-70` |
| 22 | `packages/core/src/session/goal.ts:163-184` | `packages/core/src/session/title.ts:138-159` |
| 22 | `packages/core/src/session/goal.ts:266-287` | `packages/core/src/session/title.ts:215-236` |
| 22 | `packages/core/src/integration.ts:532-553` | `packages/core/src/integration.ts:509-530` |
| 21 | `packages/core/src/github-copilot/responses/tool/web-search-preview.ts:83-103` | `packages/core/src/github-copilot/responses/tool/web-search.ts:76-96` |
| 21 | `packages/core/src/integration.ts:456-476` | `packages/core/src/integration.ts:391-411` |
| 20 | `packages/core/src/session/file-change-cleanup.ts:37-56` | `packages/core/src/session/usage-cleanup.ts:39-58` |
| 20 | `packages/core/src/provider-usage/meta.ts:11-30` | `packages/core/src/provider-usage/openai.ts:6-25` |
| 19 | `packages/core/src/session/runner/continuation.ts:252-270` | `packages/core/src/session/runner/continuation.ts:228-246` |
| 19 | `packages/core/src/session/message-updater.ts:514-532` | `packages/core/src/session/message-updater.ts:486-504` |
| 18 | `packages/core/src/github-copilot/chat/openai-compatible-chat-language-model.ts:627-644` | `packages/core/src/github-copilot/chat/openai-compatible-chat-language-model.ts:585-602` |
| 18 | `packages/core/src/session/goal.ts:184-201` | `packages/core/src/session/title.ts:158-175` |
| 16 | `packages/core/src/tool/mcp.ts:125-140` | `packages/core/src/tool/shell.ts:127-142` |

50 smaller groups are omitted; rerun the same command to list them.
