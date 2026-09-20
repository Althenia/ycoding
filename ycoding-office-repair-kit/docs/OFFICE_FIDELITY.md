# Office fidelity and truthful behavior

The user-approved direction is a cohesive living pixel workplace, with fine-grained character behavior, not moving dots or a static office background. The supplied current office may already contain good tiles/assets: retain them unless actual visual review shows a problem. Quality gates concern the rendered build, not how many scenes were created.

## Visual quality

Keep a coherent asset scale/palette, furniture composition, walls/doors, readable navigation spaces and recognizable work zones. Use proper sprite depth/occlusion, four-direction facing/walking where assets support it, idle/sit/type/talk/read states, subtle prop effects and stable camera behavior. Prioritize transitions, clarity and asset cohesion over adding rooms. Do not bundle copied Gather assets or unrelated font binaries.

Characters should navigate around furniture, use valid interaction anchors, stop at conversation distance and face participants. A stand/turn/walk/arrive/talk/return/sit transition is a presentation state machine, not a runtime dependency. If pathfinding fails, show the truthful status without blocking real execution or creating endless loops. Avoid rigidly scheduling every delegate animation while the underlying task has already finished.

## State fidelity

| Available evidence | Acceptable depiction | Unacceptable implication |
|---|---|---|
| Active session/provider step | Working/thinking state with accurate status | Exposing private reasoning or claiming a test ran |
| Actual delegation | Manager visits worker; short source description | Fake subordinate just because a desk exists |
| Read/search/edit/tool evidence | Reading/typing/tool animation appropriate to verified kind | Guessing a shell command is a test without classification evidence |
| Actual report message | Worker reports; full source accessible | “All tests pass” from child completion alone |
| Real pending question/review | Attention icon, linked question/review UI | Ambient conversation presented as an actual request |
| Disconnect / missing state | Unknown/reconnecting indicator and canonical resync | False done/idle state |
| No actual work | Cosmetic idle/coffee/stretch | Fictional work messages or conversation history |

Do not infer semantic state by parsing arbitrary prose with another LLM. Use existing structured operations/events and conservative fallbacks. Keep one actor identity per active execution representation; two concurrent sessions using the same agent configuration must not overwrite one avatar's status. Display parent/child ownership accurately rather than inventing a permanent hierarchy.

## Choreography constraints

Runtime starts immediately; animations never delay it. Keep per-actor bounded visual queues with priority for failure, interruption and current status. Drop/coalesce obsolete transitions. A busy manager can receive a remote report indicator rather than forcing many simultaneous trips. Reconnect should restore current state without replaying a long obsolete meeting queue.

Ambient behavior is local-only, cheaply scheduled and preemptible. No extra model calls. No fake speech to make an idle scene feel busy. Gestures can be cosmetic; text acknowledgments require actual messages. Reduced-motion mode preserves all semantic status/history without movement.

## Bubble and history fidelity

Use an actual short delegation description or safely truncated source excerpt; preserve uncertainty and test scope. A report excerpt must not turn “unit tests passed; integration not run” into “all tests pass”. Prefer a neutral “Report available” when safe shortening is not possible. Bubbles expire; source-linked durable history does not. Show short text once, coalesce bursts, and keep it readable without covering input or clipped by the viewport. Click/keyboard selection opens the same source message/thread.

## Acceptance evidence

Native normal-speed footage must demonstrate at least one real delegation, simultaneous workers when the runtime produces them, true question/review or blocker, report with source, and history inspection. Synthetic fixtures may test choreography separately, never replace real operation evidence. At normal view the office remains visibly dominant; large opaque shell panels cannot conceal that it is not working.
