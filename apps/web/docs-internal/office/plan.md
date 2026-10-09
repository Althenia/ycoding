# Office workday behavior: gap analysis and bounded plan

Internal proposal, 2026-10-09. **No increment is implemented or approved by this document.** Product code and `DESIGN.md` remain unchanged. Evidence: [current-office.md](./current-office.md), [claw3d-reference.md](./claw3d-reference.md). Claw citations below use that document's D/C source IDs; local paths are repository-relative.

## Decision and boundary

Keep the 2D Phaser open floor and original pixel art. Strengthen the existing director rather than add a simulation platform, browser-owned agent workflow or new dependencies. Make work visibly distinct, make idle time varied and finite, and make corroborated interactions legible. Never invent speech or infer teamwork from simultaneous execution.

Six increments below are prioritized; 1 gates every new motion behavior, 3 gates idle groups in 5, and 6 checks shared travel introduced by 3/5. Increments 2 and 4 can proceed independently after 1. S/M/L are relative estimates of implementation plus focused tests (S: one narrow boundary; M: several coupled web files; L: cross-runtime contract work). No calendar estimate is asserted.

### Invariants for every increment

- Preserve owner/device/family scoping, selected-child identity, capped 16 actors, overflow and reported totals; never populate from unrelated Session inventory (`apps/web/src/remote/office/model.ts:15,40-89`).
- Use each member's ready `familyActivity` → `OfficeActor.status/activity/source`, not family `SessionSummary.running`, role/title or parsed bubble text (`model.ts:157-188`; `types.ts:14-24,63-90`). Preserve W29's separation of family running from model execution (`apps/web/DESIGN.md:341`).
- Keep work at its own task spots, ≤12 tiles apart, no routes through another claim; delegate/report stays in place (`apps/web/DESIGN.md:387`; `src/remote/office/map.test.ts:37-68`).
- Labels/bubbles must use existing backend activity/state/cue facts. Decorative coffee/stretch/chat/play must never claim a tool, task, speech, meeting or review occurred. Leisure requires backend-derived idle, ready connection and projection source; attention/non-idle cancels immediately.
- Keep hydration placement, same-family refresh continuity, cue deduplication, hidden-page suspension, static reduced motion, nearest-neighbor 32px tiles / 32×48 frames, DPR≤2 and 30/20 FPS. No persistent itinerary or conversation state (`apps/web/DESIGN.md:335,387-391`; `src/remote/office/create-game.ts:56-81,100-141`).
- Reuse the existing Office floor/navigation/roster component and illustration palette; no new chrome, camera behavior, scene layout or UI tokens (`apps/web/DESIGN.md:389-391,467`). No copied code/assets. New work art only through `apps/web/script/office-art` and its owning generator; decorative leisure reuses existing frames under W23.

## Behavior comparison

