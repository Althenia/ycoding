# SL TUI inventory

Lane rebased from `3962b14f` onto `codebase-cleanup` `1141158a`. Original-root local inventory; never stage this file. No package-local AGENTS exists under `packages/tui`; root rules apply. One file per Bun process (G13); never run the full TUI suite. Lane-owned targeted package typechecks are recorded per verified group; final integrated checks remain parent-owned, with heavy calls serialized by the 24 GiB resource gate.

## Basis and risk

G11 baseline: `bun test --cwd packages/tui --timeout 30000 test/composer-live-fixes.test.tsx`, exit 1, 7 pass / 9 fail, 69 assertions, 46.24s. Contract: TUI DESIGN T11/T12 and docs/runtime.md composer/receipt sections. Nonblocking dispatch supersedes blocking draft/status expectations and Escape cancellation of owned admission. Definitive attachment rejection and prompt-ID conflict must still be distinguished from uncertain admission (docs/runtime.md). That distinction is missing in the current receipt.

Primary risks: submitted input loss, exact-retry identity, admission-before-wake, independent editor lifetime, attachment cleanup, review precedence, input and layout fidelity. Techniques: lifecycle transitions, concurrency gates, exact-retry and negative-effect oracles, actual rendered frames. No real provider, terminal emulator, or PTY claim. Captured-child recovery and dedicated human-answer surfaces are untouched.

## G11 mapping before changes

| Original composer-live-fixes case/group | Disposition | Surviving assertion / layer | Baseline isolated ms |
| --- | --- | --- | --- |
| resident StartupGate stays mounted | rewrite | same test: actual resident frame and mounts=1 after readiness drops; component render | see full baseline log |
| permission review hides picker | rewrite | same test: frame keeps review, no Subagents/reviewer after Down; app render | see full baseline log |
| input inset/wrap cap/autocomplete placement | rewrite | same test: rule and row coordinates, cap-tail, scrolling, autocomplete above rule; app render | see full baseline log |
| missing clipboard image explicit removal | keep | same test: first send absent, retained text, explicit second send; app render/transport | see full baseline log |
| cancellable clipboard read and late cleanup | rewrite | same test: cancel frame, edited Unicode draft, no image, temporary absent; app render/filesystem | see full baseline log |
| admitted attachment wake retry | rewrite | same test: receipt below retained bubble, managed URI, cleanup, wake-only exact retry; app render/transport | see full baseline log |
| rejected attachment and corrected next prompt | rewrite | same test: definitive receipt, original attachment retained, local recovery discard then new independent prompt; app render/transport/filesystem | see full baseline log |
| uncertain attachment exact retry | rewrite | same test: unresolved receipt, same IDs, original temporary URI then managed wake, cleanup; app render/transport/filesystem | see full baseline log |
| skill preactivation/loading rejection | merge | prompt-recovery.screen: direct metadata without preactivation; submission.test: failed standalone skill stable retry and no prompt; app render + submission/client | see full baseline log |
| durable conflict stable identity | rewrite | same test: definitive receipt, retry via receipt, identical IDs and false/false/true resumes; app render/transport | see full baseline log |
| Escape cancels owned admission | rewrite | same test asserts current T11: Escape does not cancel transport; editable newer draft survives completion; app render/transport | see full baseline log |
| virtualized large paste full submission | keep | same test: virtualized frame and exact full request text; app render/transport | see full baseline log |
| running Session model choice applied before admission | rewrite | same test: gate start, no interrupt/admission, then model/admit/resume sequence; app render/transport | see full baseline log |
| failed model selection retains submission | rewrite | same test: unresolved receipt, no admission/wake, retained submitted text; app render/transport | see full baseline log |
| blocked model selection retains submission | rewrite | same test: blocked receipt, no admission/wake, retained submitted text; app render/transport | see full baseline log |
| subagent picker placement/metadata | rewrite | same test: frame text and coordinates plus readable span pairs; app render | see full baseline log |

## Execution scope

G11 is diagnosed and validated below. The package declaration index lists every test file and named declaration/group with existing assertion locations; other dispositions are initial triage, not semantic completion. Package-wide leaning is not complete. Release-leg and design-drift suites remain retained.

## G11 verified outcome

- Reproduced defect: definitive `ConflictError` and `InvalidRequestError(field=files)` were labeled uncertain by the submission owner. Fix only those declared admission outcomes; preserve uncertain status, managed wake retries, immutable identity and current nonblocking ownership. No design rule changes. Existing docs/runtime.md defines this distinction; no new product contract.
- Stale blocking expectations are replaced with rendered receipt recovery. `$review text` preactivation case merges into the current metadata flow plus separate standalone failure guard. Escape now proves owned admission survives while a later draft remains editable. Early placeholder checks no longer stand in for actual transport completion. Touched composer file contains no Bun.sleep/setTimeout.
- G11 map baseline per-case ms in original order: 41.76, 2510.52, 2109.74, 1337.32, 2216.41, 8560.20, 3471.25, 3816.88, 3314.10, 3321.08, 3304.12, 1133.01, 1320.84, 3454.30, 3428.75, 1187.56. Durations include failing waits and are not a performance benchmark.
- RED: `bun test --cwd packages/tui test/prompt/submission.test.ts` after valid fixture setup: exit 1, 12 pass/2 fail, 159ms; exactly conflict and attachment phases fail. Uncertain status uses 503 and preserves the generated Client's `UnexpectedStatus` category (response is undeclared), not a fabricated server message. Render RED: composer durable-conflict filter, exit 1, missing definitive receipt, 7.75s.
- Mutation 1 (merged skill metadata): temporarily set `payload.metadata = undefined` immediately after capture in submission.ts. `bun test --cwd packages/tui --timeout 30000 test/screen/prompt-recovery.screen.test.ts -t 'direct skill metadata'`: exit 1, expected metadata absent, 2.45s. Exact patch removed.
- Mutation 2 (merged standalone lifecycle): temporarily bypass `if (entry.skillOnly)` in submission.ts. `bun test --cwd packages/tui test/prompt/submission.test.ts -t 'failed standalone skill'`: exit 1, owned failure transition absent, 149ms. Exact conditional restored. Final diff contains only the intended error classification production change.
- Three final-shape isolated runs, one file per process: composer `bun test --cwd packages/tui --timeout 30000 test/composer-live-fixes.test.tsx`: 15 pass/0 fail each, exit 0, 17.83s / 17.75s / 17.82s. Submission `bun test --cwd packages/tui test/prompt/submission.test.ts`: 14 pass/0 fail each, exit 0, 148ms / 140ms / 140ms.
- Actual loaded interval: package typecheck started 2026-10-03T02:53:08Z and ended 02:53:13Z, exit 0 (`bun run --cwd packages/tui typecheck`, tsgo --noEmit). Submission loaded started 02:53:08Z, 14/14, 145ms, exit 0. Composer loaded started 02:53:08Z and ended 02:53:26Z, 15/15, 18.02s, exit 0. Both overlapped the recorded typecheck interval. Earlier nominal loaded files without proved overlap are not counted. All commands capped at 8192 MiB.
- Neighbor: `bun test --cwd packages/tui --timeout 30000 test/screen/prompt-recovery.screen.test.ts`: exit 0, 11 pass/0 fail, 14.40s after precise probe restoration. This proves metadata and standalone loading render guards against final production.
- Touched-file lint: `bun run lint -- packages/tui/src/prompt/submission.ts packages/tui/test/composer-live-fixes.test.tsx packages/tui/test/prompt/submission.test.ts`: exit 0, 0 errors/12 existing warnings versus HEAD test-file copies 0 errors/13 warnings. Initial external-baseline lint attempt aborted because oxlint requires paths under its root; corrected with lane-local temporary HEAD copies, then removed them. Formatting owner: installed prettier; final formatting check and diff review recorded at commit boundary. Root checks/AGENTS remain parent-owned.
- Final formatter check exit 0; git diff --check exit 0; reviewed intended diff and clean lane after commit `bad6e9e8` (`fix(tui): distinguish definitive submission receipts`). Two touched test files remain two files; executed cases 27 → 29 (composer 16 → 15, submission 11 → 14), lines 1530 → 1541 (1040 → 1020 and 490 → 521). Baseline composer alone 46.24s with failures; final isolated composer median 17.82s and submission median 140ms. This is stability evidence, not profiler-backed performance evidence.

## Skill source-assertion mapping before changes

| Original group | Disposition | Surviving assertion / layer |
| --- | --- | --- |
| session-skill-render: user/agent completed titles | rewrite | actual Session transcript renders both distinct names with theme default foreground and Loaded badges in skill accent; full app render |
| session-skills: highlight Loaded badges | merge | rewritten skill-render title/color test; full app render |
| session-skills: hide completed duplicate tools | merge | existing session-transcript-boundary duplicate Skill test (zero-line row) plus actual mixed-transcript no duplicate name; component + app render |
| session-skills: bounded details / Enter+Space | rewrite/merge | rewritten skill-render details test: open actual dialog, expand via Enter, page bounded content, collapse via Space; app render |
| tool-output-display: focusable bounded expanded skill scrollbox | merge | new skill-render transcript-content test proves focus, Enter expansion, bounded height, End paging and collapse; retained release-leg transcript test separately establishes native text-buffer wiring |
| session-skills grouping/filtering/labels/string content | keep | four existing behavioral assertions; util boundary |
| tool-output-display preview/expansion/empty/error/string skill content | keep | six existing behavioral assertions; display boundary |

No source-group deletion is considered validated before matching mutation probes and final stability evidence. Release-leg files remain retained.

## Skill render group verified evidence

- Replacing source assertions with the real Session route exposed three runtime defects: choosing a skill reconstructed its dialog controller after mounting details, discarding selection; locked details' inherited dialog keymap swallowed raw paging keys; focused transcript skill content lost End to the Session page binding. Keyed/untracked stack-entry construction now owns one dialog lifetime; skill details use modal bindings; transcript content owns a focus-targeted priority-1 layer. No token/geometry/design-rule changes. D19 explicitly approves exported `DialogContext.stack[].element` as `JSX.Element | (() => JSX.Element)`, preserving current direct JSX/factory runtime inputs. Parent owns public-contract documentation/spec changes.
- RED setup is not behavior evidence: early palette-row matching was not filter-focus settlement, `SPACE` is not an OpenTUI mock key (literal space is), and the typed skill fixture originally omitted the required `skill` field. All were corrected without production workarounds. Initial typecheck exit 2 also exposed the incorrectly JSX-only stack annotation; D19 correction removes it without casts or aliases.
- Runtime RED: selected-details frame remained the list after selection; temporary diagnostics showed a second DialogSessionSkills construction without Back. After lifetime fix, End left details at line 00. After modal paging fix, transcript End still failed despite row focus; a targeted priority-1 keymap owner reaches line 59. All temporary diagnostics removed with exact patches.
- Four merged-source-group probes: badge accent replaced with default ink, same-treatment render fails (exit 1, 2.39s); `alreadyActive !== true` inverted, Duplicate review appears and render fails (exit 1, 2.90s); details height changed to 100, bounds assertion reads 100 > 15 (exit 1, 2.37s); transcript maxHeight changed to 100, expanded first-line viewport guard fails (exit 1, 7.29s). Each exact mutation reversed, preserving the real fixes.
- Lifetime discrimination rechecked after D19 type correction: restore direct factory insertion in DialogProvider temporarily; rendered details selection fails, exit 1, 8.11s. Keyed/untracked construction precisely restored.
- New direct-JSX/factory table in `test/ui/dialog-pattern.test.tsx` asserts one resident mount and preserved signal state, factory cleanup on replacement, old content removal, Escape close, original input focus restoration and one cleanup on final renderer destruction. The direct JSX node's owner is its construction scope; the factory owner is the stack entry. Existing replacement/selection/prompt dialogs remain tested separately.
- Final typecheck after D19: `bun run --cwd packages/tui typecheck`, exit 0. `bun run --cwd packages/plugin typecheck`, exit 0. Existing typed TUI consumers and plugin UI facade compile. `./ui/dialog` export and DialogContext are public; this is approved type change, not characterized as private.
- Actual loaded overlap: typecheck 2026-10-03T03:33:11Z–03:33:16Z, exit 0. Each file one Bun process: session-skills start/end 03:33:11Z, 4/4, 215ms; tool-output 03:33:11Z–12Z, 6/6, 121ms; dialog-pattern 03:33:12Z–13Z, 7/7, 1479ms; skill-render 03:33:13Z–18Z, 3/3, 5.29s. All exit 0, all overlap. Caps 8192 MiB.
- Three isolated runs: session-skills 4/4 at 79/85/69ms; tool-output 6/6 at 72/74/69ms; dialog-pattern 7/7 at 1219/1257/1229ms; skill-render 3/3 at 4.67/4.59/4.52s. All exit 0. Subsequent formatting-preservation and lifetime probe reversions require final focused reruns below.
- Neighbor/release/design checks, command `bun test --cwd packages/tui --timeout 30000 <file>` individually, all exit 0: cli/tui/dialog-select 8/8 902ms; dialog-prompt 3/3 411ms; command-palette 1/1 452ms; session-transcript-boundary 8/8 1331ms; session-transcript-live-fixes 25/25 74.44s; permission-interaction 7/7 445ms; permission 1/1 278ms; util/permission 2/2 73ms; branding 4/4 92ms; design-md 2/2 254ms.
- Four touched test files stay four; executed cases 20 → 20 (skill-render 1→3, session-skills 7→4, tool-output 7→6, dialog-pattern 5→7), lines 508 → 813 (33→267, 85→67, 55→45, 335→434). More lines replace nonexistent render proof and add regression/lifecycle boundaries; no test-count or line-count target is asserted. Before isolated duration for this group is Not Run; the first validated median summed file duration is 5.970s, not a performance claim.
- Lint of the seven touched files: exit 0, 0 errors/36 warnings versus lane-local HEAD copies 0 errors/37 warnings. Temporary copies removed. Four touched test files pass installed Prettier check. Unrelated production formatting was precisely restored rather than treating formatting of untouched JSX as an authorized behavior change.
- Final-shape isolated reruns after formatting preservation and probe restoration, each exit 0: session-skills 4/4 136/73/72ms; tool-output 6/6 73/72/71ms; dialog-pattern 7/7 1274/1228/1209ms; skill-render 3/3 4.64/4.53/4.50s. Median summed file duration 5.903s. Actual loaded overlap above remains the validated same semantic/type inputs; no loaded claim rests on an unproved parent command.
- Final interaction checks on restored code, one file/process at 8192 MiB, command `bun test --cwd packages/tui --timeout 30000 <file>`: skills-conflict 10/10 857ms; composer-live-fixes 15/15 17.77s; screen/captured-child-recovery.screen 7/7 11.41s; screen/subagent-answer.screen 7/7 10.42s, all exit 0. Captured-child recovery and owned literal human-answer behavior remain intact.
- Resource gate: parent subsequently assigned the heavy typecheck slot to web; do not rerun TUI typecheck concurrently. Last TUI/plugin exit-0 checks remain settled for their type inputs; parent owns integration/root validation and D19 docs/spec updates.
- Verified group committed `894c5c1b` (`fix(tui): preserve dialog lifetime and skill paging`), seven intended files only; lane clean after commit. No inventory/plans staged.

## Duration boundary duplicate mapping before changes

Basis: `formatDuration` current callers in `src/util/time.ts`, `routes/session/composer/shell-tab.tsx`, and `routes/session/header.tsx`. Six unit-range cases retain distinct empty/nonpositive, floor, second/minute/hour/day/week and singular/plural outcomes. The `handles boundary values correctly` group repeats exactly the same eight input/output assertions already present: 59/60 in seconds+minutes, 3599/3600 in minutes+hours, 86399/86400 in hours+days, 604799/604800 in days+weeks. Disposition: merge/delete duplicate group; surviving assertions stay in these named six cases at the isolated formatter layer. No production change.

Baseline: `bun test --cwd packages/tui test/util/format.test.ts`, exit 0, 7/7, 33 assertions, 123ms, 60 lines. Mutation discrimination and final isolated/loaded runs remain required before commit. This group is not an approval to remove any distinct range, rounding, or visible-format assertion.

Verified duration result: cutoff mutation `seconds < 60` → `seconds <= 60` fails retained `formats minutes under an hour` at input 60 (`60s` instead of `1m00s`), exit 1, 5 pass/1 fail, 75ms. Exact condition restored; production diff empty. Three final isolated runs each exit 0, 6/6, 25 assertions, 76/71/69ms. Loaded run exit 0, 6/6, 140ms at 2026-10-03T03:48:10Z, within explicitly approved two-worker SHA-256 pressure interval 03:48:00.962155Z–03:48:20.971582Z; pressure tree capped 512 MiB and joined both owned workers, exits [0,0]. No pressure filesystem mutation or pending processes remain. Neighbor shell-tab render exit 0, 1/1, 14 assertions, 577ms. Touched lint exit 0, 0 errors/0 warnings; Prettier check and git diff --check exit 0. One test file remains one, cases 7→6, lines 60→49, isolated median 71ms (baseline one run 123ms is not a performance benchmark). Last package typecheck remains the settled preexisting type inputs; this change removes only duplicate typed assertions and parent owns the currently occupied typecheck slot.

Committed duration group `246813ca` (`test(tui): remove duplicated duration boundaries`), intended test only, lane clean.

## Guardrail source-group mapping before changes

`test/cli/tui/guardrail-autosurface.test.ts`: keep four `activeGuardrail` selector cases (first, explicitly selected, stale selection, empty). Merge two source-text groups into `test/guardrail-surface.test.tsx`: real root durable-list render plus explicit composer-pause/no ordinary-composer assertions; real child transcript render/reply uses an empty projected transcript, so a review cannot depend on a compaction boundary, and verifies default rejection against the root-owned endpoint. Keep durable/live arrival at both root and child; these distinguish bootstrap and event projection boundaries, not duplicate permutations. Rewrite two Bun.sleep polling loops to bounded actual-state completion; keep the existing real-render/event-stream harness and preserve hard-review/decision suites. No production behavior change. Probe the pending-review row wiring before treating the two static groups as removed coverage.

Guardrail verified result: first probe removing `guardrails` from the separate disabled memo did not discriminate (filtered render passed); this was not counted as proof and the memo was restored. Correct initiating-input probe empties the composer-selected review input while retaining its transcript row; root durable-list render fails missing Guardrail blocked, exit 1, 26.40s. Row probe removes only guardrail activity rows while retaining composer review; child flow fails missing `needs approval`, exit 1, 2.21s. This exposed a weak surviving flow assertion: matching only Guardrail blocked proves the composer, not the transcript row. The final child assertion now requires the row's distinct status; root assertion also requires ordinary review choices and paused/no ordinary composer. Both effective probes exactly reversed; production diff empty.

Three final isolated runs, each file its own Bun process and each exit 0: `bun test --cwd packages/tui --timeout 30000 test/cli/tui/guardrail-autosurface.test.ts` 4/4 at 283/304/267ms; `... test/guardrail-surface.test.tsx` 5/5 at 6.95/6.93/6.89s. Loaded 4/4 282ms 2026-10-03T04:00:17Z–18Z and 5/5 6.92s 04:00:18Z–25Z, exit 0, inside approved two-worker SHA-256 pressure interval 04:00:03.449845Z–33.459833Z. Pressure capped 512 MiB, owned workers joined [0,0], no filesystem mutation or pending work. Tests capped 8192 MiB. Package typecheck after slot release: `bun run --cwd packages/tui typecheck`, exit 0, 8192 MiB/120s limit. Both baseline/final touched lint exit 0 with 0 errors/0 warnings; final Prettier and diff checks exit 0. Two files remain two, cases 11→9, lines 264→281 (unit45→26, render219→255). Median summed isolated duration 7.213s; original render duration Not Run, so no before/after speed claim.

Committed guardrail group `4b22ea5c` (`test(tui): prove guardrail wiring through rendered flows`), intended two tests only, lane clean.

## Provider usage source-group mapping before changes

`test/cli/tui/provider-usage-command.test.tsx`: keep its seven profile/generation/render/quota/local-usage cases; merge `registers screen-only entry and back commands without a command palette item` into existing `test/provider-usage-screen-interaction.test.tsx` real route flow. Surviving assertions: lowercase leader U remains undo, Shift+leader+U opens Overview/backend-wide usage, refresh causes new quota and usage reads, Escape and clicked Back preserve the current draft with no prompt, clicked footer Usage opens the route, command palette contains no provider-usage item. Keep its Overview-error and wide/narrow keyboard-route tests (different outcomes/input/layout boundaries). Rewrite all seven explicit sleep loops to named actual state/request completion, including detail close, sort transitions and report refresh. No production change. Shortcut wiring probe must fail the real flow before the source group is considered safely merged. Provider quota, profile privacy and normalized usage guards remain retained.

Provider usage discrimination: change shortcut Shift+leader+U to Shift+leader+I, real navigation fails, exit 1, 8.91s. Add `palette: true`: the old initial-frame negative assertion passed (not counted as proof), because an off-viewport command was invisible. Final flow waits for the actual palette filter, searches provider usage, and requires No results/no Open provider usage item; that probe now fails, exit 1, 7.65s. Both footer mutations precisely restored, production diff empty. Earlier loaded result predating the last four loop rewrites is not final stability evidence. Final three isolated runs each exit 0: provider-command 7/7 at 665/549/562ms; navigation 4/4 at 7.10/7.02/7.06s. Final loaded and typecheck gates remain pending.

Provider lint setup correction: HEAD copies under fixture changed relative import resolution and incorrectly reported zero type-aware warnings. Recreated HEAD copies beside their original files so imports resolve identically; baseline/final both exit 0, 0 errors/30 existing warnings (mostly await of synchronous mock keys). No rule disabled and no baseline copies retained. Prettier checks pass. Do not infer that a relocated lint fixture preserves type-aware evidence.

Final provider checks: all seven explicit Bun.sleep loops removed. Three isolated runs above are final inputs. Final loaded runs each exit 0: provider-command 7/7 833ms at 2026-10-03T04:27:04Z–05Z; navigation 4/4 7.10s at 04:27:05Z–12Z. Both overlap approved two-worker SHA-256 pressure 04:26:50.525889Z–04:27:20.539721Z; pressure cap512 MiB, workers joined [0,0], no retained processes/files. Package typecheck after parent actual slot release: `bun run --cwd packages/tui typecheck`, exit 0, 8192 MiB/120s limit. Two test files stay two, cases12→11; original722 lines (384+338), final765 (363+402). More lines include owned focused-search proof and existing fixture formatting; no count target. Original isolated duration Not Run; final median summed isolated duration7.622s. Formatting/lint/diff final checks and commit review below; no production change.

Provider group committed `45cd319b` (`test(tui): verify usage navigation through the live screen`), intended two tests only, lane clean.

## Passive selection source-group / D24 mapping before changes

`test/app-lifecycle.test.tsx` passive-copy source group is replaced by the real main Session-route selection flow in new `test/screen/clipboard-selection.screen.test.ts`: select actual rendered assistant text, require no passive clipboard write regardless of dialog toggle, explicitly Ctrl+C the selected text, require exact clipboard text and selection cleared without app exit. Retain dialog enabled/disabled/default positive/negative release cases at 80 and100 columns with a stub clipboard outside the verified UI boundary. Retain existing lifecycle/bootstrap cases and explicit platform-key selector cases; touched sleeps need state completion rather than timing.

Initial live reproduction under the prior broad documentation expectation failed (0/1, exit1,2.73s): the exact main-transcript selection exists, but enabled toggle produces no automatic clipboard write. This was a documentation/intended-contract ambiguity, not an approved production bug. USER D24 decides to KEEP main explicit-copy-only, scope the current toggle to dialogs, preserve JSON field and defaults, and clarify Settings/docs. No automatic clipboard behavior is added. Parent owns root configuration/runtime specifications. Local Settings title changes `Copy on select` → `Dialog copy on select`; existing list-row/selected-row tokens and geometry remain unchanged. Owning DESIGN T13 states this approved scope before production label changes.

Settings label RED at the real route: two main explicit-copy cases pass, two dialog label cases fail missing truthful scoped label, exit1,16.38s. After one title change, all four cases pass, exit0,6.28s; expanded final matrix adds omitted-default and 80-column dialog coverage. Real host clipboard is never accessed or mutated; the only writes are to the test recorder.

D24 final evidence: two main cases (dialog toggle enabled/disabled) and six dialog cases (enabled/disabled/default ×80/100columns), all actual main/Settings frames at40rows. Explicit Ctrl+C copies the exact selected main text, clears selection and does not exit. Dialog release preserves selection without writing when disabled; enabled and omitted default on this macOS host write the exact selected category text and clear selection. Default expression remains disabled on Windows; no live Windows, all-theme, or real host-clipboard claim.

Source-group discrimination: temporarily add selected-text clipboard write to the main Session container's mouse-release handler; new main guard fails with unexpected passive write, exit1,2.91s. Force DialogProvider copy-on-select off; enabled80-column dialog case fails with missing Terminal write, exit1,2.83s. Exact mutations reverted; app.tsx/session index/ui/dialog production diffs empty. Only permanent production change is the scoped Settings title. T13 uses existing list-row and selected-row treatments; no new token, component or layout. Strict lint root+owning DESIGN both0errors/0warnings; design drift2/2 passes, no CI changes.

All touched direct sleeps removed: lifecycle Escape/first-Ctrl+C now complete a render and assert the renderer remains alive, resume waits for its actual resource frame; platform selector's synchronous state/effect oracles no longer wait0ms. Three isolated runs, each exit0 and onefile/process: lifecycle4/4 at6.14/5.70/5.38s; selector5/5 at128/71/70ms; selection flow8/8 at10.72/10.48/10.52s. Median summed isolated duration16.291s; original duration Not Run.

Actual loaded overlap: selector5/5 237ms at2026-10-03T05:35:13Z; lifecycle4/4 6.03s at05:35:13Z–19Z; selection flow8/8 10.65s at05:35:19Z–30Z. All exit0 within approved two-worker SHA-256 pressure05:34:57.509555Z–05:35:47.519605Z. Pressure capped512MiB, owned workers joined[0,0], no filesystem mutation/pending processes. Tests capped8192MiB. Ready package typecheck8192MiB/120s exit0 and slot immediately released. Adjacent config2/2 201ms, dialog-pattern7/7 1199ms, design drift2/2 233ms, all exit0. Lint existing/current both0errors/4warnings with baseline copies beside original imports, copies removed; final formatting and diff checks0.

Two original tests become three: cases10→17 (app5→4, selector5→5, newflow8), lines410→599 (344→341,66→61,new197). More lines replace a source-only privacy assertion with real positive/negative UI boundaries and an approved scope requirement; no reduction target. Parent owns D24 root configuration/runtime specification wording. No JSON field, schema, default, public API or automatic clipboard behavior changed.

D24 group committed `3a57acd6` (`fix(tui): clarify dialog-only copy selection scope`), five intended files only. Clean lane; no plans staged.

## Utility semantic review (read-only decisions before changes)

| File / case groups | Decision and surviving assertions | Active boundary / reason | Execution evidence |
| --- | --- | --- | --- |
| util/filetype,2 | keep both maps/extensions/unknown and absent/empty cases | permission diff and inline diff presentation; mini tool language map | Not Run, unchanged |
| util/locale,3 | keep width0/1, CJK, magnitude boundaries and elapsed tokens | dialogs, header, activity rows, provider usage and mini surfaces; terminal cells differ from string length | Not Run, unchanged |
| util/model,5 | keep nested-ID parse; merge private formatRef case into active switchLabel case for variant present/absent; keep catalog name/fallback and variant-only/base/default transitions | app.tsx imports model utility; Session route uses switchLabel; formatRef only feeds switchLabel, not a package export | focused probe/checks required for merge |
| util/path-format,1 | keep its POSIX/Windows/relative/home/root cases | context/path-format and mini/tool current callers; platform path semantics not duplicate aliases | Not Run, unchanged |
| util/presentation,1 | keep title, continuation command and product identity | Session route epilogue; actual lifecycle flow also guards output | Not Run, unchanged |
| util/renderer,2 | keep clear-before-destroy order and already-destroyed no second destroy | app acquisition/release/SIGHUP callers; resource ordering/idempotence are behavior, not merely mock-call confirmation | Not Run, unchanged; lifecycle flow passes |
| util/revert-diff,1 | delete obsolete test group of an unconsumed private helper | bounded git grep across packages/apps/script/docs/specs finds definition and this test only; package exports contain no subpath; current revert display consumes projected data | no required current guarded behavior; production untouched for later SC |
| util/session,1 | keep generated parent/child title and custom title rejection | app and mini/runtime.lifecycle current isDefaultTitle callers | Not Run, unchanged |
| util/thai-truncation,3 | keep no orphan combining marks across truncation modes, exact middle cut, and collapsed-tool integration | Locale grapheme handling and active transcript tool preview consumer | Not Run, unchanged |
| util/tool-display,5 declaration groups /10 expanded cases | keep primitive/canonical/metadata state guards and known-provider names; merge six unsupported provider permutations into one table group without removing negative input classes | current Session route and mini/tool consumers; metadata display boundary hides pending/malformed values | focused probe/checks required if merged |
| util/cache-diagnostics,8 | keep5 active cache/model cases, including unreported-vs-reported zero; delete3 unconsumed request-formatter cases | subagent footer/context breakdown use active format helpers; formatProviderRequestDiagnostics/ProviderRequestDiagnostics only occur in definition+these tests, absent package exports; actual provider-usage and cache normalization cases remain retained | obsolete private formatter, not current quota normalization; active telemetry cases never pruned |

Search evidence: imported consumers under packages/tui/src verified; targeted `git grep` for getRevertDiffFiles/formatProviderRequestDiagnostics/ProviderRequestDiagnostics across packages/apps/script/docs/specs shows no active caller. Production helpers remain outside SL production-edit boundary and can be considered by SC. No required behavior is silently mapped to a nonexecuting helper. These keep decisions complete semantic disposition, not an assertion that their unchanged tests were executed or that all SL gates are complete.

Utility group final evidence: four changed/deleted files24expanded cases→14,287lines→169. Surviving model4/cache5/tool5 cases all pass in three final-format isolated runs: model237/72/72ms, cache79/73/75ms, tool74/71/73ms. Each `bun test --cwd packages/tui ./test/util/<file>.test.ts` ran one file/process, exit0. Seven other reviewed utility keeper files remain unchanged/Not Run. Model notice merge probe bypassed undefined-variant filtering and failed retained notice assertion (`...sonnet/` instead of `...sonnet`),3pass/1fail,82ms,exit1. Generic provider label changed to Search and failed the consolidated all-input negative group,4pass/1fail,187ms,exit1. Both exact changes reversed; utility production diff empty.

Utility loaded run: joined two-worker20s SHA-256 pressure2026-10-03T07:23:56.133372Z–07:24:16.142420Z,exits[0,0]. Three files run serially at07:23:56Z,14/14 total,model183ms/cache75ms/tool69ms,all exit0; combined tree capped8192MiB and no pending workers/files. Final TUItypecheck after format edits exit0 with8192MiB/120s cap, slotreleasedimmediately. Targeted lint0warnings/0errors, Prettier0, diff0. Unknown-vs-zero cache telemetry and exact provider/model/variant identity checks remain retained. Dead helper tests have no current runtime consumer; SC owns any later production deletion. No quota/cache normalization change or public-contract change.

Autocomplete phase committed `519391fd` (`fix(tui): rank best file mentions before folders`), five intended paths only. Four utility tests remained uncommitted during that phase; original-root inventory is never staged.

## Independent UI semantic keep mapping (parent handoff; Not Run)

Readonly reviewer mapped these five stable files while this lane owned autocomplete. Keep all20 named groups /38 expanded registered cases. This is semantic disposition, not execution evidence; no unchanged-file sweep was run. Dialog-pattern remains covered by this lane's earlier verified group.

| File | Kept groups/cases and required outcomes | Active consumer | Execution |
| --- | --- | --- | --- |
| test/ui/toast-slot.test.tsx | 7groups/14cases: eight variant/width renders plus six single cases; updated copy, unmount/no-update, theme geometry, rail/home/live-Session placement | current toast slot and rendered app shell | Not Run, unchanged |
| test/ui/state-glyph.test.tsx | 1group/1case: leading glyph, alignment, selected foreground/background contrast | live DialogSelect | Not Run, unchanged |
| test/ui/glyph.test.tsx | 1group/12cases: each GlyphName's visible slot | DialogSelect, sidebar, header | Not Run, unchanged |
| test/ui/file-path.test.tsx | 8groups/8cases: fitting, right/parent/extension/separator cuts, POSIX literal backslash, absolute POSIX/drive/mixed/UNC paths, graphemes, bounded output at every width | Session, workspace, footer | Not Run, unchanged |
| test/ui/select-controller.test.ts | 3groups/3cases: identity reconciliation, clamping/wrapping, reveal offset/margins | DialogSelect and footer menu | Not Run, unchanged |

## Approved autocomplete ranking regression / T14

Utility leaning paused at four uncommitted test paths while the USER-approved `@agents` defect was fixed. Root cause: two separately ranked directory/file searches were merged with unconditional directory priority. Existing resource admission, separate8directory/20file query budgets, references/agents ranking, and async retained results stay intact. The merge now uses installed fuzzysort on normalized paths to identify only the maximum relevance group, promotes all equal-best candidates stably, and retains folder-first/backend-order remainder without filtering any returned candidate or introducing a numeric score cutoff. Empty/no-match query remains folder-first. No API/schema/dependency, provider/quota, mini, or clipboard change.

| Requirement | Surviving proof |
| --- | --- |
| best match → folder → remainder | unit `promotes the best query match...`; real Session `@agents shows and selects...` at80×24 and100×40 |
| equal best matches/backend stability | unit `promotes equal best matches...`; ordered equal-score paths preserve incoming order |
| directories can be the best match | unit exact `agents/` beats weaker folder and `AGENTS.md` prefix |
| no loss of quotas/candidates/duplicate identity | unit caps8folders, retains all20files and unmatched results; normalized POSIX/Windows keys deduplicate without rewriting returned paths |
| actual input→query→merge→render→selection | real composer types `@agents`, observes exactly directory8+file20 requests for `agents`, checks row order, Enter selects `@AGENTS.md `; Down+Tab drills the following folder with one separator |
| neighboring command/skill geometry and keys | unchanged component5 and design10 cases remain green (visibility/window reachability, trigger/query reset, wrap, Enter/Tab, wheel/hover/click) |

Baseline RED after adding the first two unit cases: `bun test --cwd packages/tui ./test/prompt/autocomplete.test.ts`, exit1,11pass/2fail,130ms; both fail the intended ordering. Initial unprefixed filename filter also ran its `.tsx` peer (16pass/2fail across2files), so it is NOT the isolated baseline; corrected explicit `./` path is. Real route RED: `bun test --cwd packages/tui --timeout30000 ./test/screen/file-mention-ranking.screen.test.ts`, exit1,0pass/2fail,8.96s: file row follows folders, then Down+Tab selects the wrong folder. No setup/syntax/provider failure is counted as RED.

Final suite commands use `bun test --cwd packages/tui --timeout 30000 ./<file>`, one file/process. Three isolated runs all exit0: prompt/autocomplete.test.ts16/16 at150/75/74ms; prompt/autocomplete.test.tsx5/5 at946/854/847ms; screen/file-mention-ranking.screen.test.ts3/3 at4.98/4.59/4.65s; autocomplete-design.test.tsx10/10 at1.85/1.85/1.89s; design-md.test.ts2/2 at239/220/221ms. Total36 retained/new checks each run; affected unchanged tests were not removed. Original unit11→16 cases/128→206lines; new screen3cases/180lines.

Discrimination probe: remove only component→merge `base` query propagation. Both real `@agents` ordering cases fail,0pass/2fail,exit1,4.07s, while helper-only implementation remains present. Exact argument restored; no mutation remains. This proves the input/consumer wiring, not only isolated helper ordering.

