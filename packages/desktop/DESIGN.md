---
version: alpha
name: YCoding Desktop
description: A centered working conversation with quiet execution detail and proportionate Session coordination.
surface: web
extends: ../../DESIGN.md
colors:
  primary: "#67D7A4"
  brand-trace: "#67D7A4"
  brand-frost: "#F2F3F5"
  brand-attention: "#F0BE62"
  brand-tile: "#24282F"
  brand-rule: "#3A404A"
  bg: "#0B1115"
  surface: "#11181D"
  surface-raised: "#151E24"
  surface-sunken: "#0E151A"
  surface-overlay: "#151E24"
  text: "#F4F7F6"
  text-muted: "#99A2AD"
  text-subtle: "#99A2AD"
  border: "#263039"
  border-strong: "#3A4652"
  green: "#67D7A4"
  primary-bg: "#67D7A4"
  primary-fg: "#0B1115"
  focus: "#67D7A4"
  yellow: "#F0BE62"
  yellow-strong: "#F0BE62"
  danger: "#EF6F6F"
  info: "#79B8FF"
  info-strong: "#79B8FF"
  violet-strong: "#C4B5FD"
  teal-strong: "#67E3F9"
  meter-warn: "#F0BE62"
themes:
  light:
    colors:
      primary: "#0A7B47"
      brand-trace: "#67D7A4"
      brand-frost: "#F2F3F5"
      brand-attention: "#F0BE62"
      brand-tile: "#24282F"
      brand-rule: "#3A404A"
      bg: "#FFFFFF"
      surface: "#F7F9F8"
      surface-raised: "#FFFFFF"
      surface-sunken: "#EFF3F1"
      surface-overlay: "#FFFFFF"
      text: "#0B0F14"
      text-muted: "#5C6672"
      text-subtle: "#646D78"
      border: "#E4E8E6"
      border-strong: "#78847E"
      green: "#27D17F"
      primary-bg: "#0B8550"
      primary-fg: "#FFFFFF"
      focus: "#0B8B50"
      yellow: "#F4BD3D"
      yellow-strong: "#946200"
      danger: "#C53A3A"
      info: "#175CD3"
      info-strong: "#175CD3"
      violet-strong: "#6938EF"
      teal-strong: "#0E7090"
      meter-warn: "#D97706"
  high-contrast-light:
    colors:
      info: "#0A3D91"
      info-strong: "#0A3D91"
      violet-strong: "#4A1FB8"
      teal-strong: "#0B4F66"
      meter-warn: "#8A4B00"
  high-contrast-dark:
    colors:
      info: "#A5E0FF"
      info-strong: "#A5E0FF"
      violet-strong: "#DDD2FF"
      teal-strong: "#A5F0FC"
      meter-warn: "#FFB74D"
typography:
  body:
    fontFamily: "Geist"
    fontSize: "13px"
    lineHeight: "20px"
  mono:
    fontFamily: "JetBrains Mono"
    fontSize: "12px"
    lineHeight: "18px"
controls:
  height-xs: "24px"
  height-dense: "28px"
  height-sm: "32px"
  height-md: "40px"
  height-touch: "44px"
  height-lg: "48px"
rounded:
  sm: "3px"
  md: "4px"
  lg: "4px"
  xl: "6px"
  2xl: "8px"
layout:
  conversation-max: "1024px"
  rail: "256px"
  rail-compact: "64px"
  companion: "320px"
  header: "40px"
  system-header: "48px"
  workspace-inspector: "420px"
  project-inspector: "400px"
  diff-files: "340px"
  session-diff-unified-files: "240px"
  session-diff-split-files: "220px"
  diff-header: "57px"
  team-inspector: "320px"
  session-toolbar: "40px"
  team-toolbar: "40px"
  project-toolbar: "44px"
  workspace-toolbar: "48px"
  coordination-toolbar: "56px"
  dialog-header: "40px"
motion:
  duration:
    instant: "80ms"
    quick: "140ms"
    base: "220ms"
    slow: "320ms"
  easing:
    standard: "cubic-bezier(0.2, 0, 0, 1)"
    entrance: "cubic-bezier(0, 0, 0.2, 1)"
    exit: "cubic-bezier(0.4, 0, 1, 1)"
