---
version: alpha
name: YCoding brand
description: Terminal-first coding agent identity shared by its TUI, web client, and marks.
surface: brand
colors:
  trace: "#67D7A4"
  frost: "#F2F3F5"
  attention: "#F0BE62"
  mark-surface: "#24282F"
  mark-rule: "#3A404A"
  mark-canvas: "#1B1E23"
---

# YCoding design rules

## Overview

YCoding is a terminal-first coding agent. Its TUI is the behavioral reference; the SolidJS web client is a presentation and remote-control surface for the same runtime. The visual signature is a branching Y with a warm execution junction, quiet neutral surfaces, restrained status color, and explicit state. The public site, remote workspace, terminal, icons, and offline/error states belong to one identity, not interchangeable dashboard templates. Sources: `docs/product-direction.md`, `assets/brand/README.md`, `packages/tui/src/theme/assets/ycoding.json`, `apps/web/src/styles/tokens.css`.

## Principles

- Put execution and durable state in the local runtime; presentation mirrors TUI behavior rather than inventing a second workflow (`docs/product-direction.md`, `docs/runtime.md`).
- Own appearance with semantic tokens and components while retaining native keyboard, focus, and input behavior (`apps/web/src/styles/base.css`, `packages/tui/DESIGN.md`).
- Keep physical control geometry stable and adapt composition at content breakpoints; reserve async geometry to preserve reading position (`apps/web/src/styles/tokens.css`, `apps/web/verify/loading.integration.test.ts`).
- Favor a calm, legible work surface: use status color for meaning, text for recovery, and motion for continuity (`apps/web/src/styles/base.css`, `apps/web/src/remote/ui/loading.css`).

## Rules

Each approved rule binds inherited surfaces. An exception records an unresolved conflict; it is not permission to silently adopt either implementation.

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| R1 | approved | The web MUST mirror TUI behavior and NEVER execute a separate browser-owned Session workflow. | review-only (`docs/product-direction.md`, `docs/runtime.md`) |
| R2 | approved | Every visible control and view MUST have an owned token or component treatment; NEVER leave a user-agent or library default appearance, except forced-colors system rendering. | review-only; `apps/web/src/styles/composition.test.ts` and `apps/web/verify/scrollbar.integration.test.ts` cover selected defaults |
| R3 | approved | Async regions MUST reserve final geometry and NEVER move content that follows them when data resolves. | `apps/web/verify/loading.integration.test.ts`, `apps/web/verify/running-sessions.integration.test.ts` |
| R4 | approved | Popovers MUST anchor beside their invoking control, including portalled overlays. | `apps/web/verify/status-panel-motion.integration.test.ts`, `apps/web/verify/composer-controls.integration.test.ts` |
| R5 | approved | The installed web app MUST keep page zoom locked; browser tabs MUST retain browser zoom. | `apps/web/verify/pwa-shell.integration.test.ts` |
| R6 | approved | Web, terminal, and app marks MUST carry the YCoding identity; raster derivatives MUST come from the canonical SVG generator. | `packages/simulation/test/brand-assets.test.ts`, `bun run check:ycoding-brand` |
| R7 | approved | Token values documented by the web surface MUST match its light root and dark overrides in both directions. | `apps/web/src/styles/design-md.test.ts` |
| R8 | approved | Interactive states MUST remain distinguishable without color alone; focus MUST remain visible and controls keyboard operable. | review-only; `apps/web/verify/design-contract.integration.test.ts` samples rendered states |
| R9 | approved | GUI typography MUST use Geist Sans (`Geist`) for interface prose and Geist Mono for code and compact metadata. Web fonts MUST be self-hosted and extension fonts MUST be embedded without external font requests or new archive entries. Terminal typography MUST document Geist Mono as its reference without changing the user's terminal font settings. | `apps/web/src/styles/typography.test.ts`, `extensions/chrome/test/design-md.test.js`; terminal host control is review-only |
| R10 | approved | README and public showcase images MUST be captures of current product surfaces with sample data: terminal frames from the real-route TUI screen harness in the default `ycoding` theme rendered in Geist Mono, and web and phone views from the remote verification fixture with only its fixture banner and controls hidden. Compositions MUST use the mark palette and Geist; NEVER redraw, mock, or retouch a captured surface. | review-only (`assets/showcase`) |

## Colors

The mark's Trace, Frost, Attention, dark Surface, Rule, and Canvas are SVG asset colors, not an instruction to replace surface theme roles. The TUI's default interaction blue and the web's green accent are documented surface roles, not a claimed color match. See surface files and `assets/brand/README.md`.

## Typography

Geist Sans (`Geist`) is the GUI family for titles, prose, and interface labels; Geist Mono is the family for code and compact remote metadata. Use the unmodified variable fonts and SIL Open Font License in `assets/brand/fonts`; the web serves them from its own build and the extension embeds its required faces. Keep owned platform fallback stacks for unavailable fonts and unsupported glyphs. Preserve each surface's sizes, line heights, and weights; hierarchy comes from weight, position, and semantic ink before decoration (`packages/tui/DESIGN.md`, `apps/web/src/styles/base.css`, `apps/web/src/styles/remote.css`).

The terminal renders whole cells in the user's selected monospace font and size. Geist Mono is the reference face for terminal specimens, not a setting the TUI can enforce. Native browser-owned badge typography also remains browser-controlled. Canonical mark geometry remains unchanged.

## Motion

