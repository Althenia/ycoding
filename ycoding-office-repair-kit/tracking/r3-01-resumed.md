# R3-01 (resumed) — Settings navigation, search and scope

Lane: omoikane (DeepSeek v4.1 flash, high). Exclusive writer: `app/main.gd`,
`app/main.tscn`, `ui/shell/*`, new settings UI/core files, dedicated new tests,
`tests/run_tests.gd`. Worktree: `/Users/viadz/Workspace/Project/ycoding.worktrees/office`.
**Not marked done by this lane.** This file records evidence only.

## Task acceptance (tracking/tasks.json, R3-01)

> Grouped application/workspace/connections/runtime/advanced; Global/Project/Folder/Session
> only where valid.

Required evidence kinds: `test_run`, `native_runtime`.

## What was implemented

### New core (pure presentation logic, no scene tree)

- `apps/office/core/settings_group.gd` — the settings information architecture.
  `ORDER` = application / workspace / connections / runtime / advanced. A single
  `PAGES` table maps each page id to exactly one group; `PAGE_LABELS`,
  `PAGE_DETAIL` and `PAGE_COVERAGE` give every page a label, a one-line
  description, and the configuration areas it owns. `matching_pages` /
  `matching_groups` are the search index (label, description, group, group label,
  group detail, and coverage — case-insensitive, whitespace-trimmed, empty query
  returns everything). `stepped_page` walks the *filtered* list with wraparound.
  `first_page` / `default_page` decide what a group and a fresh visit open on.
- `apps/office/core/settings_scope.gd` — the four real scopes. `available()`
  offers Global always; Project and Folder only with an open folder; Session only
  with a selected session. `reason_unavailable()` gives a stated cause for every
  omission, `reconcile()` moves an invalidated scope back to a valid one while
  keeping a still-valid scope, and `badge()` names *which* folder or session a
  narrow scope applies to.

### New surface

- `apps/office/ui/settings/settings_panel.gd` — the Settings page. A search box,
  a Back control, a grouped scrolling navigation column with a text marker on the
  current page, a page body carrying the title, description and coverage list, and
  a scope selector that offers only valid scopes and is disabled with a stated
  reason when only Global is valid.

### Wired into the shell

- `ui/shell/office_route.gd` — `SETTINGS` added to the closed route set, with its
  own label and a distinct glyph.
- `ui/shell/office_shell_layout.gd` — `settings_region()`, a bounded, centred
  surface (capped at `SETTINGS_W`/`SETTINGS_MAX_SHARE`, floored at
  `SETTINGS_MIN_W`, margin on every side) placed in the content region east of the
  docked rail. Deliberately NOT a fifth entry in `OVERLAYS`: it is a full surface,
  not a floating panel over the world.
- `ui/shell/office_view_state.gd` — `settings_page` added to `STORED_FIELDS` and
  to `sanitize`, validated against `SettingsGroup.is_page` so an unknown page is
  dropped rather than restored.
- `app/main.gd` / `app/main.tscn` — the `SettingsPanel` node, route visibility,
  the close handler (routes back to Office), per-project page capture/restore, and
  the panel added to the repaint list.

### The honesty boundary (R3-02 is blocked; nothing fakes a save)

No configuration read/write path exists for the desktop. `Config.Service` is
read-only, and R3-02 is blocked on an additive `server.config` group — a public
contract change. So **no control on this surface is enabled and no save is
faked**. Every settings page renders a visible line stating that editing arrives
with the configuration owner and that no control here writes anything. The test
suite asserts that boundary positively on all 20 pages.

## Evidence

### Baseline (before any production change)

```
sh ycoding-office-repair-kit/tools/godot_lock.sh /Applications/Godot.app/Contents/MacOS/Godot \
  --headless --path apps/office --script res://tests/run_tests.gd
passed: 8663  failed: 0  RESULT: PASSED   engine errors: 0
```

A first run against a checkout with no generated `.godot` cache printed
`passed: 0 / RESULT: PASSED` — the known vacuous-pass trap. The import pass
(`--editor --quit`, 0 engine errors) was run first, and every run below was
checked for a nonzero assertion count AND grepped for engine errors.

### Full suite after the change

```
passed: 9463  failed: 0  RESULT: PASSED   engine errors: 0
```

(+800 assertions over baseline; the new suite contributes 468.)

### Flow check

```
checks: 34, failures: 0   FLOW RESULT: PASSED   engine errors: 0
```

### New suite