---

# Desktop design

## Overview

Revision r8 governs the Desktop conversation, composer, navigation and Project coordination for 0.11.7 local testing. The annotated conversation, composer-footer and Coordination images establish the corrected placement and full-height structure. Implementation and native verification remain separate gates. The brand parent is `../../DESIGN.md`; `.stitch/DESIGN.md` records the source-comparison boundary. Web rules and implementations are unchanged.

Stitch project `5038403086787961002` supplies 57 approved Desktop references. Conversation Idle `7dc0aa9f1fbd49e089d42fa98d994bef` shows an open conversation, grouped execution detail, a composer on the conversation axis, and an independent companion. Its HTML explicitly declares a 256px navigation rail and blue-black body surfaces; its theme configuration also contains different Material palette roles. Projects `9121b2a17ffb4d81a7f021e6325329f4` declares the blue-black palette, Geist and JetBrains Mono, a project inventory, and a separate members/workflow inspector. Their illustrations do not establish backend capabilities. Current Desktop instructions govern the centered populated layout, quieter activity hierarchy, reduced boxing and natural list height where they differ from these references.

## Principles

- Make user messages, substantive responses and final results the reading path. Put intermediate execution within that path without making it the dominant furniture.
- Center the useful conversation and composer together. Give both sides deliberate, modest space rather than parking content on the left of a blank pane.
- Use typography, spacing, semantic ink and surface tone before borders. Preserve boundaries that explain an input, floating layer, pending decision or danger.
- Keep information, provenance, keyboard actions, drafts, reported state and confirmation boundaries intact.
- Animate a change of state, not every incoming token. Keep the reading anchor and input responsive.

## Rules

