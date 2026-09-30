---
version: alpha
name: YCoding web
description: Shared public site and remote workspace presentation of the local terminal-first runtime.
surface: web
extends: ../../DESIGN.md
colors:
  green: "#27d17f"
  green-strong: "#0a7b47"
  green-soft: "rgba(39, 209, 127, 0.12)"
  primary-bg: "#0b8550"
  primary-fg: "#ffffff"
  yellow: "#f4bd3d"
  yellow-strong: "#946200"
  yellow-soft: "rgba(244, 189, 61, 0.16)"
  danger: "#c53a3a"
  danger-soft: "rgba(197, 58, 58, 0.1)"
  focus: "#0b8b50"
  bg: "#ffffff"
  surface: "#f7f9f8"
  surface-sunken: "#eff3f1"
  surface-raised: "#ffffff"
  text: "#0b0f14"
  text-muted: "#5c6672"
  text-subtle: "#646d78"
  border: "#e4e8e6"
  border-strong: "#78847e"
  terminal-bg: "#0c1413"
  terminal-fg: "#d8e6de"
  terminal-dim: "#8fa79b"
  terminal-accent: "#5fe3a1"
typography:
  font-sans: '"Geist", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
  font-mono: '"Geist Mono", ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, monospace'
  size-2xs: 12px
  leading-2xs: 16px
  size-xs: 13px
  leading-xs: 20px
  size-sm: 14px
  leading-sm: 22px
  size-md: 16px
  leading-md: 26px
  size-lg: 18px
  leading-lg: 28px
  size-xl: 20px
  leading-xl: 30px
  size-2xl: 24px
  leading-2xl: 32px
  size-3xl: 30px
  leading-3xl: 38px
  size-4xl: 36px
  leading-4xl: 42px
  size-display: 40px
  leading-display: 44px
  weight-regular: 400
  weight-medium: 500
  weight-semibold: 600
  weight-bold: 700
  tracking-tight: -0.02em
  tracking-wide: 0.06em
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 24px
  "8": 32px
  "10": 40px
  "12": 48px
  "16": 64px
  "20": 80px
rounded:
  sm: 6px
  md: 10px
  lg: 14px
  xl: 20px
  pill: 999px
elevation:
  sm: "0 1px 2px rgba(11, 15, 20, 0.06)"
  md: "0 8px 24px rgba(11, 15, 20, 0.08)"
  lg: "0 20px 48px rgba(11, 15, 20, 0.16)"
  focus-ring: "0 0 0 2px var(--yc-bg), 0 0 0 4px var(--yc-focus)"
controls:
  control-h: 44px
  control-h-dense: 36px
  hit-min: 44px
  control-pad-x: 16px
  border-width: 1px
  scrollbar-size: 12px
cursors:
  surface: default
  action: pointer
  text: text
  disabled: not-allowed
  busy: progress
  pan: grab
  panning: grabbing
  zoom-in: zoom-in
  adjust-x: ew-resize
  resize-y: ns-resize
layout:
  measure: 68ch
  measure-narrow: 54ch
  header-h: 60px
  header-session-h: 44px
  status-strip-h: 36px
  bottom-nav-h: 56px
  content-max: 1200px
  rail-w: 288px
  docs-nav-w: 248px
  docs-toc-w: 200px
  device-max: 180px
  gutter: 16px
motion:
  duration:
    instant: 80ms
    quick: 140ms
    base: 220ms
    slow: 320ms
  easing:
    standard: "cubic-bezier(0.2, 0, 0, 1)"
    entrance: "cubic-bezier(0, 0, 0.2, 1)"
    exit: "cubic-bezier(0.4, 0, 1, 1)"
layers:
  header: 30
  nav: 20
  scrim: 90
  overlay: 100
  toast: 110
breakpoints:
  compact: 360
  phone: 480
  small: 640
  tablet: 768
  desktop: 1024
  wide: 1280
  expansive: 1600
devices:
  phone:
    width: 390
    height: 844
    pointer: coarse
    hover: false
    dpr: 3
  desktop:
    width: 1440
    height: 900
    pointer: fine
    hover: true
    dpr: 1
themes:
  dark:
    colors:
      green: "#27d17f"
      green-strong: "#4ee29b"
      green-soft: "rgba(39, 209, 127, 0.16)"
      primary-bg: "#4ee29b"
      primary-fg: "#04150c"
      yellow-strong: "#f7d37c"
      yellow-soft: "rgba(244, 189, 61, 0.14)"
      danger: "#ef6f6f"
      danger-soft: "rgba(239, 111, 111, 0.14)"
      focus: "#4ee29b"
      bg: "#0b1115"
      surface: "#11181d"
      surface-sunken: "#0e151a"
      surface-raised: "#151e24"
      text: "#f4f7f6"
      text-muted: "#99a2ad"
      text-subtle: "#7d8792"
      border: "#263039"
      border-strong: "#718278"
    elevation:
      sm: "0 1px 2px rgba(0, 0, 0, 0.4)"
      md: "0 10px 30px rgba(0, 0, 0, 0.45)"
      lg: "0 24px 56px rgba(0, 0, 0, 0.55)"
---

# YCoding web design rules

## Overview

This surface inherits `../../DESIGN.md`: the public site and the authenticated remote workspace share light/dark semantic tokens but present distinct density. Values are transcribed from `src/styles/tokens.css`; its referenced `.aphrodite/redesign-audit/specs/tokens.toon` is absent, so that file cannot serve as an authority. `src/styles/base.css` owns shared primitives; `site.css`, `docs.css`, `remote.css`, and `src/remote/ui/*.css` own composition.

## Principles

- Keep the TUI's Session behaviors while adapting the presentation to web navigation and responsive controls (`docs/product-direction.md`, `docs/runtime.md`).
- Separate invariant control/type geometry from compositional gutter/display steps (`src/styles/tokens.css`, `src/styles/tokens.test.ts`).
- Use semantic colors rather than a raw brand SVG color as a button surface; the primary has its own theme-specific ink (`src/styles/contrast.test.ts`).

## Rules

