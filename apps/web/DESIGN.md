---
version: alpha
name: YCoding web
description: Shared public site and remote workspace presentation of the local terminal-first runtime.
surface: web
extends: ../../DESIGN.md
colors:
  green: "#27d17f"
  green-strong: "#0a7b47"
  green-soft: "rgba(39, 209, 127, 0.12)"
  primary-bg: "#0b8550"
  primary-fg: "#ffffff"
  yellow: "#f4bd3d"
  yellow-strong: "#946200"
  yellow-soft: "rgba(244, 189, 61, 0.16)"
  danger: "#c53a3a"
  danger-soft: "rgba(197, 58, 58, 0.1)"
  focus: "#0b8b50"
  bg: "#ffffff"
  surface: "#f7f9f8"
  surface-sunken: "#eff3f1"
  surface-raised: "#ffffff"
  text: "#0b0f14"
  text-muted: "#5c6672"
  text-subtle: "#646d78"
  border: "#e4e8e6"
  border-strong: "#78847e"
  terminal-bg: "#0c1413"
  terminal-fg: "#d8e6de"
  terminal-dim: "#8fa79b"
  terminal-accent: "#5fe3a1"
typography:
  font-sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
  font-mono: 'ui-monospace, "SFMono-Regular", "JetBrains Mono", "Geist Mono", Menlo, monospace'
  size-2xs: 12px
  leading-2xs: 16px
  size-xs: 13px
  leading-xs: 20px
  size-sm: 14px
  leading-sm: 22px
  size-md: 16px
  leading-md: 26px
  size-lg: 18px
  leading-lg: 28px
  size-xl: 20px
  leading-xl: 30px
  size-2xl: 24px
  leading-2xl: 32px
  size-3xl: 30px
  leading-3xl: 38px
  size-4xl: 36px
  leading-4xl: 42px
  size-display: 40px
  leading-display: 44px
  weight-regular: 400
  weight-medium: 500
  weight-semibold: 600
  weight-bold: 700
  tracking-tight: -0.02em
  tracking-wide: 0.06em
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 24px
  "8": 32px
  "10": 40px
  "12": 48px
  "16": 64px
  "20": 80px
rounded:
  sm: 6px
  md: 10px
  lg: 14px
  xl: 20px
  pill: 999px
elevation:
  sm: "0 1px 2px rgba(11, 15, 20, 0.06)"
  md: "0 8px 24px rgba(11, 15, 20, 0.08)"
  lg: "0 20px 48px rgba(11, 15, 20, 0.16)"
  focus-ring: "0 0 0 2px var(--yc-bg), 0 0 0 4px var(--yc-focus)"
controls:
  control-h: 44px
  control-h-dense: 36px
  hit-min: 44px
  control-pad-x: 16px
  border-width: 1px
  scrollbar-size: 12px
layout:
  measure: 68ch
  measure-narrow: 54ch
  header-h: 60px
  header-session-h: 44px
  status-strip-h: 36px
  bottom-nav-h: 56px
  content-max: 1200px
  rail-w: 288px
  activity-w: 344px
  docs-nav-w: 248px
  docs-toc-w: 200px
  device-max: 180px
  gutter: 16px
motion:
  duration:
    instant: 80ms
    quick: 140ms
    base: 220ms
    slow: 320ms
  easing:
    standard: "cubic-bezier(0.2, 0, 0, 1)"
    entrance: "cubic-bezier(0, 0, 0.2, 1)"
    exit: "cubic-bezier(0.4, 0, 1, 1)"
layers:
  header: 30
  nav: 20
  scrim: 90
  overlay: 100
  toast: 110
breakpoints:
  compact: 360
  phone: 480
  small: 640
  tablet: 768
  desktop: 1024
  wide: 1280
  expansive: 1600
devices:
  phone:
    width: 390
    height: 844
    pointer: coarse
    hover: false
    dpr: 3
  desktop:
    width: 1440
    height: 900
    pointer: fine
    hover: true
    dpr: 1
themes:
  dark:
    colors:
      green: "#27d17f"
      green-strong: "#4ee29b"
      green-soft: "rgba(39, 209, 127, 0.16)"
      primary-bg: "#4ee29b"
      primary-fg: "#04150c"
      yellow-strong: "#f7d37c"
      yellow-soft: "rgba(244, 189, 61, 0.14)"
      danger: "#ef6f6f"
      danger-soft: "rgba(239, 111, 111, 0.14)"
      focus: "#4ee29b"
      bg: "#0b1115"
      surface: "#11181d"
      surface-sunken: "#0e151a"
      surface-raised: "#151e24"
      text: "#f4f7f6"
      text-muted: "#99a2ad"
      text-subtle: "#7d8792"
      border: "#263039"
      border-strong: "#718278"
    elevation:
      sm: "0 1px 2px rgba(0, 0, 0, 0.4)"
      md: "0 10px 30px rgba(0, 0, 0, 0.45)"
      lg: "0 24px 56px rgba(0, 0, 0, 0.55)"
