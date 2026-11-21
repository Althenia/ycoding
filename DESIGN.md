---
version: alpha
name: YCoding brand
description: Shared identity and interaction contract for the YCoding terminal, Web, Desktop, and marks.
surface: brand
colors:
  trace: "#67D7A4"
  frost: "#F2F3F5"
  attention: "#F0BE62"
  mark-surface: "#24282F"
  mark-rule: "#3A404A"
  mark-canvas: "#1B1E23"
---

# YCoding design system

## Overview

YCoding runs Sessions on the host runtime. The terminal is the behavioral reference. Web publishes product information and presents connected Sessions; Desktop adds local backend and macOS controls. The branching Y and its amber junction identify each surface.

## Principles

- Keep runtime and decision authority with the host. Present reported state, supported actions, and explicit recovery.
- Give reading, navigation, and decisions their own planes. Use space and type before frames.
- Reserve geometry for asynchronous content. Keep input, focus and the reading anchor stable while state changes.

## Rules

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
| R9 | approved | GUI prose and interface labels MUST use Geist (`Geist`). Browser Web code and compact metadata MUST use self-hosted JetBrains Mono; extension code and metadata retain Geist Mono and extension fonts MUST be embedded without external requests or new archive entries. Terminal specimens MUST use Geist Mono as their reference without changing the user's terminal font settings. Preserve licensed faces and owned fallbacks. | `apps/web/src/styles/typography.test.ts`, `extensions/chrome/test/design-md.test.js`; terminal host control is review-only |
| R10 | approved | README and public showcase images MUST be captures of current product surfaces with sample data: terminal frames from the real-route TUI screen harness in the default `ycoding` theme rendered in Geist Mono, and web and phone views from the remote verification fixture with only its fixture banner and controls hidden. Compositions MUST use the mark palette and Geist; NEVER redraw, mock, or retouch a captured surface. | review-only (`assets/showcase`) |
| R11 | approved | Decision copy MUST identify the pending request, allowed typed actions, active feature capability, and source provenance; it MUST NOT assign decision authority by person category or label a request as human-only. A request stays pending until a valid authorized client decision or configured automation settles it. Reject, Cancel, timeout, and Dismiss are request-local; Stop and Interrupt are separate Session operations. Do not infer a session-wide rejection default. Preserve configured defaults and capability-scoped grants. Outside an effective YOLO category, preserve explicit denies and permission ceilings. Before enabling any new YOLO category, require explicit in-dialog acceptance of all resulting risks: YOLO disables every blocker in that category, including hard, catastrophic, and destructive guardrails, permission blocks, and all questions, free-text questions, and open questions. State that the user assumes full responsibility. Cancel or Escape saves nothing; Manual and Auto apply directly. Project coordinator separation remains enforced. Defer is a persistent toggle; prompts do not disable it. | review-only (`packages/tui/DESIGN.md`, `apps/web/DESIGN.md`, `docs/runtime.md`) |
| R12 | approved | Web hierarchy MUST use typography, whitespace and semantic planes with owned public header/footer boundaries and bounded code, diff, request, search and selected-detail surfaces. Conversation and companion headers, fields, composer, floating layers, focus and hard-review danger states retain their meaningful boundaries. NEVER add arbitrary nested cards or blanket row separators. Chrome extension and TUI composition retain their surface owners. | `apps/web/verify/design-contract.integration.test.ts`; other surfaces review-only |
| R13 | approved | Web and Desktop MUST share the Field Notes planes, typography, icon grammar, and selection marker. Their surface documents MUST own layout and host-specific variation; this rule does not apply to terminal or extension composition. | `apps/web/src/styles/design-md.test.ts`, `packages/desktop/test/ledger-design.test.ts` |

## Colors

`trace`, `frost`, `attention`, `mark-surface`, `mark-rule` and `mark-canvas` belong to the mark assets. Field Notes uses paper and ink in the default light mode and olive charcoal in the default dark mode. Use green for primary actions, selected navigation, focus, and user attribution; mint for active or completed work, amber for attention, coral for destructive actions and errors. Keep other schemes available and let each host own its theme roles. Light canvas-to-raised and chrome-to-raised contrast are at least 1.15:1 and 1.10:1; meaningful pane boundaries and focus reach 3:1.

## Typography

Geist is the interface and prose family. Web and Desktop use self-hosted JetBrains Mono for code and compact metadata. Chrome and Meeting keep their embedded Geist and Geist Mono faces and existing archive layout. Terminal specimens use Geist Mono; the terminal owns actual font and cell size. Browser-owned tab and badge text uses the host font. Keep licensed face files and fallbacks.