Inherited R1–R8 apply. These web-specific rules are approved binding statements:

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| W1 | approved | Web CSS MUST use the declared `--yc-*` theme roles and fixed breakpoint steps; documented base and dark token values MUST agree with `tokens.css`. | `src/styles/design-md.test.ts`, `src/styles/tokens.test.ts` |
| W2 | approved | Primary actions MUST use `--yc-primary-bg` and `--yc-primary-fg`, NEVER the foreground green for the surface; normal-size labels MUST reach 4.5:1 in both themes. | `src/styles/contrast.test.ts` |
| W3 | approved | Dense controls MUST become 44px on coarse pointers; gutter/display overrides MUST follow the steps below rather than viewport interpolation. | `src/styles/tokens.test.ts` |
| W4 | approved | Loading placeholders MUST wait 140 ms, reserve region-specific geometry, and remain static under reduced motion. | `verify/loading.integration.test.ts` |
| W5 | approved | The Running and recent carousel MUST reserve its initial height and show at most ten roots; it and the Session list MUST order running families first, then descending reported activity time within each group, using updated time only when activity is unreported and a stable Session ID tie-break. Pins MUST NOT override that activity order. Status and activity updates MUST refresh order without clearing resident rows. Pagination MUST follow the same sort keys; carousel pagination appears only on overflow. | `verify/running-sessions.integration.test.ts`, `test/remote-session.test.ts`, `../../packages/cli/test/remote-operations.test.ts` |
| W6 | approved | User transcript bubbles MUST be right-aligned; assistant content MUST remain left-aligned, and history paging MUST preserve the visible row. Streaming Markdown MUST retain blocks and inline nodes while their position and semantic kind stay unchanged; growing content MUST remain live without remounting code controls or losing focus. Background snapshots, unchanged todos, and captured-file rereads MUST preserve the reader's message anchor and deliberate scroll-up; captured paths MUST retain their row, expansion, and focused control while refreshed counts and patches remain live. Latest-follow MUST still track real content growth. | `verify/transcript.integration.test.ts`, `verify/transcript-stability.integration.test.ts` |
| W7 | approved | Fine-pointer scrollbars MUST use the owned treatment: a 12px gutter with a transparent track and corner, no arrow buttons, and a pill thumb 4px wide at rest in `--yc-border-strong` that widens to 8px under the pointer (`--yc-text-muted`) and while dragged (`--yc-green-strong`); coarse pointers and forced colors MUST keep platform scrollbars. From 768px with a fine pointer, primary scroll regions MUST reserve the gutter so overflow never shifts content, and Conversation rows outside the scroller MUST stop at the scroller's content edge while full-width bands reach the window edge. | `verify/scrollbar.integration.test.ts`, `src/styles/contrast.test.ts` |
| W8 | approved | Popovers MUST appear beside their triggers without losing focus return, including portalled ones; sheets/dialogs MUST keep keyboard focus contained. | `verify/status-panel-motion.integration.test.ts`, `verify/composer-controls.integration.test.ts` |
| W9 | approved | In the light theme, the public hero MUST remain neutral without the ambient green glow; the glow belongs to the dark hero only. Composer cards, picker outlines, and neutral circular icon actions MUST have boundaries of at least 3:1 against the white work surface without changing their size or dark-theme treatment. | `verify/light-office.integration.test.ts` |
| W10 | approved | On a tall viewport, the landing hero MUST absorb spare vertical space while keeping its content centered; the capabilities section MUST meet the footer without a blank band in either theme. On short viewports, content MUST keep its natural height and remain scrollable. | `verify/light-office.integration.test.ts` |
| W11 | approved | Settings MUST show the browser or installed-app mode in an App section; show Install App only when native install is offered or supported Apple manual steps apply. Manual instructions MUST use the shared modal as a compact dialog on desktop and sheet on phones, without mimicking platform UI; closing MUST return keyboard focus to the action. | `src/pwa/install.test.ts`, `verify/pwa-install.integration.test.ts` |
| W12 | approved | The desktop Workspaces scroller MUST keep its bottom edge in the visible scrollport, fade only that edge while more items remain below, and clear the fade when the end is reached or the list fits. The fade MUST not intercept pointer input or obscure keyboard focus; forced colors MUST show unfaded content, and reduced motion MUST keep state changes instantaneous. | `verify/workspace-scroll-cue.integration.test.ts` |
| W13 | approved | Every modal sheet or dialog MUST have exactly one named close control at the end of its owning header; the shared `Modal` owns that control in `.overlay__head`, so embedded panel headers MUST NOT repeat the title or close. A standalone panel owns its own title and close. Team places its active count beside that sole title, pads the sheet body by `--yc-space-4`, and scrolls the body with Load older after the task cards in flow. The close target MUST be at least `--yc-hit-min`, and Escape MUST dismiss with focus returned to the trigger. Pointer-opened selector sheets MUST keep the close icon free of an automatic focus outline without blurring it; keyboard activation and subsequent keyboard navigation MUST retain the existing visible focus treatment. Unknown activation and forced-colors rendering MUST retain visible focus. | `verify/team.integration.test.ts`, `verify/modal-close.integration.test.ts` |
| W14 | approved | Settings → Office MUST render only when the shell can show Office, using its phone-layout state. The Notifications table MUST keep channel headers on one line at phone width, center switches under their headers, and contain any horizontal overflow within its own scroll region. | `verify/remote-fidelity.integration.test.ts`, `verify/remote-shell-layout.integration.test.ts` |
| W15 | approved | Office MUST allocate height after visible shell notices, keep its controls and roster reachable, and fit the entire floor. Zoomed views MUST support drag, two-axis wheel/trackpad and focused arrow-key panning within floor bounds. Manual panning MUST suspend following without changing Session selection; browser zoom gestures MUST retain their ordinary behavior. | `verify/office.integration.test.ts`, `verify/office-engine.integration.test.ts` |
| W16 | approved | Setting a goal MUST NOT disable or block the composer: submitting releases the draft at once, one goal request per Session is in flight, and a second `/goal` is refused with its text kept. The composer status row MUST show one Setting goal indicator — a dot trail with words (the compact Setting… below 480px) in the row, the Goal control marked busy and named Setting goal, and an always-mounted polite live region announcing it — that adds no row and leaves the box of the text field, pickers, and action buttons unchanged. Reduced motion MUST remove its entrance and dot animation. A failed or uncertain request MUST return `/goal <text>` to an empty draft with its outcome toast. | `verify/composer-controls.integration.test.ts`, `test/remote-session.test.ts` |
| W17 | approved | The monthly provider distribution MUST expose one accessible legend list whose entries each show the provider, its share, and its exact value in the selected Spend or Tokens metric; it MUST NOT add a second visible table or a View table control. The exact total and its metric unit MUST flow as normal text directly below the donut inside its chart column, never inside the fixed donut hole, and MUST NOT be abbreviated or shrunk to fit; the total, provider names, and amounts MUST stay inside their card at phone, tablet, and desktop widths, wrapping within the card rather than overflowing it. Unreported values MUST stay unreported (never zero), each metric MUST keep its own unit, and switching Spend and Tokens MUST keep the selection and its unit. It uses the existing chart, text, and border tokens with no palette change; the daily chart keeps its own table. While the monthly distribution loads below 1280px, where its body is stacked, its placeholder MUST reserve 400px for the chart, total, and legend; from 1280px, where the body is side by side, it keeps the 280px reserve, and no other chart or the shared loading placeholder changes. | `verify/usage-page.integration.test.ts`, `src/remote/ui/usage-model.test.ts` |
| W18 | approved | Composer suggestions MUST use one anatomy at every width: a panel anchored above the composer field with a visible header titled Suggestions and a named Close control, over one scrolling listbox of options. The panel MUST be bounded by the visual viewport: never taller than the space between the field and the top of the workspace scroll region or visual viewport, 40% of it, or 360px, and never shorter than its 54px header, so Close stays reachable, while an on-screen keyboard cannot leave the panel covering the app or the field. Close and Escape MUST dismiss it and return focus to the field; an outside press MUST dismiss it without taking focus, so the pressed control keeps its focus and its action. Every dismissal MUST leave the draft unchanged, and a dismissed token MUST NOT reopen until its text changes or the cursor moves to another token. A failed file search MUST show the same panel with its error and no options, and MUST dismiss the same way. Choices, file search, and selection MUST behave as before. | `verify/composer-controls.integration.test.ts`, `src/remote/ui/composer-logic.test.ts` |
| W19 | approved | Jump to top and Jump to latest MUST float as one anchored pill at the conversation column's end edge at every width, reserving no layout row. The pill MUST sit above the Todo panel, composer, and pending decisions without covering them, MUST leave the last transcript content reachable by scroll clearance, MUST appear only while a jump is possible, and its targets MUST be at least 36px, 44px on coarse pointers. Follow and jump behavior MUST be unchanged; reduced motion MUST remove its transition. The Sessions screen MUST show the same pill with only Jump to top, at the Sessions content's end edge above the bottom navigation, while that screen is scrolled from its top; the pill MUST NOT show a Jump to latest there, and a Conversation pill MUST NOT show while another screen is active. | `verify/transcript.integration.test.ts`, `verify/remote-navigation.integration.test.ts`, `src/styles/composition.test.ts` |
| W20 | approved | The Edited files card MUST be one collapsible summary at every width: a single header control with icon, title, totals, and chevron, named with its full counts, collapsed by default in one row. Expanding MUST list every file with its counts and its full path as the accessible name, each file expanding to its own diffs, side by side from 768px and unified below. Each prompt-to-next-prompt unit with completed edits MUST have its own card after that unit's last assistant message, with one row per path whose counts sum only that unit's recorded patches and its exactly claimed child stretches; totals MUST NOT carry into a later unit's card, and a card MUST NOT be replaced by a ledger or recovery summary. While the Session runs, only the latest unit's card MUST be hidden. Counts, provenance, and empty or unavailable states MUST match the diffs shown. | `verify/file-change-card.integration.test.ts` |
| W21 | approved | Team MUST be one compact icon control with its active count, named Open Team, beside Notifications in the header at every width. It opens the same Team panel or sheet and returns focus to itself. No Team bar or row exists; the workspace toolbar row appears only where it holds the Conversation and Office switch. | `verify/team.integration.test.ts`, `verify/modal-close.integration.test.ts`, `verify/remote-shell-layout.integration.test.ts` |
| W22 | approved | Selecting Sessions from another screen MUST show the Sessions screen at its top, and selecting Conversation from another screen MUST show the latest message and resume following. Each position MUST be in place before the entering screen is first painted visibly, so no inherited position shows and then jumps. A reader's later deliberate scroll-up MUST NOT be forced back, and filters, paging, and switching the selected Session inside a screen MUST NOT reset its scroll. | `verify/remote-navigation.integration.test.ts` |
| W23 | approved | Office MUST NOT show an unexplained empty floor while the selected family's team and activity inputs load: an initial-loading indication MUST be visible and named, a selected Session whose team has not been read yet counts as loading, and unsupported, error, and offline states MUST settle explicitly. The loading placeholder MUST reserve its geometry immediately and show its notice only after 140 ms measured from renderer readiness. Once the initial reads settle, existing members MUST appear directly at their reported workstation or lounge spot with no entrance animation; only a genuinely new arrival on an already-ready floor uses the entrance. Background refreshes MUST preserve the current actors and positions, and after first hydration a background snapshot whose required inputs are still loading MUST be ignored rather than retarget seated members. When a member is idle by backend facts, its leisure is decorative: existing table spots use a slow play or talk-frame rally with a tiny scene-drawn ball between the players present at both ends, and pantry or couch relaxation reuses existing poses, with no invented tool, task, or speech label, no new art asset, and nothing persisted. Any backend non-idle or attention fact MUST stop leisure at once, and reduced motion MUST show a static pose with no ball travel. | `verify/office.integration.test.ts`, `verify/office-engine.integration.test.ts`, `src/remote/office/director.test.ts`, `src/remote/office/model.test.ts` |
| W24 | approved | Transient popups MUST appear only for failed or unknown mutations and for notices that carry actual failure evidence; a successful send, ordinary status, approval, and offline change MUST NOT raise a popup. The notification center, its unread badge, actionable cards, and OS channels remain separate and unchanged by this rule. A failed or unknown popup keeps its safe retry, manual dismiss, six-second expiry, hover and focus pause, and MUST NOT cover the header. A submitted prompt MUST show one inline sending ring at the end of its own text while its own send mutation awaits acknowledgement, with an accessible name, no bubble or composer geometry shift, and a static ring under reduced motion; the ring ends on acknowledgement, and the inline receipt states the outcome. | `verify/remote-shell-layout.integration.test.ts`, `verify/notifications.integration.test.ts`, `verify/composer-controls.integration.test.ts` |
| W25 | approved | The Team panel and sheet MUST be one compact, stable anatomy at every width: tabs (Subagents, Shell, Side chats) that pair an icon, a label, and a count, with active and inactive counts stated separately for subagents; each task row a status mark, title, and model, over four usage slots in fixed order — Tokens, Cost, Context with a meter, and Cache — where a slot still loading, one reported as unreported, and one with a value are three distinct states and unreported is never shown as zero; and compact named controls (Open, Cancel, Answer) sized by `--yc-control-h-dense` (36px, and 44px on coarse pointers) with no size outside the declared tokens. Within a section, rows MUST keep launch-time order and MUST NOT reorder or resize when a status, usage value, or count changes. Only the first load shows a placeholder; refreshes and reconnects MUST retain rows, and older pages load through one compact Load older row after the last card. W13 still governs the sheet's single title, count, and close. | `verify/team.integration.test.ts`, `verify/modal-close.integration.test.ts`, `test/remote-team.test.ts`, `src/remote/ui/team-model.test.ts` |
| W26 | approved | The selected-subagent context bar MUST use one anatomy across widths and remain compact by default: agent identity, a status mark paired with its status word (unreported states say so), named icon-only Main session, Previous subagent, and Next subagent navigation, and a named Subagent details icon. Navigation and details MUST retain owned focus, keyboard activation, and `--yc-control-h-dense` targets (36px, 44px on coarse pointers); absent siblings stay present but disabled. At narrow widths, whole header groups may wrap, but navigation buttons MUST NOT wrap or shrink their touch targets. The details action MUST lazily mount description, Model, Tokens, Cache (hit share with read and write counts), Cost, Context (total over limit), and the full parent title inside the existing shared Modal: a phone bottom sheet or desktop dialog with one Subagent details title, one owned Close control, Escape, trapped focus, and focus return. Details MUST retain every reported value, wrap without horizontal overflow, and never show an unreported value as zero; they MUST NOT expand inline and consume transcript height. Closed details MUST remain unmounted; the shared Modal owns normal/reduced-motion entry, inert exit, and focus semantics. Selection changes MUST dismiss the previous Session's details. A waiting answer form MUST remain outside the Modal and directly actionable. The closed phone bar MUST leave a usable transcript rather than show all descriptive and usage rows by default. The Conversation and Office switch MUST pair an icon with each label in one segmented control of at least `--yc-hit-min` height, keep its sliding selection and waiting-decision mark, and stay reachable by arrow keys. Reuse existing tokens and the shared icon set. | `verify/team.integration.test.ts`, `verify/remote-shell-layout.integration.test.ts`, `verify/office.integration.test.ts`, `src/remote/ui/subagent-bar.test.ts` |
| W27 | approved | Settings → Machine MUST show one Keep machine awake row after the machine picker: a switch named Keep machine awake with a text state label (On, Off, Checking, Unavailable, Unsupported, or Error; never color alone), one polite status line, and an always-visible caveat that it is macOS-only, prevents idle sleep only, not manual sleep or closing the lid, and resets when that machine's YCoding stops or restarts. The switch MUST be enabled only while the selected machine is reachable and its first read has settled to a supported state; while checking, when the machine is unreachable, older, silent, unsupported, or the read failed, it MUST stay disabled and unchecked with an explicit reason (checking, update YCoding on this machine, the reported message, or the failure with Retry) and MUST NOT show Off. A machine that reports an error shows its message and may be retried. A change in flight disables the switch; a failed change keeps the machine's reported state and shows the failure; an unknown outcome is reconciled by exactly one fresh read, is never replayed, and never claims confirmation. The state is read when Settings opens or the machine changes, is never remembered in the browser or re-armed automatically, and no browser wake lock is used. The row reuses `.defs__row`, `.switch`, `.field__hint`, and `.button--secondary` with existing tokens; its `.machine-awake__status` and `.machine-awake__caveat` each take a full flex line, and status tones use `--yc-danger` and `--yc-yellow-strong`. | `src/remote/keep-awake.test.ts`, `test/remote-keep-awake.test.ts`, `verify/keep-awake-settings.integration.test.ts` |
| W28 | approved | A pending guardrail review returned for the selected Session's family MUST be answerable by a human from that view using the backend's existing family authorization; it MUST NOT strand the user behind an owner-Session equality check. Show the owning Session and inspectable, escaped action/target details without requiring blind approval. If neither concrete targets nor an inspectable command is available, disable approval with a missing-context explanation and keep Reject available. Hard reviews MUST retain Human only, Approve once, and Reject, with no Always or automatic reply. Pending sends MUST disable duplicate actions; failed or uncertain outcomes stay explicit and MUST NOT auto-replay. A reply from an obsolete selection MUST NOT remove another Session's request. Floating jump controls MUST NOT cover review actions at phone widths. Reuse existing request-card, token, and focus treatments. | `test/remote-session.test.ts`, `verify/guardrail-family.integration.test.ts` |
| W29 | approved | Team activity MUST combine reported active subagent tasks and actually running shell rows, while task-tab totals stay separate. Exited, timed-out, memory-limited, or killed shells MUST NOT count as running. Until the relevant shell read settles, activity MUST remain qualified as unreported rather than claim an exact zero; truncated loaded activity MUST NOT be presented as an exact total. Canonical backend root-running state MUST drive Session running filters and carousel placement, including live background work, without inventing model execution, generation speed, or a model elapsed-start time. Preserve known activity during same-family refreshes. | `src/remote/ui/team-model.test.ts`, `test/remote-team.test.ts`, `verify/team.integration.test.ts`, `verify/running-sessions.integration.test.ts` |
| W30 | approved | Icon-bearing action controls MUST NOT use green decorative borders, outlines, or focus halos. Their focus role MUST use the neutral `--yc-border-strong` with the existing outline/halo geometry, including shared buttons, Team, navigation, camera, and inline actions. Expanded Team and outlined task actions MUST use transparent or neutral borders. Pending agent/model pickers MUST retain their pending description and use a neutral border with `--yc-green-soft` fill. Preserve semantic green glyphs, filled primary actions, status marks, and selected-item highlights. Keyboard focus MUST remain visible; forced-colors system rendering remains the accessibility exception. | `verify/modal-close.integration.test.ts`, `src/styles/contrast.test.ts` |
| W31 | approved | Cursor roles MUST be defined only by the design system's `cursors` tokens and shared foundation rules. Components MUST consume semantic roles, NEVER introduce cursor keywords, custom cursor images, or document-wide mouse-move cursor handlers. Enabled actions MUST show action, editable/selectable text text, unavailable controls disabled, and busy controls busy; background loading MUST NOT turn usable controls into unavailable cursors. Office MUST show pan on the floor, action on selectable actors, and panning during a drag, restoring the role on release, cancellation, exit, or disposal. | `src/styles/cursors.test.ts`, `src/styles/design-md.test.ts`, `verify/cursors.integration.test.ts`, `verify/office-engine.integration.test.ts` |