| Behavior | Claw3D evidence | YCoding today | Gap / disposition |
| --- | --- | --- | --- |
| Live task movement | C1/C4: event holds and intent-driven rooms; C6 staged entrance. | Own implement/research/verify/coordinate spots, instant retarget and smoothed speed (`director.ts:162-220`). | Already present; do not replace with random roaming or sticky execution. |
| Desk typing | C4/C9: sitting work; dedicated typing body cycle unverified. | Explicit 4 FPS type cycle at implement spot (`OfficeScene.ts:94-102`; `director.ts:223-235`). | We already exceed the verified reference gesture; preserve it. |
| Reading / checking / planning | C14 monitors; separate reading/review body animation unverified. | Research stand, verify sit/stand, coordinate stand (`map.ts:48-74`). | Make our factual categories visibly distinguishable: increment 2, not a claim to copy reference animations. |
| Idle social destinations | C4: repeated chance-based roam/social stops. | One 6s idle-to-lounge trip; table-first claims, then mostly standing forever (`director.ts:140-172`). | Finite, identity-varied loops and meaningful seated rests: increment 3. |
| Coffee | C4 social target; drinking animation unverified. | Coffee machine and pantry spots exist but no fetch sequence (`map.ts:162-169,234`). | Walk/pause/return only, existing frames; no “Fetching coffee” bubble: increment 3. |
| Human micro-motion | C9 breathing, blinking, phase offsets. | 1 FPS stand, 3 FPS talk, 2 FPS play; no generic stretch/read frame (`sprites.ts:7-14`). | Existing pose pacing for idle stretch-like movement, explicit generated work read/point art; 1–3. Do not relabel wave art as a full anatomical stretch. |
| Safe reduced motion / interruption | Reference reduced-motion contract not verified. | Paths settle/no ball, but renderer still plays stand/type; ambient chat survives sync to work (`current-office.md`, §6). | Fix prerequisite gaps: increment 1. |
| Delegation/report | D1 documents collaboration; dedicated coding pairing unverified. | Corroborated in-place talk gestures with deduped events (`model.ts:142-150`; `OfficeScene.ts:285-308`). | Make current causal exchange readable without travel: increment 4. |
| Group standup | C12/C13: explicit participants, arrivals, speaker and summary cards. | Shared meeting furniture, no meeting participation/speaker fact (`types.ts:50-98,119-144`). | Idle silent standup-spot gathering only: increment 5. Actual standup is blocked on new runtime facts. |
| Two-agent play | C4/C11: click selects two idle players; partner/table ownership, ball after arrival. | Automatic four table spots; ball needs the two ends (`leisure.ts:13-20`). | Already implemented. Increment 3 adds variety; 5 preserves mutually exclusive participation. |
| Passing / personal space | C10: stop, face, temporary bubble and escape roam point. | Shared routes know furniture/claim boundaries, not peer occupancy (`navigation.ts:3-25`). | Quiet deterministic yielding, no decorative text or work reroute: increment 6. |
| Review/pairing authority | D1 collaboration claim; C2 review intent is text parsing, not proof of pair relationship. | Activity room gives category, cues give delegation/report, neither gives review partners/outcome. | Never infer shared coding from role, tool label, proximity or same files. New backend fact / Protocol work required. |

## 1. Truthful interruption and fully static reduced poses — S, prerequisite

**User-visible behavior:** any new work/attention fact immediately ends the idle gesture as well as the idle trip. Reduced motion retains state-specific static posture and factual markers; no sprite-frame cycling, ball flight or travel. Disconnect cannot retain a live leisure gesture.

**Facts:** `OfficeInput.connection`, `familyActivity.status`, `OfficeActor.source/status/activity`, `OfficePreferences.motion`, system media state (`types.ts:5-12,63-90`; `model.ts:157-188`; `preferences.ts:23-25`). `ActorSpeech` currently lacks provenance (`types.ts:133`): distinguish ambient chat from corroborated delegate/report response inside director state, so clearing leisure never erases a genuine cue indiscriminately.

**Must change:** `apps/web/src/remote/office/director.ts` (ambient gesture cancellation), `OfficeScene.ts` (static frame selection using current reduced state), `director.test.ts`, `verify/office-engine.integration.test.ts`, `apps/web/DESIGN.md`. Verify existing `preferences.ts` and `create-game.ts`; no new preference/API needed.

**Art:** existing stand/sit/type/talk/wave frames; choose one named frame per pose in reduced mode. No generator run or new asset.

**Proposed W23 clarification:** “Reduced motion MUST stop every sprite animation and show one fixed state-appropriate frame. A backend non-idle, attention or unavailable fact MUST clear decorative trips and gestures on the next applied snapshot; corroborated handoff feedback MUST retain its separate ownership.” Add static-frame/interruption wording to the Office Components row; keep W29 unchanged.

**Tests:** extend `src/remote/office/director.test.ts` with idle-chat→work/attention, disconnect and genuine-cue provenance cases. In `verify/office-engine.integration.test.ts`, compare actual frame IDs and positions across controlled engine advancement for stand/type/play and live preference switches. Keep ball absence and state markers asserted. In `verify/office.integration.test.ts`, retain pending-decision navigation, factual text and no resend/reconnect checks.

**Risk:** low-to-medium; clearing all speech would hide real reports, and reduced-mode implementation must not restart animations every render. Acceptance requires preserved factual badges and stable frame IDs, not merely `moving === false`.

