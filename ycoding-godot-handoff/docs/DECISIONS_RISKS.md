# Decisions, defaults and risks

## Decision ledger

| ID | Status | Decision and rationale |
|---|---|---|
| ADR-01 | User-approved direction | Godot is the full desktop frontend; retain existing YCoding service and TUI |
| ADR-02 | User-approved direction | User prompts normally; office acts automatically; no movement/roleplay syntax |
| ADR-03 | User-approved direction | Local HTTP is acceptable; avoid a new IPC/security architecture without a concrete need |
| ADR-04 | User-approved requirement | High visual/behavioral fidelity, bubbles and conversation history are first-class scope |
| ADR-05 | Proposed implementation default | Same repo, native `apps/office`, no Bun wrapper unless build integration needs one |
| ADR-06 | Proposed implementation default | Typed GDScript, pinned stable Godot 4.x, Compatibility renderer, grid navigation |
| ADR-07 | Proposed implementation default | Snapshot-first state with volatile event invalidation; no duplicate durable client store |
| ADR-08 | Proposed implementation default | Source-backed short excerpts, no LLM per bubble; nonverbal ambient interactions only |
| ADR-09 | Proposed implementation default | Two-actor fidelity gate precedes world expansion; actual Godot footage required |
| ADR-10 | Proposed implementation default | First target is user's local macOS machine; full PTY/map editor/public distribution deferred |

## Risk register

| ID | Risk / trigger | Mitigation / owner |
|---|---|---|
| RISK-01 | Art lacks matching seated/interaction poses | Asset audit before scale-out; art owner proves two-actor slice |
| RISK-02 | Existing TUI-only policy blocks new surface | M0 explicit narrow migration; preserve supported TUI/runtime boundary |
| RISK-03 | Missed global SSE events leave stale state | Canonical resync, epoch/generation ownership and race tests |
| RISK-04 | Agent definition treated as unique employee | Assignment key includes actual scoped session identity; repeated-role test |
| RISK-05 | Queue lag makes the office lie | Immediate status, bounded/coalesced travel, cancellation tokens and recent-activity labels |
| RISK-06 | Conversation cannot be fully reconstructed | Show source availability honestly; prove any backend projection gap before extending contracts |
| RISK-07 | Godot UI scope grows into full IDE | Basic transcript/diff/tool output first; PTY and advanced editor features deferred |
| RISK-08 | Shared daemon killed or duplicate prompt sent | Attach-first lifecycle, verified ownership and retry reconciliation |
| RISK-09 | Private data/paid assets leak in export | Sanitized evidence, explicit licenses and release inspection |
| RISK-10 | Agent edits clobber local user work | Baseline diff inventory, no Git mutation, single ownership of shared scene resources |
| RISK-11 | “Tests passed” becomes a misleading visual | Source distinction and negative mapping tests; no string-guessing success |
| RISK-12 | Attractive demo hides broken live path | Separate synthetic, live, visual and native-export evidence |

## Open implementation checks

Local checkout/toolchain, asset choice, exact API DTOs and active/attention-state read strategy are deliberately resolved in M0. No unresolved choice requires returning to Electron or a new runtime. Spending, destructive edits, public release signing and visual acceptance remain genuine user decision boundaries.

## Change record format

Record date/task, concrete problem, at least two meaningful alternatives when architectural, chosen option, cost, affected boundaries/tests, user approval when required and rollback approach. Small local implementation details need not become an ADR. Never silently change a hard acceptance gate to make an incomplete task appear done.
