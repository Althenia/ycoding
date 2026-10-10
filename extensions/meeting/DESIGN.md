---
version: alpha
name: YCoding Meet capture companion
description: Explicit consent, authenticated local pairing, capture state and stop controls for the unpacked meeting companion.
surface: native
extends: ../../DESIGN.md
colors:
  background: "#ffffff"
  surface: "#f7f8fa"
  border: "#dadde2"
  text: "#1e2024"
  muted: "#525862"
  button: "#ebedf0"
  button-hover: "#dee2e8"
  connected: "#145e36"
  connected-bg: "#e1f3e7"
  offline: "#505b6b"
  offline-bg: "#e9edf3"
  focus: "#1764b2"
  badge-on: "#28753e"
themes:
  dark:
    colors:
      background: "#17191d"
      surface: "#22252a"
      border: "#3c424a"
      text: "#f2f3f5"
      muted: "#bac0c9"
      button: "#353a42"
      button-hover: "#454c55"
      connected: "#99e0ad"
      connected-bg: "#193524"
      offline: "#d0d6df"
      offline-bg: "#323841"
      focus: "#a9d0ff"
typography:
  body:
    fontFamily: Geist, system-ui, -apple-system, Segoe UI, sans-serif
    fontSize: 13px
    lineHeight: 1.45
  mono:
    fontFamily: Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace
rounded:
  control: 8px
  card: 14px
spacing:
  gap: 8px
  padding: 12px
controls:
  height: 34px
  focus: 2px
layout:
  width: 320px
---

# YCoding Meet capture companion

## Overview

The separate opt-in MV3 companion captures only the selected Google Meet tab after a user presses Start with consent checked. It installs unpacked; it is not part of the existing browser-control extension or release archive. The popup inherits the root identity and reuses the semantic light/dark palette, green badge, typography and control treatment of `../chrome/popup.css` and `../chrome/DESIGN.md`.

## Principles

- Keep pairing and consent explicit; display capture and recovery state in words.
- Keep knowledge, analysis, model configuration and durable execution in the trusted local runtime.
- Stop rather than silently drop audio, resume after restart, or capture another tab.

## Rules

| ID  | Status   | Binding statement                                                                                                                                                                                                                                                                                                                                         | Enforcing check                                                                                                   |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| M1  | approved | Capture MUST require a popup user action on the selected Meet tab, affirmative consent and a separate optional microphone choice.                                                                                                                                                                                                                         | `test/capture-coordinator.test.js`, `test/capture-popup.test.js`                                                  |
| M2  | approved | The popup MUST show textual Checking, Not paired, Ready, Starting, Capturing, Reconnecting, Stopping and Error states; active capture MUST show a REC badge and an always-visible Stop control.                                                                                                                                                           | `test/capture-popup.test.js`, `test/capture-coordinator.test.js`                                                  |
| M3  | approved | Controls MUST have explicit labels, visible focus and 34px targets (44px for coarse pointers); the status region MUST announce updates without replacing keyboard focus.                                                                                                                                                                                  | `test/capture-design.test.js`, `test/chrome.integration.test.ts`                                                  |
| M4  | approved | The popup MUST use the documented semantic colors in both themes and self-hosted canonical Geist fonts; it MUST NEVER request remote fonts.                                                                                                                                                                                                               | `test/capture-design.test.js`                                                                                     |
| M5  | approved | Microphone audio MUST NEVER reach playback; tab audio MUST retain playback. Capture help MUST advise headphones, explain echo cancellation and describe arming with `ycoding meeting` or `/meeting start`; consent and optional microphone choice MUST remain outside help.                                                                               | `test/capture.test.js`, `test/capture-design.test.js`, `test/capture-popup.test.js`                               |
| M6  | approved | Queue overflow, expired pairing, failed retries and restart MUST show an actionable error and MUST NEVER auto-resume.                                                                                                                                                                                                                                     | `test/capture.test.js`, `test/capture-coordinator.test.js`, `test/capture-popup.test.js`                          |
| M7  | approved | The native popup MUST open at 320 CSS px, render the canonical icon at 24px beside its heading, and keep both unpaired and Ready views within 420 CSS px height with help collapsed. Secondary guidance MUST remain available through keyboard-operable help; consent and Stop MUST remain outside it. Toolbar icons MUST use canonical generated assets. | `test/chrome.integration.test.ts`, `test/capture-design.test.js`                                                  |
| M9  | approved | The popup MUST NEVER request microphone access itself. When microphone capture is chosen without a granted permission, Start MUST NOT begin recording; it MUST open the extension microphone access page instead. That page MUST explain a refused request and offer Chrome site settings.                                                                | `test/capture-popup.test.js`, `test/capture-microphone.test.js`, `test/chrome.integration.test.ts`                |
| M8  | approved | The toolbar and extension-list icon MUST use the branded microphone, distinct in shape from the browser-control Y. Both popup headers and the browser-control launcher MUST retain the canonical Y. All Meeting icon sizes MUST be generated from the owned SVG and packaged by the companion build.                                                      | `test/capture-design.test.js`, `test/chrome.integration.test.ts`, `packages/simulation/test/brand-assets.test.ts` |

