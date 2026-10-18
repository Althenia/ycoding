---
version: alpha
name: YCoding Meeting Passage
description: Consent-led, page-owned capture and a lifecycle reading sheet for the local Meeting runtime.
surface: web
extends: ../../../DESIGN.md
colors:
  bg: "#ffffff"
  surface: "#f7f9f8"
  raised: "#ffffff"
  text: "#0b0f14"
  muted: "#5c6672"
  border: "#e4e8e6"
  control-border: "#78847e"
  accent: "#0b8550"
  on-accent: "#ffffff"
  success: "#0a7b47"
  warning: "#946200"
  danger: "#c53a3a"
  focus: "#0b8b50"
themes:
  dark:
    colors:
      bg: "#0b1115"
      surface: "#11181d"
      raised: "#151e24"
      text: "#f4f7f6"
      muted: "#99a2ad"
      border: "#263039"
      control-border: "#718278"
      accent: "#4ee29b"
      on-accent: "#04150c"
      success: "#4ee29b"
      warning: "#f7d37c"
      danger: "#ef6f6f"
      focus: "#4ee29b"
typography:
  body:
    fontFamily: Geist, system-ui, -apple-system, Segoe UI, sans-serif
    fontSize: 16px
    lineHeight: 1.65
  mono:
    fontFamily: Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace
  metrics:
    fontSize: 18px
rounded:
  control: 6px
  panel: 14px
spacing:
  small: 4px
  gap: 8px
  padding: 16px
  section: 24px
  large: 32px
controls:
  height: 44px
  wrapped-height: 66px
  focus: 2px
layout:
  content: 1040px
  measure: 70ch
  answer-reserve: 256px
  feedback-reserve: 52px
  dialog: 480px
motion:
  duration:
    quick: 140ms
  easing:
    standard: cubic-bezier(0.2, 0, 0, 1)
breakpoints:
  phone: 768
---

# Meeting Passage design rules

## Overview

Passage is the user-approved direction from the Meeting direct-capture proposal: Start, Live and Review form one lifecycle-led sheet. The page owns capture through Chrome's native tab picker; the authenticated local runtime owns transcription, analysis and finalization. Inherit the root brand directly. Preserve the Capacities YDS neutral tiers, restrained accent and explicit textual state; never unify the web green and TUI blue under root R6.

## Principles

- Foreground transcript reading and retain its anchor across polling.
- Disclose operational details and findings without concealing recovery.
- Render only reported facts; preserve unknown metrics as Unreported.

## Rules