Loaded evidence was rerun after the first20s pressure window ended before later suites. Final joined two-worker20s SHA-256 window: 2026-10-03T06:47:11.868298Z–06:47:31.879624Z, exits[0,0]. One file/process, final recorded file windows06:47:11–12Z(unit16,189ms),12–13Z(component5,960ms),13–17Z(screen3,4.96s),18–19Z(design10,1.85s),19–20Z(drift2,244ms), all exit0. No pending workers or pressure files. Combined tree capped8192MiB; first standalone pressure tree was512MiB. This is stability evidence, not a measured speed claim.

TUItypecheck `bun run --cwd packages/tui typecheck` exit0,8192MiB/120s, slot released immediately. Targeted lint on helper/component/unit/newscreen exit0,0warnings/0errors. Prettier helper+unit+screen exit0. Full component formatter reports existing HEAD drift; same-context stdin formatter comparison proves formattedHEAD→formattedcurrent differs only by this query argument and stale-comment removals. Unrelated renderer formatting remains untouched; no full component-format pass is claimed. Strict root/TUIDesign lint both0errors/0warnings; drift2/2 green. T14 owns ordering with existing list/selected roles and geometry. Root runtime.md:401 wording is parent-owned for integration; mini remains unchanged. Mocked filesystem/catalog HTTP responses are outside the verified actual UI boundary; no live fff/provider/terminal-emulator claim.

## Remaining utility keep mapping and current Chrome warning regression

Readonly keep decisions: `test/util/connected-provider.test.ts` both2groups retain disconnected empty and connected credential/env readiness through current `use-connected.tsx`; `test/util/form.test.ts` all4groups retain configured/custom defaults, all supported field constraints, field classification/row/display semantics and immutable multiselect updates through full and mini forms; `test/util/error.test.ts` all7groups retain native/record/opaque/custom error diagnostics, bare-brace sanitation, blocked-model token/boundary facts and wrapped durable conflicts through app/dialog/submission error views. These three unchanged files are Not Run; no unchanged-file sweep.

Current warning basis: `docs/browser-extension.md:24` requires the source-site permission prompt to warn that an allowed action may trigger downloads without another prompt. Current Core `tool/browser.ts:406/425` supplies `mode: profile/owned`, `incidentalDownloads: true`, and `site`; TUI presentation and Always copy still gated the obsolete `selected` mode. This was a reachable presentation defect, not permission/guardrail policy. Replace only mode-specific rendering gates with the current explicit side-effect flag. No legacy alias/shim, Core/browser tool, skipReview, ordinary/hard guardrail, permission decision, API/schema/dependency or variant-picker change.

Unit RED after replacing stale selected metadata: `bun test --cwd packages/tui ./test/util/permission.test.ts`,1pass/2fail,233ms,exit1, current modes render generic Call tool title/no site. Actual PermissionPrompt RED: `bun test --cwd packages/tui --timeout 30000 ./test/cli/tui/permission-interaction.test.tsx -t 'Chrome site download warning'`,0pass/2fail/7filtered,857ms,exit1; both real views show generic browser_interact and omit site/warning. Fixture uses the verified public request fields; catalog/transport are mocked outside the real UI boundary. No live Chrome or backend grant claim.

Surviving guards: unit checks profile/owned navigate+interact, source-site identity, initial and Always warning text, no invented warning on unflagged actions; real component checks both modes at80×24, same warning in Always confirmation, Escape returns to initial prompt and sends no permission reply. All seven prior interaction cases remain (arrows/hover, bounded long details and resize, stable selection lines at50/100 for permission+guardrail). Mini7 cases preserve one-time/confirmed-Always/trimmed-reject transitions, canonical metadata priority, edit patch and wildcard/pattern copy. Semantic-label1 and design-drift2 remain retained.

Always-stage discrimination: remove only warning propagation in `permissionAlwaysLines`; initial real warning passes but both Always assertions fail,0pass/2fail,606ms,exit1. Exact spread restored. Final code reads the side-effect flag once per presenter/helper; warning ink, glyphs and scrolling use existing approval components. Owning DESIGN verification maps the actual warning flow; root browser specification already states this behavior.

Final three isolated runs, one file/process, all exit0: unit4/4 at280/82/78ms; interaction9/9 at826/692/659ms; mini.shared7/7 at79/90/75ms; semantic-label1/1 at306/304/301ms; drift2/2 at253/238/235ms. Total23 cases per run. Commands `bun test --cwd packages/tui --timeout 30000 ./<file>` with the exact filenames above. Initial guessed mini filename did not exist and was not run; exact `test/mini/permission.shared.test.ts` was then located and executed.

Final loaded23/23, exits0: unit241ms at2026-10-03T08:12:41Z; interaction788ms at08:12:41–42Z; mini80ms/semantic320ms/drift251ms at08:12:42Z. Joined two-worker20s SHA-256 pressure08:12:41.252613Z–08:13:01.262888Z, exits[0,0], combined tree8192MiB; no pending workers or pressure files. Final TUItypecheck exit0 with8192MiB/120s cap, slotreleasedimmediately. Targeted lint0errors/1existing Dict warning versus same-context HEAD baseline1; baseline removed. Prettier three code/test files0, strict root/TUIDesign0errors/0warnings, drift2/2. Two touched tests remain two,9→13cases and274→369lines; added cases replace obsolete metadata proof and add actual cancellation/confirmation boundaries, not a count target.

## Package declaration index (static inventory; execution and semantic review incomplete)

Initial post-G11 snapshot: 231 files, 57085 lines, 1336 named declarations/groups (corrected to include the conditional skipIf group initially omitted by the extractor). Table and loop expansion is not an executed-case count. Counts include two explicitly separate integration files. Duration is Not Run unless recorded in the verified evidence sections. Classification below is initial triage, not completed SL acceptance. Keep preserves current assertions; rewrite requires a surviving behavior mapping before any deletion. No unreviewed group is approved for deletion.

### test-integration/custom-endpoint-credential.test.ts (1 declarations/groups, 137 lines)

Layer: live integration. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "a saved custom endpoint uses its named credential for discovery and Chat/Responses requests" — test-integration/custom-endpoint-credential.test.ts:11 | `expect(saved).toEqual({ providerID: provider, credentialConnected: true })` |

### test-integration/isolated-browser-integration.test.tsx (1 declarations/groups, 190 lines)

Layer: live integration. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "rendered explicit Start and Stop cross the real Session API and isolated Chrome lifecycle" — test-integration/isolated-browser-integration.test.tsx:24 | `expect(initial.state).toBe("unavailable")` |

### test/app-lifecycle.test.tsx (5 declarations/groups, 344 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "SIGHUP clears title and disposes scoped resources once" — test/app-lifecycle.test.tsx:8 | `expect(setup.renderer.isDestroyed).toBe(true)` |
| "Escape never exits and Ctrl+C requires two presses" — test/app-lifecycle.test.tsx:52 | `expect(resolved).toBe(false)` |
| "session lifecycle updates the terminal title and prints the epilogue after cleanup" — test/app-lifecycle.test.tsx:103 | `expect(stdout).toContain("Renamed session")` |
| "explicit session bootstrap restores its location-scoped model without an invalid-model warning" — test/app-lifecycle.test.tsx:191 | `expect(frame).toContain("session-workspace")` |
| "passive mouse selection never writes to the clipboard" — test/app-lifecycle.test.tsx:339 | `expect(source).not.toContain("MouseButton.RIGHT")` |

### test/attention-sounds.test.ts (1 declarations/groups, 20 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "%s attention sound is a non-empty mp3 file" — test/attention-sounds.test.ts:11 (table) | `expect(path.extname(soundPath)).toBe(".mp3")` |

### test/attention.test.ts (2 declarations/groups, 122 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "delivers a blurred notification before focus is reported through Ghostty's renderer" — test/attention.test.ts:6 | `expect(available).toBe(1)` |
| "plays the built-in done sound through the TUI audio host" — test/attention.test.ts:74 | `expect(result.sound).toBe(true)` |

### test/autocomplete-design.test.tsx (10 declarations/groups, 494 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders the command autocomplete design frame" — test/autocomplete-design.test.tsx:193 | `expect(frame.join("\n")).toContain("/ COMMANDS")` |
| "keeps the command popup geometry proportional at the narrow viewport" — test/autocomplete-design.test.tsx:251 | `No inline assertion; inspect called harness` |
| "keeps the command popup geometry proportional at the wide design viewport" — test/autocomplete-design.test.tsx:260 | `No inline assertion; inspect called harness` |
| "keeps only the visible command rows resident" — test/autocomplete-design.test.tsx:269 | `expect(findTexts(app.renderer.root, /^\/command-/)).toHaveLength(10)` |
| "wheel reaches the last command without stationary-pointer hover snapping the window back" — test/autocomplete-design.test.tsx:286 | `expect(selectedCommands(app)).toEqual(['/command-${index.toString().padStart(2, "0")}'])` |
| "keeps every matching slash command reachable after filtering" — test/autocomplete-design.test.tsx:319 | `expect(seen.size).toBe(60)` |
| "resets selection to the first match when the query changes" — test/autocomplete-design.test.tsx:339 | `expect(selectedCommands(app)).toEqual([firstName])` |
| "wraps keyboard selection and keeps Enter and Tab completion" — test/autocomplete-design.test.tsx:362 | `expect(selectedCommands(app)).not.toEqual(first)` |
| "does not allocate command rows while autocomplete is hidden" — test/autocomplete-design.test.tsx:386 | `expect(findTexts(app.renderer.root, /^\/command-/)).toHaveLength(0)` |
| "moves the only selected command to the hovered row and selects that row on click" — test/autocomplete-design.test.tsx:396 | `expect(selectedCommands(app)).toEqual(["/compact"])` |

### test/brand-mark.test.tsx (1 declarations/groups, 52 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "mounts the transparent canonical mark at landing and header sizes" — test/brand-mark.test.tsx:10 | `expect(painted.length).toBeGreaterThan(0)` |

### test/branding.test.ts (4 declarations/groups, 52 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "omits internal runtime generation labels from user-facing errors" — test/branding.test.ts:7 | `expect(await Bun.file(path.join(root, "src/plugin/context.tsx")).text()).not.toContain("Invalid V2 TUI plugin")` |
| "uses the YCoding wordmark and compact YC mark" — test/branding.test.ts:12 | `expect(logo).toEqual({` |
| "exports the Penpot terminal mark and header lockup" — test/branding.test.ts:28 | `expect(terminal).toEqual(["\u2588   \u2588", "\u2580\u2588 \u2588\u2580", "  \u2588"])` |
| "contains no legacy product copy in active TUI presentation sources" — test/branding.test.ts:35 | `expect(stale).toEqual([])` |

### test/btw-session-render.test.tsx (15 declarations/groups, 805 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "mounts one ordinary composer only for the root and BTW child without a BTW subagent picker" — test/btw-session-render.test.tsx:324 | `expect(root.frame().match(/Message YCoding…/g)).toHaveLength(1)` |
| "main team surface reopens a BTW chat and returns without submitting or interrupting" — test/btw-session-render.test.tsx:373 | `expect(screen.frame()).toContain("+ New side chat")` |
| "hydrates the parent title for a cold-opened BTW and retains it for the export preview" — test/btw-session-render.test.tsx:408 | `No inline assertion; inspect called harness` |
| "BTW shows side-conversation context rather than delegated-task chrome at %s columns" — test/btw-session-render.test.tsx:429 (table) | `expect(screen.frame()).toContain("BTW SIDE CHAT")` |
| "renders the compact BTW notice and chrome footer at $width×$height" — test/btw-session-render.test.tsx:458 (table) | `expect(lines).toHaveLength(height + 1)` |
| "subagent chat hydrates its todos and renders live status changes without the parent rail" — test/btw-session-render.test.tsx:486 | `expect(screen.frame()).toContain("TODO LIST")` |
| "goal steer shows the generated response rather than the synthetic description" — test/btw-session-render.test.tsx:519 | `expect(screen.frame()).toContain("Goal · steer")` |
| "hides %s goal tool rows but retains the goal steer" — test/btw-session-render.test.tsx:539 (table) | `expect(screen.frame()).toContain("Goal · steer")` |
| "main header clears its stale child count after reconnect without visiting the child" — test/btw-session-render.test.tsx:574 | `expect(screen.lines()[1]).not.toContain("subagent")` |
| "BTW returns to the main transcript by %s while its composer has a draft" — test/btw-session-render.test.tsx:596 (table) | `expect(row).toBeGreaterThan(-1)` |
| "keeps repeated ordinary BTW messages on the read-only child agent and model (variant %s)" — test/btw-session-render.test.tsx:633 (table) | `expect(childPrompts.map((request) => request.body.text)).toEqual([` |
| "opens an editable immediate-parent export preview and cancellation preserves the BTW draft" — test/btw-session-render.test.tsx:685 | `expect(screen.frame()).toContain("Destination: Main implementation")` |
| "prevents an empty reviewed parent export" — test/btw-session-render.test.tsx:717 | `expect(screen.frame()).toContain("Send to Main implementation")` |
| "sends exact reviewed text to the immediate parent as one stable steer and stays in BTW" — test/btw-session-render.test.tsx:741 | `expect(exports).toHaveLength(1)` |
| "retries a failed reviewed export with the exact same parent message id" — test/btw-session-render.test.tsx:774 | `expect(exports.map((request) => request.body.text)).toEqual(["Retain this export", "Retain this export"])` |

### test/captured-child-hydration.test.tsx (4 declarations/groups, 199 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "an obsolete membership result cannot authorize or read a previous selection's child" — test/captured-child-hydration.test.tsx:100 | `expect(fixture.hydration().ids()).toEqual(["ses_new"])` |
| "a late failed child read cannot overwrite the new selection and shared in-flight reads coalesce" — test/captured-child-hydration.test.tsx:125 | `expect(await pending).toBe("failed")` |
| "disconnect retains authorized captured children and marks the retained data incomplete until rehydration" — test/captured-child-hydration.test.tsx:159 | `expect(fixture.hydration().ids()).toEqual(["ses_old"])` |
| "failed membership reads expose their error, read no unverified child, and recover on a relevant task update" — test/captured-child-hydration.test.tsx:174 | `expect(fixture.hydration().ids()).toEqual([])` |

### test/captured-file-changes-summary.test.tsx (1 declarations/groups, 161 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "attributes a reused child's work to the segment that dispatched it and keeps one collapsed summary per segment" — test/captured-file-changes-summary.test.tsx:123 | `expect(rows("Captured changes 2 files")).toHaveLength(1)` |

### test/cli/cmd/tui/integration-options.test.ts (5 declarations/groups, 98 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "keeps popular integrations first and sorts the rest alphabetically" — test/cli/cmd/tui/integration-options.test.ts:18 | `No inline assertion; inspect called harness` |
| "offers key and OAuth methods but not environment discovery" — test/cli/cmd/tui/integration-options.test.ts:31 | `No inline assertion; inspect called harness` |
| "returns removable credential connections only" — test/cli/cmd/tui/integration-options.test.ts:49 | `No inline assertion; inspect called harness` |
| "shows credential labels and environment variables" — test/cli/cmd/tui/integration-options.test.ts:66 | `No inline assertion; inspect called harness` |
| "offers the historical default name first and avoids one already in use" — test/cli/cmd/tui/integration-options.test.ts:83 | `expect(profileFallback(integration({ id: "openai", name: "OpenAI" }))).toBe("default")` |

### test/cli/cmd/tui/model-options.test.ts (3 declarations/groups, 34 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "orders the external hosted provider before other providers" — test/cli/cmd/tui/model-options.test.ts:5 | `expect(sorted.map((model) => model.title)).toEqual(["Claude Sonnet 4", "Claude Opus 4", "GPT 5"])` |
| "orders provider groups by provider name and models by newest release" — test/cli/cmd/tui/model-options.test.ts:15 | `expect(sorted.map((model) => model.title)).toEqual(["Claude Opus 4", "Claude Sonnet 4", "Gemini 2.5 Pro", "GPT 5"])` |
| "falls back to title when release dates match within a provider" — test/cli/cmd/tui/model-options.test.ts:26 | `expect(sorted.map((model) => model.title)).toEqual(["Claude Opus 4", "Claude Sonnet 4"])` |

### test/cli/cmd/tui/notifications.test.ts (41 declarations/groups, 1198 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "a pending blocker review reaches the terminal without declaring work complete" — test/cli/cmd/tui/notifications.test.ts:392 | `expect(terminal.output()).toContain("\u001b]777;notify;Questions;Input needs response\u001b\\")` |
| `approval events reach the real Ghostty renderer only when focus is ${focus}` — test/cli/cmd/tui/notifications.test.ts:440 | `expect(terminal.notifications()).toHaveLength(focus === "focused" ? 0 : 2)` |
| `recovers pending ${kind} when Ghostty capability arrives on the same connection` — test/cli/cmd/tui/notifications.test.ts:469 | `expect(terminal.notifications()).toHaveLength(0)` |
| `recovers an undelivered ${kind} on reconnect without losing pending validation or replaying a delivered alert` — test/cli/cmd/tui/notifications.test.ts:490 | `expect(harness.notifications).toHaveLength(1)` |
| `a reconnect does not alert a ${kind} already resolved while delivery was unavailable` — test/cli/cmd/tui/notifications.test.ts:515 | `expect(harness.notifications).toHaveLength(1)` |
| "pending approvals suppressed while focused alert after blur" — test/cli/cmd/tui/notifications.test.ts:537 | `expect(terminal.notifications()).toHaveLength(0)` |
| "a successful sound cannot retire failed OS delivery and is not replayed during recovery" — test/cli/cmd/tui/notifications.test.ts:556 | `expect(harness.notifications).toEqual([permissionNotification, { ...permissionNotification, sound: false }])` |
| "capability arrival during an outstanding attention settlement retains one pending recovery" — test/cli/cmd/tui/notifications.test.ts:577 | `expect(terminal.notifications()).toHaveLength(0)` |
| "uses only the V2 plugin runtime" — test/cli/cmd/tui/notifications.test.ts:610 | `expect("setup" in Notifications).toBe(true)` |
| "registers notifications in the active V2 builtin list" — test/cli/cmd/tui/notifications.test.ts:615 | `expect(builtins.filter((plugin) => plugin.id === "internal:notifications")).toHaveLength(1)` |
| "provides a deterministic notification factory" — test/cli/cmd/tui/notifications.test.ts:619 | `expect(module.createNotifications).toBeFunction()` |
| "alerts only after a request remains pending for 500ms" — test/cli/cmd/tui/notifications.test.ts:624 | `expect(harness.notifications).toEqual([])` |
| "suppresses requests resolved automatically before the checkpoint" — test/cli/cmd/tui/notifications.test.ts:637 | `expect(harness.notifications).toEqual([])` |
| "alerts the root family after a guardrail request remains pending" — test/cli/cmd/tui/notifications.test.ts:652 | `expect(harness.scheduled.map((item) => item.delay)).toEqual([500])` |
| "suppresses a guardrail reply received before the checkpoint" — test/cli/cmd/tui/notifications.test.ts:668 | `expect(harness.notifications).toEqual([])` |
| "notifies once only after the top-level session reaches stable idle" — test/cli/cmd/tui/notifications.test.ts:683 | `expect(harness.notifications).toEqual([])` |
| "keeps routine child completion silent" — test/cli/cmd/tui/notifications.test.ts:708 | `expect(harness.notifications).toEqual([])` |
| "keeps root settlement silent while a child is active" — test/cli/cmd/tui/notifications.test.ts:727 | `expect(harness.notifications).toEqual([])` |
| "keeps root settlement silent when a child is active after reconnect" — test/cli/cmd/tui/notifications.test.ts:748 | `expect(harness.notifications).toEqual([])` |
| "stays silent at ordinary idle without explicit completion" — test/cli/cmd/tui/notifications.test.ts:758 | `expect(harness.notifications).toEqual([])` |
| "does not treat an unfinished or another Session's completion call as root completion" — test/cli/cmd/tui/notifications.test.ts:766 | `expect(harness.notifications).toEqual([])` |
| "keeps explicit completion silent while a background shell is running" — test/cli/cmd/tui/notifications.test.ts:776 | `expect(harness.notifications).toEqual([])` |
| "does not let another Session's shell suppress explicit completion" — test/cli/cmd/tui/notifications.test.ts:795 | `expect(harness.notifications).toEqual([` |
| "alerts once for explicit completed work after root settlement" — test/cli/cmd/tui/notifications.test.ts:816 | `expect(harness.notifications).toEqual([` |
| "keeps active goal settlement silent and alerts once when the goal completes" — test/cli/cmd/tui/notifications.test.ts:827 | `expect(harness.notifications).toEqual([])` |
| "does not replay a retained exhausted goal alert for later ordinary work" — test/cli/cmd/tui/notifications.test.ts:852 | `expect(harness.notifications).toEqual([` |
| "notifies once when a goal completes after successor executions" — test/cli/cmd/tui/notifications.test.ts:873 | `expect(harness.notifications).toEqual([])` |
| "uses an error alert when goal mode exhausts without progress" — test/cli/cmd/tui/notifications.test.ts:919 | `expect(harness.notifications).toEqual([` |
| "distinguishes silent and attention-requiring interruptions" — test/cli/cmd/tui/notifications.test.ts:961 | `expect(harness.notifications).toEqual([` |
| "cancels pending attention work and listeners on cleanup" — test/cli/cmd/tui/notifications.test.ts:981 | `expect(harness.listenerCount()).toBeGreaterThan(0)` |
| "contains notification failures and continues handling later attention" — test/cli/cmd/tui/notifications.test.ts:994 | `expect(harness.notifications).toEqual([permissionNotification, permissionNotification])` |
| "notifies for form, question, and permission requests with blurred notifications and always-on sounds" — test/cli/cmd/tui/notifications.test.ts:1011 | `expect(harness.notifications).toEqual([titledFormNotification, questionNotification, permissionNotification])` |
| "ignores auto-resolved question" — test/cli/cmd/tui/notifications.test.ts:1027 | `expect(harness.notifications).toEqual([])` |
| "alerts for hard guardrail at YOLO 3" — test/cli/cmd/tui/notifications.test.ts:1041 | `expect(harness.notifications).toEqual([guardrailNotification])` |
| "ignores an auto-approved ordinary guardrail at YOLO 3" — test/cli/cmd/tui/notifications.test.ts:1054 | `expect(harness.notifications).toEqual([])` |
| "notifies for global forms once the TUI can render them" — test/cli/cmd/tui/notifications.test.ts:1068 | `expect(harness.notifications).toEqual([globalFormNotification])` |
| "dedupes pending forms, questions, and permissions until they are resolved" — test/cli/cmd/tui/notifications.test.ts:1083 | `expect(harness.notifications).toEqual([formNotification, questionNotification, permissionNotification])` |
| "coalesces successor executions into one terminal notification" — test/cli/cmd/tui/notifications.test.ts:1120 | `expect(harness.notifications).toEqual([` |
| "uses sound-only attention for actionable child requests" — test/cli/cmd/tui/notifications.test.ts:1139 | `expect(harness.notifications).toEqual([` |
| "notifies execution failures once and suppresses following done events" — test/cli/cmd/tui/notifications.test.ts:1162 | `expect(harness.notifications).toEqual([` |
| "dedupes repeated terminal failures" — test/cli/cmd/tui/notifications.test.ts:1180 | `expect(harness.notifications).toEqual([` |

### test/cli/tui/collapse-tool-output.test.ts (1 declarations/groups, 14 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "limits command input and output to the same line budget" — test/cli/tui/collapse-tool-output.test.ts:4 | `expect(collapsed.overflow).toBe(true)` |

### test/cli/tui/command-palette.test.tsx (1 declarations/groups, 92 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "Escape dismisses the command palette when terminal text is selected" — test/cli/tui/command-palette.test.tsx:17 | `expect(app.captureCharFrame().split("\n").find((line) => line.includes("Other command"))).toContain("⌃o")` |

### test/cli/tui/context-breakdown.test.tsx (7 declarations/groups, 150 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "allocates a full bar proportionally and keeps tiny nonzero categories visible" — test/cli/tui/context-breakdown.test.tsx:24 | `expect(cells.reduce((sum, count) => sum + count, 0)).toBe(40)` |
| "renders session stats, percentages, tokens and total in a two-column grid" — test/cli/tui/context-breakdown.test.tsx:51 | `expect(frame).toContain(label)` |
| "stacks stats at narrow width and still shows missing breakdown guidance" — test/cli/tui/context-breakdown.test.tsx:80 | `expect(frame).toContain("The breakdown appears after this Session's next")` |
| "shows a dash when terminal Session activity is absent despite a record update" — test/cli/tui/context-breakdown.test.tsx:95 | `expect(app.captureCharFrame()).toMatch(/Last Activity\s+—/) } finally { app.renderer.destroy() }` |
| "keeps the complete token table inside a narrow terminal" — test/cli/tui/context-breakdown.test.tsx:100 | `expect(frame).toMatch(/Total\s+1,000\s+100\.0%/)` |
| "shows zero dollars when request summary has no reported cost" — test/cli/tui/context-breakdown.test.tsx:109 | `expect(app.captureCharFrame()).toContain("$0.00") } finally { app.renderer.destroy() }` |
| "palette command opens the context route for the current session" — test/cli/tui/context-breakdown.test.tsx:117 | `expect(palette().find((command) => command.id === "session.context-breakdown.open")?.palette).toBe(true)` |

### test/cli/tui/data.test.tsx (53 declarations/groups, 4237 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "releases rows through a completed V2 compaction boundary after each canonical reconcile" — test/cli/tui/data.test.tsx:87 | `expect(residentMessageIDs()).toEqual(["msg_compaction_job"])` |
| "preloads root sessions before applying the session limit" — test/cli/tui/data.test.tsx:181 | `expect(request?.searchParams.get("project")).toBe("proj_test")` |
| "bootstraps MCP data for the TUI location" — test/cli/tui/data.test.tsx:211 | `expect(requests.map((url) => url.searchParams.get("location[directory]"))).toEqual([directory, directory])` |
| "syncs MCP status when a connection settles during bootstrap" — test/cli/tui/data.test.tsx:239 | `expect(mcpRequests).toBe(2)` |
| "refreshes resources into reactive getters" — test/cli/tui/data.test.tsx:302 | `expect(data.location.default()).toEqual({ directory: process.cwd() })` |
| "applies absolute usage events to session info" — test/cli/tui/data.test.tsx:410 | `expect(data.session.get(sessionID)?.tokens).toEqual({` |
| "truncates committed revert messages without changing lifetime usage" — test/cli/tui/data.test.tsx:507 | `expect(data.session.get(sessionID)?.cost).toBe(0.75)` |
| "projects live archive and unarchive without changing session activity" — test/cli/tui/data.test.tsx:663 | `expect(data.session.get("ses_test")).toBeDefined()` |
| "updates session location when moved" — test/cli/tui/data.test.tsx:744 | `expect(data.session.get("ses_test")?.projectID).toBe("project-moved")` |
| "reconnects the event stream and resyncs active data" — test/cli/tui/data.test.tsx:813 | `expect(data.session.message.get("session-stale", "message-stale")?.id).toBe("message-stale")` |
| "completes exploration when a queued prompt is promoted" — test/cli/tui/data.test.tsx:937 | `expect(rows.find((row) => row.type === "group")?.completed).toBe(false)` |
| "classifies live tool rows independently of their call ID" — test/cli/tui/data.test.tsx:1046 | `expect(rows).toHaveLength(1)` |
| "removes committed revert messages from local state" — test/cli/tui/data.test.tsx:1100 | `expect(data.session.message.list(sessionID).map((message) => message.id)).toEqual(["msg_001"])` |
| "distinguishes initial connection from reconnection" — test/cli/tui/data.test.tsx:1158 | `expect(client.connection.status()).toBe("connecting")` |
| "preserves execution events received while the active snapshot is loading" — test/cli/tui/data.test.tsx:1217 | `expect(data.session.status("session-old")).toBe("idle")` |
| "ignores an active snapshot from a disconnected event stream" — test/cli/tui/data.test.tsx:1284 | `expect(data.session.status("session-current")).toBe("running")` |
| "tracks session status from active sessions and execution events" — test/cli/tui/data.test.tsx:1324 | `expect(data.session.status("session-idle")).toBe("idle")` |
| "refreshes integrations after integration updates" — test/cli/tui/data.test.tsx:1681 | `expect(data.location.integration.list()).toEqual([])` |
| "refreshes MCP resources after catalog updates" — test/cli/tui/data.test.tsx:1762 | `expect(data.location.mcp.resource.list()).toEqual([])` |
| "refreshes effective catalog data after catalog updates" — test/cli/tui/data.test.tsx:1833 | `No inline assertion; inspect called harness` |
| "refreshes agents after agent updates" — test/cli/tui/data.test.tsx:1880 | `No inline assertion; inspect called harness` |
| "refreshes references after updates" — test/cli/tui/data.test.tsx:1932 | `expect(data.location.reference.list()?.[0]?.name).toBe("docs")` |
| "keeps shell state scoped to location" — test/cli/tui/data.test.tsx:1992 | `expect(data.shell.list().map((shell) => shell.id)).toEqual(["sh_default"])` |
| "adds and dismisses permission requests from live events" — test/cli/tui/data.test.tsx:2070 | `expect(data.session.permission.list("ses_1")?.[0]?.id).toBe("per_2")` |
| "hydrates and updates root-family guardrail reviews" — test/cli/tui/data.test.tsx:2141 | `expect(data.session.guardrail.list("ses_root")).toEqual([initial])` |
| "reconciles active session permissions when the event stream reconnects" — test/cli/tui/data.test.tsx:2218 | `No inline assertion; inspect called harness` |
| "adds, dismisses, and refreshes form requests" — test/cli/tui/data.test.tsx:2283 | `expect(data.session.form.list("ses_1")?.map((form) => form.id)).toEqual(["frm_remote"])` |
| "tracks global forms by location" — test/cli/tui/data.test.tsx:2385 | `expect(data.session.form.list("global", { directory }) ?? []).toEqual([])` |
| "syncs global forms once for each requested location" — test/cli/tui/data.test.tsx:2460 | `expect(requests).toHaveLength(1)` |
| "resyncs global forms only for the active location after reconnect" — test/cli/tui/data.test.tsx:2527 | `expect(data.session.form.list("global", other)?.[0]?.id).toBe("frm_other_1")` |
| "reconciles active session forms when the event stream reconnects" — test/cli/tui/data.test.tsx:2627 | `No inline assertion; inspect called harness` |
| "settles pending tools when a live failure arrives" — test/cli/tui/data.test.tsx:2698 | `expect(assistant?.type).toBe("assistant")` |
| "renders admitted prompts immediately and tracks them until promoted" — test/cli/tui/data.test.tsx:2879 | `expect(admitted).toMatchObject({` |
| "does not remove a resident promoted user message when canonical projection is stale" — test/cli/tui/data.test.tsx:2984 | `expect(sync.session.message.get(sessionID, messageID)).toBeDefined()` |
| "restores a pending steer after leaving and reopening a child session" — test/cli/tui/data.test.tsx:3057 | `expect(sync.session.message.list(childID)).toEqual([])` |
| "skips initial instruction state and projects later updates with their message ID" — test/cli/tui/data.test.tsx:3129 | `expect(sync.session.message.list("session-1")).toHaveLength(1)` |
| "groups an orphan child under its missing parent until the root arrives" — test/cli/tui/data.test.tsx:3242 | `expect(data.session.root("child")).toBe("root")` |
| "indexes arbitrarily deep nesting under a single root" — test/cli/tui/data.test.tsx:3261 | `expect(data.session.root("grandchild")).toBe("child")` |
| "totals family cost for roots and keeps subagent cost scoped" — test/cli/tui/data.test.tsx:3283 | `expect(data.session.cost("root")).toBe(6)` |
| "re-registering an existing session is idempotent" — test/cli/tui/data.test.tsx:3298 | `expect(before).toEqual(["grandchild", "child", "root"])` |
| "loads and refreshes normalized session diagnostics" — test/cli/tui/data.test.tsx:3317 | `expect(data.session.diagnostics.get("ses_test")?.cache.hitRatio).toBe(0.5)` |
| "caches durable session usage independently from diagnostics" — test/cli/tui/data.test.tsx:3463 | `expect(data.session.usage.get("ses_usage")).toEqual(usage)` |
| "lists every direct subagent task across pages regardless of state" — test/cli/tui/data.test.tsx:3519 | `expect((await data.session.subagent.children(parentID)).map((child) => [child.sessionID, child.state])).toEqual([` |
| "syncs durable subagent tasks and refreshes them from task events" — test/cli/tui/data.test.tsx:3567 | `expect(waiting?.sessionID).toBe("ses_child")` |
| "replaces bounded subagent pages instead of appending them" — test/cli/tui/data.test.tsx:3633 | `expect({` |
| "resolves an evicted task parent before restoring its top page" — test/cli/tui/data.test.tsx:3741 | `expect(data.session.get("ses_evicted")).toBeUndefined()` |
| "keeps a refreshed top page when an older request settles late" — test/cli/tui/data.test.tsx:3818 | `expect(data.session.subagent.page("ses_parent")?.position).toBe("top")` |
| "stops at the last non-repeating ancestor on a parent cycle" — test/cli/tui/data.test.tsx:3884 | `expect(data.session.root("y")).toBe("x")` |
| "indexes a launched subagent before its session fetch resolves" — test/cli/tui/data.test.tsx:3903 | `expect(data.session.get("ses_child")?.parentID).toBe("ses_parent")` |
| "rehydrates durable subagent tasks for active families when the stream connects" — test/cli/tui/data.test.tsx:3964 | `expect(data.session.subagent.page("ses_parent")?.data[0]?.state).toBe("waiting")` |
| "indexes subagents that are already running when the stream connects" — test/cli/tui/data.test.tsx:4016 | `expect(data.session.family("ses_parent")).toEqual(["ses_child"])` |
| "refetches durable subagent tasks changed during an in-flight sync" — test/cli/tui/data.test.tsx:4056 | `expect(data.session.get("ses_child")?.parentID).toBe("ses_parent")` |
| "patches the durable Daybreak program onto stored Session info" — test/cli/tui/data.test.tsx:4160 | `expect(data.session.get(sessionID)?.daybreak).toBeUndefined()` |

### test/cli/tui/dialog-prompt.test.tsx (3 declarations/groups, 201 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders prompt on the shared panel cell grid with the live confirm shortcut" — test/cli/tui/dialog-prompt.test.tsx:106 | `expect(panel.width).toBe(98)` |
| "dialog prompt submit wins when return is also input newline" — test/cli/tui/dialog-prompt.test.tsx:140 | `expect(confirmed).toEqual(["draft"])` |
| "dialog prompt submit can be rebound separately from input submit" — test/cli/tui/dialog-prompt.test.tsx:166 | `expect(confirmed).toEqual([])` |

### test/cli/tui/dialog-select.test.tsx (8 declarations/groups, 382 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders actions with a current selection" — test/cli/tui/dialog-select.test.tsx:150 | `No inline assertion; inspect called harness` |
| "dialog actions run without options while row actions still require a selection" — test/cli/tui/dialog-select.test.tsx:167 | `expect(global).toBe(1)` |
| "footer actions run when filtering leaves no selected row" — test/cli/tui/dialog-select.test.tsx:189 | `expect(global).toBe(1)` |
| "row actions receive the selected option" — test/cli/tui/dialog-select.test.tsx:215 | `expect(rows).toEqual(["alpha"])` |
| "selects the new final option immediately after removing the selected final option" — test/cli/tui/dialog-select.test.tsx:234 | `expect(select.selected).toEqual(["second"])` |
| "selects a repopulated option after removing the only option" — test/cli/tui/dialog-select.test.tsx:256 | `expect(select.selected).toEqual([])` |
| "keeps the cursor index while options are temporarily empty" — test/cli/tui/dialog-select.test.tsx:277 | `expect(select.selected).toEqual(["third"])` |
| "replacing model select keeps exactly one live filter input" — test/cli/tui/dialog-select.test.tsx:301 | `expect(before.length).toBe(1)` |

