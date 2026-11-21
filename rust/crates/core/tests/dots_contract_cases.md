# Native boundary regression basis

Basis: committed main `1e5e22db19b0c6bc21029779980c1d3856e42fdb`, `packages/core/test/dots-{access,access-config,native,native-admission,native-decisions,native-projection,retirement-promotion}.test.ts`, `session-yolo-steer.test.ts`, `session-restart-recovery-runner.test.ts`, `session-autonomy.test.ts`, `credential.test.ts`, and `packages/cli/test/remote-control-native.test.ts`.

Use synthetic disposable stores and deterministic gates. Every case starts with fresh state and closes its owned subscriptions, tasks, credentials, and store. All cases are Not Run. Priority P0 covers authority and durability; P1 covers lifecycle and projection. No provider traffic, user-store migration, or mutation probes are selected.

| Case | Priority | Action and observable result |
| --- | --- | --- |
| A1 | P0 | Read absent global preference; receive Off/revision 0 despite historical family grants and Session creation. |
| A2 | P0 | Concurrent expected-revision writes through independent access services; exactly one succeeds, stale noops conflict, unrelated KV survives. |
| A3 | P0 | Repeat same-value write; revision and notifications do not advance. An actual change advances once and persists across reconstruction. |
| A4 | P0 | Read malformed preference or attempt overwrite; fail closed and preserve stored bytes. |
| A5 | P0 | Enable or repeat On with invalid config/profile; reject. Off remains available with the exact revision. |
| A6 | P0 | Use Location, injected, historical, duplicate-profile, key, missing-account or malformed global config; none grants native access. |
| A7 | P1 | Attach one status transport, reject replacement, release and reattach; old release cannot remove current owner. |
| A8 | P0 | Resolve delayed status across Off-On, config/account replacement or transport retirement; no stale connected identity. |
| A9 | P1 | Supply control characters, oversized display fields or secret-bearing transport failure; output is bounded, sanitized and fixed guidance only. |
| H1 | P0 | Attach valid pins, then retire by Off, config Off-On, account replacement, connection/channel close or shutdown; all late operations fail without interrupting execution, deleting admitted input or consuming owners. |
| H2 | P0 | List/read roots with child, archived, missing/cyclic ancestry or foreign owner; exclude them. Descendant waits remain attached to eligible roots. |
| H3 | P0 | Delay enrichment/catalogue/subscription setup, then revoke an earlier root or account; final result excludes revoked contributions and events. Retirement callback fires once. |
| H4 | P0 | Create root in a recorded project directory with deterministic input ID; retry adopts existing root. Unknown directory and retired admission create nothing. |
| H5 | P0 | Prompt queue/steer with deterministic input ID; retry returns first admitted content and Host-pinned provenance. Revoke before preparation or commit; no new durable input. |
| H6 | P1 | List model/skill catalogues across eligible recorded contexts; union stable identities without runner/provider initialization. |
| H7 | P0 | Settle foreign stream/connection/root, replayed, retired or stale-stage Candidate; no owner mutation. Invalid answer preserves usable Candidate. |
| D1 | P0 | Settle permission with exact live fingerprint, ceiling, ownership and explicit-deny check under owner lock/transaction; allow exact request once, reject no blanket grant. |
| D2 | P0 | Settle ordinary/hard/custom guardrail; explicit native approval only, recheck live denies and authority in receipt transaction. |
| D3 | P0 | Settle pending Form or Question with invalid, conditional, external, option, custom or multiselect answer; reject invalid answers without consuming owner; valid answer has exact native source. |
| D4 | P0 | Settle deferred permission/guardrail/Form/Question/child/recovery review; preserve review ownership, live ceilings and source, never wake or replay uncertain work. |
| D5 | P0 | Answer managed-child question using exact parent/child/request/task fingerprint and revision; ordinary parent cannot answer review-owned question. |
| D6 | P0 | Retire native authority between owner snapshot and writer admission; no receipt or settlement. Fresh stages get distinct Candidates and IDs. |
| P1 | P1 | Project nullable options, isOther/isSecret, duplicate labels, explicit empty/whitespace values, true/false and external acknowledgement without coercion. |
| P2 | P1 | Project conditional fields and optional skips; retain original types and enforce uniqueness, bounds and formats. Cancellation is distinct from data. |
| P3 | P1 | Project child text then structured JSON data, with optional components; finish only with at least one component. |
| S1 | P0 | Promote queued/steered retired routine/delegated input; reject before preparation, consume once, append exactly one delegation_invalid receipt, preserve ordinary/native inputs and history. |
| S2 | P0 | Admit fresh human steer under effective category autonomy; cancel active evaluator/input owner, withdraw affected review and grants atomically. Queue, duplicate and nonhuman input retain their distinct behavior. |
| S3 | P0 | Deliver late Form answer after cancellation/defer/replacement; preserve terminal owner state and emit no duplicate receipt. |
| S4 | P0 | Read/write independent per-category autonomy and effective ancestry; no legacy authority on malformed history; preserve explicit denies and root-family guardrails. |
| S5 | P0 | Select complete child model and replace credential during grading; honor explicit selection, reject stale grade and do not rotate accounts. |
| S6 | P1 | Recover managed child after restart ending in user/tool turn; end recovery request at boundary without replaying provider/tool work or resuming roots. |
| L1 | P1 | Load catalogue-only Location, extend lazily, hold decision/draft lease, release after final lease and idle TTL; build/release publish no change announcements. |
| L2 | P0 | Shutdown while drain active; stop intake and drains before releasing Location-owned services; await private carrier and subscriptions. |
| R1 | P0 | Dispatch global get2068/set2069 MACHINE data tag1; reject retired4090–4101/3054–3055/5044 while retaining enroll3053 and configured MCP/browser remote. |
| R2 | P0 | Feed private carrier synthetic enroll/handshake/request/answer/error/retirement events; map only frozen Channel methods, discard late identity and never replay uncertain mutations. |
| I1 | P1 | Project settled durable leaf receipts into retained transcript without adding a model turn; Accounting completion accepts optional historical outcome and meter/activity wiring. |
| I2 | P0 | Remove Session through project-owner cleanup seam; preserve project policy ownership and prevent dangling coordination references. |

Techniques: permission partitions, boundary values, transactional concurrency, state transitions, idempotency, data integrity, cancellation and observable durable receipts. Performance/load, real-provider interoperability and real-user migration are excluded by execution scope, not claimed passing.