| ID  | Status   | Binding statement                                                                                                                                                                                                                                             | Enforcing check                                             |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| V1  | approved | The view MUST use the documented light/dark tokens and self-hosted canonical Geist faces, NEVER remote resources.                                                                                                                                             | `test/view-design.test.ts`, `test/view.integration.test.ts` |
| V2  | approved | Passage MUST use one 1040px sheet with Setup, Live, Finalizing, Recovery and Review states. Compact runtime reports precede the transcript in Live; summary, proposed actions and open questions precede evidence in Review. Other findings MUST begin collapsed. NEVER retain a cockpit, alternate layout or pairing. | `test/view.integration.test.ts` |
| V3  | approved | Every Start MUST require fresh participant-consent and organizational-policy acknowledgement, with optional microphone independent. Chrome MUST choose the surface and Share tab audio; missing audio MUST release tracks and require re-share.               | `test/view.test.ts`, `test/view.integration.test.ts`        |
| V4  | approved | Controls MUST have 44px targets, visible focus, semantic names, contained Stop-dialog focus and reduced-motion behavior. Reported buffer/backlog/processed values MUST stay visible; absent values and unsupplied lag MUST say Unreported.                    | `test/view-design.test.ts`, `test/view.integration.test.ts` |
| V5  | approved | Absent metrics MUST render Unreported; polling MUST preserve transcript rows, draft text and explicit Follow selection.                                                                                                                                       | `test/view.test.ts`, `test/view.integration.test.ts`        |
| V6  | approved | Capture MUST show a compact sticky REC / Keep this tab open strip with always-visible Stop and leave-warning preview; beforeunload MUST warn while recording. Chrome Stop sharing MUST release tracks and stop capture. Retry failed audio MUST NEVER restart capture. | `test/view.test.ts`, `test/view.integration.test.ts` |
| V7  | approved | Tab playback MUST remain unaffected; microphone MUST NEVER reach speakers. Permission prompt, allowed, denied and blocked states MUST explain site settings and permission ownership per origin including port.                                               | `test/view.test.ts`, `test/view.integration.test.ts`        |
| V8  | approved | Capture MUST send ordered float32LE PCM frames of at most one second, per-source sequence/startMs, bounded backpressure and 5-second heartbeats. Only explicit unaccepted busy responses MAY retry; unknown outcomes MUST stop without replay or auto-resume. | `test/view.test.ts`, `test/view.integration.test.ts`        |
| V9  | approved | Owner settings MUST render only when the page holds the separate owner credential from the native-issued owner link; the fragment MUST clear immediately and the credential MUST stay memory-only. Controls MUST cover only future Ask AI model/variant and knowledge connector bindings, with loading, error/retry, availability and saved states in words. Loaded controls MUST be usable; unavailable saved selections MUST stay visible and unchanged when saving other settings. Ordinary view links MUST NOT show or enable them. Knowledge writes MUST keep YCoding approval; owner controls MUST NOT approve, call tools or control capture. | `test/owner-settings.test.ts`, `test/owner-settings.integration.test.ts`, `test/owner-settings-browser.integration.test.ts` |
| V10 | approved | Finalizing MUST distinguish reported audio stopping from analysis `analyzing`, retaining readable evidence. Recovery MUST retain its warning and Retry during presentation-only review. Rearming, finding decisions and knowledge approvals MUST hand off to YCoding. Never invent completion percentages, elapsed time, failed ranges, pagination or summary/Ask citations. | `test/view.test.ts`, `test/view.integration.test.ts` |
| V11 | approved | Owner settings MUST start collapsed and remain separate from the lifecycle. Diagnostics MUST start collapsed while reported metrics remain visible. Citation navigation MUST mark and focus resident evidence, pause Follow, and explain nonresident evidence. Polling, layout transitions and original/corrected toggles MUST preserve the reader's anchor and unsent draft. | `test/view.integration.test.ts`, `test/owner-settings-browser.integration.test.ts` |

## Colors

Use neutral page and panel tiers with text/muted ink. Primary actions use accent/on-accent; success, warning and danger are foreground status roles with explicit words. Control boundaries use control-border for 3:1 visibility. Theme follows prefers-color-scheme.

## Typography

Use Geist for 16px/1.65 prose, 24px page and 20px section headings; use Geist Mono for 12px metadata and 18px metrics. Transcript uses 18px/1.8. Embed canonical fonts with `bun view/build-fonts.ts` and preserve the SIL notice. System sans supplies unsupported Thai glyphs. Wrap identifiers, not Unreported; runtime metrics wrap at their intrinsic content width to retain readable labels and unknown values.

## Layout

Cap the sheet at 1040px; use 16px insets, 8px intra-group gaps, 24px section and 32px large spacing. Setup uses 2:1 capture/readiness tracks; other states use a compact full-width runtime line with Diagnostics. The sticky recording strip occupies layer 2 at the viewport top; allow its text to wrap without covering Stop. Evidence spans the sheet. Live summary/Ask and Review summary/questions use equal tracks; Review actions span the sheet, followed by Ask and terminal handoff. Owner settings spans the sheet as a collapsed disclosure below the lifecycle; its select rows wrap and binding rows stack without a second scroll owner. Move existing advisory nodes before evidence only in Review; retain nodes, focus and reader anchor. Cap prose at 70ch. Keep one document scroll owner. Reserve 256px answer and 52px feedback minima, growing for content. Stop, leave-preview and settings-help dialogs cap at 480px.

## Responsive

At or below the 768px container edge, stack capture, runtime, evidence and advisory while live; Review keeps advisory before evidence. Stack actions full-width, retain 44px targets and allow two-line recovery labels to grow to 66px. Keep draft/source choice/rows through resize. At 1024/1440 retain the capped sheet and its two-track capture/advisory groups. Check 320px reflow and 200% text resize; preserve browser zoom and no hidden recovery.

## Shapes

Use 6px controls, 14px evidence panels, 1px control-border boundaries, 3px warning/source rules and 2px focus with 2px offset. Selects use base-select for the field and picker, the same control radius, border, height and focus roles, no user-agent arrow, and an owned CSS chevron in muted ink. Picker surfaces use raised/text, selected options use accent/on-accent, and focused options retain the focus ring; forced-colors restores system select rendering. Keep opaque tonal content, no glass, gradients or shadows; dialog backdrop uses surface at 0.92 opacity. Own 44px checkbox hit targets with native accessible inputs, accent fill and 20px visible boxes.

