# R0-07 — Compare every supplied visual reference

Lane D (analyst). Model: openrouter/deepseek-v4.1-flash#high.
Source revision: `a4bb99e` (`main`), dirty state: `?? ycoding-office-repair-kit/` only.
Repository source is READ-ONLY for this note; nothing outside this kit was modified.

Evidence classes used below, per AGENTS.md:
- `observed_in_supplied_image` — measured directly from the supplied PNG (vision).
- `inference_from_written_docs` — derived from REQUEST.md / ADDENDUM.md / README / INLINE_REFERENCES / REFERENCE_REVIEW.
- `verified_in_checkout` — read in `apps/office/` source.
- `calculated` — deterministic arithmetic over live constants (no Godot run in this lane).
- `deferred` — needs a live render that does not exist yet.
- `verified_at_runtime` — measured from `evidence/r0-02-native-launch-1280x720.png`, a 1280x720
  baseline capture that appeared in `evidence/` while this note was being written (produced by the
  lane that owns the Godot process and this app, revision `a4bb99e`, window 1280x720, DEMO boot).
  Measurements are pixel scans of that PNG, not visual estimates.

---

## 1. Per-image requirements and evidence

### Image 01 — `references/images/01-app-shell-reference.png` (2048x1306)
Direct observations:
- Persistent, opaque, full-height left rail; it is a **docked column**, not a floating card:
  it shares the window's top and bottom edges, and the conversation surface to its right is
  inset from it, not underneath it.
- Rail content is short rows with generous but even vertical rhythm; the header row holds a
  product pill plus two small icon actions; a primary "New chat" row sits directly below.
- Sections are labelled with small dim headings ("Projects", "Recents"); the project list is a
  tree (parent row + indented children).
- A footer strip is pinned to the rail's bottom ("kritthapas Ph…", "Voice", "?").
- Composer: a wide, low, bottom-anchored rounded card, visibly **narrower than the window** and
  horizontally inset inside the content column; the input line is on top with a separate,
  shorter action row beneath (attach `+`, approval affordance left; model + effort center-right;
  send at right).
- Content region is essentially empty and readably expansive; nothing is covered by the rail.

Requirements implied:
1. Rail is persistent and docked; content region is a sibling to its right (REQUEST.md:79-80).
2. Rail is compact: short rows, small labels, contained footer (README.md:7).
3. Content region is expansive/full-height (REQUEST.md:81).
4. Composer is bottom-centred, width-constrained, not full-bleed (REQUEST.md:82; README.md:7).

### Image 02 — `references/images/02-current-ycoding-problem.png` (1600x900)
This image is the **defect exhibit**, not a target. What it presents as broken (observed):
- The sidebar is a **floating rounded card**: it has its own margins on all four sides
  (REFERENCE_REVIEW.md:5 measures the left panel at roughly x=20…762, y=20…880) and office art is
  visible around it rather than the rail occupying a reserved column. REFERENCE_REVIEW.md:7 states
  the same: "the sidebar is a floating card rather than a disciplined application rail".
- The composer is a large floating card over the office's lower-right, not inset in a content
  column; together they "obscure much of the scene" (REFERENCE_REVIEW.md:5).
- Controls and text are oversized relative to the card: "large text and tall controls dominate;
  composer height/width is out of proportion to its small content; model text is truncated while
  large unused space remains" (REFERENCE_REVIEW.md:7).
- A prominent "DEMO" badge and "Synthetic playback — no runtime work is executed" label are
  surfaced as problems (README.md:8 "synthetic mode"; ADDENDUM.md:9 "demo startup" superseded).
- A top-right control runs past the image edge (REFERENCE_REVIEW.md:7).

Requirement implied (the inverse): a docked compact rail, an inset bottom composer, normal
control scale, and no demo-first startup.