## Colors

Green is the single web accent. `--yc-green-strong` is foreground on page, raised, and soft-green surfaces; primary buttons instead use their dedicated pair because white on the bright dark green is only 1.65:1. `--yc-text-subtle` holds AA on sunken surfaces; `--yc-border-strong` holds 3:1 for active boundaries. Terminal plate inks stay constant across themes; semantic page surfaces and shadows change. Sources: `src/styles/tokens.css`, `src/styles/contrast.test.ts`.

In light mode, the new-session and conversation composer use `--yc-border-strong` for their outline and neutral icon/picker boundaries against white. Dark mode retains its existing raised-surface treatment. The install command remains a dark code block in both themes: its constant terminal ink and surface distinguish executable code from page prose. The public hero's ambient green gradient is dark-theme only (`src/styles/site.css`, `src/styles/base.css`, `src/remote/ui/composer.css`, W9).

## Typography

Use `--yc-font-sans` for public titles and prose, `--yc-font-mono` for code and compact remote labels/metadata. Self-host the canonical Geist and Geist Mono normal/italic variable faces from `assets/brand/fonts` with weights 100–900 and `font-display: swap`; Vite owns their hashed URLs. Preserve the platform fallback stacks when a face or glyph is unavailable. Preload normal faces and expose italic prefetch URLs on the public entry without blocking runtime startup; all four URLs enter the existing shell precache discovery. Office waits at most 1500ms for its normal faces, uses Mono for name/cue metadata and Sans for prose/symbols, redraws text after late font settlement, and releases its font wait/listener on disposal. Keep the active DOM BrandMark anatomy. Fixed size/leading pairs run 2xs–4xl; display is 40/44px before 1024px and 56/60px from 1024px, at the measured headline wrap point. Reading measures are 68ch and 54ch (`src/styles/tokens.css`, `src/styles/tokens.test.ts`, `src/styles/remote.css`). Verify faces, roles, fallback, canvas lifetime and render geometry with `src/styles/typography.test.ts` and `verify/typography.integration.test.ts`.

