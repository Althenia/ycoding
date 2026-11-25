---
version: alpha
name: YCoding Chrome interaction
description: Local approval, match-code pairing, target marking, mini panel, and Stop/Resume controls for Chrome interaction.
surface: native
extends: ../../DESIGN.md
colors:
  primary: "#28753E"
  primary-hover: "#1E5E30"
  chrome: "#E5EAF0"
  canvas: "#F2F3F5"
  ink: "#24282F"
  muted: "#525862"
  field: "#FFFFFF"
  rule: "#626C75"
  on-action: "#FFFFFF"
  stop: "#A72835"
  stop-bg: "#FCECEE"
  warning: "#744C00"
  warning-bg: "#FFE9CE"
  active-bg: "#E1F3E7"
  mark: "#67D7A4"
typography:
  body:
    fontFamily: Geist, system-ui, sans-serif
    fontSize: 13px
    lineHeight: 1.45
  mono:
    fontFamily: Geist Mono, ui-monospace, monospace
    fontSize: 12px
    lineHeight: 1.4
spacing:
  body: 12px
  row: 8px
rounded:
  control: 6px
  card: 8px
  pill: 999px
controls:
  target: 34px
layout:
  popup: 320px
  panel: 340px
motion:
  duration:
    instant: 80ms
    quick: 140ms
  easing:
    standard: "cubic-bezier(0.2, 0, 0, 1)"
themes:
  dark:
    colors:
      primary: "#67D7A4"
      primary-hover: "#4EC48E"
      chrome: "#15181D"
      canvas: "#1B1E23"
      ink: "#F2F3F5"
      muted: "#A1A8B2"
      field: "#24282F"
      rule: "#4A525E"
      on-action: "#1B1E23"
      stop: "#F58E98"
      stop-bg: "#3B1B1F"
      warning: "#F0BE62"
      warning-bg: "#3C2603"
      active-bg: "#143021"
---

# YCoding Chrome interaction

## Overview

Use the extension popup to connect to the local YCoding service, verify first-time pairing with a match code, approve or reject tab control, pause/resume or stop active control, and open the compact mini panel. Keep pairing separate from target approval. Show every state (not connected, waiting for approval, connected idle, pending approval, active, paused with reason, and error) as explicit text.

## Principles

Keep control local to the exact approved target. Make the control state visible without taking focus, relying on color alone, or changing unrelated tabs or groups.

## Rules

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| I1 | approved | The adapter MUST confirm the favicon, per-tab badge, and any owned-group marker before admitting control. | `test/interaction-chrome-controller.test.js`; native Chrome acceptance |
| I2 | approved | Stop MUST revoke action admission before waiting for Chrome cleanup. | `test/interaction-chrome-controller.test.js` |
| I3 | approved | Each controlled tab MUST be in an expanded adapter-owned YCoding control group. The popup MUST name any move before approval; the adapter MUST NEVER move a tab out of a user-owned group. | `test/interaction-chrome-controller.test.js`; native Chrome acceptance |
| I4 | approved | Extension toolbar and page icons MUST derive from `assets/brand/ycoding-icon.svg`. Idle icons (`icons/idle-16.png`, `32`, `48`, `128`) show the canonical rounded tile; active icons (`icons/active-16.png`, `32`) MUST add a geometric border and corner bullseye badge so active control is legible at 16px without relying on color alone. | review-only (Chrome for Testing render inspection) |
| I5 | approved | First-time pairing MUST show `#match-code` in Geist Mono alongside `button#connect`, keeping `input[name=address]` (default `http://127.0.0.1:42188`) and `button#forget` inside collapsed `details#advanced`. | `test/popup.test.js`; Chrome for Testing render inspection |
| I6 | approved | Paused control rows and the mini panel MUST state the pause reason in plain words and place `Resume` (`data-kind="resume"` / `#resume`) beside `Stop` (`data-kind="stop"` / `#stop`). | `test/popup.test.js`; Chrome for Testing render inspection |
| I7 | approved | The popup MUST present full unwrapped connection status and the next available action in the primary body plane, MUST remove the body strip and its enclosing dividers whenever no status or action content exists (with no filler or reserved height), and MUST match documented tokens in `popup.css`. | `test/popup.test.js`, `test/design-md.test.js`; Chrome for Testing render inspection |

## Colors