### test/cli/tui/diff-viewer-file-tree.test.tsx (4 declarations/groups, 158 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders sorted hierarchical file rows" — test/cli/tui/diff-viewer-file-tree.test.tsx:17 | `expect(lines).toEqual([` |
| "keeps loading and error quiet while rendering an empty settled state" — test/cli/tui/diff-viewer-file-tree.test.tsx:46 | `expect(loading).not.toContain("Loading diff...")` |
| "does not render text markers for highlighted rows" — test/cli/tui/diff-viewer-file-tree.test.tsx:64 | `expect(focused).toContain("▾ src/config")` |
| "renders collapsed and expanded directory rows" — test/cli/tui/diff-viewer-file-tree.test.tsx:90 | `No inline assertion; inspect called harness` |

### test/cli/tui/diff-viewer.test.tsx (5 declarations/groups, 295 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "closing the diff viewer returns to the route it opened from" — test/cli/tui/diff-viewer.test.tsx:25 | `expect(viewer.current()).toEqual({` |
| "shows an error instead of an empty diff when loading fails" — test/cli/tui/diff-viewer.test.tsx:50 | `expect(viewer.app.captureCharFrame()).not.toContain("No changes to show")` |
| "uses the active location when opened outside a session" — test/cli/tui/diff-viewer.test.tsx:60 | `expect(viewer.vcsDiffInput()).toEqual({` |
| "brackets navigate diff hunks" — test/cli/tui/diff-viewer.test.tsx:73 | `expect(TuiKeybind.defaultValue("diff_next_hunk")).toBe("]")` |
| "branch diff source requests branch VCS diff" — test/cli/tui/diff-viewer.test.tsx:261 | `expect(viewer.current()).toEqual({` |

### test/cli/tui/form.test.tsx (3 declarations/groups, 153 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "requires explicit acknowledgement before submitting an external field" — test/cli/tui/form.test.tsx:101 | `expect(prompt.replies).toEqual([])` |
| "includes external acknowledgements in progress" — test/cli/tui/form.test.tsx:129 | `expect(prompt.app.captureCharFrame()).toContain("0/1")` |
| "keeps a form surface immediately above the session footer" — test/cli/tui/form.test.tsx:140 | `expect(footer).toBe(19)` |

### test/cli/tui/guardrail-autosurface.test.ts (6 declarations/groups, 45 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "returns first pending request when no selection" — test/cli/tui/guardrail-autosurface.test.ts:10 | `expect(activeGuardrail([first, second], undefined)).toEqual(first)` |
| "returns explicitly selected pending request when valid" — test/cli/tui/guardrail-autosurface.test.ts:14 | `expect(activeGuardrail([first, second], "grq_second")).toEqual(second)` |
| "falls back to first pending when selection is stale" — test/cli/tui/guardrail-autosurface.test.ts:18 | `expect(activeGuardrail([first, second], "grq_missing")).toEqual(first)` |
| "returns undefined when no requests pending" — test/cli/tui/guardrail-autosurface.test.ts:22 | `expect(activeGuardrail([], undefined)).toBeUndefined()` |
| "index.tsx auto-surfaces pending guardrails at composer" — test/cli/tui/guardrail-autosurface.test.ts:29 | `expect(source).toContain("activeGuardrail")` |
| "rows.ts mounts pending guardrails without a compaction boundary" — test/cli/tui/guardrail-autosurface.test.ts:40 | `expect(source).toContain("activityRows()")` |

### test/cli/tui/guardrail.test.tsx (7 declarations/groups, 387 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "formats guardrail profile and family counters" — test/cli/tui/guardrail.test.tsx:35 | `expect(module.guardrailSummary(status)).toEqual({` |
| "attributes child reviews to their root family and exposes explicit guardrail replies" — test/cli/tui/guardrail.test.tsx:47 | `expect(prompt.guardrailPresentation(request)).toEqual({` |
| "renders a warning-framed guardrail approval" — test/cli/tui/guardrail.test.tsx:74 | `expect(frame).not.toContain("!!")` |
| "renders a hard review with one-time approval or rejection only" — test/cli/tui/guardrail.test.tsx:135 | `expect(frame).toContain("Allow once")` |
| "defaults guardrails to deny and ordinary permissions to allow once" — test/cli/tui/guardrail.test.tsx:190 | `expect(selected).toBeDefined()` |
| "renders guardrail status without raw rules or command resources" — test/cli/tui/guardrail.test.tsx:254 | `expect(frame).toContain("GUARDRAILS")` |
| `replacing a scrolled review resets hard-review details and sends ${decision} once` — test/cli/tui/guardrail.test.tsx:303 | `expect(app.captureCharFrame()).toContain("FINAL_COMMAND_SENTINEL")` |

### test/cli/tui/inline-tool-wrap-snapshot.test.tsx (11 declarations/groups, 235 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "falls back for unknown tool names" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:128 | `expect(toolDisplay("shell")).toBe("shell")` |
| "replaces pending copy when a tool fails before completion" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:139 | `expect(frame).toContain("Patch failed")` |
| "preserves useful completed copy when a tool fails" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:145 | `expect(frame).toContain("Read src/index.ts")` |
| "aligns switch reminders with instruction reminders" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:151 | `expect(reminder.indexOf("Switched")).toBe(3)` |
| "wraps a trailing status as one padded item" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:162 | `expect(wide.split("\n")).toHaveLength(1)` |
| "filters malformed nested tool wire data" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:179 | `expect(parseQuestions([{}, { question: 1 }, { question: "Continue?" }])).toEqual([{ question: "Continue?" }])` |
| "ignores diagnostics with malformed nested ranges" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:202 | `No inline assertion; inspect called harness` |
| "keeps retry status ahead of wrapping messages" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:217 | `expect(formatSubagentRetry(2, "Rate limited by provider")).toBe("Retrying (attempt 2) · Rate limited by provider")` |
| "labels only detached or async subagents as background" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:221 | `expect(isBackgroundSubagent({ status: "running" }, "running")).toBeFalse()` |
| "snapshots consecutive grep, glob, and read rows at a narrow width" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:228 | `expect(await renderFrame(() => <Fixture />, { width: 72, height: 12 })).toMatchSnapshot()` |
| "snapshots expanded tool errors under the tool text" — test/cli/tui/inline-tool-wrap-snapshot.test.tsx:232 | `expect(await renderFrame(() => <Fixture errorExpanded />, { width: 72, height: 12 })).toMatchSnapshot()` |

### test/cli/tui/keymap-arguments.test.tsx (1 declarations/groups, 44 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "dispatch passes slash input through the registered command" — test/cli/tui/keymap-arguments.test.tsx:8 | `expect(received).toEqual([undefined, "src/components with spaces"])` |

### test/cli/tui/memory-command.test.tsx (1 declarations/groups, 82 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "mounted production session.memory command computes lazily, refreshes, renders labels, and closes" — test/cli/tui/memory-command.test.tsx:19 | `expect(app.captureCharFrame()).not.toContain("Estimated resident payload")` |

### test/cli/tui/message-navigation.test.ts (8 declarations/groups, 164 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "adds only enough slack to align the selected message" — test/cli/tui/message-navigation.test.ts:16 | `expect(messageNavigationSlack({ top: 80, viewportHeight: 50, scrollHeight: 100, currentSlack: 0 })).toBe(30)` |
| "finds the next user message without stopping at an assistant message" — test/cli/tui/message-navigation.test.ts:21 | `No inline assertion; inspect called harness` |
| "finds the previous user message without stopping at an assistant message" — test/cli/tui/message-navigation.test.ts:34 | `No inline assertion; inspect called harness` |
| "preserves navigation across both user and assistant messages" — test/cli/tui/message-navigation.test.ts:47 | `No inline assertion; inspect called harness` |
| "uses the selected message when the viewport is too tall to scroll" — test/cli/tui/message-navigation.test.ts:68 | `No inline assertion; inspect called harness` |
| "stops at the first and last selected user message" — test/cli/tui/message-navigation.test.ts:93 | `No inline assertion; inspect called harness` |
| "keeps the logical boundary when layout temporarily moves it outside the viewport" — test/cli/tui/message-navigation.test.ts:118 | `No inline assertion; inspect called harness` |
| "stops at the first and last message" — test/cli/tui/message-navigation.test.ts:132 | `No inline assertion; inspect called harness` |

### test/cli/tui/permission-interaction.test.tsx (3 declarations/groups, 245 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "updates permission selection from vertical arrows and hover" — test/cli/tui/permission-interaction.test.tsx:12 | `expect(descendants(app.renderer.root).some((item) => item.id === "session.permission.action.reject.band")).toBe(` |
| `${kind} pins decisions while complete long details scroll at short heights and after resize` — test/cli/tui/permission-interaction.test.tsx:85 | `expect(frame).toContain(label)` |
| `${kind} choices stay on the same terminal lines during selection at width ${width}` — test/cli/tui/permission-interaction.test.tsx:168 | `expect(before.every((line) => line >= 0)).toBe(true)` |

### test/cli/tui/permission.test.ts (1 declarations/groups, 7 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "uses the permission action when a surface has no display title" — test/cli/tui/permission.test.ts:4 | `expect(permissionSemanticLabel("shell")).toBe("Permission required: shell")` |

### test/cli/tui/prompt-submit-race.test.ts (8 declarations/groups, 303 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "concurrent submits must not lose the user's text" — test/cli/tui/prompt-submit-race.test.ts:77 | `expect(h.submissions.every((s) => s.text === "Hello there.")).toBe(true)` |
| "a sequential second submit after clear is a no-op, not a phantom session" — test/cli/tui/prompt-submit-race.test.ts:91 | `expect(h.submissions).toHaveLength(1)` |
| "retains one session and stable message IDs for an unchanged failed submission" — test/cli/tui/prompt-submit-race.test.ts:105 | `expect(retry).toBe(first)` |
| "retries a lost Home create response with one preallocated session identity" — test/cli/tui/prompt-submit-race.test.ts:129 | `expect(submission.sessionID).toMatch(/^ses_/)` |
| "existing sessions never invoke create" — test/cli/tui/prompt-submit-race.test.ts:160 | `expect(submission.sessionID).toBe("ses_existing")` |
| "retry action stashes a changed draft and restores the exact retained prompt and IDs" — test/cli/tui/prompt-submit-race.test.ts:175 | `expect(stashed).toEqual([changed])` |
| "retry restoration preserves display-cell cursor offsets for wide characters" — test/cli/tui/prompt-submit-race.test.ts:243 | `expect(restored.prompt.text).toBe("中文")` |
| "holds changed skill metadata behind the retained identity of an unresolved admission" — test/cli/tui/prompt-submit-race.test.ts:264 | `expect(run(first)).rejects.toThrow("lost response")` |

### test/cli/tui/provider-usage-command.test.tsx (8 declarations/groups, 384 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "hides unsupported providers and de-duplicates each provider profile" — test/cli/tui/provider-usage-command.test.tsx:28 | `No inline assertion; inspect called harness` |
| "invalidates stale asynchronous generations" — test/cli/tui/provider-usage-command.test.tsx:51 | `expect(guard.current(first)).toBeFalse()` |
| "registers screen-only entry and back commands without a command palette item" — test/cli/tui/provider-usage-command.test.tsx:63 | `expect(footer).toContain("session.provider-usage.open")` |
| "renders provider progress and unavailable states in a dedicated dialog" — test/cli/tui/provider-usage-command.test.tsx:76 | `expect(frame).toContain("Claude Max")` |
| "renders missing local pricing as an estimated zero cost" — test/cli/tui/provider-usage-command.test.tsx:154 | `expect(frame).toContain("custom/custom")` |
| "renders durable backend request usage after detailed records are compacted" — test/cli/tui/provider-usage-command.test.tsx:205 | `expect(frame).toContain("12,000")` |
| "renders aggregate provider request usage on the screen" — test/cli/tui/provider-usage-command.test.tsx:257 | `expect(frame).toContain("Usage")` |
| "renders usage in a narrow screen without horizontal layout assumptions" — test/cli/tui/provider-usage-command.test.tsx:326 | `expect(frame).toContain("Usage")` |

### test/cli/tui/provider-usage-layout.test.tsx (3 declarations/groups, 303 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders each provider quota window with its own reset and derivable progress bar" — test/cli/tui/provider-usage-layout.test.tsx:11 | `expect(rows.find((row) => row.includes("Openrouter"))).toContain("updated now")` |
| "lists every provider quota before YCoding local Today spend" — test/cli/tui/provider-usage-layout.test.tsx:150 | `expect(headers.every((index) => index >= 0)).toBe(true)` |
| "preserves reported account tiers and renders each reported reset without invented quota lanes" — test/cli/tui/provider-usage-layout.test.tsx:211 | `expect(rows.find((row) => row.includes("Claude Max"))).toContain("live")` |

### test/cli/tui/session-row-view.test.tsx (2 declarations/groups, 76 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "a message row for a message that does not exist renders nothing, not a blank line" — test/cli/tui/session-row-view.test.tsx:22 | `expect(frame).toBe("before\nafter")` |
| "assistant content rows without a resident message render no empty blocks" — test/cli/tui/session-row-view.test.tsx:39 | `expect(frame).toBe("before\nafter")` |

### test/cli/tui/session-rows-live.test.tsx (13 declarations/groups, 1257 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "projects live context observations once as resident chronological messages" — test/cli/tui/session-rows-live.test.tsx:79 | `expect(mounted.data.session.message.get(sessionID, "msg_context_state")).toMatchObject({` |
| "reconciles V2 compaction rows by jobID through terminal lifecycle events" — test/cli/tui/session-rows-live.test.tsx:117 | `expect(compaction()?.pressure).toEqual(pressure)` |
| "rehydrates one identity-stable V2 compaction row when an event arrives before reconnect fetch" — test/cli/tui/session-rows-live.test.tsx:294 | `expect(provisional).toBeDefined()` |
| "keeps a persisted V2 compaction failure diagnostic-only through reconnect hydration" — test/cli/tui/session-rows-live.test.tsx:394 | `expect(mounted.rows.some((item) => item.type === "compaction" && item.jobID === jobID)).toBe(false)` |
| "keeps a resident background compaction before newer user and assistant chat" — test/cli/tui/session-rows-live.test.tsx:481 | `expect(mounted.data.session.compaction.get(sessionID, jobID)?.status).toBe("running")` |
| "keeps a production V2 compaction before newer assistant and tool rows after completion" — test/cli/tui/session-rows-live.test.tsx:663 | `expect(mounted.data.session.compaction.get(sessionID, jobID)).not.toHaveProperty("messageID")` |
| "renders only the latest completed compaction before later chat" — test/cli/tui/session-rows-live.test.tsx:816 | `expect(order()).toEqual(["compaction:cmp_three", "message:msg_later_chat"])` |
| "moves a completed compaction marker to its historical message position before later chat" — test/cli/tui/session-rows-live.test.tsx:918 | `expect(order()).toEqual(["compaction:cmp_ordered", "message:msg_after_compaction"])` |
| "an initial instructions.updated event that never becomes a message never renders a row" — test/cli/tui/session-rows-live.test.tsx:994 | `expect(mounted.data.session.message.get(sessionID, "msg_instructions_initial")).toBeUndefined()` |
| "streaming text and tool deltas preserve transcript row identity" — test/cli/tui/session-rows-live.test.tsx:1020 | `expect(mounted.rows.find((row) => row.type === "part" && row.ref.partID === "text:0")).toBe(textRow)` |
| "a full reconcile after streaming preserves incremental part row identity" — test/cli/tui/session-rows-live.test.tsx:1082 | `expect(mounted.rows.find((row) => row.type === "part" && row.ref.partID === "text:0")).toBe(textRow)` |
| "an active subagent does not create a transcript row" — test/cli/tui/session-rows-live.test.tsx:1148 | `expect(mounted.rows.some((row) => row.type === "subagent")).toBe(false)` |
| "shows an invoked skill block live, directly after the prompt that requested it" — test/cli/tui/session-rows-live.test.tsx:1181 | `expect(mounted.data.session.message.get(sessionID, "msg_skill_block")).toMatchObject({` |

### test/cli/tui/session-rows.test.ts (11 declarations/groups, 310 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "assigns assistant boundaries to the first rendered row instead of the first text row" — test/cli/tui/session-rows.test.ts:5 | `expect(messageBoundaryIDs(rows, messages)).toEqual(["user-1", "assistant-1", undefined, undefined])` |
| "groups exploration parts across assistant messages until a delimiter" — test/cli/tui/session-rows.test.ts:19 | `expect(reduceSessionRows(messages)).toEqual([` |
| "keeps non-exploration tools as individual part rows" — test/cli/tui/session-rows.test.ts:51 | `expect(reduceSessionRows(messages)).toEqual([` |
| "assigns stable kind ordinals within an assistant message" — test/cli/tui/session-rows.test.ts:79 | `expect(reduceSessionRows(messages)).toEqual([` |
| "groups adjacent reasoning parts until a visible boundary" — test/cli/tui/session-rows.test.ts:107 | `expect(reduceSessionRows(messages)).toEqual([` |
| "groups across empty assistant reasoning parts" — test/cli/tui/session-rows.test.ts:137 | `expect(reduceSessionRows(messages)).toEqual([` |
| "completes exploration groups when another row follows" — test/cli/tui/session-rows.test.ts:169 | `expect(reduceSessionRows(messages)).toEqual([` |
| "hides synthetic messages without descriptions" — test/cli/tui/session-rows.test.ts:200 | `expect(reduceSessionRows(messages)).toEqual([` |
| "renders synthetic messages with descriptions" — test/cli/tui/session-rows.test.ts:226 | `expect(reduceSessionRows(messages)).toEqual([` |
| "renders a footer for a pre-output retry assistant after replay" — test/cli/tui/session-rows.test.ts:258 | `expect(reduceSessionRows([message])).toEqual([{ type: "assistant-footer", messageID: "assistant-retry" }])` |
| "places a running compaction barrier before every queued user message" — test/cli/tui/session-rows.test.ts:269 | `expect(reduceSessionRows(messages, new Set(["user-before", "user-after"]))).toEqual([` |

### test/cli/tui/sidebar-cache.test.tsx (11 declarations/groups, 610 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders provider prompt cache without application artifact diagnostics" — test/cli/tui/sidebar-cache.test.tsx:105 | `expect(module.SidebarCacheContent).toBeDefined()` |
| "renders latest generation speed and bounded trend, then hides it on model switch" — test/cli/tui/sidebar-cache.test.tsx:166 | `expect(frame).toContain("Speed")` |
| "keeps the latest speed on one narrow row without a wrapping trend" — test/cli/tui/sidebar-cache.test.tsx:196 | `expect(frame).toContain("Speed")` |
| "derives active background compaction from V2 lifecycle instead of conversation_summarize" — test/cli/tui/sidebar-cache.test.tsx:222 | `expect(module.isConversationSummarizing([], [{ status: "running" }])).toBeTrue()` |
| "keeps a last-step model and limit when session selection changes" — test/cli/tui/sidebar-cache.test.tsx:279 | `expect(frame).toContain("Model")` |
| "renders aggregate fallback spend as a single total when diagnostics are unavailable" — test/cli/tui/sidebar-cache.test.tsx:322 | `expect(frame).toContain("SPEND")` |
| "renders durable model spend and estimated zero for unpriced costs after compaction" — test/cli/tui/sidebar-cache.test.tsx:358 | `expect(frame).toContain("anthropic/claude-sonnet-4-5#thinking")` |
| "groups spend by model under the measured model identity without colliding with rail values" — test/cli/tui/sidebar-cache.test.tsx:392 | `expect(frame).toContain("Model")` |
| "sums reported provider-priced spend in Total" — test/cli/tui/sidebar-cache.test.tsx:560 | `expect(frame).toContain("openai/gpt-5.6#high")` |
| "renders Total and an unpriced model as estimated zero" — test/cli/tui/sidebar-cache.test.tsx:576 | `expect(frame).toContain("openai/gpt-5.6#high")` |
| "keeps same model id/variant from different providers as distinguishable Spend rows" — test/cli/tui/sidebar-cache.test.tsx:595 | `expect(frame).toContain("openai/gpt-5.6#high")` |

### test/cli/tui/subagent-economics.test.tsx (4 declarations/groups, 176 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders footer economics, picker attachment metadata, and parent subagent spend" — test/cli/tui/subagent-economics.test.tsx:104 | `expect(frame).toContain("1.6K (5%) · 74% hit · $0.13")` |
| "does not invent hit telemetry for a child with zero or missing usage" — test/cli/tui/subagent-economics.test.tsx:145 | `expect(frame).toContain("openai/gpt-5.6-terra#high")` |
| "renders missing subagent pricing as an estimated zero" — test/cli/tui/subagent-economics.test.tsx:157 | `expect(value?.spent).toBe("$0.00")` |
| "fits delegated economics in the 80-column band" — test/cli/tui/subagent-economics.test.tsx:165 | `expect(frame).toContain("1.6K (5%) · 74% hit · $0.13")` |

### test/cli/tui/subagent-footer.test.tsx (4 declarations/groups, 127 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "derives agent and session model fallback when diagnostics are unavailable" — test/cli/tui/subagent-footer.test.tsx:11 | `expect(module.subagentFooterData).toBeDefined()` |
| "renders subagent diagnostics with model variant, context, and provider cache totals" — test/cli/tui/subagent-footer.test.tsx:74 | `expect(frame).toContain("Reviewer")` |
| "renders available diagnostics without a model" — test/cli/tui/subagent-footer.test.tsx:96 | `expect(frame).toContain("Reviewer")` |
| "preserves navigation in compact width without diagnostics" — test/cli/tui/subagent-footer.test.tsx:115 | `expect(frame).toContain("Reviewer")` |

### test/cli/tui/subagent-navigation.test.tsx (5 declarations/groups, 194 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "budgets whole sibling chips before the fixed navigation block" — test/cli/tui/subagent-navigation.test.tsx:38 | `expect(layout.right).toBe("1 of 10  ·  ↑ parent  ← prev  → next")` |
| "retains the board-15 three-sibling identity layout" — test/cli/tui/subagent-navigation.test.tsx:71 | `expect(layout.parentTitle).toBe("Provider cache audit")` |
| "labels a direct child on an older page with its exact sibling position" — test/cli/tui/subagent-navigation.test.tsx:89 | `expect(layout.right).toBe("12 of 12  ·  ↑ parent  ← prev  → next")` |
| "renders the sibling strip, blocked footer chip, and existing arrow hints" — test/cli/tui/subagent-navigation.test.tsx:105 | `expect(frame).toContain("↑ Parent session")` |
| "hydrates an absent child and crosses bounded sibling pages deterministically" — test/cli/tui/subagent-navigation.test.tsx:147 | `expect(page.data.map((task) => task.sessionID)).toEqual(["ses_10", "ses_11"])` |

### test/cli/tui/subagents-tab.test.tsx (11 declarations/groups, 521 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "formats provider, model, and optional variant" — test/cli/tui/subagents-tab.test.tsx:58 | `expect(module.formatSubagentModel({ providerID: "openai", id: "gpt-5.6-sol" })).toBe("openai/gpt-5.6-sol")` |
| "sections active and inactive tasks deterministically" — test/cli/tui/subagents-tab.test.tsx:76 | `expect(entries).toEqual([` |
| "classifies every non-terminal orchestration state as active" — test/cli/tui/subagents-tab.test.tsx:192 | `expect(module.isActiveSubagent("starting")).toBe(true)` |
| "counts durable active tasks and live family sessions without duplicates" — test/cli/tui/subagents-tab.test.tsx:203 | `No inline assertion; inspect called harness` |
| "cancels waiting managed tasks through the durable endpoint" — test/cli/tui/subagents-tab.test.tsx:220 | `expect(module.canCancelSubagent("waiting")).toBe(true)` |
| "cancels a starting subagent from sequential Ctrl+X then K" — test/cli/tui/subagents-tab.test.tsx:248 | `expect(cancellations).toEqual([{ pathname: "/api/session/ses_parent/subagent/ses_child/cancel", method: "POST" }])` |
| "renders model and running status without a second task row" — test/cli/tui/subagents-tab.test.tsx:318 | `expect(titleRow).toBeDefined()` |
| "renders model metadata for a completed row without status" — test/cli/tui/subagents-tab.test.tsx:337 | `expect(frame).toContain("openai/gpt-5.6-sol")` |
| "omits model metadata when the session has no model" — test/cli/tui/subagents-tab.test.tsx:348 | `expect(frame).not.toContain("·")` |
| "renders a long model id untruncated on its own row without colliding with telemetry" — test/cli/tui/subagents-tab.test.tsx:365 | `expect(frame).toContain("openrouter/deepseek/deepseek-v4-fla")` |
| "renders section headings while keyboard navigation selects only task rows and keeps the selected row visible" — test/cli/tui/subagents-tab.test.tsx:384 | `expect(initial).toContain("ACTIVE")` |

### test/cli/tui/theme-mode.test.tsx (1 declarations/groups, 66 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "uses an available mode while retaining the pinned preference" — test/cli/tui/theme-mode.test.tsx:17 | `expect(current().mode()).toBe("light")` |

### test/cli/tui/thinking.test.ts (5 declarations/groups, 36 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "extracts a leading summary title and leaves markdown body" — test/cli/tui/thinking.test.ts:5 | `expect(reasoningSummary("**Continuing Quality Review**\n\nDetails.\n\n**Next section**\n\nMore.")).toEqual({` |
| "extracts a completed title before its streamed body arrives" — test/cli/tui/thinking.test.ts:12 | `expect(reasoningSummary("**Continuing Quality Review**")).toEqual({` |
| "preserves markdown-significant indentation in the extracted body" — test/cli/tui/thinking.test.ts:19 | `expect(reasoningSummary("**Continuing Quality Review**\n\n    const value = true\n")).toEqual({` |
| "does not consume ordinary leading bold content" — test/cli/tui/thinking.test.ts:26 | `expect(reasoningSummary("**Important:** keep this in the body.")).toEqual({` |
| "leaves content without a leading title in its body" — test/cli/tui/thinking.test.ts:33 | `expect(reasoningSummary("Details only.")).toEqual({ title: null, body: "Details only." })` |

### test/cli/tui/toast.test.tsx (1 declarations/groups, 28 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "shows structured API error messages instead of an unknown-error fallback" — test/cli/tui/toast.test.tsx:7 | `expect(toast.currentToast?.message).toBe("History request failed")` |

### test/cli/tui/transcript-history.test.tsx (2 declarations/groups, 109 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "loads the complete transcript with one unpaged canonical request" — test/cli/tui/transcript-history.test.tsx:19 | `expect(searches).toEqual([""])` |
| "estimates all resident message payloads without claiming exact heap attribution" — test/cli/tui/transcript-history.test.tsx:40 | `expect(estimate.counts).toEqual({ messages: 1, residentSessions: 1 })` |

### test/cli/tui/use-event.test.tsx (8 declarations/groups, 303 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "logs only durable events" — test/cli/tui/use-event.test.tsx:108 | `expect(logs).toEqual([` |
| "delivers events for the current project" — test/cli/tui/use-event.test.tsx:141 | `expect(seen).toEqual([event(vcs("main"), { directory: "/tmp/other", workspace: "ws_a" })])` |
| "delivers current project events regardless of active workspace" — test/cli/tui/use-event.test.tsx:156 | `expect(seen).toEqual([event(vcs("ws"), { directory: "/tmp/other", workspace: "ws_b" })])` |
| "delivers truly global events even when a workspace is active" — test/cli/tui/use-event.test.tsx:170 | `expect(seen).toEqual([event(update("1.2.3"), { directory: "global" })])` |
| "reconnects to the server after the event stream drops" — test/cli/tui/use-event.test.tsx:184 | `expect(attempts).toEqual([])` |
| "keeps the current client when reconnection fails" — test/cli/tui/use-event.test.tsx:219 | `expect(client.api).toBe(original)` |
| "backs off when a resolved event stream keeps failing" — test/cli/tui/use-event.test.tsx:242 | `expect(calls).toBe(2)` |
| "cancels pending endpoint resolution on cleanup" — test/cli/tui/use-event.test.tsx:281 | `No inline assertion; inspect called harness` |

### test/clipboard.test.ts (7 declarations/groups, 84 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "prefers Wayland clipboard when available" — test/clipboard.test.ts:8 | `expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])` |
| "uses osascript on macOS" — test/clipboard.test.ts:12 | `expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])` |
| "falls back through X11 clipboard commands" — test/clipboard.test.ts:16 | `expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])` |
| "returns undefined when native clipboard is unavailable" — test/clipboard.test.ts:21 | `expect(copyCommand("linux", false, () => false)).toBeUndefined()` |
| "CLP-001 materializes concurrent clipboard images in distinct mode-0600 files" — test/clipboard.test.ts:25 | `expect(new Set(paths).size).toBe(2)` |
| "CLP-002 removes a partial clipboard file when acquisition fails" — test/clipboard.test.ts:49 | `expect(await readdir(root)).toEqual([])` |
| "CLP-003 aborts clipboard materialization and releases its owned temporary file" — test/clipboard.test.ts:62 | `expect(acquisition).rejects.toThrow("cancel clipboard acquisition")` |

### test/command-palette-design.test.tsx (1 declarations/groups, 269 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders command-palette groups, selection, and live keymap hints" — test/command-palette-design.test.tsx:18 | `expect(design.frame).toContain("Commands")` |

### test/composer-blocked-queued.test.tsx (3 declarations/groups, 222 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "names the permission blocker inline when it replaces the composer" — test/composer-blocked-queued.test.tsx:171 | `expect(screen.frame()).toContain("Composer paused: permission review")` |
| "shows a queued notice for durable pending rows while idle without clearing the draft" — test/composer-blocked-queued.test.tsx:187 | `expect(screen.frame()).toContain("Queued")` |
| "shows a queued notice while a session shell is running" — test/composer-blocked-queued.test.tsx:208 | `expect(screen.frame()).toContain("Queued")` |

### test/composer-live-fixes.test.tsx (15 declarations/groups, 1020 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "keeps resident content mounted after one-time startup loading completes" — test/composer-live-fixes.test.tsx:311 | `expect(app.captureCharFrame()).not.toContain("resident session content")` |
| "keeps the composer subagent picker hidden during a permission review" — test/composer-live-fixes.test.tsx:385 | `expect(screen.frame()).toContain("bash wants to run")` |
| "insets the input, caps natural wrapping at six rows, and keeps autocomplete above the rule" — test/composer-live-fixes.test.tsx:405 | `expect(promptRow).toBeGreaterThan(-1)` |
| "blocks a dead clipboard image until the user explicitly removes it and sends" — test/composer-live-fixes.test.tsx:485 | `expect(submittedPrompt).toBeUndefined()` |
| "shows cancellable clipboard progress and disposes a late image without touching the edited draft" — test/composer-live-fixes.test.tsx:523 | `expect(screen.frame()).toContain("edited while reading 中文")` |
| "keeps the managed receipt and stable prompt ID when wake fails, then retries exactly" — test/composer-live-fixes.test.tsx:568 | `expect(screen.frame()).toContain("retry this image")` |
| "distinguishes attachment rejection and discards only its recovery before a new prompt" — test/composer-live-fixes.test.tsx:627 | `expect(screen.frame()).toContain("[Image 1]")` |
| "keeps an uncertain attachment admission intact for an exact retry instead of asking to remove it" — test/composer-live-fixes.test.tsx:684 | `expect(screen.frame()).toContain("[Image 1]")` |
| "never mints a fresh prompt ID after a durable conflict" — test/composer-live-fixes.test.tsx:728 | `expect(promptRequests).toHaveLength(1)` |
| "Escape leaves owned admission running and its completion preserves the new draft" — test/composer-live-fixes.test.tsx:757 | `expect(composer(screen.renderer.root)?.plainText).toBe("")` |
| "submits virtualized large pastes at full length without blocking the composer" — test/composer-live-fixes.test.tsx:801 | `expect(screen.frame()).not.toContain("large-paste-line-0-")` |
| "defers a running Session's model selection until the next prompt, then switches before admission" — test/composer-live-fixes.test.tsx:822 | `expect(modelSwitchRequests).toEqual([])` |
| "a failed in-flight selection admits nothing and retains the draft" — test/composer-live-fixes.test.tsx:879 | `expect(modelSwitchStarted).toBe(false)` |
| "a blocked model switch retains the draft and admits nothing" — test/composer-live-fixes.test.tsx:929 | `expect(promptRequests).toHaveLength(0)` |
| "stacks the full-width subagent picker above the prompt with legible model metadata" — test/composer-live-fixes.test.tsx:984 | `expect(promptRow).toBeGreaterThan(-1)` |

### test/composer-switch-unblocked.test.tsx (6 declarations/groups, 345 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "steers immediately by interrupting the active step before the wake" — test/composer-switch-unblocked.test.tsx:151 | `expect(admitted).toEqual(["stop and read this"])` |
| `ordinary submit follows external durable ${target.id} ${target.variant ?? "base"} without silently reselecting` — test/composer-switch-unblocked.test.tsx:260 | `expect(await waitForFrameText(probe.screen, target.variant ? "GPT 5.6 Terra · low" : "Plain model")).toBe(true)` |
| "a genuine pending effort survives an external durable model update and switches before admission" — test/composer-switch-unblocked.test.tsx:275 | `expect(await waitForFrameText(probe.screen, "Select variant")).toBe(true)` |
| "an unavailable durable effort retains the draft without silently repairing or admitting it" — test/composer-switch-unblocked.test.tsx:293 | `expect(await waitForFrameText(probe.screen, "Model selection needs attention")).toBe(true)` |
| "an existing Session without a saved model admits on its default without persisting a UI fallback" — test/composer-switch-unblocked.test.tsx:304 | `expect(await waitForFrameText(probe.screen, "Message YCoding…")).toBe(true)` |
| "holds the composer behind an awaited model switch and admits on the selected variant" — test/composer-switch-unblocked.test.tsx:314 | `expect(switchStarted).toBe(true)` |

### test/config.test.tsx (2 declarations/groups, 66 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "resolves nested config and keybind defaults" — test/config.test.tsx:6 | `expect(config.leader.timeout).toBe(500)` |
| "provides config and its host interface" — test/config.test.tsx:29 | `expect(app.captureCharFrame()).toContain("mouse ctrl+x")` |

### test/context/local.test.ts (2 declarations/groups, 22 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "parses model IDs containing slashes" — test/context/local.test.ts:4 | `expect(parseModel("provider/family/model")).toEqual({` |
| "moves a model to the front, deduplicates, and limits recents" — test/context/local.test.ts:11 | `expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([` |

### test/custom-endpoint-config.test.ts (9 declarations/groups, 137 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "updates the existing JSONC config and preserves settings, models, and comments" — test/custom-endpoint-config.test.ts:17 | `expect(result).toContain("// retained")` |
| "updates ycoding.json when it exists and creates it when neither config exists" — test/custom-endpoint-config.test.ts:29 | `expect(written.settings.baseURL).toBe("https://example.test")` |
| "rejects malformed existing config without silently replacing it" — test/custom-endpoint-config.test.ts:46 | `expect(writeCustomEndpoint(dir, { baseURL: "https://example.test", api: "chat" })).rejects.toThrow("Unable to parse YCoding config")` |
| "rejects malformed provider merge paths without changing config bytes" — test/custom-endpoint-config.test.ts:54 | `expect(writeCustomEndpoint(dir, { baseURL: "https://example.test", api: "chat", provider: "custom" }))` |
| "keeps an existing model, catalog, and API key when writing nonsecret endpoint config" — test/custom-endpoint-config.test.ts:71 | `expect(provider.models.model).toEqual({ name: "Existing name", family: "Existing family" })` |
| "merges only explicitly set model fields into an existing model" — test/custom-endpoint-config.test.ts:92 | `expect(result.providers.custom.models.model).toEqual({ name: "New name", family: "Old family", api: "responses", disabled: true, package: "kept" })` |
| "writes separate Runpod Jobs endpoints and their served model IDs" — test/custom-endpoint-config.test.ts:114 | `expect(providers["runpod-ollama"]).toMatchObject({ package: "@ycoding-ai/ai/providers/runpod", settings: { worker: "ollama", baseURL: "https://api.runpod.ai/v2/ollama123" }, models` |
| "rejects a Runpod URL outside the Jobs endpoint root before writing credentials or config" — test/custom-endpoint-config.test.ts:123 | `expect(writeCustomEndpoint(dir, { baseURL: "https://other.example/v2/endpoint", api: "chat", worker: "vllm" }))` |
| "does not replace an unrelated provider with a Runpod endpoint" — test/custom-endpoint-config.test.ts:130 | `expect(writeCustomEndpoint(dir, { baseURL: "https://api.runpod.ai/v2/endpoint", api: "chat", worker: "vllm", provider: "shared" }))` |