## Layout

### Office open floor

The Office canvas is a continuous shared workspace with varied desk clusters, a perimeter entrance, a furnished lounge, a meeting area and a pantry/coffee corner. Use grouped floor textures and natural circulation instead of a repeated carpet square around every desk. Sixteen disjoint workstation claims preserve stable ownership without drawing a cubicle grid. Desk variants differ in silhouette, monitor arrangement and accessories, not color alone: mix compact and extended worktops, laptops and monitors, books, mugs, plants and personal details. Shared seating and meeting furniture occupy usable floor depth rather than a narrow strip along the bottom. All artwork is original procedural pixel art owned by `script/office-art`; generate assets with `bun script/generate-office-art.ts` from this package.

Editing stays at the owned desk, reading/search at its reference spot, tests/typecheck/lint/commands at its test spot, and coordination at its planning spot. Working characters and routes stay within their claim, with at most twelve tiles between task spots and immediate retargeting when activity changes. Corridors connect claims to shared seating and the entrance without crossing another claim. The visible population is capped at sixteen; additional child tasks are counted outside the scene. Idle agents may rest at their desk or move to the lounge. Delegation and report cues stay at the agents' current workstations. Use compact name-only canvas plates; agent roles, location and full activity remain in the accessible roster. Keep characters legible relative to furniture and stagger name plates and truthful activity bubbles. Preserve stable actor identities, ownership and reduced-motion settling.