| ID | Status | Binding statement | Enforcing check |
|---|---|---|---|
| D1 | approved | Startup and reconnect MUST retain the saved shared-backend and managed-local flows, genuine loading and failure states, revision fences and explicit retry; unavailable reads MUST NEVER become successful empty results. | `test/renderer.test.tsx` |
| D2 | approved | Assistant headers, Thought and tool disclosures, Shell-finished cards, Step provenance, user bubbles, assistant markdown and right-side duration/chevron controls MUST share the composer's centered outer track. Wide-window maximum width MUST be 960–1040px with margin-inline:auto; compact gutters MUST remain symmetric. Prose MUST NOT introduce a second narrowed track. Floating scroll and zoom controls MUST remain outside the track without overlapping content or shifting its bounds. | `test/renderer.integration.test.ts`; `SCENARIOS.md` |
| D3 | approved | Outer page, pane, transcript, composer shell, action bar, attachments and chips MUST satisfy scrollWidth <= clientWidth in normal and long-content states, collapsed and expanded; composer and near-composer horizontal scrollbars MUST NEVER appear. Word-wrapped code/diffs, prose, paths, labels and tool output MUST fit without a horizontal bar. Diff wrap `none` MUST retain no-wrap behavior with intentional horizontal scrolling ONLY inside a bounded inner diff/code viewport; that inner scroll MUST NEVER widen an outer container. | `test/renderer.integration.test.ts`; review-only native DOM measurements |
| D4 | approved | Width fixes MUST belong to the owning flex/grid track, min-width, wrapping or content layout; hidden clipping, flattened whitespace, removed information and compressed controls MUST NEVER substitute for fitting content. | `test/renderer.integration.test.ts`; review-only source inspection |
| D5 | approved | User messages, assistant prose, actor/model changes and final results MUST each restart prominent provenance. Any nonempty assistant prose, including commentary, MUST remain a boundary. Only consecutive intermediate tool/thought activity by an unchanged agent/model MAY share quiet provenance instead of repeating a prominent badge on every microstep. | `test/renderer.integration.test.ts` |
| D6 | approved | Compact tool/thought groups MUST retain every output, status, error, provenance field, timing, copy/expand control and user action through reachable disclosure; changes of actor/model and errors MUST remain identifiable without color. | `test/renderer.integration.test.ts`; `test/renderer.test.tsx` |
| D7 | approved | Disclosure and navigation MUST retain accessible names, expanded state, keyboard order, visible focus, focus return and screen-reader announcements; collapsed content MUST NOT remain an invisible keyboard target. | `test/renderer.integration.test.ts` |
| D8 | approved | Streaming and refresh MUST preserve stable message/disclosure identities and the reader's attached or detached scroll position; motion MUST NEVER remount unchanged rows, move a detached reader or delay input. | `test/renderer.integration.test.ts` |
| D9 | approved | Transcript, composer, sidebar and surrounding chrome MUST use compact, consistent turn/step/composer spacing, typography and tonal grouping without redundant nested cards or pills; field, focus, structural, pending-decision and destructive boundaries MUST remain where useful. | `test/renderer.integration.test.ts`; review-only render comparison |
| D10 | approved | Action controls MUST use consistent comfortable icon-led size, spacing and alignment, owned non-native hover/focus hints and meaningful semantic ink; needed visible labels and values MUST remain at least 12px. | `test/renderer.integration.test.ts`; `test/ledger-design.test.ts` |
| D11 | approved | Composer model, effort, autonomy, delivery, attachment, Send and Stop controls MUST retain their full behavior, readable values and stable geometry. The metrics/Auto/Send cluster MUST have margin-inline-start:auto before the cluster, an 8–10px Auto-to-Send gap and symmetric 10–12px right/bottom card insets consistent with the left pills; an empty slot MUST NOT separate Auto from Send. Auto remains the send-mode selector, distinct from the policy/autonomy pill. Compact reflow and coarse hit targets MUST remain intact. Unsent and unconfirmed text MUST survive failure and MUST NEVER be resent automatically. | `test/renderer.test.tsx`; `test/renderer.integration.test.ts` |
| D12 | approved | Coordination's Add-existing/New-member sidebar background and left border MUST span the full pane height. Its left main pane MUST be a full-height min-height:0 flex column, with a flex:1 min-height:0 overflow-y:auto member-list region and a concurrency/delegated-decisions footer docked flush to the pane bottom behind a clean top border. Rows MUST retain natural height; sparse lists MUST NOT stretch rows or place the footer immediately below the last row. Compact drill-in MUST retain contained scrolling and reachable footer controls. | `test/renderer.integration.test.ts`; `test/project-members.test.tsx` |
| D13 | approved | Projects MUST retain one Master/member roster, real selection and detail, inline concurrency and distinct Open, Remove from project and Delete Session actions; create/add workflows MUST NOT duplicate that roster. | `test/project-members.test.tsx`; `test/renderer.integration.test.ts` |
| D14 | approved | Motion MUST consume the canonical duration/easing tokens for feedback, transient layers, panel/detail changes and screen/Session continuity; frequent streaming updates MUST remain still and input MUST remain responsive. | `test/ledger-design.test.ts`; `test/renderer.integration.test.ts` |
| D15 | approved | Reduced motion MUST remove spatial travel and smooth scrolling, keep effects at most 150ms and exits immediate, and preserve focus, state and announcements; motion MUST NEVER conceal essential content or cause flicker or a reflow storm. | `test/renderer.integration.test.ts` |
| D16 | approved | Ordinary rail, directory, recent lists and counters MUST show only noncompaction roots; the bounded paginated index MUST retain descendants for real child, fork, BTW and grandchild discovery without promoting off-page children to roots. | `test/root-sessions.test.ts`; `test/renderer.integration.test.ts` |
| D17 | approved | Status MUST derive from reported state, remain named without color and preserve unknown values; counters, filters, pins, metrics and durations MUST NOT invent activity, capacity, allowance or verification. | `test/renderer.test.tsx`; `test/renderer.integration.test.ts` |
| D18 | approved | Settings MUST retain pane-filling section navigation, current values, one labelled keep-awake switch, every keyboard action and chord, and the existing presentation handlers and paste threshold. | `test/keyboard.test.ts`; `test/renderer.integration.test.ts` |
| D19 | approved | Owned palette, fonts, corner sizes, component geometry and motion MUST agree with their documented tokens in both directions, including theme overrides; components MUST consume semantic roles. | `test/ledger-design.test.ts` |
| D20 | approved | Loading, empty, pending, disabled, failure and recovery states MUST retain owned presentation and actual controls; skeletons and compaction progress MUST retain static reduced-motion states. | `test/renderer.test.tsx`; `test/renderer.integration.test.ts` |
| D21 | approved | Dialogs, menus and pickers MUST keep named controls, contained scrolling, genuine errors, confirmation gates and focus return; commands MUST retain modal combobox/listbox behavior and supported actions only. | `test/renderer.integration.test.ts` |
| D22 | approved | Native menus, clipboard, update verification and rollback MUST retain their existing contracts; Enter sends and Shift+Enter inserts a newline only in the existing composer context. | `test/host-contract.test.ts`; `test/updater.test.ts` |
| D23 | approved | Backend ownership, credentials, permissions, pairing, session data and frozen bridge capabilities MUST NOT change through presentation work; the client MUST NEVER answer or approve a pending request automatically. | `test/renderer.test.tsx`; review-only native preservation checks |
| D24 | approved | Browser fixture results MUST NOT stand in for native-window rendering, saved-endpoint readback, crash-free operation or existing populated family navigation. | `SCENARIOS.md`; review-only native verification |
| D25 | approved | Team MUST show reported direct children, blockers and selected-child detail; parent/child actions MUST retain current identities and answer confirmation. | `test/renderer.integration.test.ts` |
| D26 | approved | Coordination MUST distinguish Master, member, owner and driver state without fabricating branches, commits, external-message ingestion or verification. | `test/renderer.integration.test.ts` |
| D27 | approved | The New-chat target chooser MUST overlay its entry, retain registered directory selection, Escape focus return and unsent text, and MUST NOT create or execute a Session from a starter command. | `test/renderer.integration.test.ts` |
| D28 | approved | Usage MUST distinguish available, stale, unauthorized, unavailable and failed reads, with each provider's labelled windows and no invented unlimited quota. | `test/renderer.integration.test.ts` |
| D29 | approved | Guardrail and decision history MUST remain structured, read-only and faithful to recorded fields; missing evidence MUST remain unrecorded. | `test/renderer.integration.test.ts` |
| D30 | approved | Native/transient activity MUST retain actual execution, validated peers and reported bridges; queued input MUST NOT create false execution activity. | `test/renderer.integration.test.ts` |
| D31 | approved | System, browser, incident and context views MUST present returned facts as labelled information with explicit missing fields; secrets MUST remain masked until explicit reveal. | `test/renderer.integration.test.ts` |
| D32 | approved | Component-specific chrome MUST keep the source ownership table's independent toolbar and inspector geometry above the compact boundary; a shared header or companion MUST NOT substitute for those owners. | `test/ledger-design.test.ts`; `test/renderer.integration.test.ts` |
| D33 | approved | Compact navigation and list/detail views MUST use dismissible drawers, overlays or single-pane drill-ins with Back/Close, Escape, preserved drafts/scroll and focus return; coarse controls MUST retain 44px reach and compact/coarse inputs at least 16px. | `test/renderer.integration.test.ts` compact journeys |

