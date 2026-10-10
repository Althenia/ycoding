---
version: alpha
name: YCoding Meeting Telemetry
description: Metrics-visible operations cockpit for the authenticated local Meeting runtime.
surface: web
extends: ../DESIGN.md
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
  gap: 8px
  padding: 16px
controls:
  height: 44px
  focus: 2px
layout:
  content: 1600px
  operations: 272px
  insights: 300px
  dialog: 480px
motion:
  duration:
    quick: 140ms
  easing:
    standard: cubic-bezier(0.2, 0, 0, 1)
breakpoints:
  phone: 768
---

# Meeting Telemetry design rules

## Overview

Telemetry is the selected Meeting live-page composition: a three-column Console cockpit with a dense operations rail and always-visible reported processing metrics, central transcript, and summary/findings plus live advisory Ask AI in the right column. Inherit the Meeting capture rules and root brand through `../DESIGN.md`; native popup sizing and palette remain companion-specific. This web surface owns its semantic light/dark roles. Execution, consent and capture start remain runtime/Chrome owned.

## Principles

- Foreground transcript reading and retain its anchor across polling.
- Disclose operational details and findings without concealing recovery.
- Render only reported facts; preserve unknown metrics as Unreported.

## Rules

| ID  | Status   | Binding statement                                                                                                                                                                                                                          | Enforcing check                                             |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| V1  | approved | The view MUST use the documented light/dark tokens and self-hosted canonical Geist faces, NEVER remote resources.                                                                                                                          | `test/view-design.test.ts`, `test/view.integration.test.ts` |
| V2  | approved | The page MUST use three desktop tracks: metrics-visible operations, central transcript, insights plus live Ask AI. Phone MUST place operations before transcript and insights; findings MUST begin collapsed.                              | `test/view.integration.test.ts`                             |
| V3  | approved | Recording MUST start only from Chrome consent and Start; the page MUST expose only pair, stop and failed-audio retry controls.                                                                                                             | `test/view.test.ts`, `test/view.integration.test.ts`        |
| V4  | approved | Controls MUST have 44px targets, visible focus, semantic names, contained Stop-dialog focus and reduced-motion behavior. Reported buffer/backlog/processed values MUST stay visible; absent values and unsupplied lag MUST say Unreported. | `test/view-design.test.ts`, `test/view.integration.test.ts` |
| V5  | approved | Absent metrics MUST render Unreported; polling MUST preserve transcript rows, draft text and explicit Follow selection.                                                                                                                    | `test/view.test.ts`, `test/view.integration.test.ts`        |

## Colors

Use neutral page and panel tiers with text/muted ink. Primary actions use accent/on-accent; success, warning and danger are foreground status roles with explicit words. Control boundaries use control-border for 3:1 visibility. Theme follows prefers-color-scheme.

## Typography

Use Geist for prose and Geist Mono for metadata, timestamps, bridge address, pairing code and 18px metric values. Embed canonical font data with `bun view/build-fonts.ts`; preserve the SIL notice in the embedded asset. System sans supplies unsupported Thai glyphs. Body is 16px/1.65; segment text uses 18px; compact metadata uses 12px. Metric typography fits the Unreported word without breaking it across letters in the 272px operations track.

## Layout

Use a 1600px maximum cockpit with 16px gutters/gaps. Desktop tracks are 272px operations, flexible transcript and 300px insights/chat. Operations stays visible with health/sources, a two-column processing metric grid, Model details, Chrome guidance, pairing and recovery. Model/device/provider stay in disclosure; metric values never do. Keep one document scroll owner, no independent transcript scroll pane. Stop confirmation uses a 480px maximum named dialog. Reserve control/chat feedback and initial chat-history geometry; retain resident rows and drafts during polling.

## Responsive

Below 768px stack operations, transcript and insights/chat in that order with intact 44px controls and metrics exposed. Keep Stop and status in header flow. At 1024 and 1440 use the three cockpit tracks. Wrap long IDs, pairing codes and source labels; never scale a desktop frame. Preserve native browser zoom; minimum checked width is 390px. Recovery stays outside disclosure, without a rail collapse control.

## Shapes

Use 6px control and 14px panel corners, strong control boundaries and neutral panel rules. Keep borders-only depth; dialog backdrop uses the surface tier.

## Motion

Use a 140ms standard opacity entrance for the Stop dialog; close immediately, preserving native focus return. Reduced motion removes animation. REC is static; polling/countdown update facts without ambient animation.

## Mark

Render the canonical Y mark at 32px in the header. Embed its exact SVG source; never redraw or recolor it.

## Components

| Component      | Anatomy and tokens                                                                                                         | Behavior                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header         | Y mark, meeting title, status, Stop; text/bg/border                                                                        | Stop confirms; recording has REC words                                                                                                                |
| OperationsRail | Runtime health/sources, exposed metrics, model details, Chrome guidance, pairing and recovery; surface/muted/layout tracks | Metrics/recovery stay outside disclosure; use runtime audio.bufferedSeconds, audio.backlog and audio.processedSeconds only; never invent rates or lag |
| Pairing        | bridge, one-use code, countdown, Copy and New pairing code; mono/control tokens                                            | Expired Copy disabled with explanation; absence is not claimed paired                                                                                 |
| Transcript     | ID, source, timestamp, settlement and text; body/mono/border                                                               | Keyed rows update in place; Follow and original/corrected toggle retain selection                                                                     |
| Analysis       | latest summary and collapsed findings; surface/text                                                                        | Status and evidence refs shown; no approvals or knowledge controls                                                                                    |
| AskPanel       | Advisory scope, history, field, submit/retry and feedback; surface/text/control roles                                      | Always in insights column, one request pending, retain draft/history; no overlay or close control                                                     |
| Feedback       | connection alert, action status, recovery; danger/warning/success                                                          | Unauthorized blocks API controls; failed audio retry never starts capture                                                                             |

## Accessibility

Use headings, labelled forms, native details/dialog, Skip to transcript, polite compact status and actionable alerts. Do not announce the entire accumulating transcript. Own focus, selection, caret, cursor, details markers, disabled states, backdrop and fine-pointer scrollbars. Forced colors retains system rendering.

## Verification

Run `bun test test/view.test.ts test/view-design.test.ts`, strict design lint and package typecheck. Run `test/view.integration.test.ts` with YCODING_TEST_ISOLATED_BROWSER_CHROME for real bridge/Chrome flows in light/dark at 1440/1024/390, including visible reported/Unreported metrics, operations-first phone order and preserved rows/drafts. Compare documented palette/layout tokens in both directions and mutation-probe drift. Capture all three widths. Browser doubles cover provider boundaries, not real inference or model quality.

## Maintenance

Read this file and its inherited root before edits; update rules and code in the same change, run strict lint and the repo-local drift test, and obtain approval before changing design values. Regenerate embedded fonts only through `view/build-fonts.ts`; preserve canonical assets and unrelated work.
