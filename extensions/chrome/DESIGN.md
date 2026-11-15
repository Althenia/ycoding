---
version: alpha
name: YCoding Chrome control indicators
description: Tab favicon logo marker and toolbar badge that show which Chrome tabs YCoding is controlling.
surface: native
extends: ../../DESIGN.md
colors:
  badge-on: "#28753e"
  agent-mark: "#67d7a4"
typography:
  popup-body:
    fontFamily: Geist, system-ui, -apple-system, Segoe UI, sans-serif
    fontSize: 13px
    lineHeight: 1.45
  popup-mono:
    fontFamily: Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace
components:
  toolbar-badge:
    backgroundColor: "{colors.badge-on}"
layout:
  popup-width: 320px
spacing:
  popup-padding: 12px
controls:
  popup-height: 34px
---

# YCoding Chrome control indicators

## Overview

The Chrome extension marks every tab YCoding is controlling so the person using Chrome can see it: the YCoding logo as the tab favicon in the tab strip and a per-tab toolbar badge. The extension shows no visible in-page control indicator. Chrome's native debugger infobar is separate, owned by Chrome, and cannot be restyled. The extension popup is a separate pre-existing surface (see Exceptions). Sources: `docs/browser-extension.md`, `extensions/chrome/indicator.js`, `extensions/chrome/service-worker.js`.

## Principles

- Show control where the user already looks: the tab strip first, then the toolbar. The tab strip carries the real YCoding logo as the favicon; the badge carries a word (`extensions/chrome/indicator.js`).
- Carry no private text. The marker is a static logo image; typed text, Session titles, Session IDs, and URLs never enter the page DOM (`extensions/chrome/indicator.js`).
- Refuse control rather than hide it. When the marker cannot be shown and confirmed on a tab, the extension rejects the operation before dispatch (`extensions/chrome/test/service-worker.test.js`).
- Keep marker lifetimes explicit. The favicon expires in the page. Native group appearance is restored only while current-process ownership remains provable; crash leftovers are not cleaned up after restart.

## Rules

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| X1 | approved | Before any observe or action dispatch, a controlled tab MUST carry the favicon logo marker and the extension MUST confirm it by reading it back; otherwise the operation MUST fail before dispatch and MUST NOT be reported as controlled. | `extensions/chrome/test/service-worker.test.js` |
| X2 | approved | The marker MUST preserve the page's own favicon declarations, including icons the page changes later, MUST NOT alter the page title, and cleanup MUST restore the last page-authored favicon set and remove only the marker link the extension installed. | `extensions/chrome/test/service-worker.test.js` |
| X3 | approved | The marker image MUST be the fixed logo below; the page DOM MUST NEVER receive typed text, Session titles, Session IDs, or URLs, and the extension MUST NOT draw a cursor, label, ripple, or other overlay in the page. | `extensions/chrome/test/service-worker.test.js` |
| X5 | approved | Explicit cleanup MUST complete, bounded in time, before the debugger detaches; when refresh stops, the page MUST remove the marker no later than the documented expiry plus its check interval, and on visibility or resume events. | `extensions/chrome/test/service-worker.test.js`, `packages/server/test-integration/browser-owned-chrome.test.ts` |
| X6 | approved | A pinned tab MUST NEVER be controlled, because its tab-strip presence is only its favicon and the verified marker contract is not established for pinned tabs. | `extensions/chrome/test/service-worker.test.js` |
| X8 | approved | The popup MUST render text in Geist and its local service address and pairing code in Geist Mono, from faces embedded in `popup.css`, and MUST NOT fetch a font or add a font file, permission, or CSP source. | `extensions/chrome/test/popup.test.js`, `extensions/chrome/test/fonts.test.js`, `packages/server/test-integration/browser-owned-chrome.test.ts` |
| X10 | approved | The popup MUST use 320px intrinsic width, 12px outer/card padding, a 24px canonical mark, a 15px heading and 13px body text. Controls MUST be at least 34px (44px for coarse pointers); secondary help MUST remain keyboard accessible, with pairing authority visible before Connect. | `extensions/chrome/test/popup.test.js`, `packages/server/test-integration/browser-owned-chrome.test.ts` |
| X11 | approved | The tab marker MUST be the mint pixel-Y path of `assets/brand/ycoding-mark.svg` (fill `agent-mark`) on a dark rounded tile, installed as the tab favicon through an inline SVG data URL, and MUST NOT add an archive entry, fetch an asset, or use an emoji or a text glyph. | `extensions/chrome/test/indicator.test.js`, `packages/cli/test/chrome-extension-packaging.test.ts` |
| X7 | approved | Documented `colors` MUST equal `extensions/chrome/indicator.js`, with `popup-body` and `popup-mono` equal to the `--font-sans` and `--font-mono` values in `popup.css`, and documented values MUST NOT be missing from or extra to them. | `extensions/chrome/test/design-md.test.js` |
| X12 | approved | A native group control marker MUST use Chrome's `green` group color only when every member is granted to the same Session. Existing groups require an explicit all-member group-control grant. Establishing or restoring group appearance MUST NOT move tabs or operate on active or pinned members. An active ungrouped tab retains favicon-only control. | `extensions/chrome/test/group-marker.test.js`, `extensions/chrome/test/fixtures/service-worker.case.js` |
| X13 | approved | Membership, grant, position, or appearance changes MUST stop group control without overwriting user changes. Normal release MUST restore saved appearance, or ungroup a marker-created singleton, only with unchanged ownership. Native appearance restoration is best effort; a crash may leave a green group. Restart MUST NOT reconstruct cleanup authority from color, title, or persisted metadata. | `extensions/chrome/test/group-marker.test.js` |

