# V2 specifications

These documents explain V2 behavior that is difficult to recover from one source file. They are current cross-module contracts or explicit design records; they are not API reference, a product roadmap, or an implementation backlog.

Start with the fork documentation index at [`../../docs/README.md`](../../docs/README.md) for product direction and operator-facing behavior.

## Authority

Authority follows the concern:

| Concern                                                     | Owner                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Executable behavior                                         | Current implementation and targeted tests                                                                     |
| Public domain shapes and durable event payloads             | [`packages/schema`](../../packages/schema/src)                                                                |
| HTTP operations, middleware placement, and transport errors | [`packages/protocol`](../../packages/protocol/src), assembled by Server `HttpApi`                             |
| Runtime behavior and persistence                            | [`packages/core`](../../packages/core/src)                                                                    |
| Product direction and maintained behavior                   | [`docs/product-direction.md`](../../docs/product-direction.md) and [`docs/runtime.md`](../../docs/runtime.md) |
| Package boundaries and dependency direction                 | [`docs/architecture.md`](../../docs/architecture.md)                                                          |
| Contributor-critical regression guardrails                  | Root [`AGENTS.md`](../../AGENTS.md)                                                                           |

Current specifications explain cross-module contracts without copying exact types. Decision records explain why a design was selected. Historical documents describe earlier states and may use obsolete names.

Generated clients follow the assembled public `HttpApi`. GitHub issues own active work; Git history preserves removed plans and scratchpads.

## Current contracts

| Document                                  | Job                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| [Session](./session.md)                   | Explain prompt admission, execution, instructions, compaction, and recovery boundaries. |
| [Session guardrails](./session-guardrails.md) | Explain root-family policy, reviews, counters, boundaries, and security invariants.   |
| [Provider usage](./provider-usage.md)     | Explain normalized quota sources, caching, source stability, APIs, and TUI semantics.   |
| [Tools](./tools.md)                       | Explain tool construction, registration, execution, and settlement laws.                |

## Decisions and proposals

| Document                                                          | Status                     | Job                                                                          |
| ----------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| [Event stream](./event-stream-architecture.md)                    | Accepted and implemented   | Record why public events use one encoded feed with independent queues.       |
| [Managed restart continuation](./session-restart-continuation.md) | Accepted and implemented   | Record why graceful managed-service restart uses private Session suspension. |
| [Instruction sync](./instruction-sync-proposal.md)                | Accepted and implemented   | Record why instruction state is value deltas plus derived rendering.         |
| [Provider policy](./provider-policy.md)                           | Proposed and unimplemented | Explore provider authorization independently from provider configuration.    |

## Historical context

| Document                                                                | Job                                                                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Schema changelog](./schema-changelog.md)                               | Preserve the pre-release compatibility ledger. Names in older entries are intentionally historical. |
| [Catalog/config/plugin lifecycle](./catalog-config-plugin-lifecycle.md) | Preserve the option comparison that led to replayable Location-scoped catalog transforms.           |

## Maintenance rules

- Do not add implementation checklists here. Put actionable work in issues or explicitly temporary plans.
- Do not copy generated types into prose. Link to Schema or Protocol and explain the invariant.
- Mark proposals as proposed until production code and tests exist.
- Update root `docs/runtime.md` when a specification changes user-visible behavior.
- Update the relevant maintained product document when behavior changes.