`calculated` corroboration that this image is the *current code at text scale 2.0*: applying the
live constants with the project's `canvas_items` / `expand` stretch (project.godot
`window/size/viewport_width=1280 height=720`, so a 1600x900 physical window is a x1.25 factor)
gives sidebar x=20..762 and composer x=778..1580, y=560..850 at scale 2.0 — matching
REFERENCE_REVIEW.md:5's measured `x=20…762` / `x=780…1580, y=560…850`. At scale 1.0 the sidebar
would be only 20..391. This is arithmetic on `OfficeShellLayout` constants, not a render.

`verified_at_runtime` corroboration: the scale-1.0 baseline capture
(`evidence/r0-02-native-launch-1280x720.png`) reproduces every structural defect image 02 shows —
floating rail card, office art visible around it, a floating composer taller than its reserved box,
DEMO prominence. The scale-2.0 inference is therefore not load-bearing for the findings; it only
explains why image 02's controls look disproportionately large (REFERENCE_REVIEW.md:7).

### Image 03 — `references/images/03-model-effort-reference.png` (532x208)
Direct observations:
- A compact popover card (~532x208), not a full-width control.
- Top line: small glyph at left, current effort value centred in an accent hue with a `>` chevron,
  a reset glyph at right.
- Second line: the model name, centred, smaller and dimmer than the effort value.
- A single horizontal track with a filled leading segment, a raised round knob, and 4 small dot
  stops; the knob's position encodes the value.

