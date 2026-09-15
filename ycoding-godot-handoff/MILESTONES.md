# Milestones and acceptance gates

**All implementation work starts unperformed.** Task IDs and status are canonical in [tracking/tasks.json](tracking/tasks.json). Direction approval is not milestone completion or approval of unseen art. “User review” means a recorded user decision on real evidence; an agent cannot approve its own visual fidelity.

| Milestone | Tasks | Outcome | Required exit evidence |
|---|---|---|---|
| M0 — Audit and safe boundaries | TASK-001–008 | Correct checkout, supported-surface migration, protocol inventory, toolchain/art strategy | Local SHA/status report; exact Godot/Bun versions; baseline command results; populated wire audit; policy diff |
| M1 — Bootable foundation | TASK-009–016 | Native app boots in DEMO; state/transport/director boundaries and test runner exist | Editor/import logs; running scene screenshot; deterministic fixture test; proof DEMO sends no backend mutations |
| M2 — Fidelity slice | TASK-017–024 | Two polished employees perform one believable interaction | Actual Godot clip (60–90 seconds) or a shorter clip plus stills covering every hard criterion, two window-size stills, fidelity scores, license manifest, explicit user visual acceptance |
| M3 — Live integration | TASK-025–032 | Ordinary prompt/interrupt/approval and source-backed history over local service | Sanitized live trace, actual prompt admission/retry tests, disconnect/epoch recovery test, UI source-link verification |
| M4 — Full office MVP | TASK-033–040 | Five zones, four role templates, concurrent assignments, complete interaction/history UX | Four-actor replay + live truthfulness trace, 12-actor stress case, queue/path tests, second user visual acceptance |
| M5 — Internal-ready desktop | TASK-041–048 | Native export works locally with verified lifecycle and documented limits | Export launch log, soak/performance report, regression results, final Godot capture, license/security review, completed handoff |

## Gate details

### G0 / TASK-008

Every repo assumption is labeled verified, drifted or unresolved. Prompt, auth, events and snapshot ownership are understood; remaining wire details have exact follow-up tasks. The native location and product-boundary changes are explicit. Any conflicting local instructions or missing toolchain are recorded. Do not mark M0 done with an empty audit.

### G1 / TASK-016

The app starts without provider credentials and clearly says DEMO. At least one scene, widget and reducer is exercised by actual tests. Test failures return nonzero. Fixture records are visibly synthetic. UI/director code has no direct access to model or filesystem-execution APIs.

### G2 / TASK-024 — mandatory visual gate

All hard fidelity criteria in [FIDELITY_SPEC.md](docs/FIDELITY_SPEC.md) pass. Evidence shows walking around furniture, correct depth, directional turns, sit/type, a source-backed bubble, a readable conversation panel and preemptible ambient behavior. The user reviews genuine Godot footage at normal speed. Greybox art, straight-line wall crossing, unreadable pixel-font panels or a prose promise fail this gate.

Independent integration work may continue while review is pending; TASK-024 stays `in_review`. TASK-033, which expands the art/world, depends on its acceptance.

### G3 / TASK-032

A real authorized prompt completes through the existing YCoding service. The desktop does not inject a new orchestrator. Duplicate-submit handling follows verified API semantics; disconnect restores truth; approvals preserve server choices. History points to actual messages. The service feed's volatility is handled rather than concealed. Live execution and synthetic choreography evidence remain separate.

### G4 / TASK-040

All five zones and four role templates use the same accepted asset style. Two sessions using the same agent type do not overwrite each other. Rapid events do not leave an endless walking queue or suppress an approval. Parent-child messages are not duplicated as both a delegated prompt and a fake human chat. The user accepts fidelity with the inspector/history open and concurrent work visible.

### G5 / TASK-048

Native export launches without an editor. Closing the client does not kill an existing shared service. No secret/private transcript is bundled. Live calls, sync recovery, scene rendering and packaging have separate evidence. Performance is measured on a recorded machine. Unsupported OS/capability areas are stated. Final video is recorded from the app, not reconstructed externally.

## Reopening a gate

Reopen the relevant gate when a change invalidates its evidence: replacing art, changing camera scale/depth, altering prompt/auth/sync semantics, changing engine version or changing export lifecycle. A README status cannot override a failed check. Update dependent task status or note that a previously completed task requires revalidation.
