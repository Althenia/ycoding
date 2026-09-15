# Workplan

## Execution order

M0 repository/tooling audit → M1 bootable fixture-driven foundation → M2 high-fidelity two-actor vertical slice → M3 live YCoding integration → M4 complete four-role workspace → M5 recovery, performance and native delivery.

Do not expand the map to compensate for weak art or animations. Do not build backend orchestration again to compensate for missing UI event mapping. Reduce breadth before reducing the agreed fidelity of the core interaction.

## M0 — establish a safe starting point

Read the live checkout, instructions and package scripts. Record branch/HEAD, existing modifications, OS/CPU/display, Godot executable/version and baseline checks. Inspect prompt admission, delivery modes, session/child identities, canonical snapshot, active execution status, global stream, auth/discovery and approval contracts. Record verified symbols/routes in `contracts/wire-audit.json`.

Choose the native `apps/office/` directory after confirming root policies. Make the desktop addition explicit in root product/architecture/contributor docs and narrowly extend checks where necessary. A non-JavaScript Godot project does not need to become a Bun package solely to satisfy naming symmetry. Preserve the JS allowlist; add a scoped native-surface check rather than deleting it.

Select an asset strategy, document licenses and obtain approval before purchases. Pin tool versions and a starting pixel scale. M0 must produce a factual handoff, not simply copy this remote audit.

## M1 — make the boundaries executable

Create a Godot project, app scene, office viewport, readable shell UI and a fixture playback adapter. The app's main composition root selects exactly one transport: `DemoTransport` or `HttpTransport`. DEMO is the initial default; LIVE requires an explicit connection.

Build plain-data presentation state, source references, identity mapping and director interfaces. Set up a headless test runner that returns a nonzero failure code. Add a fixture parser and deterministic clock. The mock composer feeds synthetic events locally without any network mutation. A placeholder floor is acceptable in this milestone only.

## M2 — prove the visual product

Use production-intent art for one CEO/lead, one Backend worker, an office/engineering area, a doorway, desk/visitor anchors and a conversation panel. Implement foot-based depth ordering, actual obstacle routing, four-direction animations and graceful sit/stand/turn/talk transitions. Add a concise bubble tied to the synthetic source record, selection and an expandable history entry. Add one ambient coffee/idle interaction that is interrupted by work.

Capture normal-speed footage directly from Godot and screenshots at both supported window sizes. Compare against the explicit fidelity checklist. Await real visual acceptance before expanding to M4. While visual approval is pending, independent transport/tests may proceed, but the M2 gate is not marked passed.

## M3 — integrate real work without changing how the user prompts

Attach to the existing service using verified local configuration and auth. Implement ordinary JSON calls and an incremental SSE connection. Reconcile canonical state on connect/reconnect/epoch change; use event invalidation plus bounded refresh first, not a new durable event store. Verify how transient assistant deltas, pending prompts and execution state are represented before mapping them.

Preserve the actual prompt DTO, stable retry identity and delivery semantics. Guard against accidental double submits and ambiguous network errors without inventing backend idempotency. Wire interrupt and supported human approval/question flows. The first live test uses an authorized inexpensive task; no automatic provider spending.

Read the actual root/child transcript and links. A missing report/answer is shown as missing, not reconstructed from “what the worker probably meant.” A runtime state of inactive/idle is not inherently a successfully completed task.

## M4 — expand the proven components

Build one floor with five zones and four role templates using the M2 asset family and interaction primitives. Handle simultaneous child sessions, duplicate agent definitions and UI navigation across session families. Add bounded queues, per-actor cancellation, anchor release, interaction batching where appropriate, and up-to-date attention markers that preempt decorative behavior.

Complete parent-child conversation filtering, source links, current/past assignment navigation and technical details. Full PTY/IDE features remain deferred. Re-run visual acceptance with concurrent workers and the history drawer open. Replay and live modes must use the same director and actor code.

## M5 — qualify local delivery

Test disconnection, SSE overflow, service restart/epoch change, long transcripts, rapid session switching, duplicate delivery, app close/reopen, path blockage and prompt-response ambiguity. Measure the Godot process separately from YCoding/model latency. Profile ordinary load and 12 synthetic actors; do not silently raise limits to hide a leak.

Export a native app on the target development machine. Verify launch without the Godot editor, attach to the existing service and graceful exit without killing a shared daemon. Auto-start is optional only if the verified service mechanism permits safe ownership tracking; manual start with a clear message remains acceptable for this MVP.

Record licenses, configuration, exact validation commands and known limitations. Capture the final actual-Godot demo and package local launch instructions. Public signing/notarization/updater work is a later release unless explicitly added.

## Day-to-day working loop

Choose a dependency-ready task from `tracking/tasks.json`. Establish a small observable outcome and failing test where applicable. Implement it, run focused verification, inspect the diff, attach evidence and update the task. Append a session log and current handoff even when blocked. Keep user changes separate; do not commit unless asked.

Estimate in task size only until M0 reveals the codebase/toolchain and asset availability. No calendar dates or completion promises are implied by these milestones.

## Scope-change rule

Record a short decision containing the concrete problem, alternatives, complexity cost, affected tasks and acceptance changes. Prefer an adapter fix over a server change; prefer one small server projection improvement over a new service; prefer fewer polished activities over a bigger unfinished world. Never weaken factual truthfulness, permission enforcement or the fidelity gate to meet a demo deadline.
