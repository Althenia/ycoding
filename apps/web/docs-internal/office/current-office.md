# Current YCoding web Office behavior

Internal source audit, 2026-10-09, branch `web-wide-layout`. Product code was read-only. Paths below are repository-relative; line ranges cite this worktree's live files. Rules are requirements, not proof that every rendered behavior already conforms.

## Read boundary

Read `apps/web/src/remote/office/{types,model,director,leisure,navigation,map,sprites}.ts`, `OfficeScene.ts`, `OfficeWorkspace.tsx`, and every existing `*.test.ts` in that directory. Also read `adapter.ts`, `preferences.ts`, `OfficeCanvas.tsx`, `create-game.ts`, the test helpers, both `apps/web/verify/office*.integration.test.ts` suites, `script/generate-office-art.ts`, relevant character-generation source, root `DESIGN.md`, web `DESIGN.md`, web `AGENTS.md`, and the product documentation authority/direction.

## 1. Data flow and population

`RemoteStoreState` → `officeInputFromRemote` → `OfficeInput` → `projectOffice` → `OfficeSnapshot` → latest-state mailbox → `OfficeDirector` → `ActorFrame` → Phaser `OfficeScene`; frame locations return to the DOM roster. Evidence: `apps/web/src/remote/office/adapter.ts:7-56`, `model.ts:40-89`, `OfficeScene.ts:239-269`, `OfficeWorkspace.tsx:20-49`.

- A scene requires owner, device and selected Session; scope is `[ownerID, deviceID, rootID]`. Actors have `[deviceID, sessionID]` IDs. Team root comes from `team.rootID`, otherwise the selected Session. Only that root and deduplicated direct members with matching `parentID` enter; unrelated Session inventory does not supply actors. `apps/web/src/remote/office/model.ts:40-59,75-88`.
- **Visible cap: 16**, including root and selected child. Selected actors sort first; excess loaded members become `overflow`. Reported team total/more remain separate. The roster also uses this capped snapshot, so off-camera actors remain available, but it is not an uncapped roster of every unloaded/overflow member. `apps/web/src/remote/office/model.ts:15,47-59,73-86`; `OfficeWorkspace.tsx:62-89`.
- Human names are deterministic hashes with collision suffixes; roles and task descriptions stay separate. Appearance hashes into 12 looks, not 16 unique looks. `apps/web/src/remote/office/model.ts:60-71,104-105,128-129`; `sprites.ts:4,20-22`.

## 2. Backend facts and derived states

`types.ts` declares presentation shapes; it does not itself derive behavior. Derivation is in `model.ts`.

| Input / output field | Meaning and actual use | Evidence |
| --- | --- | --- |
| `OfficeInput.connection` | `ready/offline/reconnecting/unavailable`; gates source availability, travel and cues. | `apps/web/src/remote/office/types.ts:63-72`; `model.ts:161-181`; `director.ts:95-98,195-196`. |
| `familyActivity.status`, `.members` | Only a ready read supplies authoritative per-member execution/activity. `RemoteFamilyActivity` carries `sessionID`, `executing`, optional `activity.kind`, `.room`, `.text`. | `apps/web/src/remote/office/types.ts:71,148`; `model.ts:157-164`; `packages/remote/src/index.ts:184-192`. |
| `SelectedSession.requestCount`, `.status`, `.compacting`, `.unknownOutcome` | Selected Session only: pending-decision precedence, failure/interruption, compaction and uncertain-mutation marker. | `apps/web/src/remote/office/types.ts:27-38`; `model.ts:153-155,170-180,111,135`. |
| `SelectedSession.activeTool`, `.activity`, `.thinking`, `.assistantExcerpt` | Adapter derives these, but current projection does not use them to choose work category, thinking status or completed-text bubble. Family activity wins; historical text must not mark an idle actor busy. | `apps/web/src/remote/office/adapter.ts:44-54,85-93`; `model.ts:170-198`; `model.test.ts:29-47`. |
| `TeamMember.state` | Starting/running/waiting/cancelling/cancelled/completed/failed/lost. Waiting forces attention; failed forces failure; completed/cancelled/lost are idle in projection and terminal tasks depart in director. | `apps/web/src/remote/office/types.ts:40-48`; `model.ts:116-139`; `director.ts:248-250`. |
| `TeamInput.cues` → `OfficeCue` | Existing delegation/report event IDs, child ID and report outcome. Only a resident child of the shown family is mapped, and only while connection is ready. | `apps/web/src/remote/office/types.ts:50-61,92-98`; `model.ts:88,142-150`. |

