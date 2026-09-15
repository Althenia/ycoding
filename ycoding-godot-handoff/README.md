# YCoding Office — Godot local handoff

**Package:** 1.0 · **Prepared:** 2026-09-15 · **Status:** implementation plan, not an implemented desktop app.

Build a native Godot desktop client for YCoding: a polished, Gather-inspired pixel workplace in which the user types normal TUI-style prompts and watches real agent work represented by employees, desks, meetings, movement, speech bubbles, and inspectable conversation history.

The selected direction is **Godot as the complete desktop frontend → existing local YCoding HTTP/SSE service**. No Electron wrapper, Solid desktop renderer, replacement agent runtime, or office-control prompting is required. The existing TUI remains supported.

## Start locally

1. Extract this archive into a **new directory**, preferably beside the YCoding checkout. Do not extract it over the repository root or replace its existing `AGENTS.md`.
2. Open that checkout with your local coding agent. Give the agent the extracted handoff directory as additional context, and paste [STARTER_PROMPT.md](STARTER_PROMPT.md).
3. The first implementation work is M0: inspect the actual local checkout, preserve existing changes, verify the protocol, pin the toolchain, and make the approved desktop product-boundary change explicitly. The agent must not assume the local checkout equals the GitHub snapshot used for this pack.

From the extracted handoff directory, these **pack utilities work now** and need only Python 3.10+:

```sh
python3 tools/validate_pack.py
python3 tools/render_tracking.py --check
python3 tools/doctor.py --repo /absolute/path/to/ycoding
```

The last command only reports the checkout and available tool versions. It does not install dependencies, start YCoding, modify Git, or run model requests. A missing Godot executable is reported honestly. See [local setup](docs/LOCAL_SETUP.md).

## Files to use

| File | Purpose |
|---|---|
| [MVP.md](MVP.md) | Product contract, tiers, non-goals, acceptance criteria |
| [WORKPLAN.md](WORKPLAN.md) | Implementation sequence and working rules |
| [MILESTONES.md](MILESTONES.md) | Six milestone exit gates and required evidence |
| [PROJECT_LAYOUT.md](PROJECT_LAYOUT.md) | Proposed repository placement, Godot scenes and module ownership |
| [AGENTS.md](AGENTS.md) | Rules for an agent working from this handoff; never a root-repository replacement |
| [TRACKING.md](TRACKING.md) | Generated milestone/task summary |
| [TODO.md](TODO.md) | Generated task checklist with dependencies |
| [CHECKLIST.md](CHECKLIST.md) | Definition of done and release/visual checks |
| [STARTER_PROMPT.md](STARTER_PROMPT.md) | Copy-ready initial implementation prompt |
| [tracking/tasks.json](tracking/tasks.json) | Canonical task status, dependencies, acceptance and evidence |
| [tracking/HANDOFF.md](tracking/HANDOFF.md) | Current continuation point for the next local agent |
| [docs/FIDELITY_SPEC.md](docs/FIDELITY_SPEC.md) | Measurable visual, animation, UX and truthfulness quality bar |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | HTTP/SSE, snapshot recovery, identity, prompts and source attribution |
| [docs/OFFICE_DIRECTOR.md](docs/OFFICE_DIRECTOR.md) | Event-to-behavior rules, queueing, preemption and navigation |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Functional, protocol, resilience, visual and export test cases |

Additional documents cover conversations, assets, a demo storyboard, decisions, repository evidence and sources. `contracts/` and `fixtures/` contain **proposed client-internal contracts and explicitly synthetic test data**, not captured YCoding wire traffic. Templates are ready to populate with real local evidence.

## Important boundaries

- **No application milestone has been completed by this package.** All 48 implementation tasks begin as `todo`; creation/validation of this handoff is separate evidence.
- The previous videos were concept renders, not Godot footage or an approved asset set. Do not use them as proof of visual fidelity or implementation.
- GitHub inspection used `Althenia/ycoding` at commit `8544ea9fa55e0c86dcc09ac7d4b43dc7ee6dba10`. The remote is a Bun/TypeScript workspace. A different local branch or the separate historical Rust checkout requires a fresh audit, not forced conformity to these paths.
- The inspected `/api/event` feed is explicitly volatile. Reconnect means resynchronize canonical state; an SSE event ID does **not** imply replay support. See [repository audit](docs/REPO_AUDIT.md), references R1–R6.
- The native project location `apps/office/` is a **proposal to implement**, not a directory claimed to already exist.

## Tracking workflow

Edit `tracking/tasks.json`, then run `python3 tools/render_tracking.py`. Do not hand-edit generated `TRACKING.md` or `TODO.md`. Record each working session in [SESSION_LOG.md](tracking/SESSION_LOG.md); update [HANDOFF.md](tracking/HANDOFF.md) with the exact next task, changed paths, tests and blockers. A task can become `done` only with actual evidence and satisfied dependencies. Visual approval tasks need the user's review of actual Godot captures.

[PACK_VALIDATION.md](PACK_VALIDATION.md) records what was checked on this deliverable. `SHA256SUMS` describes the original archive payload: `python3 tools/validate_pack.py --integrity` verifies it **before local edits**. Checksums are expected to change as the plan is executed.
