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
  control: "8px"
  card: "12px"
  composer: "16px"
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
  window-min-width: "800px"
  window-min-height: "600px"
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

YCoding Desktop centers a readable conversation between the Session rail and an optional Companion. Project coordination and Settings use the same navigation rhythm, ink, and spacing as chat, with wider work areas for rosters and forms. Management dialogs keep their title and actions separate from scrollable detail. Nothing in these surfaces changes where a Session runs or how its data is stored.

The parent `DESIGN.md` owns brand and cross-surface accessibility. Desktop owns its palette and geometry in `src/tokens.css` and this document. Approved rules govern behavior and appearance. `Implemented` rules describe local geometry, not a new brand requirement. The inspected Settings, Keyboard Shortcuts, Connect Providers, and Master-Session Team Stitch screens inform grouping and alignment. Their illustrative runtime states and actions are not product capabilities. A `proposal` does not bind the implementation.

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
| D11 | approved | The composer MUST float on the canvas without a footer fill, divider or redundant Working label. The right-hand action MUST show Send at rest and a red Stop generation control during generation; the toolbar MUST NOT contain a second stop control. Keep keyboard submission, Steer now, attachment handling and draft recovery distinct from Stop. Preserve model, effort, autonomy and delivery controls, the 8–10px Auto-to-action gap and symmetric 10–12px card insets. Compact reflow and coarse hit targets MUST remain intact. Unsent and unconfirmed content MUST survive failure and MUST NEVER be resent automatically. | `test/renderer.test.tsx`; `test/renderer.integration.test.ts` |
| D12 | approved | Coordination's Add-existing/New-member sidebar background and left border MUST span the full pane height. Its left main pane MUST be a full-height min-height:0 flex column, with a flex:1 min-height:0 overflow-y:auto member-list region and a concurrency/delegated-decisions footer docked flush to the pane bottom behind a clean top border. Rows MUST retain natural height; sparse lists MUST NOT stretch rows or place the footer immediately below the last row. Compact drill-in MUST retain contained scrolling and reachable footer controls. | `test/renderer.integration.test.ts`; `test/project-members.test.tsx` |
| D13 | approved | Projects MUST retain one Master/member roster, real selection and detail, inline concurrency and distinct Open, Remove from project and Delete Session actions; create/add workflows MUST NOT duplicate that roster. Add MUST attach a running root Session from any directory without restarting it, and Remove from project MUST detach it, through the named attach and detach operations and never a member-list rewrite. The Session and its history survive Remove. | `test/project-members.test.tsx`; `test/renderer.integration.test.ts` |
| D14 | approved | Motion MUST consume the canonical duration/easing tokens for feedback, transient layers, panel/detail changes and screen/Session continuity; frequent streaming updates MUST remain still and input MUST remain responsive. | `test/ledger-design.test.ts`; `test/renderer.integration.test.ts` |
| D15 | approved | Reduced motion MUST remove spatial travel and smooth scrolling, keep effects at most 150ms and exits immediate, and preserve focus, state and announcements; motion MUST NEVER conceal essential content or cause flicker or a reflow storm. | `test/renderer.integration.test.ts` |
| D16 | approved | Ordinary rail, directory, recent lists and counters MUST show only noncompaction roots; the bounded paginated index MUST retain descendants for real child, fork, BTW and grandchild discovery without promoting off-page children to roots. | `test/root-sessions.test.ts`; `test/renderer.integration.test.ts` |
| D17 | approved | Sidebar Session rows MUST show state through distinct semantic glyphs rather than visible status words. Preserve accessible status names, unknown state, filters, counters, pins and paging. Animate active glyphs only when motion is allowed. Counters, metrics and durations MUST NOT invent activity, capacity, allowance or verification. | `test/renderer.test.tsx`; `test/renderer.integration.test.ts` |
| D18 | approved | Settings MUST retain pane-filling section navigation, current values, one labelled keep-awake switch, every keyboard action and chord, and the existing presentation handlers and paste threshold. | `test/keyboard.test.ts`; `test/renderer.integration.test.ts` |
| D19 | approved | Owned palette, fonts, corner sizes, component geometry and motion MUST agree with their documented tokens in both directions, including theme overrides; components MUST consume semantic roles. | `test/ledger-design.test.ts` |
| D20 | approved | Loading, empty, pending, disabled, failure and recovery states MUST retain owned presentation and actual controls; skeletons and compaction progress MUST retain static reduced-motion states. | `test/renderer.test.tsx`; `test/renderer.integration.test.ts` |
| D21 | approved | Dialogs, menus and pickers MUST keep named controls, contained scrolling, genuine errors, confirmation gates and focus return; commands MUST retain modal combobox/listbox behavior and supported actions only. | `test/renderer.integration.test.ts` |
| D22 | approved | Native menus, clipboard, update verification and rollback MUST retain their existing contracts; Enter sends and Shift+Enter inserts a newline only in the existing composer context. | `test/host-contract.test.ts`; `test/updater.test.ts` |
| D23 | approved | Backend ownership, credentials, permissions, pairing, session data and frozen bridge capabilities MUST NOT change through presentation work; the client MUST NEVER answer or approve a pending request automatically. | `test/renderer.test.tsx`; review-only native preservation checks |
| D24 | approved | Browser fixture results MUST NOT stand in for native-window rendering, saved-endpoint readback, crash-free operation or existing populated family navigation. | `SCENARIOS.md`; review-only native verification |
| D25 | approved | Team MUST offer Table and Grid over the same reported children, blockers and shared selection. Pointer or keyboard activation MUST reveal the selected child with lineage, status, assignment, model, effort, profile, elapsed time, tokens, full progress and pending requests. Open Dedicated Child Session MUST use the selected child identity; answers keep confirmation. | `test/renderer.integration.test.ts` |
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
| D41 | approved | Use the control, card and composer corner roles consistently across navigation, views and overlays. Use the canvas for the reading track, raised cards for coherent control/inspector groups, and semantic ink for state. Keep existing pane boundaries, routes and named actions. Provider profiles MUST show labelled default and connection state rather than raw booleans. System tool notices MUST appear only on their owning tab. | `test/ledger-design.test.ts`; `test/renderer.integration.test.ts` |
| D42 | approved | A composer MUST paste text and attach clipboard or drop files through the existing prompt file contract. Show a visible file drop target, removable attachment chips, and recoverable limits or read errors before submission. Drop outside the composer MUST NOT navigate the window. No asynchronous transfer may change a locked or replaced draft. | `test/renderer.integration.test.ts` |
| D43 | approved | Project titles and roster actions MUST use the available main pane up to its normal inspector gutter. Align concurrency and delegated decisions in the footer and folder inputs with chooser buttons; wrap controls rather than crowding them. | `test/renderer.integration.test.ts` |
| D44 | approved | The context ring, token count and percentage MUST remain visible in one named header control. Rail links and Settings section buttons retain distinct roles and share icon geometry, label insets and current-state treatment. Settings cards MUST use `--yc-space-5` insets, `--yc-space-4` at or below 700px, and a 1px `--yc-border` frame. Align Machine and Updates at the top; let each frame follow its content. Below 701px the Keep machine awake switch retains a centered 32×18px pill and 12px thumb in its interaction box; the coarse target MUST be at least 44×44px. Shortcut actions MUST stay beside the field within their own grouped track, with distinct focus, selection, hover and unassigned states. | `test/renderer.integration.test.ts` |
| D45 | approved | Management dialogs MUST share Desktop headings, spacing, close/focus behavior and scroll boundaries. MCP moves refresh into its header and nests resources beneath their server. Connect providers MUST keep search and refresh inline when they fit; wrap names and identifiers, stack the two columns at or below 700px, and keep `scrollWidth <= clientWidth` in both. Pad the provider, credential, authorization and custom URL surfaces and separate Add provider from the input. | `test/renderer.integration.test.ts` |
| D46 | approved | Escape MUST dismiss the focused layer without minimizing the window. Restore focus to that layer's invoking control, unless it leaves the screen or is unavailable. The native Window menu and window button retain explicit minimize. | `test/renderer.integration.test.ts`, `test/host-contract.test.ts`, `SCENARIOS.md` |
| D47 | implemented | Regular-width provider dialogs MUST cap their width at 880px and place the registry beside the connection form. Compact windows stack those regions within the same dialog. The header meter MUST use the compact 24px control step for the ring and retain 12px visible values. | `test/renderer.integration.test.ts` |
| D48 | approved | Team MUST reserve space for the floating Master composer while the table and inspector scroll. At the list boundary the final row and its action remain visible. The Team scroll-to-top control and its side tooltip MUST NOT cover the composer or progress card on hover or keyboard focus. The action never targets the hidden transcript. Align table headers with their cells and use `--yc-space-4` insets in the blocker summary and inspector cards. | `test/renderer.integration.test.ts` |
| D49 | approved | Native desktop windows MUST enforce a minimum content size of 800×600px (`window-min-width` and `window-min-height`), clamping any smaller initial or programmatic bounds to at least 800×600px while allowing free resizing at or above that floor and preserving traffic lights, explicit Minimize/Restore, focus return, Escape and reduced motion. | `test/window-bounds.test.ts`; `test/isolated-mode.test.ts`; `SCENARIOS.md` |
| D50 | implemented | Genuine Dot-originated synthetic steer prompts (excluding internal envelopes, system/review/instruction/history/peer/audit metadata and notices) MUST render as right-aligned trailing prompt bubbles via `SharedMessageTurn` with transport markup stripped, `transcript-message--synthetic` and `Dot steer prompt` accessible labeling, `Dot steer` provenance rather than human authorship, and prompt-rail ticks. Empty steers after transport stripping MUST remain hidden without inventing text; non-steer synthetic notices, `Dots.peer` and `Goal · steer` MUST remain unchanged. | `test/form-rules.test.ts`; `test/renderer.test.tsx`; `test/renderer.integration.test.ts` |

