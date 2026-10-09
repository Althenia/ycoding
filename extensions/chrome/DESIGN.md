---
version: alpha
name: YCoding Chrome control indicators
description: In-page cursor, tab-title marker, and toolbar badge that show which Chrome tabs YCoding is controlling.
surface: native
extends: ../../DESIGN.md
colors:
  agent-cursor: "#8b5cf6"
  agent-label: "#6d28d9"
  agent-label-text: "#ffffff"
  agent-ripple: "#a78bfa"
  agent-shadow: "#00000088"
  badge-on: "#28753e"
typography:
  agent-label:
    fontFamily: YCodingGeist, system-ui, sans-serif
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.2
  popup-body:
    fontFamily: Geist, system-ui, -apple-system, Segoe UI, sans-serif
    fontSize: 13px
    lineHeight: 1.45
  popup-mono:
    fontFamily: Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace
rounded:
  agent-label: 5px
components:
  agent-cursor:
    textColor: "{colors.agent-cursor}"
    height: 20px
  agent-label:
    backgroundColor: "{colors.agent-label}"
    textColor: "{colors.agent-label-text}"
    typography: "{typography.agent-label}"
    rounded: "{rounded.agent-label}"
    padding: 3px 6px
  agent-ripple:
    size: 22px
  toolbar-badge:
    backgroundColor: "{colors.badge-on}"
motion:
  duration:
    cursor-move: 320ms
    ripple: 450ms
layers:
  agent-overlay: 2147483647
layout:
  popup-width: 320px
spacing:
  popup-padding: 12px
controls:
  popup-height: 34px
---

# YCoding Chrome control indicators

## Overview

The Chrome extension marks every tab YCoding is controlling so the person using Chrome can see it: a fixed title prefix in the tab strip, a labelled cursor inside the page, and a per-tab toolbar badge. Chrome's native debugger infobar is separate, owned by Chrome, and cannot be restyled. The extension popup is a separate pre-existing surface (see Exceptions). Sources: `docs/browser-extension.md`, `specs/v2/browser.md`, `extensions/chrome/indicator.js`, `extensions/chrome/service-worker.js`.

## Principles

- Show control where the user already looks: the tab strip first, then the page, then the toolbar. Color never carries the signal alone; every indicator has text (`extensions/chrome/indicator.js`).
- Show only what the extension knows to be true. The cursor moves only to the coordinates of an action that is actually dispatched; it never wanders, and it stays hidden for actions without a target (`extensions/chrome/service-worker.js`).
- Carry no private text. The marker is a static prefix and the cursor label is one of a fixed action set; typed text, Session titles, Session IDs, and URLs never enter the page DOM (`extensions/chrome/indicator.js`).
- Refuse control rather than hide it. When the marker cannot be shown and confirmed on a tab, the extension rejects the operation before dispatch (`extensions/chrome/test/service-worker.test.js`).
- Own an expiry. The page removes the marker itself when the extension stops refreshing it, because no command can run after a native Cancel, a crash, or an extension reload.

## Rules

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| X1 | approved | Before any observe or action dispatch, a controlled tab MUST carry the title marker and the extension MUST confirm it by reading it back; otherwise the operation MUST fail before dispatch and MUST NOT be reported as controlled. | `extensions/chrome/test/service-worker.test.js` |
| X2 | approved | The marker MUST preserve the page's own title, including titles the page changes later, and cleanup MUST restore the last page-authored title and remove only the marker the extension installed. | `extensions/chrome/test/service-worker.test.js` |
| X3 | approved | Marker text MUST be the fixed title prefix and cursor labels MUST come from the action-type set (Click, Type, Scroll); the page DOM MUST NEVER receive typed text, Session titles, Session IDs, or URLs. | `extensions/chrome/test/service-worker.test.js` |
| X4 | approved | The cursor tip MUST sit on the actual action coordinates and MUST NEVER move to a coordinate that no action uses; under reduced motion it MUST jump without animation. | `extensions/chrome/test/service-worker.test.js` |
| X5 | approved | Explicit cleanup MUST complete, bounded in time, before the debugger detaches; when refresh stops, the page MUST remove the marker no later than the documented expiry plus its check interval, and on visibility or resume events. | `extensions/chrome/test/service-worker.test.js`, `packages/server/test-integration/browser-owned-chrome.test.ts` |
| X6 | approved | A pinned tab MUST NEVER be controlled, because the tab strip shows only its favicon and no verified marker exists for it. | `extensions/chrome/test/service-worker.test.js` |
| X8 | approved | The popup MUST render text in Geist and its local service address and pairing code in Geist Mono, from faces embedded in `popup.css`, and MUST NOT fetch a font or add a font file, permission, or CSP source. | `extensions/chrome/test/popup.test.js`, `extensions/chrome/test/fonts.test.js`, `packages/server/test-integration/browser-owned-chrome.test.ts` |
| X9 | approved | The page label MUST use Geist through a page-scoped `FontFace` under the alias `YCodingGeist`, registered once per document with the first cursor without delaying the label, removed with the marker whether loaded or pending, and MUST fall back to the system UI stack, never blocking the action, when the face cannot be installed. | `extensions/chrome/test/indicator.test.js`, `extensions/chrome/test/service-worker.test.js`, `packages/server/test-integration/browser-owned-chrome.test.ts` |
| X10 | approved | The popup MUST use 320px intrinsic width, 12px outer/card padding, a 24px canonical mark, a 15px heading and 13px body text. Controls MUST be at least 34px (44px for coarse pointers); secondary help MUST remain keyboard accessible, with pairing authority visible before Connect. | `extensions/chrome/test/popup.test.js`, `extensions/meeting/test/chrome.integration.test.ts` |
| X7 | approved | Documented `colors`, `rounded`, `typography`, `motion.duration`, `layers`, and component sizes MUST equal `extensions/chrome/indicator.js`, with `popup-body` and `popup-mono` equal to the `--font-sans` and `--font-mono` values in `popup.css`, and documented values MUST NOT be missing from or extra to them. | `extensions/chrome/test/design-md.test.js` |

