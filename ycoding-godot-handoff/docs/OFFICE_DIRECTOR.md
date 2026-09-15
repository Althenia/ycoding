# OfficeDirector: automatic workplace behavior

## Inputs and outputs

Input: verified canonical state changes and optional social interactions with provenance. Output: local visual actions. It cannot launch subagents, approve tools, prompt models, write the repository or modify session history.

Keep `runtime_status` separate from `visual_activity`. Example: a worker may already be running while a short delegation scene finishes. The inspector shows RUNNING immediately. Coffee is always `ambient`, never evidence of work.

## Mapping rules

| Client-internal fact | Visual response | Truth/fallback rule |
|---|---|---|
| Root admitted/processing | Lead attentive, reading or generic processing indicator | Not a depiction of private reasoning; no forced extra “CEO” request |
| Delegation accepted | Lead visits child desk anchor, faces worker, short instruction excerpt | Trigger from verified parent-child launch/instruction, not mere child discovery on reconnect |
| Work activity changed | Read/type/terminal/test desk variant | Unknown tool/activity → generic working; no guessing from arbitrary tool output text |
| Message/question delivered | Source-backed bubble; important questions may cause a visit | Cosmetic nod allowed; fake answer/acknowledgment text forbidden |
| Awaiting human decision | Immediate attention marker and active decision panel | Director cannot resolve it; travels must not delay UI availability |
| Report delivered to parent | Child visits parent or brief remote report badge | Completion without an actual report may show neutral “work finished,” not an attributed invented report |
| Review interaction | Appropriate shared anchor/meeting scene | Only claim review if real source supports it; otherwise present a generic result receipt |
| Session inactive/settled | Current state label and return/idle behavior | Do not conflate inactive with successful task completion |
| Failure/cancel | Cancel stale cosmetic actions, immediate truthful status | Never play later success celebrations from an obsolete queue |
| Rehydrate/reconnect | Position according to current state, history refresh | No historical event reenactment flood |

These labels are not raw YCoding event names. The mapper is where the verified wire contract meets the proposal [INTEGRATION.md](INTEGRATION.md).

## Actor state and ownership

`ActorPresentation` contains scoped assignment key, display profile, canonical status, current activity class, position/route, destination anchor, active interaction token, queue generation and selected state. Domain fields are read-only to the director. Avatar position is never a backend command.

Every asynchronous animation/path/bubble completion checks its interaction token and generation. On interruption or session removal, invalidate the token, release anchors and stop obsolete tweens. A late callback must not resume an old “working” pose after cancellation.

## Priorities and freshness

Priority order: failure/cancel/disconnect invalidation → human attention → active work/state correction → important question/report/delegation → routine status → ambient.

Canonical state updates are never queued behind animation. Decorative actions are bounded and coalesced. Start with 8 queued actions per actor and a 10-second maximum age for starting a social travel action. If stale, retain its history item but replace travel with a small recent-activity cue or discard the reenactment. Do not discard human attention or durable history. These are design defaults to tune through tests.

A burst of delegations may show one concise lead interaction and individual worker-start cues. A meeting can be a visual batching device, but it must not fabricate a multi-party conversation or change its participants/wording. All actors need not physically visit every other actor for every status change.

## Navigation and anchors

Use grid blockers derived from walls/furniture and a single AStarGrid2D navigation map. Disable diagonal corner cutting. Validate every interaction anchor is reachable from relevant doors. Desks expose separate `work`, `visitor` and `approach` points with facing direction. Doors expose passage occupancy; conversation anchors have capacity. Do not place workers on desk surfaces or use the same point for both speakers.

A small anchor registry owns reservation tokens and releases them on completion, interruption, disconnect, node removal and timeout. Dynamic actors may yield briefly/replan; avoid building a general crowd simulator. If a path stays blocked, abandon only the cosmetic travel and use a source-backed bubble/notification at the current valid position. Never cross a wall or make the runtime wait. Log the fallback for visual review.

Test shared destinations, opposite-direction doorway traversal, removed targets and blocked visitor anchors. Collisions must use the character's feet/body footprint rather than the full tall sprite rectangle.

## Micro-sequences

**Delegation:** leave seat → route → align at visitor anchor → turn both actors → bubble with source → nonverbal acknowledgment → release visitor anchor → return/continue current work.

**Report:** child stops work pose → route to lead → turn → source-backed report excerpt → retain complete report in history → return/idle according to actual current state.

**Question:** attention marker appears immediately → optional visit → exact question → wait state remains until a real answer arrives → answer bubble only from actual source → new work state.

**Ambient:** seeded idle timer chooses coffee/stretch/read/window/desk; no prose conversation, no model call and no canonical mutation. Real work cancels ambience. The seed is fixed in regression playback; live ambience may use a session-local seed.

## Bubble layout

One active social bubble per actor; initially three visible across the scene. Prioritize selection and human-attention messages. Long content uses a neutral excerpt/truncation, an ellipsis and source affordance; never an extra LLM call. A quote excerpt should preserve negation and conditions. When safe extraction is uncertain, show a neutral label such as “Report available” rather than rewriting meaning.

Bubbles use actor-to-screen transforms, stay within the world viewport and avoid covering prompt/approval controls. History receives the item immediately even when its bubble is postponed or suppressed. Status indicators do not enter conversation history.

## Required director tests

The production director must accept a deterministic clock and injected navigation/animation boundaries. Test duplicate interaction IDs, fresh status arriving mid-walk, cancel during sit, unreachability, reservation release, same-role concurrent actors, stale completion callbacks, queue overflow, reconnect without old bubbles and reduced-motion mode. A test that simply reimplements the mapping table outside the real director is insufficient.
