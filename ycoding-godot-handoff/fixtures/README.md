# Synthetic presentation fixtures

These JSONL files are authored **DEMO-only client-internal observations**, not captured server events, model conversations or evidence of code/test execution. Validate before loading. The normal app's live adapter must map its verified source contracts into the same store/director boundary.

## OAuth workplace

`oauth-workplace.jsonl`: 0–82 seconds of root/delegation/work/question/answer/report/QA/settlement/reconnect events. The demo harness may animate typing the normal user prompt and open the conversation drawer between 68–78 seconds. Those screen actions are not backend events. Keep a DEMO badge visible. The fixture's connection `state: live` means the **synthetic connection is ready**, not that mode became LIVE.

Expected: distinct scoped employees, source-backed bubbles, no runtime delay from walking, no extra LLM calls, reports retain explicit synthetic provenance, and old messages are not reanimated after the epoch-B resynchronization. The harness reloads canonical-fixture history separately if testing full history rehydration; this file by itself is not a durable server.

## Reconnect and concurrency

`reconnect-and-concurrency.jsonl`: two active sessions share the backend agent definition, a social interaction is delivered twice with the same interaction ID, one actor cancels during movement, the stream reconnects under a new epoch, then an old-epoch observation arrives.

Expected: Backend A/B remain distinct; duplicate interaction makes one social scene/history item; cancellation invalidates stale animations and releases anchors; old-epoch work does not revive Backend A. The renderer may not pretend that event-ID sequence numbers establish backend ordering.

## Tests still required

These fixtures do not exercise byte-level SSE framing, request retry semantics, complete snapshot-race behavior, actual anchor collision geometry, live provider execution or native packaging. Implement those tests against the production code as listed in docs/TEST_PLAN.md.