## Colors

Use `surface` for quiet rows, `surface-raised` for active or floating surfaces, and `surface-sunken` for recessed readouts and compact metadata. Tint user bubbles lightly with mint over `surface-raised`. Use violet for reasoning and Projects, teal for terminal and tools, sky blue for files, models and Markdown links, mint for active or completed work, amber for usage and goals, and the danger role for failures and destructive actions. Effort icons follow their variant hues. Pair every state color with a name or distinct icon. Resolve these roles through the documented light, dark and high-contrast schemes; keep raw color values in tokens, not component styles.

## Typography

Use self-hosted Geist for interface prose and JetBrains Mono Regular, Medium and SemiBold for code and metadata. Body text is 13px with 20px leading; metadata has a 12px floor. Prose occupies the same centered track as the surrounding activity and composer without another character-count maximum. Preserve original whitespace and line structure when wrapping code and tool output.

## Layout

The 256px rail and optional 320px Companion bound the conversation pane. Center transcript and composer in one track with equal inline gutters and a 1024px cap. Use 24px wide gutters and 12px compact gutters. Assistant prose and tool detail use the full track. Local user bubbles, attachments and timestamp receipts align at the trailing edge. Keep the title and workspace or connection status together at the leading edge of the 40px conversation header. Group the trailing Team, context, Companion and menu controls; show the context values beside the ring, not in a second control or a tooltip alone.