Product motion is functional: entrances, exits, and state feedback; reduced-motion preferences retain state without travel. The public site may use restrained reveal motion (`apps/web/src/styles/base.css`, `apps/web/src/remote/ui/loading.css`).

## Icons

Web action icons use the owned `Icon` SVG registry: 24-unit viewBox, 1.6-unit rounded strokes, and `currentColor` (`apps/web/src/ui/icon.tsx`). The terminal uses cell-width Unicode glyphs paired with text or status context; neither surface substitutes a generic third-party icon or an emoji for the Y mark (`packages/tui/DESIGN.md`).

## Mark

`assets/brand/ycoding-mark.svg` is the transparent color source; `ycoding-mark-mono.svg` is its monochrome silhouette; `ycoding-wordmark.svg` carries the full lockup. `ycoding-icon.svg` is the rounded-square any-purpose icon, with a small even Y margin of at least 17% on each side. `ycoding-icon-maskable.svg` is full-bleed dark; keep the Y inside the centered circle with radius 40% of tile width. `packages/simulation/test/brand-assets.test.ts` checks palette, geometry, dimensions, opacity, margin, and safe zone. Generate PNG derivatives with `bun run brand:generate` (`packages/simulation/script/generate-brand-assets.ts`); never redraw, stretch, or edit the generated PNGs. The compact three-line terminal silhouette is documented in `assets/brand/README.md`.

## Showcase

`assets/showcase` holds the README hero and per-surface screens. `ycoding-tui.png` renders the TUI screen harness's captured cell colors and attributes for the composed Session route at 189×69 cells in Geist Mono at an 8px cell; `ycoding-web.png` (1440×900 CSS px at 2×) and `ycoding-phone.png` (390×844 CSS px at 3×) capture the dark remote verification fixture. `ycoding-showcase.png` frames those three captures on Canvas with Surface window bars, Rule borders, Frost text at full and reduced opacity, Trace labels, the canonical wordmark, and Geist type (R10). Regenerate every screen together after a visible change to a captured surface.

## Content

Name actions by what they do, use YCoding and Session consistently, distinguish pending, failed, unknown, and completed outcomes, and pair errors with a next action. Unknown usage values remain unreported rather than zero (`docs/product-direction.md`, `docs/runtime.md`, `apps/web/src/remote/ui/transcript.css`). The web public site and remote workspace use direct, concise labels; terminal hints use compact keyboard-first wording.

## Touchpoints

Brand assets live in `assets/brand`; the web app uses separate any-purpose and maskable icons, wordmark on the new-session surface, and brand roles on public, remote, offline, and error views (`apps/web/src/styles/site.css`, `docs/product-direction.md`). Terminal chrome uses the default `ycoding` theme's role colors and Unicode glyphs (`packages/tui/src/theme/assets/ycoding.json`). Do not infer an unverified social-preview or notification asset from the icon inventory.

## Accessibility

Use WCAG 2.2 AA floors: normal text 4.5:1, large text and meaningful non-text boundaries 3:1, visible focus, keyboard access, names for icon-only controls, no color-only status, reduced motion, and at least 24px targets or sufficient separation (44px for coarse pointers). Check reflow at 320 CSS px and tab zoom at 200%; R5 is an installed-app-only magnification trade-off, not a claim that zoom accessibility is preserved. Terminal states must be readable without color. Contrast of a token pair does not prove rendered contrast over every background.

## Verification

R1 and R2 require code and rendered-state review. R3–R5 use their named browser integration suites; R6 uses `bun test` in `packages/simulation` targeting `test/brand-assets.test.ts` and `bun run check:ycoding-brand`; R7 uses `bun test src/styles` from `apps/web`; R8 uses keyboard/contrast review and the named design-contract suite. R10 requires reviewing each showcase image against its capture source. Run `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint` on this file and both surface files. Browser integration suites need their configured Chrome executable; a unit-suite pass does not imply these suites ran.

## Maintenance

Read the nearest surface file and its `extends` chain before UI changes. Add or revise the binding rule first, obtain approval for changed values/behavior, and update code, tests, and this chain in the same change. The web drift test compares documented light/dark values against `tokens.css` in both directions; the CSS values are executable, not silently authoritative when they differ. Record disagreement as a scoped pending exception with review date; do not choose a winner by extraction.

## Do's and Don'ts

- Do reuse owned tokens, states, accessible primitives, and canonical marks; test both themes, keyboard, pointer, and pending/error states.
- Don't promote a specimen or a generated image into authority, hard-code a near-match color, hide a necessary action on hover, or call an unrun render matrix verified.

## Exceptions

| Rule | Scope | Reason | Approval | Review date |
| --- | --- | --- | --- | --- |
| R2 | Existing web controls and native input variants | A complete never-default audit is not established by current unit tests; unowned variants require rendered review, not assumed compliance. | pending | 2026-10-29 |
| R5 | Installed-app accessibility | Page zoom lock is the approved product contract but removes page magnification; legibility and reflow require separate verification. | approved | 2026-10-29 |
| R6 | Web and default terminal action color | `apps/web/src/styles/tokens.css` uses green (`--yc-primary-bg`) while `packages/tui/src/theme/assets/ycoding.json` uses blue interactive `#79B8FF`; preserve both implemented roles pending an explicit cross-surface palette decision. | pending | 2026-10-29 |
| R9 | Terminal typography | `packages/tui/DESIGN.md` specifies Geist Mono at 14/18px for specimens; the terminal controls its actual font and cell size, and the TUI does not change those host settings. | approved | 2026-10-29 |