At supported tablet and desktop sizes the Office route panel consumes only the remaining height after shell headers and notices. The canvas fills its flexible row above a bounded, scrollable roster on tablets; canvas and independently scrollable roster sit side by side from 1024px. Do not assign an additional full scrollport height below notices or force a canvas minimum that clips controls on short desktops. A phone fixture keeps a minimum usable canvas and may scroll vertically; the real phone shell uses Conversation. Office opens around the selected agent at a working scale of at least 0.65 CSS pixels per world pixel, increased when needed to cover the canvas. Fit contains the entire floor and centers any necessary aspect-ratio margins symmetrically; never crop the lounge in Fit. Wheel and trackpad pan both axes, Shift-wheel pans horizontally, dragging pans, and the focusable floor accepts arrow keys. Keep a visible navigation hint, focus ring and 44px camera controls. Explicit Fit and resize while fitted restore whole-floor containment; manual panning suspends follow until a focus/follow action. Show canvas labels and bubbles only for characters in the visible camera region; the roster retains every family member.

The canvas uses a fixed illustration palette in both shell themes: blue-slate backdrop `#1b2832`, warm wood and textile floors from `environmentTiles`, furniture colors from `environmentFurniture`, dark name plates `#1e2934` with white text, and cream activity plates `#faf7ef` with ink `#253443`. These authored illustration colors are not shell UI tokens. UI chrome uses the existing theme roles. Render 32px tiles and 32×48px character frames with smoothing disabled, rounded world positions and a device-pixel-ratio cap of two. Whole-floor Fit permits fractional zoom to preserve complete content; authored pixels remain nearest-neighbor filtered.

Use the 4px spacing scale, 1200px content maximum, stepped `--yc-gutter`, the declared header row and rail widths, and a connection-strip row that exists only while it has something to say. Center Conversation's transcript and composer as one column; reserve todo and composer space in document flow (`src/styles/remote.css`, `verify/transcript.integration.test.ts`). The owned scrollbar occupies layout space, so from 768px with a fine pointer `.workspace__scroll` reserves its gutter, and Conversation's main grid adds a `--yc-scrollbar-size` end column that only the scroller, the top bar, and the subagent bar span; the todo panel, jump controls, and composer end where the transcript column's content box ends (`src/styles/remote.css`, `verify/scrollbar.integration.test.ts`).

The landing route alone uses a flexible hero before its fixed-height capabilities section. The hero centers its existing content as it grows so a tall viewport adds room around the opening statement rather than a blank strip after the cards; shorter screens retain ordinary page scrolling (`src/styles/site.css`, W10).

## Responsive

The front-matter `breakpoints` are width thresholds in pixels, not CSS declarations. `tokens.css` steps the gutter 16px below 480, 20px at 480, 24px at 640, 32px at 1024, 40px at 1280, and 48px at 1600. At 1024, display size/leading become 56/60px. At `(pointer: coarse)`, dense height becomes 44px independently of width. The 360 and 768 thresholds are composition breakpoints used by surface styles, not token-value overrides. `src/styles/tokens.test.ts` checks the token steps; `verify/design-contract.integration.test.ts` checks representative route geometry.

## Elevation & Depth

Raised cards, overlays, and dialogs use three light/dark shadow steps paired with borders, not shadows alone. `--yc-focus-ring` composes background and focus-color halos; header/nav/scrim/overlay/toast use the declared layer order (`src/styles/tokens.css`, `src/styles/base.css`).

## Shapes

Use 6/10/14/20px rounded steps and the 999px pill for compact controls and chips. Child corners remain subordinate to their container; the remote composer and overlays use the larger surface radius (`src/styles/base.css`, `src/styles/remote.css`, `src/remote/ui/composer.css`).

## Motion

80/140/220/320ms durations and the three declared easings carry feedback and entrance/exit motion. Dismissed overlays become inert before exit finishes; reduced motion removes travel but preserves the state transition (`src/styles/base.css`, `src/remote/ui/loading.css`, `verify/overlay-motion.integration.test.ts`).

## Icons

`src/ui/icon.tsx` owns SVG path meanings, a 24-unit viewBox, 1.6-unit rounded strokes, `currentColor`, and decorative hiding. Icon-only controls need their own accessible names; `src/styles/base.css` and `src/remote/ui/*.css` own their focus and hit areas.

## Components

### Cursor roles

Define cursor values in `tokens.css` and apply DOM roles centrally in `base.css`; all component stylesheets inherit them. Use the action role for links, buttons, disclosure controls, selects, toggles, and their labels or icon children. Text inputs, read-only copyable fields, and selectable prose use text. Native disabled controls, disabled fieldsets, and `aria-disabled` controls use disabled; a control's own busy state, or a disabled control inside its busy region, uses busy without blocking other controls in that region. The surface arrow belongs only to noninteractive surfaces. Image expansion consumes zoom-in, horizontal effort adjustment consumes adjust-x, and the vertical textarea resize handle consumes resize-y.

Use `data-cursor` only when native element semantics cannot express an existing interaction. Dismissible scrims and popover footers consume action while modal contents retain their ordinary roles. The Office renderer consumes CSS variable references for its floor and actor roles and exposes only its drag state to the shared rules; panning overrides actor hover until the drag ends. Preserve native selection, pointer capture, keyboard behavior, and touch behavior. Do not hide or replace the operating system cursor. Cursor roles are identical in both themes; the browser renders the platform glyph for the selected role.