### Status precedence

For ordinary actors: offline → reconnecting → unavailable/unknown → pending request or waiting/attention → failed → interrupted → no family member/unknown → not executing/idle → compacting → thinking-kind/thinking → tool-kind/tool → working. This is member execution, **not** `SessionSummary.running` family aggregation. Terminal child overrides occur before this function. `apps/web/src/remote/office/model.ts:119,170-181`; status union: `types.ts:1-3`.

### Activity mapping

| Derived `OfficeActivity` | Backend condition | Destination today |
| --- | --- | --- |
| `research` | Member activity room `research`. | Own reference spot. |
| `verify` | Room `qa`. | Own QA/test spot. |
| `coordinate` | Room `meeting`. | Own planning/board spot, **not** shared meeting furniture. |
| `implement` | Room `developer`. | Own desk. |
| `hold` | Attention, compacting, thinking-kind or room `hold`. | Director falls back to own implement spot; it does not preserve the previous research/QA location. |
| absent | Idle/unknown, or no activity. | Idle uses lounge/rest handling; other statuses fall back to own implement spot. |

Evidence: `apps/web/src/remote/office/types.ts:23-25`; `model.ts:183-188`; `director.ts:162-180`. A test title says thinking “holds its current room,” but its assertion only checks projected `activity === "hold"`, not director position: `model-team.test.ts:135-150`.

### Truthful text

- Active label is backend `activity.text`, with state-derived phrases for attention, failure, interruption, compaction and connection; executing without text says “Preparing next step.” Idle/unknown labels are empty. `apps/web/src/remote/office/model.ts:190-198`.
- `bubbleFor` suppresses idle/unknown and bubbles-off. Both status and excerpt preference currently use the same fact label; no completed assistant excerpt is rendered. `apps/web/src/remote/office/model.ts:166-168`; `model.test.ts:41-49`.
- Canvas names are bounded name-only labels; unknown mutation replaces bubble with “Action outcome unknown.” Attention/failure/unknown get a marker. Decorative `ActorSpeech` is a gesture, never the displayed bubble text. `apps/web/src/remote/office/OfficeScene.ts:405-422`; `types.ts:132-144`.
- Roster shows name, role, location and full status text (or “Outcome unknown”), plus accessible live delegation/report announcements. Unsupported activity asks to update the machine. `apps/web/src/remote/office/OfficeWorkspace.tsx:70,99-115,129-135`.

## 3. Floor, routes and task destinations

- Continuous **48×38 grid of 32px tiles**, 1536×1216 world pixels; two-cell perimeter entrance at `(23,37)`/`(24,37)`. Blocking furniture and perimeter determine walkability. `apps/web/src/remote/office/map.ts:3-7,179-207`; `map.test.ts:24-35`.
- Sixteen disjoint pods/claims use five templates; activity changes retarget immediately, including mid-walk. Routes forbid all other agents' claims. BFS uses four cardinal neighbors, rejects invalid/unwalkable endpoints, returns `undefined` on failure; director exposes `blocked`, clears the path and stays put. No actor-versus-actor shared-corridor avoidance is implemented in these route functions. `apps/web/src/remote/office/map.ts:48-111`; `navigation.ts:3-25`; `director.ts:75-76,183-220`.
- Work travel must stay in its claim with at most 12 tiles between task spots; tests explicitly assert reachability/ownership. `apps/web/src/remote/office/map.test.ts:37-68`; `open-plan.test.ts:13-59`.

Template coordinates are **relative to each pod origin** (shifted in `map.ts:101-111`):

| Template | Implement | Research | Verify | Coordinate |
| --- | --- | --- | --- | --- |
| row | `(1,2)` up/sit | `(4,2)` up/stand | `(6,2)` up/sit | `(3,3)` down/stand |
| corner | `(1,2)` up/sit | `(5,2)` up/stand | `(7,2)` up/sit | `(4,4)` down/stand |
| bench | `(1,2)` up/sit | `(3,2)` up/stand | `(5,2)` up/sit | `(2,3)` down/stand |
| stagger | `(1,2)` up/sit | `(4,2)` up/stand | `(6,4)` up/sit | `(1,4)` down/stand |
| studio | `(1,2)` up/sit | `(4,2)` up/stand | `(6,2)` up/stand | `(3,3)` down/stand |