---

# YCoding web design rules

## Overview

This surface inherits `../../DESIGN.md`: the public site and the authenticated remote workspace share light/dark semantic tokens but present distinct density. Values are transcribed from `src/styles/tokens.css`; its referenced `.aphrodite/redesign-audit/specs/tokens.toon` is absent, so that file cannot serve as an authority. `src/styles/base.css` owns shared primitives; `site.css`, `docs.css`, `remote.css`, and `src/remote/ui/*.css` own composition.

## Principles

- Keep the TUI's Session behaviors while adapting the presentation to web navigation and responsive controls (`docs/product-direction.md`, `docs/runtime.md`).
- Separate invariant control/type geometry from compositional gutter/display steps (`src/styles/tokens.css`, `src/styles/tokens.test.ts`).
- Use semantic colors rather than a raw brand SVG color as a button surface; the primary has its own theme-specific ink (`src/styles/contrast.test.ts`).

## Rules

Inherited R1–R8 apply. These web-specific rules are approved binding statements:

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| W1 | approved | Web CSS MUST use the declared `--yc-*` theme roles and fixed breakpoint steps; documented base and dark token values MUST agree with `tokens.css`. | `src/styles/design-md.test.ts`, `src/styles/tokens.test.ts` |
| W2 | approved | Primary actions MUST use `--yc-primary-bg` and `--yc-primary-fg`, NEVER the foreground green for the surface; normal-size labels MUST reach 4.5:1 in both themes. | `src/styles/contrast.test.ts` |
| W3 | approved | Dense controls MUST become 44px on coarse pointers; gutter/display overrides MUST follow the steps below rather than viewport interpolation. | `src/styles/tokens.test.ts` |
| W4 | approved | Loading placeholders MUST wait 140 ms, reserve region-specific geometry, and remain static under reduced motion. | `verify/loading.integration.test.ts` |
| W5 | approved | The Running and recent carousel MUST reserve its initial height and show at most ten roots, running first; pagination MUST appear only on overflow. | `verify/running-sessions.integration.test.ts` |
| W6 | approved | User transcript bubbles MUST be right-aligned; assistant content MUST remain left-aligned, and history paging MUST preserve the visible row. | `verify/transcript.integration.test.ts` |
| W7 | approved | Fine-pointer scrollbars MUST use the owned treatment: a 12px gutter with a transparent track and corner, no arrow buttons, and a pill thumb 4px wide at rest in `--yc-border-strong` that widens to 8px under the pointer (`--yc-text-muted`) and while dragged (`--yc-green-strong`); coarse pointers and forced colors MUST keep platform scrollbars. From 768px with a fine pointer, primary scroll regions MUST reserve the gutter so overflow never shifts content, and Conversation rows outside the scroller MUST stop at the scroller's content edge while full-width bands reach the window edge. | `verify/scrollbar.integration.test.ts`, `src/styles/contrast.test.ts` |
| W8 | approved | Popovers MUST appear beside their triggers without losing focus return, including portalled ones; sheets/dialogs MUST keep keyboard focus contained. | `verify/status-panel-motion.integration.test.ts`, `verify/composer-controls.integration.test.ts` |
| W9 | approved | In the light theme, the public hero MUST remain neutral without the ambient green glow; the glow belongs to the dark hero only. Composer cards, picker outlines, and neutral circular icon actions MUST have boundaries of at least 3:1 against the white work surface without changing their size or dark-theme treatment. | `verify/light-office.integration.test.ts` |
| W10 | approved | On a tall viewport, the landing hero MUST absorb spare vertical space while keeping its content centered; the capabilities section MUST meet the footer without a blank band in either theme. On short viewports, content MUST keep its natural height and remain scrollable. | `verify/light-office.integration.test.ts` |

## Colors

Green is the single web accent. `--yc-green-strong` is foreground on page, raised, and soft-green surfaces; primary buttons instead use their dedicated pair because white on the bright dark green is only 1.65:1. `--yc-text-subtle` holds AA on sunken surfaces; `--yc-border-strong` holds 3:1 for active boundaries. Terminal plate inks stay constant across themes; semantic page surfaces and shadows change. Sources: `src/styles/tokens.css`, `src/styles/contrast.test.ts`.