Requirements implied: compact model+effort control with a two-level hierarchy (state above model)
and stop count taken from the model, not a fixed ladder (README.md:9 "Compact selection and
hierarchy; no hardcoded model names or universal effort levels").

### Image 04 — `references/images/04-sidebar-reference.png` (562x1576)
Direct observations:
- Tall but narrow rail: ~562 wide at ~1576 tall (a zoomed crop, so image pixels are not logical
  units). Icon+label rows are ~44-48 image px high and label text is roughly 24-26 image px; the
  rail is dense relative to its width.
- Only the label column varies in size: small dim group headings, a full-width row highlight, and
  no decorative chrome beyond hairlines.
- Rows: inline glyph, label, trailing icon; the active row is a filled pill spanning the rail
  width; an indented child row ("test") below it.
- Grouped, small, dim headings ("Projects", "Recents") with real vertical separation.
- Footer pinned at the very bottom edge, separated by a hairline: avatar + truncated name at left,
  icon+label items at right, and a trailing `?`.
- The whole rail is one flat surface with no outer rounded card/margin — it reaches the window
  edges.

Requirements implied: dense compact navigation, grouped sections, contained pinned footer,
restrained control scale (README.md:10 "Grouping, density, pinned footer"; but "do not invent PR,
voice, account or schedule functionality").

### Image 05 — `references/images/05-composer-reference.png` (1516x230)
Direct observations:
- A wide, short rounded card: ~1516x230 at 2x-ish density, i.e. roughly 100-115 logical px tall
  and clearly wider than tall.
- Top area is the input: placeholder "Do anything" near the top-left with a caret, and the input
  area occupies roughly the upper 60% of the card's height — i.e. it is a **multi-line-capable**
  field, not a one-line box.
- A separate, shorter action row at the bottom: `+` at far left, "Ask for approval" beside it,
  then a large empty gap, then "GPT-5.6 Luna Medium ⌄" at right, a mic glyph, and a filled
  circular send button.
- The action row is visually subordinate (dimmer text) to the input line.

Requirements implied: multiline input with Enter/Shift+Enter semantics, a compact subordinate
action row, model+permission information in that row, and a bottom-centred width-constrained
placement (README.md:11; REQUEST.md:355-363).

### Image 06 — `references/images/06-settings-reference.png` (2048x1289)
Direct observations:
- A dedicated full-window settings page, not a modal.
- A left navigation column (~300 px) with a back link at top, a search field ("Search settings…"),
  then groups ("Personal", "Integrations", "Coding", "Archived") of icon+label rows; the active
  row is a filled pill.
- A right content column with a page title ("General") then **grouped card sections**
  ("Permissions", "General") of stacked rows; each row is a two-column composition: bold title +
  wrapped dim description at left, control at right (toggle, dropdown, "Change" button, segmented
  Bottom/Right, "View" link).
- Rows are ~60-70 px tall, separated by hairlines; body text ~13-14 px with ~12 px descriptions.
- A row with an external action has a trailing `↗`.

Requirements implied: a settings route with grouped left navigation, real controls wired to state,
readable descriptions, and categories derived from YCoding rather than copied
(README.md:12; INLINE_REFERENCES.md:5; REQUEST.md:174).

---

## 2. Live implementation constants

Source: `apps/office/`. All `verified_in_checkout`.

| Surface | Constant | Value | Path:line |
| --- | --- | --- | --- |
| Sidebar | `SIDEBAR_W` | 272.0 (effective 297.0 via floor) | `ui/shell/office_shell_layout.gd:33` |
| Sidebar | `SIDEBAR_CONTENT_FLOOR` | 297.0 | `ui/shell/office_shell_layout.gd:36` |
| Sidebar | `SIDEBAR_MARGIN` / `SIDEBAR_MARGIN_Y` | 16.0 / 16.0 | `ui/shell/office_shell_layout.gd:37,39` |
| Overlay | `GAP` | 12.0 | `ui/shell/office_shell_layout.gd:41` |
| Composer | `COMPOSER_SHARE` | 0.50 | `ui/shell/office_shell_layout.gd:49` |
| Composer | `COMPOSER_MIN_W` | 460.0 | `ui/shell/office_shell_layout.gd:50` |
| Composer | `COMPOSER_CONTENT_FLOOR` | 477.0 | `ui/shell/office_shell_layout.gd:54` |
| Composer | `COMPOSER_CONTENT_HEIGHT` / `COMPOSER_H` | 116.0 / 116.0 | `ui/shell/office_shell_layout.gd:56,58` |
| Composer | `COMPOSER_MAX_W` | 720.0 | `ui/shell/office_shell_layout.gd:57` |
| Composer | `COMPOSER_BOTTOM` | 40.0 | `ui/shell/office_shell_layout.gd:59` |
| Toggles | `TOGGLES_W` / `TOGGLES_H` / `TOGGLES_MARGIN` | 76.0 / 28.0 / 16.0 | `ui/shell/office_shell_layout.gd:65-67` |
| Composer card | `INPUT_H` / `CONTROL_H` / `CARD_H` | 44.0 / 34.0 / 116.0 | `ui/prompt/prompt_panel.gd:22-24` |
| Composer card | `PILL_MIN_W` | 96.0 | `ui/prompt/prompt_panel.gd:28` |
| Effort card | `CARD_W` / `CARD_H` / `TRACK_H` / `DOT_R` / `KNOB_R` | 300 / 142 / 30 / 4 / 13 | `ui/prompt/effort_slider.gd:15,19,20,22,23` |
| World | `MAP_WIDTH` x `MAP_HEIGHT` | 41 x 23 = 1.783 aspect | `office/maps/hq/office_world.gd:46-47` |
| World | `TILE` | 32 | `office/maps/hq/office_world.gd:10` |
| Drawer | literal (no constant) | 552 / 536 / -200 | `app/main.gd:123-127` |
| Sidebar node | tscn default | offset_right 320, offset_bottom 700 | `app/main.tscn:53-57` |
| Text scale | `UiScale.MIN/MAX/STEPS` | 1.0 / 2.0 / [1,1.25,1.5,1.75,2] | `app/ui_scale.gd:14-18` |
| Sidebar typography | mode/detail/session/team | 12 / 11 / 14 / 13 | `ui/shell/sidebar_panel.gd:84,89,373,453` |
| Composer typography | input / approval / notice | 15 / 13 / 11 | `ui/prompt/prompt_panel.gd:61,86,117` |
| Palette | dark panel/text/accent | `2b2f3a` / `e8eaf0` / `6fb2e8` | `ui/theme/office_palette.gd:22-35` |

Application of the design (`verified_in_checkout`): `app/main.gd:104-127` re-applies regions on
start, resize, and after a rescale; `office_view` gets `office_region(shell.size)` (line 109),
`sidebar` gets `overlays["sidebar"]` (line 112) on top of it.

`calculated` consequences at the project's logical base 1280x720:

| scale | sidebar w / %frame | composer w / %frame / %content | composer h |
| --- | --- | --- | --- |
| 1.0 | 297 / 23.2% | 477 / 37.3% / 50.8% | 116 |
| 1.25 | 371 / 29.0% | 596 / 46.6% / 69.0% | 145 |
| 1.5 | 446 / 34.8% | 716 / 55.9% / 90.5% | 174 |
| 2.0 | 594 / 46.4% | 642 / 50.2% / 100% | 232 |

`calculated`: a docked rail (content_x = 16+297+12 = 325, content 939x688, aspect 1.365) shapes a
world-aspect office to 939x527, i.e. **76.6%** of the content region; the remaining 23.4% is
letterboxed. (The office is currently drawn full-bleed at window size, so this figure only applies
to the docked target.)

### Runtime baseline measured (`verified_at_runtime`)

Pixel scan of `evidence/r0-02-native-launch-1280x720.png` (1280x720, revision `a4bb99e`):

| Overlay | Designed (scale 1.0) | Measured in capture | Delta |
| --- | --- | --- | --- |
| Sidebar | x16..312, y16..703; 297x688 | x17..320, y17..702; **304x686** | +7 px wider than designed |
| Composer | x556..1032, y564..679; 477x116 | x557..1031, y565..698; 475x**134** | **+18 px taller**; bottom edge 698 vs 679 |
| Composer bottom margin | 41 px | **22 px** | 19 px closer to the window edge |

Confirmed in the live render:
1. The sidebar is a rounded card with an opaque office fill visible to its **left** (sampled
   `(3,360)`, `(5,400)`) and **below** it (`(200,710)`), so it is floating over the office and not
   occupying a reserved column. This is the defect image 02 shows, reproduced at scale 1.0.
2. The composer is a floating card whose opaque fill extends past the height the shell reserves
   (`y565..698`, 134 px) — 18 px over `COMPOSER_H`/`COMPOSER_CONTENT_HEIGHT` (116) and 19 px past
   the designed bottom edge. So the composer already clips/overflows its own reserved box at scale
   1.0, before any text-scale growth. Office art is visible below it (`(600,715)`).
3. The office fills the window at 1280x720 (office region 1280x718 by construction), so the rail and
   the composer both sit **on top of** the world rather than beside it.
4. `DEMO` and "Synthetic playback — no runtime work is executed" are the loudest labels in the rail,
   matching image 02's report.

The 18 px composer overflow is explained by arithmetic, and it contradicts the design's own claim.
`prompt_panel.gd:51-53` builds a `VBoxContainer` at `separation 8` holding input (min 44,
`:59`), control row (min 34, `:71`) and notice label (11 px font, one line ~16). `card_style()`
(`ui/shell/office_theme.gd:202-218`) adds 12 px top and bottom content margins. The panel's own
combined minimum is therefore `24 + 44 + 8 + 34 + 8 + ~16 = 134`, which is 18 px more than the
116 the shell reserves (`office_shell_layout.gd:56,58`; `prompt_panel.gd:24` claims "the card's
total matches what the shell layout reserves"). `OfficeShellLayout.place()`
(`office_shell_layout.gd:181-188`) assigns `control.size = rect.size`, but a Godot container grows
to its minimum, so the measured 134 is the minimum winning over the design. This also means the
`composer` rect returned by `overlays()` is never the composer's painted geometry.

The sidebar's 7 px overrun is the same class of defect: `SIDEBAR_CONTENT_FLOOR` (297,
`office_shell_layout.gd:36`) is documented as "the narrowest the sidebar's own CONTENT can render",
yet the painted rail is 304, so the declared floor is below the real combined minimum. Which child
is the widest contributor is `deferred` (it needs font metrics, not source reading).

---

## 3. Gap table

| # | Requirement (image + doc) | Current implementation (path:line + value) | Gap | Severity | Must change |
| --- | --- | --- | --- | --- | --- |
| G1 | Persistent left app sidebar; office occupies the remaining region (img 01, 04; REQUEST.md:79-80; ADDENDUM.md:9 supersedes "floating rail") | Sidebar is an overlay drawn over a full-bleed office: `office_shell_layout.gd:83-104` (`overlays()`), `:129-136` (`office_region()` centred world-aspect rect), applied `main.gd:109,112`. **Runtime-verified**: at 1280x720 the opaque rail (304x686 at x17..320) has office art visible to its left and below it, and the office region is 1280x718 (window-sized) | The rail floats; the office is not a sibling region | **blocker** | `ui/shell/office_shell_layout.gd`, `app/main.gd`, `app/main.tscn`, `apps/office/AGENTS.md`, `office/maps/hq/office_world.gd`, tests |
| G2 | Office feels expansive/full-height in the content region (img 01, 02; REQUEST.md:81) | `office_region()` = world-aspect 1.783 centred (`:129-136`); content region 939x688 (1.365) after a docked rail | `calculated` 939x527 office = 76.6% of the region; ~23% letterboxed. Today it is full-bleed, so the office is expansive but **underneath** the rail, which is the wrong kind of expansiveness | **major** | `ui/shell/office_shell_layout.gd` (region derivation) |
| G3 | Composer centred near bottom, width-constrained, unobtrusive (img 01, 05; REQUEST.md:82, 357-358; README.md:7) | `COMPOSER_BOTTOM=40` (`:59`), `COMPOSER_H=116` (`:58`), `COMPOSER_MAX_W=720` (`:57`), centre of content area (`:100-103`) | **Measured** painted card is 475x**134** at x557..1031 y565..698, i.e. 18 px taller than the reserved 116 and 19 px past the designed bottom edge, leaving only a 22 px bottom margin. Runtime-verified against `evidence/r0-02-native-launch-1280x720.png` | **major** | `ui/shell/office_shell_layout.gd`, `ui/prompt/prompt_panel.gd` |
| G4 | Multiline composer with Enter=send / Shift+Enter=newline (img 05; REQUEST.md:360-361) | `prompt_panel.gd:268` sends only on `KEY_ENTER` with Ctrl/Meta; plain Enter inserts a newline, Shift+Enter is unhandled | Enter/Shift+Enter semantics inverted; no IME handling | **major** | `ui/prompt/prompt_panel.gd` |
| G5 | Composer action row compact and subordinate (img 01, 05; README.md:11) | `CONTROL_H=34` (`prompt_panel.gd:23`), attach/approval at 16/13 px (`office_theme.gd:247`, `prompt_panel.gd:86-88`), approval permanently `disabled=true` (`:88`) | Approval affordance is a dead disabled control; row height matches 05 but scale grows to 68 px at 2.0 | **major** | `ui/prompt/prompt_panel.gd`, `ui/shell/office_theme.gd` |
| G6 | Model + effort selector compact, hierarchical, stop-count from the model (img 03; README.md:9) | `effort_slider.gd` 300x142 with real variant stops (`:15,19`, `ModelCatalog.variant_stops`); opened after model pick (`prompt_panel.gd:310-324`) | Shape is right; it is a separate popover, never shown as image 03's inline two-line card, and there is no visible effort state in the composer itself | **minor** | `ui/prompt/effort_slider.gd`, `ui/prompt/prompt_panel.gd` |
| G7 | Dedicated settings page: grouped nav + search + described rows + real controls (img 06; REQUEST.md:174 "Settings must be reachable from the UI and actually work"; INLINE_REFERENCES.md:5) | No settings surface exists in `apps/office/` (grep: only `core/motion.gd:17`, `app/main.gd:830` comment, `ui/prompt/prompt_panel.gd:328` string) | Entire page absent; theme/scale/motion are only chrome-toggle buttons (`ui/shell/chrome_toggles.gd:20-31` `ENTRIES`/`ACTIONS`, handlers `:96,:103`) | **major** | new page + `app/main.gd` route owner, `ui/` |
| G8 | Sidebar density: compact rows, grouped headings, pinned footer (img 04; README.md:10) | `sidebar_panel.gd` already has product pill (`:76-86`), New session (`:95-99`), Sessions/Team sections (`:111-118`), pinned agent row (`:127-132`) and status bar (`:135-139`) | Structure matches; body text runs 11-14 px (`:84-136`), consistent with img 04's dense rail, but rows carry no trailing icon, there is no search, and the rail is styled as a rounded card (`_ensure_built` `add_theme_stylebox_override("panel", OfficeTheme.card_style())` at `:68`) rather than image 04's edge-to-edge surface | **minor** | `ui/shell/sidebar_panel.gd`, `ui/shell/office_theme.gd` (`card_style` on the rail) |
| G9 | Layout coherent during resizing; reflow/collapse at large UI settings (img 01, 02; REQUEST.md:88; REFERENCE_REVIEW.md:21) | `supported_sizes()` goes to 1024x768 (`office_shell_layout.gd:193-197`), but there is no compact breakpoint anywhere; scale is clamped 1.0-2.0 (`ui_scale.gd:14-15`) | At scale >1.0 the sidebar exceeds the 26% budget and the composer exceeds the 45% budget (see §2), so the design's own pinned assertions (`test_shell_layout.gd:175-193`) only hold at 1.0 | **major** | `ui/shell/office_shell_layout.gd`, `app/main.gd` |
| G10 | No demo-first startup; no prominent synthetic label (img 02; ADDENDUM.md:9; README.md:8) | `main.gd:95` `_start_demo()`, `:134-141` DEMO default, badge in `sidebar_panel.gd:254-271` (`Synthetic playback — no runtime work is executed`) | DEMO is still the boot path and its label is the loudest state in the rail (owned by other lanes; recorded here because image 02 shows it) | **major** | `app/main.gd` (R1-01) |
| G11 | Content area is unobstructed; overlays must not hide the work (img 01; REQUEST.md:83) | Composer/drawer occlusion constraints are tested but the drawer placement is a literal (`main.gd:120-128`) marked "provisional" | Drawer is not part of the reviewed design and is unconstrained by any test | **minor** | `app/main.gd`, `ui/conversation/` |
| G12 | Office remains the primary spatial workspace (REQUEST.md:84-86) | World is 41x23/1.783 (`office_world.gd:46-47`) sized to fill 16:9 (`:13-19`); anchors kept at row >=16 and east of the lobby (`:37-39`) | Sound; only becomes a constraint once G1 changes the region aspect | **minor** | `office/maps/hq/office_world.gd` (only if it conflicts with the docked region) |

---

## 4. Sidebar / floating conflict — verdict

**Verdict: the live code implements the FLOATING-over-office sidebar, and the persistent-left-sidebar
requirement is not implemented anywhere.** The conflict is between the written latest scope and both
the code and the client's own `AGENTS.md` design contract. Confirmed at runtime: in
`evidence/r0-02-native-launch-1280x720.png` the office fill is visible at `(3,360)`, `(5,400)` and
`(200,710)` — left of and below the opaque rail — and the office region is the whole window.

Exact lines that encode the float (all `verified_in_checkout`):

1. `apps/office/ui/shell/office_shell_layout.gd:3-5` — docstring: "There is no header. The office
   viewport is full-bleed and reaches every window edge; everything else floats above it."
2. `apps/office/ui/shell/office_shell_layout.gd:8-12` — the ASCII design shows "sidebar | OFFICE
   VIEWPORT (full bleed)" with the sidebar drawn inside the frame.
3. `apps/office/ui/shell/office_shell_layout.gd:23-25` — "Overlays deliberately cover part of the
   office."
4. `apps/office/ui/shell/office_shell_layout.gd:83-104` — `overlays()` returns `sidebar` as a
   `Rect2(16, 16, w, size.y-32)`, i.e. an overlay, not a reserved region.
5. `apps/office/ui/shell/office_shell_layout.gd:127-136` — `office_region()` is "Anchored to the
   window centre. The leftover space is not dead: the sidebar and composer float over the edges of
   it", and returns a rect spanning the whole window: `Rect2((size.x-width)*0.5, (size.y-height)*0.5, width, height)`.
6. `apps/office/app/main.gd:109` — `place(office_view, OfficeShellLayout.office_region(_shell.size))`
   gives the world the full window.
7. `apps/office/app/main.gd:112` — `place(sidebar, overlays["sidebar"])` places the rail **on top of**
   the world.
8. `apps/office/app/main.gd:100-102` — comment: "The office is full-bleed and reaches the window
   edges; the panels float over it."
9. `apps/office/app/main.tscn:53-57` — the `Sidebar` node is a free-floating `PanelContainer` with
   `offset_right = 320` and no container/anchor contract with the viewport.
10. `apps/office/AGENTS.md:51` — "Sidebar | 264 wide, floats over the office" and `:56` — "There is
    no header. The office is full-bleed and the panels float over it".
11. `apps/office/office/maps/hq/office_world.gd:28` — "cols 1-12 lobby (the sidebar floats over this
    band)"; `:37-39` — "The sidebar is always open, and at 1024x768 it covers cols 0-13"; `:128` and
    `:244` repeat the float assumption for furniture and anchors.
12. Tests that pin the float as intended behaviour (these are the assertions R2-01 must
    replace, not merely edit):
    - `apps/office/tests/suites/test_shell_layout.gd:284` `test_sidebar_never_covers_an_anchor`
    - `apps/office/tests/suites/test_shell_layout.gd:120-134` `test_sidebar_does_not_cover_the_office_centre`
    - `apps/office/tests/suites/test_shell_layout.gd:222-257` `test_hidden_overlays_occlude_nothing` / `test_hidden_chrome_frees_every_anchor`
    - `apps/office/tests/suites/test_shell_layout.gd:310-329` `test_occlusion_maps_to_real_tiles` (asserts "the sidebar hides the west edge of the map")
    - `apps/office/tests/suites/test_layout.gd:137-153` `test_lobby_band_holds_no_anchors` — reserves
      the west band *because* the rail covers it.

Against this, `references/ADDENDUM.md:9` states the most recent requests "supersede the earlier
prototype's … floating rail", and `references/REQUEST.md:79-81` requires a persistent left sidebar
with the office in the remaining region. `references/INLINE_REFERENCES.md:11` places the latest
explicit requirements above screenshot grammar and the current desktop implementation. The
repository root `AGENTS.md` and `apps/office/AGENTS.md` still describe the float, so the client
contract itself is the second authority that must change.

Note: `apps/office/AGENTS.md:51` says "264 wide" while `office_shell_layout.gd:33` is `272.0`
(and `:36` floors the effective width at 297). The doc and code already disagree; the doc's
262/264 figure matches neither.

---

## 5. What image 02 is presenting as the defect

Image 02 is the **before** state that REQUEST.md must repair:
1. The floating rounded sidebar card over visible office art (REFERENCE_REVIEW.md:7; code lines in §4).
2. The oversized floating composer over the office's lower-right, so the two panels "obscure much
   of the scene" (REFERENCE_REVIEW.md:5, measured x=20…762 and x=780…1580, y=560…850).
3. Oversized text/controls and a truncated model name with unused space (REFERENCE_REVIEW.md:7).
4. Synthetic/"DEMO" mode prominence (README.md:8; `sidebar_panel.gd:254-271`, `main.gd:134-141`).
5. A top-right control running past the image edge (REFERENCE_REVIEW.md:7).

Per README.md:8, this is one render and does not prove every production launch uses DEMO; the demo
boot path is separately verified in code at `main.gd:95`.

---

## 6. Work items implied

- **R2-01** (owns G1): replace the floating rail contract. Rewrite `office_shell_layout.gd` so the
  sidebar is a reserved region and the office is the remaining rect; update `main.gd:109-113`
  placement; update `apps/office/AGENTS.md:49-60`, `office_world.gd:28,37-39,128,244`; replace the
  float-pinning tests listed in §4.12.
- **R2-02** (owns G2, G9): region derivation and scale ownership; add a compact breakpoint so the
  office stops being a centred world-aspect rect with dead bands, and so scale >1.0 does not push
  the rail past 26% and the composer past 45%.
- **R2-03** (owns G3, G4): bottom-centred multiline composer. Fix the reserved height so it matches
  the card's real minimum (the measured 134 vs reserved 116, `prompt_panel.gd:51-123` +
  `office_theme.gd:202-218`), then `COMPOSER_BOTTOM`/`COMPOSER_H` derivation and Enter /
  Shift+Enter (`prompt_panel.gd:264-270`).