Keep the composer footer compact. Place the flexible spacer before the metrics/autonomy/send cluster, not between Auto and Send. Keep their control-box gap at 8–10px and Send's trailing and bottom card insets at 10–12px, matching the left attachment/model treatment. Reflow controls on compact windows without losing any control or shrinking coarse targets. Tighten turn, activity-step and composer spacing together without removing content or reducing text sizes.

Give every flex/grid child that contains long content a shrinkable track. Wrap paths, labels, tool output and code without destroying their text; keep controls at their readable size and reflow the action row when needed. Neither the composer nor its surrounding dock owns a horizontal scroller. Give each pane one deliberate vertical scroll owner and retain the established attached-reader behavior.

Diff lines retain their original whitespace and existing `Wrap diff lines` control. Stored `word` wraps code within the available width without a horizontal bar. Stored `none` keeps no-wrap lines and intentional horizontal scrolling inside the bounded inner diff/code viewport. Keep that viewport shrinkable and contained; its scroll must not widen the page, pane, transcript or composer. Preserve preference values/defaults, line numbers, content, copy actions, reviewed state and split/unified controls.

Coordination uses a project inventory, one Master/member roster and a separate Add-existing/New-member workflow sidebar. Both panes reach the bottom of the window. Stretch the roster and its header across the main pane, with actions facing the workflow divider. Keep row heights natural. The list region owns vertical scrolling above the pinned footer. In the footer, align the concurrency label and picker with a labelled delegation summary. Pair a folder field and chooser along their control baseline; wrap the chooser below the input when the form track cannot fit both.