In light mode, the new-session and conversation composer use `--yc-border-strong` for their outline and neutral icon/picker boundaries against white. Dark mode retains its existing raised-surface treatment. The install command remains a dark code block in both themes: its constant terminal ink and surface distinguish executable code from page prose. The public hero's ambient green gradient is dark-theme only (`src/styles/site.css`, `src/styles/base.css`, `src/remote/ui/composer.css`, W9).

## Typography

Use `--yc-font-sans` for public titles and prose, `--yc-font-mono` for code and compact remote labels/metadata. Fixed size/leading pairs run 2xs–4xl; display is 40/44px before 1024px and 56/60px from 1024px, at the measured headline wrap point. Reading measures are 68ch and 54ch (`src/styles/tokens.css`, `src/styles/tokens.test.ts`, `src/styles/remote.css`).

## Layout

### Office open floor

The Office canvas is one continuous floor with a perimeter entrance, no internal walls or room titles. Sixteen disjoint, bounded agent blocks form four rows of four; each block has its own desk/monitor, bookshelf, test terminal, and whiteboard. Editing stays at the desk, reading/search at the shelf, tests/typecheck/lint/commands at the terminal, and subagent/todo coordination at the board. Working characters and their activity routes remain within their claimed block, with at most twelve tiles between task spots and immediate retargeting when activity changes. Neutral corridors connect the blocks to a shared lounge and perimeter entrance without crossing another block. The visible population is capped at sixteen; excess child tasks are counted outside the scene, never assigned another agent's block. Idle agents may rest at their desk or move to the lounge. Delegation and report cues use bubbles at each agent's own block rather than shared task furniture. At supported tablet/desktop whole-floor fit, stagger bubbles and name plates instead of letting neighboring agents' labels cover each other. Reuse authored Office sprites and preserve crisp pixel scaling, controls, names, status bubbles, and reduced-motion settling.

At tablet and desktop widths the Office route occupies the available scroll-region height below the header and status strip, with the canvas and roster stretching to its bottom without document scrolling. A phone fixture keeps a minimum usable canvas and may scroll vertically. Default camera view fits the whole floor at 1024 and 1440 CSS-pixel widths; zoom and follow can intentionally crop it.

Use the 4px spacing scale, 1200px content maximum, stepped `--yc-gutter`, declared header/status rows, and rail widths. Center Conversation's transcript and composer as one column; reserve todo and composer space in document flow (`src/styles/remote.css`, `verify/transcript.integration.test.ts`). The owned scrollbar occupies layout space, so from 768px with a fine pointer `.workspace__scroll` reserves its gutter (Activity, whose panes run edge to edge, does not), and Conversation's main grid adds a `--yc-scrollbar-size` end column that only the scroller, the top bar, and the subagent bar span; the todo panel, jump controls, and composer end where the transcript column's content box ends (`src/styles/remote.css`, `verify/scrollbar.integration.test.ts`).

The landing route alone uses a flexible hero before its fixed-height capabilities section. The hero centers its existing content as it grows so a tall viewport adds room around the opening statement rather than a blank strip after the cards; shorter screens retain ordinary page scrolling (`src/styles/site.css`, W10).

## Responsive

The front-matter `breakpoints` are width thresholds in pixels, not CSS declarations. `tokens.css` steps the gutter 16px below 480, 20px at 480, 24px at 640, 32px at 1024, 40px at 1280, and 48px at 1600. At 1024, display size/leading become 56/60px. At `(pointer: coarse)`, dense height becomes 44px independently of width. The 360 and 768 thresholds are composition breakpoints used by surface styles, not token-value overrides. `src/styles/tokens.test.ts` checks the token steps; `verify/design-contract.integration.test.ts` checks representative route geometry.

## Elevation & Depth

Raised cards, overlays, and dialogs use three light/dark shadow steps paired with borders, not shadows alone. `--yc-focus-ring` composes background and focus-color halos; header/nav/scrim/overlay/toast use the declared layer order (`src/styles/tokens.css`, `src/styles/base.css`).

## Shapes

Use 6/10/14/20px rounded steps and the 999px pill for compact controls and chips. Child corners remain subordinate to their container; the remote composer and overlays use the larger surface radius (`src/styles/base.css`, `src/styles/remote.css`, `src/remote/ui/composer.css`).

## Motion

80/140/220/320ms durations and the three declared easings carry feedback and entrance/exit motion. Dismissed overlays become inert before exit finishes; reduced motion removes travel but preserves the state transition (`src/styles/base.css`, `src/remote/ui/loading.css`, `verify/overlay-motion.integration.test.ts`).

## Icons

