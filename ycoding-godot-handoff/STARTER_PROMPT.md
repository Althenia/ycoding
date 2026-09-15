# Starter prompt — paste into your local coding agent

Use this prompt with the YCoding checkout open and the extracted `ycoding-godot-handoff` folder available to the agent.

---

Implement YCoding Office using the supplied `ycoding-godot-handoff` pack. This is an implementation handoff, not a request to brainstorm the stack again.

The approved product direction is:
- Godot is the complete native desktop frontend. Do not introduce Electron, a Solid desktop renderer or an embedded browser.
- Keep the existing YCoding runtime and its local HTTP/SSE interface. Preserve the existing TUI.
- I type ordinary prompts exactly as in the TUI. The runtime decides whether to work, delegate, ask, review or report. I must not script employee movements or prompt a separate office AI.
- A deterministic OfficeDirector turns real runtime facts into walking, facing, sitting, typing, reviewing, reporting and source-backed speech bubbles. Ambient life is cosmetic and preemptible.
- Visual fidelity is a hard requirement: coherent pixel-art office, directional characters, actual routes around furniture, correct depth, fine-grained interactions, crisp world rendering and readable professional panels.
- Clicking an employee exposes source-backed conversation history and their actual session/work. Never invent dialogue, acknowledgments, test successes or persistent history.

Resolve the handoff root from the supplied folder. Read its README.md, AGENTS.md, tracking/HANDOFF.md, tracking/tasks.json, MVP.md, MILESTONES.md and the relevant detailed documents. Resolve the repository root from the current checkout and read its actual root/scoped AGENTS.md, current source/tests, Schema/Protocol and product docs. Do not copy the handoff AGENTS.md over the repository's guide.

First establish a safe local baseline: correct repository and HEAD, current dirty/untracked paths, OS/architecture, Godot executable and exact version, declared backend toolchain and available verification commands. Preserve all existing changes. Do not reset, clean, stash, stage, commit, push, create/switch branches or alter unrelated files. Never print credentials or dump environment/private transcripts. Do not install paid assets or trigger paid/live model requests without authorization.

The remote source audit in this pack used Althenia/ycoding at 8544ea9fa55e0c86dcc09ac7d4b43dc7ee6dba10; it is not proof about my current local checkout. A different branch or the historical Rust repository must be audited independently. Verify exact DTOs, route names, auth, location scope and sync behavior locally. The inspected global SSE feed was volatile, so do not assume replay or treat event IDs as universal cursors. Use canonical snapshots and verified source-epoch/watermark semantics.

Adding Godot is explicitly approved. The current repository may still say TUI-only: reconcile that in a narrow supported-surface/architecture/contributor-doc change while preserving existing runtime and package boundaries. The proposed native location is apps/office; confirm it fits the local repository. Do not add a JavaScript wrapper merely to make Godot a workspace package, and do not disable the workspace checker to bypass policy.

Begin with TASK-001 and execute M0 in dependency order. Populate contracts/wire-audit.json with local evidence, pin the toolchain, document the native boundary and identify a cohesive asset strategy. Then implement the first runnable M1 Godot foundation: main scene, visibly labeled DEMO mode, synthetic fixture transport, read model/director boundaries, a normal prompt widget and real test runner. Create files and run verification rather than responding only with another plan.

For the fidelity slice, follow docs/FIDELITY_SPEC.md. M1 can use greybox assets, but M2 must use production-intent coherent art and actual Godot footage. Do not substitute a Python-rendered movie or static concept image. Obtain user visual acceptance for the M2/M4 gates before dependent art/world expansion; independent safe tests/integration work may continue while review is pending.

Implement only verified live behavior. Preserve actual TUI prompt admission/delivery/permission settings; never inject a CEO policy or auto-launch workers for appearances. DEMO fixtures cannot send live mutations. Live and synthetic recordings must be visibly distinguishable. Keep game state in the client; never access YCoding's database directly. No Kafka/Redis/new orchestration service/full PTY editor in this MVP.

Use test-first changes for behavior. Run the actual Godot import/test/scene checks when available and affected backend suites for backend changes. Discover package commands; the audited root bun test deliberately fails. A test not run is not a pass. A successful parse is not visual approval. If a tool or asset is unavailable, record the exact blocker and continue independent safe work without pretending the missing step succeeded.

Maintain tracking/tasks.json as the canonical task store. Attach actual evidence before marking done, regenerate TRACKING.md and TODO.md with tools/render_tracking.py, append tracking/SESSION_LOG.md and update tracking/HANDOFF.md after each work session. Respect task dependencies and single ownership of shared scenes/tilesets.

Finish the session with changed paths, exact commands/results, outstanding risks or approvals and the next task ID. Do not claim the application, live integration, visual gate or export is complete unless its evidence actually exists.

Start the local audit and implementation now.