## 2. Distinct reading, checking and planning gestures — M

**User-visible behavior:** at the owned reference spot, a quiet book/reference-reading cycle; at QA desk, seated checking/type posture (standing checking at the device rack); at owned board, a restrained pointing/looking cycle. Work remains immediately retargetable. Generic thinking/compacting/attention keeps neutral hold/wave posture, not fake typing or test progress.

**Facts:** `OfficeActor.status/activity/source` derived from ready member `executing`, `activity.kind/room` in `model.ts:170-188`; `OfficeActor.bubble/statusText` stays backend text. Research includes search/web reads: the reading gesture is a category illustration, not evidence of a particular file/tool. Do not parse `.text` to invent a more specific work kind. `hold` remains the existing implement-destination fallback; preserving prior locations would be a separate behavior decision, not hidden in this increment.

**Must change:** `apps/web/src/remote/office/types.ts` (presentation-only poses), `sprites.ts`, `director.ts`, `OfficeScene.ts`, `OfficeWorkspace.tsx` (atlas indexing), `script/office-art/characters.ts`; regenerate via `script/generate-office-art.ts`. Update `characters.test.ts`, `director.test.ts`, `model-activity.test.ts` where assertions apply, both Office integration suites and `apps/web/DESIGN.md`.

**Art:** reuse type/sit at QA where seated; generate original read/check/point frames only where a distinct silhouette is required. Keep 32×48 frame size, feet and appearances; extend atlas columns deliberately. Roster hardcodes 12-column modulo/division (`OfficeWorkspace.tsx:109`) and must consume the same atlas column count. Update frame/content tests and generated manifest together; total remains ≤400 KiB (`script/generate-office-art.ts:14-28`). No Claw3D art.

**Proposed Office Layout rule wording:** “Research, verification and coordination MUST use distinct category-appropriate gestures at their owned task spots; these gestures MUST NOT imply an unreported tool, result or conversation. Work-pose art MUST be generated by `script/office-art`; decorative leisure MUST keep reusing existing poses.” Keep W23's no-new-leisure-asset clause, add work-pose ownership to the Office Components row. W29 unchanged.

**Tests:** `src/remote/office/characters.test.ts` checks every new direction/appearance/frame, generator determinism, feet and clipping; `director.test.ts` checks arrival-only pose and interrupt-to-hold/wave; `map.test.ts`/`open-plan.test.ts` retain owned routes. `verify/office-engine.integration.test.ts` asserts actual animated frame changes for active work and fixed frames reduced, at readable zoom in both themes. `verify/office.integration.test.ts` proves roster/bubble text remains exact and identity is stable.

**Risk:** medium; atlas consumers can drift, category art can overclaim precision, frame-size changes could harm pixel fidelity. All atlas consumers and asset loading must pass; no change to public Protocol, stored preferences or wire shapes.

## 3. Varied finite idle workday loops — M

**User-visible behavior:** idle workers sometimes remain at desk, sometimes walk to pantry, pause facing coffee machine, then rest on a sofa/reading seat or return home; others play at the existing table. Reuse a short stand/wave/stand transition for a small stretch-like idle gesture, not a labelled exercise. Avoid everyone leaving together or staying at table forever.

**Facts:** backend `executing:false` → actor `status:"idle"`; additionally require `source:"projection"`, snapshot `connection:"ready"` and settled activity inputs (`types.ts:66,71,82-87,105`; `model.ts:157-178`). Timers and stable identity seed decide decoration only, never task status. Terminal `taskState` still departs; reduced/hidden/offline interrupts schedules rather than catches up on return.

**Must change:** `apps/web/src/remote/office/director.ts` (bounded rest/travel/dwell/return phase), `map.ts` (existing leisure destinations with appropriate sit/stand/facing), `leisure.ts` only if ball membership needs stronger guarding, `director.test.ts`, `leisure.test.ts`, `map.test.ts`, `open-plan.test.ts`, both Office integration suites, `apps/web/DESIGN.md`. Use existing `OfficeSpot` poses; do not introduce a general behavior plugin or persisted schedule.