### test/custom-endpoint-save.test.ts (4 declarations/groups, 95 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "writes a blank-provider endpoint before registering and connecting its named key profile" — test/custom-endpoint-save.test.ts:11 | `expect(config.providers["custom-openai"].package).toBe("aisdk:@ai-sdk/openai-compatible")` |
| "refreshes configured provider and model read models before config-only save succeeds" — test/custom-endpoint-save.test.ts:41 | `expect(result.credentialConnected).toBe(false)` |
| "reports a partial save and does not claim success when profile connection fails" — test/custom-endpoint-save.test.ts:60 | `expect(saveCustomEndpoint(configDir, {` |
| "bounds registration waiting and skips credential calls when no integration appears" — test/custom-endpoint-save.test.ts:78 | `expect(saveCustomEndpoint(configDir, {` |

### test/design-md.test.ts (2 declarations/groups, 122 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "matches every mapped documented color to the resolved default ycoding dark theme" — test/design-md.test.ts:91 | `expect(result.errors).toEqual([])` |
| "detects changed theme values, dropped documented colors, and stale documented colors on scratch copies" — test/design-md.test.ts:98 | `expect([...result.errors, ...result.findings].some((issue) => issue.includes(expected)), expected).toBe(true)` |

### test/devtools.test.ts (1 declarations/groups, 19 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "registers and updates grouped DevTools data" — test/devtools.test.ts:4 | `expect(DevTools.data().find((item) => item.id === "test")).toEqual({` |

### test/dialog-custom-endpoint.test.tsx (8 declarations/groups, 348 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "supports keyboard-driven catalog/provider selection, model editing, and submit" — test/dialog-custom-endpoint.test.tsx:19 | `expect(app.captureCharFrame()).toContain("Model ID")` |
| "saves a blank-provider API key through the registered default integration" — test/dialog-custom-endpoint.test.tsx:80 | `expect(submitted?.provider).toBeUndefined()` |
| "renders Runpod worker selection and submits a served model" — test/dialog-custom-endpoint.test.tsx:136 | `expect(app.captureCharFrame()).toContain("vllm")` |
| "clicking a field focuses it instead of editing the previous field" — test/dialog-custom-endpoint.test.tsx:184 | `expect(app.renderer.currentFocusedEditor?.plainText).toBe("default")` |
| "OpenAI provider field accepts a click and Tab advances to the API key" — test/dialog-custom-endpoint.test.tsx:221 | `expect(submitted).toMatchObject({ baseURL: "https://api.example.test/v1", provider: "private", apiKey: "test-key" })` |
| "OpenAI endpoint choices show the active background after selection" — test/dialog-custom-endpoint.test.tsx:251 | `expect(initial.find((item) => item.text.includes("none"))!.text).toBe("none")` |
| "endpoint choices and actions stay readable in dark and light themes" — test/dialog-custom-endpoint.test.tsx:286 | `expect(span, '${mode}/${kind}: ${label} must render').toBeDefined()` |
| "OpenAI provider suggestions cannot spill a long identifier across the dialog" — test/dialog-custom-endpoint.test.tsx:326 | `expect(frame).not.toContain("A".repeat(45))` |

### test/dialog-feature-sections.test.tsx (5 declarations/groups, 208 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders Active, Conflict, and Available skill sections with conflict treatment" — test/dialog-feature-sections.test.tsx:17 | `expect(result.frame).toContain("Active")` |
| "renders all artifact kind sections at once" — test/dialog-feature-sections.test.tsx:39 | `expect(result.frame).toContain("Skills")` |
| "renders project and global skill scopes from registered skill locations" — test/dialog-feature-sections.test.tsx:56 | `expect(result.frame).toContain("project")` |
| "renders no scope for a skill outside known project and global roots" — test/dialog-feature-sections.test.tsx:75 | `expect(result.frame).toContain("External skill")` |
| "renders artifact scope and stage-derived load status" — test/dialog-feature-sections.test.tsx:89 | `expect(result.frame).toContain("Project · All")` |

### test/dialog-model-recent-footer.test.tsx (1 declarations/groups, 143 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "recent and favorite rows render the formatted context window footer" — test/dialog-model-recent-footer.test.tsx:26 | `expect(recent).toBeTruthy()` |

### test/dialog-model.test.ts (4 declarations/groups, 48 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "completes an explicit selection of the already-current model and variant" — test/dialog-model.test.ts:5 | `No inline assertion; inspect called harness` |
| "withholds completion until a required variant is explicitly selected" — test/dialog-model.test.ts:16 | `expect(dialogModel.completeModelSelection(input)).toBeUndefined()` |
| "model and variant cancellation have no completion result" — test/dialog-model.test.ts:31 | `No inline assertion; inspect called harness` |
| "reports explicit cancellation from both model and variant dialogs" — test/dialog-model.test.ts:41 | `expect(model).toContain('props.onComplete?.({ type: "cancelled" })')` |

### test/dialog-session-list-archive.test.tsx (5 declarations/groups, 256 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders archived sessions distinctly while retaining them in the switcher" — test/dialog-session-list-archive.test.tsx:28 | `expect(app.captureCharFrame()).toContain("Archived")` |
| "cancelling archive leaves the selected session unchanged" — test/dialog-session-list-archive.test.tsx:39 | `expect(requests).toEqual([])` |
| "reports archive failures for the selected session only" — test/dialog-session-list-archive.test.tsx:67 | `expect(requests.map((url) => url.pathname)).toEqual(["/api/session/ses_active/archive"])` |
| "archives the selected active session after confirmation" — test/dialog-session-list-archive.test.tsx:96 | `expect(confirmation).toContain("This is reversible")` |
| "unarchives the selected archived session directly" — test/dialog-session-list-archive.test.tsx:128 | `expect(requests.map((url) => url.pathname)).toEqual(["/api/session/ses_archived/archive"])` |

### test/dialog-session-list-pin.test.tsx (5 declarations/groups, 247 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "lists server-pinned sessions first in pin order with quick-switch slots" — test/dialog-session-list-pin.test.tsx:28 | `expect(pinned).toBeLessThan(first)` |
| "pin toggle asks the server to pin the highlighted unpinned session" — test/dialog-session-list-pin.test.tsx:46 | `expect(requests).toEqual(["POST /api/session/ses_other/pin"])` |
| "pin toggle on a pinned session asks the server to unpin it" — test/dialog-session-list-pin.test.tsx:69 | `expect(requests).toEqual(["DELETE /api/session/ses_first/pin"])` |
| "a session.pinned event moves the session into the pinned group" — test/dialog-session-list-pin.test.tsx:92 | `expect(app.captureCharFrame()).not.toContain("Pinned")` |
| "imports pins from the previous local session.json once and removes it" — test/dialog-session-list-pin.test.tsx:113 | `expect(requests).toEqual([` |

### test/dialog-session-list-rows.test.tsx (1 declarations/groups, 117 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "the first recent session renders on its own row without a blank row above it" — test/dialog-session-list-rows.test.tsx:26 | `expect(header).toBeGreaterThanOrEqual(0)` |

### test/editor.test.ts (3 declarations/groups, 32 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "rejects when the external editor cannot start" — test/editor.test.ts:12 | `expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow()` |
| "normalizes a single trailing editor newline for one-line prompts" — test/editor.test.ts:25 | `expect(normalizePromptContent("hello\n")).toBe("hello")` |
| "preserves multiline prompts that end with a newline" — test/editor.test.ts:30 | `expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")` |

### test/error-boundary.test.tsx (2 declarations/groups, 52 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "FatalCrashGuard exits with the original crash when the crash screen fails to render" — test/error-boundary.test.tsx:12 | `expect(exits).toEqual([original])` |
| "FatalCrashGuard renders the crash screen normally when it does not throw" — test/error-boundary.test.tsx:35 | `expect(exits).toEqual([])` |

### test/feature-plugins/diff-viewer-file-tree-utils.test.ts (22 declarations/groups, 323 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "builds a nested tree with deduplicated directories and file indexes" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:20 | `expect(tree.nodes.filter((node) => node.kind === "directory" && node.name === "src")).toHaveLength(1)` |
| "sorts directories before files and alphabetically within each group" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:41 | `expect(rows.map((row) => '${"  ".repeat(row.depth)}${row.kind}:${row.name}')).toEqual([` |
| "sorts root-level files without creating directories" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:63 | `expect(tree.nodes.every((node) => node.kind === "file")).toBe(true)` |
| "collapses unary directory chains while flattening" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:70 | `expect(rows.map((row) => '${"  ".repeat(row.depth)}${row.kind}:${row.name}')).toEqual([` |
| "does not collapse a directory into a file row" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:84 | `expect(rows.map((row) => '${"  ".repeat(row.depth)}${row.kind}:${row.name}')).toEqual([` |
| "stops collapsing at branches" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:93 | `expect(rows.map((row) => '${"  ".repeat(row.depth)}${row.kind}:${row.name}')).toEqual([` |
| "keeps same directory names under different parents separate" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:113 | `expect(rows.map((row) => '${"  ".repeat(row.depth)}${row.kind}:${row.name}')).toEqual([` |
| "flattens all-expanded rows depth-first with depths and file references" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:126 | `expect(rows.map((row) => ({ name: row.name, kind: row.kind, depth: row.depth, fileIndex: row.fileIndex }))).toEqual(` |
| "collapses expanded unary children under the first visible directory id" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:141 | `expect(flattenFileTree(tree, new Set()).map((row) => row.name)).toEqual(["packages/core/src"])` |
| "flattens only expanded directory descendants when expansion is provided" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:156 | `expect(flattenFileTree(tree, new Set()).map((row) => row.name)).toEqual(["src", "README.md"])` |
| "moves selection across visible rows and clamps to bounds" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:177 | `expect(moveFileTreeSelection(rows, undefined, 1)).toBe(rows[0]!.id)` |
| "moves directory selection to first visible child" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:187 | `expect(moveFileTreeSelectionToFirstChild(rows, src.id)).toBe(config.id)` |
| "moves collapsed chain selection to first visible child" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:198 | `expect(moveFileTreeSelectionToFirstChild(rows, packages.id)).toBe(cli.id)` |
| "moves file and collapsed directory selection to visible parent" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:208 | `expect(moveFileTreeSelectionToParent(rows, app.id)).toBe(cli.id)` |
| "moves file selection relative to the highlighted row" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:222 | `expect(moveFileTreeSelectionToFile(rows, undefined, 1)).toBe(tui.id)` |
| "selects a file tree node and expands its parents for a patch file" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:241 | `expect(selection?.highlightedNode).toBe(` |
| "prefers the selected file when choosing the single patch file" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:252 | `expect(singlePatchFileIndex(2, 1, 0, 3)).toBe(2)` |
| "orders patches by the flattened file tree order" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:259 | `expect(orderedPatchFileIndexes(rows)).toEqual([2, 1, 0])` |
| "shows the diff viewer file tree only when enabled and files exist" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:271 | `expect(showDiffViewerFileTree(true, 1)).toBe(true)` |
| "moves patch selection through the ordered patch file indexes" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:278 | `expect(movePatchFileIndex(fileIndexes, undefined, 1)).toBe(2)` |
| "toggles only selected directory expansion" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:291 | `expect(collapsed.has(src.id)).toBe(false)` |
| "sets only selected directory expansion" — test/feature-plugins/diff-viewer-file-tree-utils.test.ts:308 | `expect(collapsed.has(src.id)).toBe(false)` |

### test/file-change-summary.test.tsx (10 declarations/groups, 307 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "shows a running edit as its own row and never as an edited or captured summary" — test/file-change-summary.test.tsx:128 | `expect(screen.frame()).toContain("src/parent.ts")` |
| "keeps a completed edit visible in the summary while its step is still running" — test/file-change-summary.test.tsx:140 | `expect(line("Still working.")).toBeLessThan(line("Captured changes 1 file"))` |
| "shows the summary after an assistant that ended without a footer" — test/file-change-summary.test.tsx:152 | `expect(line("Apply the changes")).toBeLessThan(line("Captured changes 1 file"))` |
| "keeps a finished segment's summary in place while the next segment is running" — test/file-change-summary.test.tsx:165 | `expect(line("First request")).toBeLessThan(first!)` |
| "keeps a failed edit as its own failed row without a summary" — test/file-change-summary.test.tsx:179 | `expect(screen.frame()).not.toContain("Captured changes")` |
| "merges repeated edits to one file into one summary row and hides the per-tool edit blocks" — test/file-change-summary.test.tsx:190 | `expect(screen.frame()).not.toContain("Edited 1 file")` |
| "keeps one summary per prompt segment on its own reply, omits an unchanged segment, and reads no ledger" — test/file-change-summary.test.tsx:208 | `expect(line("First request")).toBeLessThan(first!)` |
| "keeps earlier segment summaries across a compaction" — test/file-change-summary.test.tsx:230 | `expect(screen.frame()).not.toContain("src/second.ts")` |
| "lists every edited file of one segment and expands a patch" — test/file-change-summary.test.tsx:245 | `expect(screen.lines().filter((line) => sixPaths.some((path) => line.includes(path)))).toHaveLength(6)` |
| `renders an expanded captured file with ${name} layout` — test/file-change-summary.test.tsx:277 | `expect(header).toBeGreaterThan(-1)` |

### test/footer-guardrail-mode-chips.test.tsx (3 declarations/groups, 121 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "derives the goal chip from the active goal status and labels YOLO by level" — test/footer-guardrail-mode-chips.test.tsx:12 | `expect(active).toEqual({ key: "goal", label: "goal", tone: "on" })` |
| "renders the idle, goal, YOLO, and guardrail footer states at 80 columns" — test/footer-guardrail-mode-chips.test.tsx:39 | `expect(frame).toContain("goal off")` |
| "clearing a pending guardrail restores the prior YOLO footer state" — test/footer-guardrail-mode-chips.test.tsx:90 | `expect(frame).toContain("goal")` |

### test/guardrail-surface.test.tsx (5 declarations/groups, 219 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "surfaces a pending root guardrail review from the durable list" — test/guardrail-surface.test.tsx:151 | `expect(screen.frame()).toContain("Guardrail blocked")` |
| "surfaces a pending root guardrail review that arrives as a live event" — test/guardrail-surface.test.tsx:162 | `expect(screen.frame()).not.toContain("Guardrail blocked")` |
| "surfaces a pending subagent guardrail review from the durable list" — test/guardrail-surface.test.tsx:175 | `expect(screen.frame()).toContain("Subagent ses_guardrail_child in ses_guardrail_parent")` |
| "surfaces a pending subagent guardrail review that arrives as a live event" — test/guardrail-surface.test.tsx:186 | `expect(screen.frame()).not.toContain("Guardrail blocked")` |
| "renders a transcript row for a subagent review and replies against the root session" — test/guardrail-surface.test.tsx:199 | `expect(screen.frame()).toContain("rm -rf packages/one packages/two")` |

### test/index.test.tsx (1 declarations/groups, 6 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "exports the canonical application lifecycle" — test/index.test.tsx:4 | `expect(typeof run).toBe("function")` |

### test/isolated-browser-dialog.test.tsx (19 declarations/groups, 755 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "Session browser commands appear in the modal command palette without starting pairing" — test/isolated-browser-dialog.test.tsx:31 | `expect(result.commands().map((command) => command.id)).toContain("session.browser.chrome")` |
| "production Session command is available and opens isolated browser for its current Session" — test/isolated-browser-dialog.test.tsx:59 | `expect(result.app.captureCharFrame()).not.toContain("Isolated browser")` |
| "Session command creates a one-time Chrome pairing code only on explicit request" — test/isolated-browser-dialog.test.tsx:89 | `expect(requests).toHaveLength(0)` |
| "Chrome pairing code survives status polls and paired disconnects never offer implicit re-pairing" — test/isolated-browser-dialog.test.tsx:128 | `expect(statuses).toBeGreaterThanOrEqual(2)` |
| "paired Chrome status offers explicit forget instead of another pairing code" — test/isolated-browser-dialog.test.tsx:170 | `expect(result.app.captureCharFrame()).not.toContain("create pairing code")` |
| "Chrome connection dialog describes profile-wide pairing without a separate grant" — test/isolated-browser-dialog.test.tsx:204 | `expect(result.app.captureCharFrame().replace(/\s+/g, " ")).toContain(` |
| "cancelling explicit Start submits no API call" — test/isolated-browser-dialog.test.tsx:237 | `expect(cancelled.app.captureCharFrame()).toContain("esc")` |
| "explicit Start submits one credential-free URL and renders only origin and path" — test/isolated-browser-dialog.test.tsx:262 | `expect(starts).toEqual([` |
| "Start rejects non-http and embedded-credential URLs before transport" — test/isolated-browser-dialog.test.tsx:296 | `expect(starts).toBe(0)` |
| "pending controls suppress duplicate submissions and preserve stop during startup" — test/isolated-browser-dialog.test.tsx:321 | `expect(pauses).toBe(1)` |
| "ready, paused, stopped, unavailable, conflict, and safe failures render truthful controls" — test/isolated-browser-dialog.test.tsx:373 | `expect(result.app.captureCharFrame()).not.toContain("secret=yes")` |
| "unreported ready tab requires a fresh start and narrow view keeps safety notices visible" — test/isolated-browser-dialog.test.tsx:420 | `expect(frame).toContain("Temporary disposable Chrome")` |
| "pause, resume, and stop call only isolated lifecycle methods for the Session" — test/isolated-browser-dialog.test.tsx:439 | `expect(controls).toEqual([` |
| "reopen and Session change ignore stale responses and reject a foreign tab owner" — test/isolated-browser-dialog.test.tsx:473 | `expect(result.app.captureCharFrame()).not.toContain("stale.example")` |
| "conflict never invokes selected-extension operations or starts before isolated stop" — test/isolated-browser-dialog.test.tsx:505 | `expect(result.app.captureCharFrame()).not.toContain("Start isolated browser")` |
| "lost start response refreshes authoritative status once without replaying start" — test/isolated-browser-dialog.test.tsx:534 | `expect(starts).toBe(1)` |
| "foreign tab state cannot dispatch controls through hidden keyboard bindings" — test/isolated-browser-dialog.test.tsx:566 | `expect(controls).toBe(0)` |
| "late control completion cannot overwrite another Session's status" — test/isolated-browser-dialog.test.tsx:588 | `expect(controlSignal?.aborted).toBe(true)` |
| "late startup-stop result cannot replace a reopened dialog" — test/isolated-browser-dialog.test.tsx:621 | `expect(statuses).toBe(2)` |

### test/keep-awake.test.tsx (7 declarations/groups, 217 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "the one keep-awake row shows the backend state with a word and a color that agree" — test/keep-awake.test.tsx:74 | `expect(view.commands().filter((command) => command.id?.startsWith("keepAwake.")).map((command) => command.title)).toEqual(["Keep machine awake"])` |
| "palette selection turns the backend switch on and off and explains what it does not override" — test/keep-awake.test.tsx:102 | `expect(server.writes).toEqual([true, false])` |
| "an unsupported backend shows its reason and receives no write" — test/keep-awake.test.tsx:125 | `expect(server.writes).toEqual([])` |
| "a backend error is surfaced and the next toggle retries" — test/keep-awake.test.tsx:139 | `expect(view.status()?.message).toBe("The sleep inhibitor could not be started.")` |
| "a rejected request reports the failure without claiming the machine is awake" — test/keep-awake.test.tsx:161 | `expect(view.status()).toEqual({ state: "error", message: "backend unreachable" })` |
| "a delayed initial read shows Checking and writes nothing before settling %s" — test/keep-awake.test.tsx:178 (table) | `expect(view.status()).toBeUndefined()` |
| "disposing while the initial read is pending ignores its late result and prevents writes" — test/keep-awake.test.tsx:207 | `expect(view.status()).toBeUndefined()` |

### test/keybind.test.ts (4 declarations/groups, 111 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "binds agent cycling only to tab by default" — test/keybind.test.ts:4 | `expect(TuiKeybind.Definitions.agent_cycle.default).toBe("tab")` |
| "binds supported maintainer shortcuts without leader collisions" — test/keybind.test.ts:9 | `expect(TuiKeybind.Definitions.variant_list.default).toBe("<leader>v")` |
| "new supported shortcuts remain configurable and render in help" — test/keybind.test.ts:33 | `expect(TuiKeybind.parse({ variant_list: "ctrl+v", session_autonomy_normal: "ctrl+d" })).toMatchObject({` |
| "binds shell output actions through configurable commands" — test/keybind.test.ts:104 | `expect(TuiKeybind.Definitions.shell_output_back.default).toBe("escape")` |

### test/keymap-registration.test.ts (7 declarations/groups, 78 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "every configurable keybind has a runtime consumer" — test/keymap-registration.test.ts:4 | `expect(missing).toEqual([])` |
| "session goal keeps palette and durable autonomy state wiring" — test/keymap-registration.test.ts:16 | `expect(command).toContain('name: "session.autonomy.goal"')` |
| "session goal has one slash registration" — test/keymap-registration.test.ts:32 | `expect(sources.join("\n").match(/slash:\s*\{\s*name:\s*"goal"\s*\}/g)).toHaveLength(1)` |
| "retained submission retry is an explicit conditional Prompt command" — test/keymap-registration.test.ts:41 | `expect(prompt).toContain('title: "Retry previous submission"')` |
| "session skills is registered only by the session route" — test/keymap-registration.test.ts:52 | `expect(session).toContain('title: "Session skills"')` |
| "session compact surfaces API rejection through the toast error path" — test/keymap-registration.test.ts:60 | `expect(command).toContain("client.api.session.compact({ sessionID: route.sessionID })")` |
| "shell output relies on configurable action bindings" — test/keymap-registration.test.ts:71 | `expect(route).toContain('id: "shell-output.back"')` |

### test/keymap.test.tsx (9 declarations/groups, 315 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "drops key events with an empty name instead of erroring in the resolver" — test/keymap.test.tsx:9 | `expect(errors.some((line) => line.includes("event-match-resolver-error"))).toBe(false)` |
| "legacy page key aliases compile as page keys" — test/keymap.test.tsx:48 | `expect(read()).toEqual({ up: "pgup", down: "pgdn" })` |
| "formats navigation keys as arrows" — test/keymap.test.tsx:87 | `expect(read()).toEqual({` |
| "leader bindings dispatch from real terminal input" — test/keymap.test.tsx:119 | `expect(calls).toEqual(["model"])` |
| "inline leader sequences dispatch from real terminal input" — test/keymap.test.tsx:150 | `expect(calls).toEqual(["cancel"])` |
| "plain tab dispatches the default agent cycle command" — test/keymap.test.tsx:181 | `expect(calls).toEqual(["agent"])` |
| "custom leader bindings dispatch from real terminal input" — test/keymap.test.tsx:211 | `expect(calls).toEqual(["model"])` |
| "custom direct command binding replaces the default leader binding" — test/keymap.test.tsx:242 | `expect(calls).toEqual([])` |
| "global commands stay reachable when the mode changes" — test/keymap.test.tsx:277 | `expect(calls).toEqual(["global", "base", "global"])` |

### test/landing.test.tsx (6 declarations/groups, 165 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders the transparent five-block mark and requested landing copy with the YCoding design tokens" — test/landing.test.tsx:66 | `expect(frame(app).join("\n")).toMatch(/[▀▄█]/)` |
| "keeps the five-block mark above the hero copy" — test/landing.test.tsx:79 | `expect(mark).toBeGreaterThanOrEqual(0)` |
| "keeps the brand lockup independent of command-palette keybindings" — test/landing.test.tsx:94 | `expect(frame(rebound).join("\n")).toContain("What should we build?")` |
| "uses the static landing placeholder and an uncapped full-width composer rule" — test/landing.test.tsx:107 | `expect(frame(narrow).join("\n")).toContain("Message YCoding…")` |
| "gives the landing composition the same resting height as the session composer" — test/landing.test.tsx:124 | `expect(findText(app.renderer.root, "single-line composer")?.parent?.parent?.height).toBe(` |
| "hides an image-mark slot while an overlay is open" — test/landing.test.tsx:156 | `expect(app.captureCharFrame()).not.toContain("bitmap mark")` |

### test/live-ui-regressions.test.tsx (5 declarations/groups, 283 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "centers the first rail section title in a full-width three-row background band" — test/live-ui-regressions.test.tsx:25 | `expect(titleRow).toBe(4)` |
| "keeps the prompt input visible with Prompt, Shell, and Subagents selected" — test/live-ui-regressions.test.tsx:64 | `expect(capture.frame()).toContain("Message YCoding")` |
| "never renders a Unix home directory username in a file path" — test/live-ui-regressions.test.tsx:83 | `expect(frame.match(/~\/Workspace\/project/g)).toHaveLength(2)` |
| "keeps subagent and shell footer counts as independent segments" — test/live-ui-regressions.test.tsx:106 | `expect(line).toContain("subagents 2   shells 0")` |
| "keeps the header model readable while a toast is visible" — test/live-ui-regressions.test.tsx:161 | `expect(app.captureCharFrame()).toContain("Claude Opus 5")` |

### test/mcp-oauth-routing.test.ts (3 declarations/groups, 41 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "maps MCP lifecycle states to the correct dialog action" — test/mcp-oauth-routing.test.ts:7 | `expect(mcpDialogAction("pending")).toBe("none")` |
| "resolves the OAuth method registered for an MCP server" — test/mcp-oauth-routing.test.ts:15 | `expect(mcpOAuthTarget(server, [integration])).toEqual({ integration, method })` |
| "MCP authorization launches from Enter or the toggle action" — test/mcp-oauth-routing.test.ts:35 | `expect(dialogMcp).toContain('if (server.status.status === "needs_auth")')` |

### test/mcp-presentation.test.ts (2 declarations/groups, 33 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "presents every MCP state distinctly" — test/mcp-presentation.test.ts:4 | `expect(mcpStatusPresentation("pending")).toEqual({ symbol: "⋯", label: "Connecting", tone: "subdued" })` |
| "summarizes connected and configured MCP servers" — test/mcp-presentation.test.ts:17 | `expect(summary).toEqual({` |

### test/mini/catalog.shared.test.ts (3 declarations/groups, 93 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "resolves the catalog-selected model for the footer" — test/mini/catalog.shared.test.ts:11 | `expect(waitForDefaultModel({ sdk: client, location: { directory: "/tmp" } })).resolves.toEqual({` |
| "loads visible project references from the current reference catalog" — test/mini/catalog.shared.test.ts:31 | `expect(list).toHaveBeenCalledWith({ location: { directory: "/tmp" } })` |
| "merges current providers and models into the footer catalog shape" — test/mini/catalog.shared.test.ts:60 | `expect(providers).toEqual([` |

### test/mini/entry.body.test.ts (13 declarations/groups, 541 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders a failed direct shell as an error instead of completed success" — test/mini/entry.body.test.ts:45 | `No inline assertion; inspect called harness` |
| "renders assistant, reasoning, and user entries in their display formats" — test/mini/entry.body.test.ts:62 | `expect(reasoning).toEqual({` |
| "keeps running subagent tool state out of scrollback" — test/mini/entry.body.test.ts:204 | `No inline assertion; inspect called harness` |
| "promotes subagent results to markdown and falls back to structured summaries" — test/mini/entry.body.test.ts:228 | `No inline assertion; inspect called harness` |
| "streams tool progress text and treats completed progress as done" — test/mini/entry.body.test.ts:280 | `expect(body).toEqual({` |
| "formats completed shell output with a blank line after the command and no trailing blank row" — test/mini/entry.body.test.ts:322 | `No inline assertion; inspect called harness` |
| "renders command-only shell starts without the shell header" — test/mini/entry.body.test.ts:348 | `No inline assertion; inspect called harness` |
| "renders direct shell commits without a synthetic shell header" — test/mini/entry.body.test.ts:372 | `No inline assertion; inspect called harness` |
| "falls back to patch summary when patch has no visible diff items" — test/mini/entry.body.test.ts:414 | `No inline assertion; inspect called harness` |
| "suppresses redundant patched rows when patch also created a file" — test/mini/entry.body.test.ts:442 | `No inline assertion; inspect called harness` |
| "renders glob failures as the raw error under the existing header" — test/mini/entry.body.test.ts:474 | `No inline assertion; inspect called harness` |
| "renders bounded structured output for completed unknown tools without text" — test/mini/entry.body.test.ts:499 | `expect(body).toMatchObject({ type: "code", filetype: "json" })` |
| "renders interrupted assistant finals as text" — test/mini/entry.body.test.ts:524 | `No inline assertion; inspect called harness` |

### test/mini/footer-keymap.test.tsx (1 declarations/groups, 91 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "down opens subagents from an empty prompt" — test/mini/footer-keymap.test.tsx:11 | `expect(app.renderer.currentFocusedEditor?.plainText).toBe("")` |

### test/mini/footer.menu.test.ts (2 declarations/groups, 43 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "footer menu scrolls before the selected row hits the bottom edge" — test/mini/footer.menu.test.ts:18 | `expect(state.menu.selected()).toBe(6)` |
| "footer menu scrolls before the selected row hits the top edge" — test/mini/footer.menu.test.ts:31 | `expect(state.menu.selected()).toBe(9)` |

### test/mini/footer.test.ts (1 declarations/groups, 25 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "coalesces progress only within the same message and tool state" — test/mini/footer.test.ts:19 | `expect(coalesceProgressCommit(progress(), progress({ messageID: "msg_2" }))).toBeUndefined()` |

### test/mini/footer.view.test.tsx (33 declarations/groups, 1492 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "direct footer preserves a partial multi-field form draft across permission preemption" — test/mini/footer.view.test.tsx:199 | `expect(app.renderer.currentFocusedEditor?.plainText).toBe("keep this draft")` |
| "direct footer composer area does not adopt footer surface" — test/mini/footer.view.test.tsx:296 | `expect(area.backgroundColor.toInts()).not.toEqual(surface.toInts())` |
| "run entry content updates when live commit text changes" — test/mini/footer.view.test.tsx:321 | `expect(app.captureCharFrame()).toContain("I")` |
| "direct command panel renders grouped command palette" — test/mini/footer.view.test.tsx:365 | `expect(frame).toContain("Commands")` |
| "direct skill panel renders searchable skill list" — test/mini/footer.view.test.tsx:431 | `expect(frame).toContain("Skills")` |
| "direct skill panel truncates long descriptions from the end" — test/mini/footer.view.test.tsx:479 | `expect(frame).toContain("terminal-control")` |
| "direct command panel shows subagent entry when available" — test/mini/footer.view.test.tsx:518 | `expect(frame).toContain("View subagents")` |
| "direct command panel keeps completed subagents available" — test/mini/footer.view.test.tsx:564 | `expect(frame).toContain("View subagents")` |
| "direct subagent panel renders active subagents" — test/mini/footer.view.test.tsx:612 | `expect(frame).toContain("Select subagent")` |
| "direct subagent panel closes when moving up from the first item" — test/mini/footer.view.test.tsx:659 | `expect(closed).toBe(0)` |
| "direct queued prompt panel renders pending prompt actions" — test/mini/footer.view.test.tsx:695 | `expect(frame).toContain("Queued prompts")` |
| "direct footer recreates the frame across command panel transitions" — test/mini/footer.view.test.tsx:739 | `expect(composer).toBeDefined()` |
| "Mini Chrome command shows the service address and creates a code only on p" — test/mini/footer.view.test.tsx:766 | `expect(app.captureCharFrame()).toContain("Connect Chrome")` |
| "closing Mini Chrome pairing ignores a pending response and does not submit twice" — test/mini/footer.view.test.tsx:807 | `expect(starts).toHaveLength(1)` |
| "Mini paired Chrome view hides pair and exposes deliberate forget" — test/mini/footer.view.test.tsx:842 | `expect(app.captureCharFrame()).toContain("Chrome is paired; waiting for Chrome to reconnect.")` |
| "direct footer dispatches leader variant binding only when leader is registered" — test/mini/footer.view.test.tsx:876 | `expect(calls).toEqual([])` |
| "direct footer keeps leader variant binding inactive when leader is disabled" — test/mini/footer.view.test.tsx:896 | `expect(calls).toEqual([])` |
| "direct footer submits slash autocomplete selections without dispatching shell completions" — test/mini/footer.view.test.tsx:915 | `expect(submits).toEqual([` |
| "direct footer mention menu ranks an exact non-file match above a fuzzy prefix match" — test/mini/footer.view.test.tsx:977 | `expect(agentRow).toBeGreaterThanOrEqual(0)` |
| "direct footer slash autocomplete keeps a real skills command" — test/mini/footer.view.test.tsx:1009 | `expect(submits).toEqual([{ text: "/skills ", parts: [], command: { name: "skills", arguments: "" } }])` |
| "selectedCommand backfills the catalog source for bound drafts" — test/mini/footer.view.test.tsx:1036 | `expect(selectedCommand("/ycoding-ts fix it", { name: "ycoding-ts", arguments: "" }, catalog)).toEqual({` |
| "direct footer tags skill slash submissions with their catalog source" — test/mini/footer.view.test.tsx:1059 | `expect(submits).toEqual([` |
| "direct footer skill picker inserts an editable bound skill command" — test/mini/footer.view.test.tsx:1084 | `expect(app.captureCharFrame()).toContain("Skill named new")` |
| "direct footer clears the synthetic skills draft when the panel closes" — test/mini/footer.view.test.tsx:1122 | `expect(app.captureCharFrame()).toContain("Apply formatter fixes")` |
| "direct footer shows editable prompts and additional queued work while running" — test/mini/footer.view.test.tsx:1153 | `expect(spinner).toBeDefined()` |
| "direct footer always offers backgrounding for a foreground subagent" — test/mini/footer.view.test.tsx:1263 | `expect(frame).toContain("GPT-5")` |
| "direct footer hides the subagent hint when only completed subagents remain" — test/mini/footer.view.test.tsx:1290 | `expect(frame).toContain("GPT-5")` |
| "direct footer omits interrupt key hint when interrupt is unbound" — test/mini/footer.view.test.tsx:1316 | `expect(frame).toContain("interrupt")` |
| "direct footer shows full usage metadata when room is available" — test/mini/footer.view.test.tsx:1333 | `expect(frame).toContain("159.6K (16%) · $4.23")` |
| "direct footer mode label keeps left padding without a status pill" — test/mini/footer.view.test.tsx:1348 | `expect(statusline).toBeDefined()` |
| "direct permission rejection submits through keymap return binding" — test/mini/footer.view.test.tsx:1365 | `expect(app.captureCharFrame()).toContain("retry")` |
| "direct model panel renders current model selector" — test/mini/footer.view.test.tsx:1411 | `expect(frame).toContain("Select model")` |
| "direct variant panel renders current variant selector" — test/mini/footer.view.test.tsx:1454 | `expect(frame).toContain("Select variant")` |

### test/mini/footer.width.test.ts (1 declarations/groups, 35 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "preserves shared dialog and statusline breakpoints" — test/mini/footer.width.test.ts:5 | `expect(narrow.dialog.narrow).toBe(true)` |

### test/mini/form.shared.test.ts (2 declarations/groups, 66 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "builds every supported answer and preserves owner location" — test/mini/form.shared.test.ts:22 | `expect(formAnswer(form, state)).toEqual(answer)` |
| "rejects invalid and deliberately unsupported shapes" — test/mini/form.shared.test.ts:50 | `expect(formValidate(invalid, createFormBodyState(invalid))).toContain("Answer required")` |