The tokens/states below describe current selectors and owners, not a new component API. Across interactive components, use the owner's rest/hover/active/disabled/focus-visible styles and never make hover the only path to an action.

| Component and purpose | Owner/selectors | Tokens, states, and rule |
| --- | --- | --- |
| Primary, secondary, and small buttons: actions | `src/styles/base.css` `.button`, `--primary`, `--secondary`, `--small`, `[disabled]` | Dedicated primary surface/ink; raised secondary with strong border; dense small height; hover/active/disabled/focus states. W2. |
| Fields and checks: labeled entry/choice | `src/styles/base.css` `.field`, `.input`, `.select`, `.textarea`, `.check` | Surface, strong border, muted hint, danger error, focus halo; placeholder, invalid, checked, disabled states. R2/R8. |
| Invite acceptance and access-key sign-in: single-use entry | `src/remote/ui/invite.tsx`, `shell.tsx`; `src/styles/remote.css` `.sign-in`, `.sign-in__panel`, `.sign-in__error`; shared `.field`, `.input`, `.button` | Centered raised panel; fragment removed before display; accept-only redemption, invalid and pending states, once-only key reveal with Copy and Continue; labeled key input, explicit invalid/rate-limited/retry errors; light/dark and phone/desktop use shared tokens. R2/R8. |
| Switches: boolean choice | `src/styles/base.css` `.switch` | Pill radius, border and green checked track; checked/focus states. R8. |
| Segmented controls: mutually exclusive view choice | `src/styles/remote.css` `.presentation-switch.filters`, `.appearance-segments .filters`, `.filters__option--active` | Surface/green roles and pill controls; selected and keyboard-focus states. R8. |
| Chips, pills, status: compact state labels | `src/styles/base.css` `.chip`, `.tag`, `.status-dot`; `src/remote/ui/status-bar.css` `.session-status__slot`; `src/remote/view-model.ts` `sessionStateChips` | Green/yellow/danger soft fills, semantic text, pill radius; status also needs words. A Session whose only attention reason is a failed run shows a neutral Failed chip first and no attention dot, until it runs again. R8. |
| Portalled popovers and panels: local choices/details | `src/remote/ui/status-bar.tsx`, `model-control.tsx`, `composer-picker.tsx`; `status-bar.css` `.session-status__popover`, `src/styles/base.css` `.panel` | Raised surface, border, XL radius, large shadow, overlay layer; enter/exit/inert, anchored to trigger with focus return. R4/W8. |
| Sheets and overlays: contained mobile or modal decisions | `src/styles/base.css` `.overlay`, `.overlay--sheet`, `.overlay__close`; `src/remote/ui/composer.css` `.composer__selection-sheet`; `src/ui/modal.tsx`; `src/remote/ui/team-view.tsx` `.team-view__heading`, `team-view.css` `.team-view__sheet` | Raised surface, scrim/overlay layers, large radius, safe-area and `--yc-space-4` Team body padding; one named owning-header title, active count, and close of at least `--yc-hit-min`, scrolling Team body with Load older in flow, Escape, focus return and trapped focus. W8/W11/W13. |
| Settings: responsive Office and notification choices | `src/remote/ui/shell.tsx` `SettingsPage`; `src/remote/ui/settings.tsx` `.notification-table`; `src/styles/remote.css` `.notification-table` | Office choices mount only when the same shell layout permits Office. Phone notification headers remain unbroken; switches align with their channel columns, and the shared `.table-scroll` contains overflow. The Machine section's Keep machine awake row is one `.defs__row` with the `.switch`, a text state label, a polite status line, and the idle-sleep caveat (W27). Push to this device holds only the toggle/Re-enable control and one polite `.field__hint` status, with no Send test alert UI. Test pushes are operator-only through the admin Bearer API; browser UI MUST NOT handle admin keys. W14/W27. |
| App installation: Settings mode and manual steps | `src/remote/ui/settings.tsx` `.settings__section`, `.defs__row`, `.defs__key`, `.defs__value`; `src/pwa/install-button.tsx`; shared `.button--secondary`, `src/ui/modal.tsx` `.overlay`, `.overlay__body`; `src/styles/docs.css` `.steps`, `.steps__item`, `.steps__text`; `src/styles/remote.css` `.overlay--pwa-install .overlay__body` | Existing Settings spacing and typography, browser/installed text status, conditional action, numbered steps and token padding, responsive modal/sheet and trapped focus. W9. |
| Workspaces scroll cue: more items below | `src/remote/ui/shell.tsx` `.workspace-nav`; `src/styles/remote.css` `.workspace-nav[data-more-below]` | The scroller's available height is measured against the visible scrollport; a bottom-only alpha mask spans `--yc-space-6`, scroll-padding protects focused rows, no overlay hit target or transition, and no mask in forced colors. W10. |
| Cards: grouped information | `src/styles/base.css` `.card`, `.card--quiet`; `src/remote/ui/running-sessions.css` `.running-sessions__item` | Raised surface/border/radius, optional shadow; selected/hover/focus states only when interactive. W5. |
| Tables: dense comparable data | `src/styles/base.css` `.table-scroll`; `src/remote/ui/transcript.css` `.transcript-md table`; `src/remote/ui/usage.css` | Border, spacing, text roles; contained horizontal scrolling and focus. R8. |
| Subagent context bar and view switch: where you are and how to move | `src/remote/ui/subagent-bar.tsx`, `subagent-bar.css` `.subagent-bar__*`; `src/ui/modal.tsx`; `src/remote/ui/shell.tsx` `PresentationSwitch`; `src/styles/remote.css` `.presentation-switch` | Raised compact identity/status bar, dense named navigation and Subagent details icon; lazy description, wrapping reported metric cells, and full parent title in the shared phone sheet/desktop dialog with one title/close, Escape, focus trap/return, and inert exit. Waiting answers remain in the bar. Whole header groups may wrap, never navigation controls; shared control-height, spacing, focus, and motion tokens retain 44px coarse targets and a usable phone transcript. The segmented Conversation/Office switch retains its labelled icons, sliding selection, and waiting mark. W26. |
| Team panel: subagents, shells, and side chats | `src/remote/ui/team-view.tsx`, `team-view.css` `.team-view__*`, `team-model.ts` `usageSlots`, `taskRows` | Icon, label, and count tabs; status mark, title, and model per row; four fixed usage slots with a context meter and separate loading, unreported, and value states; compact Open, Cancel, and Answer controls at `--yc-control-h-dense`; stable launch-time order; first-load placeholder only; one Load older row. W13/W25. |
| Workspace navigation: destinations | `src/remote/ui/shell.tsx` `RemoteHeader` `.remote-nav`, `BottomNav`; `src/styles/remote.css` `.bottom-nav` | Sessions, Conversation, Usage, and Settings only, in header links from 768px and one row of four bottom-bar icon targets below it; the Sessions and Conversation marks appear only for a decision the user can answer, never for a failed run. R8. |
| Connection strip: connection state with a recovery action | `src/remote/ui/shell.tsx` `ConnectionStrip`, `connectionStripView`; `src/styles/base.css` `.status-strip` | Absent while the connection is healthy, because the header connection label already states it: visible text from 1024px, and below that the tone dot with the label kept for assistive technology. Connecting, offline, signed-out, unavailable, and error states show tone-coloured text with Reconnect or Open settings; the app grid drops the row while it is absent and popover heights follow. R8/W8. |
| Notification center: unread list and Read all | `src/remote/ui/notifications.tsx` `NotificationCenter`; `src/remote/ui/notifications.css` `.yc-notification-panel`, `.yc-notification` | Every listed notice is unread: the bell badge counts all stored unread rows, including categories muted in app, and each visible row keeps its unread dot. Opening the panel never clears a notice; a row leaves only through its dismiss control, by opening its Session, or through the header Read all icon button (`check-all` icon, accessible name "Read all", 44px target on a coarse pointer). Older pages use Load more even when the current page has no visible rows; storage errors keep a visible retry and do not present an empty list as fully synced. R8. |
| Notices and toasts: feedback and recovery | `src/styles/base.css` `.notice-strip`; `src/remote/ui/notifications.css` `.yc-toasts`, `.yc-toast`; `src/remote/ui/toast.tsx` | One toast layer below the header and, with a selected Session, below the workspace toolbar row while it is shown, so no header control is covered. It holds at most three toasts, composer outcomes first and notifications after, newest first. Popups appear only for failed or unknown mutations and for notices with actual failure evidence; the notification center, unread badge, actionable cards, and OS channels are separate. Every toast dismisses after six seconds, pauses while hovered or focused, exits over the base duration, and keeps a dismiss button and keyboard focus. Outcome unknown uses yellow and Failed danger; raised surfaces. R8/W24. |
| Loading placeholders: async occupancy | `src/remote/ui/loading.tsx`, `loading.css` `.loading-placeholder` | Raised/sunken/border, fixed geometry per region; 140ms reveal, static reduced-motion state. R3/W4. |
| Running and recent carousel: cross-workspace roots | `src/remote/ui/running-sessions.tsx`, `running-sessions.css` `.running-sessions` | Card border/radius, green running dot, snap rail/dots; loading/empty/overflow/selection. Idle cards show terminal `time.active` as Last active or Last active not reported when absent. W5. |
| Transcript bubbles: authored messages | `src/remote/ui/transcript.css` `.transcript-message--user`, `--assistant`, `__bubble` | Raised background, strong border, radius, text/metadata roles; streaming/read/failed/paged states. W6. |
| File-change card: captured edit/patch diffs grouped by path | `src/remote/ui/file-change-card.tsx`, `file-change-card.css` `.file-change-card`, `__diff` | Raised card filling the conversation column, green/danger counts matching every expanded diff, one card per prompt unit after that unit's last assistant message, sunken headings; one collapsed summary row at every width that expands to every file, each file expanding to split (768px and wider) or unified (narrower) diffs, unavailable patch state. W20. `verify/file-change-card.integration.test.ts`. |
| Usage provider distribution: month-to-date share by provider | `src/remote/ui/usage.tsx`, `usage.css` `.usage-distribution`, `.usage-donut`, `.usage-provider` | One donut with a Spend/Tokens metric switch and one legend list of provider, share, and exact value; no duplicate table or View table control. The exact total and unit flow in normal text below the donut in its chart column, outside the fixed hole, at the existing `--yc-size-xl` total and `--yc-size-2xs` unit sizes with the 200px chart width unchanged; total and legend text stay inside the card at every width, unknown values render as unreported, and existing tokens supply every color. While loading below 1280px (stacked body) the monthly placeholder reserves 400px for chart, total, and legend, and 280px from 1280px; other charts and the shared placeholder are unchanged. W17. |
| Composer suggestions: command, file, agent, and skill choices | `src/remote/ui/composer.tsx`, `composer.css` `.mini-composer__autocomplete`, `composer-logic.ts` `autocompleteBound`, `suggestionTrigger` | Raised XL-radius panel with a Suggestions header, Close, and a scrolling listbox anchored above the field; height bounded by the visual viewport, active/hover soft green, 44px option rows on coarse pointers, dismissal that survives an unchanged token; Close and Escape return focus to the field and an outside press leaves focus with the pressed control. W18. |
| Conversation jump controls: return to top or latest | `src/remote/ui/transcript-nav.tsx`, `transcript-nav.css` `.transcript-navigation__controls`; `src/styles/remote.css` `.conversation-jump-slot` | Raised pill with strong border and medium shadow, floating at the column's end edge above Todo and composer with no layout row (on Sessions, the same pill with only Jump to top at the content's end edge); muted ghost arrow buttons, green hover, focus ring, 36px (44px coarse) targets, scroll clearance under the last content. W19. Entry positions for Sessions (top) and Conversation (latest): W22. |
| Team trigger: open the Team panel or sheet | `src/remote/ui/shell.tsx` `RemoteHeader` `.app-header__team`; `src/ui/icon.tsx` `team` | Ghost icon control with the active count in the header end group, green expanded state, 44px on coarse pointers, `aria-label` Open Team and the count as its description. W21. |
| Focus ring: keyboard location | `src/styles/base.css` `:focus-visible`, field focus, remote controls | Focus color/halo and 2px outline/offset; visible on each interactive state. R8. |
| Office floor and navigation | `src/remote/office/OfficeCanvas.tsx`, `office.css`, `OfficeScene.ts` | Flexible remaining-height canvas, fixed illustration palette, existing camera icons and 44px targets, muted navigation hint, inset focus outline, wheel/drag/arrow panning, compact name plates and an independently scrollable DOM roster. Initial loading (a selected Session with no team read yet included) is named and visible, its notice appears 140 ms after renderer readiness while the placeholder geometry is reserved at once, existing members appear in place, background snapshots with unfinished inputs never retarget seated members, idle leisure is decorative with the scene-drawn ball and reused poses, and reduced motion is static. W15/W23. |
| Icons: action/status symbols | `src/ui/icon.tsx` `Icon` | `currentColor`, rounded stroke, 24-unit viewBox; decorative hidden, icon-only control named. R8. |
| Scrollbar: owned fine-pointer scroll affordance | `src/styles/base.css` `::-webkit-scrollbar*` and the Firefox standard-property fallback; `src/styles/remote.css` gutter and Conversation grid rules; `.running-sessions__list` and `.transcript-navigation__ticks` hide their rails with alternate pagination/navigation | `--yc-scrollbar-size` 12px; transparent track/corner, no arrows, 4px pill at rest (`--yc-border-strong`) inset by `--yc-space-1`, 8px hover (`--yc-text-muted`) and drag (`--yc-green-strong`), minimum length `--yc-space-8`, every state ≥3:1 on page, surface, raised, sunken, and terminal backgrounds. Chromium and WebKit use the pseudo-elements; Firefox gets thin scrollbars in the rest color on a transparent track because a non-auto `scrollbar-color` would switch the pseudo-elements off elsewhere; coarse pointers keep transient native indicators and forced colors keep system scrollbars. W7. |