Use `chrome` for the header and footer deck bands, `canvas` for the main body, `field` for interactive cards and inputs, and `rule` for 1px boundaries. Use `primary` for Connect, Approve, Capture, Resume, and focus outlines; `active-bg` for connected and active status surfaces; `warning` and `warning-bg` for waiting-for-approval, loading, and paused status; `stop` and `stop-bg` for Stop revocation and error alerts; and `mark` for the canonical YCoding control mark. The native group uses Chrome green and the label “YCoding control”; color is never the only signal.

## Typography

Use embedded Geist for interface text and embedded Geist Mono for the match code, local service address, and status badges. Keep Chrome-owned group labels and toolbar badge text in native typography.

## Layout

- **Signal Deck popup (`320px`)**: A `chrome` header band carries the 20px canonical YCoding icon and full title. The `canvas` primary body (`#deck-body`) stacks the `#connection` status surface (`#status` with `role="status"`, geometric non-color state indicator, full unwrapped copy, `#match-code`, and `button#connect`), conditional `#requests` and `#active` lists, and `#feedback` (`role="alert"`). Empty sections stay `hidden`; when no status or action content exists, `#deck-body` is hidden and the enclosing header/footer dividers collapse with zero reserved height. A `chrome` footer band houses collapsed `details#advanced` and `button#open-panel` in DOM order.
- **Mini panel (`340px`)**: A `chrome` header band carries `#session` and `#status`. The `canvas` body frames `img#frame` in a `field` viewport above an action row of `button#capture`, `button#resume` (hidden unless paused), and `button#stop`, followed by `#feedback`.
- Wrap all status, target, reason, and error text within the container width. Keep all controls keyboard accessible with a 2px `primary` `:focus-visible` outline (`2px` offset), `44px` coarse-pointer targets, and `@media (forced-colors: active)` system colors.

## Motion

Use `80ms` (`instant`) for button press feedback and `140ms` (`quick`) with `cubic-bezier(0.2, 0, 0, 1)` for state and border transitions, with a calm pulse on the `waiting` status indicator. Under `prefers-reduced-motion: reduce`, transitions and animations are disabled (`0s`).

## Components

- **Icons (`icons/`)**: `idle-16/32/48/128.png` and `active-16/32.png` derived from `assets/brand/ycoding-icon.svg`; both `popup.html` and `panel.html` link `icons/idle-32.png` as favicon.
- **Primary status & connect (`#connection`)**: Full-width `#status` (`data-state="disconnected|waiting|connected|active|paused|error"`) pairs a distinct geometric indicator (hollow ring, dashed pulse ring, solid dot, pause bars, or rotated error diamond) with unwrapped text. `button#connect` initiates pairing or reconnect. While waiting for Mac approval, `#match-code` displays the verification code in tracked Geist Mono inside a `field` card. `details#advanced` stays collapsed by default and reveals `input[name=address]` and `button#forget`.
- **Pending approval rows (`#requests`)**: Each row names the target and proposed grouping (`Approve and group` / `Approve` with `data-kind="approve"`, and `Reject` with `data-kind="reject"`).
- **Active & paused rows (`#active`)**: Active rows show the target label and `Stop control` (`data-kind="stop"`) beside `Take over`. Paused rows show the plain-word pause reason and `Resume` (`data-kind="resume"`) beside `Stop control`.
- **Mini panel (`panel.html`)**: Shows `#session`, `#status`, live `img#frame`, `button#capture`, `button#resume` (when paused), `button#stop`, and `#feedback`.
- **Chrome tab marker**: Target favicon and per-tab `ON` badge with the named expanded native group. Restore only an unchanged group created for that tab. Never draw an overlay in the page.

## Verification

Check extension fixture cases (`test/interaction-chrome-controller.test.js`), popup contract tests (`test/popup.test.js`), and token drift tests (`test/design-md.test.js`). Verify popup states (connected, pairing/loading, disconnected/error, no-status, and keyboard focus) in light and dark themes with Chrome for Testing, and lint this file with `design_md.py lint --strict`.

## Maintenance

Keep the popup, mini panel, icon, and Chrome-native indicator definitions in this file. Check changes against the inherited identity, color, and accessibility rules.

## Do's and Don'ts

- Keep popup scope, current status, pause reason, Resume, and Stop visible without relying on color.
- Do not switch tabs, raise windows, or edit an unrelated tab or user-owned group to make a marker appear. Refuse when the required grouping cannot be confirmed.