## Colors

The documented dark palette uses blue-black canvas and tonal surfaces, light ink and restrained mint, amber, blue, violet and danger roles. Success, running, waiting, failure and unknown state also carry a name or distinct symbol. Light and high-contrast schemes retain their existing roles. No palette change is part of r8.

Conversation Idle has explicit blue-black body declarations alongside incompatible Material theme roles. Other approved sources also differ in palette and shared chrome. **Leave override unapproved** remains the recorded decision; those source conflicts are unwaived. Token consistency is not source precedence or visual acceptance.

## Typography

Use self-hosted Geist for interface prose and JetBrains Mono Regular, Medium and SemiBold for code and metadata. Body text is 13px with 20px leading; metadata has a 12px floor. Prose occupies the same centered track as the surrounding activity and composer without another character-count maximum. Preserve original whitespace and line structure when wrapping code and tool output.

## Layout

The navigation rail and optional Session companion bound the conversation pane. Inside that pane, transcript content and composer use one centered outer track, with a wide-window maximum between 960px and 1040px, margin-inline:auto and equal inline gutters. Wide gutters begin from 24px spacing; compact gutters use 12px. Apply those same outer bounds to assistant identity, disclosures, Shell-finished cards, provenance, user bubbles, markdown and duration/chevron controls. Remove nested prose maxima rather than centering a second narrow block. Measure left and right edges, not just shared centers, after layout settles. Place floating scroll and zoom controls outside the track without covering it or changing its width.

