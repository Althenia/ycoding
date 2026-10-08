---
version: alpha
name: YCoding TUI
description: Keyboard-first terminal UI for an AI coding agent. Everything is a monospace character grid rendered by OpenTUI.
surface: terminal
extends: ../../DESIGN.md
colors:
  primary: "#79B8FF"
  background: "#15181D"
  chrome: "#0F1115"
  surface-offset: "#1D2128"
  surface-overlay: "#252A33"
  text: "#F2F4F7"
  text-subdued: "#98A2B3"
  text-label: "#6F7885"
  text-hint: "#5D6673"
  separator: "#4B535F"
  border: "#3B424D"
  on-primary: "#0F1115"
  destructive: "#EF7D84"
  on-destructive: "#0A0A0A"
  success: "#67D7A4"
  warning: "#F0BE62"
  error: "#EF7D84"
  info: "#79B8FF"
  backdrop: "#00000096"
typography:
  body:
    fontFamily: Geist Mono
    fontSize: 14px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0px
  title:
    fontFamily: Geist Mono
    fontSize: 14px
    fontWeight: 700
    lineHeight: 18px
    letterSpacing: 0px
  hint:
    fontFamily: Geist Mono
    fontSize: 14px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0px
rounded:
  none: 0px
spacing:
  cell-x: 8.4px
  cell-y: 18px
  inset: 3
  gap: 1
components:
  dialog-panel:
    backgroundColor: "{colors.surface-offset}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    width: 98ch
  list-row:
    backgroundColor: "{colors.surface-offset}"
    textColor: "{colors.text}"
    height: 1 line
    padding: 0 3ch
  list-row-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  list-row-confirm-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.on-destructive}"
  category-header:
    textColor: "{colors.info}"
    typography: "{typography.title}"
  footer-hint:
    textColor: "{colors.text-subdued}"
    typography: "{typography.hint}"
---

# YCoding TUI design system

## Overview

YCoding is a terminal application. Every screen is a fixed-width monospace character grid (typically 80-200 columns by 24-60 rows) drawn with text, background colours, bold/dim attributes and Unicode glyphs. Designs must be directly implementable with a terminal renderer: one font, one size, whole-cell layout, no pixels in between.

The feel is calm, dense and keyboard-first: a dark neutral canvas, one blue interaction colour, semantic status colours used sparingly, and explicit keyboard hints on every screen. Mouse click and wheel work, but nothing may depend on hover.

Anti-references: web dashboards, cards with shadows, rounded pills, icon fonts, avatars, charts with smooth curves, modals with images.

## Principles

- Keep terminal composition in whole cells and adapt to available columns rather than borrowing pixel-oriented web layout (`docs/runtime.md`, `src/routes/session/`).
- Treat the canonical transcript as durable history and the resident transcript as a bounded rendering projection; an absent row must not reserve space (`AGENTS.md`, `test/cli/tui/transcript-history.test.tsx`, `test/session-transcript-boundary.test.tsx`).
- Preserve text and keyboard operation when color, width, or history residency limits presentation (`test/file-change-summary.test.tsx`, `test/session-transcript-boundary.test.tsx`).
- Show the context breakdown's Last Activity from terminal Session activity, or `—` before any terminal Step or run (`test/cli/tui/context-breakdown.test.tsx`).

## Rules

