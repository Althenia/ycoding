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