### test/mini/permission.shared.test.ts (7 declarations/groups, 194 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "replies immediately for allow once" — test/mini/permission.shared.test.ts:31 | `expect(out.reply).toEqual({` |
| "requires confirmation for allow always" — test/mini/permission.shared.test.ts:41 | `expect(next.state.stage).toBe("always")` |
| "builds trimmed reject replies and stage transitions" — test/mini/permission.shared.test.ts:59 | `expect(next.state.stage).toBe("reject")` |
| "maps supported permission types into display info" — test/mini/permission.shared.test.ts:87 | `expect(permissionInfo(req({ action: "doom_loop" }))).toMatchObject({` |
| "prefers canonical request metadata over source tool metadata" — test/mini/permission.shared.test.ts:132 | `No inline assertion; inspect called harness` |
| "uses source patch text when an edit has no generated diff" — test/mini/permission.shared.test.ts:157 | `No inline assertion; inspect called harness` |
| "formats always-allow copy for wildcard and explicit patterns" — test/mini/permission.shared.test.ts:183 | `expect(permissionAlwaysLines(req({ action: "bash", save: ["*"] }))).toEqual([` |

### test/mini/prompt.editor.test.ts (4 declarations/groups, 116 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "strips the local /editor command from the initial editor text" — test/mini/prompt.editor.test.ts:6 | `expect(resolveEditorSlashValue("/editor")).toBe("")` |
| "realigns file and agent parts after external editing" — test/mini/prompt.editor.test.ts:12 | `expect(realignEditorPromptParts("Please check @helper before @src/app.ts", parts)).toEqual([` |
| "drops parts whose virtual text was deleted" — test/mini/prompt.editor.test.ts:63 | `expect(realignEditorPromptParts("Only @helper remains", parts)).toEqual([` |
| "uses display offsets when realigning Mini parts" — test/mini/prompt.editor.test.ts:102 | `expect(realignEditorPromptParts("中文🙂\n@helper", [part])).toEqual([` |

### test/mini/prompt.shared.test.ts (6 declarations/groups, 101 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "filters blank prompts and dedupes consecutive history" — test/mini/prompt.shared.test.ts:16 | `expect(out.items.map((item) => item.text)).toEqual(["one", "two", "one"])` |
| "push ignores blanks and dedupes only the latest item" — test/mini/prompt.shared.test.ts:24 | `expect(pushPromptHistory(base, prompt("   ")).items.map((item) => item.text)).toEqual(["one"])` |
| "moves through history only at input boundaries and restores draft" — test/mini/prompt.shared.test.ts:32 | `expect(movePromptHistory(base, -1, "draft", 1)).toEqual({` |
| "uses display-width cursors for history restoration" — test/mini/prompt.shared.test.ts:66 | `expect(latest.apply).toBe(true)` |
| "recognizes exit commands" — test/mini/prompt.shared.test.ts:90 | `expect(isExitCommand("/exit")).toBe(true)` |
| "recognizes the new-session command" — test/mini/prompt.shared.test.ts:96 | `expect(isNewCommand("/new")).toBe(true)` |

### test/mini/runtime.boot.test.ts (5 declarations/groups, 147 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "reads footer keybinds from resolved keybind config" — test/mini/runtime.boot.test.ts:44 | `expect(result.keybinds.get("leader")?.[0]?.key).toBe("ctrl+g")` |
| "falls back to default tui keymap config when config load fails" — test/mini/runtime.boot.test.ts:73 | `expect(result.keybinds.get("leader")?.[0]?.key).toBe("ctrl+x")` |
| "preserves disabled leader from resolved tui config" — test/mini/runtime.boot.test.ts:88 | `expect(result.keybinds.get("leader")).toEqual([])` |
| "preserves current theme mode, leader, and thinking config" — test/mini/runtime.boot.test.ts:94 | `expect(result.theme).toEqual({ mode: "light" })` |
| "loads v2 providers and models for model selector data" — test/mini/runtime.boot.test.ts:108 | `expect(resolveModelInfo(sdk, { directory: "/workspace" })).resolves.toEqual({` |

### test/mini/runtime.queue.test.ts (16 declarations/groups, 405 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "ignores empty prompts" — test/mini/runtime.queue.test.ts:7 | `expect(calls).toBe(0)` |
| "treats /exit as a close command" — test/mini/runtime.queue.test.ts:25 | `expect(calls).toBe(0)` |
| "treats /new as a local session command" — test/mini/runtime.queue.test.ts:42 | `expect(created).toBe(1)` |
| "shell mode submits /exit as a shell command" — test/mini/runtime.queue.test.ts:75 | `expect(seen).toEqual([{ text: "/exit", parts: [], mode: "shell" }])` |
| "shell mode submits /new instead of creating a session" — test/mini/runtime.queue.test.ts:94 | `expect(created).toBe(0)` |
| "shell mode does not append a synthetic user row" — test/mini/runtime.queue.test.ts:118 | `expect(ui.commits).toEqual([])` |
| "shell mode does not emit a turn duration summary" — test/mini/runtime.queue.test.ts:133 | `expect(ui.events.some((event) => event.type === "turn.duration")).toBe(false)` |
| "preserves whitespace for initial input" — test/mini/runtime.queue.test.ts:149 | `expect(seen).toEqual(["  hello  "])` |
| "passes prompts to onSend" — test/mini/runtime.queue.test.ts:174 | `expect(seen).toEqual(["  hello  "])` |
| "appends the user row before the turn starts" — test/mini/runtime.queue.test.ts:192 | `expect(ui.commits).toEqual([` |
| "runs queued prompts in order" — test/mini/runtime.queue.test.ts:213 | `expect(seen).toEqual(["one"])` |
| "exposes ordinary in-flight prompts for removal before sending" — test/mini/runtime.queue.test.ts:245 | `expect(turns.map((item) => item.text)).toEqual(["one"])` |
| "removing one managed queued prompt preserves the others" — test/mini/runtime.queue.test.ts:286 | `expect(turns).toEqual(["active", "queued one", "queued three"])` |
| "drains a prompt queued during an in-flight turn" — test/mini/runtime.queue.test.ts:321 | `expect(seen).toEqual(["one"])` |
| "close aborts the active run and drops pending queued work" — test/mini/runtime.queue.test.ts:354 | `expect(hit).toBe(true)` |
| "propagates run errors" — test/mini/runtime.queue.test.ts:392 | `expect(task).rejects.toThrow("boom")` |

### test/mini/runtime.test.ts (7 declarations/groups, 619 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "Mini pairing uses the active Session and only starts after an explicit request" — test/mini/runtime.test.ts:51 | `expect(lifecycle.browserAddress?.()).toBe("http://127.0.0.1:43094")` |
| "switching to a model without the saved variant displays and submits no stale variant" — test/mini/runtime.test.ts:122 | `expect(selected).toMatchObject({ modelLabel: "model-b · Test", variant: undefined })` |
| "routes form responses to their owners with global location and local settlement" — test/mini/runtime.test.ts:211 | `expect(reply).toHaveBeenCalledWith(` |
| "resolves the deferred session only after first paint" — test/mini/runtime.test.ts:300 | `expect(resolved).toBe(0)` |
| "restores deferred session history and model after first paint" — test/mini/runtime.test.ts:354 | `expect(sdk.session.get).not.toHaveBeenCalled()` |
| "aborts deferred resume history on close and uses the cached exit title" — test/mini/runtime.test.ts:446 | `expect(aborted).toBe(2)` |
| "adopts the deferred target location for catalogs, files, and runtime placement" — test/mini/runtime.test.ts:524 | `expect(targets).toBe(0)` |

### test/mini/scrollback.surface.test.ts (13 declarations/groups, 737 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "turn summary starts at the left edge" — test/mini/scrollback.surface.test.ts:116 | `expect(renderRows(commits.at(-1)!)[0]).toBe("Build · Little Frank · 2.2s")` |
| "theme swaps restyle active reasoning without resetting the stream" — test/mini/scrollback.surface.test.ts:133 | `expect(activeSyntax(out.scrollback)).toBe(previousSyntax)` |
| "theme swaps preserve streamed markdown parser state" — test/mini/scrollback.surface.test.ts:177 | `expect(output).toContain("const answer = 42")` |
| "scopes repeated tool part IDs to their assistant messages" — test/mini/scrollback.surface.test.ts:249 | `expect(entryGroupKey(first)).not.toBe(entryGroupKey(second))` |
| "finalizes markdown tables for streamed and coalesced input" — test/mini/scrollback.surface.test.ts:262 | `expect(output).toContain("Column 1")` |
| "holds markdown code blocks until final commit and keeps newline ownership" — test/mini/scrollback.surface.test.ts:291 | `expect(progress).toHaveLength(1)` |
| "renders question summaries without boilerplate footer copy" — test/mini/scrollback.surface.test.ts:327 | `expect(claim(out.renderer)).toHaveLength(0)` |
| "inserts spacers for new visible groups" — test/mini/scrollback.surface.test.ts:408 | `expect(commits).toHaveLength(2)` |
| "renders replayed user, reasoning, and assistant output after completion" — test/mini/scrollback.surface.test.ts:500 (skipIf win32) | `expect(output).toContain("› Hello you")`; remaining replay assertions require semantic review; Windows is skipped, not passed |
| "coalesces same-line tool progress into one snapshot" — test/mini/scrollback.surface.test.ts:535 | `expect(commits).toHaveLength(1)` |
| "does not double-space before completed shell output when inline tool headers intervene" — test/mini/scrollback.surface.test.ts:555 | `expect(output).toContain('✱ Grep "tool" in src/cli/cmd/run\n\ndemo.ts')` |
| "renders plain errors with one blank line before and after the error block" — test/mini/scrollback.surface.test.ts:647 | `expect(commits.at(-1)?.trailingNewline).toBe(false)` |
| "renders structured write finals once as code blocks" — test/mini/scrollback.surface.test.ts:681 | `expect(claim(out.renderer)).toHaveLength(0)` |

### test/mini/session.shared.test.ts (5 declarations/groups, 229 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "builds user prompts from projected text and attachments" — test/mini/session.shared.test.ts:52 | `expect(out.first).toBe(false)` |
| "leaves attachment sources undefined when projected mentions are absent" — test/mini/session.shared.test.ts:96 | `expect(out.turns[0]?.prompt).toEqual({` |
| "dedupes consecutive history entries, drops blanks, and copies prompt parts" — test/mini/session.shared.test.ts:123 | `expect(out.map((item) => item.text)).toEqual(["one", "two"])` |
| "returns the latest matching variant for the active model" — test/mini/session.shared.test.ts:153 | `expect(sessionVariant(session, model)).toBeUndefined()` |
| "restores current prompt history from stored text and file references" — test/mini/session.shared.test.ts:175 | `expect(out.model).toEqual({ providerID: "openai", modelID: "gpt-5" })` |

### test/mini/stream-v2.subagent.test.ts (12 declarations/groups, 563 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "keeps a live running child when an in-place hydrate sees a stale active map" — test/mini/stream-v2.subagent.test.ts:219 | `expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "running" }])` |
| "keeps a live running child when hydration replays a still-running projected subagent call" — test/mini/stream-v2.subagent.test.ts:243 | `expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "running" }])` |
| "settles a live running child on reconnect when the active map no longer lists it" — test/mini/stream-v2.subagent.test.ts:293 | `expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "completed" }])` |
| "settles the child when its subagent tool call fails" — test/mini/stream-v2.subagent.test.ts:322 | `expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "error" }])` |
| "settles a foreground child when the parent execution is interrupted" — test/mini/stream-v2.subagent.test.ts:344 | `expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "cancelled" }])` |
| "keeps a backgrounded child running when the parent execution is interrupted" — test/mini/stream-v2.subagent.test.ts:366 | `expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "running", background: true }])` |
| "admits a new subagent once the family cap is already full" — test/mini/stream-v2.subagent.test.ts:426 | `expect(states().at(-1)?.tabs).toHaveLength(CAP)` |
| "never evicts a running child while settled children remain" — test/mini/stream-v2.subagent.test.ts:447 | `expect(tabs).toHaveLength(CAP)` |
| "grows past the cap rather than dropping a live child when every entry is running" — test/mini/stream-v2.subagent.test.ts:475 | `expect(states().at(-1)?.tabs).toHaveLength(CAP)` |
| "keeps the selected child when the cap sheds a settled entry" — test/mini/stream-v2.subagent.test.ts:497 | `expect(tabs).toHaveLength(CAP)` |
| "discovers an indirect child at the cap by shedding a settled entry" — test/mini/stream-v2.subagent.test.ts:517 | `expect(states().at(-1)?.tabs).toHaveLength(CAP)` |
| "skips discovery at the cap when every entry is running" — test/mini/stream-v2.subagent.test.ts:540 | `expect(states().at(-1)?.tabs).toHaveLength(CAP)` |

### test/mini/stream-v2.transport.test.ts (47 declarations/groups, 3557 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "recursively hydrates blockers for direct and transitive descendants" — test/mini/stream-v2.transport.test.ts:205 | `expect(snapshots.at(-1)?.tabs.map((item) => item.sessionID)).toEqual(["ses_child", "ses_grandchild"])` |
| "resolves a pre-existing child permission from its exact source message at startup" — test/mini/stream-v2.transport.test.ts:246 | `expect(client.session.message).toHaveBeenCalledWith(` |
| "reduces nested form owners idempotently and filters global events by complete location" — test/mini/stream-v2.transport.test.ts:342 | `expect(childSnapshots.at(-1)?.forms.filter((item) => item.id === child.id)).toHaveLength(1)` |
| "finalizes an idle projection before reducing live output" — test/mini/stream-v2.transport.test.ts:426 | `expect(ui.commits.map((item) => item.text)).toEqual(["[Link](https://example.com)"])` |
| "sends initial files and local mentions as URI-only structured prompt files" — test/mini/stream-v2.transport.test.ts:506 | `expect(request?.text).toBe("Review @note.ts and @docs")` |
| "sends attached file mentions as structured prompt files without reading them" — test/mini/stream-v2.transport.test.ts:601 | `expect(remoteRead).not.toHaveBeenCalled()` |
| "sends local media mentions as structured prompt files" — test/mini/stream-v2.transport.test.ts:688 | `expect(request?.text).toBe("Review @diagram.png")` |
| "shows V2 blockers and replies through the runtime-owned session API" — test/mini/stream-v2.transport.test.ts:762 | `expect(ui.events).toContainEqual({` |
| "rebootstraps after disconnect and completes a promoted turn from idle active state" — test/mini/stream-v2.transport.test.ts:796 | `expect(ui.events).toContainEqual({ type: "stream.patch", patch: { phase: "running", status: "reconnecting" } })` |
| "does not duplicate the optimistic user row when reconnect hydration recovers a missed prompt" — test/mini/stream-v2.transport.test.ts:862 | `expect(ui.commits.filter((item) => item.kind === "user" && item.messageID === "msg_prompt")).toHaveLength(1)` |
| "replaces the client for buffered hydration, descendants, turns, and interrupts" — test/mini/stream-v2.transport.test.ts:928 | `expect(resized).toBe(false)` |
| "reconciles buffered deltas already present in a resize snapshot" — test/mini/stream-v2.transport.test.ts:1097 | `expect(ui.commits.filter((item) => item.text === "the answer")).toHaveLength(1)` |
| "replays live assistant text missing from the resize projection" — test/mini/stream-v2.transport.test.ts:1160 | `expect(live.map((commit) => commit.text)).toEqual(["partial suffix"])` |
| "does not replay a resize-buffered suffix twice" — test/mini/stream-v2.transport.test.ts:1227 | `expect(ui.commits.filter((commit) => commit.messageID === "msg_assistant").map((commit) => commit.text)).toEqual([` |
| "preserves active text and reasoning across resize before terminal projection" — test/mini/stream-v2.transport.test.ts:1288 | `expect(live.map((commit) => commit.text)).toEqual(["hello", "Thinking: thought"])` |
| "serializes and coalesces overlapping resize replays" — test/mini/stream-v2.transport.test.ts:1337 | `expect(second).toBe(first)` |
| "restores local output and drains buffered events when resize hydration fails" — test/mini/stream-v2.transport.test.ts:1377 | `expect(replay).rejects.toThrow("projection failed")` |
| "dedupes a projected step failure from live redelivery" — test/mini/stream-v2.transport.test.ts:1427 | `expect(ui.commits.filter((commit) => commit.kind === "error" && commit.text === "provider failed")).toHaveLength(1)` |
| "dedupes a retained live step failure from resize projection" — test/mini/stream-v2.transport.test.ts:1472 | `expect(live[0]?.messageID).toBe("msg_assistant")` |
| "preserves an execution-only local error beside its projected prompt" — test/mini/stream-v2.transport.test.ts:1525 | `expect(ui.commits.some((commit) => commit.kind === "error" && commit.text === "model unavailable")).toBe(true)` |
| "scopes text and reasoning ordinals by assistant message" — test/mini/stream-v2.transport.test.ts:1572 | `expect(ui.commits.map((item) => item.text)).toEqual([` |
| "renders full reasoning when only the ended event is observed" — test/mini/stream-v2.transport.test.ts:1624 | `expect(ui.commits.at(-1)?.text).toBe("Thinking: considering")` |
| "tracks repeated root call IDs independently across assistant messages" — test/mini/stream-v2.transport.test.ts:1653 | `expect(commits.map((item) => [item.messageID, item.phase])).toEqual([` |
| "reduces root tool progress and preserves it on failure" — test/mini/stream-v2.transport.test.ts:1718 | `expect(commits.map((item) => [item.phase, item.text, item.toolState])).toEqual([` |
| "resolves an interrupted turn even when promotion never arrived" — test/mini/stream-v2.transport.test.ts:1796 | `expect(interrupted).toHaveBeenCalledWith({ sessionID: "ses_1" })` |
| "falls back to the default model when selecting a variant on a fresh session" — test/mini/stream-v2.transport.test.ts:1842 | `expect(switched).toHaveBeenCalledWith(` |
| "interrupts the current Session when an active turn is aborted" — test/mini/stream-v2.transport.test.ts:1905 | `expect(interrupted).toHaveBeenCalledWith({ sessionID: "ses_1" })` |
| "runs a shell turn through v2.session.shell and renders live output" — test/mini/stream-v2.transport.test.ts:1960 | `expect(request).toMatchObject({ sessionID: "ses_1", command: "ls", id: expect.stringMatching(/^evt_/) })` |
| "aborts an active shell turn without interrupting the session" — test/mini/stream-v2.transport.test.ts:2052 | `expect(aborted).toBe(true)` |
| "does not resolve an owned shell output wait from an unrelated shell" — test/mini/stream-v2.transport.test.ts:2094 | `expect(done).toBe(false)` |
| "hydrates projected shell transcripts once and dedupes live redelivery" — test/mini/stream-v2.transport.test.ts:2220 | `expect(ui.commits.filter((item) => item.shell)).toMatchObject([` |
| "renders failed projected shells as errors and marks truncated live output" — test/mini/stream-v2.transport.test.ts:2282 | `expect(ui.commits).toContainEqual(` |
| "routes command prompts through v2.session.command" — test/mini/stream-v2.transport.test.ts:2359 | `expect(request).toMatchObject({` |
| "routes skill prompts through v2.session.skill and settles without promotion" — test/mini/stream-v2.transport.test.ts:2447 | `expect(request).toMatchObject({ sessionID: "ses_1", id: "msg_skill", skill: "tigerstyle" })` |
| "does not resolve a skill turn before the matching activation is observed" — test/mini/stream-v2.transport.test.ts:2510 | `expect(done).toBe(false)` |
| "refreshes catalogs on connection and location-scoped invalidations" — test/mini/stream-v2.transport.test.ts:2594 | `expect(refreshes).toBe(1)` |
| "hydrates skill activation messages once and dedupes live redelivery" — test/mini/stream-v2.transport.test.ts:2649 | `expect(ui.commits.filter((item) => item.text === '→ Skill "tigerstyle"')).toHaveLength(1)` |
| "discovers current subagents from progress and reduces descendant tool state" — test/mini/stream-v2.transport.test.ts:2694 | `expect(states().at(-1)?.tabs).toMatchObject([` |
| "discovers a live child session and tracks its tab and selected detail" — test/mini/stream-v2.transport.test.ts:2862 | `expect(states().at(-1)?.tabs).toMatchObject([` |
| "reveals an admitted child prompt only when it is promoted after hydration" — test/mini/stream-v2.transport.test.ts:2981 | `No inline assertion; inspect called harness` |
| "preserves a pre-hydration admission promoted during stale hydration" — test/mini/stream-v2.transport.test.ts:3037 | `No inline assertion; inspect called harness` |
| "retries child hydration after a bounded live-event overflow" — test/mini/stream-v2.transport.test.ts:3101 | `expect(childRequests).toBe(2)` |
| "reconciles pre-hydration tool metadata without downgrading projected completion" — test/mini/stream-v2.transport.test.ts:3197 | `expect(commits.find((item) => item.partID === "prt_call_terminal")).toMatchObject({` |
| "keeps child terminal state observed during discovery" — test/mini/stream-v2.transport.test.ts:3312 | `No inline assertion; inspect called harness` |
| "does not resurrect a settled child from stale discovery buffer" — test/mini/stream-v2.transport.test.ts:3369 | `expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "cancelled" }])` |
| "adopts historical children from the session family list" — test/mini/stream-v2.transport.test.ts:3474 | `expect(client.session.list).toHaveBeenCalledWith(` |
| "hydrates completed subagent children from projected tool output" — test/mini/stream-v2.transport.test.ts:3508 | `expect(states.at(-1)?.tabs).toMatchObject([` |

### test/mini/stream.test.ts (2 declarations/groups, 53 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "defaults status patches to running phase" — test/mini/stream.test.ts:6 | `expect(out.events).toEqual([` |
| "delivers commits before ordered footer updates" — test/mini/stream.test.ts:30 | `expect(out.calls.map((call) => (call.type === "commit" ? "commit" : call.value.type))).toEqual([` |

### test/mini/theme.test.ts (8 declarations/groups, 168 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "falls back when palette lookup fails" — test/mini/theme.test.ts:62 | `expect(await resolveRunTheme(renderer({ fail: true }))).toBe(RUN_THEME_FALLBACK)` |
| "resolveTheme maps a current theme file to the Mini flat theme" — test/mini/theme.test.ts:66 | `expect(theme.primary).toBeInstanceOf(RGBA)` |
| "returns syntax styles and indexed splash colors" — test/mini/theme.test.ts:75 | `expect(theme.block.syntax).toBeDefined()` |
| "keeps footer surfaces exact while scrollback stays palette matched" — test/mini/theme.test.ts:93 | `expect(expectRgba(theme.footer.selected).toInts()).toEqual(expectRgba(exact.backgroundElement).toInts())` |
| "uses refreshed background brightness when cached renderer mode is stale" — test/mini/theme.test.ts:111 | `expect(expectRgba(stale.footer.surface).toInts()).toEqual(expectRgba(light.footer.surface).toInts())` |
| "keeps renderer mode when refreshed default background is unavailable" — test/mini/theme.test.ts:127 | `expect(expectRgba(light.footer.surface).toInts()).not.toEqual(expectRgba(dark.footer.surface).toInts())` |
| "keeps dark surfaces neutral on saturated backgrounds" — test/mini/theme.test.ts:144 | `expect(spread(theme.backgroundPanel)).toBeLessThan(10)` |
| "keeps light surfaces close to neutral on warm backgrounds" — test/mini/theme.test.ts:157 | `expect(spread(theme.backgroundPanel)).toBeLessThan(60)` |

### test/mini/tool.test.ts (4 declarations/groups, 97 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "uses V2 shell output without the model-facing status" — test/mini/tool.test.ts:5 | `No inline assertion; inspect called harness` |
| "normalizes only persisted tool aliases into current fields" — test/mini/tool.test.ts:21 | `No inline assertion; inspect called harness` |
| "keeps segment-safe contained tool paths relative" — test/mini/tool.test.ts:76 | `expect(toolPath("..cache/result.txt", { directory: "/work/project" })).toBe("..cache/result.txt")` |
| "labels completed skills as loaded" — test/mini/tool.test.ts:81 | `expect(toolInlineInfo(skill).title).toBe('Skill "review"  Loaded')` |

### test/mini/variant.shared.test.ts (8 declarations/groups, 86 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "prefers cli then session then saved variants" — test/mini/variant.shared.test.ts:25 | `expect(resolveVariant("max", "high", "low", ["low", "high"])).toBe("max")` |
| "drops a stored variant when the model offers no variants at all" — test/mini/variant.shared.test.ts:31 | `expect(resolveVariant(undefined, "high", "low", [])).toBeUndefined()` |
| "keeps stored variants while the catalog has not resolved the model yet" — test/mini/variant.shared.test.ts:36 | `expect(resolveVariant(undefined, "high", "low", undefined)).toBe("high")` |
| "keeps an explicit cli variant even when the catalog has not resolved variants" — test/mini/variant.shared.test.ts:41 | `expect(resolveVariant("max", undefined, undefined, undefined)).toBe("max")` |
| "cycles through variants and back to no variant" — test/mini/variant.shared.test.ts:46 | `expect(cycleVariant(undefined, ["low", "high"])).toBe("low")` |
| "cycles through an offered none variant and treats a catalog variant named default as an ordinary id" — test/mini/variant.shared.test.ts:53 | `expect(cycleVariant(undefined, ["none", "low", "high"])).toBe("none")` |
| "formats model labels" — test/mini/variant.shared.test.ts:67 | `expect(formatModelLabel(model, undefined)).toBe("gpt-5 · openai")` |
| "picks the latest matching variant from session history" — test/mini/variant.shared.test.ts:74 | `expect(pickVariant(model, session)).toBe("minimal")` |

### test/model-preference.test.ts (3 declarations/groups, 59 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "repairs known model preferences and preserves unrelated fields" — test/model-preference.test.ts:6 | `No inline assertion; inspect called harness` |
| "preserves named none and default variants as ordinary ids" — test/model-preference.test.ts:22 | `No inline assertion; inspect called harness` |
| "atomically serializes patches and variant updates" — test/model-preference.test.ts:36 | `expect(await Bun.file(file).json()).toEqual({` |

### test/notice-summary.test.ts (4 declarations/groups, 33 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "summarizes Session state" — test/notice-summary.test.ts:8 | `No inline assertion; inspect called harness` |
| "summarizes TeamView states" — test/notice-summary.test.ts:17 | `No inline assertion; inspect called harness` |
| "summarizes malformed framed JSON without details" — test/notice-summary.test.ts:26 | `expect(noticeSummary("session-state", '${sessionPrefix}{broken')).toBe("Session state · unavailable")` |
| "ignores unrecognized source framing" — test/notice-summary.test.ts:30 | `expect(noticeSummary("other", '${teamViewPrefix}{"children":[]}')).toBeUndefined()` |

### test/permission-autonomy-only.test.tsx (1 declarations/groups, 60 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "legacy local auto state cannot approve a permission outside durable autonomy" — test/permission-autonomy-only.test.tsx:6 | `expect(screen.frame()).toContain("Permission required")` |

### test/permission-surface.test.tsx (3 declarations/groups, 199 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "surfaces a subagent's own pending permission in the subagent view" — test/permission-surface.test.tsx:134 | `expect(screen.frame()).toContain("atlassian-rovo_updateConfluenceContent")` |
| "surfaces a live subagent permission in the subagent view" — test/permission-surface.test.tsx:154 | `No inline assertion; inspect called harness` |
| "shows the download side-effect warning on selected Chrome site approval" — test/permission-surface.test.tsx:177 | `expect(screen.frame()).toContain("example.test")` |

### test/plugin/context.test.tsx (1 declarations/groups, 112 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "active production plugin contexts follow a managed-service client replacement" — test/plugin/context.test.tsx:19 | `expect(context.client).toBe(initial)` |

### test/plugin/runtime.test.ts (2 declarations/groups, 50 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "routes use the latest registration and restore previous registrations" — test/plugin/runtime.test.ts:4 | `expect(runtime.routes.get("demo")).toBe(second)` |
| "facade publishes and clears presentation state" — test/plugin/runtime.test.ts:16 | `expect(await runtime.commands().activate("demo")).toBe(true)` |

### test/plugin/slots.test.tsx (1 declarations/groups, 38 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "replace slot mounts plugin content once" — test/plugin/slots.test.tsx:10 | `expect(mounts).toBe(1)` |

### test/project-artifacts.test.ts (6 declarations/groups, 143 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "filters by scope, kind, and stage without changing server order" — test/project-artifacts.test.ts:53 | `expect(filterArtifacts(artifacts, { scope: "project", kind: "all", stage: "all" })).toEqual(artifacts.slice(0, 2))` |
| "uses stable kind categories and concise descriptions" — test/project-artifacts.test.ts:58 | `expect(artifactCategory(artifacts[0])).toBe("Skills")` |
| "limits unsupported plugins to no lifecycle or promotion actions" — test/project-artifacts.test.ts:64 | `expect(artifactActions({ scope: "global", kind: "plugin", stage: "quarantine", versions: 2 })).toEqual({` |
| "limits shadow previews to an exact project-over-global collision" — test/project-artifacts.test.ts:87 | `No inline assertion; inspect called harness` |
| "renders confirmation-token expiry for shadow previews" — test/project-artifacts.test.ts:114 | `expect(confirmationPreviewLines({ expiresAt: 1_700_000_000_000 })).toEqual(["Expires: 2023-11-14T22:13:20.000Z"])` |
| "renders every available promotion preview safety field before confirmation" — test/project-artifacts.test.ts:118 | `No inline assertion; inspect called harness` |

### test/prompt-paste.test.tsx (4 declarations/groups, 190 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "attaches a clipboard image from ctrl+v" — test/prompt-paste.test.tsx:115 | `No inline assertion; inspect called harness` |
| "attaches a clipboard image when an image-only clipboard arrives as an empty bracketed paste" — test/prompt-paste.test.tsx:133 | `No inline assertion; inspect called harness` |
| "attaches a clipboard image from super+v" — test/prompt-paste.test.tsx:151 | `No inline assertion; inspect called harness` |
| "attaches an image from a pasted file path" — test/prompt-paste.test.tsx:173 | `expect(screen.frame()).not.toContain("pasted-image.png")` |

### test/prompt/autocomplete.test.ts (11 declarations/groups, 128 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "lists directories before files while preserving backend ranking" — test/prompt/autocomplete.test.ts:23 | `expect(merged.map((item) => item.path)).toEqual([` |
| "keeps folders visible even when the file search fills every slot" — test/prompt/autocomplete.test.ts:43 | `expect(merged[0]?.path).toBe("packages/tui/")` |
| "caps folders so file results always keep slots" — test/prompt/autocomplete.test.ts:50 | `expect(merged.filter((item) => item.type === "directory")).toHaveLength(MENTION_DIRECTORY_LIMIT)` |
| "keeps a single row when both searches return the same path" — test/prompt/autocomplete.test.ts:57 | `expect(merged.map((item) => item.path)).toEqual(["src/", "src/app.ts"])` |
| "still returns results when one of the two searches came back empty" — test/prompt/autocomplete.test.ts:69 | `expect(mergeFileSearchEntries([], files(3)).map((item) => item.path)).toEqual([` |
| "keeps every returned agent and file result reachable" — test/prompt/autocomplete.test.ts:80 | `expect(merged.filter((item) => item.display.startsWith("file-"))).toHaveLength(20)` |
| "leaves command and skill lists untouched when there are no file results" — test/prompt/autocomplete.test.ts:91 | `expect(mergeAutocompleteOptions(nonFiles, [])).toHaveLength(9)` |
| "keeps the highlighted row inside the current option list" — test/prompt/autocomplete.test.ts:98 | `expect(clampAutocompleteIndex(7, 3)).toBe(2)` |
| "keeps only the selected viewport resident while preserving option indexes" — test/prompt/autocomplete.test.ts:107 | `expect(autocompleteWindow(options, 0, 10)).toEqual({ start: 0, options: options.slice(0, 10) })` |
| "does not double the trailing separator for directory entries" — test/prompt/autocomplete.test.ts:117 | `expect(expandDirectoryQuery("packages/tui/")).toBe("packages/tui/")` |
| "normalizes the platform separator the search backend appends" — test/prompt/autocomplete.test.ts:124 | `expect(expandDirectoryQuery("packages/tui\\")).toBe("packages/tui/")` |

### test/prompt/autocomplete.test.tsx (3 declarations/groups, 173 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders skills and agents with inline conflict markers above the footer at 80 columns" — test/prompt/autocomplete.test.tsx:126 | `expect(output).toContain("danger · conflict")` |
| "keeps every %s option reachable beyond the visible rows" — test/prompt/autocomplete.test.tsx:139 (table) | `expect(output).not.toContain(trigger === "@" ? "agent-59" : "skill-59")` |
| "resets to the first row when switching triggers with the same empty query" — test/prompt/autocomplete.test.tsx:157 | `expect(frame(app)).not.toContain("skill-0 ")` |

### test/prompt/codec.test.ts (2 declarations/groups, 53 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "projects durable managed attachments to opaque attachment URIs without mutation" — test/prompt/codec.test.ts:5 | `expect(output).toEqual({` |
| "retains empty attachment keys for editable prompt replacement" — test/prompt/codec.test.ts:46 | `expect(projectedPromptInput({ text: "plain" })).toEqual({` |

### test/prompt/display.test.ts (5 declarations/groups, 75 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "uses display-width offsets for mentions" — test/prompt/display.test.ts:12 | `expect(mentionTriggerIndex("@")).toBe(0)` |
| "recognizes triggers after opening punctuation" — test/prompt/display.test.ts:41 | `expect(mentionTriggerIndex("see (@src")).toBe(5)` |
| "recognizes skill triggers only at token boundaries" — test/prompt/display.test.ts:53 | `expect(skillTriggerIndex("$review")).toBe(0)` |
| "revalidates mention and skill menus from the cursor" — test/prompt/display.test.ts:61 | `expect(autocompleteTriggerIndex("$skill", 6, "$")).toBe(0)` |
| "defaults omitted palette visibility while preserving explicit hidden values" — test/prompt/display.test.ts:69 | `expect(promptCommandPalette({})).toBe(true)` |

### test/prompt/history-provider.test.tsx (2 declarations/groups, 80 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "down rejects at the newest history item with an empty prompt" — test/prompt/history-provider.test.tsx:10 | `expect(history!.move(1, "")).toBeUndefined()` |
| "canonical history reconciliation preserves dispatch order when receipts settle in reverse order" — test/prompt/history-provider.test.tsx:40 | `expect(settleFirst).toBeDefined()` |

### test/prompt/history.test.ts (6 declarations/groups, 65 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "recovers valid JSONL entries around corruption" — test/prompt/history.test.ts:12 | `expect(parsePromptHistory('${JSON.stringify(entry("one"))}\nnot-json\n${JSON.stringify(entry("two"))}\n')).toEqual([` |
| "ignores the legacy parts shape" — test/prompt/history.test.ts:19 | `expect(parsePromptHistory(JSON.stringify({ input: "old", parts: [] }))).toEqual([])` |
| "retains only the newest entries" — test/prompt/history.test.ts:23 | `expect(result).toHaveLength(MAX_HISTORY_ENTRIES)` |
| "dedupes only identical consecutive entries" — test/prompt/history.test.ts:32 | `expect(isDuplicateEntry(undefined, entry("hello"))).toBe(false)` |
| "does not dedupe entries with different attachments" — test/prompt/history.test.ts:39 | `expect(isDuplicateEntry(a, b)).toBe(false)` |
| "strips legacy data attachments while preserving URI attachments and prompt text" — test/prompt/history.test.ts:45 | `expect(parsed).toEqual([` |

### test/prompt/jsonl.test.ts (3 declarations/groups, 45 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "stash JSONL skips corruption and retains newest entries" — test/prompt/jsonl.test.ts:5 | `expect(result).toHaveLength(MAX_STASH_ENTRIES)` |
| "stash JSONL strips legacy data attachments and preserves managed refs" — test/prompt/jsonl.test.ts:15 | `expect(result[0]?.prompt.files).toEqual([{ uri: managed, name: "managed.pdf" }])` |
| "frecency JSONL skips corruption, keeps latest path state, and limits entries" — test/prompt/jsonl.test.ts:36 | `expect(result).toHaveLength(MAX_FRECENCY_ENTRIES)` |