`apps/office/tests/suites/test_settings_navigation.gd`, 30 cases, driven at the
real boundary: a `SettingsPanel` with its real `_ready`, and the real composition
root for the route and scope wiring.

### Mutation check (the suite must discriminate)

`ycoding-office-repair-kit/tools/r301_mutations.py` mutates the implementation and
requires failures. Restore is verified by SHA-256, not by trusting the edit.

```
control: exit=0 passed=468 failed=0
scope-session-always-valid:        exit=1 passed=457 failed=11 DETECTED
group-order-drops-one:             exit=1 passed=410 failed=13 DETECTED
search-stops-reading-coverage:     exit=1 passed=464 failed=4  DETECTED
route-set-drops-settings:          exit=1 passed=458 failed=7  DETECTED
page-stops-stating-the-boundary:   exit=1 passed=448 failed=20 DETECTED
empty-query-matches-nothing:       exit=1 passed=463 failed=5  DETECTED
settings-region-unbounded:         exit=1 passed=458 failed=10 DETECTED
scope-reason-empty:                exit=1 passed=464 failed=4  DETECTED
MUTATION CHECK PASSED: all 8 mutations produced failures
```

### Repository gate

`apps/office/tools/verify.sh` (import + tests + flow, engine-error gated):

```
Godot: 4.7.2.stable.official.ed1daf0bf
import         exit=0 engine_errors=0
tests          exit=0 engine_errors=0
flow           exit=0 engine_errors=0
  passed: 9463
  RESULT: PASSED
  checks: 34, failures: 0
  FLOW RESULT: PASSED
VERIFY: PASSED
```

**The check found a real weakness on its first run.** `search-stops-reading-coverage`
was NOT detected: the original coverage-search test used "sandbox"/"quota"/"ntfy",
all of which also appear in the pages' *description* lines, so the test passed
through a different field and proved nothing about the coverage index. The test now
uses terms that are coverage-only (`verbosity`, `counters`, `colour`, `Leader`) and
asserts that premise explicitly before asserting the match.

### The runner's own vacuous-pass trap (fixed)

While adding the scaled-floor assertion the new suite failed to COMPILE
(`var content_w := size.x - sidebar_w` inferred Variant from an untyped array).
The engine reported a parse error, no case executed — and `run_tests.gd` still
printed `RESULT: PASSED` around **zero** assertions. The full run reported
`passed: 8995` while the suite was silently absent, which is exactly the trap the
Godot checks skill warns about.

`tests/run_tests.gd` now fails when no assertion ran:

```
if _passed == 0:
    print("RESULT: FAILED (no assertions ran)")
    quit(1)
```

### A real preference was written by this suite (found, fixed, guarded)

While attributing the sidebar width, `git status` showed a new untracked
`apps/office/Godot/app_userdata/YCoding Office/`. Investigating the outside effect
rather than the test showed the cause: `test_the_page_is_remembered_per_project`
drove `select_folder`, and `ProjectLedger.save()` writes `user://projects.cfg`
**unconditionally** — unlike `OfficeViewState`, it has no instance path a caller can
redirect. So the suite overwrote the project list a person is using.

State found and what was done:

- The real file
  (`~/Library/Application Support/Godot/app_userdata/YCoding Office/projects.cfg`)
  contained **only this lane's own synthetic `/tmp/ycoding-r301-*` entries** — no
  user data was lost, and `motion.cfg` / `r7_05_capture_budgets.cfg` are untouched.
  Nothing was restored because there was nothing of the user's to restore.
- The test now drives the same two halves a switch uses (`_capture_view_state` /
  `_restore_view_state`) instead of `select_folder`, so the property is still proven
  without persisting anything.
- A new case, `test_the_surface_writes_no_preference`, digests the real
  `user://projects.cfg` before and after driving every page and every scope and
  requires it unchanged — asserting the outside effect, which inspection cannot show.
- The scratch directory `apps/office/Godot/` is an untracked artifact of this
  lane's runs and is reported rather than silently removed.

**Not fixed here:** `ProjectLedger` has no instance path, so ANY test that calls
`select_folder` writes that real file. The remaining writers are
`tests/suites/test_folder_target.gd:254` and the parent-owned
`tests/suites/test_production_boot.gd` (six calls). Giving the ledger the same
instance-path seam `OfficeViewState` has is a `core/project_ledger.gd` change
outside this lane's ownership. Reported for its owner; this lane's suite no longer
contributes.

### Native captures

`ycoding-office-repair-kit/tools/r301_capture.gd` boots the real `res://app/main.tscn`,
opts into synthetic playback through the production action, routes to Settings
through `_on_route_requested`, and writes a PNG plus the panel's real logical rects.

