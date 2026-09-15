# Contract files

`wire-audit.json` is the local verification worksheet, prefilled only with explicitly remote observations. Null fields are intentional unverified facts, not an implementation promise. TASK-004 must fill the current local mapping before live behavior.

`semantic-event.schema.json` describes a **proposed client-internal observation/replay envelope**. It is not a server API, generated client or durable event schema. The app can refine it without changing Core as long as the director/state boundaries and tests remain coherent. `at_ms` is relative fixture scheduling time, not a global ordering guarantee. `event_id` is a normalized observation identity; `source_epoch` is synchronization context, never a permanent employee identity. `source` fields shown here are a minimal fixture provenance contract; the live implementation must retain the actual full canonical source locator from its verified DTOs.

LIVE observations must come from verified source mappings; never send these proposal payloads to YCoding as commands. A settled fixture event is deliberately synthetic: a live inactive session alone does not justify success. Rehydrated history must not be fed back as fresh `interaction.created` animations. See [integration](../docs/INTEGRATION.md).

The pack validator checks the shipped contract subset and fixture invariants. It is not a general JSON Schema implementation or a substitute for backend contract integration tests.