Each rule describes current TUI behavior and names its enforcing test or review boundary.

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| T1 | approved | The TUI MUST fetch a Session's complete projected transcript in one canonical ascending-order request and retain it while that Session is resident. | `test/cli/tui/transcript-history.test.tsx` |
| T2 | approved | Every message-backed transcript row MUST verify that its message or assistant part is resident before mounting; an unresolved row MUST consume zero terminal lines and MUST NOT initialize child components that require Session context. | `test/session-transcript-boundary.test.tsx` |
| T3 | approved | Expanded captured-change diffs MUST use split columns when `diffs.view` is `split` or `auto` and the diff area is at least 100 columns; narrower areas and `unified` MUST use one column. | `test/file-change-summary.test.tsx` |
| T4 | approved | The resident subagent summary MUST refresh after reconnect and reject a response started before disconnect. | `test/subagent-summary-reconnect.test.tsx` |
| T5 | approved | Transcript timeline selection MUST follow option identity rather than list index when new events reorder options. | review-only (`AGENTS.md`, `docs/runtime.md`) |
| T6 | approved | Documented `colors` MUST equal the resolved default `ycoding` theme for every mapped role, in both directions; a documented color without an honest theme counterpart MUST be a recorded exception. | `test/design-md.test.ts` |
| T7 | approved | Completed `edit` and `patch` tool parts MUST NOT render as per-tool blocks. Each prompt segment (the messages from one `user` message up to the next) MUST show one collapsed `Captured changes` summary after its last resident assistant row, whether or not that row is a terminal footer and whether or not the Session is still running, listing each path once with counts summed over the recorded patches; an earlier segment's summary MUST stay after its own last row and MUST NOT be repeated in a later segment, and a segment with no completed edit MUST show none. Running and failed edit tools MUST keep their own rows. | `test/file-change-summary.test.tsx`, `test/captured-file-changes-summary.test.tsx` |
| T8 | approved | The command palette MUST offer exactly one `Keep machine awake` command whose footer is `● Checking` until the initial backend read settles, then `● ` plus the backend state word (`off`, `on`, `unsupported`, or `error`); `on` MUST use the success color, `error` the error color, and Checking, `off`, and `unsupported` the subdued color, so color never carries the state alone. Choosing it MUST NOT write while the state is unknown or `unsupported`, and turning it on MUST show one toast line stating that only idle sleep is blocked and that manual sleep and the lid still apply. The Status dialog MUST list Checking before initial settlement, then the same backend state under Services with the backend message. | `test/keep-awake.test.tsx`, `test/screen/keep-awake-status.screen.test.tsx` |
| T9 | approved | A parent MUST show its resident waiting child's question with warning ink, an `awaiting input` label, and the configured Subagents shortcut; clicking the notice MUST open that child. The child answer textarea MUST submit literal text only to its owned question, retain rejected drafts, and NEVER admit a prompt or command. Guardrail, permission, and form review MUST precede question answering; the footer MUST NOT invite an answer while review owns input. | `test/screen/subagent-answer.screen.test.tsx`, `test/subagent-answer.test.tsx` |
| T10 | approved | A prompt segment with unread dispatched-child transcripts MUST label its file count `known` and `incomplete`, retain available root and child patches, and show a loading or warning-colored unavailable state even at zero known files. Failed reads MUST expose a primary-colored `Retry child changes` action and keyboard command. Recovery MUST retry only failed authorized reads, coalesce in-flight requests, and reject obsolete selections. Expanding a summary MUST NOT fetch; totals MUST remain isolated by prompt segment. | `test/screen/captured-child-recovery.screen.test.tsx`, `test/captured-file-changes-summary.test.tsx` |
| T11 | approved | Prompt and standalone skill dispatch MUST release the composer for editing and another draft without awaiting transport settlement. Submitted user text MUST contain no loading animation; a subdued static receipt MUST sit beneath the bubble. Failed or unresolved sends MUST retain their input and identities, show an error-colored outcome with a primary-colored `Retry send` action beneath the bubble, and offer the same retry in the command palette. Late outcomes MUST NOT clear a newer draft or affect another Session. Normal prompts MUST carry selected skill IDs in admission metadata without client preactivation; the runtime owns skill activation at the safe promotion boundary. Model selection MUST settle before prompt admission, and admission MUST settle before wake; an unresolved gate MUST hold later sends in that Session without blocking its editor or another Session. Tool and reasoning activity glyphs MUST remain available. | `test/screen/prompt-recovery.screen.test.ts`, `test/prompt/submission.test.ts`, `test/session-transcript-chat-shape.test.tsx`, `test/screen/landing-autonomy.screen.test.tsx` |
| T12 | approved | Configured slash commands MUST use the same nonblocking submission owner, admit with a stable input ID before waking with the canonical returned text and attachments, and NEVER re-evaluate an acknowledged command on wake retry. Pre-admission retries MUST compare the live Session model with the captured selection. Consumed-input proof MUST retire an unresolved admission without replay, finish attachment cleanup, and release later sends. Successful attachment receipts MUST reconcile the reserved history entry to managed URIs before temporary cleanup without reordering dispatched history. Failed recovery MUST offer `Discard previous submission recovery` in the command palette, preserve the current draft, and warn that dropping local recovery does not undo backend input. | `test/prompt/submission.test.ts`, `test/prompt/history-provider.test.tsx`, `test/screen/prompt-recovery.screen.test.ts` |
| T13 | approved | Main transcript selection MUST require explicit copy and NEVER write the clipboard on mouse release. `terminal.copy_on_select` MUST control dialog selection only, retain its default of enabled except on Windows, and appear as `Dialog copy on select` in Settings. Explicit selection copy MUST consume its shortcut without exiting the app. | `test/screen/clipboard-selection.screen.test.ts` |
| T14 | approved | File mention autocomplete MUST show the strongest fuzzy query matches first, remaining folders next, and remaining files last. Equal-best matches and each remaining group MUST preserve backend order; empty or unmatched queries MUST keep folders first. Ranking MUST retain the separate eight-folder and twenty-file search budgets, deduplicate normalized paths, and preserve keyboard file selection and single-separator folder completion. | `test/prompt/autocomplete.test.ts`, `test/screen/file-mention-ranking.screen.test.ts` |
| T15 | approved | Variant pickers MUST display only source-offered IDs, including a legitimate `none`, without synthetic Default/Base options or invented default descriptions. Cycling MUST wrap through offered IDs; clearing an optional selection MUST be a separate labelled action. An unavailable explicit Session or saved selection MUST remain visible with an unavailable label and block model prompts without losing their drafts or starting provider work; NEVER silently replace it with a saved value or omission. An omitted variant MUST remain absent and MUST NOT be labelled Default/Base. | `test/mini/variant.shared.test.ts`, `test/session-model-selection.test.tsx`, `test/mini/footer.view.test.tsx`, `test/mini/runtime.test.ts` |
| T16 | approved | Selected and destructive elements MUST pair their semantic action fill and ink; filled warning chips and paste markers MUST use the warning feedback hue as their fill with readable ink. For a known opaque fill below 4.5:1 against its preferred ink, use whichever black or white provides greater contrast; for a transparent fill, preserve the semantic ink without guessing the terminal background. The agent label MUST use categorical ink over its actual formfield surface without inventing a filled badge. | `test/theme-v1-parity.test.ts`, affected rendered selection, warning, destructive and skill-label tests |
| T17 | approved | Theme migration MUST preserve the 52 resolved legacy RGBA roles for each supported built-in mode except the T16 readability adjustment; the fixed thinking opacity is `0.6`, not a ThemeFile setting. Generate syntax styles from resolved theme tokens while retaining the existing scopes and text attributes. | `test/theme-v1-parity.test.ts`, `test/theme/syntax.test.ts`, `test/mini/theme.test.ts` |
| T18 | approved | An automatic OAuth dialog MUST show a keyboard-labelled manual-code action only when the attempt advertises that capability and no code has been submitted. Its code entry MUST retain the same attempt and continue status polling; leaving the dialog MUST cancel that attempt, while successful automatic or manual completion MUST not cancel it. | `test/screen/dialog-remaining-capture.test.tsx` |
| T19 | approved | The single Remote connection command MUST enable from `off` and disable from `connecting`, `on`, or `error`. A second toggle during a pending enable MUST request disable; obsolete reads and replies MUST NOT restore the superseded state. Render backend state with the existing status word and ink; keep recovery in the backend rather than creating a client-owned reconnect loop. | `test/remote-connector.test.tsx` |
| T20 | approved | Expanded generic tool details MUST retain the bounded Request and Response regions, include the tool's error on failure, and apply the existing sensitive-field and control-sequence sanitization. A failed decision MUST NOT display a fabricated answer; model-estimate TOON MUST remain readable through the same scrollable response region. | `test/btw-session-render.test.tsx`, `test/screen/session-transcript-chat.test.tsx` |
| T21 | approved | The built-in `high-contrast` theme MUST hold every text, syntax, markdown, feedback, diff, selected-row, and destructive ink pair to 7:1 on its page, offset, and overlay surfaces in both modes, and its border and scrollbar to 4.5:1. Built-in `one-dark` and `one-dark-pro` MUST use the official One Dark (Atom, base16) and One Dark Pro (binaryify) palettes. Every built-in theme MUST resolve with no missing-token sentinel; a standalone theme that omits `text.separator`, `text.hint`, or `text.label` MUST read them as its own `text.subdued`. | `test/theme-builtins.test.ts` |
| T22 | approved | The command palette MUST list user-invocable commands available in the current view, on the landing and in a Session, including configured commands under `Commands`; selecting an argument-taking command MUST preserve the draft and focus the prompt. Keep explicit palette exclusions for itself, positional quick-slot keys, scroll and message-cursor primitives, and diagnostics excluded by their owning specification; omit disabled commands. Slash names and aliases such as `/compact` MUST match their commands. Palette selection MUST execute interrupt, background, and steer actions without requiring prompt focus or their keybinding confirmation keystrokes. Rows MUST retain title, optional subdued description, shortcut footer, and category header roles. | `test/screen/command-palette-coverage.test.ts`, `test/command-palette-design.test.tsx` |
| T23 | approved | The model picker MUST offer eligible named profiles through the existing dialog/list treatment and a distinct Use provider default action. Show the selected or pending profile in the model identity and Session header; do not equate a provider's active default with an explicit Session selection. Profile-only changes MUST persist independently per Session without activating a global profile; transcript notices MUST identify the changed profile by name or `provider default`, and include a simultaneously changed variant. Missing saved profiles MUST remain visible as unavailable and block provider work while preserving the draft. Retain offered profiles across same-provider model/variant choices and never copy a name across providers. Daybreak controls and indicators MUST use the explicit profile's advertised programs; absent programs MUST NOT inherit the global default's access. Effort choices MUST use the explicit profile's variant IDs. Keep account-exclusive models selectable with an eligible profile and reject an ineligible provider-default choice without discarding the draft. | `test/session-model-selection.test.tsx`, `test/screen/model-profile-selection.test.ts`, `test/session-transcript-chat-shape.test.tsx` |