### test/prompt/local-attachment.test.ts (4 declarations/groups, 98 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "DOC-001 preserves image, PDF, SVG, and Excel files as file URIs without reading content" — test/prompt/local-attachment.test.ts:15 | `expect(await readLocalAttachmentWith(localFiles, file)).toEqual(expected)` |
| "preserves SVG attachments as URI metadata" — test/prompt/local-attachment.test.ts:76 | `expect(await readLocalAttachmentWith(files({ mime: "image/svg+xml", text: "<svg />" }), "/tmp/image.svg")).toEqual({` |
| "preserves PDF attachments as URI metadata" — test/prompt/local-attachment.test.ts:85 | `expect(await readLocalAttachmentWith(files({ mime: "application/pdf" }), "/tmp/file.pdf")).toEqual({` |
| "ignores unsupported and unreadable local files" — test/prompt/local-attachment.test.ts:94 | `expect(await readLocalAttachmentWith(files({ mime: "text/plain" }), "/tmp/file.txt")).toBeUndefined()` |

### test/prompt/mention.test.ts (3 declarations/groups, 91 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "realigns reordered, duplicate, deleted, and prefix-related mentions" — test/prompt/mention.test.ts:9 | `expect(realignPromptMentions("@two @same @one @same", mentions)).toEqual([` |
| "realigns mixed prompt attachments without mutation" — test/prompt/mention.test.ts:52 | `expect(output).toEqual({` |
| "shifts mention hints when pasted placeholders expand" — test/prompt/mention.test.ts:77 | `expect(expanded.files?.[0]?.mention).toEqual({ start: 33, end: 38, text: "@same" })` |

### test/prompt/parse.test.ts (2 declarations/groups, 24 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "preserves file line-range parsing semantics" — test/prompt/parse.test.ts:4 | `expect([` |
| "keeps frontend-specific slash separators" — test/prompt/parse.test.ts:20 | `expect(parseSlashHead("/editor\rfirst")).toEqual({ name: "editor\rfirst", arguments: "", end: 13 })` |

### test/prompt/part.test.ts (2 declarations/groups, 34 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "preserves wide characters around pasted text" — test/prompt/part.test.ts:5 | `No inline assertion; inspect called harness` |
| "only expands the tracked placeholder occurrence" — test/prompt/part.test.ts:20 | `No inline assertion; inspect called harness` |

### test/prompt/persistence.test.ts (1 declarations/groups, 23 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "persistence creates parent directories and supports text, append, and JSON" — test/prompt/persistence.test.ts:7 | `expect(await readText(textPath)).toBe("one\ntwo\n")` |

### test/prompt/skill.test.ts (11 declarations/groups, 157 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "keeps only valid selected skill metadata" — test/prompt/skill.test.ts:7 | `No inline assertion; inspect called harness` |
| "replaces only selected skill tokens" — test/prompt/skill.test.ts:17 | `No inline assertion; inspect called harness` |
| "replaces selected skill IDs with punctuation and spaces at token boundaries" — test/prompt/skill.test.ts:27 | `No inline assertion; inspect called harness` |
| "matches the longest selected ID and leaves unselected dollar text unchanged" — test/prompt/skill.test.ts:42 | `No inline assertion; inspect called harness` |
| "resolves typed skill mentions against the available skills" — test/prompt/skill.test.ts:56 | `No inline assertion; inspect called harness` |
| "preserves typed $skill admission order" — test/prompt/skill.test.ts:69 | `No inline assertion; inspect called harness` |
| "keeps menu-selected skills that no longer match a text mention" — test/prompt/skill.test.ts:81 | `No inline assertion; inspect called harness` |
| "accepts historical prompt entries without skills" — test/prompt/skill.test.ts:100 | `expect(parsePromptInfo({ text: "Existing prompt", pasted: [] })).toEqual({ text: "Existing prompt", pasted: [] })` |
| "settles admission before waking the prompt" — test/prompt/skill.test.ts:104 | `expect(calls).toEqual(["prompt:admit"])` |
| "returns the first durable admission and supplies it to the exact wake retry" — test/prompt/skill.test.ts:122 | `expect(result).toEqual({ admitted })` |
| "captures the durable admission before a failed wake settles" — test/prompt/skill.test.ts:140 | `expect(captured).toEqual([admitted])` |

### test/prompt/submission.test.ts (11 declarations/groups, 521 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "a correlated admission event settles the owned request before its HTTP response without skill RPCs" — test/prompt/submission.test.ts:88 | `expect(flow.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(1)` |
| "a failed standalone skill remains owned and retries its stable ID without admitting a prompt" — test/prompt/submission.test.ts:119 | `expect(flow.requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(0)` |
| "admission status %i preserves a distinct recovery outcome" — test/prompt/submission.test.ts:147 (table) | `expect(flow.manager.list()[0]?.phase).toBe(phase)` |
| "model switch failure pauses only its Session and prevents accidental admission or wake" — test/prompt/submission.test.ts:178 | `expect(flow.requests.filter((request) => request.path === '/api/session/${first.sessionID}/prompt')).toHaveLength(0)` |
| "late admission reconciles an unknown response, and retry after failed wake never reactivates or readmits" — test/prompt/submission.test.ts:220 | `expect(flow.manager.list()[0]?.state).toBe("attention")` |
| "reconnect pending snapshot resolves admission without replay; consumed snapshot requires no wake" — test/prompt/submission.test.ts:257 | `expect(flow.manager.list()).toHaveLength(0)` |
| "agent reselection on retry preserves prompt identity without client skill activation" — test/prompt/submission.test.ts:286 | `expect(skillIDs).toHaveLength(0)` |
| "managed attachments survive a failed wake without replaying admission or repeating cleanup" — test/prompt/submission.test.ts:328 | `expect(cleanups).toBe(1)` |
| "consumed snapshot retires a still-pending admission despite a later failure and releases the next send" — test/prompt/submission.test.ts:378 | `expect(flow.manager.list()).toHaveLength(0)` |
| "pre-admission retry restores the chosen model only when it drifted: %s" — test/prompt/submission.test.ts:423 (table) | `expect(model).toEqual(item.payload.model)` |
| "command failure retries the same admission ID and wake retry uses its canonical receipt without command reevaluation" — test/prompt/submission.test.ts:462 | `expect(requests.map((request) => request.endpoint)).toEqual(["model", "command"])` |

### test/prompt/traits.test.ts (3 declarations/groups, 25 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "normal mode without autocomplete only captures tab" — test/prompt/traits.test.ts:5 | `expect(traits.capture).toEqual(["tab"])` |
| "normal mode with autocomplete captures navigation keys" — test/prompt/traits.test.ts:12 | `expect(traits.capture).toEqual(["escape", "navigate", "submit", "tab"])` |
| "shell mode disables capture and labels the prompt without suspending" — test/prompt/traits.test.ts:19 | `expect(traits.capture).toBeUndefined()` |

### test/prompt/yolo-hint.test.tsx (1 declarations/groups, 45 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders the restored disable-YOLO composer hint" — test/prompt/yolo-hint.test.tsx:22 | `expect(app.captureCharFrame()).toContain("⌃x y disable YOLO")` |

### test/provider-refresh-command.test.ts (1 declarations/groups, 71 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "the command palette refreshes models and providers for the current location" — test/provider-refresh-command.test.ts:8 | `expect(setup.captureCharFrame()).toContain("Refresh models and providers")` |

### test/provider-usage-aic.test.tsx (1 declarations/groups, 79 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders backend model tokens and costs without local model-price conversions" — test/provider-usage-aic.test.tsx:9 | `expect(frame).toContain("github-copilot/claude-sonnet-5")` |

### test/provider-usage-design.test.tsx (4 declarations/groups, 237 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders an unreported cache read as a word instead of a bare placeholder" — test/provider-usage-design.test.tsx:47 | `expect(frame).toContain("Unknown/300")` |
| "renders approved Overview geometry and complete metrics at $width×$height" — test/provider-usage-design.test.tsx:65 (table) | `expect(lines).toHaveLength(height + 1)` |
| "sorts complete overview model rows client-side and keeps Total pinned" — test/provider-usage-design.test.tsx:133 | `expect(lines.findIndex((line) => line.trimStart().startsWith("Total"))).toBeLessThan(lines.findIndex((line) => line.includes("openrouter/")))` |
| "renders direct Models navigation and a full-width selected table row at $width×$height" — test/provider-usage-design.test.tsx:170 (table) | `expect(lines).toHaveLength(height + 1)` |

### test/provider-usage-direct-views.test.tsx (3 declarations/groups, 354 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "cycles ten direct views by arrows and tabs and opens views by mouse" — test/provider-usage-direct-views.test.tsx:138 | `expect(frame).not.toContain("1 Overview")` |
| "requests server sorting before bounded pagination and gives selection, details, and escape precedence" — test/provider-usage-direct-views.test.tsx:184 | `expect(calls.map((call) => ({ group: call.group, offset: call.offset, limit: call.limit, sort: call.sort, order: call.order }))).toEqual([` |
| "derives a full-width colored Stats graph and summary from daily, model, and session reports" — test/provider-usage-direct-views.test.tsx:279 | `expect(lines[row("Tue")].trimEnd()).toHaveLength(origin + 52 * 3)` |

### test/provider-usage-reports.test.tsx (7 declarations/groups, 375 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "defaults tables to all retained history and exposes normalized metrics plus explicit custom dates" — test/provider-usage-reports.test.tsx:112 | `expect(calls[0]).toEqual({ group: "model", offset: 0, limit: 100, sort: "tokens", order: "desc" })` |
| "preserves selected identity on refresh and fences stale, failed, and changed-query results" — test/provider-usage-reports.test.tsx:168 | `expect(app.captureCharFrame()).not.toContain("Stale result")` |
| "sorts every report metric from its column header and keyboard bindings" — test/provider-usage-reports.test.tsx:214 | `expect(app.captureCharFrame().split("\n")[headerY]).toContain("INPUT ▼")` |
| "removes the retention remark while preserving the empty-window message" — test/provider-usage-reports.test.tsx:251 | `expect(frame).not.toContain("Usage before")` |
| "pages bounded rows and keeps keyboard or mouse selection visible without a permanent detail block" — test/provider-usage-reports.test.tsx:278 | `expect(frame.split("\n").every((line) => line.length <= 80)).toBe(true)` |
| "invalidates late report work when the screen unmounts" — test/provider-usage-reports.test.tsx:330 | `No inline assertion; inspect called harness` |
| "keeps large-value rows on one line with compact token columns" — test/provider-usage-reports.test.tsx:345 | `expect(lines.every((line) => line.length <= 189)).toBe(true)` |

### test/provider-usage-screen-interaction.test.tsx (3 declarations/groups, 338 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "opens provider usage without submitting a draft and returns by keyboard or mouse" — test/provider-usage-screen-interaction.test.tsx:191 | `expect(screen.frame()).toContain("keep this draft")` |
| "keeps the failed Overview free of scrollbar strips and makes padded navigation cells clickable" — test/provider-usage-screen-interaction.test.tsx:232 | `expect(screen.scrollbox()?.horizontalScrollBar.visible).toBe(false)` |
| "uses Tokscale-style keyboard navigation through the real Usage route at %i columns" — test/provider-usage-screen-interaction.test.tsx:264 (table) | `expect(reportCalls.at(-1)?.get("group")).toBe(group)` |

### test/remote-connector.test.tsx (3 declarations/groups, 147 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "the one remote row shows colored server states even when highlighted" — test/remote-connector.test.tsx:61 | `expect(view.commands().filter((command) => command.id?.startsWith("remote.")).map((command) => command.title)).toEqual(["Remote connection"])` |
| "palette selection toggles the shared server switch in both directions" — test/remote-connector.test.tsx:90 | `expect(server.writes).toEqual([true, false])` |
| "two TUIs display one server state and reflect the other's switch within a probe" — test/remote-connector.test.tsx:112 | `expect(app.captureCharFrame()).toContain("second: on")` |

### test/runtime.test.tsx (2 declarations/groups, 37 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "abbreviates paths within home boundaries" — test/runtime.test.tsx:6 | `expect(abbreviateHome("/home/test", "/home/test")).toBe("~")` |
| "provides focused immutable runtime inputs" — test/runtime.test.tsx:13 | `expect(app.captureCharFrame()).toContain("/work")` |

### test/screen/blocked-subagent-capture.test.tsx (1 declarations/groups, 134 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures the product blocked-subagent screen at reference dimensions" — test/screen/blocked-subagent-capture.test.tsx:27 | `expect(rows).toHaveLength(viewport.height)` |

### test/screen/captured-child-recovery.screen.test.tsx (6 declarations/groups, 399 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "keeps partial child successes, labels only the affected prompt incomplete, and explicitly retries failed reads" — test/screen/captured-child-recovery.screen.test.tsx:232 | `expect(screen.frame()).toContain("Captured changes 1 file")` |
| "retries on the failed child's task update and coalesces duplicate updates while preserving successful reads" — test/screen/captured-child-recovery.screen.test.tsx:265 | `expect(state.reads(childIDs[1])).toBe(initialReads[1])` |
| "shows an incomplete placeholder when no completed file is yet known" — test/screen/captured-child-recovery.screen.test.tsx:300 | `expect(screen.frame()).toContain("Retry child changes")` |
| "keyboard command retries failed captured reads in a narrow Session without refetching successes" — test/screen/captured-child-recovery.screen.test.tsx:313 | `expect(screen.frame()).toContain("Retry captured changes")` |
| "healthy %s live edits update a collapsed summary before toggling and toggling fetches nothing" — test/screen/captured-child-recovery.screen.test.tsx:342 (table) | `expect(screen.frame()).not.toContain("src/three.ts")` |
| "reopens a Session whose captured transcript is still resident without crashing" — test/screen/captured-child-recovery.screen.test.tsx:382 | `expect(screen.frame()).not.toContain("YCoding crashed")` |

### test/screen/chrome-capture.test.tsx (1 declarations/groups, 121 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures the product chrome variants at canonical terminal dimensions" — test/screen/chrome-capture.test.tsx:27 | `expect(rows).toHaveLength(viewport.height)` |

### test/screen/daybreak-command.test.tsx (16 declarations/groups, 591 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "toggles Daybreak from the landing palette and slash command without creating a Session" — test/screen/daybreak-command.test.tsx:267 | `expect(screen.frame()).toContain("What should we build?")` |
| "saves landing Daybreak before the first prompt and rehydrates its Session indicator" — test/screen/daybreak-command.test.tsx:290 | `expect(mutations).toEqual(["create", "daybreak", "admit", "wake"])` |
| "retains the landing draft and retries the same Session when saving Daybreak fails" — test/screen/daybreak-command.test.tsx:316 | `expect(screen.frame()).toContain("Check the application")` |
| "rejects unsupported landing Daybreak without starting a Session" — test/screen/daybreak-command.test.tsx:348 | `expect(screen.lines()[1]).not.toContain("Daybreak")` |
| "applies landing Daybreak before an explicit goal starts the new Session" — test/screen/daybreak-command.test.tsx:360 | `expect(mutations).toEqual(["create", "daybreak", "goal"])` |
| "does not activate a landing goal when Daybreak persistence fails" — test/screen/daybreak-command.test.tsx:381 | `expect(mutations).toEqual(["create", "daybreak"])` |
| "lists the Daybreak command in the palette with the Session's current state" — test/screen/daybreak-command.test.tsx:400 | `No inline assertion; inspect called harness` |
| "rehydrates and updates the header indicator from durable Daybreak state" — test/screen/daybreak-command.test.tsx:413 | `expect(screen.lines()[1]).toContain("openai/GPT 5.6 Terra · Daybreak Blue · high")` |
| "marks a saved Daybreak program inactive on a model that does not advertise it" — test/screen/daybreak-command.test.tsx:433 | `expect(screen.lines()[1]).toContain("openai/GPT 5.6 Terra · Daybreak Blue (inactive)")` |
| "keeps Daybreak inactive on unsupported models and providers, and restores it on the supported model" — test/screen/daybreak-command.test.tsx:444 | `expect(sessionDaybreak).toBe("daybreak_blue")` |
| "refreshes Daybreak activity when the account's advertised programs change" — test/screen/daybreak-command.test.tsx:470 | `expect(sessionDaybreak).toBe("daybreak_blue")` |
| "cycles off → blue → red → off across the advertised programs" — test/screen/daybreak-command.test.tsx:500 | `expect(daybreakSets).toEqual([{ daybreak: "daybreak_blue" }])` |
| "cycles a red-only model off → red → off" — test/screen/daybreak-command.test.tsx:532 | `expect(daybreakSets).toEqual([{ daybreak: "daybreak_red" }])` |
| "reports Daybreak as unavailable when the model advertises no program" — test/screen/daybreak-command.test.tsx:553 | `expect(daybreakSets).toEqual([])` |
| "rejects an explicit program the active model does not advertise" — test/screen/daybreak-command.test.tsx:565 | `expect(daybreakSets).toEqual([])` |
| "clears the program with an explicit off argument" — test/screen/daybreak-command.test.tsx:581 | `expect(daybreakSets).toEqual([{ daybreak: null }])` |

### test/screen/dialog-base-capture.test.tsx (1 declarations/groups, 158 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures canonical shared dialog fixtures at canonical and compact dimensions" — test/screen/dialog-base-capture.test.tsx:86 | `No inline assertion; inspect called harness` |

### test/screen/dialog-remaining-capture.test.tsx (2 declarations/groups, 384 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "the Connect integration menu opens the custom endpoint dialog" — test/screen/dialog-remaining-capture.test.tsx:114 | `expect(opened).toBe(true)` |
| "captures concrete remaining dialog fixtures at canonical terminal dimensions" — test/screen/dialog-remaining-capture.test.tsx:175 | `No inline assertion; inspect called harness` |

### test/screen/dialog-runtime-capture.test.tsx (2 declarations/groups, 305 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures runtime dialog frames at reference dimensions" — test/screen/dialog-runtime-capture.test.tsx:61 | `No inline assertion; inspect called harness` |
| "captures complete bounded command and edit reviews without nested scroll owners" — test/screen/dialog-runtime-capture.test.tsx:83 | `expect(app.captureCharFrame()).toContain(action === "guardrail" ? "Guardrail blocked" : "Permission required")` |

### test/screen/dialog-workspace-capture.test.tsx (1 declarations/groups, 263 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures workspace dialogs at reference terminal dimensions" — test/screen/dialog-workspace-capture.test.tsx:50 | `No inline assertion; inspect called harness` |

### test/screen/expanded-goal-yolo-capture.test.tsx (1 declarations/groups, 249 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures the expanded goal and YOLO session with populated rail fixtures" — test/screen/expanded-goal-yolo-capture.test.tsx:165 | `expect(screen.lines().some((line) => line.slice(railStart).includes('−  ${title}'))).toBe(true)` |

### test/screen/goal-command.test.tsx (13 declarations/groups, 563 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "replaces an active goal with the exact /goal text and never admits a prompt" — test/screen/goal-command.test.tsx:231 | `expect(autonomySets).toEqual([{ goal: "replace the migration plan" }])` |
| "clears the composer after an explicit /goal starts goal mode from normal" — test/screen/goal-command.test.tsx:247 | `expect(autonomySets).toEqual([{ goal: "finish product." }])` |
| `clears a goal draft after ${name} and steer events before the autonomy response` — test/screen/goal-command.test.tsx:270 | `expect(screen.frame()).not.toContain("/goal finish product.")` |
| "retains the goal draft after a failed PUT across a permission remount" — test/screen/goal-command.test.tsx:339 | `expect(screen.frame()).toContain("/goal finish product.")` |
| "creates a landing session and sets its goal with the returned session ID" — test/screen/goal-command.test.tsx:370 | `expect(landingCreates).toBe(1)` |
| "expands a tracked long paste after /goal and keeps the surrounding text" — test/screen/goal-command.test.tsx:387 | `expect(autonomySets).toEqual([{ goal: '${pasted} trailing context' }])` |
| "keeps the draft and attachment and reports an error when goal calculation fails" — test/screen/goal-command.test.tsx:407 | `expect(screen.frame()).toContain("replace the migration plan")` |
| "switches the selected variant before an explicit /goal activates its steer" — test/screen/goal-command.test.tsx:438 | `expect(modelSwitchStarted).toBe(false)` |
| "a rejected selected variant keeps /goal editable and does not activate a steer" — test/screen/goal-command.test.tsx:463 | `expect(switchRequests).toEqual([{ providerID: "openai", id: "gpt-5.6-terra", variant: "low" }])` |
| "stops an active goal on a bare /goal without admitting a prompt" — test/screen/goal-command.test.tsx:494 | `expect(autonomySets).toEqual([{ goal: null }])` |
| "resumes a retained goal on a bare /goal without synthesis or prompt admission" — test/screen/goal-command.test.tsx:510 | `expect(autonomySets).toEqual([{ goal: true }])` |
| "agrees with the composer branch when the slash menu selects the goal command" — test/screen/goal-command.test.tsx:526 | `expect(autonomySets).toEqual([{ goal: null }])` |
| "opens the explicit objective dialog when a bare /goal has no retained goal" — test/screen/goal-command.test.tsx:545 | `expect(autonomySets).toEqual([])` |

### test/screen/keep-awake-status.screen.test.tsx (2 declarations/groups, 97 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "the full TUI offers one Keep machine awake switch and lists its backend state in Status" — test/screen/keep-awake-status.screen.test.tsx:10 | `expect(screen.frame()).toContain("Keep machine awake")` |
| "Status remains Checking until the initial backend read reports On" — test/screen/keep-awake-status.screen.test.tsx:63 | `expect(screen.frame()).toContain(text)` |

### test/screen/landing-autonomy.screen.test.tsx (5 declarations/groups, 261 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "landing YOLO %d is durable before its first prompt and shown in chat" — test/screen/landing-autonomy.screen.test.tsx:116 (table) | `expect(backend.mutations).toEqual([])` |
| "explicit landing goal creates a Session with the displayed YOLO level before its first prompt" — test/screen/landing-autonomy.screen.test.tsx:152 | `expect(backend.mutations.slice(0, 2)).toEqual(["create", "autonomy"])` |
| "an autonomy-set failure retains the submitted input for receipt retry and prevents the first drain" — test/screen/landing-autonomy.screen.test.tsx:182 | `expect(backend.mutations).toEqual(["create", "autonomy"])` |
| "the landing palette cycles visible YOLO levels without creating a Session" — test/screen/landing-autonomy.screen.test.tsx:211 | `expect(backend.mutations).toEqual([])` |
| "a failed landing goal still carries its displayed YOLO level to the created Session" — test/screen/landing-autonomy.screen.test.tsx:237 | `expect(backend.mutations.slice(0, 3)).toEqual(["create", "autonomy", "autonomy"])` |

### test/screen/landing-design-match.test.tsx (2 declarations/groups, 93 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "matches the 189x69 landing measurements" — test/screen/landing-design-match.test.tsx:91 | `No inline assertion; inspect called harness` |
| "matches the 220x69 landing measurements" — test/screen/landing-design-match.test.tsx:92 | `No inline assertion; inspect called harness` |

### test/screen/landing.screen.test.tsx (3 declarations/groups, 175 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders the design composer, hero, footer, and hint row at 189x69" — test/screen/landing.screen.test.tsx:170 | `No inline assertion; inspect called harness` |
| "keeps the composer full-width at 220x69" — test/screen/landing.screen.test.tsx:172 | `No inline assertion; inspect called harness` |
| "keeps the landing composer structurally clean at 80x24" — test/screen/landing.screen.test.tsx:174 | `No inline assertion; inspect called harness` |

### test/screen/overlay-capture.test.tsx (1 declarations/groups, 237 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures deterministic overlay frames" — test/screen/overlay-capture.test.tsx:58 | `No inline assertion; inspect called harness` |

### test/screen/overlay-colour-probe.test.tsx (1 declarations/groups, 221 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "probes dialog, toast, and autocomplete colours at canonical viewports" — test/screen/overlay-colour-probe.test.tsx:67 | `No inline assertion; inspect called harness` |

### test/screen/prompt-recovery.screen.test.ts (11 declarations/groups, 659 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "dispatch releases the composer for a second send while the first acknowledgement is unresolved" — test/screen/prompt-recovery.screen.test.ts:254 | `expect(composer(screen.renderer.root)?.plainText).toBe("")` |
| "enhanced Enter release never submits a draft while an earlier send is pending" — test/screen/prompt-recovery.screen.test.ts:297 | `expect(composer(screen.renderer.root)?.plainText).toBe("not released as submit")` |
| "route disposal does not cancel owned transport or attach its late failure to the home draft" — test/screen/prompt-recovery.screen.test.ts:332 | `expect(composer(screen.renderer.root)?.plainText).toBe("new home draft")` |
| "direct skill metadata reaches admission without preactivation while the editor accepts another send" — test/screen/prompt-recovery.screen.test.ts:373 | `expect(composer(screen.renderer.root)?.plainText).toBe("")` |
| "every space-separated skill mention reaches prompt admission from the composer" — test/screen/prompt-recovery.screen.test.ts:413 | `expect(screen.frame()).toContain("$review $plan $review now")` |
| "a late admission failure retains the submitted input without erasing a new draft or queued send" — test/screen/prompt-recovery.screen.test.ts:437 | `expect(promptRequests).toHaveLength(1)` |
| "standalone skill loading stays owned while the real composer accepts a second draft" — test/screen/prompt-recovery.screen.test.ts:476 | `expect(composer(screen.renderer.root)?.plainText).toBe("")` |
| "receipt retry uses the retained prompt identity and leaves an editable draft untouched" — test/screen/prompt-recovery.screen.test.ts:508 | `expect(promptRequests).toHaveLength(1)` |
| "configured command admission releases editing and queues the next prompt without repeating command processing" — test/screen/prompt-recovery.screen.test.ts:536 | `expect(composer(screen.renderer.root)?.plainText).toBe("")` |
| "explicit local recovery discard releases a failed head without replaying it or erasing the new draft" — test/screen/prompt-recovery.screen.test.ts:575 | `expect(promptRequests.map((request) => request.text)).toEqual([` |
| "successful delayed clipboard admission reconciles recalled history to its managed attachment before cleanup" — test/screen/prompt-recovery.screen.test.ts:606 | `expect(composer(screen.renderer.root)?.plainText).toBe("")` |

### test/screen/remote-status.screen.test.tsx (1 declarations/groups, 72 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "the full TUI shows one server remote switch without a bottom remote line" — test/screen/remote-status.screen.test.tsx:10 | `expect(screen.frame()).not.toMatch(/remote (?:off&#124;on&#124;connecting&#124;error)/)` |

### test/screen/responsive-capture.test.tsx (2 declarations/groups, 253 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders the responsive rail placement bands" — test/screen/responsive-capture.test.tsx:41 | `expect(railPlacement(99)).toBe("hidden")` |
| "renders the shared dialog at the responsive width ladder" — test/screen/responsive-capture.test.tsx:83 | `expect(line?.indexOf("Responsive dialog")).toBe(Math.ceil((viewport.width - width) / 2) + 3)` |

### test/screen/route-capture.test.ts (1 declarations/groups, 372 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures composed routes at reference terminal dimensions" — test/screen/route-capture.test.ts:322 | `expect(lines).toHaveLength(HEIGHT)` |

### test/screen/screen-colour-probe.test.tsx (6 declarations/groups, 262 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "keeps the landing footer usage and command hints visible at narrow widths" — test/screen/screen-colour-probe.test.tsx:101 | `expect(footer).toContain("usage")` |
| "offers Chrome connection from the landing command palette" — test/screen/screen-colour-probe.test.tsx:114 | `expect(requests).toEqual(["create", "status"])` |
| "landing Chrome pairing reuses a Session in the current Location" — test/screen/screen-colour-probe.test.tsx:141 | `expect(requests).toEqual(["status"])` |
| "opens provider usage from the landing footer and returns home without creating a session" — test/screen/screen-colour-probe.test.tsx:165 | `expect(column).toBeGreaterThan(0)` |
| "probes the landing header and footer at canonical viewports" — test/screen/screen-colour-probe.test.tsx:192 | `expect(headerBand).not.toHaveLength(0)` |
| "probes the session rail at canonical viewports" — test/screen/screen-colour-probe.test.tsx:219 | `expect(railBand).not.toHaveLength(0)` |

### test/screen/session-chrome-design-match.test.tsx (5 declarations/groups, 317 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "matches the 189x69 chrome rows" — test/screen/session-chrome-design-match.test.tsx:293 | `No inline assertion; inspect called harness` |
| "matches the 220x69 chrome rows" — test/screen/session-chrome-design-match.test.tsx:294 | `No inline assertion; inspect called harness` |
| "fills the main column behind the composer at responsive widths" — test/screen/session-chrome-design-match.test.tsx:295 | `No inline assertion; inspect called harness` |
| "names the active profile after the agent in the header and not in the Context rail" — test/screen/session-chrome-design-match.test.tsx:299 | `No inline assertion; inspect called harness` |
| "paints a loaded agent's configured colour on the header agent segment" — test/screen/session-chrome-design-match.test.tsx:303 | `expect(screen.lines().some((line) => line.includes("GSD · anthropic/Claude Opus 5"))).toBe(true)` |

### test/screen/session-rail-design-match.test.tsx (2 declarations/groups, 184 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "matches the 189x69 rail measurements" — test/screen/session-rail-design-match.test.tsx:182 | `No inline assertion; inspect called harness` |
| "matches the 220x69 rail measurements" — test/screen/session-rail-design-match.test.tsx:183 | `No inline assertion; inspect called harness` |

### test/screen/session-retry-interrupt.screen.test.ts (1 declarations/groups, 88 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "an interrupted retry does not keep the header cooking" — test/screen/session-retry-interrupt.screen.test.ts:27 | `expect(screen.lines()[1]).toContain("retry")` |

### test/screen/session-running-status.screen.test.ts (1 declarations/groups, 66 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "a running session never reports ready" — test/screen/session-running-status.screen.test.ts:23 | `expect(header).toContain("cooking")` |

### test/screen/session-transcript-chat.test.tsx (1 declarations/groups, 328 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders typed transcript chat rows at the design gutter with safe expandable tool details" — test/screen/session-transcript-chat.test.tsx:223 | `expect(collapsed[assistantRow]?.indexOf("YCODING")).toBe(3)` |

### test/screen/session.screen.test.ts (1 declarations/groups, 201 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders the canonical header, transcript bubble, context rail, and section set" — test/screen/session.screen.test.ts:23 | `expect(frame).toContain("~/Workspace/Personal/YCoding")` |

### test/screen/shell-output-capture.test.tsx (2 declarations/groups, 143 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "shell-output route renders identity header, stream, metadata, and footer" — test/screen/shell-output-capture.test.tsx:51 | `expect(rows).toHaveLength(viewport.height)` |
| "shell-output route renders an exited shell without a kill action" — test/screen/shell-output-capture.test.tsx:93 | `expect(text).toContain("exited")` |

### test/screen/shells-capture.test.tsx (2 declarations/groups, 151 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "accepts shell-output route navigation" — test/screen/shells-capture.test.tsx:69 | `No inline assertion; inspect called harness` |
| "captures the Shell tab owner rows with populated groups" — test/screen/shells-capture.test.tsx:96 | `expect(frame).toContain("MAIN CHAT · THIS SESSION")` |

### test/screen/subagent-answer.screen.test.tsx (5 declarations/groups, 355 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "subagent answer Enter submits the owned question once, never a prompt or command" — test/screen/subagent-answer.screen.test.tsx:191 | `expect(state.writes).toEqual([` |
| "a rejected resolved question retains the answer for inspection and retry" — test/screen/subagent-answer.screen.test.tsx:230 | `expect(screen.frame()).toContain("Keep this answer")` |
| "parent shows the waiting child question on live update and reconnect without a permission request" — test/screen/subagent-answer.screen.test.tsx:251 | `expect(screen.frame()).toContain("awaiting input")` |
| "a cold parent at narrow width opens its waiting child to answer without queuing input" — test/screen/subagent-answer.screen.test.tsx:289 | `expect(screen.frame()).toContain("general awaiting input")` |
| "waiting child question does not hide its pending %s review" — test/screen/subagent-answer.screen.test.tsx:322 (table) | `expect(screen.frame()).not.toContain("Enter answer")` |

### test/screen/subagent-chat-capture.test.tsx (1 declarations/groups, 82 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures populated subagent chat states at reference terminal dimensions" — test/screen/subagent-chat-capture.test.tsx:17 | `expect(lines).toHaveLength(viewport.height)` |

### test/screen/subagent-picker-capture.test.tsx (3 declarations/groups, 336 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures populated subagent picker states at reference terminal dimensions" — test/screen/subagent-picker-capture.test.tsx:66 | `expect(lines).toHaveLength(viewport.height)` |
| "renders populated subagents in the parent-session rail" — test/screen/subagent-picker-capture.test.tsx:129 | `expect(frame).toContain("SUBAGENTS")` |
| "keeps the parent header status informational while subagents are active" — test/screen/subagent-picker-capture.test.tsx:147 | `expect(spanOf("waiting · 2 subagents")?.fg.toInts()).not.toEqual([240, 190, 98, 255])` |

### test/screen/subagent-picker-layout.test.tsx (3 declarations/groups, 344 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "shows active and terminal tasks in separate sections in Subagents without resizing the composer" — test/screen/subagent-picker-layout.test.tsx:77 | `expect(open.height).toBe(closed.height)` |
| "pages past a full active top page to make terminal tasks reachable in INACTIVE" — test/screen/subagent-picker-layout.test.tsx:140 | `expect(screen.frame()).toContain("ACTIVE")` |
| "freezes a completed task timer while other active task timers keep advancing" — test/screen/subagent-picker-layout.test.tsx:197 | `expect(initialOngoing).toBeDefined()` |

### test/screen/transcript-blocks-capture.test.tsx (4 declarations/groups, 450 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "captures the product transcript block primitives at canonical terminal dimensions" — test/screen/transcript-blocks-capture.test.tsx:273 | `expect(rows).toHaveLength(viewport.height)` |
| "captures transcript blocks through the real session route" — test/screen/transcript-blocks-capture.test.tsx:338 | `expect(lines).toHaveLength(viewport.height)` |
| "truncates command text without displacing its status at 80 columns" — test/screen/transcript-blocks-capture.test.tsx:368 | `expect(row.length).toBeLessThanOrEqual(80)` |
| "selects structured transcript blocks only for matching tool message data" — test/screen/transcript-blocks-capture.test.tsx:409 | `expect(transcriptToolPresentation({ tool: "plugin_tool", input: {}, output: "done" })).toBeUndefined()` |

### test/selection-tokens.test.tsx (2 declarations/groups, 42 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "resolves selected UI colours to the INFO focused-action pair" — test/selection-tokens.test.tsx:17 | `No inline assertion; inspect called harness` |
| "keeps crash fallback selection colours aligned with the ycoding theme" — test/selection-tokens.test.tsx:34 | `expect(fallback.fill.toInts()).toEqual(resolved.background.action.primary.focused.toInts())` |

### test/session-activity-row.test.tsx (3 declarations/groups, 146 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "self-stops a tool interval after completed, error, or cancelled lifecycle states" — test/session-activity-row.test.tsx:61 | `expect(callbacks).toHaveLength(1)` |
| "updates active tool durations once per second" — test/session-activity-row.test.tsx:92 | `expect(interval).toBe(1_000)` |
| "self-stops a subagent interval when its durable task completes" — test/session-activity-row.test.tsx:105 | `expect(callbacks).toHaveLength(1)` |