## Motion

Use a 140ms standard opacity entrance for the Stop dialog; close immediately, preserving native focus return. Reduced motion removes animation. REC is static; polling/countdown update facts without ambient animation.

## Mark

Render the canonical Y mark at 32px in the header. Embed its exact SVG source; never redraw or recolor it.

## Components

| Component      | Anatomy and tokens                                                                                                    | Behavior                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Header         | Y mark, meeting title, status and Setup/Live/Finalizing/Review stage labels; text/bg/border | Current stage has words and underline; Recovery marks Finalizing as needing attention |
| CaptureGate    | Participant consent, policy acknowledgement, optional microphone, Start and local feedback; text/surface/accent/focus | Fresh checks per attempt; no pairing; cancelled picker/no audio recover without recording         |
| OwnershipStrip | REC words, Keep this tab open, Stop and leave preview; warning/surface/text | Sticky during recording; closing or reloading stops recording; preview is not the browser prompt |
| RuntimeStrip   | Health/sources, exposed metrics and collapsed Diagnostics; mono/muted | Use reported audio.bufferedSeconds/backlog/processedSeconds only; never invent rates or lag |
| Transcript     | ID, source, timestamp, settlement and text; body/mono/border                                                          | Keyed rows update in place; Follow and original/corrected toggle retain selection                 |
| Analysis       | Latest summary, Review actions/questions and collapsed remaining findings; surface/text | Only finding-provided evidence refs are navigable; no approvals or knowledge-write controls |
| Finalization   | Audio/analysis stage words and transcript; warning/surface/text | Audio follows stopping; analysis follows analyzing; no timer or inferred progress |
| Handoff        | Terminal guidance and command text; surface/text/mono | Review retained evidence changes presentation only; rearm and approval stay in YCoding |
| AskPanel       | Advisory scope, latest-50 history, field, submit/retry and feedback; surface/text/control roles                       | One pending request, at most 2000 characters, preserve draft/history; no tools/actions or overlay |
| OwnerSettings  | Ask AI model/variant selects, connector toggle, binding rows with per-binding toggle/remove, add-binding selects, save and feedback; surface/text/control roles | Owner link only; inventory names and availability from the runtime; one save pending at a time; failed save retains edits; reload requires reopening the owner link |
| Feedback       | connection alert, action status, recovery; danger/warning/success                                                     | Unauthorized blocks API controls; failed audio retry never starts capture                         |

## Accessibility

Use headings, labelled forms, native details/dialog, Skip to transcript, polite compact status and actionable alerts. Do not announce the entire accumulating transcript. Own focus, selection, caret, cursor, details markers, disabled states and backdrop. Scrollbars use a 12px base on both pointer classes, bg tracks and control-border thumbs with 4px bg borders; fine-pointer hover narrows that border to 2px. Picker scrollbars use control-border and raised. Forced colors retains system rendering.

## Verification

Run `bun test test/view.test.ts test/view-design.test.ts`, strict design lint, CSS audit and package typecheck. Run `test/view.integration.test.ts` with YCODING_TEST_ISOLATED_BROWSER_CHROME for real page-owned capture/bridge/Chrome flows and light/dark renders at 1440/1024/390. Run `test/owner-settings-browser.integration.test.ts` the same way for owner-link, ordinary-link, saving, error and responsive settings flows. Check fresh consent, audio delivered, track end, no audio, mic denied, Stop confirmation, inference retry, Ask, unauthorized key, reader/draft continuity, keyboard/focus/reduced motion. Mutation-probe palette/type/layout drift. Provider doubles prove integration, not real speech accuracy; CDP track stop proves the browser track-end boundary, not native infobar pixels.

## Maintenance

Read this file and its inherited root before edits; update rules and code in the same change, run strict lint and the repo-local drift test, and obtain approval before changing design values. Regenerate embedded fonts only through `view/build-fonts.ts`; preserve canonical assets and unrelated work.

## Exceptions

| Rule | Scope                | Reason                                                                                                             | Approval | Review date |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- | ----------- |
| R6   | Meeting action color | Keep approved web green roles and the pending root web-green/TUI-blue exception; canonical mark remains unchanged. | approved | 2026-10-29  |