### Surface geometry

| Component | Wide-window geometry |
|---|---|
| Workspaces | 48px toolbar, 420px detail |
| Projects | 44px toolbar, 400px workflow inspector |
| Sessions | 40px toolbar |
| Team | 40px toolbar, 320px selected detail; one scrolling content track at or below 1000px |
| Coordination | 56px toolbar, 320px selected detail |
| Agents & Skills | 1080×720 dialog; 48px header; 320px agent and 360px skill tracks |
| Browser | 960×640 dialog, 48px header |
| Status & Debug | 980×650 dialog, 48px header plus 40px tabs |
| Session actions | 920×680 dialog, 48px header |
| Git diff | 1080×720 dialog, 57px border-inclusive header, 340px files |
| Provider connection | Up to 880px, standard dialog header, shrinkable registry and detail tracks |
| Folder chooser | Up to 580px, shared title and close controls |
| Prompt stashes / editor / export | 740px / 680px / 520px widths, bounded content height |
| Appearance / command palette | 560px / 640px widths; palette search 48px |
| Captured-file confirmation | 460px width |

Desktop enforces a native minimum window content size of `800×600px` (`window-min-width: 800px`, `window-min-height: 600px`) and opens new windows at `1360×860px` with no persisted window-bounds file (`preferences.ts` stores only backend `mode` and `sharedEndpoint`). Baseline evidence for `800×600px`: `800px` remains above the `700px` compact drawer breakpoint so the `256px` persistent navigation rail (`layout.rail`) sits beside a `544px` main pane (`448px` centered track with `24px` gutters), side-by-side title/status header (`D38`), `--yc-space-5` Settings card insets (`D44`), `min(320px, 100%)` overlay Companion leaving main-pane context visible, 2-column Connect providers (`D45`/`D47`), and the `752px` (`100dvw - 48px`) modal track for `640px` palette, `680px` editor, `740px` stashes and `768px` default dialogs; `600px` exceeds the `36rem` (`576px`) compact-height dialog rule in `src/style.css` (`552px` modal height, `560px` body below the `40px` header) and aligns with Electrobun's `BrowserWindow` `800×600` baseline.

The composer recognizes `/btw`, `/btw-send`, `/suggest`, `/prompt`, `/cd`, `/editor`, `/docs`, `/exit` and `/defer` as local commands. Side-chat and prompt-assistance commands open a reviewable dialog with the supplied text; they do not submit that text as an ordinary prompt. `/btw-send` is restricted to a BTW side chat with a parent. `/prompt` from New chat creates a Session only after confirmation and opens prompt assistance without sending a prompt. `/editor` opens the draft through `VISUAL`, then `EDITOR`, using a private temporary file and argument parsing without a shell. Missing or unsuccessful external editors open the owned draft dialog instead. Saving preserves file and agent attachments; an empty edited draft is valid. `/docs` opens the documentation in the external browser. `/exit` confirms before disconnecting and quitting; a failed disconnect prevents quitting.

The autonomy popover and `/defer` toggle persistent deferral without changing Permissions, Guardrails or Answers. `/defer on` and `/defer off` set it explicitly. The chip shows its current state and the action reads Defer on or Defer off. Normal prompts leave deferral enabled; only an explicit off action disables it. The popover keeps a named dialog role, independent category controls, Goal actions and an alert region. Enabling a new YOLO category requires an explicit risk confirmation before applying it; New chat requires the same consent for staged YOLO autonomy before sending.

Full Session diffs use independent 240px unified and 220px split file tracks. Keep the Git diff viewer read-only; it does not stage, discard or commit changes.

## Responsive