Keep the composer footer compact. Place the flexible spacer before the metrics/autonomy/send cluster, not between Auto and Send. Keep their control-box gap at 8–10px and Send's trailing and bottom card insets at 10–12px, matching the left attachment/model treatment. Reflow controls on compact windows without losing any control or shrinking coarse targets. Tighten turn, activity-step and composer spacing together without removing content or reducing text sizes.

Give every flex/grid child that contains long content a shrinkable track. Wrap paths, labels, tool output and code without destroying their text; keep controls at their readable size and reflow the action row when needed. Neither the composer nor its surrounding dock owns a horizontal scroller. Give each pane one deliberate vertical scroll owner and retain the established attached-reader behavior.

Diff lines retain their original whitespace and existing `Wrap diff lines` control. Stored `word` wraps code within the available width without a horizontal bar. Stored `none` keeps no-wrap lines and intentional horizontal scrolling inside the bounded inner diff/code viewport. Keep that viewport shrinkable and contained; its scroll must not widen the page, pane, transcript or composer. Preserve preference values/defaults, line numbers, content, copy actions, reviewed state and split/unified controls.

Coordination uses a project inventory, one Master/member roster and a separate Add-existing/New-member workflow sidebar. Stretch the sidebar surface and left separator to the pane bottom, independently of its form content. The left main pane fills the same height as a min-height:0 flex column. Its list region takes the remaining space and owns vertical scrolling; the concurrency and Delegated decisions footer stays at the bottom with a top border. Short lists leave open list-region space without stretching rows. Long lists scroll without displacing the footer or forcing the sidebar to grow. Preserve selection, explicit member actions and create/add workflows without dummy rows or duplicated membership.

### Source ownership

| Component | Approved reference | Independent geometry |
|---|---|---|
| Conversation chrome | `7dc0aa9f1fbd49e089d42fa98d994bef` | 256px rail, 40px header/tabs and 320px companion are implemented shared values with unwaived source conflicts |
| Workspaces | `70ca078090f64321b1f264ab4cdc88e2` | 48px toolbar, 420px detail |
| Projects | `9121b2a17ffb4d81a7f021e6325329f4` | 44px toolbar, 400px workflow inspector |
| Sessions | `9715087f99c9431a938a353cb05ca9a9` | 40px toolbar |
| Team | `d870471b750a42df8e17ff0fb5d29e67` | 40px toolbar, 320px selected detail |
| Coordination | `adedc0ab360c471d9996962413cf247d` | 56px toolbar, 320px selected detail |
| Agents & Skills | `37f0351447f34e448556eb9d7b6276c9` | 1080×720 dialog; 48px header; 320px agent and 360px skill tracks |
| Browser | `d584aabe84d942089c45a938ed4d4c8c` | 960×640 dialog, 48px header |
| Status & Debug | `6fc8e392a42b4433a08a7a1564e4b7d3` | 980×650 dialog, 48px header plus 40px tabs |
| Session actions | `6ac6a9dd73b6451fa41dfa46d4d18b8b` | 920×680 dialog, 48px header |
| Git diff | `825f05dcc7724e0fb83ffb3667c0d627` | 1080×720 dialog, 57px border-inclusive header, 340px files |
| Provider connection | `80928cfab4bc4b20b3042c2f089574ef` | 660px width, 44px header |
| Folder chooser | `f4476b36068c4c41adbb0f97a88e33d8` | 580px width, content-height title with 14px vertical padding |
| Prompt stashes / editor / export | `35bf71933d5945eeb63ac9605785664d`, `bf4de94bc265448a87ae20d91c0c5109`, `fea2212a85a649968cdb4852537cec6d` | 740px / 680px / 520px widths, bounded content height |
| Appearance / command palette | `5e357147cdc24647befd44ce514bc8e2`, `309bc47fe0d642a2a9775391b92c1451` | 560px / 640px widths; palette search 48px |
| Captured-file confirmation | `359f63a0638846f6b5f764c0a9e44c38` | 460px width |