Evidence: `apps/web/src/remote/office/map.ts:48-74`. Desk/reference/test/board objects are verified by `map.test.ts:126-140`.

- Delta is clamped to 0–50ms. Travel accelerates/decelerates over a 400ms speed scale, max **4.5 tiles/second = 144 world px/second**; retarget resets speed. Standing facing comes from the destination, walking facing from direction of travel. `apps/web/src/remote/office/director.ts:123-128,192,195-235`.
- First hydration waits for required reads and places known actors directly at work or leisure destinations. Genuine later arrivals enter via door; departing/terminal tasks leave after report gesture expiry if present, fade over 400ms, then disappear. Reduced/connection transitions can settle/remove directly. `apps/web/src/remote/office/model.ts:17-25`; `director.ts:41-93,107-145,238-250`.

## 4. Actions and art that actually exist

| Pose | Frames / rate | Selection today |
| --- | --- | --- |
| stand | Columns 0–1; 1 FPS | Default standing task/rest spot; reduced table play fallback. |
| walk | Columns 2–5; 8 FPS | Non-reduced nonempty path. |
| talk | Columns 6–7; 3 FPS | Active director speech/gesture when not walking. |
| sit | Column 8; static | Seat spot when no higher-priority pose applies. |
| type | Columns 9–10; 4 FPS | At work, working/tool/compacting status, and absent/implement activity. `hold` does not meet that activity condition. |
| wave | Column 11; static | Attention while at its resolved work spot. |
| play | Reuses talk 6–7; 2 FPS | Arrived at a play spot, available source and ordinary motion; no dedicated paddle frames. |

Evidence: `apps/web/src/remote/office/sprites.ts:1-17`; `OfficeScene.ts:94-102,398-402`; `director.ts:223-235`. Precedence is walk → speech/talk → attention/wave → implement/type → play/static fallback → spot pose. Research has no book/page animation; verify is sit or stand, not typing; coordinate is stand, not a dedicated planning gesture.

Characters are 32×48 with feet `(16,46)`, four directions, 12 appearances, 12 columns. Scene renders characters at 1.5 scale, rounds world positions and depth-sorts by feet. Art tests protect content, strides, silhouettes and deterministic generation. `apps/web/src/remote/office/sprites.ts:1-17`; `OfficeScene.ts:375-376,392-404`; `characters.test.ts:21-83`.

## 5. Idle / leisure: already implemented, not a blank feature

- Initially hydrated idle actors start directly at a claimed leisure spot; genuinely later idle arrivals walk there from the door. A worker becoming idle returns toward its desk and waits **6 seconds** before a lounge trip. Once assigned a lounge destination it stays there; there is no general rotating workday itinerary. `apps/web/src/remote/office/director.ts:73-90,140-143,175-180`.
- Claim order prefers all four play spots before hash-rotated other spots. Reserved leisure cells avoid occupied destinations; available map has 26 spots. Table sides `(14,26)`/`(19,26)` face inward; two south positions face up. Sofa/beanbag/reading/meeting-edge/pantry spots are currently all **stand**, despite the furnishings. `apps/web/src/remote/office/director.ts:167-172`; `map.ts:225-235`.
- Shared meeting and pantry are classified as `lounge`, not distinct semantic rooms. Conference table, whiteboard, TV, counter, fridge, coffee machine and bistro tables exist, but no coffee-fetching sequence, drinking pose, scheduled standup or runtime pairing state exists in these types/director. `apps/web/src/remote/office/map.ts:155-169,189,210-215`; `types.ts:23-24,92-98,119-144`.
- Every 5 seconds, resting idle peers in lounge within Manhattan distance 3 can receive a 3-second `chat` gesture, with a 20-second per-actor cooldown. This is decorative; it adds no actual speech label or collaboration fact. The loop can choose more than one qualifying peer, not one exclusive conversation group. `apps/web/src/remote/office/director.ts:147-157`.
- **`leisure.ts` only draws the rally trajectory**: ball exists when play frames occupy both west/east ends. Full rally is 1800ms with a 10px sine arc. Scene creates a 6px ellipse, not an imported asset. The director owns idle decisions/chat/play; not `leisure.ts`. `apps/web/src/remote/office/leisure.ts:4-20`; `OfficeScene.ts:91,270-272`.
- In-place delegation/report gestures set source and recipient speech for 2450/2000ms. They do not route either actor to another workstation. Seen IDs suppress hydration/reconnect/visibility replay; reduced cues use a 750ms static badge. `apps/web/src/remote/office/director.ts:95-103`; `OfficeScene.ts:124-127,206-214,241-253,285-308`.

