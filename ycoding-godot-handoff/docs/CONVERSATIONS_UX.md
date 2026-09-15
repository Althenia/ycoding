# Conversation history and desktop UX

## Main layout

Office-first, not office-only. A compact workspace/session rail; a large pixel office; a persistent prompt composer and current root response; an optional inspector/history drawer; a visible connection/mode indicator. Collapsing a panel increases office space without losing text drafts or selection. Keep a non-spatial session list for keyboard navigation and reduced motion.

Click employee: select its scoped assignment, highlight the sprite and open a small current-state card. Open details: activity, parent/root, task description, conversation and technical tabs. Open source: jump to the original canonical session/message. A selection of an ambient decorative employee shows “unassigned / ambient,” never fictional work history.

## Conversation model

The social view is a projection of verified delegation instructions, delivered messages/questions/answers, reports and review interactions. Full session view remains distinct and may contain user/assistant/tool/system content. Do not present tool logs or synthetic runtime bookkeeping as employee dialogue. Do not imply access to unexposed private model reasoning.

Every row includes speaker/recipient when known, relationship/thread, kind, timestamp/order metadata, body/excerpt, mode and source references. Group by assignment, not only by agent display name. For different session histories without a total causal order, group threads or label approximate ordering instead of inventing an authoritative interleaving.

## Bubbles versus history

A bubble is ephemeral and may be suppressed for clutter; its history item remains available. History is loaded from server-owned durable data, not from the bubble queue. Reopen/reconnect rehydrates the drawer but does not replay old speech. A task returning the same text twice in distinct messages remains two source items; one message encountered twice during refetch remains one item.

Use delegation's short description when supported, with full instruction in details. For final reports, prefer a faithful short excerpt. Never turn “tests not run” or “passes locally but fails in CI” into “tests pass.” A neutral “Report ready” is safer than an unfaithful summary.

## Screens and empty/error states

| Screen | Required behavior |
|---|---|
| First launch / DEMO | Obvious synthetic mode; no credentials needed; choosing replay does not run coding work |
| Connect | Existing local service configuration; actionable missing-service/auth/version errors; no secret echo |
| Active root | User prompt, pending/running distinction, response and current family visible |
| Agent inspector | Accurate status immediately, even during delayed social animation; parent/source navigation |
| Team history | Per-assignment thread, search/filter, canonical source opening, long text wrapping |
| Attention | Same supported question/permission/guardrail choices as backend; never fictional CEO approval |
| Offline / reconnecting | Draft retained; stale badge; mutations disabled or safely reconciled; cancel reconnect available |
| Unsupported details | Explicit unavailable capability; no pretend terminal/diff/test widget |
| No workers | Lead works alone; office may contain visibly ambient/unassigned characters |
| Deleted/evicted session | Explain missing source or reload canonical data; no stale actor controlling another session |

## Technical inspection MVP

Show source-backed transcript and tool output, basic file/diff text when a verified endpoint is available, error/approval details and source-reported usage values. Unknown cost/token values are “unavailable,” not zero or invented model names. A real PTY, code editor, merge conflict solver and rich debugger are deferred.

## Accessibility and themes

Support a keyboard path for submit, session switch, actor selection, conversation open/close and approval choices. Use visible focus and text labels in addition to color. Support UI text scaling, light/dark panel themes and reduced motion. Pause or simplify ambient activity when minimized; never stop runtime operations by minimizing the app. Keep world palette coherent across themes rather than arbitrarily inverting art.

Explicitly test long paths, multi-paragraph reports, Unicode, empty responses, 200% UI scale and narrow windows. Source content is untrusted display data: escape rich-text markup unless sanitized, make links non-executable by default and never automatically run a path/command appearing in a transcript.
