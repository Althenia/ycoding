# Completion and release gates

No gate passes from source appearance alone. A required feature may be blocked by an external dependency; it is not done until its actual evidence exists. Discovered working code can satisfy a task only after its behavior is independently reverified.

## Evidence hierarchy

1. Exact native runtime behavior and screenshots/normal-speed video for the graphical workflow.
2. Real provider-backed desktop end-to-end result with persisted source and safe correlation.
3. Integration/contract tests exercising the real production boundary with explicit isolated external substitutes where appropriate.
4. Focused unit/regression tests and build/import/lint/typecheck.
5. Code inspection and plans explain implementation but do not substitute for the above.

A test may legitimately use fixtures; its evidence is `test_run`, not `real_provider`. A CLI provider call alone does not close the desktop flow. The “pass” label requires actual execution, not command text copied into a document.

## Required stage gates

R0 baseline; R1 real runtime; R2 coherent multipage shell; R3 complete settings; R4 fidelity/player; R5 projects/folders; R6 history/TUI parity; R7 statistics/quota/budgets; R8 recovery/native signoff; R9 builds/install/signing; R10 GitHub Release/Pages. Exact requirements and task dependencies are in MILESTONES.md. No stage is a substitute for another.

## Final stop conditions

Any unresolved real-provider failure, production-reachable fake path, nonfunctional required control, critical clipped/oversized geometry, hidden permission bypass, lost/duplicated work or missing required verification prevents complete status. Document unrelated pre-existing failures precisely; do not label new failures unrelated without evidence.

No unsupported feature is required solely because it appears in a reference screenshot. Conversely, hiding a broken required feature is not a valid resolution. Capability decisions need actual TUI/config evidence and a recorded scope decision.

## Evidence record rules

Each record includes actual time, kind, outcome, non-synthetic classification, repo revision/dirty-state reference, cwd/command or GUI steps, artifacts and redaction review. `user_review` records the user's real response; do not author an approval on their behalf. Numeric layout captures must come from running controls, not recomputed expected values. A human must review semantics and visual polish even when a geometry script passes.

The validator catches structural mistakes, missing evidence kinds and missing artifacts. It cannot establish that an author told the truth or that an image looks good. Agent and human review remain necessary.