**Art:** existing walk/stand/sit/wave/talk frames and existing pantry/sofa/reading-seat props. Coffee stop is approach/pause, not verified cup pouring/drinking. No new asset or generator change under W23.

**Proposed W23 replacement for leisure sentence:** “Backend-confirmed idle members MAY use finite desk-rest, pantry-stop, seated-rest and table-play sequences with identity-varied dwell times and existing poses. Each destination MUST have one claim; agents MUST perform only after arrival and return or choose another free rest after a bounded dwell. Decorative actions MUST create no tool, task, speech or schedule labels and MUST NOT persist.” Retain immediate cancellation/static reduced clauses; reflect finite rests in Office Layout/Components. W29 unchanged.

**Tests:** `director.test.ts` drives elapsed time, checks varied but repeatable schedules, arrival-before-action, unique spots, finite return and cancellation at every phase; `leisure.test.ts` checks ball disappears when either end leaves. `map.test.ts`/`open-plan.test.ts` check seats, routes and all 16 actors. `verify/office-engine.integration.test.ts` renders coffee-facing/seated poses and work interrupt without stale ball/gesture. `verify/office.integration.test.ts` verifies no invented activity text, calls or new storage fields on return/selection.

**Risk:** medium; synchronization, long-distance travel and reserving/restoring spots may create crowding. Choose explicit finite phases and released reservations; no promise of time-of-day, productivity, health or real coffee consumption. Hydration remains direct, not itinerary replay.

## 4. Clear in-place delegation and report exchanges — S

**User-visible behavior:** the existing two participants briefly face each other and use a speaking/listening gesture at current locations, with a compact fact-backed Delegated/Reported cue rather than an ambiguous talk loop. An active task label remains readable. No walk to another desk, shared review performance or invented response text.

**Facts:** `OfficeSnapshot.cues`, `OfficeCue.id/kind/fromActorID/toActorID/outcome`; projected resident family ownership; `OfficeActor.status/source`. Actual event edges already come from `TeamInput.cues` (`types.ts:50-61,92-115`; `model.ts:142-150`). `OfficeWorkspace.tsx:129-135` already announces verified title/outcome; reuse its provenance, do not manufacture speech from description.

**Must change:** `apps/web/src/remote/office/director.ts` (cue facing/gesture lifetime), `OfficeScene.ts` (normal-motion fact cue plus existing reduced badge), `director.test.ts`, `model-team.test.ts`, `verify/office-engine.integration.test.ts`, `verify/office.integration.test.ts`, `apps/web/DESIGN.md`. `OfficeWorkspace.tsx` is a verification target unless shared cue presentation requires a direct adjustment. No replay queue beyond existing bounded scene ownership.

**Art:** existing talk/wave/static poses; scene-drawn fact badge uses current palette/font. No new asset. Speech is never displayed just because a talk frame plays.

**Proposed Office Layout/Components addition:** “Corroborated delegate/report cues MUST identify their two resident family actors in place, preserve current work text, expire promptly and never replay on hydration, reconnect or visibility restoration. Attention feedback MUST outrank decorative gestures; no cue MUST imply a shared review or unreported spoken response.” W23 remains the cancellation/static baseline; W29 unchanged.

**Tests:** `director.test.ts` checks only those participants turn, expiry restores activity facing, concurrent attention is preserved, no path/position changes and terminal child exits after report. `model-team.test.ts` retains foreign/overflow-child rejection. Engine suite asserts visible fact badge, unchanged positions, readability against work bubble and static reduced state. Remote Office suite retains live announcement/no-replay, no extra transcript load, request routing and no mutation resend.

**Risk:** low-to-medium; facing can obscure current task pose, multiple live cues can compete with work plates. Keep work and attention primary and drop expired visual cues; durable runtime remains untouched.

## 5. Silent idle gatherings at the standup spot — M, depends on 3

**User-visible behavior:** small groups of two or three **idle** peers occasionally walk to separate free spots beside the existing meeting table/whiteboard, face inward, alternate existing talk/stand gestures briefly, then disperse to rest. This looks social, but is not labelled “Standup,” “Pairing,” or a task conversation.