## 6. Hard rules and implementation differences

| Constraint | Required behavior / evidence | Current boundary or gap |
| --- | --- | --- |
| Backend facts outrank leisure | W23: any non-idle or attention fact stops leisure immediately. `apps/web/DESIGN.md:335`. | Play stops and route changes immediately (`director.ts:74-76,175-180,226-231`; `director.test.ts:234-258`). However `sync` does **not** clear already-active ambient `speech/speechAge`; a confirmed in-memory probe retains `speech:"chat"` after changing actor to working. It walks first, so this is a stale gesture state, not fabricated bubble text. |
| Reduced motion = static pose | W23 and Office component row; system OR preference cannot be overridden. `apps/web/DESIGN.md:335,467`; `apps/web/src/remote/office/preferences.ts:23-25`. | Director settles paths, clears speech, changes play to stand (`director.ts:107-125,226-231`). Renderer still calls `sprite.play` for stand/type (`OfficeScene.ts:398-402`) without a reduced flag: fully static sprite frames are **not established**. Existing integration checks assert no travel/ball, not unchanged frame IDs (`verify/office-engine.integration.test.ts:491-502`). |
| No invented tool/task/speech labels | W23; truthful name/bubble handling. `apps/web/DESIGN.md:335,387`; `model.ts:166-198`. | Ambient chat is only a pose. Excerpt preference does not currently expose completed text. No standup/pairing semantics may be inferred from proximity or role. |
| Original generated art only | Office Layout owns `script/office-art`; W23 additionally says **no new art asset for decorative leisure**. `apps/web/DESIGN.md:335,385,391`. | Any permitted future art must change generator source and regenerate, never hand-edit PNGs or copy Claw3D assets. Generator caps all art at 400 KiB and writes provenance manifest (`apps/web/script/generate-office-art.ts:7-28`). |
| Bounded, stable presentation | 16 actors, exclusive claims, 32px tiles; same-family selection preserves identities and scene. `apps/web/DESIGN.md:387,391`. | No backend execution/storage added; only cosmetic preferences persist. DOM roster retains capped actors regardless of camera region (`OfficeWorkspace.tsx:62-89`); canvas labels/bubbles are view-filtered (`OfficeScene.ts:405-413`). |
| W29 is family activity, not a pose rule | Actual shells/subagent counts and canonical root-running state must remain truthful. `apps/web/DESIGN.md:341`. | Do not use root family running to animate idle root execution. Per-member `executing` remains the Office authority (`model.ts:170-180`; `model-team.test.ts:48-56`). |

Hidden pages pause the engine; returning adopts latest state and settles without cue replay. Standard/battery renderer caps are 30/20 FPS, DPR ≤2, pixel smoothing disabled. Lifecycle cleanup and normal-view recovery are implemented. `apps/web/src/remote/office/create-game.ts:56-81,100-117,129-141`; `OfficeCanvas.tsx:47-73,83-95`.

## 7. Validation evidence and limits

- Executed from `apps/web`: `bun test ./src/remote/office` — **108 passed, 0 failed, 12 files, exit 0**. This is unit/source-art coverage; it does not prove real Phaser pixels or browser accessibility.
- Read integration assertions: actual engine poses/ball/interruption/hydration (`apps/web/verify/office-engine.integration.test.ts:448-571`), in-place handoffs (`:204-218`), scene/roster continuity (`:221-256`), frame caps/lifetime (`:272-318`); remote shell/family activity/draft/decision preservation (`apps/web/verify/office.integration.test.ts:103-255,274-364,464-547`). **Not run**: both browser suites, fresh live render and Claw3D runtime.
- Read-only `bun -e` director probe: four idle actors, 100×50ms ticks → third actor has idle/chat/talk; sync third to working/implement → working/chat/walk/moving. It confirms the stale ambient gesture state described above. No test file or product fix was written.
- Strict design lint: `python3 /Users/viadz/.agents/skills/daedalus/scripts/design_md.py lint DESIGN.md --strict` and the same command for `apps/web/DESIGN.md` — each **0 errors, 0 warnings, exit 0**. No design rule was changed.

See [plan.md](./plan.md) for proposals, not current capabilities; [claw3d-reference.md](./claw3d-reference.md) separates documented claims from verified reference mechanisms.
