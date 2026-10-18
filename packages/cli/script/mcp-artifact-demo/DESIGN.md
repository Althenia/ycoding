---
version: alpha
name: YCoding MCP artifact feasibility fixture
description: Offline single-document fixture that probes what an MCP Apps host allows; it is not a production preview.
surface: web
extends: ../../../../DESIGN.md
colors:
  bg: "#ffffff"
  surface: "#f7f9f8"
  surface-sunken: "#eff3f1"
  surface-raised: "#ffffff"
  text: "#0b0f14"
  text-muted: "#5c6672"
  text-subtle: "#646d78"
  border: "#e4e8e6"
  border-strong: "#78847e"
  primary-bg: "#0b8550"
  primary-fg: "#ffffff"
  green-strong: "#0a7b47"
  danger: "#c53a3a"
  focus: "#0b8b50"
themes:
  dark:
    colors:
      bg: "#0b1115"
      surface: "#11181d"
      surface-sunken: "#0e151a"
      surface-raised: "#151e24"
      text: "#f4f7f6"
      text-muted: "#99a2ad"
      text-subtle: "#7d8792"
      border: "#263039"
      border-strong: "#718278"
      primary-bg: "#4ee29b"
      primary-fg: "#04150c"
      green-strong: "#4ee29b"
      danger: "#ef6f6f"
      focus: "#4ee29b"
typography:
  font-sans: '"Geist", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
  font-mono: '"Geist Mono", ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, monospace'
  size-xs: 13px
  leading-xs: 20px
  size-sm: 14px
  leading-sm: 22px
  size-md: 16px
  leading-md: 26px
  size-lg: 18px
  leading-lg: 28px
  size-2xl: 24px
  leading-2xl: 32px
  weight-regular: 400
  weight-medium: 500
  weight-semibold: 600
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "6": 24px
rounded:
  sm: 6px
  md: 10px
  lg: 14px
elevation:
  focus-ring: "0 0 0 2px var(--yc-bg), 0 0 0 4px var(--yc-focus)"
controls:
  control-h: 44px
  control-pad-x: 16px
  border-width: 1px
layout:
  measure: 68ch
  gutter: 16px
breakpoints:
  small: 640
---

# MCP artifact feasibility fixture design rules

## Overview

`index.html` is a single offline document that probes one host: whether an MCP Apps view completes the `ui/initialize` handshake, switches between two structurally different variants, and runs a nested sandboxed frame. It is a feasibility fixture, not the production artifact preview or proposal output. Inherit the root brand and the web surface tokens; this file adds no brand, color, type, or token decision. Sources: `apps/web/src/styles/tokens.css`, `apps/web/DESIGN.md`.

## Principles

- Report only what the host demonstrably did; an unanswered request is a failure or Not confirmed, never success.
- Keep the document self-contained and reuse web tokens unchanged.

## Rules

| ID  | Status   | Binding statement                                                                                                                                                                                                                                                                                                                                                               | Enforcing check |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| F1  | approved | The fixture MUST declare only the tokens above, copied unchanged from `apps/web/src/styles/tokens.css`, and MUST NOT load fonts, scripts, images, or any other resource from outside the document; it falls back through the documented font stacks.                                                                                                                            | review-only     |
| F2  | approved | Variants MUST differ in structure: List is one bordered ordered list of divided rows, Cards is a grid of bordered article cards with a heading each. Both render from the same data with `textContent` only; NEVER insert untrusted input as HTML.                                                                                                                              | review-only     |
| F3  | approved | Variant controls MUST be native buttons in a labelled group with `aria-pressed`; the pressed state MUST carry a check mark and weight as well as color. Selection MUST update `#variant=list` or `#variant=cards` so history and Back work, and the hash MUST drive the initial variant.                                                                                        | review-only     |
| F4  | approved | Host initialization MUST show Pending, Initialized, or Failed in words. It MUST send only `ui/initialize` and the `ui/notifications/initialized` acknowledgement to the immediate parent, accept replies only when `event.source` is that parent, and NEVER send `tools/call` or `ui/message` or call `fetch`. Initialized requires the answer to select protocol `2026-01-26`. | review-only     |
| F5  | approved | The nested probe MUST create its frame only on button click with `sandbox="allow-scripts"` and no `allow-same-origin`, and MUST give the frame a restrictive CSP. The parent MUST accept only the fixed readiness message from `iframe.contentWindow` and MUST NOT forward any child message to the host.                                                                       | review-only     |
| F6  | approved | Probe status MUST read Not confirmed until the child's message arrives, then Confirmed, and Unavailable after the timeout; it MUST NOT claim nested frames are supported.                                                                                                                                                                                                       | review-only     |
| F7  | approved | Controls MUST have 44px targets, visible focus (`focus-ring` with a transparent outline for forced colors), and a dashed, muted disabled state exposed with `aria-disabled`. Content MUST reflow at 320px with no horizontal scroll.                                                                                                                                            | review-only     |

## Colors

Use the neutral page tiers, `text` and `text-muted` ink, `border-strong` for control and card boundaries, and `primary-bg` / `primary-fg` for the pressed variant. Status uses a 4px left rule in `border-strong`, `green-strong` (Initialized, Confirmed), or `danger` (Failed, Unavailable); every state also begins with its word. Dark values apply through `prefers-color-scheme`.

## Typography

Use the sans stack for 16px/26px prose, 24px/32px page title, 18px/28px section headings, and 14px/22px controls and status. Use the mono stack for 13px state metadata. No font files are embedded or requested.

## Layout

One column capped at `measure`, 24px section spacing, 16px inset (24px from 640px). Cards use `repeat(auto-fit, minmax(min(100%, 200px), 1fr))` with 12px gaps so one card spans the row at 320px. The probe frame is 240px tall and full width.

## Responsive

The single `small` breakpoint (640px) raises the inset from 16px to 24px. All other adaptation is intrinsic: wrapping controls and the auto-fit card grid. Check 320px reflow.

## Elevation & Depth

Flat. Depth comes from 1px borders; the only elevation token is `focus-ring`.

## Motion

None.

## Components

| Component     | Anatomy and tokens                                                 | Behavior                                                                                 |
| ------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| HostStatus    | `#host-status`; surface, border, status rule                       | Live region; Pending until the parent answers, then Initialized or Failed after 3 s      |
| VariantSwitch | `#variant-list`, `#variant-cards`; raised, border-strong, primary  | Pressed state, hash update, direct render; `#variant-heading` names the selected variant |
| VariantView   | `#variant-view`; List rows or Cards grid                           | Rebuilt from fixed data on every selection                                               |
| ProbeButton   | `#probe-button`; raised, border-strong                             | Starts one probe; `aria-disabled` while waiting                                          |
| ProbeStatus   | `#probe-status`; surface, border, status rule                      | Not confirmed, Confirmed, or Unavailable after 2 s                                       |
| ProbeFrame    | `#probe-frame`, title "Isolated nested frame probe"; border-strong | Child shows its own List and Cards buttons and sends one readiness message               |

## Accessibility

Use one `h1`, sectioned headings, labelled groups, `role="status"` regions, native buttons, and keyboard focus rings. State never relies on color alone. Check reflow at 320px.

## Verification

Run `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint packages/cli/script/mcp-artifact-demo/DESIGN.md --strict`. Rendered checks need a host that embeds the document; a standalone open proves only the Failed host state and the variant and probe behavior.

## Maintenance

Read the root and web files before edits; change tokens only with their source in `apps/web/src/styles/tokens.css`.
