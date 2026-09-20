# Conversation and session history contract

Keep canonical session/messages/orchestration in the existing YCoding runtime. The desktop renders views; it is not another source of durable conversation truth. Verify current public read/event contracts locally before mapping literal wire event names.

## User interaction

Click/focus an actor to show current work and a compact inspector. Open Conversation to see actual delegation, questions, follow-ups and reports associated with that execution. Open the full session to inspect complete user-facing text and supported tool/activity output. Preserve the office and composer context; Escape closes the most recent overlay and restores focus.

Use actual session/parent/child and message identifiers. An agent configuration reused across sessions must not merge unrelated histories. Actor name is not a durable key. A parent-child thread may span several messages; show sender/recipient using provenance, not guessed dialogue.

## Message projection

Retain source session ID, message/tool-call ID when available, kind, time/order, sender, recipient, excerpt and full-content navigation. Separate user text, agent text, tool output and synthetic/system observations. Do not render private reasoning as social messages. Do not add another LLM summary for every bubble.

A completion status without a report message supports “Completed; open session”, not an invented success statement. If an observation is a system-generated status, label it as such. An unavailable original message remains unavailable; do not reconstruct imaginary text.

## Recovery

Inspect current TUI canonical hydration and current source-epoch/watermark contracts. Reconcile snapshots and event races using the actual implementation's guarantees. Duplicate event IDs must not create duplicate history or replay bubbles. Do not sort concurrent source events solely by wall clock when the runtime supplies causal ordering. On reconnect/restart, rebuild the current read model and show missing/deleted/compacted details honestly.

Handle long transcripts without breaking the runtime's canonical snapshot/load semantics. Virtualize graphical rows if needed; do not invent partial-history authority. Persist only bounded presentation preferences/drafts in Godot. Never mark a background child complete because its UI row is evicted.

## Verification

Send → see response → close/open inspector → switch sessions → restart desktop → confirm same durable content. Include duplicate/reordered events, missing source, long text, Unicode, concurrent sessions and cancellation. Verify a bubble opens its exact source; shortened reports preserve qualifiers. Source transcript is runtime evidence; an animation replay fixture is not.