`src/ui/icon.tsx` owns SVG path meanings, a 24-unit viewBox, 1.6-unit rounded strokes, `currentColor`, and decorative hiding. Icon-only controls need their own accessible names; `src/styles/base.css` and `src/remote/ui/*.css` own their focus and hit areas.

## Components

The tokens/states below describe current selectors and owners, not a new component API. Across interactive components, use the owner's rest/hover/active/disabled/focus-visible styles and never make hover the only path to an action.

| Component and purpose | Owner/selectors | Tokens, states, and rule |
| --- | --- | --- |
| Primary, secondary, and small buttons: actions | `src/styles/base.css` `.button`, `--primary`, `--secondary`, `--small`, `[disabled]` | Dedicated primary surface/ink; raised secondary with strong border; dense small height; hover/active/disabled/focus states. W2. |
| Fields and checks: labeled entry/choice | `src/styles/base.css` `.field`, `.input`, `.select`, `.textarea`, `.check` | Surface, strong border, muted hint, danger error, focus halo; placeholder, invalid, checked, disabled states. R2/R8. |
| Invite acceptance and access-key sign-in: single-use entry | `src/remote/ui/invite.tsx`, `shell.tsx`; `src/styles/remote.css` `.sign-in`, `.sign-in__panel`, `.sign-in__error`; shared `.field`, `.input`, `.button` | Centered raised panel; fragment removed before display; accept-only redemption, invalid and pending states, once-only key reveal with Copy and Continue; labeled key input, explicit invalid/rate-limited/retry errors; light/dark and phone/desktop use shared tokens. R2/R8. |
| Switches: boolean choice | `src/styles/base.css` `.switch` | Pill radius, border and green checked track; checked/focus states. R8. |
| Segmented controls: mutually exclusive view choice | `src/styles/remote.css` `.presentation-switch.filters`, `.appearance-segments .filters`, `.filters__option--active` | Surface/green roles and pill controls; selected and keyboard-focus states. R8. |
| Chips, pills, status: compact state labels | `src/styles/base.css` `.chip`, `.tag`, `.status-dot`; `src/remote/ui/status-bar.css` `.session-status__slot` | Green/yellow/danger soft fills, semantic text, pill radius; status also needs words. R8. |
| Portalled popovers and panels: local choices/details | `src/remote/ui/status-bar.tsx`, `model-control.tsx`, `composer-picker.tsx`; `status-bar.css` `.session-status__popover`, `src/styles/base.css` `.panel` | Raised surface, border, XL radius, large shadow, overlay layer; enter/exit/inert, anchored to trigger with focus return. R4/W8. |
| Sheets and overlays: contained mobile or modal decisions | `src/styles/base.css` `.overlay`, `.overlay--sheet`; `src/remote/ui/composer.css` `.composer__selection-sheet`; `src/ui/modal.tsx` | Raised surface, scrim/overlay layers, large radius, safe-area padding; open/closing and trapped focus. W8. |
| Cards: grouped information | `src/styles/base.css` `.card`, `.card--quiet`; `src/remote/ui/running-sessions.css` `.running-sessions__item` | Raised surface/border/radius, optional shadow; selected/hover/focus states only when interactive. W5. |
| Tables: dense comparable data | `src/styles/base.css` `.table-scroll`; `src/remote/ui/transcript.css` `.transcript-md table`; `src/remote/ui/usage.css` | Border, spacing, text roles; contained horizontal scrolling and focus. R8. |
| Notices and toasts: feedback and recovery | `src/styles/base.css` `.notice-strip`; `src/remote/ui/notifications.css` | Attention/danger and raised surfaces, toast layer; dismiss and keyboard focus. R8. |
| Loading placeholders: async occupancy | `src/remote/ui/loading.tsx`, `loading.css` `.loading-placeholder` | Raised/sunken/border, fixed geometry per region; 140ms reveal, static reduced-motion state. R3/W4. |
| Running and recent carousel: cross-workspace roots | `src/remote/ui/running-sessions.tsx`, `running-sessions.css` `.running-sessions` | Card border/radius, green running dot, snap rail/dots; loading/empty/overflow/selection. Idle cards show terminal `time.active` as Last active or Last active not reported when absent. W5. |
| Transcript bubbles: authored messages | `src/remote/ui/transcript.css` `.transcript-message--user`, `--assistant`, `__bubble` | Raised background, strong border, radius, text/metadata roles; streaming/read/failed/paged states. W6. |
| File-change card: captured edit/patch diffs grouped by path | `src/remote/ui/file-change-card.tsx`, `file-change-card.css` `.file-change-card`, `__diff` | Raised card filling the conversation column, green/danger counts matching every expanded diff (compaction recovery: latest recorded patch and its counts), sunken headings; three rows then expand, split desktop/unified phone, unavailable patch state. `verify/file-change-card.integration.test.ts`. |
| Focus ring: keyboard location | `src/styles/base.css` `:focus-visible`, field focus, remote controls | Focus color/halo and 2px outline/offset; visible on each interactive state. R8. |
| Icons: action/status symbols | `src/ui/icon.tsx` `Icon` | `currentColor`, rounded stroke, 24-unit viewBox; decorative hidden, icon-only control named. R8. |
| Scrollbar: owned fine-pointer scroll affordance | `src/styles/base.css` `::-webkit-scrollbar*` and the Firefox standard-property fallback; `src/styles/remote.css` gutter and Conversation grid rules; `.running-sessions__list` and `.transcript-navigation__ticks` hide their rails with alternate pagination/navigation | `--yc-scrollbar-size` 12px; transparent track/corner, no arrows, 4px pill at rest (`--yc-border-strong`) inset by `--yc-space-1`, 8px hover (`--yc-text-muted`) and drag (`--yc-green-strong`), minimum length `--yc-space-8`, every state ≥3:1 on page, surface, raised, sunken, and terminal backgrounds. Chromium and WebKit use the pseudo-elements; Firefox gets thin scrollbars in the rest color on a transparent track because a non-auto `scrollbar-color` would switch the pseudo-elements off elsewhere; coarse pointers keep transient native indicators and forced colors keep system scrollbars. W7. |