## Content

The composer keeps per-model effort choices only within its current target's lifetime; the existing preferred-model reference supplies only workspace/new-Session defaults. An existing Session without an explicit model displays the machine catalog's base default, never the stored new-Session preference. An unread Session or unreported machine default stays unreported and blocks model-dependent sends until its authority is known or a valid choice is explicit. An omitted variant is Base, not the first offered effort or an inferred provider default. Base is a neutral slider stop before offered variants, uses `--yc-text-muted`, and sends no variant. Reset explicitly selects Base and clears that model's prior remembered effort. Every model trigger, effort hero, slider, and next-send intent agrees. An unavailable saved effort displays its value, hides the misleading slider, and blocks model-dependent sends until the user explicitly chooses Base or an offered effort, without rewriting the stored Session on read. Matching effective Session selection releases a local override; mismatching reads preserve the pending choice, and later external selections own ordinary sends. Failed switches retain the draft and admit no prompt. Fast counterparts retain effort only when offered, otherwise omit it; models with no effort omit it. Diagnostics keep their actual model reference and unknown values (`verify/model-replay.integration.test.ts`).

The Session creation action uses one compact plus-icon button named and titled New session in both the sidebar and list. Keep its existing creation route, keyboard focus, and 44px coarse-pointer target. Assistant messages show the green agent heading only when a non-whitespace text reply is present; tool-only and thought-only messages retain their metadata footer without that heading. The selected-subagent bar starts with identity, readable status, named icon navigation, and Subagent details; description, all reported usage, and full parent title lazily open in the existing Modal sheet/dialog rather than expand the footer, while a waiting answer remains directly available. Selection changes dismiss stale details; retain full identity and usable transcript space at phone widths. Reuse existing control, spacing, focus, and Modal tokens (`verify/transcript-stability.integration.test.ts`, `verify/team.integration.test.ts`).