```
R301 route=settings visible=true page=general scope=global
R301 window=(1280.0, 720.0)
R301 settings_rect=[P: (434.62, 16.0), S: (707.76, 688.0)]
R301 sidebar_rect=[P: (0.0, 0.0), S: (350.0, 720.0)]
R301 office_visible=false composer_visible=false statistics_visible=false
R301 nav_rows=20 offered_scopes=["global"]
```

At 150% text the page reflows: `settings_rect=[P: (562.33, 16.0), S: (600.84, 688.0)]`.
With `--search=ntfy` the navigation collapses to `nav_rows=1`, which is the filter
working on the rendered surface.

Artifacts (all hash-distinct), in `ycoding-office-repair-kit/evidence/r3-01/`:

| File | State |
| --- | --- |
| `r3-01-general.png` | Application / General |
| `r3-01-permissions.png` | Runtime / Permissions and guardrails |
| `r3-01-advanced.png` | Advanced / Configuration and environment |
| `r3-01-default-search-ntfy.png` | filtered by `ntfy` |
| `r3-01-appearance.png` | Appearance at 100% |
| `r3-01-appearance-1.50.png` | Appearance at 150% |

### Sidebar width: attributed, not caused by this change

The capture reports `sidebar_rect` 350 wide against a declared 297. This was
investigated rather than assumed: a probe removed the new Settings route row and
re-measured, and the sidebar minimum stayed at **350**. The driver is long
session/project labels (`'Implement the OAuth callback and tests.'` → 284) inside
the scrolling section, i.e. a pre-existing under-reservation in
`SIDEBAR_CONTENT_FLOOR`, not the fourth nav row. Not fixed here: it is outside
R3-01's acceptance and `office_shell_layout.gd` is shared.

## Open items

1. **Visual fidelity is NOT closed.** The user directed that high-fidelity styling
   matching the supplied references is mandatory and that screenshot-driven
   production styling pauses until the visual spec is validated. The functional
   surface above is built and tested; its styling is not claimed as final. R3-01
   must not be closed on visual grounds until that spec lands.
2. **`sidebar_rect` is 350 wide against a declared 297.** Attributed above to the
   pre-existing `SIDEBAR_CONTENT_FLOOR` under-reservation (long session/project
   labels), NOT to the new route row: removing that row leaves the minimum at 350.
   Reported, not fixed — outside R3-01's acceptance and in a shared file.
3. **R3-02 remains blocked** on an additive `server.config` public contract, which
   is an explicit scope decision for the user. Nothing in this lane's work depends
   on it, and no save is implemented or faked.
4. Documentation update required but **not made** (shared file, parent-owned):
   `docs/runtime.md` — record the Settings route and the four-scope model; and
   `docs/configuration.md` — the scope-to-document mapping the selector names.
5. **Not marked done.** `tracking/tasks.json` and `tracking/evidence.json` are the
   kit's ledgers and are not edited by this lane.

## Files changed by this lane

New (repository source):

- `apps/office/core/settings_group.gd` (+ `.uid` from the import pass)
- `apps/office/core/settings_scope.gd` (+ `.uid`)
- `apps/office/ui/settings/settings_panel.gd` (+ `.uid`)
- `apps/office/tests/suites/test_settings_navigation.gd` (+ `.uid`)

Modified (repository source):

- `apps/office/app/main.gd`, `apps/office/app/main.tscn`
- `apps/office/ui/shell/office_route.gd`
- `apps/office/ui/shell/office_shell_layout.gd`
- `apps/office/ui/shell/office_view_state.gd`
- `apps/office/tests/run_tests.gd`
- `apps/office/tests/suites/test_routes.gd`

New (kit only, no repository source depends on them):

- `ycoding-office-repair-kit/tools/r301_capture.gd`
- `ycoding-office-repair-kit/tools/r301_mutations.py`
- `ycoding-office-repair-kit/evidence/r3-01/*.png` (6 captures)
- `ycoding-office-repair-kit/tracking/r3-01-resumed.md` (this file)

No temporary driver remains: `apps/office/tools/_r301_one.gd` and
`apps/office/tools/_r301_capture.gd` (staging copies) were deleted with their
`.uid` files, and `git status --short apps/office | grep r301` is empty. The
sidebar probe was likewise deleted.

Not touched: `test_production_boot.gd` (parent-owned), `tracking/tasks.json`,
`tracking/evidence.json`, `docs/runtime.md`, `docs/configuration.md`.
