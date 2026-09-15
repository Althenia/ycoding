# Product contract and MVP

**Direction approved in conversation:** native Godot desktop, existing local HTTP/SSE, normal prompts, automatic office behavior, speech bubbles, durable conversation history, and a cohesive Gather-like visual quality bar. Detailed implementation choices below are defaults, not claims of completed work.

## The experience

The user opens an existing workspace/session or creates one, types “Add OAuth login and tests,” and uses the same task-oriented prompting as the TUI. YCoding determines whether to work directly, delegate, ask a question, request approval, or finish. The Godot office observes those facts and presents a believable workplace automatically. Clicking an employee opens their current activity and source-backed conversation/session details.

“CEO” is a configurable display role for the root session, not a new authority or mandatory extra model. Small requests may use one agent only. The desktop must never force a manager hierarchy, rewrite the user's prompt into roleplay, create workers for entertainment, or wait for a walking animation before sending a real command.

## Delivery tiers

| Tier | Milestone | Deliverable | What it does not prove |
|---|---|---|---|
| Visual vertical slice | M0–M2 | Actual Godot scene with CEO + Backend, near-final assets, navigation, interaction, bubbles, readable panel and deterministic synthetic playback | A real backend integration |
| Usable MVP | M3–M4 | Normal live prompts, faithful status, four role templates, five office zones, conversation history, approvals, reconnect recovery | All desktop platforms or a full coding IDE |
| Internal-ready MVP | M5 | Tested native local export, recovery/performance evidence, lifecycle documentation, licenses and final demo | Public-store distribution, auto-updater, enterprise support |

The polished two-actor slice is a gate, not disposable artwork. Expand its proven scene/components instead of replacing a crude prototype at the end.

## Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| RQ-01 | Godot is the whole desktop client | No Electron/embedded-browser runtime required; native app opens on the user's development machine |
| RQ-02 | Ordinary prompt workflow | Existing prompt semantics, session selection, agent/model/delivery choices and permission settings are preserved; no movement syntax |
| RQ-03 | Single execution authority | Only YCoding starts/runs/cancels coding work; stopping animation never stops or launches a run |
| RQ-04 | Living office | CEO office, engineering, meeting, QA and break areas form one readable floor with doors, furniture and reachable anchors |
| RQ-05 | Fine-grained characters | Directional idle/walk, approach/turn/talk, sit/type/read, visible waiting/blocked state and ambient activity |
| RQ-06 | Honest semantic behavior | Delegation, work, report, question and review visuals require corresponding supported source facts; unknown activity remains generic |
| RQ-07 | Source-backed bubbles | Concise actual instruction/report excerpts; click expands the canonical message; no invented acknowledgments |
| RQ-08 | Durable conversation inspection | Parent/child assignments and real messages remain inspectable after closing/reopening the client; history provenance and ordering are explicit |
| RQ-09 | Concurrent identity | Multiple active sessions using the same agent definition remain distinct actors or clearly separated assignments |
| RQ-10 | Fidelity gate | Actual Godot stills/video pass the [fidelity specification](docs/FIDELITY_SPEC.md), not just a text promise |
| RQ-11 | Recovery | Disconnection/source-epoch change invalidates volatile assumptions; canonical snapshots restore truth without replaying stale visits |
| RQ-12 | Human control | Send, interrupt, select session, inspect errors and answer supported permission/guardrail prompts remain usable independently of the office |
| RQ-13 | Honest modes | DEMO / LIVE / RECONNECTING badges; mock mode cannot execute backend mutations or quietly switch to live |
| RQ-14 | Practical local delivery | Tool versions, launch/export commands, asset attribution, known limitations and evidence accompany the build |
| RQ-15 | Readability/accessibility | Keyboard navigation, adjustable text size, reduced motion, text status labels and light/dark panel themes |

Four roles means CEO/root, Backend, Frontend and QA templates. The live number of actors comes from actual sessions; do not manufacture four running employees when only one exists. Idle decorative employees are explicitly ambient/unassigned.

## Scope included

A workspace/session selector; prompt composer; root conversation; office view with pan/zoom and selection; agent inspector; source-backed team conversation; read-only tool output/transcript and a basic diff view where the verified service supports it; permission/question handling; session interruption; reconnect/error UI; persistent local display preferences; synthetic playback using the same director as live mode.

Basic diff means readable text, file headings and scroll/search. Tool output is **not** a PTY emulator. Missing or unsupported server capabilities must be disabled with an explanation, not represented by a working-looking mock button.

## Deferred

A map/furniture editor, multiplayer/proximity audio, voice agents, marketplace/skins, eight-direction art, advanced lighting, full terminal emulation, editor-grade merge tooling, automatic updates/notarization for public release, mobile/web clients, remote multi-host service management, persistent org-chart orchestration, and a second database/event bus. Worktree isolation remains a YCoding concern; the desktop does not invent a new merge/scheduler system.

## Defaults and limits

macOS on the user's development machine is the first acceptance target; record exact OS/architecture in M0. Godot 4.x stable + typed GDScript + Compatibility renderer is the starting choice; pin an exact verified version locally rather than guessing the newest release. No .NET dependency is required. Choose a single licensed asset family before M2. Define the first floor for four simultaneous assignments; stress-test 12 actors before declaring capacity. Performance thresholds are proposed test targets, not measurements.

## Success scenario

One normal prompt is accepted by YCoding. When the actual engine delegates, the office shows a visit and a source-backed bubble, while the worker executes immediately. A real question or approval displays accurately. On a real report, the worker visits the lead; the conversation drawer exposes the original text. Restarting only the desktop restores the session family and transcript. The office retains its visual quality while all this happens.

The synthetic OAuth storyline tests choreography deterministically. A live run is not required to reproduce a fixed number of delegations, the same wording, or a contrived blocker. Verify live truthfulness rather than training the UI to fake the storyboard.