## Content

Use concise action labels and explicit pending, error, and unknown states. On remote screens, distinguish account, machine, Session, and child status; unknown provider quotas are unreported, not zero. The carousel orders active roots before recent idle roots; file-change counts match every expanded diff, and compaction recovery shows each path's latest recorded patch with its own counts (`docs/runtime.md`, `verify/running-sessions.integration.test.ts`, `verify/file-change-card.integration.test.ts`).

## Touchpoints

Public routes, documentation, changelog, remote workspace, offline shell, installed app icons, and browser theme-color use the same semantics but their route compositions remain owned by `site.css`, `docs.css`, `remote.css`, and the app shell. Use the canonical mark variants in `../../assets/brand` rather than a screenshot-derived approximation (`verify/pwa-shell.integration.test.ts`, `../../assets/brand/README.md`).

## Accessibility

Inherit the brand floors. Primary normal-size button text needs 4.5:1; active boundaries/focus need 3:1 across every surface they occupy (`src/styles/contrast.test.ts`). Keyboard focus and overlay behavior require real rendered review. At installed-app zoom lock, test legibility/reflow separately; do not claim magnification support. Preserve native selection, focus behavior, coarse-pointer hit areas, reduced-motion state, and forced-colors system scrollbar rendering.

## Verification

W1/W3: `bun test src/styles` from `apps/web`, including `design-md.test.ts` and `tokens.test.ts`. W2: `contrast.test.ts`. W4–W8: named `verify/*.integration.test.ts` with a configured Chrome executable; those are not part of `bun run test:web`. W7's thumb contrast runs in `contrast.test.ts`; its rendering runs in `verify/scrollbar.integration.test.ts`, the one suite that launches Chrome with visible scrollbars (`launchBrowser(..., { scrollbars: true })`). The other suites pass `--hide-scrollbars`, which hides custom scrollbars but still reserves `scrollbar-gutter`, so their geometry includes the gutter. Lint this chain with `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint apps/web/DESIGN.md`; `git diff --check` guards whitespace only.

## Maintenance

Read `../../DESIGN.md` and this file before UI changes. Add or revise a rule first, obtain approval for changed values or behavior, then update tokens/components, affected tests, and documentation together. `src/styles/design-md.test.ts` fails when any documented `--yc-*` value or any root/dark CSS declaration differs in either direction; responsive/pointer overrides are separately held by `src/styles/tokens.test.ts`. Record same-role conflicts as pending exceptions rather than silently selecting a winner.

## Do's and Don'ts

- Do compose from existing semantic colors and control geometry; check light/dark, coarse/fine, keyboard, loading, reduced motion, and route resize.
- Don't copy generated Stitch colors, assume a token contrast check proves all rendered states, or hide native control behavior to get a custom look.

## Exceptions

| Rule | Scope | Reason | Approval | Review date |
| --- | --- | --- | --- | --- |
| R2 | `src/remote/ui/transcript.css` rendered Markdown checkbox and other native controls | No complete owned-style audit of all generated content; behavior/accessibility must be preserved while appearance is reviewed. | pending | 2026-10-29 |
