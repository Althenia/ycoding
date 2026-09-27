---
version: alpha
name: YCoding TUI
description: Keyboard-first terminal UI for an AI coding agent. Everything is a monospace character grid rendered by OpenTUI.
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
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0px
  title:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: 700
    lineHeight: 18px
    letterSpacing: 0px
  hint:
    fontFamily: JetBrains Mono
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

## Colors

The default "ycoding" dark theme (users can switch among ~30 themes, so designs must rely on roles, not exact hues):

- **background** `#15181D` main canvas; **chrome** `#0F1115` status/footer bars.
- **surface-offset** `#1D2128` dialog panels; **surface-overlay** `#252A33` secondary highlight (e.g. selected row while focus is on an action).
- **text** `#F2F4F7` primary text; **text-subdued** `#98A2B3` descriptions, metadata, hints; **text-label** `#6F7885`; **text-hint** `#5D6673`; **separator** `#4B535F`; **border** `#3B424D`.
- **primary / info** `#79B8FF`: the selected list row is a full-width band of this colour with `#0F1115` text; category headers use it as bold text.
- **success** `#67D7A4`, **warning** `#F0BE62`, **error** `#EF7D84` for status glyphs and short labels only.
- **destructive** `#EF7D84` band with near-black text marks a row that is armed for deletion ("Press ctrl+d again to confirm").
- Dialogs dim the screen behind them with a black ~60% backdrop.

## Typography

One monospace font (render as JetBrains Mono 14px / 18px line). The only typographic variations are **bold** (titles, category headers, the selected value), normal, and colour. No size changes, no italics for meaning, no headings larger than body text. Text that does not fit is truncated with `…`; file paths truncate from the left and abbreviate the home directory as `~`.

## Layout

- Units are character cells: horizontal spacing in columns (ch), vertical in lines. Standard left inset is 3 columns; gaps are 1 column or 1 blank line.
- **Dialog**: a 98-column panel (full width when the terminal is narrower than 100 columns), horizontally centred, starting one quarter down the screen, no border. Structure top to bottom: title row (bold title left, subdued `esc` right) → search row (`Search` placeholder) → blank line → scrollable list → footer row of action hints.
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
- **Command palette**: centred dialog listing commands grouped by category with shortcut footers; screens are opened from here.

## Do's and Don'ts

- Do design on an explicit grid (e.g. 120×36 and 80×24) and make every element a whole number of cells.
- Do show the keyboard shortcut for every action on screen.
- Do keep one line per list item and put extra detail in a details pane or a subdued second line only when essential.
- Do state loading, empty, error, confirm-delete and partial-page states explicitly.
- Don't use images, icons other than Unicode glyphs, avatars, gradients, shadows, rounded corners, or multiple font sizes.
- Don't rely on hover, tooltips, drag-and-drop, or right-click menus.
- Don't use colour as the only signal; pair it with a glyph or word.
- Don't add buttons as boxes; actions are keyboard hints in the footer.
