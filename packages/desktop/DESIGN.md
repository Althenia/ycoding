---
version: alpha
name: YCoding Desktop
description: Icon-led conversation, Session activity, and management for the YCoding Desktop client.
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

# YCoding Desktop design

## Overview

YCoding Desktop centers the conversation between navigation and an optional Session Companion. Lead with owned icons, readable labels, and tonal surfaces. Keep ongoing work and secondary detail close to the conversation without giving routine events the weight of chat turns.

## Principles

- Make user messages, substantive responses and final results the reading path. Put intermediate execution within that path without making it the dominant furniture.
- Center the useful conversation and composer together. Give both sides deliberate, modest space rather than parking content on the left of a blank pane.
- Use typography, spacing, semantic ink and surface tone before borders. Preserve boundaries that explain an input, floating layer, pending decision or danger.
- Keep information, provenance, keyboard actions, drafts, reported state and confirmation boundaries intact.
- Animate a change of state, not every incoming token. Keep the reading anchor and input responsive.

## Rules

| ID | Status | Binding statement | Enforcing check |
|---|---|---|---|
| D1 | approved | Startup and reconnect MUST retain the saved shared-backend and managed-local flows, genuine loading and failure states, revision fences and explicit retry. Open Settings to inspect or change the saved backend. Unavailable reads MUST NEVER become successful empty results. | `test/renderer.test.tsx` |
| D2 | approved | Assistant headers, Thought and tool disclosures, shell completions, Step provenance, assistant prose and duration/chevron controls MUST share both edges of the composer's centered track. Prose MUST NOT introduce a second narrowed track. User bubbles MUST align to its trailing edge. The wide track caps at 1024px; compact gutters MUST remain symmetric. Floating scroll and zoom controls MUST stay outside the track. | `test/renderer.integration.test.ts`; `SCENARIOS.md` |
| D3 | approved | Outer page, pane, transcript, composer shell, action bar, attachments and chips MUST satisfy scrollWidth <= clientWidth in normal and long-content states, collapsed and expanded; composer and near-composer horizontal scrollbars MUST NEVER appear. Word-wrapped code/diffs, prose, paths, labels and tool output MUST fit without a horizontal bar. Diff wrap `none` MUST retain no-wrap behavior with intentional horizontal scrolling ONLY inside a bounded inner diff/code viewport; that inner scroll MUST NEVER widen an outer container. | `test/renderer.integration.test.ts`; review-only native DOM measurements |
| D4 | approved | Width fixes MUST belong to the owning flex/grid track, min-width, wrapping or content layout; hidden clipping, flattened whitespace, removed information and compressed controls MUST NEVER substitute for fitting content. | `test/renderer.integration.test.ts`; review-only source inspection |
| D5 | approved | User messages, assistant prose, actor/model changes and final results MUST each restart prominent provenance. Any nonempty assistant prose, including commentary, MUST remain a boundary. Only consecutive intermediate tool/thought activity by an unchanged agent/model MAY share quiet provenance instead of repeating a prominent badge on every microstep. | `test/renderer.integration.test.ts` |
| D6 | approved | Compact tool/thought groups MUST retain every output, status, error, provenance field, timing, copy/expand control and user action through reachable disclosure; changes of actor/model and errors MUST remain identifiable without color. | `test/renderer.integration.test.ts`; `test/renderer.test.tsx` |
| D7 | approved | Disclosure and navigation MUST retain accessible names, expanded state, keyboard order, visible focus, focus return and screen-reader announcements; collapsed content MUST NOT remain an invisible keyboard target. | `test/renderer.integration.test.ts` |
| D8 | approved | Streaming and refresh MUST preserve stable message/disclosure identities and the reader's attached or detached scroll position; motion MUST NEVER remount unchanged rows, move a detached reader or delay input. | `test/renderer.integration.test.ts` |
| D9 | approved | Use owned 16px SVG icons, typography and spacing to lead rows and disclosures. Normal content MUST use `surface`, `surface-raised` or `surface-sunken` instead of nested outlines. Preserve useful boundaries for fields and the composer, floating layers, pending decisions, and destructive and error states, as well as focus rings and functional pane separators. | `test/ledger-design.test.ts`; `test/renderer.integration.test.ts` |
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
| D34 | approved | A local user message MUST use a borderless tonal bubble at the trailing edge, sized to its text up to the smaller of 78% of the track and 42rem. Keep the turn anchor, attachments and timestamp receipt; align attachments and receipts to the same edge. Omit the visible author label for local user turns. Wrap prose, unbroken text and code without horizontal overflow. | `test/renderer.integration.test.ts` |
| D35 | approved | The transcript MUST omit repeated `subagent_notification` events, Project `started` and `progress`, and undescribed synthetic task noise. Preserve parent answers, goal steers, described completions and notes, and actionable described Project member notifications with an Open action. Filtering MUST NOT change retained history or Activity. | `test/form-rules.test.ts`; `test/renderer.integration.test.ts` |
| D36 | approved | Companion Context MUST give the category breakdown the full inner width, with readable labels, counts and shares. Keep usage and Session tasks readable; put Diagnostics, Loaded child task costs and Compaction history behind named keyboard-operable disclosures. Nested snapshot values MUST stack below their keys. Activity and Running MUST wrap both headings and metadata without truncation, with `scrollWidth <= clientWidth` throughout. | `test/renderer.integration.test.ts` |
| D37 | approved | The mint Working arc MUST spin continuously through 360° at a constant speed around its center. The YCoding label and strip stay still. Keep the arc static with reduced motion or when animations are off. | `test/renderer.integration.test.ts` |
| D38 | approved | At widths above 700px, connection status MUST sit beside the session title with one spacing step between them. Truncate text only when width is constrained; the header actions remain at the trailing edge. | `test/renderer.integration.test.ts` |
| D39 | approved | The model and effort chips MUST open the same searchable catalog without blocking interaction, including when 600 models are offered. Keep provider grouping, recent models, profile and effort selection, and focus return to the invoking control. | `test/renderer.integration.test.ts`; `test/model-switch.test.ts` |
| D40 | approved | User and assistant turns, reasoning, substantive notices and narrative tool output MUST use Markdown. Fenced code MUST preserve indentation and line breaks; show its language or `text` and an icon-led Copy action that writes the rendered code text through the native clipboard. Text must remain selectable and any code scrollbar must stay inside the code viewport. | `test/renderer.integration.test.ts` |