Keep the existing 700px compact navigation/drill-in boundary and 1180px companion overlay boundary. At compact widths, put selectors on another composer row rather than shrinking their text. Use contained, content-sized picker sheets, visual viewport geometry and safe-area insets. Keep a named Close/Back action, scrim dismissal and Escape behavior. At 320px the whole page and all named conversation/composer containers still fit horizontally. Native compact checks concern the Desktop renderer in a resized window, not a claim of physical-phone verification.

## Elevation & Depth

Use single-level tonal planes in normal flow and restrained depth for floating layers. Keep useful pane separators, field boundaries and destructive/pending treatments. Remove a redundant wrapper at its owner; never apply blanket border-removal CSS. A disclosure is an interaction, not a reason to put another card around every nested row.

## Shapes

Use 8px for interactive controls, 12px for raised cards and dialogs, and 16px for the single composer boundary. Preserve smaller detail radii and circular status geometry. Group controls without enclosing each field in another card; keep repeated conversation activity open and aligned.

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

Group the rail as Needs action, Running, Pinned, Recent. On startup, use the saved connection and open the last available Session or New chat. Machine & Backend owns configuration and reconnect actions. Route links and section buttons share 16px icons, the control inset and tonal selection, with `aria-current="page"` for routes and `aria-current="location"` for sections. Machine and Updates share equal-width tracks and a top edge, with content-height frames. Settings switches to one content column below 1280px. Session display, Keyboard shortcuts, Permissions, Models & Providers, and MCP retain the same raised card, inset and frame. Provider and MCP cards open the existing management dialogs. At 700px, keep Command, Shortcut and its action group on one baseline; below 520px, Command takes a full row and actions stay beside Shortcut. Show chords in mono pills. The selected row has a tonal surface and inset marker; keyboard focus is distinct from selection.

### Projects and management

Keep the Project Master/member roster singular. Master and member creation accept an absolute POSIX, drive or UNC path, `~`, `~/…` or `~\…`. Send it to the backend as typed without probing this machine's filesystem; create a missing folder after confirmation. Back and Escape preserve selection and return focus in compact views. Remove from project retains the Session; Delete Session and Delete project keep their distinct confirmations.

Team uses separate roster and selected-child scrollports above the composer at regular widths. In stacked mode the Team view owns their scroll; at 700px the selected-child inspector uses the compact panel. The scroll-to-top action lives on the composer caption row. Its tooltip opens toward the caption, within a reserved inline slot and outside both scrollports and the composer field. Hover and keyboard focus use the same geometry without moving the caption. The blocker summary and inspector cards share a 16px content inset. Preserve long progress text, row selection, the keyboard path to the last member, and the selected child's request boundary.

Use the Desktop modal shell for a named title, compact header actions, visible Close, scrollable content and, where needed, a footer. Keep inner navigation and confirmation actions keyboard reachable. MCP shows state beside the server name, groups actions at the trailing edge or below, and nests the resource cards within that server. Connect providers uses a bounded vertical registry with separate wrapping name and identifier lines. At regular widths the registry stays visible while the dialog scrolls through authorization details; at compact widths it returns to flow above the detail. Use 16px card insets and an 8px minimum input-to-action gap for Add provider. Keep focus visible and restore it on dismissal; reduced motion preserves that interaction without travel.

### Bridge gaps

Expose only operations supported by the Desktop backend connection. The Git diff viewer does not stage, discard or commit files. Report unavailable data and actions without simulating them.

## Accessibility

Keep semantic landmarks, names, visible focus and keyboard operation. Normal text retains 4.5:1 contrast and meaningful non-text affordances 3:1; status uses a name or glyph as well as color. Long content remains available and readable in expanded groups. Keep forced-colors system rendering and existing high-contrast schemes. No collapsing transition may leave invisible focusable descendants or hide a required error/action. Browser emulation does not establish native accessibility or device behavior.

## Verification

`SCENARIOS.md` maps populated layout, execution hierarchy, long-content containment, Project sizing and motion to selected local tests and separate native observations. Record before/after wide and compact screenshots plus relevant DOM widths, gutters, centers and scrollbar geometry. Use existing synthetic sessions and managed data for isolated QA; do not mutate a live backend or use real provider accounts to populate validation states.

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