The composer recognizes `/btw`, `/btw-send`, `/suggest`, `/prompt`, `/cd`, `/editor`, `/docs`, `/exit` and `/defer` as local commands. Side-chat and prompt-assistance commands open a reviewable dialog with the supplied text; they do not submit that text as an ordinary prompt. `/btw-send` is restricted to a BTW side chat with a parent. `/prompt` from New chat creates a Session only after confirmation and opens prompt assistance without sending a prompt. `/editor` opens the draft through `VISUAL`, then `EDITOR`, using a private temporary file and argument parsing without a shell. Missing or unsuccessful external editors open the owned draft dialog instead. Saving preserves file and agent attachments; an empty edited draft is valid. `/docs` opens the documentation in the external browser. `/exit` confirms before disconnecting and quitting; a failed disconnect prevents quitting.

The autonomy popover and `/defer` toggle persistent deferral without changing Permissions, Guardrails or Answers. `/defer on` and `/defer off` set it explicitly. The chip shows its current state and the action reads Defer on or Defer off. Normal prompts leave deferral enabled; only an explicit off action disables it. The popover keeps a named dialog role, independent category controls, Goal actions and an alert region. Enabling a new YOLO category requires an explicit risk confirmation before applying it; New chat requires the same consent for staged YOLO autonomy before sending.

The reference inventory, aliases and unavailable staged/unstaged VCS scene remain in `test/renderer.integration.test.ts`. Full Session diffs retain their independent 240px unified and 220px split file tracks. Source illustrations never authorize stage, discard, commit or other absent frozen-bridge operations.

## Responsive

Keep the existing 700px compact navigation/drill-in boundary and 1180px companion overlay boundary. At compact widths, put selectors on another composer row rather than shrinking their text. Use contained, content-sized picker sheets, visual viewport geometry and safe-area insets. Keep a named Close/Back action, scrim dismissal and Escape behavior. At 320px the whole page and all named conversation/composer containers still fit horizontally. Native compact checks concern the Desktop renderer in a resized window, not a claim of physical-phone verification.

## Elevation & Depth

Use single-level tonal planes in normal flow and restrained depth for floating layers. Keep useful pane separators, field boundaries and destructive/pending treatments. Remove a redundant wrapper at its owner; never apply blanket border-removal CSS. A disclosure is an interaction, not a reason to put another card around every nested row.

## Shapes

Keep the documented small corner scale and circular status geometry. Use a single composer input boundary rather than nested outlined selector fields. Repeated activity and member rows remain open, aligned content rather than stacked pills.

## Motion

Reuse the canonical shared `--yc-dur-*`, `--yc-ease-*` and `--yc-motion-*` tokens: 80ms feedback, 140ms small changes/exits, 220ms entrances and 320ms slow effects where appropriate. Screen/Session navigation stays within 300ms. Use standard easing for state feedback, entrance easing for entering layers and exit easing for closing layers. Animate transform and opacity; do not tween transcript height, every streaming token, large grids or permanent layout widths.

Keep the shell, composer and stable message rows mounted through navigation and refresh. Panel and disclosure state changes retain focus and the reading anchor. Start closing behavior immediately and remove a floating layer when its actual exit finishes; interruption must leave a usable final state. Essential content remains visible at rest. No new motion framework or dependency is needed.

One global reduced-motion mapping removes spatial travel and smooth scroll, limits effect fades to 150ms or less and makes exits immediate. Reduced motion preserves feedback, expanded state, focus visibility and announcements. Verify normal and reduced motion during streaming, disclosure, navigation and member selection; a stationary screenshot alone proves none of those transitions.

## Icons

Use the owned 24-unit SVG registry, 1.6-unit rounded currentColor strokes and 16px inline icons. Model, effort, policy, delivery, attachment and execution controls keep meaningful symbols, consistent alignment and readable values. Running, waiting, failed, idle and unknown states keep distinct glyphs and names. Dense actions expose owned non-native hover/focus hints; coarse actions keep 44px reach. Do not replace user-facing names with unexplained icons or native title tooltips.

## Components

### Populated conversation

Present user intent, assistant prose and final results as the primary content. Intermediate tool and thought activity forms compact, meaningful disclosure groups. Show actor/model changes clearly; within a consecutive unchanged actor/model tool/thought-only run, avoid a new prominent badge for every microstep. Keep provenance and timing reachable in the group or per-message details. Preserve message identities, deep links, statuses, error recovery, outputs, copy controls and all user actions. Never group across a user message, nonempty assistant prose including commentary, an actor/model change or a final result. Explicit saved reasoning/tool display choices remain functional.