T1 and T2 separate complete durable projection from resident row rendering. T3 applies to the captured-change diff, not every inline tool diff; the tested `diffs.view` cases and threshold are specified in `docs/runtime.md`. T7 keeps the segment summary as the only completed-edit presentation; child edits join the segment whose `subagent` or `subagent_control` call dispatched them, and a child segment ends at the child's next `user` input or answer.

## Colors

The default "ycoding" dark theme (users can switch among ~30 built-in themes, including `one-dark`, `one-dark-pro`, and `high-contrast`, so designs must rely on roles, not exact hues):

- **background** `#15181D` main canvas; **chrome** `#0F1115` status/footer bars.
- **surface-offset** `#1D2128` dialog panels; **surface-overlay** `#252A33` secondary highlight (e.g. selected row while focus is on an action).
- **text** `#F2F4F7` primary text; **text-subdued** `#98A2B3` descriptions, metadata, hints; **text-label** `#6F7885`; **text-hint** `#5D6673`; **separator** `#4B535F`; **border** `#3B424D`.
- **primary / info** `#79B8FF`: the selected list row is a full-width band of this colour with `#0F1115` text; category headers use it as bold text.
- **success** `#67D7A4`, **warning** `#F0BE62`, **error** `#EF7D84` for status glyphs and short labels only.
- **destructive** `#EF7D84` band with near-black text marks a row that is armed for deletion ("Press ctrl+d again to confirm").
- Filled warning chips and paste markers use the warning feedback hue as their fill with readable ink; an armed destructive row uses the destructive action pair; selected rows use the focused primary action pair. Keep the preferred resolved foreground when an opaque pair is readable, otherwise select the higher-contrast black or white ink. The agent label is categorical foreground over the formfield surface, not a filled badge. Preserve semantic ink over a transparent terminal background without claiming a measured contrast ratio.
- Dialogs dim the screen behind them with a black ~60% backdrop.