## Colors

Use the existing Chrome popup semantic palette without near-match colors. `connected` and `connected-bg` identify active capture; `offline` and `offline-bg` identify ready, recovery and failure states alongside text. Native REC uses `badge-on`; native error uses the light `offline` role. Dark overrides retain the same meanings. Focus, selection, checkbox fill and caret use `focus` or `connected`; forced-colors uses system rendering.

## Typography

Use Geist for prose and Geist Mono for the local service URL and pairing code. Build copies canonical fonts and their license from `assets/brand/fonts`; no dependency or remote font is needed. Body and text inputs are 13px/1.45; the heading is 15px. Native toolbar badge typography remains browser-owned under root R9.

## Layout

Use a 320px intrinsic popup width, 12px outer and card padding, a 24px canonical heading icon with an 8px gap, and 8px form gaps. Do not clamp intrinsic popup sizing with viewport units. Keep compact state labels separate from wrapping recovery text, retain Stop in document flow, and preserve keyboard access when vertical scrolling is needed. Own scrollbars with border/thumb and surface/track roles, disable overflow anchoring, and retain browser zoom.

## Responsive

Reflow controls and prose at 320 CSS px and 200% zoom. Use full-width controls and no fixed-height card. Action targets are at least 34px, increasing to 44px for coarse pointers.

## Shapes

Controls use an 8px radius and a 1px `muted` border for distinguishable boundaries; cards use a 14px radius and 1px `border` rule. Focus uses a 2px ring with 2px offset.

## Motion

State changes have no animation; reduced-motion preserves the same still state.

## Icons

Use `assets/brand/ycoding-meeting-icon.svg` for launcher assets, not popup headers. Its 256-unit grid has a 48-unit corner radius, a 2-unit Rule outline, a Trace capsule from x=96 to 160 and y=48 to 144, and a Frost cradle/stand with 16-unit rounded strokes. The cradle spans x=72 to 184; the base spans x=104 to 152 at y=208. The microphone fits within x=64..192 and y=48..216; strokes remain at least 1px at the 16px toolbar size. Keep the shape still and the existing REC state badge independent from the icon. Generate 16/32/48/128px PNGs with the root brand command; copy them through `companion/build.js`.

## Components