### Composer and navigation

Align the composer with the transcript axis, with one input boundary and open icon-led controls. Model, reasoning, autonomy and delivery retain their menus, values and validation. Metrics remain labelled and distinct from Send/Stop. Attachments and context chips wrap without pushing the pane wider. Sidebar titles retain full accessible names; grouping, status filters, paging and pinning keep bounded connection-scoped reads.

### Projects and management

Keep the Project Master/member roster compact and singular. The adjacent workflow region contains add-existing and create-new controls; selected member detail remains reachable without duplicating the list. Selection and focus survive the compact Back/Escape journey. Remove from project retains the Session; Delete Session and Delete project keep their distinct confirmations. Other dialogs keep their current routes, actual capabilities, errors and focus return.

## Accessibility

Keep semantic landmarks, names, visible focus and keyboard operation. Normal text retains 4.5:1 contrast and meaningful non-text affordances 3:1; status uses a name or glyph as well as color. Long content remains available and readable in expanded groups. Keep forced-colors system rendering and existing high-contrast schemes. No collapsing transition may leave invisible focusable descendants or hide a required error/action. Browser emulation does not establish native accessibility or device behavior.

## Verification

`SCENARIOS.md` maps the populated layout, execution hierarchy, long-content containment, Project sizing and motion journeys to selected local tests and separate native observations. Record before/after wide and compact screenshots plus DOM widths, gutters, centers and scrollbar geometry. Use realistic synthetic multi-agent, tool-heavy and thought-heavy data for local tests; use only existing populated Sessions for native navigation.

Run strict lint on this file, `../../DESIGN.md` and `../../.stitch/DESIGN.md` using the installed unified skill's `scripts/design_md.py`. Run the dependency-free token/theme/motion drift checks in `test/ledger-design.test.ts`, selected changed-behavior tests, affected CSS/icon/render audits, lint and one final Desktop typecheck. Preserve raw audit findings and label measured, judged and unverified results separately. Run one final frozen-backend candidate build only after cohesive source and test corrections finish, including signing, toolchain and finalizeBuild checks. Native acceptance requires the rebuilt OUTER app, approved saved endpoint readback, a crash-free WebView/backend, existing root → child → grandchild rendering and actual native geometry; browser captures are not a substitute.

## Maintenance

Read this contract and its brand parent before visual changes. Change a rule and its consumers together, keep strict lint and bidirectional drift checks, and obtain explicit approval for a new rule outside the approved revision. Preserve original source exports and unwaived conflicts. Reuse check evidence only for unchanged code, inputs and environment; never count a previous candidate or passing validator as visual acceptance. Keep native and synthetic evidence distinct.

## Do's and Don'ts

- Do measure the populated reading path, both gutters and composer center, including expanded long execution content.
- Do keep sparse lists naturally sized, controls comfortable and errors/provenance reachable.
- Don't fill space with dummy content, stretch rows, clip an overflow defect or flatten code whitespace.
- Don't animate incoming tokens, break scroll anchoring, repeat noisy metadata or silently remove an interaction.

## Exceptions

Root R9, Desktop code/metadata only: self-hosted JetBrains Mono follows the explicit Desktop font directive and approved source declarations. Geist remains the interface family; Web and other surfaces keep their font contract. Approval: Desktop-only directive of 2026-11-16; review date 2026-11-17.

Root R4, compact/coarse Desktop pickers only: content-sized bottom sheets replace beside-control anchoring. Fine-pointer Desktop anchoring is unchanged. Approval: compact-renderer directive of 2026-11-16; review date 2026-11-17.

Root Ledger Settings composition, Desktop only: pane-filling responsive tracks and icon-led section navigation retain all Settings behavior. Approval: Desktop directive of 2026-11-17; review date 2026-11-17.

Shared palette, shared header and Session companion precedence remains **Leave override unapproved**. Keep all incompatible source measurements unwaived. Revision r7 authorizes its explicit Desktop layout, hierarchy, de-boxing, comfort, motion and sizing changes, not new backend capabilities or acceptance of an earlier candidate.
