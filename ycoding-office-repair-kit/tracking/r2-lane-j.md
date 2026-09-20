# Lane J — composer submit contract (Enter / Shift+Enter)

Status: **complete and verified**. Date: 2026-09-16. Repo `main` @ `a4bb99e`.
Engine: `/Applications/Godot.app/Contents/MacOS/Godot` = `4.7.2.stable.official.ed1daf0bf`.
All Godot invocations ran under `ycoding-office-repair-kit/tools/godot_lock.sh`; `pgrep -fl Godot` is empty after the last run.
No git mutating command was run; nothing was staged or committed.

## 1. Files owned and changed

| Path | Change |
| --- | --- |
| `apps/office/ui/prompt/prompt_panel.gd` | rewrote `_on_input_event`, added `_asks_for_a_newline`, 3-line key-map note in the class docs |
| `apps/office/tests/suites/test_composer_submit.gd` | NEW suite, 15 tests / 38 assertions |
| `apps/office/tests/run_tests.gd` | one added registration line (`preload("res://tests/suites/test_composer_submit.gd")`) |
| `apps/office/tests/suites/test_composer_submit.gd.uid` | engine-generated companion on first import; the repo commits a `.uid` for every script (79 tracked), so it is left in place |

Not touched (owned elsewhere): `app/main.gd`, `office_shell_layout.gd`, `chrome_toggles.gd`, `office_theme.gd`, `packages/**`.
`git status` also shows other lanes' files (`.github/workflows/*`, `apps/office/tools/verify-integration.sh`, `script/office_*`) — untouched by this lane.

## 2. Defect confirmed before the change (independent of the delivered test)

Diagnostic probe `/tmp/ycoding_lane_j_probe.gd` (direct drive of `_on_input_event` with synthetic keys, text `"hello"`, caret at end):

```
--- plain Enter ---      emitted=[]        text_changed=false
--- Shift+Enter ---      emitted=[]        text_changed=false
--- Ctrl+Enter ---       emitted=["hello"] text_changed=false
--- Alt+Enter ---        emitted=[]        text_changed=false
--- Meta+Enter ---       emitted=["hello"] text_changed=false
--- whitespace Enter --- emitted=[]        text_changed=false
--- empty Enter ---      emitted=[]        text_changed=false
```
Command: `godot_lock.sh /Applications/Godot.app/Contents/MacOS/Godot --headless --path apps/office --script /tmp/ycoding_lane_j_probe.gd`, cwd `/Users/viadz/Workspace/Project/ycoding`, exit 0 (log `/tmp/lane_j_probe4.log`).
Confirms the report exactly: plain Return did nothing, Shift/Alt+Return were unhandled, and Ctrl+Return / Cmd+Return were the only submit keys.

Baseline full suite before any lane-J edit (same command as §4, registration not yet added):
`passed: 6234, failed: 0, RESULT: PASSED`, exit 0, 0 engine errors (log `/tmp/lane_j_baseline_suite.log`) — matches the orchestrator's stated baseline.

## 3. RED (test written first, run before the implementation changed)