- **R2-06** (owns G5, G6, G8): control/theme polish — approval affordance either wired or removed,
  effort state surfaced in the composer, rail fidelity to image 04.
- **R3-01** (owns G7): settings route with grouped navigation, search, grouped described rows and
  real controls, wired through the config owner (R3-02).
- **R1-01** (owns G10): production boot instead of `main.gd:95` demo-first.
- **R2-05** (owns G11): remove the "provisional" literal drawer placement at `main.gd:120-128`.

---

## 7. Unknowns and deferred verification

1. **Partially resolved — live render available.** `evidence/r0-02-native-launch-1280x720.png`
   (revision `a4bb99e`, 1280x720, DEMO boot) supplied `verified_at_runtime` measurements for the
   shell at scale 1.0 only. Still `deferred`: every other window size, every text scale above 1.0,
   light mode, and the 1600x900 capture size REFERENCE_REVIEW.md:21 names.
2. **Deferred — interaction evidence.** Focus, hover, pressed, dropdown, scroll, IME, resize reflow,
   and Settings persistence cannot be established from still images (REFERENCE_REVIEW.md:5,
   "A still image cannot prove clickability, scrolling, movement, stream updates or persistence").
   The baseline capture is a single still of DEMO idle; it does not show typing, sending, or a
   resize.