**Facts:** each participant independently has ready, projection-backed `OfficeActor.status:"idle"`; same `OfficeSnapshot.scope` and nonterminal `taskState`. Presence is cosmetic, not `OfficeActivity.coordinate` or a `TeamCue` fact. Existing `room:"meeting"` maps active work to owned planning spots and remains there (`model.ts:183-188`; `director.ts:162-164`). An actor cannot simultaneously join table play, another group or an in-place factual cue.

**Must change:** `apps/web/src/remote/office/director.ts` (small ephemeral group ownership and release), `map.ts` (meeting-edge spot metadata/facing), `types.ts` only for necessary presentation metadata, `director.test.ts`, `map.test.ts`, `leisure.test.ts`, `verify/office-engine.integration.test.ts`, `verify/office.integration.test.ts`, `apps/web/DESIGN.md`. No standup controller, scheduling service or new endpoint.

**Art:** existing walk/talk/stand/sit frames and conference-table/whiteboard furniture. No new speech bubble/art. No copy of Claw3D meeting cards.

**Proposed W23 addition:** “Idle decorative gatherings MAY occupy at most three distinct meeting-edge spots for a bounded dwell, with no meeting/task/speech labels. Any participant's renewed work, attention or unavailable state MUST release its membership immediately without waiting for the group; the remaining group MUST end if fewer than two eligible members remain.” Office Layout/Components must distinguish decorative gatherings from runtime-confirmed collaboration. W29 unchanged.

**Tests:** `director.test.ts` proves all-idle admission, arrival-before-talk, group/spot exclusivity, 16-actor bound, timeout, per-member work/attention interruption and reduced settling. `leisure.test.ts` proves group members do not also sustain rally. Engine suite asserts rendered inward poses, no invented speech plate and rapid dispersal on factual work. Remote Office suite asserts unchanged backend labels/counts, no standup/tool requests and scene continuity across selection/reconnect.

**Risk:** medium; even a silent grouping can suggest real collaboration. Keep it visibly decorative, idle-only and short; if product requires actual standup meaning, use the contract gate below rather than relabel this behavior.

## 6. Polite shared-floor passing without work detours — M, depends on 3/5 travel

**User-visible behavior:** agents approaching the same shared-corridor cell briefly yield rather than pass through each other. Arrival facing and work gestures remain deliberate. No collision speech, shoving, teleporting or escaping to random roam points.

**Facts:** actor status/activity/source decides destination priority; existing frame/path position is presentation state, not a new runtime fact (`types.ts:135-146`; `director.ts:183-220`). Corroborated attention and resumed work cannot wait for decorative group dwell. Reduced mode skips passing choreography and settles directly.

**Must change:** `apps/web/src/remote/office/director.ts` (next shared-cell admission with stable tie order and bounded yield), `navigation.ts` only if constrained path re-evaluation is necessary; preserve BFS and claim predicate. Update `director.test.ts`, `open-plan.test.ts`, `map.test.ts`, `verify/office-engine.integration.test.ts`, and `apps/web/DESIGN.md`. Remote Office integration remains a continuity/label/camera regression target.

**Art:** existing walk/stand frames, no collision icon/bubble or new asset. Reuse the current time-based speed envelope; do not import Claw3D's frame-dependent speed or escape-roam policy.

**Proposed Office Layout addition:** “Shared-floor travel MUST use deterministic bounded yielding at occupied route cells, never displace another actor into furniture or a claim. Yielding MUST preserve the latest backend-owned work destination and MUST NOT invent speech or delay cancellation of leisure. Reduced motion MUST settle directly.” Office Components references this routing behavior; W23/W29 semantics remain unchanged.

**Tests:** `director.test.ts` and `open-plan.test.ts` cover same-cell approach, opposite-direction passage, stable tie winner, no starvation within documented bound, immediate retarget during yield, no other-claim crossing and 16 concurrent movers. Engine suite samples actual sprite positions/frames during a crossing, verifies no overlap after admission and forward progress at 20/30 FPS. Remote Office suite preserves camera/roster selection and no new wire operations.

