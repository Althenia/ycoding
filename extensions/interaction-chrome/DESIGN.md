---
version: alpha
name: YCoding Chrome interaction
description: Local approval, target marking, and Stop controls for Chrome interaction.
surface: native
extends: ../../DESIGN.md
colors:
  primary: "#28753E"
  canvas: "#F2F3F5"
  ink: "#24282F"
  field: "#FFFFFF"
  rule: "#626C75"
  on-action: "#FFFFFF"
  stop: "#A72835"
  mark: "#67D7A4"
typography:
  body:
    fontFamily: Geist, system-ui, sans-serif
    fontSize: 13px
    lineHeight: 1.45
spacing:
  body: 12px
  row: 8px
rounded:
  control: 6px
controls:
  target: 34px
layout:
  popup: 320px
themes:
  dark:
    colors:
      primary: "#67D7A4"
      canvas: "#24282F"
      ink: "#F2F3F5"
      field: "#1B1E23"
      rule: "#8E98A3"
      on-action: "#1B1E23"
      stop: "#F58E98"
---

# YCoding Chrome interaction

## Overview

Use the extension popup to connect, approve one target or action, and stop control without selecting another browser tab. Show the target and the pending action before the decision. Keep pairing separate from target approval. Show unavailable, pending, and active states as text.

## Principles

Keep control local to the exact approved target. Make the control state visible without taking focus or changing unrelated tabs or groups.

## Rules

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| I1 | approved | The adapter MUST confirm the favicon, per-tab badge, and any owned-group marker before admitting control. | `test/interaction-chrome-controller.test.js`; native Chrome acceptance |
| I2 | approved | Stop MUST revoke action admission before waiting for Chrome cleanup. | `test/interaction-chrome-controller.test.js` |
| I3 | approved | Each controlled tab MUST be in an expanded adapter-owned YCoding control group. The popup MUST name any move before approval; the adapter MUST NEVER move a tab out of a user-owned group. | `test/interaction-chrome-controller.test.js`; native Chrome acceptance |

## Colors

Use the canvas, ink, rule, and field tokens for the popup. Use primary for approval and focus, stop for revocation, and mark for the canonical YCoding control mark. The native group uses Chrome green and the label “YCoding control”; color is not the only signal.

## Typography

Use embedded Geist for interface text and its system fallback. Keep Chrome-owned group labels and toolbar badge text in native typography.

## Layout

Keep a compact column of status, pending controls, and Stop in the popup. Wrap target and destination text within the popup width. Keep all controls keyboard accessible, with an owned focus outline and native forced colors.

## Components

- Approval names the selected Chrome tab or new background tab and the proposed origin or destination. Use “Approve and group” to approve moving only the selected tab into a new YCoding control group. If the exact selected tab is in a verified adapter-owned group, state that it will stay there. Reject dismisses only that challenge.
- Stop revokes only the named target before waiting for cleanup. Keep it available in the popup for an owned tab in that window even when it is in the background.
- Chrome shows the marker as a target favicon and per-tab `ON` badge with the named expanded native group. Restore only an unchanged group created for that tab. Never draw an overlay in the page. Native debugger warnings, tab-strip visibility, and toolbar pinning remain Chrome-owned; confirmation of the marker state is not proof of native pixels.

## Verification

Check extension fixture cases for marker readback, ownership, and Stop. Verify actual tab-strip and toolbar rendering in an authorized native Chrome fixture before shipping.

## Maintenance

Keep the popup and Chrome-native indicator definitions in this file. Check changes against the inherited identity, color, and accessibility rules.

## Do's and Don'ts

- Keep popup scope, current status, and Stop visible without relying on color.
- Do not switch tabs, raise windows, or edit an unrelated tab or user-owned group to make a marker appear. Refuse when the required grouping cannot be confirmed.