## Colors

Use `surface` for quiet rows, `surface-raised` for active or floating surfaces, and `surface-sunken` for recessed readouts and compact metadata. Tint user bubbles lightly with mint over `surface-raised`. Use violet for reasoning and Projects, teal for terminal and tools, sky blue for files, models and Markdown links, mint for active or completed work, amber for usage and goals, and the danger role for failures and destructive actions. Effort icons follow their variant hues. Pair every state color with a name or distinct icon. Resolve these roles through the documented light, dark and high-contrast schemes; keep raw color values in tokens, not component styles.

## Typography

Use self-hosted Geist for interface prose and JetBrains Mono Regular, Medium and SemiBold for code and metadata. Body text is 13px with 20px leading; metadata has a 12px floor. Prose occupies the same centered track as the surrounding activity and composer without another character-count maximum. Preserve original whitespace and line structure when wrapping code and tool output.

## Layout

The 256px rail and optional 320px Companion bound the conversation pane. Center the transcript and composer in one track with equal inline gutters and a 1024px cap. Wide gutters begin at 24px; compact gutters use 12px. Assistant prose and tool detail use the full track. Local user bubbles, attachments and timestamp receipts align at the trailing edge. Keep the title and workspace/connection status together at the leading edge of the 40px conversation header, with actions at the trailing edge.

Keep the composer footer compact. Place the flexible spacer before the metrics/autonomy/send cluster, not between Auto and Send. Keep their control-box gap at 8–10px and Send's trailing and bottom card insets at 10–12px, matching the left attachment/model treatment. Reflow controls on compact windows without losing any control or shrinking coarse targets. Tighten turn, activity-step and composer spacing together without removing content or reducing text sizes.

Give every flex/grid child that contains long content a shrinkable track. Wrap paths, labels, tool output and code without destroying their text; keep controls at their readable size and reflow the action row when needed. Neither the composer nor its surrounding dock owns a horizontal scroller. Give each pane one deliberate vertical scroll owner and retain the established attached-reader behavior.

Diff lines retain their original whitespace and existing `Wrap diff lines` control. Stored `word` wraps code within the available width without a horizontal bar. Stored `none` keeps no-wrap lines and intentional horizontal scrolling inside the bounded inner diff/code viewport. Keep that viewport shrinkable and contained; its scroll must not widen the page, pane, transcript or composer. Preserve preference values/defaults, line numbers, content, copy actions, reviewed state and split/unified controls.

