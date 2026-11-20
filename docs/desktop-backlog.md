# Desktop Intelligent UI backlog

Status: **Deferred — proposed for YCoding Desktop**

This document records deferred work for YCoding Desktop. It is not implemented behavior or current product scope. Current source, tests, Schema, and Protocol remain authoritative.

## Why Desktop

Intelligent UI renders structured answers as interactive cards. It targets the Desktop surface (Tauri 2 shell, Bun worker, Solid/Vite UI) because that surface provides:

- Graphical layout with proportional columns and resizable cards.
- Vector charts (SVG) rather than character-cell approximations.
- Proportional comparison tables with scrolling and sorting.
- Multi-state cards with direct pointer and keyboard controls.

The character-cell TUI keeps plain-text transcripts; every card carries a text fallback for it.

## Capability architecture

### Component surfaces

A `ui` tool returns a typed, declarative spec. Desktop renders it with owned components:

- KPI/metric strips with tone (`default`, `positive`, `warning`, `danger`).
- Multi-series bar, line, area, pie, and sparkline charts with bounded points.
- Sortable, scrollable comparison tables.
- Callouts, tabs, and variant views.
- Per-card view state persisted across reloads and reconnects.
- Deterministic height reservation so streaming does not shift the transcript.
- Streaming, loading, and failure states; an invalid or partial spec shows the fallback.

### Interactive controls

- Control kinds: `toggle`, `select`, `range`.
- A variant selector, an optional user note, Reset defaults, and Apply/Send changes.
- Apply formats a deterministic plain-text prompt from changed controls, the selected variant, and the note.

### Composition guidance

A built-in instruction tells the model to call `tools.ui` through CodeMode `execute` only when interactive or visual structure clarifies an answer better than static Markdown. Every call supplies a complete plain-text `fallback`. Ordinary prose and Markdown tables remain the default. The instruction is available only while the `ui` tool is visible to the agent.

## Invariants

### Rendering and security

- Render only Schema-validated data into owned Solid/SVG/DOM components styled with YCoding design tokens.
- Execute no model-authored JavaScript or HTML, embed no iframes, and load no external CDN assets in phase 1.
- Escape control and bidirectional characters in every displayed string.
- Open external links only after explicit user confirmation.
- An isolated HTML sandbox requires a separate decision record covering an opaque-origin frame, a `default-src 'none'` CSP, a capability-fenced `MessageChannel`, and user confirmation for external links.

### Size bounds

- Respect the Desktop worker's 1 MiB event resync ceiling.
- Bound a spec to at most 16 KiB, 8 blocks, 24 chart points, 32 table rows, 12 controls, and 6 variants.
- Reject duplicate block, control, and variant identifiers.

### Variant composition

A variant either overrides named block slots or supplies a complete block list. A variant summary or metric override never hides the primary chart or table blocks.

### Human authority

- Control adjustments and Apply only populate the composer draft.
- Populate the draft only when it is empty, fenced by the current connection revision.
- Never submit a turn, settle a permission, guardrail, or form, or change autonomy from a card.

## Implementation slices

1. Spec Schema and pure helpers: bounds, cross-field validation, fallback extraction, draft formatting, height reservation.
2. Core `ui` tool registered for CodeMode, with the model-visible fallback output and the `ui-use` instruction gated on the tool.
3. Desktop transcript renderer for metrics, callouts, and tables, with streaming and failure states.
4. SVG charts: bar, line, area, pie, sparkline, with tokens, legends, and keyboard-accessible data.
5. Controls, variants, Reset, note, and Apply into a connection-fenced composer draft; persisted per-card view state.
6. Documentation and contract updates for the tool, the instruction, and the configuration surface.

## Acceptance cases

- A valid spec renders its blocks; the same spec with an invalid field renders the fallback and no partial card.
- A spec missing `fallback`, with duplicate block identifiers, with a negative pie value, or over 16 KiB fails validation with a visible tool error.
- A variant that defines only a summary keeps the primary blocks visible.
- Changing a control, variant, or note and pressing Apply fills an empty composer with the formatted text and submits nothing.
- Apply while the composer holds text, or after the connection revision changed, leaves the composer unchanged.
- Adjusting a card never changes a pending permission, guardrail, or form, or the autonomy mode.
- Reload restores each card's selected variant and control values.
- A string containing control or bidirectional characters displays escaped.
- A streaming card reserves its final height and does not shift later transcript rows.
- With the `ui` tool hidden or denied, the `ui-use` instruction is absent.