**Risk:** medium-high within web; naïve occupied-cell waiting deadlocks opposite traffic. Before implementation, reproduce a shared-route conflict with existing map fixtures and choose the smallest bounded reservation/yield rule that proves forward progress without changing work targets. If that proof needs a large traffic simulator, stop at the decision gate instead of expanding this increment. No backend impact.

## Backend fact / Protocol gates — explicitly outside these web increments

| Requested semantic behavior | Missing fact in current Office input | Boundary needed before truthful implementation |
| --- | --- | --- |
| Actual scheduled/manual standup with speakers/content | No meeting ID, participants, phase, arrivals, current speaker or fact-backed speech in `types.ts`; activity `room:"meeting"` is only a category. | New runtime-owned meeting/interaction fact, Schema/Protocol exposure, Server/remote forwarding and web adapter contract. Do not create a browser-owned meeting lifecycle. |
| Coding pairs / joint review | No relationship ID, partner Session IDs, shared task/review target, participation phase or review outcome. Team parent-child plus delegate/report does not establish pairing. | Explicit collaboration facts through approved runtime → Protocol → remote transport; ownership/security/consumer tests and contract approval. |
| “Reading file,” “Typing reply,” or “Review approved” precision for every actor | Family activity has only kind/room/text, not structured tool subtype/target/result. Selected detail has active tool for one actor, not the whole family. | Existing text may be displayed verbatim; deriving a new specific action/outcome requires a structured authoritative fact and public contract work. Never parse prose or reuse old transcript results as truth. |
| Workday time, breaks scheduled by backend, mood/health/productivity | No such fact exists in the read shapes. | Cosmetic idle timers are permitted; reporting these semantics would require approved runtime facts, not a hidden web simulation. |

These are required gates for those semantics, not promised extra increments. The six proposed web increments need no public Protocol change, migration, CI change, dependency installation or new stored authority.

## Acceptance and implementation verification

1. Write the missing behavioral assertion in the named existing suite, observe intended RED, implement, then GREEN; preserve currently passing behavior rather than manufacture RED for already-satisfied movement/table play.
2. Run affected `src/remote/office/*.test.ts` suites from `apps/web`; for art, include `characters.test.ts`/`environment.test.ts` and inspect regenerated PNG/manifest sizes. Reused-art increments must not regenerate unchanged assets.
3. Run `YCODING_WEB_CHROME=<installed executable> bun test verify/office-engine.integration.test.ts verify/office.integration.test.ts` with finite memory/timeout. Extend existing fixtures only as necessary; sample rendered frame IDs/positions as well as text. Browser suites require the executable and generate captures; they were **not run in this read-only phase**.
4. Render ordinary/reduced, light/dark, working/idle/thinking/attention/offline/reconnecting/unsupported/error, 1/3/16 actors, hydration/refresh/new arrival, same-family selection and different-family replacement. Use existing tablet/desktop and short-height checks; the real phone stays Conversation. Measure Fit/default zoom and reachable controls, not just a cropped social screenshot.
5. Keep hidden-page suspension, 20/30 FPS frame cap, DPR≤2, cleanup, no draft loss, no extra execution/transport calls, truthful text and roster focus. No new telemetry or persistence is needed.
6. In an authorized implementation phase, update owning Office Layout, W23 wording and Office Components with the implemented behavior in the same change; preserve W29. Strict-lint changed design chain files, run `src/styles/design-md.test.ts`, affected package typecheck and applicable repository lint checks. Validate normal asset build only when art/imports change. Do not treat this plan's prose as design approval.

## Phase evidence / delivery risk

The read-only baseline passed `bun test ./src/remote/office` (108/108; exit 0) and strict lint on both design-chain files (0 errors/warnings each). An in-memory director probe confirmed stale ambient chat after work sync. Full reduced-frame freezing is a source-level gap, not a completed browser reproduction. All proposed behavior, pixel readability, traffic progress and new-art quality remain unverified until the named assertions/render checks run.

Rollback for future web work is code/generator reversion and regeneration from the matching source, with no data migration or public-contract transition. These documents are internal: the public docs registry/Vite build does not import this directory (`apps/web/src/content/docs/registry.ts:1-7`; `apps/web/vite.config.ts:1-5`). Keep it outside `public` and the curated registry; publication is not part of this task.