### test/session-autonomy.test.ts (20 declarations/groups, 300 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "normalizes untrusted YOLO input to a supported level" — test/session-autonomy.test.ts:13 | `expect([1.5, 9, Number.NaN, -1, true].map((yolo) => yoloLevel({ yolo }))).toEqual([1, 3, 0, 0, 2])` |
| "represents explicit goal reports through the progress label" — test/session-autonomy.test.ts:17 | `No inline assertion; inspect called harness` |
| "re-reads goal state when execution settles rather than when the assistant turn ends" — test/session-autonomy.test.ts:33 | `expect(source).toContain('data.on("session.execution.succeeded"')` |
| "rejects a completed refresh that began before a local goal activation" — test/session-autonomy.test.ts:41 | `expect(guard.accepts(stale)).toBe(false)` |
| "rejects an older refresh after a newer refresh starts" — test/session-autonomy.test.ts:51 | `expect(guard.accepts(stale)).toBe(false)` |
| "renders durable assistant text directly without treating literal marker text as control state" — test/session-autonomy.test.ts:60 | `expect(textPart).toContain("createMemo(() => props.part.text)")` |
| "labels normal, yolo, and goal modes" — test/session-autonomy.test.ts:68 | `expect(autonomyModeLabel({ mode: "normal", yolo: 0 } as unknown as SessionAutonomyState)).toBe("Normal")` |
| "formats goal progress" — test/session-autonomy.test.ts:109 | `expect(autonomyProgressLabel({ mode: "normal", yolo: 0 })).toBeUndefined()` |
| "renders goal iteration separately from no-progress" — test/session-autonomy.test.ts:123 | `No inline assertion; inspect called harness` |
| "hides the goal panel when the goal is not active" — test/session-autonomy.test.ts:136 | `expect(source).toContain('props.autonomy.goal?.status === "active"')` |
| "reports how a finished goal ended" — test/session-autonomy.test.ts:142 | `expect(autonomyProgressLabel(terminal("completed"))).toBe("completed after 3 iterations")` |
| "parses single-line, multiline, non-goal, and empty goal commands" — test/session-autonomy.test.ts:153 | `expect(parseGoalCommand("/goal Finish the migration")).toEqual({ goal: "Finish the migration" })` |
| "stops an active goal on a bare toggle" — test/session-autonomy.test.ts:160 | `No inline assertion; inspect called harness` |
| "resumes a retained goal without inventing or recalculating its objective" — test/session-autonomy.test.ts:170 | `No inline assertion; inspect called harness` |
| "requests an explicit objective when no retained goal text exists" — test/session-autonomy.test.ts:187 | `expect(goalToggleAction({ mode: "normal", yolo: 0 })).toEqual({ type: "request-objective" })` |
| "does not reset an active goal when its original text is re-activated" — test/session-autonomy.test.ts:198 | `expect(calls).toEqual([])` |
| "calculates and replaces the goal when new objective text is submitted" — test/session-autonomy.test.ts:224 | `expect(calls).toEqual(["Replace migration"])` |
| "surfaces a failed calculation so the dialog can preserve the draft" — test/session-autonomy.test.ts:251 | `No inline assertion; inspect called harness` |
| "keeps the goal dialog retry identity for a failed submission" — test/session-autonomy.test.ts:264 | `expect(changed).toBe(original)` |
| "exposes autonomy only for the connected active session" — test/session-autonomy.test.ts:281 | `expect(typeof currentSessionAutonomy).toBe("function")` |

### test/session-btw.test.ts (6 declarations/groups, 267 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "creates a distinct BTW child per command, seeds history, and admits with the selected model" — test/session-btw.test.ts:78 | `expect(typeof openBtwSessionCandidate).toBe("function")` |
| "opening BTW copies history without invoking the parent's generation API" — test/session-btw.test.ts:142 | `expect(generated).toEqual([])` |
| "side-chat activity leaves parent session state untouched" — test/session-btw.test.ts:168 | `expect(typeof openBtwSessionCandidate).toBe("function")` |
| "does not list or reuse an existing BTW child" — test/session-btw.test.ts:192 | `expect(typeof openBtwSessionCandidate).toBe("function")` |
| "steers an explicit conclusion into the parent without interrupting it" — test/session-btw.test.ts:225 | `expect(typeof steerBtwConclusionCandidate).toBe("function")` |
| "opens BTW only from explicit model-dialog completion and retains the draft on cancellation" — test/session-btw.test.ts:249 | `expect(source).toContain('slash: { name: "btw", arguments: true as const }')` |

### test/session-chrome-live-fixes.test.tsx (4 declarations/groups, 208 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "drops the session id the sidebar already shows" — test/session-chrome-live-fixes.test.tsx:56 | `expect(frame).toContain("main")` |
| `renders the installation version beside the brand at ${width} columns` — test/session-chrome-live-fixes.test.tsx:98 | `expect(line.indexOf("▌▐")).toBe(1)` |
| "renders the canonical text brand mark at its full size" — test/session-chrome-live-fixes.test.tsx:140 | `expect(first).toBeGreaterThanOrEqual(0)` |
| "carries a full-width top rule without moving its rows or columns" — test/session-chrome-live-fixes.test.tsx:165 | `expect([...(lines[0] ?? "")].filter((character) => character === "─")).toHaveLength(DESIGN_VIEWPORT.width)` |

### test/session-chrome.test.tsx (67 declarations/groups, 1018 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "keeps the full path at 160 columns" — test/session-chrome.test.tsx:42 | `expect(labels(160)).toEqual([` |
| "keeps the last two path parts at 140 columns" — test/session-chrome.test.tsx:52 | `expect(labels(140)).toEqual(["Personal/YCoding", "main", "Build", "anthropic/claude-opus-5", "max"])` |
| "keeps only the path basename at 120 columns" — test/session-chrome.test.tsx:56 | `expect(labels(120)).toEqual(["YCoding", "main", "Build", "anthropic/claude-opus-5", "max"])` |
| "drops the path and shortens the model at 100 columns" — test/session-chrome.test.tsx:60 | `expect(labels(100)).toEqual(["main", "Build", "anthropic/claude-opus-5", "max"])` |
| "drops the branch whole at 80 columns" — test/session-chrome.test.tsx:64 | `expect(labels(80)).toEqual(["Build", "anthropic/claude-opus-5", "max"])` |
| "omits segments the session has not resolved yet" — test/session-chrome.test.tsx:68 | `expect(headerSegments({ width: 160, agent: "Build" }).map((segment) => segment.key)).toEqual(["agent"])` |
| "places the active profile immediately after the agent" — test/session-chrome.test.tsx:72 | `expect(headerSegments({ ...identity, width: 160, profile: "Work" }).map((segment) => segment.key)).toEqual([` |
| "keeps the profile through the branch band" — test/session-chrome.test.tsx:91 | `expect(headerSegments({ ...identity, width: 100, profile: "Work" }).map((segment) => segment.key)).toEqual([` |
| "drops the profile whole below the branch band and when no provider profile is active" — test/session-chrome.test.tsx:101 | `expect(headerSegments({ ...identity, width: 80, profile: "Work" }).map((segment) => segment.key)).toEqual([` |
| "derives live retry status across the scheduled deadline" — test/session-chrome.test.tsx:113 | `expect(sessionRetryHeaderState(assistant, 1_000)).toEqual({ type: "retry-scheduled", attempt: 2, at: 2_000 })` |
| `renders ${expected}` — test/session-chrome.test.tsx:144 | `expect(headerStatusLabel(state, width)).toBe(expected)` |
| "renders a bare elapsed value for working at 100 columns" — test/session-chrome.test.tsx:149 | `expect(headerStatusLabel({ type: "working", elapsed: 4.14 }, 100)).toBe("4.1s")` |
| "shows the active shell count instead of ready" — test/session-chrome.test.tsx:153 | `expect(headerStatusLabel({ type: "ready" }, 100, 3)).toBe("3 shells running")` |
| "reports the retry attempt and countdown" — test/session-chrome.test.tsx:157 | `expect(headerStatusLabel({ type: "retry-scheduled", attempt: 2, at: 15_000 }, 100, undefined, 10_000)).toBe(` |
| "reports retrying without countdown" — test/session-chrome.test.tsx:163 | `expect(headerStatusLabel({ type: "retrying", attempt: 2 }, 100)).toBe("retrying · attempt 2")` |
| "keeps active autonomy and retry status visible together" — test/session-chrome.test.tsx:167 | `No inline assertion; inspect called harness` |
| "keeps active autonomy and retrying visible together" — test/session-chrome.test.tsx:178 | `No inline assertion; inspect called harness` |
| "shows the selected model and variant only while the session still uses a different next-prompt choice" — test/session-chrome.test.tsx:185 | `No inline assertion; inspect called harness` |
| "cycling back to default shows the pending default rather than the saved variant" — test/session-chrome.test.tsx:200 | `No inline assertion; inspect called harness` |
| "keeps the header model and variant from one source after a model switch" — test/session-chrome.test.tsx:209 | `expect(headerModelRef(durable, previousMessage)).toEqual(durable)` |
| "uses the last assistant message model only when the session model is absent" — test/session-chrome.test.tsx:215 | `expect(headerModelRef(undefined, previousMessage)).toEqual(previousMessage)` |
| "displays no variant segment for an absent variant" — test/session-chrome.test.tsx:220 | `expect(headerSegments({ width: 160, model: "openai/GPT-5.6 Terra", variant: undefined }).map((segment) => segment.key)).toEqual([` |
| "labels provider-qualified models with the resolved name" — test/session-chrome.test.tsx:232 | `expect(headerModelLabel({ providerID: "openai", modelID: "gpt-5-6-terra", name: "GPT-5.6 Terra" })).toBe("openai/GPT-5.6 Terra")` |
| "keeps the header model label to provider and model only" — test/session-chrome.test.tsx:237 | `expect(headerModelLabel({ providerID: "openai", modelID: "gpt-5-6-terra", name: "GPT-5.6 Terra" })).toBe(` |
| "renders the active profile immediately after the agent" — test/session-chrome.test.tsx:250 | `expect(frame).toContain("Build · Studio · anthropic/claude-opus-5 · max")` |
| "paints the profile in the subdued token beside the model identity" — test/session-chrome.test.tsx:260 | `expect(painted?.fg.toInts()).toEqual(theme.text.subdued.toInts())` |
| "drops the profile whole below the branch band without disturbing model or variant" — test/session-chrome.test.tsx:272 | `expect(frame).not.toContain("Studio")` |
| "renders no profile when the provider stores only one credential" — test/session-chrome.test.tsx:281 | `expect(line).toContain("Build · anthropic/claude-opus-5 · max")` |
| `renders active Daybreak beside the model at ${width} columns` — test/session-chrome.test.tsx:293 | `expect(app.captureCharFrame()).toContain("openai/GPT 6 Luna · Daybreak Blue · high")` |
| "distinguishes a saved but inactive program from an active one" — test/session-chrome.test.tsx:311 | `expect(app.captureCharFrame()).toContain("anthropic/claude-opus-5 · Daybreak Red (inactive) · max")` |
| "omits the indicator when Daybreak is off" — test/session-chrome.test.tsx:322 | `expect(app.captureCharFrame()).not.toContain("Daybreak")` |
| "shows both modes off for a normal session" — test/session-chrome.test.tsx:402 | `expect(modeChips({ autonomy: { mode: "normal", yolo: 0 } })).toEqual([` |
| "inverts YOLO because it auto-approves" — test/session-chrome.test.tsx:409 | `expect(modeChips({ autonomy: { mode: "normal", yolo: 2 } })[1]).toEqual({` |
| "shows only the goal label while goal mode is active" — test/session-chrome.test.tsx:417 | `expect(chip).toEqual({ key: "goal", label: "goal", tone: "on" })` |
| "shows goal off after leaving goal mode with retained terminal state" — test/session-chrome.test.tsx:425 | `expect(modeChips({ autonomy })[0]).toEqual({ key: "goal", label: "goal off", tone: "off" })` |
| "renders the chips on the composer status row" — test/session-chrome.test.tsx:431 | `expect(frame).toContain("goal off")` |
| "renders every identity segment with its design token" — test/session-chrome.test.tsx:463 | `expect(spans.find((span) => span.text.includes("~/Workspace/Personal/YCoding"))?.fg.toInts()).toEqual(` |
| "renders segment separators with the separator token instead of subdued text" — test/session-chrome.test.tsx:485 | `expect(separator?.fg.toInts()).toEqual(theme.text.separator.toInts())` |
| "renders the branch at 100 columns" — test/session-chrome.test.tsx:496 | `expect(present.captureCharFrame()).toContain("main")` |
| "renders every supported status with its semantic theme token" — test/session-chrome.test.tsx:502 | `expect(status?.text).toContain(label)` |
| "renders the generic provider failure label instead of the detailed message" — test/session-chrome.test.tsx:528 | `expect(frame).toContain("provider error")` |
| "shows the brand mark, mint dot trail, version, identity, and cooking status on the strip at 160 columns" — test/session-chrome.test.tsx:536 | `expect(frame).toMatch(/\.\.●&#124;\.●\.&#124;●\.\./)` |
| "drops the path and branch at 80 columns instead of shrinking the state word" — test/session-chrome.test.tsx:552 | `expect(frame).toContain('v${InstallationVersion}')` |
| "renders the danger rule as a full-width filled band under the header in YOLO" — test/session-chrome.test.tsx:563 | `expect(frame).toContain("YOLO 2 \u00b7 auto-approve")` |
| "counts down the top-right retry indicator" — test/session-chrome.test.tsx:579 | `expect(app.captureCharFrame()).not.toMatch(/\.\.●&#124;\.●\.&#124;●\.\./)` |
| "scheduled retry shows countdown without animation" — test/session-chrome.test.tsx:588 | `expect(app.captureCharFrame()).toContain("1 failed · retry 2 · in")` |
| "animates retrying with the warning dot trail without countdown" — test/session-chrome.test.tsx:595 | `expect(initialTrail).toBeDefined()` |
| "renders a completed retried assistant as ready instead of currently retrying" — test/session-chrome.test.tsx:620 | `expect(frame).toContain("ready")` |
| "reveals the binding for the focused segment only" — test/session-chrome.test.tsx:643 | `expect(frame).toContain("\u2303x m change")` |
| "reveals bound segment hints while the leader key is pending" — test/session-chrome.test.tsx:651 | `expect(frame).toContain("⌃x m change")` |
| "does not reveal an unbound segment hint while the leader key is pending" — test/session-chrome.test.tsx:659 | `expect(app.captureCharFrame()).not.toContain("move")` |
| "keeps an explicit focused segment ahead of the leader-pending state" — test/session-chrome.test.tsx:666 | `expect(frame).toContain("⌃x m change")` |
| "hides hints without a focused segment or pending leader key" — test/session-chrome.test.tsx:675 | `expect(frame).not.toContain("⌃x m change")` |
| "keeps a focused model subdued and uses the label token for its hint" — test/session-chrome.test.tsx:684 | `expect(model?.fg.toInts()).toEqual(theme.text.subdued.toInts())` |
| "resolves a focused hint from the configured keymap" — test/session-chrome.test.tsx:698 | `expect(app.captureCharFrame()).toContain("⌃k change")` |
| "omits the hint for a focused segment whose command is unbound" — test/session-chrome.test.tsx:709 | `expect(app.captureCharFrame()).not.toContain("move")` |
| "renders subagent identity and cooking status in the info token" — test/session-chrome.test.tsx:716 | `expect(brand?.fg.toInts()).toEqual(theme.text.feedback.info.default.toInts())` |
| "keeps main-session cooking status and dot trail in the accent token" — test/session-chrome.test.tsx:728 | `expect(spans.find((span) => /\.\.●&#124;\.●\.&#124;●\.\./.test(span.text))?.fg.toInts()).toEqual(theme.text.feedback.success.default.toInts())` |
| "uses the slower native spinner interval while preserving normal working success color" — test/session-chrome.test.tsx:739 | `expect(findSpinnerInterval(app.renderer.root)).toBe(160)` |
| "uses the YOLO error token for the dot trail and adjacent working status" — test/session-chrome.test.tsx:751 | `expect(dotTrail?.fg.toInts()).toEqual(theme.text.feedback.error.default.toInts())` |
| "keeps the animation-disabled normal working fallback static and success-colored" — test/session-chrome.test.tsx:763 | `expect(app.captureCharFrame()).not.toMatch(/\.\.●&#124;\.●\.&#124;●\.\./)` |
| "renders next-prompt agent, model, and variant for a main Session but not a subagent" — test/session-chrome.test.tsx:778 | `expect(highlight?.fg.toInts()).toEqual(theme.text.subdued.toInts())` |
| "updates active elapsed time and stops after becoming ready" — test/session-chrome.test.tsx:842 | `expect(app.captureCharFrame()).not.toBe(initial)` |
| "renders the branch and session chip with subdued text in footer order" — test/session-chrome.test.tsx:884 | `expect(branch?.fg.toInts()).toEqual(theme.text.subdued.toInts())` |
| "omits the session chip when no session id exists" — test/session-chrome.test.tsx:918 | `expect(app.captureCharFrame()).not.toContain("ses_")` |
| "keeps a short session id unpadded and without an ellipsis" — test/session-chrome.test.tsx:944 | `expect(app.captureCharFrame()).toContain("ses_short")` |
| "renders the branch first when present and omits it when absent" — test/session-chrome.test.tsx:971 | `expect(presentFrame.indexOf("main")).toBeLessThan(presentFrame.indexOf("ses_0085fc701"))` |

### test/session-design-surfaces.test.tsx (3 declarations/groups, 103 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "shell output uses the design header, metadata columns, and footer labels" — test/session-design-surfaces.test.tsx:27 | `expect(lines[1]).toContain("y. ycoding bun test provider · Main chat · pid 48213")` |
| "blocked subagent keeps status, task, result, and question on their design rows" — test/session-design-surfaces.test.tsx:47 | `expect(output).toContain("TEST-TRIAGE SUBAGENT")` |
| "subagent sibling labels preserve lowercase names and blocked status" — test/session-design-surfaces.test.tsx:71 | `expect(subagentSwitcherLabel({ agent: "docs-sync", state: "running" })).toBe("◦ docs-sync")` |

### test/session-layout.test.ts (1 declarations/groups, 7 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "session transcript does not render the redundant top header slot" — test/session-layout.test.ts:5 | `expect(sessionRoute).not.toContain('name="session.header"')` |

### test/session-model-selection.test.tsx (16 declarations/groups, 637 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders one row for a Daybreak-advertising model and records the ordinary model id" — test/session-model-selection.test.tsx:284 | `expect(rows).toHaveLength(1)` |
| "model and variant picker selection performs no Session request" — test/session-model-selection.test.tsx:316 | `expect(screen.current()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })` |
| "rapid model cycling keeps only the newest Session target" — test/session-model-selection.test.tsx:335 | `expect(screen.pendingTarget()).toEqual({ providerID: "google", modelID: "gemini-3-pro" })` |
| "switching routes does not leak one Session's desired model" — test/session-model-selection.test.tsx:357 | `expect(switches).toEqual([])` |
| "selecting a model restores its valid stored variant without another variant choice" — test/session-model-selection.test.tsx:376 | `expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "high" })` |
| "rapid variant cycling advances from the newest pending variant" — test/session-model-selection.test.tsx:395 | `expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "low" })` |
| "variant cycling displays none, advances through offered variants, then returns to base" — test/session-model-selection.test.tsx:414 | `expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "none" })` |
| "renders and persists an advertised none variant from model selection" — test/session-model-selection.test.tsx:448 | `expect(await Bun.file(path.join(root, "variant-saved-none", "model.json")).json()).toMatchObject({` |
| "keeps the desired target until the matching prompt submission commits it" — test/session-model-selection.test.tsx:472 | `expect(screen.pendingTarget()?.variant).toBe("high")` |
| "Session model authority follows durable changes without using the agent's model preference" — test/session-model-selection.test.tsx:499 | `expect(screen.pendingTarget()).toBeUndefined()` |
| "ModelSelected replaces the whole Session reference when the target omits the prior max effort" — test/session-model-selection.test.tsx:515 | `expect(screen.durableModel()).toEqual({ providerID: "openai", id: "gpt-5-2", variant: "max" })` |
| "model round trips restore each target's valid effort, including uncommitted choices" — test/session-model-selection.test.tsx:540 | `expect(screen.variant()).toBeUndefined()` |
| "invalid model or explicit effort selections preserve the prior pending choice and preferences" — test/session-model-selection.test.tsx:560 | `expect(screen.pendingTarget()).toEqual(pending)` |
| "selecting a model with no variants does not inherit the prior model's stored variant" — test/session-model-selection.test.tsx:581 | `expect(screen.pendingTarget()).toEqual({ providerID: "google", modelID: "gemini-3-pro" })` |
| "selecting a model that does not offer the stored variant value clears it" — test/session-model-selection.test.tsx:600 | `expect(screen.variant()).toBeUndefined()` |
| "the home screen commits the next-Session preference without a Session API call" — test/session-model-selection.test.tsx:621 | `expect(screen.pendingTarget()).toBeUndefined()` |

### test/session-rail-live-fixes.test.tsx (9 declarations/groups, 570 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "ellipsises an over-long rail row label and keeps a blank column before its value" — test/session-rail-live-fixes.test.tsx:42 | `expect(line?.trimEnd().endsWith("7m14s")).toBe(true)` |
| "renders each skill as a name row with a colour-coded status value" — test/session-rail-live-fixes.test.tsx:75 | `expect(lineOf("go-developer")?.trimEnd().endsWith("CONFLICT")).toBe(true)` |
| "colours every todo marker and label by status" — test/session-rail-live-fixes.test.tsx:162 | `expect([completed.marker?.plainText, active.marker?.plainText, cancelled.marker?.plainText, pending.marker?.plainText]).toEqual([` |
| "paints the rail on its own surface behind a left rule and drops the rail footer" — test/session-rail-live-fixes.test.tsx:209 | `expect(app.rail()!.background.default.toInts()).not.toEqual(app.canvas()!.background.default.toInts())` |
| "keeps the rail bottom padding across the responsive viewports" — test/session-rail-live-fixes.test.tsx:239 | `expect(lines[app.rowOf(session.title)]).toContain(session.title)` |
| "summarizes only connected and failed MCP servers at canonical rail width" — test/session-rail-live-fixes.test.tsx:263 | `expect(header).toContain("1/5 connected · 1 failed")` |
| "omits the MCP failure exception when no server has failed" — test/session-rail-live-fixes.test.tsx:284 | `expect(header).toContain("1/1 connected")` |
| "keeps the rail top below the header across autonomy modes and retained goals" — test/session-rail-live-fixes.test.tsx:297 | `expect(tops).toEqual(Array.from({ length: modes.length }, () => tops[0]))` |
| "does not render a shell rail section for running and just-finished session shells" — test/session-rail-live-fixes.test.tsx:330 | `expect(frame).toContain("SESSION")` |

### test/session-rail-section.test.tsx (25 declarations/groups, 894 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "keeps every section toggleable with others collapsed by default" — test/session-rail-section.test.tsx:38 | `expect(app.captureCharFrame()).toContain("todo body")` |
| "registers sidebar content in the rail design order" — test/session-rail-section.test.tsx:73 | `No inline assertion; inspect called harness` |
| "renders expanded when no rail provider is mounted" — test/session-rail-section.test.tsx:88 | `expect(app.captureCharFrame()).toContain("mcp body")` |
| "renders the session title only inside the section body" — test/session-rail-section.test.tsx:100 | `expect(rows[0]).toMatch(/^− SESSION *$/)` |
| "renders guardrail auto-approval only at effective YOLO 3" — test/session-rail-section.test.tsx:115 | `expect(row?.trimEnd(), item.name).toEndWith(item.expected)` |
| "keeps autonomy semantics out of generic rail sections" — test/session-rail-section.test.tsx:149 | `expect(app.captureCharFrame()).not.toContain("Guardrails")` |
| "renders aggregate context rows when diagnostics are unavailable" — test/session-rail-section.test.tsx:161 | `expect(frame).toContain("SPEND")` |
| "renders a summary on both expanded and collapsed headers" — test/session-rail-section.test.tsx:189 | `expect(frame).toContain("56% · 71% hit")` |
| "renders compact operational rail summaries from live component state" — test/session-rail-section.test.tsx:210 | `expect(header).toContain(summary)` |
| "keeps guardrail profile identity and surfaces only its highest-priority exception" — test/session-rail-section.test.tsx:261 | `expect(guardrailSummary({ ...base, blocked: 2, invalidFiles: ["bad.md"] }).header).toBe("Standard · 2 blocked")` |
| "leaves one blank row after expanded TODO content" — test/session-rail-section.test.tsx:277 | `expect(lines[completed + 1]?.trim()).toBe("")` |
| "applies one outer surface row around populated expandable rail sections" — test/session-rail-section.test.tsx:310 | `expect(contentRow - headerRow).toBe(3)` |
| "renders RailRow values right-aligned on a single line with custom value color" — test/session-rail-section.test.tsx:349 | `expect(line?.endsWith("71%")).toBe(true)` |
| "renders the CONTEXT design rows and omits unreported cache telemetry" — test/session-rail-section.test.tsx:372 | `expect(indexes.every((index) => index >= 0)).toBe(true)` |
| "keeps credential identity out of the Context section" — test/session-rail-section.test.tsx:473 | `expect(provider).toBeGreaterThan(-1)` |
| "renders a non-toggleable CACHE sub-heading inside the toggleable CONTEXT section" — test/session-rail-section.test.tsx:505 | `expect(heading?.fg.toInts()).toEqual(themeV2()!.text.feedback.success.default.toInts())` |
| "renders rail header glyphs and colors for expanded, collapsed, and attention states" — test/session-rail-section.test.tsx:549 | `expect(expanded[0]?.plainText).toBe("\u2212")` |
| "auto-expands an expandable section on attention and re-collapses once it clears" — test/session-rail-section.test.tsx:595 | `No inline assertion; inspect called harness` |
| "expands every section on attention" — test/session-rail-section.test.tsx:619 | `expect(app.captureCharFrame()).not.toContain("subagent body")` |
| "renders distinct GOAL and AUTONOMY sections, SUBAGENTS rail rows, and a TODO LIST in the correct order" — test/session-rail-section.test.tsx:643 | `expect(indexes.every((index) => index >= 0)).toBe(true)` |
| "an attention event preserves default-expanded sections and releases its own section" — test/session-rail-section.test.tsx:723 | `expect(app.captureCharFrame()).toContain("todo body")` |
| "a user can toggle an expandable section from its header" — test/session-rail-section.test.tsx:773 | `expect(app.captureCharFrame()).toContain("todo body")` |
| "every section toggles from its header" — test/session-rail-section.test.tsx:796 | `expect(app.captureCharFrame()).not.toContain("mcp body")` |
| "preserves user toggles across session prop changes" — test/session-rail-section.test.tsx:821 | `expect(app.captureCharFrame()).toContain("todo body")` |
| "preserves expand/collapse across Session remounts (main <-> subagent)" — test/session-rail-section.test.tsx:854 | `expect(next.captureCharFrame()).toContain("context body")` |

### test/session-rail.test.ts (15 declarations/groups, 142 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "expands only session context and todo by default" — test/session-rail.test.ts:15 | `expect(defaultExpanded({})).toEqual([` |
| "keeps goal and autonomy collapsed alongside the persistent sections" — test/session-rail.test.ts:23 | `expect(defaultExpanded({ goal: true, autonomy: true })).toEqual([` |
| "keeps unrelated sections collapsed without broadening to operational ones" — test/session-rail.test.ts:31 | `expect(defaultExpanded({ allExpanded: true })).toEqual([` |
| "allows every section to expand" — test/session-rail.test.ts:41 | `expect(EXPANDABLE_RAIL_SECTIONS).toEqual([` |
| "keeps every expanded section open" — test/session-rail.test.ts:73 | `expect(expandSection(order, "mcp")).toEqual(["session", "context", "todo", "goal", "mcp"])` |
| "re-expanding a section refreshes its recency instead of duplicating it" — test/session-rail.test.ts:78 | `expect(expandSection(order, "session")).toEqual(["context", "todo", "goal", "session"])` |
| "collapsing removes the section and frees capacity" — test/session-rail.test.ts:83 | `expect(collapseSection(order, "todo")).toEqual(["session", "context", "goal"])` |
| "collapsing a section that is already collapsed changes nothing" — test/session-rail.test.ts:88 | `expect(collapseSection(order, "mcp")).toEqual(order)` |
| "opens an attention section without collapsing CONTEXT" — test/session-rail.test.ts:95 | `expect(resolveExpanded({ order, attention: ["subagents"] })).toEqual([` |
| "leaves the order untouched when nothing needs attention" — test/session-rail.test.ts:106 | `expect(resolveExpanded({ order, attention: [] })).toEqual(order)` |
| "hides the rail below 100 columns" — test/session-rail.test.ts:113 | `expect(railPlacement(80)).toBe("hidden")` |
| "overlays the rail between 100 and 119 columns" — test/session-rail.test.ts:118 | `expect(railPlacement(100)).toBe("overlay")` |
| "docks the rail from 120 columns" — test/session-rail.test.ts:123 | `expect(railPlacement(120)).toBe("docked")` |
| "interpolates the docked rail from 32 to 50 columns" — test/session-rail.test.ts:128 | `expect(railWidth(120)).toBe(32)` |
| "changes smoothly around the former design viewport widths" — test/session-rail.test.ts:136 | `expect(Math.abs(railWidth(188) - railWidth(189))).toBeLessThanOrEqual(1)` |

### test/session-skill-render.test.tsx (1 declarations/groups, 33 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders user and agent-invoked completed Skill titles with the same treatment" — test/session-skill-render.test.tsx:11 | `expect(app.captureCharFrame()).toBeDefined()` |

### test/session-skills.test.ts (7 declarations/groups, 85 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "groups active skills before inactive skills while preserving server order" — test/session-skills.test.ts:43 | `expect(groupSessionSkills(skills)).toEqual({` |
| "filters skill IDs and names without case sensitivity" — test/session-skills.test.ts:50 | `expect(filterSessionSkills(skills, "CODE")).toEqual([skills[0]])` |
| "formats active conflicts and inactive boundaries" — test/session-skills.test.ts:55 | `expect(sessionSkillLabel(skills[1])).toBe("ACTIVE - CONFLICT")` |
| "keeps exact string content and discards non-string tool output" — test/session-skills.test.ts:61 | `expect(sessionSkillContent("\nExact skill content\n")).toBe("\nExact skill content\n")` |
| "renders skill details in a bounded scrollbox with keyboard expansion" — test/session-skills.test.ts:66 | `expect(dialogSessionSkills).toContain("<scrollbox")` |
| "highlights loaded skill badges with the skill accent" — test/session-skills.test.ts:73 | `expect(sessionRoute).toContain("status={<StatusBadge color={accent()}>Loaded</StatusBadge>}")` |
| "hides only completed duplicate Skill tool parts" — test/session-skills.test.ts:81 | `expect(sessionRoute).toContain("function transcriptToolPartVisible(part: SessionMessageAssistantTool)")` |

### test/session-transcript-boundary.test.tsx (8 declarations/groups, 344 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "allocates no lines or child context for a hidden goal tool" — test/session-transcript-boundary.test.tsx:51 | `expect(frame(app)).toBe("before\nafter")` |
| "does not render a completed duplicate Skill tool part" — test/session-transcript-boundary.test.tsx:78 | `expect(frame(app)).toContain("before\nafter")` |
| "does not allocate a line for an unresolved transcript row" — test/session-transcript-boundary.test.tsx:112 | `expect(frame(app)).toContain("before\nafter")` |
| "renders a decode-only historical V1 compaction marker" — test/session-transcript-boundary.test.tsx:120 | `expect(frame(app)).toContain("~ compacted · 42 messages → 1.2k tokens")` |
| "renders sanitized V2 compaction lifecycle labels" — test/session-transcript-boundary.test.tsx:150 | `expect(frame(app)).toContain(label)` |
| "renders real V1 and V2 failed compactions as zero-line diagnostic-only state" — test/session-transcript-boundary.test.tsx:231 | `expect(frame(legacyApp)).toContain("before\nafter")` |
| "renders cancelled and superseded compactions as neutral terminal markers" — test/session-transcript-boundary.test.tsx:269 | `expect(frame(app)).toContain(lifecycle.label)` |
| "sums completed compactions while retaining per-compaction metrics" — test/session-transcript-boundary.test.tsx:308 | `expect(frame(app)).toContain("~52k tokens saved total")` |

### test/session-transcript-chat-shape.test.tsx (8 declarations/groups, 507 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders the delivery receipt below the user bubble" — test/session-transcript-chat-shape.test.tsx:359 | `expect(receipt).toContain("✓")` |
| "keeps a loaded skill row without rendering its following content" — test/session-transcript-chat-shape.test.tsx:374 | `expect(screen.frame()).toContain('Skill "focus-test"')` |
| "ends a completed idle exchange with the assistant block" — test/session-transcript-chat-shape.test.tsx:386 | `expect(lastTranscriptRow(screen.lines()).trim()).toMatch(/^Build · .+ · 2s$/)` |
| "ends an interrupted idle turn with the assistant block" — test/session-transcript-chat-shape.test.tsx:398 | `expect(lastTranscriptRow(screen.lines()).trim()).toMatch(/^Build · .+ · 1s · interrupted$/)` |
| "ends an idle tool-only turn with the assistant block rather than a dangling tool row" — test/session-transcript-chat-shape.test.tsx:408 | `expect(last).not.toContain("project_audit")` |
| "renders assistant chat text only through the markdown path" — test/session-transcript-chat-shape.test.tsx:420 | `expect(heading).not.toContain("#")` |
| "renders restored instruction notices through the markdown path" — test/session-transcript-chat-shape.test.tsx:442 | `expect(heading).not.toContain("#")` |
| "collapses a segment's file edits into one summary block that expands to the diff view" — test/session-transcript-chat-shape.test.tsx:458 | `expect(header.indexOf("Captured changes 3 files")).toBe(10)` |

### test/session-transcript-live-fixes.test.tsx (25 declarations/groups, 1860 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "derives pending, running, terminal, cancelled, and overridden tool lifecycle states from durable time" — test/session-transcript-live-fixes.test.tsx:811 | `expect(toolLifecyclePresentation({ status: "streaming", time: {}, now: lifecycleEnd })).toEqual({` |
| "does not mount TodoWrite tasks in the transcript" — test/session-transcript-live-fixes.test.tsx:854 | `expect(screen.frame()).not.toContain("Fix shared cache accounting")` |
| "hides retained Session state and TeamView bodies while keeping message order" — test/session-transcript-live-fixes.test.tsx:869 | `expect(frame).not.toContain("Authoritative current Session state: normal mode")` |
| "hides Session state and TeamView notices while keeping messages" — test/session-transcript-live-fixes.test.tsx:909 | `expect(screen.frame()).not.toContain("Session state · normal")` |
| "keeps yolo-goal todos in the sidebar instead of the transcript" — test/session-transcript-live-fixes.test.tsx:953 | `expect(lines.some((line) => line.includes("Yolo sidebar todo") && line.indexOf("Yolo sidebar todo") < railStart)).toBe(false)` |
| "bottom-follows a completed compaction tail like normal chat" — test/session-transcript-live-fixes.test.tsx:971 | `expect(scroll.scrollTop).toBe(Math.max(0, scroll.scrollHeight - scroll.viewport.height))` |
| "restores main-session tail and non-tail view across repeated subagent navigation" — test/session-transcript-live-fixes.test.tsx:988 | `expect(screen.frame()).toContain("COVERED HISTORY MUST STAY PRUNED")` |
| "keeps non-subagent activity rows on one marker/label grid with symmetric compaction rules" — test/session-transcript-live-fixes.test.tsx:1090 | `expect(thought.indexOf("ok"), screen.frame()).toBe(3)` |
| "renders one durable lifecycle grammar for execute, exploration, shell, CLI, and generic tools" — test/session-transcript-live-fixes.test.tsx:1150 | `expect(row("execute")).toMatch(/running · \d+s$/)` |
| "advances running tool elapsed time without changing terminal durations" — test/session-transcript-live-fixes.test.tsx:1191 | `expect(Number(/running · (\d+)s$/.exec(execute())?.[1])).toBeGreaterThan(Number(firstElapsed))` |
| "renders subagent notifications as compact safe activity rows" — test/session-transcript-live-fixes.test.tsx:1216 | `expect(row.indexOf("◦")).toBe(3)` |
| "keeps a running patch row honest beside the segment summary of its completed edits" — test/session-transcript-live-fixes.test.tsx:1242 | `expect(screen.frame()).not.toContain("Edited 2 files")` |
| "collapses the segment's edit summary before expanding the board diff grid" — test/session-transcript-live-fixes.test.tsx:1265 | `expect(header.indexOf("Captured changes 2 files")).toBe(10)` |
| "keeps the board diff grid in unified transcript view" — test/session-transcript-live-fixes.test.tsx:1314 | `expect((screen.lines()[rowIn(screen.lines(), "Captured changes 2 files")] ?? "").indexOf("Captured changes 2 files")).toBe(10)` |
| "renders every line of an ordinary multi-line user prompt" — test/session-transcript-live-fixes.test.tsx:1349 | `expect(flat).toContain(line.replace(/\s+/g, " "))` |
| "renders intrinsic rounded user bubbles without crossing their border at supported widths" — test/session-transcript-live-fixes.test.tsx:1381 | `expect(short.topText.startsWith("╭")).toBe(true)` |
| "renders a pasted multi-section Markdown user prompt at full height" — test/session-transcript-live-fixes.test.tsx:1413 | `expect(viewport).toBeDefined()` |
| "renders only truthful icon receipts at the lower-right of outbound user bubbles" — test/session-transcript-live-fixes.test.tsx:1494 | `expect(row).toBeGreaterThan(bubble.bottom)` |
| "bounds streaming growth renders and confines spinner frame changes to its activity row" — test/session-transcript-live-fixes.test.tsx:1537 | `expect(growthFrames).toBeGreaterThan(1)` |
| "keeps multiline tool output in one native text buffer" — test/session-transcript-live-fixes.test.tsx:1601 | `expect(countTextBuffersContaining(screen.renderer.root, "resource-line-")).toBe(1)` |
| "keeps one assistant Markdown message in one native text buffer" — test/session-transcript-live-fixes.test.tsx:1616 | `expect(markdown).toBeDefined()` |
| "finalizes completed Markdown while preserving image placeholders" — test/session-transcript-live-fixes.test.tsx:1633 | `expect(markdown).toBeDefined()` |
| "keeps expanded skill content in one native text buffer" — test/session-transcript-live-fixes.test.tsx:1651 | `expect(focusable).toBeDefined()` |
| "caps large transcript at bounded mounted window" — test/session-transcript-live-fixes.test.tsx:1673 | `expect(screen.frame()).toContain("older rows hidden")` |
| "truncates a transcript label with an ellipsis instead of overprinting its status at 80 columns" — test/session-transcript-live-fixes.test.tsx:1839 | `expect(row.indexOf("project_search")).toBe(10)` |

