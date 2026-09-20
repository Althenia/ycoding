# R1 lane G — production boot and service discovery (R1-01, R1-02)

Owner: lane G (`zeus`). Scope: `apps/office/app/main.gd`,
`apps/office/integration/service_registration.gd`,
`apps/office/ui/shell/sidebar_panel.gd` (mode/connection affordance only),
`apps/office/tests/suites/*`, `apps/office/tools/flow_check.gd`.

Revision under test: git `main`, HEAD `a4bb99e`. Working tree clean apart from the
untracked `ycoding-office-repair-kit/`.

## 1. Current facts (verified in checkout, before any edit)

Godot binary: `/Applications/Godot.app/Contents/MacOS/Godot`, `4.7.2.stable`.
Run command (all runs locked through `ycoding-office-repair-kit/tools/godot_lock.sh`):

```
/Users/viadz/Workspace/Project/ycoding/ycoding-office-repair-kit/tools/godot_lock.sh \
  /Applications/Godot.app/Contents/MacOS/Godot --headless --path apps/office \
  --script res://tests/run_tests.gd
```

Baseline (pre-change, cwd `/Users/viadz/Workspace/Project/ycoding`):

- exit `0`, `passed: 6234`, `failed: 0`, `RESULT: PASSED`
- `grep -cE "SCRIPT ERROR|Parse Error|Compile Error"` over the log: `0`
- log: `/tmp/lane-g-baseline-tests.log`

### D1 — unconditional demo boot (confirmed)

| Claim | Evidence |
|---|---|
| `_ready` starts synthetic playback on every launch | `app/main.gd:95` `_start_demo()` — the call is unconditional, inside `_ready` |
| `_start_demo` fabricates an occupied office | `app/main.gd:134` `func _start_demo()` sets `store.mode = MODE_DEMO`, loads `res://fixtures/oauth-workplace.jsonl`, and `demo.play(true)` |
| The fixture exists and is real | `apps/office/fixtures/oauth-workplace.jsonl` |

### D2 — synthetic catalogue installed on every refresh (confirmed)

| Claim | Evidence |
|---|---|
| `_model_catalog()` has no mode gate | `app/main.gd:583` `func _model_catalog()` returns `ModelCatalog.demo_catalog()` with no branch |
| It is called from `_refresh_ui` | `app/main.gd:862` `prompt_panel.set_models(_model_catalog(), _default_model_ref())` inside `func _refresh_ui()` |
| `_refresh_ui` runs on every state change | called from `_on_event` (every applied event), `_on_connection_changed`, `_on_live_failure`, `_on_reload_required`, `_on_reload_ready`, `_on_reload_failed`, `_on_attention_replied`, `_on_agent_selected`, `_on_actor_selected`, `_repaint_theme`, `_on_mode_toggle` |
| `_refresh_models()` already gates correctly, so the overwrite is the defect | `app/main.gd:203-221` guards `store.mode != MODE_LIVE`; on a failed LIVE fetch it calls `prompt_panel.set_models([], "")`, records `models_api.last_error()` in `store.last_error`, then calls `_refresh_ui()` — which immediately reinstalls `demo_catalog()` |

Consequence: a LIVE session whose model fetch failed shows the fabricated
openrouter/anthropic/openai model list, labelled "demo list", as if the runtime
had offered it.

### D3 — demo reachability from the sidebar (confirmed)

| Path | Evidence |
|---|---|
| Mode toggle | `app/main.gd:243` `func _on_mode_toggle()` → `start_demo_mode()` when the store is LIVE |
| Direct entry point | `app/main.gd:219` `func start_demo_mode()` → `_start_demo()` |
| Sidebar control that routes there | `ui/shell/sidebar_panel.gd` `_product_button.pressed -> mode_toggle_requested`; `main.gd` connects `sidebar.mode_toggle_requested` to `_on_mode_toggle` |

This path is a legitimate explicit user action and is retained, not removed.
Labelling already exists and is preserved: sidebar mode row `DEMO` +
"Synthetic playback — no runtime work is executed" (`sidebar_panel.gd`
`_refresh_mode`/`_detail_text`), composer pill suffix "· demo list"
(`prompt_panel.gd` `_refresh_pill`), composer send tooltip "DEMO: submitting
records the text locally only".

### Additional finding not in the brief — store default

`core/office_store.gd:32` `var mode: String = MODE_DEMO`. A store that is never
explicitly assigned reads as DEMO, so the sidebar badge would claim synthetic
playback for a launch that never ran any. The composition root must assign the
boot mode explicitly; the store default itself is out of this lane's file
ownership and is left unchanged.

### Additional finding — the demo entry point is not currently safe to reach

