# Visual fidelity acceptance checklist — 2026-09-20

Terse human companion to `visual-fidelity-20260920.toon`. The TOON holds measured geometry; this file holds what a reviewer must *see* to accept the work.

## Sources and authority

| ID | Source | Role |
|---|---|---|
| ref01 | `references/images/01-app-shell-reference.png` (2048x1306) | Shell composition target |
| ref02 | `references/images/02-current-ycoding-problem.png` (1600x900) | Reported-problem render, **not** a target |
| ref03 | `references/images/03-model-effort-reference.png` (532x208) | Control-quality target |
| ref04 | `references/images/04-sidebar-reference.png` (562x1576) | Sidebar density target |
| ref05 | `references/images/05-composer-reference.png` (1516x230) | Composer target |
| ref06 | `references/images/06-settings-reference.png` (2048x1289) | Settings target |
| ref07 | `/Users/viadz/Documents/SCR-20260915-sjsf.png` (1750x1686) | Gather-style office target |
| cur-* | `evidence/r2-04/office.png`, `r7-03/statistics.png`, `r7-09/analytics.png`, `r7-04/quota.png` (all 1280x720) | Newest captured current state |

- The explicit sidebar crop `SCR-20260916-ghfd.png` and composer crop `SCR-20260916-gheb.png` are byte-identical to ref04 and ref05 (sha256 `4608a8ad…` and `6a1ed8c7…`). No duplicate sources.
- The provider-usage card was supplied as a **parent description** of an inline image not visible to this session. Treated as `supplied-parent-description`. Re-inspect the original before building it.
- No font family, breakpoint, or z-index is asserted anywhere. Fonts are unresolved by design.
- These images are measurement references only. No artwork, sprite, or font may be extracted from them.

## Evidence classes used

`[M]` measured from pixels · `[V]` visible but not numerically measured · `[I]` inferred · `[U]` unresolved.

## A. Shell geometry