## Typography

Use Geist Mono at 14px / 18px line height for terminal specimens. The running TUI uses the terminal application's user-selected monospace font and cell size; it does not install fonts or change host settings. The only typographic variations are **bold** (titles, category headers, the selected value), normal, and colour. No size changes, no italics for meaning, no headings larger than body text. Text that does not fit is truncated with `…`; file paths truncate from the left and abbreviate the home directory as `~`.

## Layout

Short approval details use their natural height; the review cap must not create empty space that displaces transcript rows.

- **Approval review**: bound permission and guardrail panels to the available terminal viewport and preserve transcript space at normal terminal sizes. Keep the title, allowed decisions, and footer visible outside one scrollable details region, including edit diffs. Omit the nonfunctional Search row and hide the scrollbar; show Page Up/Page Down paging hints and support mouse-wheel scrolling without selecting or submitting a decision. Preserve the full command for review and compact decorative spacing at short heights. Resize must retain a visible selected decision; a new review must reset its details offset and default choice, and hard reviews must never gain an Always option. Verify rendered geometry and decision effects in `test/cli/tui/guardrail.test.tsx` and `test/cli/tui/permission-interaction.test.tsx`.
- Units are character cells: horizontal spacing in columns (ch), vertical in lines. Standard left inset is 3 columns; gaps are 1 column or 1 blank line.
- **Dialog**: a 98-column panel (full width when the terminal is narrower than 100 columns), horizontally centred, starting one quarter down the screen, no border. Structure top to bottom: title row (bold title left, subdued `esc` right) → search row (`Search` placeholder) → blank line → scrollable list → footer row of action hints.
- **OAuth authorization**: center the panel vertically so short terminals do not lose the authorization URL, code instructions, waiting status, or copy hint below the viewport. Keep the title and escape action visible; wrap URL and instructions to the available panel width.
- **OAuth manual fallback**: show `e enter authorization code` beneath the waiting status only when the automatic attempt offers manual entry. Use the owned dialog prompt and action hint for code input; keep the waiting attempt alive while the prompt is visible.
- **Full-screen route**: occupies the whole terminal. Header line (bold title + subdued context), content, and a single footer hint line such as `↑↓ select · enter open · ctrl+r refresh · esc back`.
- A two-pane layout (list left, details right) is allowed only at ≥120 columns; below that, show details inline under the selected row or on a separate view.
- Lists are virtualised: only visible rows render; long lists load more when the selection nears the end, showing a subdued `Loading more…` row.