`start_demo_mode()` (`app/main.gd:219`) calls
`live.event_ready.disconnect(_on_event)` without an `is_connected` guard. Today
it is always reached from a LIVE store that `start_live` connected, so it holds.
Once boot can leave the store LIVE and *disconnected* (never having connected the
signal), that line would raise an engine error. Fixed in step 3.

### AC5 — already satisfied, to be re-verified not re-implemented

`integration/service_registration.gd` is two pure `static func`s
(`candidates`, `is_usable`); it performs no I/O at all, so it cannot start, stop
or signal a daemon. `candidates` precedence (override, then
`$XDG_STATE_HOME/ycoding/service.json`, then `~/.local/state/ycoding/service.json`)
and the `is_usable` URL rule are already pinned by
`tests/suites/test_service_registration.gd`. The documented schema
`{ url, pid, password?, id?, version? }` matches
`packages/client/src/effect/service.ts` `Info` (`id?`, `version?`, `url`, `pid`,
`password?`) and the path fallback `join(state, "ycoding", "service.json")` at
`packages/client/src/effect/service.ts:184`.

## 2. RED — regression tests written first

New suite: `apps/office/tests/suites/test_production_boot.gd`, registered in
`apps/office/tests/run_tests.gd`. Twelve cases, one per acceptance criterion:

| Test (function) | Criterion |
|---|---|
| `test_a_launch_without_a_registration_fabricates_nothing` | AC1 |
| `test_the_disconnected_rail_offers_a_wired_retry` | AC1 |
| `test_retrying_without_a_registration_keeps_the_composer_draft` | AC1 |
| `test_a_registration_attaches_live_without_a_toggle` | AC2 |
| `test_the_registered_value_reaches_the_transport_and_is_never_rendered` | AC2, R1-02 |
| `test_live_never_installs_the_synthetic_catalogue` | AC4 (D2) |
| `test_a_live_state_change_never_installs_the_synthetic_catalogue` | AC4 (D2) |
| `test_demo_still_offers_the_labelled_synthetic_catalogue` | AC3 |
| `test_demo_is_reached_only_through_the_explicit_action` | AC3 |

The boot decision is driven through `_boot_with(registration)` with the wiring
`_ready` performs (`_wire_signals`), so the tests exercise the production path and
never the machine's own registration.

D1 also gets a real-scene proof: `tools/flow_check.gd` now points discovery at a
missing path before the scene is added, asserts the boot fabricated nothing, and
THEN enters demo through the explicit action before driving the demo clock.

### RED evidence (defects deliberately re-introduced to prove the tests detect them)

Command (cwd `/Users/viadz/Workspace/Project/ycoding`), one Godot run at a time
through the lock helper:

```
ycoding-office-repair-kit/tools/godot_lock.sh /Applications/Godot.app/Contents/MacOS/Godot \
  --headless --path apps/office --script res://tests/run_tests.gd
```

Result: exit `1`, `passed: 6316`, `failed: 7`, `RESULT: FAILED`,
engine errors `0`. Log `/tmp/lane-g-red.log`. Raw failure text:

```
  FAIL: the composer offers no model after the read failed
  FAIL: the synthetic catalogue is not installed in LIVE
  FAIL: the composer says there are none (expected No models, got Default)
  FAIL: and the pill cannot act
  FAIL: a LIVE refresh installs no model list
  FAIL: certainly not the synthetic one
  FAIL: a later event refresh still installs none
```

These 7 are exactly the D2 mechanism: `_model_catalog()` returned the synthetic
catalogue unconditionally, so both the fetch path and every later `_refresh_ui`
state change reinstalled it.

D1 RED, from the scene-level flow check (same command shape with
`--script res://tools/flow_check.gd`), with `_ready` calling `_start_demo()` again:

```
EXIT=1
checks: 34, failures: 10
FLOW RESULT: FAILED
  FAIL: the boot did not enter DEMO
  FAIL: the boot takes the live path
  FAIL: the missing service is stated as a disconnection
  FAIL: the boot starts no synthetic playback
  FAIL: the boot installs no synthetic model catalogue
  FAIL: the disconnected office says why
  FAIL: it names the registration that was not found
  FAIL: and names the command that fixes it
  FAIL: and offers a reachable retry
  FAIL: the rail shows the same message the office recorded
```

Engine errors `0`; log `/tmp/lane-g-red-flow.log`. The suite-level AC1 cases did
NOT go red under D1 alone because they drive `_boot_with` directly and the defect
lived in `_ready`; that is precisely why the scene-level check was added.

## 3. GREEN — implementation

Changed files (this lane):

