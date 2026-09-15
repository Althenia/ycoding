# Visual and behavioral fidelity specification

**Purpose:** replace “make it more like Gather” with testable art, motion, information and interaction criteria. This is an original office aesthetic inspired by the spatial clarity of pixel workplaces, not permission to copy Gather's proprietary art, branding or floor plan.

## Art direction

A warm, readable top-down workplace: cohesive flooring, cutaway walls, believable desks/chairs, windows, greenery, rugs, meeting furniture, QA equipment and a coffee corner. Four recognizable role silhouettes; restrained accent colors; subtle contact shadows. The world should feel inhabited without becoming visual noise. The app UI is a professional coding interface around that world, not tiny pixel text everywhere.

Start with one **32-pixel tile grid** and an asset family designed for it. Character frames may be 32×48 if the selected family supports that proportion. Pin the actual dimensions/pivots after the art audit; do not mix incompatible 16-, 32- and 48-pixel styles by arbitrary scaling. Source sprites, walk frames, seated poses and props must share viewpoint, outline weight, palette and lighting direction. No paid asset purchase or redistribution without authorization and license verification.

## Hard fidelity gates

| ID | Criterion | Evidence/pass condition |
|---|---|---|
| F-01 | Cohesive art | One accepted style sheet and asset family; no primitive rectangle people in accepted footage |
| F-02 | Readable spatial design | Distinct functional zones; desks, doors and walkable passages visible at default zoom |
| F-03 | Clean pixel rendering | Nearest-filtered world assets; stable grid; no shimmer or blurred world edges in pan/zoom capture |
| F-04 | Correct layering | Employee passes both behind and in front of a desk/plant/door frame without impossible overlap; foot-origin depth demonstrated |
| F-05 | Real routes | Routes pass through actual doors and around furniture; no interpolation through walls |
| F-06 | Character motion | Four-direction idle/walk; clear turns; consistent foot speed; no idle jogging or foot sliding |
| F-07 | Interaction detail | Stand/approach/face/talk/leave/sit/type transitions; visitor and worker are placed at distinct valid anchors |
| F-08 | Work legibility | Reading, typing, waiting and blocked/attention states are visibly distinct without relying on color alone; each state carries a distinct text label (TEST-037) |
| F-09 | Bubbles | Attached to speaker, readable, clamped to viewport, limited overlap, source opens on click; no fabricated dialogue |
| F-10 | Professional UI | Text readable at 1280×720 and 1920×1080, keyboard focus visible, no clipping with a long title or open history drawer |
| F-11 | Simultaneous life | Several employees may act concurrently; selected activity remains understandable; idle life preempts cleanly |
| F-12 | Truthfulness | LIVE/DEMO/stale states explicit; exact runtime status not delayed behind animation; history survives a reconnect from canonical sources |

M2 requires **F-01 through F-12** on two actors. F-11 is satisfied at M2 by one real-scene interaction plus demonstrated ambient preemption, not by a four-actor scene; concurrent multi-actor breadth is fully required at M4. M4 requires all criteria on four concurrent actors with the history drawer open.

This wording is authoritative for the M2 gate. `MILESTONES.md` G2 ("All hard fidelity criteria pass") and `tracking/tasks.json` TASK-024 ("applicable F-01 through F-12") both mean exactly this set: F-01–F-12, with F-11 evidenced at two-actor breadth. Functional correctness alone never passes the visual gate.

## Animation inventory

| Activity | Required by | Minimum visual treatment |
|---|---|---|
| Idle / walk north, south, east, west | M2 | Four directions, coherent gait; 4–8 useful walking frames if supplied by the asset family |
| Sit / stand | M2 | Readable transition and aligned chair/desk anchors; do not merely switch pose mid-corridor |
| Type / read | M2 | Distinct hands/posture or monitor activity; not exaggerated full-body shaking |
| Turn / face / talk | M2 | Facing chosen from relative actor positions; subtle talk gesture and calm hold |
| Processing / waiting / blocked | M2 | Subtle indicator with a matching text state; no claim to expose private model reasoning |
| Coffee / stretch / return | M2 | One polished ambient cycle; no LLM calls; real work interrupts it |
| Whiteboard / review | M4 | Explicit interaction anchor and a meaningful verified work category |
| Test / terminal activity | M4 | Desk/monitor variant first; avoid walking across the building for each shell call |
| Report / acknowledgment motion | M4 | Source-backed report bubble plus optional nonverbal nod; no invented verbal acknowledgment |

Numbers are starting animation-design targets, not arbitrary requirements to generate duplicate frames. Mirroring is allowed only when asymmetry of clothing/props remains correct.

## Rendering and camera

Keep world rendering and panel text separate. Begin with a low-resolution world SubViewport and crisp screen-space controls. Offer a small number of stable pixel zoom stops. Snap the rendered camera/visual positions consistently without destroying smooth simulation coordinates. Audit Godot's version-specific stretch and filtering settings instead of blindly applying both pixel-snap options. Test odd window sizes and high-DPI scaling as well as the two reference sizes [G5 in SOURCES].

Contact shadows, monitor accents and a few animated props are enough. Do not add a dynamic day/night system, expensive lights, screen shake or a complex shader stack before the core scene is accepted. Reduced-motion mode suppresses travel flourishes and ambient wandering while retaining exact statuses and inspectable messages.

## Micro-interaction contract

A delegation may visually perform: stand → orient → route to visitor anchor → worker turns → face/hold → bubble → leave → worker sits/types. Real execution may already be running. A new critical state can interrupt the sequence, and the inspector never waits for it. Show a brief “recent interaction” affordance when a reenactment is behind live state rather than pretending the conversation is happening synchronously.

Proposed timing ranges: facing/settle 100–250 ms; panel open 120–220 ms; bubble 3–7 seconds depending on length; travel bounded by the queue policy. Never slow runtime work or require a “talk finished” callback to admit a prompt.

## Review rubric

Score 0–3 per category: 0 missing; 1 prototype; 2 cohesive and usable; 3 polished. Categories: environment composition, character animation, navigation/depth, interaction/bubbles, text/UI readability, concurrency/truthfulness. Target **at least 15/18 with no category below 2**, plus every applicable hard criterion. This score is a review aid, not an automated claim of quality. User acceptance is still required.

A review record contains build SHA, engine version, OS/display scale, asset revision, scene/scenario, screenshots, normal-speed video, score rationale, known defects, and the user's acceptance/rejection. Use [visual review template](../templates/VISUAL_REVIEW.md). No percentage comparison such as “20% of final fidelity” is meaningful without a defined metric.

## Performance test targets

On the recorded reference machine: normal four-actor interaction aims at a 60 Hz presentation with p95 frame time ≤16.7 ms; 12-actor stress targets p95 ≤33.3 ms; selected-state UI should update within 250 ms of the client accepting a fact. These are proposed goals, not benchmark results. Profile the native app separately from provider latency. Record CPU/RAM rather than inventing an idle resource claim. Bound memory and verify no monotonic growth during a 30-minute mixed-activity soak.