## Colors

The purple cursor, label, and ripple, and the green badge, are the existing extension appearance and stay unchanged. They are extension-specific roles, not brand palette roles; the root brand file states that surface roles are not a claimed brand-color match. `agent-shadow` is the cursor drop shadow. `badge-on` is the toolbar badge background shown while a tab is controlled.

## Typography

The label is 12px, 1.2 line height, regular weight, white on the label color, in Geist. The page has no Geist, so the extension installs the embedded face into the controlled document as `YCodingGeist`, a name no site is likely to use, so a site's own `Geist` family is never replaced. The `FontFace` API takes bytes directly, so the label does not depend on the page's `font-src` policy. The face is registered before it loads and the label never waits for it: it shows the fallback with `font-display: swap` and switches when the face is loaded. A load that fails removes its face, a load that settles after the marker ended cannot add it back, and removing the marker removes the face, loaded or pending. If the face cannot be installed the label falls back to the system UI stack. The popup body is 13px, 1.45 line height, Geist, set on `body` because Chrome's extension-page default style sets a system family there and would override one inherited from `:root`; the local service address and pairing code are Geist Mono. Both faces are variable (100-900) and embedded in `popup.css` as data URLs, so the popup needs no network, permission, or CSP source. Native surfaces (the tab title, toolbar badge, and debugger infobar) use Chrome's own font and are outside this rule.

## Layout

Use the popup width, padding and control-height tokens for the popup and its card. Keep the 13px body text; use a 15px heading, 24px mark, 8px heading gap and 12px bottom spacing. Use 8px paragraph/form spacing, 4px/8px status-pill padding, and 10px secondary-action separation. Keep the connected view within 300px height with help collapsed. Reflow within 320 CSS px without clipping, retain browser zoom, and increase control and help-summary targets to 44px for coarse pointers.

## Elevation & Depth

The overlay host uses the maximum z-index (`layers.agent-overlay`) so the cursor is never hidden by page content, with `pointer-events: none` so it never intercepts hit-testing or focus. It has no other depth treatment beyond the cursor drop shadow.

## Shapes

The cursor is a pointer arrow whose tip is its hotspot. The label is a 5px-radius chip beside the arrow. The click ripple is a circle centered on the hotspot.

## Motion

The cursor eases to each real target over `cursor-move`; a click adds a ripple over `ripple`. A hidden page skips animation because frames do not run there. Reduced-motion preferences remove both animations: the cursor jumps to the target and the ripple appears without scaling.

## Components

- **Tab marker**: the document title prefix `[YCoding] ` followed by the page's own title. Marker state lives in the extension-owned overlay host's data attributes, not in text visible to the page beyond the prefix.
- **Agent cursor**: arrow, tip on the action coordinates, with a label chip reading `YCoding · Click`, `YCoding · Type`, or `YCoding · Scroll`. No label appears for actions without a target.
- **Toolbar badge**: the text `ON` on `badge-on` for each tab with an attached debugger.
- **Popup help**: native details, collapsed by default, with a 34px summary (44px for coarse pointers), muted text, owned plus/minus marker, pointer cursor and the control focus ring. Keep pairing scope and review requirements visible before Connect; place secondary debugger guidance in help. Use border/surface scrollbar roles, no overflow anchoring, focus-colored caret and text selection, and no tap highlight.

## Accessibility

Each signal carries text: the title prefix, the label words, and the badge text. The marker updates the document title, which assistive technology reads as part of the page name; this is intended disclosure that automation is active. The label chip's white text on the label color exceeds 7:1. The cursor is presentational and never receives focus.

## Verification

X1 to X6: `bun test` in `extensions/chrome` (service-worker fixture case) and the real Chrome for Testing suite `bun test test-integration/browser-owned-chrome.test.ts` from `packages/server`, which needs `YCODING_TEST_ISOLATED_BROWSER_CHROME`. X7: `bun test test/design-md.test.js` from `extensions/chrome`, which includes scratch-copy mutation probes in both directions. Lint this file, `../../DESIGN.md`, `../../apps/web/DESIGN.md`, and `../../packages/tui/DESIGN.md` with `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint <file> --strict`. Native tab-strip pixels, the debugger infobar, and native Cancel are not reproducible in headless Chrome and remain manual checks.

## Maintenance

Read `../../DESIGN.md` and this file before changing any extension appearance. Change the rule first, update `indicator.js` and this file in the same change, run strict lint and the drift test, and obtain approval before altering a color, label, marker prefix, or motion value.

## Do's and Don'ts

- Do keep the existing purple cursor and green badge unless a rule here changes.
- Do fail closed when the marker cannot be shown.
- Don't animate toward a coordinate no action uses, or show typed text in the label.
- Don't add tab groups, favicon changes, or native window focus changes to signal control.

## Exceptions

| Rule | Scope | Reason | Approval | Review date |
| --- | --- | --- | --- | --- |
| R2 | `extensions/chrome/popup.css` | The pairing popup predates this file and keeps its own stylesheet variables; this change does not alter it, so extraction into owned tokens is pending. | pending | 2026-10-29 |