| # | Check | Acceptance | Status in cur captures |
|---|---|---|---|
| A1 | Sidebar share of window width `[M]` | ref01 15.3%, ref06 15.2%. Target ≤18% at 1280 wide. | **FAIL** — cur 296/1280 = **23.1%** |
| A2 | Office remains visually dominant `[M]` | Office region ≥70% of window width | **FAIL** — cur office 984/1280 = 76.9% width but only 88% of height below an 84px chrome bar; combined with 23.1% sidebar the office reads crowded |
| A3 | Chrome bar height `[M]` | No reference chrome bar exists; ref01 header is 54px | **REVIEW** — cur 84px, 1.56x the reference header |
| A4 | Composer centred in the **visible office region** `[M]` | |card centre − office centre| ≤ 2px | **PASS** — cur office centre 788, card centre 789 |
| A5 | Composer width cap `[M]` | ref01 837px in a 1735px content region | **PASS** — cur 839px in 984px office; cap holds but leaves only 72px gutters |
| A6 | Composer gutters `[M]` | ≥16px each side | **PASS (tight)** — cur 73px left, 72px right |
| A7 | Opaque panels must not occlude the office `[V]` | ref02 is the failure case: 47.4% sidebar card + opaque composer | **PASS** — cur sidebar and composer are translucent-toned overlays, not the ref02 light cards |
| A8 | Single status strip per chrome bar `[M]` | ref01 has one right-aligned action cluster | **REVIEW** — cur draws a 459x45 inset strip (#333846) over the 84px bar, i.e. a second bar |
| A9 | Settings content column `[M]` | ref06 column 875px = 50.4% of content region, left-of-centre | **UNMEASURED** — no current settings capture in the evidence set |

## B. Typography and density

| # | Check | Acceptance | Status |
|---|---|---|---|
| B1 | Navigation row pitch `[M]` | ref01 36px. ref04 crop is 62px and is a **scale variant**, not a density target (see HYP-4) | **UNVERIFIED** — cur sidebar rows not measured as rects |
| B2 | Body ink height `[M]` | ref01 13–15px, ref06 rows 10–14px | **UNVERIFIED** |
| B3 | Section labels are visually subordinate `[V]` | ref01 `#A19B9D` vs `#F5F4F4` body | **UNVERIFIED** |
| B4 | No font family asserted `[U]` | Report as unresolved | **PASS (by omission)** — see UNC-1 |

## C. Office world (ref07 target)

| # | Check | Acceptance | Status in cur |
|---|---|---|---|
| C1 | Corridor is one continuous low-contrast plane `[M]` | ref07 floor `#ECE4DB`; adjacent tone differs 1.005:1 | **FAIL** — cur corridor patch returns ≥4 light tones (#C5C7CC, #CECFD2, #B7BAC0, #C0C2C7) plus a lilac accent; dominant pair contrast 1.25:1, so the floor reads as a busy checker |
| C2 | Zone labels are light pills with dark text `[M]` | ref07 235x43 and 190x43 light pills | **FAIL** — cur labels are small dark chips (75x19, 57x19, 67x19, 59x19) drawn directly on the floor || C3 | Room/zone naming is legible at normal zoom `[M]` | ref07 label text sits in a 43px pill | **FAIL** — cur 19px chips are 2.3x smaller than the reference label |
| C4 | Furniture variety per zone `[V]` | ref07: desk bank, chairs tucked under desks, sofas, round table, accent poufs, shelving, plants, rug, whiteboard, aquarium, water cooler, arcade machine | **PARTIAL** — cur has desk banks, chairs, sofas, plants, vending machine, cabinets; lounges are thinner |
| C5 | Desk/chair occlusion `[V]` | ref07 draws the desk edge over the tucked chair | **PASS** — cur shows the same occlusion |
| C6 | Clear walking corridors between zones `[V]` | ref07 keeps 100px+ clear runs between prop clusters | **PARTIAL** — cur zones are separated but planters sit on the corridor line |
| C7 | Planted borders `[V]` | ref07 uses plant clusters as room edges | **PASS** — cur has repeated potted plants along walls |
| C8 | Coherent perspective `[V]` | ref07 is a consistent top-down/three-quarter hybrid; all props share one vanishing convention | **PASS** — cur matches the convention |
| C9 | Palette cohesion `[M]` | ref07 quantised: 46.4% one floor tone, then a tight blue/slate/green family | **PARTIAL** — cur quantised: 36.1% dark shell, 31.9% floor, then a 10% slate band; floor and shell are similar in mass, unlike ref07 |
| C10 | Sprite scale `[M]` | ref07 character ~64px tall; chair 65x56 | **UNVERIFIED** — cur sprite not isolated cleanly |
| C11 | Overlays legible over the world `[M]` | ref07 name pills are dark with light text and never cover the avatar | **UNVERIFIED** — cur agent/status chips not measured |
| C12 | No screenshot-derived assets `[M]` | Assets must be authored, not cropped from references | **PASS (by construction)** — no asset files were created |

## D. Statistics / analytics

| # | Check | Acceptance | Status |
|---|---|---|---|
| D1 | Chart surfaces exist `[V]` | Large chart cards; line and bar charts | **FAIL** — r7-03 and r7-09 render no chart at all; the content region is flat text |
| D2 | Time-range selector exists **only with real interval accounting** `[V]` | Segmented control | **FAIL (correctly absent)** — r7-09 shows two view chips, not a 7d/30d range; the client itself states no daily series is drawn |
| D3 | Contribution heatmap `[V]` | Heatmap grid | **FAIL** — absent |
| D4 | Model/provider filter `[V]` | Model filter control | **FAIL** — `By model` is a text list, not a filter |
| D5 | Explanatory note renders once `[M]` | One paragraph | **FAIL** — the same sentence renders on two lines and the second begins mid-word (wrap/duplicate defect) |
| D6 | Absent values are unreported, not zero `[V]` | Explicit unreported state | **PASS** — `Spend (catalog estimate): Not reported` and `Not reported` reset/period text are truthful |

## E. Spend and quota

| # | Check | Acceptance | Status |
|---|---|---|---|
| E1 | Spend is separate from quotas `[V]` | Distinct sections | **FAIL** — spend appears as metric lines inside the same flat report; no separate spend surface |
| E2 | Each window labelled with its own unit `[V]` | Session / Weekly / model-specific with units | **PARTIAL** — windows are labelled but inline; `used of Not reported` mixes a count with an absent denominator |
| E3 | Recorded vs estimated distinguishable `[V]` | Explicit markers | **PASS** — `provider-recorded` vs `catalog estimate` labels exist |
| E4 | Estimated-at-reset markers only from an authoritative source `[V]` | No forecast marker unless supported | **PASS (by absence)** — no forecast markers are rendered; do not add them |
| E5 | Horizontal remaining bars / percent track `[V]` | Bars with percent and reset countdown | **FAIL** — r7-04 renders no bar, percent track, donut or legend |
| E6 | Absent value never coerced to zero or unlimited `[V]` | Keep absent absent | **PASS** — `Not reported` is preserved |
| E7 | Stale / error / unsupported states explicit `[V]` | Explicit state words | **PASS** — `unsupported`, `Provider usage refresh failed`, and a freshness timestamp are shown |

## F. Settings

| # | Check | Acceptance | Status |
|---|---|---|---|
| F1 | Left category navigation with groups `[V]` | ref06 groups: Personal / Integrations / Coding / Archived | **UNVERIFIED** — no current settings capture |
| F2 | Search field present `[M]` | ref06 295x34 inset field | **UNVERIFIED** |
| F3 | Back-to-app affordance `[V]` | ref06 back row above search | **UNVERIFIED** |
| F4 | Constrained content column `[M]` | ref06 875px, left-of-centre | **UNVERIFIED** |
| F5 | Grouped rows in rounded cards `[M]` | ref06 card `#232323` on `#181818`, radius 12 | **UNVERIFIED** |
| F6 | Right-aligned controls per row `[M]` | ref06 toggle 33x21 at the row right | **UNVERIFIED** |
| F7 | Every control has a real read/write owner `[V]` | No decorative control | **UNVERIFIED** — requires R3 settings evidence |

## G. Process gates

| # | Check | Acceptance |
|---|---|---|
| G1 | New captures after each fidelity change `[M]` | Fresh 1280x720 captures at the states in `contracts/verification-cases.json` |
| G2 | Historical tests do not establish visual acceptance `[V]` | Geometry or unit tests alone cannot pass C1–C12, D1–D6, E1–E7, F1–F7 |
| G3 | Light theme captured before deriving light tokens `[U]` | See UNC-12 |
| G4 | No private data, names, or branding copied into the client `[V]` | Reference product names, account rows, model catalogs and usage numbers are not product truth |

## Highest-impact discrepancies

1. **Sidebar consumes 23.1% of the window** versus 15.3% in the reference shell (A1). Everything else on the office screen is squeezed by this.
2. **The office floor is visually noisy** — four-plus light tones at 1.25:1 instead of one near-uniform corridor plane (C1). This is the single largest office-fidelity gap.
3. **Zone labels are 19px dark chips** where the reference uses 43px light pills (C2, C3), so rooms are not legible at normal zoom.
4. **Statistics has no chart, heatmap, filter or range control** (D1, D3, D4), so the analytics direction in the brief is unimplemented, not merely unstyled.
5. **The quota surface renders no bar or legend** (E5) and keeps spend inside the same flat report (E1).
6. **A duplicated, mid-word-wrapped note** renders in both statistics states (D5).
7. **A second 84px chrome bar with an inset status strip** sits where the reference has a 54px header (A3, A8).

## Unresolved decisions returned to the parent

1. **Sidebar width target.** ref01/ref06 both imply ~15.3%. Adopting it shrinks the sidebar by ~82px at 1280 wide. Confirm 15–16% as the office-shell target, or keep a wider sidebar and reduce office chrome instead.
2. **Office floor material.** ref07 uses one near-uniform corridor tone with zone carpets as the only contrast. Confirm replacing the current checker with a single corridor tone plus distinct zone carpets.
3. **Zone label size.** Confirm 43px light pills (ref07) as the in-world label standard, accepting that they cover more floor than the current chips.
4. **Analytics scope.** The brief asks for chart cards, segmented 7d/30d, model filters and a contribution heatmap, but the client currently has no daily series and states so. Decide whether to build interval accounting first, or ship the analytics surface with explicit unreported states and no range selector.
5. **Provider-usage card.** The composition is known only from the parent description. Re-inspect the original image or read the runtime's real spend/quota fields before building it.

## Validation evidence

```
python3 /Users/viadz/.agents/skills/chad-vision/scripts/validate_analysis.py \
  ycoding-office-repair-kit/tracking/visual-fidelity-20260920.toon
PASS: visual-fidelity-20260920.toon (11 screen(s), 152 component(s))   exit=0
```

Strict TOON round-trip decode also succeeded (`toon_codec.py decode` → 11 screens, 152 components, 152 tree nodes). Structural validation proves internal consistency, bounds, references, ASCII legends and tree integrity. It does **not** prove visual accuracy; every `[M]` row above still needs a fresh capture to confirm.