```
cd /Users/viadz/Workspace/Project/ycoding
/Users/viadz/Workspace/Project/ycoding/ycoding-office-repair-kit/tools/godot_lock.sh \
  /Applications/Godot.app/Contents/MacOS/Godot --headless --path apps/office --script res://tests/run_tests.gd
EXIT=1   engine_errors=0   (log /tmp/lane_j_red.log)
=== office test summary ===
passed: 6257
failed: 15
  FAIL: a bare Return submits the draft
  FAIL: the reported text is trimmed
  FAIL: a one-argument handler still receives the text
  FAIL: one press fires the signal exactly once
  FAIL: it inserts a newline at the caret
  FAIL: the caret's line is broken in two
  FAIL: the caret follows the inserted break
  FAIL: Ctrl+Return does not submit
  FAIL: it inserts a newline
  FAIL: it inserts a newline
  FAIL: Cmd+Return does not submit
  FAIL: it inserts a newline, like Ctrl+Return
  FAIL: the keypad Return submits like the main one
  FAIL: the draft is submitted
  FAIL: and it still says what it sends
RESULT: FAILED
```
Every failure is the intended behavioural mismatch in the new suite; no parse/setup error (engine_errors=0, exit 1 comes from the failed assertions).
The 23 assertions that already passed at RED are the criteria that already held (AC3 whitespace/empty, echo, key releases, non-Return keys, the signal's existence) — recorded as already-satisfied, not manufactured as failures.
One RED failure was a test defect, not a product defect: `and it still says what it sends` asserted the send button's tooltip before the host sets a mode; `app/main.gd:143` calls `prompt_panel.set_mode(OfficeStore.MODE_DEMO)` at startup, so the test now mirrors the host and the assertion is made after `set_mode`.

## 4. Implemented behaviour (the submit / newline matrix)

`_on_input_event` now consumes every Return press it recognises, so the editor's own
handling never runs for a key the composer has decided about:

| Event | Result |
| --- | --- |
| `KEY_ENTER` (bare, pressed, not `echo`) | `_on_send()` → `prompt_submitted(trimmed)` exactly once, draft kept |
| `KEY_KP_ENTER` (bare) | same as `KEY_ENTER` (a terminal's `return` is one key) |
| `KEY_ENTER` + Shift | `insert_text_at_caret("\n")` at the caret, no submit |
| `KEY_ENTER` + Ctrl | newline, no submit (TUI `input_newline`) |
| `KEY_ENTER` + Alt | newline, no submit (TUI `input_newline`) |
| `KEY_ENTER` + Cmd/meta | newline, no submit (Cmd ≡ Ctrl, `Shortcuts.MOD` convention) |
| `KEY_ENTER` repeated (`echo`) | consumed, no submit, no newline |
| `KEY_ENTER` release | ignored |
| any other key / mouse event | untouched, left to the editor |
| composition active (`_input.has_ime_text()`) | the key is **not** consumed and nothing is submitted: the editor keeps it so the composition can settle |
| draft empty or whitespace-only | consumed, `_on_send` returns before emitting — no submit, and no stray blank line |

## 5. GREEN

```
cd /Users/viadz/Workspace/Project/ycoding
/Users/viadz/Workspace/Project/ycoding/ycoding-office-repair-kit/tools/godot_lock.sh \
  /Applications/Godot.app/Contents/MacOS/Godot --headless --path apps/office --script res://tests/run_tests.gd
EXIT=0   (log /tmp/lane_j_green.log)
=== office test summary ===
passed: 6272      (baseline 6234 + 38 new assertions)
failed: 0
RESULT: PASSED
grep -E "SCRIPT ERROR|Parse Error|Compile Error" → 0 matches
```
New suite = 38 assertions: 6234 → 6272.

Full gate (`verify.sh` = import + suite + flow, run under the same lock):

```
cd /Users/viadz/Workspace/Project/ycoding
/Users/viadz/Workspace/Project/ycoding/ycoding-office-repair-kit/tools/godot_lock.sh apps/office/tools/verify.sh
VERIFY_EXIT=0   (log /tmp/lane_j_verify.log)
Godot: 4.7.2.stable.official.ed1daf0bf
import         exit=0 engine_errors=0
tests          exit=0 engine_errors=0
flow           exit=0 engine_errors=0
  passed: 6272
  RESULT: PASSED
  checks: 18, failures: 0
  FLOW RESULT: PASSED
VERIFY: PASSED
```
No neighbouring suite regressed (`test_effort_slider`, `test_sidebar`, `test_shortcuts`, `test_ui_scale` all included in the 6272 with 0 failures).

## 6. Acceptance criteria → evidence

| AC | Criterion | Test / assertion | RED (before) | GREEN (after) |
| --- | --- | --- | --- | --- |
| AC1 | bare Enter submits a non-empty draft | `test_a_bare_return_submits_the_draft` (3 assertions), `test_a_submission_reports_the_trimmed_text_and_keeps_the_draft` (2), `test_both_return_keys_submit` (1) | `FAIL: a bare Return submits the draft`, `FAIL: the reported text is trimmed`, `FAIL: the keypad Return submits like the main one` | pass |
| AC2 | Shift/Ctrl/Alt+Enter insert a newline, plain Enter stays submit | `test_shift_return_inserts_a_newline_at_the_caret` (4), `test_ctrl_return_inserts_a_newline_without_submitting` (2), `test_alt_return_inserts_a_newline_without_submitting` (2), `test_the_command_modifier_is_the_same_newline_binding` (2) | `FAIL: it inserts a newline at the caret`, `FAIL: the caret's line is broken in two`, `FAIL: the caret follows the inserted break`, `FAIL: Ctrl+Return does not submit`, `FAIL: it inserts a newline` ×2, `FAIL: Cmd+Return does not submit`, `FAIL: it inserts a newline, like Ctrl+Return` | pass (assertions include the exact text `hel\nlo` for a caret mid-text, line count 2, and the caret landing on the new line) |
| AC3 | whitespace-only never submits; empty never submits | `test_whitespace_only_input_never_submits` (2), `test_return_on_an_empty_composer_does_not_submit` (2) | already holding — both passed at RED (no FAIL lines), and they keep holding after the change | pass |
| AC4 | an active composition is never submitted | `test_the_editor_exposes_the_composition_state_the_guard_reads` (2); guard is `if _input.has_ime_text(): return` before any submit | n/a (new guard) | pass — see limitation in §7.1 |
| AC5 | `prompt_submitted(text: String)` unchanged, exactly once, trimmed | `test_the_submit_signal_is_unchanged_for_the_host` (5: signal exists, one argument, argument is `TYPE_STRING`, a one-argument handler receives the text, exactly one emission) | `FAIL: a one-argument handler still receives the text`, `FAIL: one press fires the signal exactly once` | pass; `app/main.gd` unmodified (`git diff` lists no change to it) |
| AC6 | the draft is not cleared on submit | `test_a_bare_return_submits_the_draft` (`current_text() == "hello"`), `test_a_submission_reports_the_trimmed_text_and_keeps_the_draft` (raw text `"  hello  \n  "` survives), `test_whitespace_only_input_never_submits` | text-keeping assertions passed at RED and still pass | pass |
| AC7 | error/notice and disabled affordances stay coherent | `test_a_submission_leaves_the_controls_coherent` (6: submit reported, send control enabled, send tooltip non-empty, approval control still disabled, approval tooltip non-empty, composer's own notice never invented) | `FAIL: the draft is submitted`, `FAIL: and it still says what it sends` | pass |

## 7. Unverified, disclosed, and findings

1. **AC4 positive path is NOT exercised by any automated check.** Godot 4.7.2 exposes only `TextEdit.has_ime_text()`, `cancel_ime()`, `apply_ime()`, `get_line_with_ime(line)` and `DisplayServer.ime_get_text()`; there is no property or setter that can put a composition into a headless `TextEdit`, and `DisplayServer.get_name()` is `headless` in this environment (probe log `/tmp/lane_j_probe2.log`). What is verified: the engine surface the guard reads exists and reports `false` for a plain editor, every submit test traverses the guard, and the guard is placed **before** any submission and does **not** consume the key (so a composition can settle instead of being swallowed). The claim "a composition is never submitted" is therefore a code-path claim, not an observed suppression.
2. **Live-window suppression of the editor's own handling is not proven headlessly.** The handler consumes the key with `accept_event()`, which is the documented way to stop `TextEdit`'s built-in handling from running after the `gui_input` signal; the previous code already relied on that for its Ctrl+Enter submit. The headless runner cannot drive the real viewport path — `SceneTree.root` is not inside the tree during the runner's `_init`, so `push_input`/`grab_focus` error there (probe log `/tmp/lane_j_probe3.log`) — so "one Enter = one submit with no stray newline in a live window" is not covered by an automated assertion. Recommended manual check on the running client: Enter, Shift+Enter, Ctrl+Enter, Alt+Enter, and Enter on an empty box.
3. **`Ctrl+J` (the TUI's fourth `input_newline` binding) was deliberately not implemented.** The task named Ctrl+Enter and Alt+Enter; in Godot, Ctrl+J arrives as `KEY_J` + Ctrl and is left to the editor (which inserts nothing). Kept out to avoid adding a binding with no agreed contract — orchestrator decision if strict parity is wanted.
4. **Numpad Return (`KEY_KP_ENTER`) is included** and tested, because a terminal's `return` (the TUI binding) is one key while Godot distinguishes the two. Plain `Enter` remains the submit binding named in AC1.
5. **Cmd/meta + Enter changed from submit to newline** (deliberate). The application already treats Cmd on macOS and Ctrl elsewhere as one shortcut modifier (`app/shortcuts.gd`, `Shortcuts.MOD = KEY_MASK_CMD_OR_CTRL`), and the TUI binds `ctrl+return` to a newline, so Cmd+Enter is that same binding on macOS. Pinned by `test_the_command_modifier_is_the_same_newline_binding`. If the orchestrator wants Cmd+Enter to keep submitting, that is a one-line change plus one assertion.
6. **Pre-existing, not fixed:** before the host calls `set_mode`, the send button carries no tooltip (the panel's own default is `MODE_DEMO`); `app/main.gd:143` sets the mode at startup so the live window is coherent, and the AC7 test now mirrors the host. Reported rather than changed, to stay inside this lane's boundary.
7. **Headless leak warnings grew** from 2 RIDs / 7 ObjectDB at baseline to 16 RIDs / 35 ObjectDB, because the new suite builds 15 `PromptPanel`s outside a tree (the same pattern `test_effort_slider`/`test_shortcuts` already use). `verify.sh` fails only on `SCRIPT ERROR|Parse Error|Compile Error` and reports `engine_errors=0`; the exit-time `ERROR: 1 resources still in use at exit` line is present identically in the pre-change baseline log.
8. **Not verified by this lane:** any real-window visual/UX check, and the DEMO/LIVE notice text produced by `app/main.gd` (owned by another lane; its handler signature is unchanged).

## 8. Re-run after the last edit (evidence kept current)

The only edit after the GREEN run was a test-code rename (`_return_event` → `_key_press`, with its doc corrected to say it presses any key, not only Return), so both gates were run again on the final tree:

```
cd /Users/viadz/Workspace/Project/ycoding
/Users/viadz/Workspace/Project/ycoding/ycoding-office-repair-kit/tools/godot_lock.sh apps/office/tools/verify.sh
VERIFY_EXIT=0   (log /tmp/lane_j_verify_final.log)
import exit=0 engine_errors=0 / tests exit=0 engine_errors=0 / flow exit=0 engine_errors=0
passed: 6272   RESULT: PASSED   checks: 18, failures: 0   FLOW RESULT: PASSED   VERIFY: PASSED
pgrep -fl Godot → no processes
```
No repository file was edited after this run. `pgrep -fl Godot` is empty; nothing was staged, committed, pushed or tagged.