3. **Deferred — font-metric contributions.** The 7 px sidebar overrun and the 18 px composer
   overrun are measured, and their arithmetic is reconstructed above, but which child sets the
   winning minimum in each case needs the scene tree's computed minimum sizes, not source reading.
4. **Inference, not observation:** image 02 was captured at text scale 2.0. The claim rests on the
   physical-pixel match computed in §1 (image 02's measured panel geometry equals the live constants
   at scale 2.0 under a 1600x900 window and the project's `canvas_items`/`expand` stretch). The
   image carries no scale metadata, and REFERENCE_REVIEW.md:5 explicitly warns the filename's `200`
   is not proof. The scale-1.0 baseline capture in `evidence/` shows the *same* structural defects
   at a smaller size, so the float verdict does not depend on this inference.
5. `calculated` and unverified: the 76.6% office-fill figure for a docked rail assumes the content
   region is exactly 939x688 at 1280x720 and that no breakpoint changes it.
6. `apps/office/AGENTS.md:51` ("264 wide") disagrees with code (`272.0`/`297.0` floor) and with the
   304 px measured rail; which is authoritative was not resolved here because the whole contract is
   scheduled for replacement by R2-01.
7. `evidence/r0-02-native-launch-1280x720.png` is the DEMO boot path. It is a valid baseline for
   shell geometry but proves nothing about LIVE mode, provider integration, or the settings surface.
8. Not inspected in this lane: `ui/conversation/conversation_panel.gd` internals beyond its float
   placement, `apps/office/tests/integration/`, `tools/capture_*.gd`, and the Settings catalog under
   `tracking/settings_catalog.json`. G7's work estimate is therefore structural only.