## Layout

The public header, page and footer share one track. Web and Desktop workspaces keep a stable shell, a readable conversation, and owned inspectors. The nearer design file sets geometry and input-dependent layout. TUI lays out terminal cells and extensions lay out the host popup or Meeting surface; neither inherits GUI workspace geometry.

## Motion

Use motion for feedback and layer continuity. On Web and Desktop, the running trace is the signature: it marks execution in existing chrome and is static under reduced motion. Translucent portrait bottom navigation and public header fall back to their opaque planes when transparency is reduced, forced colors are active or filtering is unavailable.

## Icons

GUI actions use one owned 24-unit currentColor SVG family with 1.6-unit rounded strokes. Give icon-only controls accessible names. Terminal status pairs its cell-width glyphs with text or state context. The browser-control launcher, its popup header and the Meeting live page use the canonical Y. The browser-control cursor label uses the monochrome mark; Chrome's text-only tab strip uses the documented extension glyph. Do not substitute a generic icon or emoji for the Y.

## Mark

Use `assets/brand/ycoding-mark.svg` for the color source, `ycoding-mark-mono.svg` for the silhouette and `ycoding-wordmark.svg` for the full lockup. Keep the Y centered with at least 17% margin on the rounded-square icon and inside the radius-40% safe circle on the maskable icon. Use `bun run brand:generate` for raster derivatives. README and showcase captures use the real product with sample data: TUI from the real-route harness in `ycoding` and Geist Mono; remote Web and phone from the local verification fixture with only fixture banner and controls removed. Frame screenshots with the mark palette and Geist; never redraw, mock or retouch a captured surface.

The showcase uses the 189×69-cell Session specimen at an 8px cell, the 1440×900 Web capture at 2× and the 390×844 phone capture at 3×. Use Canvas for the frame, Surface for window bars, Rule for borders, Frost for text and Trace for labels, with the canonical wordmark. When refreshing the showcase, regenerate all three captures together.

## Content

Name the operation and the available next action. Distinguish pending, failed, unknown and settled. Decision descriptions report request, capability and provenance. Stop and Interrupt are separate from Cancel, Reject, Dismiss and timeout. Missing usage is unreported, not zero.

## Touchpoints

`apps/web/DESIGN.md` and `packages/desktop/DESIGN.md` own Field Notes. `packages/tui/DESIGN.md`, `extensions/chrome/DESIGN.md`, `extensions/interaction-chrome/DESIGN.md` and `extensions/meeting/view/DESIGN.md` own their host-specific styles and inherit the identity, accessibility and decision rules here.

## Accessibility

Keep WCAG 2.2 AA contrast floors (4.5:1 normal text, 3:1 large text and meaningful non-text boundaries), visible and unobscured keyboard focus, named icon actions and non-color status. Use at least 24px targets or the required separation; coarse pointers use 44px. Check browser reflow at 320 CSS px and zoom at 200%. The installed Web app's zoom lock is limited to installed mode. Respect reduced motion and platform forced colors.

## Verification

Use the checks named in the Rules table. Run strict lint on this file and each changed surface, the owned token-drift tests, and selected tests for rendered and inherited contracts. Web captures prove Chrome output; Desktop browser renderer captures do not prove the packaged WebKit view. Rendered contrast checks supplement, not replace, each surface's palette tests.

## Maintenance

Read the nearest design file and its extends chain before changing UI. Obtain approval for changed values and behavior, update the rule first, and update code and drift tests in the same change. Run `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint DESIGN.md --strict` and the selected surface checks.

## Do's and Don'ts

- Do use licensed assets, semantic controls, and real supported state.
- Don't use a screenshot, fixture or reference as a source of product capabilities.

## Exceptions

| Rule | Scope                                           | Reason                                                                                                                                                                                                                                  | Approval | Review date |
| ---- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| R2   | Existing web controls and native input variants | A complete never-default audit is not established by current unit tests; unowned variants require rendered review, not assumed compliance.                                                                                              | pending  | 2026-10-29  |
| R5   | Installed-app accessibility                     | Page zoom lock is the approved product contract but removes page magnification; legibility and reflow require separate verification.                                                                                                    | approved | 2026-10-29  |
| R9   | Terminal typography                             | `packages/tui/DESIGN.md` specifies Geist Mono at 14/18px for specimens; the terminal controls its actual font and cell size, and the TUI does not change those host settings.                                                           | approved | 2026-10-29  |