Coordination uses a project inventory, one Master/member roster and a separate Add-existing/New-member workflow sidebar. Stretch the sidebar surface and left separator to the pane bottom, independently of its form content. The left main pane fills the same height as a min-height:0 flex column. Its list region takes the remaining space and owns vertical scrolling; the concurrency and Delegated decisions footer stays at the bottom with a top border. Short lists leave open list-region space without stretching rows. Long lists scroll without displacing the footer or forcing the sidebar to grow. Preserve selection, explicit member actions and create/add workflows without dummy rows or duplicated membership.

### Surface geometry

| Component | Wide-window geometry |
|---|---|
| Workspaces | 48px toolbar, 420px detail |
| Projects | 44px toolbar, 400px workflow inspector |
| Sessions | 40px toolbar |
| Team | 40px toolbar, 320px selected detail |
| Coordination | 56px toolbar, 320px selected detail |
| Agents & Skills | 1080×720 dialog; 48px header; 320px agent and 360px skill tracks |
| Browser | 960×640 dialog, 48px header |
| Status & Debug | 980×650 dialog, 48px header plus 40px tabs |
| Session actions | 920×680 dialog, 48px header |
| Git diff | 1080×720 dialog, 57px border-inclusive header, 340px files |
| Provider connection | 660px width, 44px header |
| Folder chooser | 580px width, content-height title with 14px vertical padding |
| Prompt stashes / editor / export | 740px / 680px / 520px widths, bounded content height |
| Appearance / command palette | 560px / 640px widths; palette search 48px |
| Captured-file confirmation | 460px width |

The composer recognizes `/btw`, `/btw-send`, `/suggest`, `/prompt`, `/cd`, `/editor`, `/docs`, `/exit` and `/defer` as local commands. Side-chat and prompt-assistance commands open a reviewable dialog with the supplied text; they do not submit that text as an ordinary prompt. `/btw-send` is restricted to a BTW side chat with a parent. `/prompt` from New chat creates a Session only after confirmation and opens prompt assistance without sending a prompt. `/editor` opens the draft through `VISUAL`, then `EDITOR`, using a private temporary file and argument parsing without a shell. Missing or unsuccessful external editors open the owned draft dialog instead. Saving preserves file and agent attachments; an empty edited draft is valid. `/docs` opens the documentation in the external browser. `/exit` confirms before disconnecting and quitting; a failed disconnect prevents quitting.

The autonomy popover and `/defer` toggle persistent deferral without changing Permissions, Guardrails or Answers. `/defer on` and `/defer off` set it explicitly. The chip shows its current state and the action reads Defer on or Defer off. Normal prompts leave deferral enabled; only an explicit off action disables it. The popover keeps a named dialog role, independent category controls, Goal actions and an alert region. Enabling a new YOLO category requires an explicit risk confirmation before applying it; New chat requires the same consent for staged YOLO autonomy before sending.

Full Session diffs use independent 240px unified and 220px split file tracks. Keep the Git diff viewer read-only; it does not stage, discard or commit changes.

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

The Working strip shows a mint partial circle immediately before YCoding. Rotate only the arc on its center at a constant speed, using three slow-duration steps per revolution. Keep its label and neighbors still. Reduced motion and the Desktop animation preference both stop the spin.

## Icons

Use the owned 24-unit SVG registry, 1.6-unit rounded currentColor strokes and 16px inline icons. Model, effort, policy, delivery, attachment and execution controls keep meaningful symbols, consistent alignment and readable values. Running, waiting, failed, idle and unknown states keep distinct glyphs and names. Dense actions expose owned non-native hover/focus hints; coarse actions keep 44px reach. Do not replace user-facing names with unexplained icons or native title tooltips.

## Components

### Populated conversation

Present user intent, assistant prose and final results as the primary content. Intermediate tool and thought activity forms compact, meaningful disclosure groups. Show actor/model changes clearly; within a consecutive unchanged actor/model tool/thought-only run, avoid a new prominent badge for every microstep. Keep provenance and timing reachable in the group or per-message details. Preserve message identities, deep links, statuses, error recovery, outputs, copy controls and all user actions. Never group across a user message, nonempty assistant prose including commentary, an actor/model change or a final result. Explicit saved reasoning/tool display choices remain functional.

Use the local user's trailing bubble as attribution; do not print “You”. External peers keep their own attribution. Keep substantive synthetic notices in the reading path as icon-led rows, adding a start-edge accent where detail needs grouping. Show Project member reviews and escalations with the originating member's Open action. Keep repeated lifecycle notices out of chat; consult Activity or Running for shell and child work. Render conversation prose and narrative tool results as Markdown, but preserve literal shell output. Use JetBrains Mono in code and its language/Copy header. Keep browser HTML out of the transcript and retain only safe link destinations.

