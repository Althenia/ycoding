# M1 — bootable foundation gate evidence

Task: TASK-009–016 · Gate: TASK-016 · Date: 2026-09-15

## Deliverable

`apps/office/` is a Godot 4.7.2 project that boots, renders the office, and
passes a real headless test suite.

```
apps/office/
├── AGENTS.md                  scoped native-client guide
├── project.godot              config_version=5, GL Compatibility, 1280x720
├── app/main.tscn|main.gd      composition root, single transport selection
├── core/                      pure presentation logic (headless-testable)
│   ├── wire.gd                real wire vocabulary constants
│   ├── actor_identity.gd      scoped assignment identity
│   ├── actor_presentation.gd  canonical status vs cosmetic position
│   ├── work_state.gd          F-08 labelled states
│   └── office_store.gd        bounded reducer, demo and live share it
├── integration/
│   ├── fixture_translator.gd  fixture label -> real wire event
│   └── demo_transport.gd      synthetic clock, no network capability
├── office/
│   ├── director/office_director.gd
│   ├── navigation/office_navigation.gd
│   ├── maps/hq/office_world.gd
│   ├── actors/office_actor.gd
│   ├── viewport/office_viewport.gd
│   └── art/                   6 generated sheets
├── ui/{shell,prompt,conversation}/
├── tests/{run_tests.gd,suites/}
└── tools/{generate_art.py,capture_scene.gd}
```

## Commands and results

| Check | Command | Result |
|---|---|---|
| Import | `Godot --headless --path apps/office --editor --quit` | exit 0, no parse or resource errors |
| Tests | `Godot --headless --path apps/office --script res://tests/run_tests.gd` | **267 passed, 0 failed, exit 0** |
| Runner failure propagation | same command with one assertion deliberately set to an impossible value | `RESULT: FAILED`, exit 1 |
| Boot (headless debugger) | Godot MCP `run_project` then `stop_project` | zero errors, zero warnings |
| Live interaction | Godot MCP `run_interactive` + `evaluate_expression` | scene `Main`; `root_session_id = demo-root`; mode `DEMO`; 3 actors |
| Capture | `Godot --path apps/office --resolution 1280x720 --script res://tools/capture_scene.gd -- --out=<abs> --frames=300` | PNG written |

Captures: `dist/office/captures/m1_final_1280x720.png` (git-ignored).

## Test coverage

267 assertions across five suites, exercising production modules:

- `test_fixture_translator.gd` — no fixture label leaks into the store; a synthetic connection is not LIVE; null parent normalises to a root session; delegation/question/answer/report/settlement map to real wire events.
- `test_office_store.gd` — two sessions sharing one agent stay distinct; tool classification; unknown tool stays generic; **inactive is not success**; attention raises and clears on a real answer; duplicate source identity is one item; epoch change invalidates tokens; bounded conversation; the store exposes no mutation method.
- `test_demo_transport.gd` — the shipped fixture loads; a missing fixture errors; deterministic ordering; every event is marked synthetic; no network method exists.
- `test_office_director.gd` — attention preempts and never queues; unchanged state plans nothing; a late callback cannot revive stale state; the queue is bounded; over-age actions expire; ambient carries no speech and is preempted by work and attention.
- `test_work_state.gd` — every state has a unique text label and glyph (F-08); conservative tool and change classification.

## Bugs found and fixed during the gate

| Defect | Cause | Fix |
|---|---|---|
| Root session never detected (`""`) | `str(null)` yields `"<null>"`, so a null parent looked non-empty | normalise null to `""`; regression test `test_null_parent_normalizes_to_root`; **RED confirmed** (`expected , got <null>`) then GREEN |
| Scene failed to load | UI scripts and the composition root lacked `class_name`, so typed references did not resolve | added the missing `class_name` declarations |
| World distorted | SubViewport stretched non-uniformly into the container | container owns the size; camera zoom preserves aspect |
| `ModeBadge` not found | moved under `TopBar` in the layout rework | updated the node path |

## Known limitations (not gate failures)

- The composer is a DEMO preview: submitting records text locally and never sends a mutation. LIVE transport is not implemented; this is M3 scope.
- Ambient life is driven from `_process`, not a seeded scheduler; deterministic ambient playback is M2 scope.
- Only `oauth-workplace.jsonl` is loaded at boot; the reconnect fixture is present for M2 tests.
