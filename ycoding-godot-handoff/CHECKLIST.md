# Implementation and release checklist

This checklist is acceptance guidance, not the authoritative task-status store. Update [tracking/tasks.json](tracking/tasks.json); evidence is mandatory before checking an item in an actual milestone review.

## Before editing

- [ ] Correct repository, root/scoped guides and local HEAD identified.
- [ ] Existing tracked/untracked work recorded and preserved; no reset/stash/commit/branch switch.
- [ ] Remote audit compared with local code; unverified API details clearly labeled.
- [ ] Godot/toolchain versions and target machine recorded; no accidental runtime upgrade.
- [ ] Godot supported-surface policy change explicit; legacy desktop stack not restored.

## Product behavior

- [ ] User types ordinary TUI-style prompts; settings/delivery/approval semantics preserved.
- [ ] A small task can remain single-agent; the office does not force managers/workers.
- [ ] Only YCoding executes coding work; no game action triggers delegation or approval.
- [ ] Status/attention updates immediately, independent of walking and bubble timing.
- [ ] DEMO/LIVE/RECONNECTING are unmistakable; demo cannot mutate backend state.
- [ ] Current assignment/source is clear when agent definitions are reused concurrently.

## Fidelity

- [ ] One coherent licensed art family with fixed grid, pivots and directional conventions.
- [ ] Walls/doors/desks/props are real scene assets, not final-quality claims about greybox primitives.
- [ ] Routes avoid obstacles; depth/occlusion, chair alignment and sprite facing are correct.
- [ ] Stand/approach/turn/talk/return/sit/type micro-sequence is visible in Godot footage.
- [ ] Reading/typing/waiting/blocked states are legible; idle life preempts cleanly.
- [ ] World is sharp during pan/zoom; normal-sized panel text stays crisp and readable.
- [ ] Bubble placement, viewport clipping and simultaneous interactions remain clear.
- [ ] M2 and M4 captures passed the hard criteria and have recorded user visual approval.

## Conversations and safety

- [ ] Every live speech/history entry is linked to a real source, or clearly an unattributed status.
- [ ] No invented acknowledgments, test successes, meetings or private reasoning.
- [ ] Full report available behind short bubble; negation/conditions retained.
- [ ] Canonical parent/child messages reload after restart; ephemeral bubbles do not become a second database.
- [ ] Approval choices exactly respect backend constraints; no CEO/hierarchy bypass.
- [ ] Untrusted transcript markup/links cannot execute code; no credentials in screenshots/logs/exports.

## Reliability

- [ ] SSE parser handles partial UTF-8, framing, comments, multiline data and incomplete EOF.
- [ ] Volatile stream reconnect uses canonical snapshots/current state, not assumed replay.
- [ ] Source-epoch change, async-generation races, pagination and workspace switch tested.
- [ ] Prompt retry reconciliation prevents unintended duplicate submission.
- [ ] Cosmetic queues are bounded; stale callback/anchor reservations cleaned on every cancellation path.
- [ ] Current-state panel remains useful during path failure, disconnect and minimized rendering.
- [ ] Long transcript/resource caps and soak measurements recorded honestly.

## Local delivery

- [ ] Native export starts without editor on the recorded target OS/architecture.
- [ ] Shared service stays running after client exit; startup/connect ownership documented.
- [ ] Unsupported capabilities/platforms and public-distribution limitations stated explicitly.
- [ ] Asset/license manifest complete, no unapproved paid sources or fonts redistributed.
- [ ] Actual Godot demo, screenshots, focused tests, backend regression results and known issues attached.
- [ ] Tracking/handoff/session log updated; generated TODO/status current; archive integrity recorded.