- Header: canonical generated icon rendered at 24px, 8px icon radius, 15px heading, 8px gap and 12px bottom spacing, matching the browser-control popup.
- Connection card: one shared surface for status, pairing or capture controls, and recovery. Pairing and consent forms must not introduce nested cards.
- Pairing form: labelled local address and one-use secret input; submit clears the code immediately. Explain that capture has a separate pairing from browser control.
- Consent form: owned checkbox rows for recording consent and optional microphone; keep explanatory paragraphs in collapsed Capture help.
- Capture status: compact inline-flex pill with 20px radius, 4px/8px padding, an 8px current-color dot and 8px gap. Keep the short state label in its polite live region and actionable recovery in the separate alert; secrets never appear in either.
- Start and Stop: full-width buttons, semantic hover/focus/disabled states, no hidden-on-hover action; Stop also has the keyboard command configured in `companion/manifest.json`.
- Capture actions: keep Start and Stop in a surface-colored sticky action group at the bottom of the visible form. Separate Forget pairing with a border rule. Reflect active source choices on reopen, clear consent after capture ends, and reject status replies from before a newer action.
- Pending and failed reads: disable pairing during the first Checking state, keep one status request in flight, and expose service-unavailable recovery rather than an unverified Not paired state. Retain local permission/action failures until a new action; a successful read may clear a transport failure.
- Microphone access page: a full extension tab reusing the popup header, card, status and primary button treatment, centered by `.access-page`. It requests the microphone once on open, releases it immediately, states the result in a polite status region, and keeps Allow microphone available to retry; after a refused request it reveals a secondary Open Chrome site settings button for a blocked microphone. Opening the tab closes the popup, so the page carries the guidance. Recording still starts only from the popup.
- Help: collapsed native details with a 34px summary (44px for coarse pointers), muted text, owned plus/minus marker, pointer cursor and the control focus ring. Keep headphones, echo cancellation, arming instructions, shortcut and call-closure limitations inside it; never place consent, microphone choice, errors or Stop inside it.
- Backend-stop recovery: preserve the allow-listed `inference_failed` reason through Start settlement and show that speech recognition failed, recording stopped and the transcript so far is saved. Offer Retry failed audio on the live page or `/meeting retry`, then a fresh Start. A stop with no known reason uses `backend_stopped`; never expose raw backend reason text.

## Content

Say what failed and how to recover: select the Meet tab, check consent, allow microphone access, stop before re-pairing, or copy a fresh TUI pairing code. State that connection closure is a conservative hangup signal and can stop internal reconnections; unsupported same-document hangup transitions require explicit Stop.

## Accessibility

Use semantic forms, associated labels, checkbox names, polite status announcements and an alert for user-action errors. Preserve tab order, input focus and browser zoom. Distinguish active and error states by text rather than color. Own cursor, selection, caret, scrollbars, checkboxes and disabled states; forced-colors retains native system rendering.

## Verification

Run `bun test --cwd extensions/meeting test/capture*.test.js` for M1–M6. `test/capture-design.test.js` compares palette and theme tokens in both directions and mutation-probes missing, extra and changed values. Run `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint extensions/meeting/DESIGN.md --strict`. Capture doubles prove lifecycle decisions, not actual Chrome audio or Meet hangup. Verify real playback, microphone permission, hangup, stop, badge, focus, zoom and theme renders with an installed unpacked build.

Run `bun run --cwd extensions/meeting test:integration:chrome` with `YCODING_TEST_ISOLATED_BROWSER_CHROME` pointing to installed Chrome for Testing. M7 measures the native popup opened by `Extensions.triggerAction` and confirms its popup view type; loading `popup.html` in an ordinary tab does not prove popup autosizing. Ordinary extension-page rendering separately covers 320px reflow. Both themes, canonical image loading, keyboard field navigation, and control geometry are checked. Real capture uses a controlled audio fixture and retains the installed companion's permissions and consent boundary. This headless suite does not prove native toolbar pixels or acoustic output.

## Maintenance

Read this file, `../../DESIGN.md` and `../chrome/DESIGN.md` before UI changes. Update the rule first and code/tests in the same change; run strict lint and the drift test. Obtain approval before changing the inherited palette or typography. Keep installation independent from the current Chrome extension and release packaging.