- `apps/office/app/main.gd`
  - `_ready` now calls `_boot_live()` instead of `_start_demo(); _refresh_ui()`.
  - new `NO_SERVICE_MESSAGE` constant: names `service.json` and
    `ycoding service start`.
  - new `_boot_live()`, `_boot_with(registration)`, `_enter_disconnected_live(message)`,
    `_retry_connection()`.
  - `_wire_signals()` extracted from `_ready` so the boot decision is drivable
    without the scene.
  - `_model_catalog()` now returns `_service_models` unless the mode is DEMO.
  - new `_service_models` field holds the service's own last read.
  - `_refresh_models()` stores the fetched list in `_service_models`.
  - `start_live()` connects its transport signals only when not already connected,
    so a reconnect (retry) cannot double-connect.
  - `start_demo_mode()` disconnects `live.event_ready` only when connected, for
    the same reason.
  - `_on_mode_toggle()` routes through `_boot_with(_read_service_registration())`.
- `apps/office/ui/shell/sidebar_panel.gd`
  - new `retry_connection_requested` signal and `_retry_button`, visible and
    enabled only while LIVE and not attached, with `retry_available()` as the
    observable accessor.
- `apps/office/tests/suites/test_production_boot.gd` (new), registered in
  `apps/office/tests/run_tests.gd`.

GREEN run, same command:

- exit `0`, `passed: 6325`, `failed: 0`, `RESULT: PASSED`, engine errors `0`
  (log `/tmp/lane-g-green-tests.log`)
- flow: exit `0`, `checks: 34, failures: 0`, `FLOW RESULT: PASSED`,
  engine errors `0` (log `/tmp/lane-g-green-flow.log`)

## 4. AC6 — rejected assertions re-pointed

| Old assertion | New assertion (same file, same test) |
|---|---|
| `test_office_store.gd` `test_demo_store_has_no_live_mutation_path`: `t.check_equal(store.mode, OfficeStore.MODE_DEMO, "store defaults to DEMO")` | a fresh store fabricates no actor/history/root session, then `store.mode` is set explicitly and the no-mutation-method assertion is unchanged |
| `test_asset_provenance.gd` `test_demo_never_answers_a_human_request`: `t.check_equal(store.mode, OfficeStore.MODE_DEMO, "the office starts in DEMO")` | the mode is assigned explicitly; the DEMO-refusal and still-pending assertions are unchanged |
| `flow_check.gd` `_verify`: `_check(store.mode == OfficeStore.MODE_DEMO, "mode stays DEMO")` at boot | `_verify_production_boot()` asserts no DEMO at boot; `_verify()` asserts the explicit action entered DEMO, plus the labelled synthetic catalogue and no retry in DEMO |

No assertion was deleted or weakened: each re-pointed case keeps its original
behavioral claim (no mutation path, refusal stays pending, DEMO is labelled)
alongside the new boot contract.

### Assertion-count accounting

- baseline: 6234
- + 12 `test_production_boot.gd` cases (some multi-assertion) and the re-pointed
  cases: 6325 at GREEN, with 7 of those assertions proven RED under D2 and 10 flow
  checks proven RED under D1.

## 4b. A defect found in this lane's own fix (RED then GREEN)

While reviewing the diff, DEMO -> LIVE with no registration was found to leave
the synthetic actors, their history and the running synthetic clock on screen
under a LIVE badge — the same fiction-as-fact the repair exists to prevent.
`_enter_disconnected_live` set the mode and message but never discarded the
projection.

Regression test added first: `test_leaving_demo_without_a_service_discards_the_synthetic_office`.

RED (cwd `/Users/viadz/Workspace/Project/ycoding`):

```
ycoding-office-repair-kit/tools/godot_lock.sh /Applications/Godot.app/Contents/MacOS/Godot \
  --headless --path apps/office --script res://tests/run_tests.gd
```

exit `1`, `passed: 6330`, `failed: 3`, engine errors `0`, log `/tmp/lane-g-red2.log`:

```
  FAIL: synthetic playback is stopped
  FAIL: no synthetic actor survives the transition
  FAIL: no synthetic history survives it
```

Fix: new `_reset_projection()` (stops the demo transport, replaces the store,
rebinds the viewport) is called by both `_enter_disconnected_live` and
`start_live`, so one mode's facts can never be presented as another's on either
transition. The composer draft is not part of the projection and survives (pinned
by `test_retrying_without_a_registration_keeps_the_composer_draft`).

GREEN: exit `0`, `passed: 6333`, `failed: 0`, `RESULT: PASSED`, engine errors `0`
(log `/tmp/lane-g-green2.log`).

## 5. AC1-AC6 evidence summary