### Session Companion

Place the context ring beside the window summary, above a full-width category breakdown. Use one label column and two consistently aligned numeric columns. Show Session usage and tasks without frames; open diagnostics, loaded child costs and compaction history through icon-led, named disclosures. Separate nested snapshot groups by indentation or a start-edge rule; do not fit a new key/value grid inside a narrow value column. In Activity and Running, place the icon first and wrap the complete command, task description and metadata in the available space without a horizontal scroll bar.

### Composer and navigation

Align the composer with the transcript axis, with one input boundary and open icon-led controls. Model, reasoning, autonomy and delivery retain their menus, values and validation. Metrics remain labelled and distinct from Send/Stop. Attachments and context chips wrap without pushing the pane wider. Sidebar titles retain full accessible names; grouping, status filters, paging and pinning keep bounded connection-scoped reads.

Group the rail as Needs action, Running, Pinned, Recent. On startup, use the saved connection and open the last available Session or New chat. The Settings **Machine & Backend** section owns configuration and reconnect actions.

### Projects and management

Keep the Project Master/member roster compact and singular. The adjacent workflow region contains add-existing and create-new controls; selected member detail remains reachable without duplicating the list. Master and member creation offer a folder path field alongside the folder chooser. Accept an absolute path, `~`, or `~/…`, and create a missing folder after confirmation. The Session uses the chosen directory, including a repository subfolder or non-Git folder. Selection and focus survive the compact Back/Escape journey. Remove from project retains the Session; Delete Session and Delete project keep their distinct confirmations. Use icons, labels and tonal selection for Settings and dialog list rows. Keep the dialog boundary and error states; avoid framing every row inside it.

### Bridge gaps

Expose only operations supported by the Desktop backend connection. The Git diff viewer does not stage, discard or commit files. Report unavailable data and actions without simulating them.

## Accessibility

Keep semantic landmarks, names, visible focus and keyboard operation. Normal text retains 4.5:1 contrast and meaningful non-text affordances 3:1; status uses a name or glyph as well as color. Long content remains available and readable in expanded groups. Keep forced-colors system rendering and existing high-contrast schemes. No collapsing transition may leave invisible focusable descendants or hide a required error/action. Browser emulation does not establish native accessibility or device behavior.

## Verification

`SCENARIOS.md` maps the populated layout, execution hierarchy, long-content containment, Project sizing and motion journeys to selected local tests and separate native observations. Record before/after wide and compact screenshots plus DOM widths, gutters, centers and scrollbar geometry. Use realistic synthetic multi-agent, tool-heavy and thought-heavy data for local tests; use only existing populated Sessions for native navigation.

Run strict `design_md.py lint` on this file and its brand parent. Use `test/ledger-design.test.ts` for token drift and binding rules, `test/form-rules.test.ts` for transcript visibility, and `test/renderer.integration.test.ts` for rendered geometry, keyboard controls, motion and model selection. Keep native acceptance separate: browser fixtures do not establish native-window behavior, saved-endpoint readback or a crash-free packaged app.

## Maintenance

Read this contract and its brand parent before visual changes. Obtain approval for rule changes, update the rule before its styling and tests, and preserve strict lint and bidirectional token drift checks. Keep browser-fixture and native evidence distinct.

## Do's and Don'ts

- Do measure the populated reading path, both gutters and composer center, including expanded long execution content.
- Do keep sparse lists naturally sized, controls comfortable and errors/provenance reachable.
- Don't fill space with dummy content, stretch rows, clip an overflow defect or flatten code whitespace.
- Don't animate incoming tokens, break scroll anchoring, repeat noisy metadata or silently remove an interaction.

## Exceptions

Root R9, Desktop code/metadata only: self-hosted JetBrains Mono follows the explicit Desktop font directive and approved source declarations. Geist remains the interface family; Web and other surfaces keep their font contract. Approval: Desktop-only directive of 2026-11-16; review date 2026-11-17.

Root R4, compact/coarse Desktop pickers only: content-sized bottom sheets replace beside-control anchoring. Fine-pointer Desktop anchoring is unchanged. Approval: compact-renderer directive of 2026-11-16; review date 2026-11-17.

Root Ledger Settings composition, Desktop only: pane-filling responsive tracks and icon-led section navigation retain all Settings behavior. Approval: Desktop directive of 2026-11-17; review date 2026-11-17.