### test/shell-owner.test.ts (4 declarations/groups, 116 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "groups current and child shells by their labelled owners" — test/shell-owner.test.ts:44 | `expect(typeof groupSessionShellsCandidate).toBe("function")` |
| "excludes shells owned by sessions outside the current subtree" — test/shell-owner.test.ts:67 | `expect(typeof groupSessionShellsCandidate).toBe("function")` |
| "keeps unknown and unattributed shells under a neutral owner" — test/shell-owner.test.ts:85 | `expect(typeof groupSessionShellsCandidate).toBe("function")` |
| "returns only running rows so the badge count equals the tab row count" — test/shell-owner.test.ts:99 | `expect(typeof groupSessionShellsCandidate).toBe("function")` |

### test/shell-tab.test.tsx (1 declarations/groups, 106 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders owner groups, supported statuses, and derived elapsed durations" — test/shell-tab.test.tsx:44 | `expect(grouped.map((group) => group.owner.label)).toEqual([` |

### test/side-chats-tab.test.tsx (3 declarations/groups, 160 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "lists only direct BTW side chats without assigning managed-task state" — test/side-chats-tab.test.tsx:34 | `expect(entries).toEqual([` |
| "loads older direct BTW chats, reopens one, and creates only one model-deferred side chat" — test/side-chats-tab.test.tsx:53 | `expect(url.searchParams.get("parentID")).toBe("ses_main")` |
| "renders a visible list error instead of an empty-side-chat message" — test/side-chats-tab.test.tsx:123 | `expect(app.captureCharFrame()).not.toContain("No side chats")` |

### test/simulation/semantics.test.ts (1 declarations/groups, 23 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "shares lazy semantic annotations with the simulation renderer" — test/simulation/semantics.test.ts:8 | `expect(Reader.read(renderable)?.()).toEqual({ role: "option", selected: false })` |

### test/skills-conflict.test.tsx (6 declarations/groups, 197 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| `renders the real conflict affordance at ${viewport.width} columns` — test/skills-conflict.test.tsx:44 | `expect(app.captureCharFrame()).toContain("! 1 conflict · ⌃x i")` |
| `omits the conflict row at ${viewport.width} columns when no active skill conflict exists` — test/skills-conflict.test.tsx:63 | `expect(app.captureCharFrame()).not.toContain("conflict")` |
| "renders a rebound live shortcut instead of the default hint" — test/skills-conflict.test.tsx:78 | `expect(app.captureCharFrame()).toContain("⌃k")` |
| "keeps the conflict row without a dead shortcut when the command is unbound" — test/skills-conflict.test.tsx:89 | `expect(app.captureCharFrame()).toContain("! 1 conflict ·")` |
| "resolves the selected skill winner" — test/skills-conflict.test.tsx:100 | `expect(calls).toEqual([{ winner: "loser", loser: "winner" }])` |
| "refreshes the server-derived skills after a conflict is already resolved" — test/skills-conflict.test.tsx:123 | `expect(app.captureCharFrame()).not.toContain("1 conflict")` |

### test/source-hygiene.test.ts (2 declarations/groups, 50 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "contains no V1 config, theme, or command compatibility" — test/source-hygiene.test.ts:12 | `expect(matches).toEqual([])` |
| "resolves every built-in theme from a current theme file" — test/source-hygiene.test.ts:39 | `expect(modes.length).toBeGreaterThan(0)` |

### test/subagent-answer.test.tsx (5 declarations/groups, 187 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "answers %s as literal text, not a command" — test/subagent-answer.test.tsx:87 (table) | `expect(fixture.writes).toEqual([` |
| "blank answers do nothing and bracketed multiline Unicode paste remains literal" — test/subagent-answer.test.tsx:105 | `expect(fixture.writes).toEqual([])` |
| "a %s question cannot receive the retained draft" — test/subagent-answer.test.tsx:123 (table) | `expect(fixture.writes).toEqual([])` |
| "failed transport preserves the draft and explicit retry submits the same owned question" — test/subagent-answer.test.tsx:141 | `expect(fixture.app.captureCharFrame()).toContain("Retry this draft")` |
| "duplicate Enter coalesces in flight and settlement does not clear a newer draft or resend" — test/subagent-answer.test.tsx:161 | `expect(fixture.writes).toHaveLength(1)` |

### test/subagent-summary-reconnect.test.tsx (1 declarations/groups, 137 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "refreshes a resident subagent summary after reconnect and rejects the pre-disconnect response" — test/subagent-summary-reconnect.test.tsx:19 | `expect(data.session.subagent.summary(parentID)?.active).toBe(1)` |

### test/terminal-inspector-component.test.tsx (6 declarations/groups, 441 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "read-only inspector is passive, renders native terminal state, and separates close from control/resize" — test/terminal-inspector-component.test.tsx:32 | `expect(frame).toContain("Owned fixture · ses_component · running · 30×4")` |
| "reconnect resumes the resident emulator at the last ordered offset" — test/terminal-inspector-component.test.tsx:108 | `expect(connections).toEqual([` |
| "holds input, focus, and resize until the current fenced control replay connects after take and reconnect" — test/terminal-inspector-component.test.tsx:161 | `expect(await inspector.takeControl()).toBe(true)` |
| "an already user-controlled terminal receives input after replay synchronization" — test/terminal-inspector-component.test.tsx:265 | `expect(new TextDecoder().decode(writes[0])).toBe("x")` |
| "close keeps user-controlled inspector open when pause fails and hides raw error details" — test/terminal-inspector-component.test.tsx:310 | `expect(closed).toBe(0)` |
| "unmount cancels an in-flight control acquisition before late settlement" — test/terminal-inspector-component.test.tsx:371 | `expect(signal?.aborted).toBe(true)` |

### test/terminal-inspector-render.test.tsx (1 declarations/groups, 43 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "native terminal viewport preserves cursor redraw and alternate-screen restoration" — test/terminal-inspector-render.test.tsx:7 | `expect(terminal!.screen().cursor).toMatchObject({ x: 12, y: 0 })` |

### test/terminal-inspector-state.test.ts (3 declarations/groups, 96 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "applies ordered generation/offset output and resumes a resident emulator contiguously" — test/terminal-inspector-state.test.ts:35 | `expect(state.reconnectInput()).toEqual({ generation: 1, offset: 3, access: "inspect", fence: undefined })` |
| "marks prefix eviction, generation changes, and out-of-order bytes unsynchronized without applying data" — test/terminal-inspector-state.test.ts:55 | `expect(state.snapshot().synchronization).toBe("unsynchronized")` |
| "allows state-dependent input only for a connected synchronized current user fence" — test/terminal-inspector-state.test.ts:70 | `expect(state.canInput()).toBe(false)` |

### test/terminal-inspector-transport.test.ts (4 declarations/groups, 240 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "ticketed control transport binds Session, generation, offset, and fence before forwarding frames" — test/terminal-inspector-transport.test.ts:12 | `expect(tickets.map((item) => item.input)).toEqual([` |
| "disposing a pending ticket request prevents late socket creation" — test/terminal-inspector-transport.test.ts:83 | `expect(signal?.aborted).toBe(true)` |
| "connect-token rejection reports one category-only failure without opening a socket" — test/terminal-inspector-transport.test.ts:116 | `expect(failures).toBe(1)` |
| "new connections resolve the current API and base URL after service reconnection" — test/terminal-inspector-transport.test.ts:145 | `expect(calls).toEqual(["first", "second"])` |

### test/terminal-picker.test.tsx (2 declarations/groups, 151 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "picker lists only the active Session terminals and selection deliberately navigates" — test/terminal-picker.test.tsx:22 | `expect(result.app.captureCharFrame()).not.toContain("Foreign terminal")` |
| "picker renders a safe retryable list failure without leaking raw details" — test/terminal-picker.test.tsx:48 | `expect(failed).toContain("Press r to retry")` |

### test/theme-ycoding.test.ts (8 declarations/groups, 104 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "resolves the YCoding dark semantic palette" — test/theme-ycoding.test.ts:27 | `No inline assertion; inspect called harness` |
| "resolves chrome bands independently for each mode" — test/theme-ycoding.test.ts:42 | `No inline assertion; inspect called harness` |
| "falls back to the page background for Aura without a chrome token" — test/theme-ycoding.test.ts:48 | `expect(auraTheme.background.chrome.toInts()).toEqual(auraTheme.background.default.toInts())` |
| "keeps a focused row readable on the INFO selection fill" — test/theme-ycoding.test.ts:52 | `expect(theme.text.action.primary.focused.toInts()).not.toEqual(theme.background.action.primary.focused.toInts())` |
| "tints a focused form field instead of filling it with the text colour" — test/theme-ycoding.test.ts:60 | `expect(theme.background.formfield.focused.toInts()).not.toEqual(theme.text.formfield.focused.toInts())` |
| "keeps light semantic text tokens visible and ordered against the page" — test/theme-ycoding.test.ts:66 | `expect(color.toInts()).not.toEqual(page.toInts())` |
| "preserves the YCoding dark semantic text hierarchy" — test/theme-ycoding.test.ts:88 | `No inline assertion; inspect called harness` |
| "resolves diff context colors from each mode's semantic tokens" — test/theme-ycoding.test.ts:95 | `No inline assertion; inspect called harness` |

### test/theme.test.ts (11 declarations/groups, 126 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "default themes export ycoding without inherited OC theme identifiers" — test/theme.test.ts:11 | `expect(DEFAULT_THEMES.ycoding).toBeDefined()` |
| "addTheme writes into module theme store" — test/theme.test.ts:16 | `expect(addTheme(name, DEFAULT_THEMES.ycoding)).toBe(true)` |
| "addTheme keeps first current theme for duplicate names" — test/theme.test.ts:22 | `expect(addTheme(name, one)).toBe(true)` |
| "addTheme rejects non-current theme files" — test/theme.test.ts:32 | `expect(addTheme(name, { theme: { primary: "#ffffff" } })).toBe(false)` |
| "hasTheme checks theme presence" — test/theme.test.ts:38 | `expect(hasTheme(name)).toBe(false)` |
| "resolveTheme rejects circular current color references" — test/theme.test.ts:45 | `expect(() => resolveTheme(circular, "dark")).toThrow("Circular theme reference")` |
| "resolveTheme exposes the current flat component view" — test/theme.test.ts:63 | `expect(theme.primary).toBeDefined()` |
| "terminalMode derives mode from refreshed background" — test/theme.test.ts:92 | `expect(terminalMode(terminalColors("#fbf1c7"))).toBe("light")` |
| "terminalMode does not derive mode from ANSI slot zero" — test/theme.test.ts:97 | `expect(terminalMode(terminalColors(null, ["#000000"]))).toBeUndefined()` |
| "custom theme precedence follows directory order" — test/theme.test.ts:101 | `expect(discoverThemes([global, project])).resolves.toEqual({ custom: { source: "project" } })` |
| "theme directories include global config before project directories" — test/theme.test.ts:113 | `expect(discoverThemes(themeDirectories(global, project))).resolves.toEqual({` |

### test/theme/v2/component.test.ts (1 declarations/groups, 72 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "provides reactive properties, states, contexts, and color operations" — test/theme/v2/component.test.ts:10 | `expect(theme.text.default).toBe(resolved().text.default)` |

### test/theme/v2/resolve.test.ts (18 declarations/groups, 320 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "resolves one-mode files with defaults for the available mode" — test/theme/v2/resolve.test.ts:11 | `expect(resolvedLight.background.default.equals(resolveTheme(light).background.default)).toBeTrue()` |
| "rejects theme files without a mode" — test/theme/v2/resolve.test.ts:21 | `expect(() => resolveThemeFile({ version: 2 })).toThrow("Invalid theme")` |
| "validates and resolves categorical hues in configured order" — test/theme/v2/resolve.test.ts:26 | `expect(theme.categorical[0]).toBe(theme.hue.accent)` |
| "uses the default categorical order for direct definitions" — test/theme/v2/resolve.test.ts:43 | `expect(theme.categorical[0]).toBe(theme.hue.blue)` |
| "resolves independent definitions and hue aliases" — test/theme/v2/resolve.test.ts:50 | `expect(lightTheme.hue.accent).not.toBe(lightTheme.hue.blue)` |
| "resolves base hue aliases and rejects circular hue aliases" — test/theme/v2/resolve.test.ts:91 | `expect(aliased.hue.blue).not.toBe(aliased.hue.red)` |
| "steps by hue source when adjacent colors have equal values" — test/theme/v2/resolve.test.ts:115 | `expect(theme.hue.neutral[200]).not.toBe(theme.hue.neutral[300])` |
| "merges partial files with the selected YCoding defaults" — test/theme/v2/resolve.test.ts:134 | `expect(theme.text.default.toInts()).toEqual([18, 52, 86, 255])` |
| "expands user structural fallbacks before merging defaults" — test/theme/v2/resolve.test.ts:152 | `expect(expanded.background.action.primary.pressed.toInts()).toEqual([18, 52, 86, 255])` |
| "standalone themes skip YCoding defaults and use the red core fallback" — test/theme/v2/resolve.test.ts:183 | `expect(lightTheme.text.default.toInts()).toEqual([255, 0, 0, 255])` |
| "uses defaults for the selected mode when it merges the other mode" — test/theme/v2/resolve.test.ts:194 | `expect(theme.background.default.toInts()).toEqual(resolveTheme(dark).background.default.toInts())` |
| "resolves matched action variants and states" — test/theme/v2/resolve.test.ts:199 | `expect(theme.text.action.primary.pressed).toBeInstanceOf(RGBA)` |
| "resolves elevated hover surfaces from direct colors" — test/theme/v2/resolve.test.ts:212 | `expect(theme.contexts["@context:elevated"]?.background.default.toInts()).toEqual([18, 52, 86, 255])` |
| "resolves transparent colors" — test/theme/v2/resolve.test.ts:226 | `expect(theme.background.formfield.default.toInts()).toEqual([0, 0, 0, 0])` |
| "reports theme decoding failures as native errors" — test/theme/v2/resolve.test.ts:235 | `expect(() =>` |
| "context overrides rewire semantic references and apply state precedence" — test/theme/v2/resolve.test.ts:249 | `expect(overlay.text.default.toInts()).toEqual([51, 51, 51, 255])` |
| "rejects missing, base, and contextual reference cycles" — test/theme/v2/resolve.test.ts:272 | `expect(() => resolveTheme(override(light, { text: { default: "$missing" } }))).toThrow(` |
| "validates complete hues, resolved groups, and hue-only syntax" — test/theme/v2/resolve.test.ts:292 | `expect(() =>` |

### test/theme/v2/select.test.ts (6 declarations/groups, 71 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "requires and selects independent light and dark themes" — test/theme/v2/select.test.ts:13 | `expect(selectTheme(file)).toBe(light)` |
| "merges an expanded mode override over the other mode" — test/theme/v2/select.test.ts:21 | `expect(selected.hue).toBeDefined()` |
| "replaces categorical order in a merge mode" — test/theme/v2/select.test.ts:34 | `expect(selected.categorical).toEqual(["accent", "cyan"])` |
| "selects the available mode when the requested mode is missing" — test/theme/v2/select.test.ts:43 | `expect(themeModes(lightOnly)).toEqual(["light"])` |
| "rejects a merge mode without its base mode" — test/theme/v2/select.test.ts:55 | `expect(() => selectThemeMode({ version: 2, light: { mergeMode: true } })).toThrow(` |
| "rejects mutual mode merging" — test/theme/v2/select.test.ts:64 | `expect(() => selectTheme(file)).toThrow("cannot both merge")` |

### test/theme/v2/types.test.ts (1 declarations/groups, 75 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "supports property-first definitions, variants, states, and contexts" — test/theme/v2/types.test.ts:60 | `expect(text.action.primary.$hovered).toBe("$hue.neutral.200")` |

### test/tool-output-display.test.ts (7 declarations/groups, 55 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: production-source assertions need behavioral/render replacement.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "shows output within the preview budget without an expand affordance" — test/tool-output-display.test.ts:7 | `expect(toolOutputDisplay("done", false, 4, 80)).toEqual({` |
| "bounds output exceeding the preview budget and makes it expandable" — test/tool-output-display.test.ts:15 | `expect(display.visible).toBe(true)` |
| "shows complete output after expansion" — test/tool-output-display.test.ts:24 | `expect(toolOutputDisplay(output, true, 4, 80).output).toBe(output)` |
| "hides empty and whitespace-only output" — test/tool-output-display.test.ts:30 | `expect(toolOutputDisplay("", false, 4, 80).visible).toBe(false)` |
| "keeps error output visible" — test/tool-output-display.test.ts:35 | `expect(display.visible).toBe(true)` |
| "keeps loaded skill output collapsed until expansion" — test/tool-output-display.test.ts:42 | `expect(toolOutputDisplay(content, false, 4, 80).output).toBe("one\ntwo\nthree\nfour…")` |
| "renders expanded skill output in a focusable bounded scrollbox" — test/tool-output-display.test.ts:49 | `expect(sessionRoute).toContain("function SkillContent")` |

### test/ui/dialog-pattern.test.tsx (5 declarations/groups, 335 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "clamps the 98-column dialog panel across responsive widths" — test/ui/dialog-pattern.test.tsx:18 | `expect(panel.width).toBe(80)` |
| "renders select, confirm, and alert dialogs on the shared panel cell grid" — test/ui/dialog-pattern.test.tsx:35 | `expect(select.panel.width).toBe(98)` |
| "fills selected dialog bands across the compact 80-column panel" — test/ui/dialog-pattern.test.tsx:113 | `expect(snapshot.panel.width).toBe(80)` |
| "renders a full dialog panel with its selected model" — test/ui/dialog-pattern.test.tsx:129 | `expect(frame).toContain("Select model")` |
| "renders the variant glyph and label in toast titles" — test/ui/dialog-pattern.test.tsx:177 | `expect(frame).toContain("Success")` |

### test/ui/file-path.test.ts (8 declarations/groups, 52 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "keeps the full path when it fits" — test/ui/file-path.test.ts:7 | `expect(truncateFilePath(path, 37)).toBe(path)` |
| "adds nearest parent segments from right to left" — test/ui/file-path.test.ts:11 | `expect(truncateFilePath(path, 26)).toBe("…/src/ui/dialog-select.tsx")` |
| "preserves the extension when the basename must shrink" — test/ui/file-path.test.ts:17 | `expect(truncateFilePath(path, 16)).toBe("…/dialog-se….tsx")` |
| "preserves the input separator" — test/ui/file-path.test.ts:22 | `expect(truncateFilePath("packages\\tui\\src\\ui\\dialog-select.tsx", 22)).toBe("…\\ui\\dialog-select.tsx")` |
| "does not treat a backslash in a POSIX filename as a separator" — test/ui/file-path.test.ts:26 | `expect(truncateFilePath("dir/file\\name.ts", 14)).toBe("…/file\\name.ts")` |
| "preserves absolute roots" — test/ui/file-path.test.ts:30 | `expect(truncateFilePath("/file.ts", 7)).toBe("/fi….ts")` |
| "measures terminal columns without splitting graphemes" — test/ui/file-path.test.ts:40 | `expect(truncateFilePath("packages/组件/对话框.tsx", 12)).toBe("…/对话框.tsx")` |
| "never exceeds the requested width" — test/ui/file-path.test.ts:47 | `expect(Bun.stringWidth(truncateFilePath(path, width))).toBeLessThanOrEqual(width)` |

### test/ui/glyph.test.ts (1 declarations/groups, 23 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "provides the %s slot" — test/ui/glyph.test.ts:20 (table) | `expect(getGlyph(name)).toMatchObject({ glyph, rendered, color })` |

### test/ui/select-controller.test.ts (3 declarations/groups, 35 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "reconciles and moves selections with explicit boundary policy" — test/ui/select-controller.test.ts:9 | `expect([reconcileSelection(3, 0), reconcileSelection(4, 3), reconcileSelection(2, 6)]).toEqual([0, 2, 2])` |
| "reveals selections within bounded windows" — test/ui/select-controller.test.ts:19 | `expect([` |
| "keeps movement offsets and preview margins in bounds" — test/ui/select-controller.test.ts:28 | `expect([` |

### test/ui/state-glyph.test.tsx (1 declarations/groups, 76 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders state glyphs in an aligned leading column with selected-row contrast" — test/ui/state-glyph.test.tsx:15 | `expect(frame).toContain("✓")` |

### test/ui/toast-slot.test.tsx (7 declarations/groups, 458 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "renders an update availability notice with the manual update command" — test/ui/toast-slot.test.tsx:33 | `expect(app.captureCharFrame()).toContain("YCoding update available")` |
| "does not render an update toast when no update is available" — test/ui/toast-slot.test.tsx:63 | `expect(toast?.currentToast).toBeNull()` |
| "does not show an update toast after unmount" — test/ui/toast-slot.test.tsx:102 | `expect(toast?.currentToast).toBeNull()` |
| `renders the measured ${current.variant} toast treatment at ${viewport.width} columns` — test/ui/toast-slot.test.tsx:152 | `expect(toast.width).toBe(60)` |
| "keeps a capped toast on the physical right edge above the docked session rail" — test/ui/toast-slot.test.tsx:211 | `expect(railPlacement(width)).toBe("docked")` |
| "keeps the toast on the right margin when the route renders no rail" — test/ui/toast-slot.test.tsx:272 | `expect(railPlacement(width)).toBe("docked")` |
| "renders the full docked session route with a top-right toast over the rail" — test/ui/toast-slot.test.tsx:317 | `expect(screen.frame()).toContain("Provider usage refreshed")` |

### test/util/cache-diagnostics.test.ts (8 declarations/groups, 145 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "formats provider context and prompt cache diagnostics" — test/util/cache-diagnostics.test.ts:24 | `expect(formatCacheDiagnostics(diagnostics)).toEqual({` |
| "distinguishes missing provider telemetry from a confirmed zero" — test/util/cache-diagnostics.test.ts:32 | `No inline assertion; inspect called harness` |
| "handles missing limits and cache categories safely" — test/util/cache-diagnostics.test.ts:53 | `No inline assertion; inspect called harness` |
| "formats bounded local provider request diagnostics" — test/util/cache-diagnostics.test.ts:73 | `No inline assertion; inspect called harness` |
| "formats unavailable request pricing as an estimated zero" — test/util/cache-diagnostics.test.ts:103 | `expect(formatProviderRequestDiagnostics(base).estimatedCost).toBe("$0.0000")` |
| "labels cache reset diagnostics" — test/util/cache-diagnostics.test.ts:116 | `expect(formatProviderRequestDiagnostics({ ...base, latestInvalidation: "compaction-reset" }).latestInvalidation).toBe(` |
| "omits an unavailable diagnostics model without inventing a variant" — test/util/cache-diagnostics.test.ts:137 | `expect(formatDiagnosticsModel(undefined)).toBeUndefined()` |
| "formats provider, model, and variant identity exactly" — test/util/cache-diagnostics.test.ts:141 | `expect(formatDiagnosticsModel({ providerID: "anthropic", id: "claude-sonnet-4", variant: "thinking" })).toBe(` |

### test/util/connected-provider.test.ts (2 declarations/groups, 14 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "is false without integration credentials" — test/util/connected-provider.test.ts:5 | `expect(hasConnectedProvider([])).toBe(false)` |
| "is true after any provider integration is connected" — test/util/connected-provider.test.ts:10 | `expect(hasConnectedProvider([{ connections: [{ type: "credential", id: "cred_1", label: "Work", active: true }] }])).toBe(true)` |

### test/util/error.test.ts (7 declarations/groups, 90 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "formats native Error instances" — test/util/error.test.ts:5 | `expect(errorMessage(err)).toBe("boom")` |
| "extracts message from record-like values" — test/util/error.test.ts:16 | `expect(errorMessage(err)).toBe("bad input")` |
| "never returns bare {} for opaque object errors" — test/util/error.test.ts:25 | `expect(errorFormat({})).not.toBe("{}")` |
| "handles opaque throwables with custom toString" — test/util/error.test.ts:36 | `expect(errorMessage(err)).toBe("ResolveMessage: Cannot resolve module")` |
| "bare-brace prompt error surfaces diagnostic, not bare brace" — test/util/error.test.ts:50 | `expect(errorMessage("{")).not.toBe("{")` |
| "formats ModelSwitchBlockedError with token counts and no bare brace" — test/util/error.test.ts:55 | `expect(message).toContain("120000")` |
| "bare-brace wrapper does not bypass nested ConflictError message" — test/util/error.test.ts:78 | `expect(errorMessage(failure)).toContain("conflicts with an existing durable")` |

### test/util/filetype.test.ts (2 declarations/groups, 16 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "maps filenames to presentation languages" — test/util/filetype.test.ts:5 | `expect(filetype("component.tsx")).toBe("typescript")` |
| "uses none for missing filenames" — test/util/filetype.test.ts:12 | `expect(filetype()).toBe("none")` |

### test/util/form.test.ts (4 declarations/groups, 103 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "initializes configured and custom defaults" — test/util/form.test.ts:29 | `No inline assertion; inspect called harness` |
| "validates every supported field constraint" — test/util/form.test.ts:44 | `expect(formValidateValue(field, value)).toBe(error)` |
| "shares field classification, rows, selection, and display" — test/util/form.test.ts:76 | `expect([isFormAnswerField(text), isFormAnswerField(external)]).toEqual([true, false])` |
| "updates multiselects without mutating their source" — test/util/form.test.ts:97 | `expect(formToggleMultiselect(source, "one")).toEqual(["custom"])` |

### test/util/format.test.ts (7 declarations/groups, 60 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "returns empty string for zero or negative values" — test/util/format.test.ts:6 | `expect(formatDuration(0)).toBe("")` |
| "formats seconds under a minute" — test/util/format.test.ts:12 | `expect(formatDuration(1)).toBe("1s")` |
| "formats minutes under an hour" — test/util/format.test.ts:19 | `expect(formatDuration(60)).toBe("1m00s")` |
| "formats hours under a day" — test/util/format.test.ts:28 | `expect(formatDuration(3600)).toBe("1h")` |
| "formats days under a week" — test/util/format.test.ts:36 | `expect(formatDuration(86400)).toBe("~1 day")` |
| "formats weeks" — test/util/format.test.ts:43 | `expect(formatDuration(604800)).toBe("~1 week")` |
| "handles boundary values correctly" — test/util/format.test.ts:49 | `expect(formatDuration(59)).toBe("59s")` |

### test/util/locale.test.ts (3 declarations/groups, 21 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "truncates text from the right by terminal width" — test/util/locale.test.ts:4 | `expect(Locale.truncateWidth("abcdefgh", 5)).toBe("abcd…")` |
| "formats compact numbers with lowercase magnitude suffixes" — test/util/locale.test.ts:11 | `expect(Locale.number(1_200)).toBe("1.2k")` |
| "formats elapsed durations with compact whole-second tokens" — test/util/locale.test.ts:17 | `expect(Locale.duration(48_000)).toBe("48s")` |

### test/util/model.test.ts (5 declarations/groups, 49 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "splits provider from a nested model identifier" — test/util/model.test.ts:5 | `expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })` |
| "includes the selected variant in model refs" — test/util/model.test.ts:10 | `expect(formatRef({ providerID: "anthropic", id: "sonnet", variant: "thinking" })).toBe("anthropic/sonnet/thinking")` |
| "includes the selected variant in model switch notices" — test/util/model.test.ts:15 | `expect(switchLabel({ providerID: "anthropic", id: "sonnet", variant: "thinking" })).toBe(` |
| "uses the catalog display name in model switch notices" — test/util/model.test.ts:21 | `expect(switchLabel({ providerID: "openai", id: "gpt-5.5-fast", variant: "high" }, models)).toBe(` |
| "distinguishes variant-only switches from model switches" — test/util/model.test.ts:35 | `expect(switchLabel({ ...previous, variant: "high" }, undefined, previous)).toBe("Switched variant to high")` |

### test/util/path-format.test.ts (1 declarations/groups, 17 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "formats relative, home, and foreign paths" — test/util/path-format.test.ts:4 | `expect(formatPath(".", { base: "/work/project" })).toBe(".")` |

### test/util/permission.test.ts (2 declarations/groups, 29 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "preserves permission roots and self-contained metadata" — test/util/permission.test.ts:4 | `expect(permissionPresentation({ action: "external_directory", resources: ["/*"] }).title).toBe(` |
| "warns before granting selected Chrome site actions that can trigger downloads" — test/util/permission.test.ts:21 | `expect(view.title).toContain("example.test")` |

### test/util/presentation.test.ts (1 declarations/groups, 9 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "formats session continuation summary" — test/util/presentation.test.ts:4 | `expect(epilogue).toContain("A session")` |

### test/util/renderer.test.ts (2 declarations/groups, 30 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "clears the terminal title before destroying the renderer" — test/util/renderer.test.ts:4 | `expect(calls).toEqual(["title:", "destroy"])` |
| "still clears the title after renderer destruction" — test/util/renderer.test.ts:18 | `expect(calls).toEqual(["title:"])` |

### test/util/revert-diff.test.ts (1 declarations/groups, 35 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "prefers the actual file path over /dev/null for added and deleted files" — test/util/revert-diff.test.ts:5 | `expect(files).toEqual([` |

### test/util/selection.test.ts (5 declarations/groups, 66 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "Cmd+C copies an active selection on macOS" — test/util/selection.test.ts:38 | `expect(result).toEqual({ writes: ["selected"], cleared: 1, prevented: 1, stopped: 1 })` |
| "Ctrl+C copies an active selection outside macOS" — test/util/selection.test.ts:44 | `expect(result).toEqual({ writes: ["selected"], cleared: 1, prevented: 1, stopped: 1 })` |
| "Ctrl+C copies an active selection on macOS instead of reaching app exit" — test/util/selection.test.ts:50 | `expect(result).toEqual({ writes: ["selected"], cleared: 1, prevented: 1, stopped: 1 })` |
| "Escape clears an active selection without copying" — test/util/selection.test.ts:56 | `expect(result).toEqual({ writes: [], cleared: 1, prevented: 1, stopped: 1 })` |
| "selection handling ignores copy keys when no selection exists" — test/util/selection.test.ts:62 | `expect(result).toEqual({ writes: [], cleared: 0, prevented: 0, stopped: 0 })` |

### test/util/session.test.ts (1 declarations/groups, 10 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "recognizes generated parent and child titles" — test/util/session.test.ts:5 | `expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()` |

### test/util/thai-truncation.test.ts (3 declarations/groups, 30 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "truncate never isolates a Thai vowel or tone mark" — test/util/thai-truncation.test.ts:12 | `expect(orphanMark(Locale.truncate(value, len))).toEqual([])` |
| "truncateMiddle keeps whole graphemes at the cut" — test/util/thai-truncation.test.ts:22 | `expect(Locale.truncateMiddle("สวัสดีครับทุกคน", 10)).toBe("สวัสดีค…ทุกคน")` |
| "truncateWidth and collapsed tool output keep whole graphemes" — test/util/thai-truncation.test.ts:26 | `expect(orphanMark(Locale.truncateWidth("สวัสดีครับทุกคน", 10))).toEqual([])` |

### test/util/tool-display.test.ts (5 declarations/groups, 58 lines)

Layer: behavior/contract. Isolated duration: Not Run (except evidence below). Initial disposition: keep; reason: retain named observable guards pending redundancy review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "normalizes shared tool primitives" — test/util/tool-display.test.ts:10 | `expect(["bash", "task", "apply_patch", "plugin_tool"].map(canonicalToolName)).toEqual([` |
| "labels known providers" — test/util/tool-display.test.ts:23 | `expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")` |
| `uses the generic label for ${name}` — test/util/tool-display.test.ts:36 | `expect(webSearchProviderLabel(provider)).toBe("Web Search")` |
| "returns structured metadata for non-pending states" — test/util/tool-display.test.ts:43 | `expect(toolDisplayMetadata({ status: "running", structured })).toBe(structured)` |
| "does not expose pending or malformed metadata" — test/util/tool-display.test.ts:51 | `expect(toolDisplayMetadata({ status: "streaming", structured: { provider: "exa" } })).toEqual({})` |

### test/workspaces-screen.test.ts (9 declarations/groups, 434 lines)

Layer: component/application render. Isolated duration: Not Run (except evidence below). Initial disposition: rewrite; reason: timed synchronization needs event/state completion review.

| Case/group and surviving assertion location | Existing assertion (bounded excerpt) |
| --- | --- |
| "the palette opens a grouped workspace inventory with kinds, glyphs, counts, and details" — test/workspaces-screen.test.ts:133 | `expect(app.line("Workspaces")).toContain("5 loaded")` |
| "narrow terminals hide the details pane" — test/workspaces-screen.test.ts:186 | `expect(app.line("/tmp/wt/ycoding-feature")).toContain("copy")` |
| "selection near the end loads the next page once with the returned cursor and appends rows" — test/workspaces-screen.test.ts:198 | `expect(app.line("Workspaces")).toContain("12 loaded · more available")` |
| "search is debounced, sent to the server, and restarts from the first page" — test/workspaces-screen.test.ts:252 | `expect(searches).toEqual([null, "feature"])` |
| "ignores inventory responses from an outdated search generation" — test/workspaces-screen.test.ts:273 | `expect(app.frame()).toContain("/tmp/wt/ycoding-feature")` |
| "ignores recent-session responses for a workspace that is no longer selected" — test/workspaces-screen.test.ts:304 | `expect(app.frame()).not.toContain("Stale selection session")` |
| "forget confirms, deletes the directory record, and removes the row" — test/workspaces-screen.test.ts:341 | `expect(app.frame()).toContain("/tmp/elsewhere/ycoding-old")` |
| "delete copy needs a second press and removes the project copy row" — test/workspaces-screen.test.ts:371 | `expect(app.frame()).not.toContain("again to delete copy")` |
| "enter opens home so the next new session is created in the selected directory" — test/workspaces-screen.test.ts:404 | `expect(app.frame()).toContain("Search workspaces")` |
