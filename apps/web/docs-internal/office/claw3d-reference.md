# Claw3D reference: visible agent workdays

Internal research, 2026-10-09. This is behavioral reference material, not permission to change YCoding's engine, art, runtime, or design rules. No Claw3D code or art is copied.

## Evidence boundary

- **Verified source** means the fetched implementation contains the stated branch or rendering behavior; it does not mean Claw3D was run here.
- **Documented** means a README/design claim, not independently demonstrated functionality.
- **Inference** means a proposed transferable principle; **unverified** means the inspected files do not establish it.
- Discovery used the GitHub recursive tree for `main`, which returned revision `0565b7892909eca7bbc8f2d9b0fad171dd75ad7c`. Source files were fetched with `webfetch` from revision-pinned `raw.githubusercontent.com` URLs. The four introductory documents were fetched from `main`; their citations below retain those actual URLs.
- Scope: the immersive `/office` stack, not the separate Phaser `/office/builder` stack. `CODE_DOCUMENTATION.md`, “Office Architecture,” explicitly separates them.

## Files actually fetched and read

Links are the raw sources. Large composition files were read in the named sections, not audited in full; directory discovery is not a claim that every directory entry was read.

| ID | File | Read scope / evidence |
| --- | --- | --- |
| D1 | [README.md](https://raw.githubusercontent.com/iamlukethedev/claw3d/main/README.md) | Entire document: shared office, standups, PR review, runtime support, two office stacks, MIT badge. |
| D2 | [VISION.md](https://raw.githubusercontent.com/iamlukethedev/claw3d/main/VISION.md) | Entire document: visualization over runtime intelligence; digital-city direction is aspirational. |
| D3 | [ARCHITECTURE.md](https://raw.githubusercontent.com/iamlukethedev/claw3d/main/ARCHITECTURE.md) | Entire document: runtime owns state; event-trigger logic derives animation/room cues. |
| D4 | [CODE_DOCUMENTATION.md](https://raw.githubusercontent.com/iamlukethedev/claw3d/main/CODE_DOCUMENTATION.md) | Entire document: intent → event reduction → reconciliation → scene; explicit persisted desk assignments. |
| C1 | [src/lib/office/eventTriggers.ts](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/lib/office/eventTriggers.ts) | Entire fetched source: `reduceOfficeAnimationTriggerEvent`, `reconcileOfficeAnimationTriggerState`, `buildOfficeAnimationState`, latch constants. |
| C2 | [src/lib/office/deskDirectives.ts](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/lib/office/deskDirectives.ts) | Entire fetched source: unified natural-language desk/review/QA/gym/standup/call/text intent parser. |
| C3 | [src/features/office/screens/OfficeScreen.tsx](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/features/office/screens/OfficeScreen.tsx) | Sections: `mapAgentToOffice`, animation assembly (3180–3253), standup trigger (4075–4094), `officeAgents` (4215–4304); not the entire UI/controller. |
| C4 | [src/features/retro-office/RetroOffice3D.tsx](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/features/retro-office/RetroOffice3D.tsx) | Sections: `useAgentTick` (848–2198), away threshold (2199), ping-pong click handler (4470–4566), actor speech props (5695–5776); not the whole scene/editor. |
| C5 | [src/features/retro-office/core/navigation.ts](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/features/retro-office/core/navigation.ts) | Entire fetched source: nav grid, A*, desk/meeting/QA/gym targets, roaming points. |
| C6 | [src/features/retro-office/core/navigation/serverRoomRoute.ts](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/features/retro-office/core/navigation/serverRoomRoute.ts) | Entire source: outer door → inner door → terminal stages. |
| C7 | [src/features/retro-office/core/constants.ts](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/features/retro-office/core/constants.ts) | Entire source: walking, sticky desk, bump, ping-pong timing constants. |
| C8 | [src/features/retro-office/core/types.ts](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/features/retro-office/core/types.ts) | Entire source: `RenderAgent` physical states, interaction stages and partner fields. |
| C9 | [src/features/retro-office/objects/agents.tsx](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/features/retro-office/objects/agents.tsx) | Entire fetched source: body/face animation, held props, names and speech bubbles. |
| C10 | [src/features/retro-office/systems/NavigationSystem.tsx](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/features/retro-office/systems/NavigationSystem.tsx) | Entire source: overlapping agents freeze, face, choose escape destinations. |
| C11 | [src/features/retro-office/systems/sceneRuntime.tsx](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/features/retro-office/systems/sceneRuntime.tsx) | Entire source: frame-driven game loop and two-player ball flight. |
| C12 | [src/features/office/hooks/useOfficeStandupController.ts](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/features/office/hooks/useOfficeStandupController.ts) | Entire source: manual/scheduled start, arrival reporting, timed speaker progression. |
| C13 | [src/lib/office/standup/service.ts](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/lib/office/standup/service.ts) | Entire source: summary-card/speech construction and meeting-state transitions. |
| C14 | [src/lib/office/deskMonitor.ts](https://raw.githubusercontent.com/iamlukethedev/claw3d/0565b7892909eca7bbc8f2d9b0fad171dd75ad7c/src/lib/office/deskMonitor.ts) | Entire source: transcript-derived monitor modes, extracted code or pseudo-editor previews. |

## A. Movement decisions and triggers

| Trigger | Concrete spatial decision | Evidence |
| --- | --- | --- |
| Runtime running / `runId` / recent traffic | Prefer assigned desk; working arrivals become `sitting`. Without a desk assignment, working agents stand in place rather than receive a made-up desk. | C3 `mapAgentToOffice`, `officeAgents`; C4 `useAgentTick`, desk assignment and working branches. |
| Explicit desk command | Unified intent sets a desk hold, restored from latest user text/transcript; release clears it. | C2 `resolveOfficeIntentSnapshot`, `reduceOfficeDeskHoldState`; C1 `applyUserMessageTriggers`, reconciliation. |
| “Review code/PRs,” GitHub/server-room command | Sets GitHub hold; scene routes through server-room entrance stages to the terminal and stands there. This is parsed intent, not proof that a review tool has executed. | C2 review regexes; C1 GitHub hold; C4 GitHub branch; C6 route stages. |
| Test/verify/reproduce/QA intent | QA hold routes to a station derived from authored terminal, rack, or bench furniture; staged entry ends standing. | C2 QA intent parser; C5 `getQaLabStations`; C4 QA branch. |
| Gym/skill-building hold | Select an equipment station, traverse route stages, enter `working_out`; station supplies run/lift/bike/box/row/stretch style. | C1 gym holds; C5 `getGymWorkoutLocations`; C4 workout branch. |
| Active standup | Only `participantOrder` members gather at authored meeting chairs plus overflow locations; turn inward and sit on arrival. | C4 `standupActive`, `meetingParticipants`, `resolveMeetingTarget`; C5 `getMeetingSeatLocations`. |
| Working becomes idle | After the effective work/desk stickiness clears, choose a roam destination. At rest, a per-frame random chance starts another walk, sometimes toward social furniture. | C4 effective status, transition to idle, tick idle branch; C7 `DESK_STICKY_MS = 10000`. |
| Long inactivity | After 15 minutes since positive `lastSeen`, idle agents select a random couch/beanbag and later use `away`. Despite the source comment saying “nearest couch,” selection uses randomness. | C4 `AWAY_THRESHOLD_MS`, `awayFurniture` branch. |
| User clicks ping-pong table | Choose two nearest eligible resting idle agents (or reuse existing pair), route to opposite ends for a 60-second session. It is not automatically runtime-triggered in this handler. | C4 table click handler; C7 `PING_PONG_SESSION_MS`. |

Existing-agent destination precedence in C4 is meeting → gym → QA → GitHub → SMS → phone → desk → unassigned working stand → error stand. The separate status-transition/new-agent target expression orders SMS/phone ahead of QA/GitHub. Do not describe this as one globally uniform priority order.

## B. Visible action catalogue: gestures versus workflows

| Action requested in the comparison | What the inspected implementation establishes | Classification |
| --- | --- | --- |
| Walking | Opposed arm/leg swings, small vertical bounce, interpolated position and facing. | Verified source: C9 `useFrame`. |
| Desk work / typing | Working actors sit at desks; seated body leans and arms hold a forward pose. Coding/browser monitor content exists. A dedicated cycling keyboard-typing body animation is **not verified** in C9. | Verified sitting/monitor; typing-specific animation unverified: C4/C9/C14. |
| Reading | Monitor can show browser/transcript/code content; no separate `reading` physical state or book-reading animation is established by C8/C9. | Dedicated reading animation unverified; do not infer it from README collaboration language. |
| Standup | Gathering, seating, speaker-specific speech bubble, summary-card board and timed speaker changes. Speaking is a UI summary display, not established as a fresh LLM reply per speaker. | Verified source: C4 actor props, C12/C13. |
| Review | Parsed review intent routes an actor to server-room terminal; GitHub immersive view is composed in C4. No review-specific body state in C8/C9. | Verified routing/UI composition; actual review execution/results not audited. |
| Coffee / water | Coffee machine and water cooler are social walk targets. A drinking, cup-fetching, or pouring animation is not established by the inspected actor source. | Verified destination: C4; consumption animation unverified. |
| Idle / away | Standing breath, identity-seeded blinking, smile/frown/brows; occasional ambient ellipsis bubble; away fades body and shows `z z z`. | Verified source: C9. These decorative text cues do not meet YCoding's fact-only bubble constraint. |
| Ping-pong | Pair routes to table, held paddles swing; ball appears only with two players on the same table who have stopped walking. | Verified source: C4/C9/C11. |
| Stretch / exercise | Six workout styles animate limbs and body differently. | Verified source: C5/C9; not evidence of real training progress. |
| Dance / cleaning | Actor renderer supports dance and janitor props; event projection exposes reset cleaning cues. | Verified renderer/trigger support: C1/C8/C9; full initiating dance/cleaning workflows not audited. |

## C. Runtime → presentation mapping

1. **Immediate event reduction:** C1 `reduceOfficeAnimationTriggerEvent` classifies chat/agent events, resolves `sessionKey` to agent, records `runId` work, assistant-text streaming, and reasoning activity. Work latch is 5 seconds; streaming/thinking latches are 6 seconds. Approval requested/resolved can also renew the work latch.
2. **Intent:** C1 applies C2's unified parser to fresh user-like chat text. Main-agent standup intent creates a keyed pending request; manual gym intent gets a 60-second latch. This is frontend interpretation of text, not a runtime activity taxonomy equivalent to ours.
3. **Reconciliation:** C1 restores holds from latest user message/transcript, prunes removed agents/expired timers, renews work while running, and expires pending standup requests after 30 seconds. Session reset detection produces bounded cleaning cues.
4. **Projection:** C1 `buildOfficeAnimationState` exposes booleans/timers, including approval, work, streaming, thinking, room holds, calls and texts. C3 adds skill-trigger movement holds and dance state; it can promote effective presentation status to running from a latch or room hold.
5. **Scene consumption:** C4 `useAgentTick` consumes room holds/effective actor status and assigns paths/poses. Its inspected signature does not consume every streaming/thinking boolean. Stream/reply text separately reaches C4's speech props; standup speech overrides ordinary speech during the meeting.

**Important difference:** a source-of-truth architecture statement (D3) does not make every visual detail a backend fact. C14 `derivePseudoEditor` invents example editor content when no code fence exists; C13 can fall back to “Reviewing current work.” YCoding must not import these synthesized work/speech semantics.

## D. Believable motion mechanisms

- **Pathing:** C5 builds a 25-unit navigation grid using furniture bounds/padding and perimeter blockers. A* supports eight directions but forbids diagonal corner cutting; blocked endpoints search for nearby free cells. C4 caches the grid by furniture-array identity. Empty paths keep actors in place rather than walking through walls.
- **Staged approach:** C6 separates outer entrance, inner entrance and terminal; C4 similarly advances room routes on arrival. Transferable inference: approach → arrive → face → perform reads more intentionally than unrelated roaming.
- **Speed variety:** C7 base `WALK_SPEED = 0.3`; C4 assigns `0.7–1.3` times base per agent and a random animation phase. Working travel multiplies by 3; ping-pong approach has a separate floor. These are per-tick increments, not verified units per second: C11 `GameLoop` calls tick once per frame without elapsed delta.
- **Pauses:** C7 sticky desk hold is 10 seconds; collision freeze 1.5 seconds, recovery 1.2 seconds. C4 pauses janitors at stops and uses a `0.005` chance per idle frame for another trip. This is not a time-based workday schedule.
- **Collision interactions:** C10 uses spatial buckets and an agent-radius threshold; overlap stops eligible actors, turns them, chooses an escape roam point, and starts a temporary bump-talk window. C4 then replans. Copying the escape-to-roam policy would violate our active-work destination ownership.
- **Micro-animation:** C9 position lerp `0.15`, facing interpolation `0.12`, breathing/blinking and phase offsets avoid identical rigid workers. These constants are frame-sensitive; do not transplant them into our delta-based director.
- **Bubbles:** C9 flattens Markdown, caps active speech at 180 characters / four estimated lines, and adds click-for-full-chat when truncated. It also synthesizes ambient `...`, `error`, and `z z z`. Transfer layout/attention principles, not fabricated speech.

## E. Multi-agent interactions

- **Standup is explicit group state:** C12 POSTs a manual/scheduled meeting request, reports arrivals, starts the first speaker when everyone arrives, then advances/completes from `speakerDurationMs`. C13 stores participant order, arrivals and speaker state in the meeting shape. C4 allocates seats by participant index. This cannot be inferred from several independent agents happening to coordinate.
- **Standup content provenance:** C13 constructs cards from manual current task, Jira ticket, latest preview, last user message, GitHub title, or a generic fallback; adds manual/failing-check blockers. C4 displays the current speaker's card speech. Backend-derived cards do not imply verbatim agent conversation.
- **Physical pairing is verified for leisure:** C4 assigns `pingPongPartnerId`, opposite sides and table UID; C11 requires two resting players before ball flight. C10 supplies brief incidental face-to-face bump interactions.
- **Code pairing/review collaboration is unverified:** D1 says agents collaborate/review/execute side by side; no explicit two-agent code-pairing choreography or shared-review relationship was verified in the inspected actor/director files. Do not claim the ping-pong partner field is a coding partner.

## Transfer boundary

Use: clear destinations, arrival-facing, distinct work gestures, finite idle variety, bounded social groups, and readable corroborated cues. Keep YCoding's 2D Phaser/pixel art, exclusive claims, static reduced motion and backend-first interruption. Do not add 3D, Claw3D assets, parsed-prompt room holds, sticky invented execution, synthetic editor output, or decorative speech text.

Not verified here: rendered Claw3D fidelity/performance, reduced-motion support, actual provider/PR/QA execution, backend implementations outside fetched files, dedicated typing/reading/drinking animation, or code-pairing choreography. The evidence supports source-level mechanisms only.