Use concise action labels and explicit pending, error, and unknown states. On remote screens, distinguish account, machine, Session, and child status; unknown provider quotas are unreported, not zero. The carousel orders active roots before recent idle roots; file-change counts match every expanded diff and belong to one prompt unit (`docs/runtime.md`, `verify/running-sessions.integration.test.ts`, `verify/file-change-card.integration.test.ts`).

## Mutation feedback

Composer mutations raise a toast in the shared toast layer only for failed and unknown outcomes, with danger and warning roles; a successful send raises none and shows its inline receipt and, while its own request awaits acknowledgement, the end-of-text sending ring (W24). Toasts dismiss like notification toasts, after six seconds unless hovered or focused, and keep a manual dismiss button; Failed and Outcome unknown are announced as alerts. Failed and unknown prompts retain an actionable status on their transcript message; a retry reuses its message identity. Reduced motion removes toast travel and exit animation without hiding the outcome or changing its timing. An admitted steer displays Processing until promotion; a queued input displays Queued until promotion. The composer status row names an active goal without relying on color or an opened popover, and shows and announces Setting goal while the selected Session's goal request is in flight, without blocking the composer (W16; `verify/composer-controls.integration.test.ts`, `verify/remote-shell-layout.integration.test.ts`).

The execution status slot counts down a scheduled retry for the latest unfinished assistant step. After the deadline, it says Retrying only until that step produces text, reasoning, or tool progress; a completed step or a non-running Session uses its ordinary state instead (`verify/composer-controls.integration.test.ts`).

## Touchpoints

Public routes, documentation, changelog, remote workspace, offline shell, installed app icons, and browser theme-color use the same semantics but their route compositions remain owned by `site.css`, `docs.css`, `remote.css`, and the app shell. Use the canonical mark variants in `../../assets/brand` rather than a screenshot-derived approximation (`verify/pwa-shell.integration.test.ts`, `../../assets/brand/README.md`).

## Accessibility

Inherit the brand floors. Primary normal-size button text needs 4.5:1; active boundaries/focus need 3:1 across every surface they occupy (`src/styles/contrast.test.ts`). Keyboard focus and overlay behavior require real rendered review. At installed-app zoom lock, test legibility/reflow separately; do not claim magnification support. Preserve native selection, focus behavior, coarse-pointer hit areas, reduced-motion state, and forced-colors system scrollbar rendering.

## Verification

W1/W3: `bun test src/styles` from `apps/web`, including `design-md.test.ts` and `tokens.test.ts`. W2: `contrast.test.ts`. W4–W8: named `verify/*.integration.test.ts` with a configured Chrome executable; those are not part of `bun run test:web`. W7's thumb contrast runs in `contrast.test.ts`; its rendering runs in `verify/scrollbar.integration.test.ts`, the one suite that launches Chrome with visible scrollbars (`launchBrowser(..., { scrollbars: true })`). The other suites pass `--hide-scrollbars`, which hides custom scrollbars but still reserves `scrollbar-gutter`, so their geometry includes the gutter. Lint this chain with `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint apps/web/DESIGN.md`; `git diff --check` guards whitespace only.

W31: `src/styles/cursors.test.ts` enforces shared cursor ownership, `design-md.test.ts` checks cursor token drift, and `verify/cursors.integration.test.ts` checks both themes, native control states, disabled fieldset legend exceptions, image expansion, sliders, and public/remote consumers. `verify/office-engine.integration.test.ts` checks real floor/actor hover and drag transitions. Browser checks assert computed cursor roles; they do not capture native operating-system cursor artwork.

## Maintenance

Read `../../DESIGN.md` and this file before UI changes. Add or revise a rule first, obtain approval for changed values or behavior, then update tokens/components, affected tests, and documentation together. `src/styles/design-md.test.ts` fails when any documented `--yc-*` value or any root/dark CSS declaration differs in either direction; responsive/pointer overrides are separately held by `src/styles/tokens.test.ts`. Record same-role conflicts as pending exceptions rather than silently selecting a winner.

## Do's and Don'ts

- Do compose from existing semantic colors and control geometry; check light/dark, coarse/fine, keyboard, loading, reduced motion, and route resize.
- Don't copy generated Stitch colors, assume a token contrast check proves all rendered states, or hide native control behavior to get a custom look.

## Exceptions

| Rule | Scope | Reason | Approval | Review date |
| --- | --- | --- | --- | --- |
| R2 | `src/remote/ui/transcript.css` rendered Markdown checkbox and other native controls | No complete owned-style audit of all generated content; behavior/accessibility must be preserved while appearance is reviewed. | pending | 2026-10-29 |