| Criterion | Test / assertion | Command | Result |
|---|---|---|---|
| AC1 no fabricated actors, honest state, actionable message, retry, draft survives | `test_production_boot.gd::test_a_launch_without_a_registration_fabricates_nothing` (mode LIVE, connection disconnected, no actors/interactions/root, demo not playing, message names `service.json` + `ycoding service start`, rail shows it in danger colour); `::test_the_disconnected_rail_offers_a_wired_retry`; `::test_retrying_without_a_registration_keeps_the_composer_draft`; `flow_check.gd::_verify_production_boot` | `godot_lock.sh Godot --headless --path apps/office --script res://tests/run_tests.gd`; same with `--script res://tools/flow_check.gd` | PASS; RED proven under D1 (10 flow failures) |
| AC2 attaches LIVE automatically | `::test_a_registration_attaches_live_without_a_toggle` (mode LIVE, `live.base_url()` == registered URL, `live.is_playing()`, demo not playing, connection not claimed before the service answers); `flow_check.gd` with `YCODING_SERVICE_FILE` pointed at a real fixture registration against a listening `tools/fixture_server.py` | attach variant of the flow command above | PASS (exit 0, 31 checks, 0 failures, 0 engine errors); no RED form exists because D1 made this unreachable before the fix |
| AC3 DEMO only on explicit action, labelled | `::test_demo_is_reached_only_through_the_explicit_action` (boot is LIVE and demo not playing; after `start_demo_mode()` mode DEMO, demo playing, catalogue identified synthetic, rail names DEMO and says "Synthetic", no retry); `::test_demo_still_offers_the_labelled_synthetic_catalogue`; `flow_check.gd::_verify` | test/flow commands above | PASS |
| AC4 LIVE never installs the synthetic catalogue | `::test_live_never_installs_the_synthetic_catalogue` (empty list, pill "No models" and disabled, `store.last_error == models_api.last_error()`); `::test_a_live_state_change_never_installs_the_synthetic_catalogue` | test command above | PASS; RED proven (7 failures, log `/tmp/lane-g-red.log`) |
| AC5 discovery read-only, precedence and schema preserved | `test_service_registration.gd` — all 5 cases unchanged and passing (`candidates` precedence override/state/home, unset skipped, config dir never searched, `is_usable` URL rule) | test command above | PASS; `integration/service_registration.gd` was NOT edited |
| AC6 rejected assertions re-pointed | see section 4 | test + flow commands above | PASS |

Final full-suite result: exit `0`, `passed: 6333`, `failed: 0`,
`RESULT: PASSED`, `SCRIPT ERROR|Parse Error|Compile Error` count `0`.

`apps/office/tools/verify.sh` (import + tests + flow, fails on any engine error):
exit `0`, `VERIFY: PASSED`.
`apps/office/tools/verify-integration.sh` (starts/stops the fixture server): exit
`0`, transport and attach stages passed.

## 6. Limitations and unverified items

- AC2 was verified against the loopback fixture server, not against a real
  installed `ycoding` daemon reached through its own registration file. The attach
  path, the registration read and the credential hand-off are exercised; a real
  daemon's `sourceEpoch` and live event vocabulary are not re-proven here.
- `test_production_boot.gd` never readies `OfficeViewport` (its `_ready` resolves
  nodes from the scene), so the boot tests prove the store, composer and rail and
  not the drawn world. The drawn-world boot state is covered by the scene-level
  `flow_check.gd`.
- The store's own `mode = MODE_DEMO` default (`core/office_store.gd:32`) is left
  unchanged: the file is outside this lane. The composition root now assigns the
  mode it presents on every path, and two suites no longer assert the default.
- `apps/office` has no README; the user-facing boot contract is documented in
  `docs/runtime.md` and `docs/configuration.md`, which are outside this lane's
  ownership and were NOT updated. The wording there ("LIVE ... entered only on an
  explicit request") should be reconciled with automatic attach by the owning lane.

## 7. Coordination for other lanes

- `tools/capture_scene.gd`, `capture_variants.gd`, `capture_report.gd`,
  `capture_effort.gd` and `measure_runtime.gd` all instantiate `main.tscn` and
  previously relied on the boot-time demo. They are not owned by this lane. The
  capture lane has since added `tools/demo_capture.gd` and preloads it from
  `capture_scene.gd`; this lane did not touch any of them.
- `docs/runtime.md:621-624` and `docs/configuration.md:583-591` describe the boot
  contract this change replaces.
- `apps/office/AGENTS.md` "Truthfulness rules" already states that DEMO is
  explicitly synthetic and that LIVE is entered on explicit request; the
  automatic attach is a change in when LIVE is entered and should be reflected in
  the package guide by its owner.