## Colors

`badge-on` is the toolbar badge background shown while a tab is controlled. `agent-mark` is the fill of the pixel-Y in the tab favicon. Both are extension-specific roles, not brand palette roles; the root brand file states that surface roles are not a claimed brand-color match.

## Typography

The popup body is 13px, 1.45 line height, Geist, set on `body` because Chrome's extension-page default style sets a system family there and would override one inherited from `:root`; the local service address and pairing code are Geist Mono. Both faces are variable (100-900) and embedded in `popup.css` as data URLs, so the popup needs no network, permission, or CSP source. Native surfaces (the tab title, toolbar badge, and debugger infobar) use Chrome's own font and are outside this rule.

## Layout

Use the popup width, padding and control-height tokens for the popup and its card. Keep the 13px body text; use a 15px heading, 24px mark, 8px heading gap and 12px bottom spacing. Use 8px paragraph/form spacing, 4px/8px status-pill padding, and 10px secondary-action separation. Keep the connected view within 300px height with help collapsed. Reflow within 320 CSS px without clipping, retain browser zoom, and increase control and help-summary targets to 44px for coarse pointers.

## Components

- **Tab marker**: the YCoding logo installed as the tab favicon (inline SVG data URL: mint pixel-Y on a dark rounded tile), replacing the page's favicon links while controlled and restoring them on cleanup or expiry. The page title is never altered.
- **Agent mark**: the mint pixel-Y from `assets/brand/ycoding-mark.svg`, drawn in `agent-mark` on the favicon tile.
- **Toolbar badge**: the text `ON` on `badge-on` for each tab with an attached debugger.
- **Native group marker**: Chrome's named `green` color, retaining the group's title and collapsed state. Chrome owns the palette and native rendering; the favicon and debugger infobar retain non-color control cues.
- **Popup help**: native details, collapsed by default, with a 34px summary (44px for coarse pointers), muted text, owned plus/minus marker, pointer cursor and the control focus ring. Keep pairing scope and review requirements visible before Connect; place secondary debugger guidance in help. Use border/surface scrollbar roles, no overflow anchoring, focus-colored caret and text selection, and no tap highlight.

## Accessibility

The badge carries text; the favicon logo is a visual signal paired with Chrome's native debugger infobar, which names YCoding while attached. The extension shows no visible in-page control indicator.

## Verification

X1 to X6 and X11: `bun test` in `extensions/chrome` (service-worker fixture case) and the real Chrome for Testing suite `bun test test-integration/browser-owned-chrome.test.ts` from `packages/server`, which needs `YCODING_TEST_ISOLATED_BROWSER_CHROME`; X11 also runs `bun test --cwd packages/cli test/chrome-extension-packaging.test.ts` against the bundled worker. X7: `bun test test/design-md.test.js` from `extensions/chrome`, which includes scratch-copy mutation probes in both directions. Lint this file, `../../DESIGN.md`, `../../apps/web/DESIGN.md`, and `../../packages/tui/DESIGN.md` with `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint <file> --strict`. Native tab-strip pixels, the debugger infobar, and native Cancel are not reproducible in headless Chrome and remain manual checks.

## Maintenance

Read `../../DESIGN.md` and this file before changing any extension appearance. Change the rule first, update `indicator.js` and this file in the same change, run strict lint and the drift test, and obtain approval before altering a color, marker glyph, or mark.

## Do's and Don'ts

- Do keep the green badge unless a rule here changes.
- Do fail closed when the marker cannot be shown.
- Don't draw a cursor, label, ripple, or any other element in the controlled page.
- Don't focus windows or move tabs to establish control. Change native group appearance only within X12 and X13; retain the favicon marker in X11.
- Don't replace the tab favicon logo with an emoji, a text glyph, or a fetched or packaged image.

## Exceptions

| Rule | Scope | Reason | Approval | Review date |
| --- | --- | --- | --- | --- |
| R2 | `extensions/chrome/popup.css` | The pairing popup predates this file and keeps its own stylesheet variables; this change does not alter it, so extraction into owned tokens is pending. | pending | 2026-10-29 |