## Elevation

There is no shadow or depth. Layering is only: canvas → dimmed backdrop → dialog panel (`surface-offset`). Toasts appear as small panels in a corner using the same surface colour and a coloured title.

## Shapes

Everything is rectangular, aligned to character cells. No rounded corners. Borders, when used at all, are single box-drawing characters (`┃` split bars, `─` rules); most screens use none.

## Components

- **List row**: exactly one line. Layout: optional 2-column status glyph, title (bold if current), subdued description, right-aligned subdued footer (shortcut, count or time). Selected row = full-width primary band.
- **Category header**: bold info-blue text on its own line, 3-column inset, blank line before (except the first).
- **Current marker**: the current item shows a `●` or the word `current` in subdued text.
- **Status glyphs**: `✓` connected/ok (success), `○` disabled/missing (subdued), `⋯` pending (info), `✗` error (error), `!` failed (error), `?` awaiting input (warning), `..` in flight (subdued).
- **Action footer**: `title shortcut` pairs such as `new ctrl+n  delete ctrl+d  refresh ctrl+r`; disabled actions are dimmed; destructive actions need a second press to confirm.
- **Spinner**: a 1-cell animated braille/dot glyph next to a title while loading.
- **Inline empty/error state**: 2–3 lines of text inside the list area (bold coloured heading + subdued explanation + recovery hint). Never a separate illustration.
- **Command palette**: centred dialog listing commands grouped by category with shortcut footers; screens are opened from here. The search matches title, category, and slash names. Configured commands appear under `Commands`.
- **Usage model identity**: append ` · profile <name>` for recorded named selections in the existing model column and ink. Keep unnamed historical rows unchanged; never infer an account or change spend totals. Verify with `test/provider-usage-direct-views.test.tsx`.

## Verification

