# SC — AI source ranking

At `96c6b644`: 91 tracked paths; 91 eligible operational source files, 15,369 physical lines. Current classifier: 150 unchanged / 63 modified / 13 new across all tracked AI paths.

| Rank | Module under `packages/ai/src/` | Lines × touches = score | Current fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `protocols/openai-responses.ts` | 1,602 × 11 = 17,622 | modified | Core `session/runner/model.ts:12` and the active OpenAI provider import it. |
| 2 | `protocols/openai-chat.ts` | 948 × 9 = 8,532 | modified | `protocols/openai-compatible-chat.ts:4` and `providers/azure.ts:6` import it. |
| 3 | `route/transport/websocket.ts` | 675 × 8 = 5,400 | modified | `route/transport/index.ts` re-exports the WebSocket transport used by route clients. |
| 4 | `protocols/anthropic-messages.ts` | 995 × 5 = 4,975 | modified | Core `session/runner/model.ts:6` and `providers/anthropic.ts:6` import it. |
| 5 | `cache-policy.ts` | 473 × 10 = 4,730 | modified | Core `session/model-request.ts:13` and `session/runner/cache.ts:4` import policy values. |
| S1 anchor | `protocols/google-images.ts` | 314 × 1 = 314 | unchanged | `providers/google.ts:7` imports `GoogleImages`. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated files, fixtures and declarations; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Classes are exact current classifier/snapshot results; S1 anchor is not promoted above higher scores. D14 duplication and provider wire/cache/reasoning behavior are not verified by this inventory; preserve provider-visible prefixes and errors.

S1 hand-off (E78): the 17 previously unresolved `src/` paths are public API (documented subpaths/barrels of the non-private package); keep unless a public-contract change is approved. `script/recording-cost-report.ts` has no caller; dead-code candidate for SC-ai.

## D14 duplication (`bunx jscpd@4`, min 70 tokens, at `2e585dce`)

77 files, 13745 lines; 24 clone groups, 332 duplicated lines (2.42%). Excludes tests, generated clients, `*.gen.ts`, and vendored `cursor/provider`. A clone group is a candidate for one owner only when both copies implement the same rule; matching text alone does not justify a merge.

| Lines | First | Second |
|---:|---|---|
| 38 | `packages/ai/src/providers/google-vertex-chat.ts:33-70` | `packages/ai/src/providers/google-vertex-responses.ts:34-71` |
| 23 | `packages/ai/src/providers/google-vertex-chat.ts:3-25` | `packages/ai/src/providers/google-vertex-responses.ts:3-25` |
| 22 | `packages/ai/src/providers/google-vertex-messages.ts:79-100` | `packages/ai/src/providers/google-vertex-responses.ts:50-71` |
| 21 | `packages/ai/src/protocols/xai-images.ts:92-112` | `packages/ai/src/protocols/zai-images.ts:55-75` |
| 21 | `packages/ai/src/protocols/openai-images.ts:82-102` | `packages/ai/src/protocols/zai-images.ts:55-75` |
| 19 | `packages/ai/src/providers/google-vertex-messages.ts:15-33` | `packages/ai/src/providers/google-vertex-responses.ts:7-25` |
| 18 | `packages/ai/src/protocols/google-images.ts:156-173` | `packages/ai/src/protocols/xai-images.ts:136-102` |
| 16 | `packages/ai/src/providers/openai-compatible-responses.ts:39-54` | `packages/ai/src/providers/openai-compatible.ts:59-74` |
| 16 | `packages/ai/src/protocols/xai-images.ts:138-153` | `packages/ai/src/protocols/zai-images.ts:87-102` |
| 15 | `packages/ai/src/providers/anthropic-compatible.ts:40-54` | `packages/ai/src/providers/openai-compatible-responses.ts:32-47` |
| 15 | `packages/ai/src/protocols/openai-images.ts:187-201` | `packages/ai/src/protocols/zai-images.ts:87-101` |
| 14 | `packages/ai/src/providers/google.ts:51-64` | `packages/ai/src/providers/openrouter.ts:236-249` |
| 12 | `packages/ai/src/route/executor.ts:52-63` | `packages/ai/src/route/executor.ts:33-44` |
| 12 | `packages/ai/src/providers/google-vertex-messages.ts:100-111` | `packages/ai/src/providers/google-vertex-responses.ts:71-98` |
| 12 | `packages/ai/src/providers/google-vertex-chat.ts:70-81` | `packages/ai/src/providers/google-vertex-responses.ts:71-98` |
| 12 | `packages/ai/src/protocols/google-images.ts:131-142` | `packages/ai/src/protocols/zai-images.ts:64-75` |
| 11 | `packages/ai/src/protocols/anthropic-messages.ts:363-373` | `packages/ai/src/protocols/anthropic-messages.ts:344-354` |
| 10 | `packages/ai/src/providers/google-vertex-responses.ts:73-82` | `packages/ai/src/providers/google-vertex.ts:89-98` |
| 10 | `packages/ai/src/protocols/anthropic-messages.ts:436-445` | `packages/ai/src/protocols/bedrock-converse.ts:323-332` |
| 8 | `packages/ai/src/providers/openai-compatible.ts:66-73` | `packages/ai/src/providers/openrouter.ts:242-249` |

4 smaller groups are omitted; rerun the same command to list them.