T1: `bun test test/cli/tui/transcript-history.test.tsx` from `packages/tui`. T2: `bun test test/session-transcript-boundary.test.tsx`. T3: `bun test test/file-change-summary.test.tsx`. T7: `bun test test/file-change-summary.test.tsx test/captured-file-changes-summary.test.tsx`. T4: `bun test test/subagent-summary-reconnect.test.tsx`. T6: `bun test test/design-md.test.ts`. T8: `bun test test/keep-awake.test.tsx test/screen/keep-awake-status.screen.test.tsx`. T5 remains review-only against the timeline selection contract in `AGENTS.md` and `docs/runtime.md`. Theme color drift and scratch-copy mutation probes run in `bun test test/design-md.test.ts`; T21 runs in `bun test test/theme-builtins.test.ts`; T22 runs in `bun test test/screen/command-palette-coverage.test.ts test/command-palette-design.test.tsx`; lint this file, `../../DESIGN.md`, and `../../apps/web/DESIGN.md` with `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint <file>`. `git diff --check` verifies whitespace only.

T13: run `bun test test/screen/clipboard-selection.screen.test.ts` for main explicit copy, dialog toggle/default behavior, and the scoped Settings label at narrow and full dialog widths.

T14: run `bun test ./test/prompt/autocomplete.test.ts` and `bun test ./test/screen/file-mention-ranking.screen.test.ts` for best-match ordering, tied relevance, preserved candidates, and real composer file selection and folder completion. The autocomplete retains the existing list-row and selected-row roles and geometry.

Permission review: run `bun test ./test/util/permission.test.ts` and `bun test ./test/cli/tui/permission-interaction.test.tsx` to verify the site-scoped incidental-download warning for profile and owned Chrome actions in the initial review and Always confirmation. Use the existing approval body ink and scroll region; cancellation must send no permission reply.
OAuth authorization layout: `bun test test/screen/dialog-remaining-capture.test.tsx --test-name-pattern 'OAuth authorization details'` verifies URL, code, status, and copy hint fit within short narrow and wide terminal viewports.

## Maintenance

Read `../../DESIGN.md` and this surface file before TUI presentation changes. Update binding rules and implementation checks in the same change when behavior changes; do not promote the typography specimen into renderer-owned font settings. Keep documented theme colors aligned with the resolved default `ycoding` dark theme through `test/design-md.test.ts`. Record any documented value with no honest theme counterpart as a scoped pending exception; never map it to a merely similar color.

## Do's and Don'ts

- Do design on an explicit grid (e.g. 120×36 and 80×24) and make every element a whole number of cells.
- Do show the keyboard shortcut for every action on screen.
- Do keep one line per list item and put extra detail in a details pane or a subdued second line only when essential.
- Do state loading, empty, error, confirm-delete and partial-page states explicitly.
- Don't use images, icons other than Unicode glyphs, avatars, gradients, shadows, rounded corners, or multiple font sizes.
- Don't rely on hover, tooltips, drag-and-drop, or right-click menus.
- Don't use colour as the only signal; pair it with a glyph or word.
- Don't add buttons as boxes; actions are keyboard hints in the footer.

## Exceptions

| Rule | Scope | Reason | Approval | Review date |
| --- | --- | --- | --- | --- |
| T6 | `colors.backdrop` | The documented translucent black backdrop has no corresponding token in the resolved `ycoding` theme; the opaque `background.surface.overlay` is not an honest substitute. | pending | 2026-10-29 |
| T16 | Built-in theme/mode pairs with opaque focused-primary, warning or destructive fills below 4.5:1 | The legacy foreground is replaced only where an opaque filled state would otherwise be unreadable; parity fixtures retain the original RGBA channels and tests assert adjusted rendered pairs. Unknown terminal backgrounds cannot be evaluated and retain semantic ink. | D10 theme migration | 2026-10-04 |
| T17 | `one-dark` dark and light `info` and `text.subdued` roles | The frozen migration fixture carried the legacy orange (dark) and brown (light) info and the Atom comment grey as subdued ink; they are corrected to the official blue info and mono-2 secondary ink, and `test/fixture/theme-v1-parity.json` is updated for those four values. | pending | 2026-10-29 |
