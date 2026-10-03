# SL CLI test inventory

Earlier groups below were recorded on another machine at cleanup `1141158a`; the package-wide inventory and lane results at `d30e97bf` are in "Package-wide inventory at d30e97bf" at the end.

## Remote enrollment PTY group

Basis: `docs/configuration.md` remote enrollment; `packages/cli/src/remote-prompt.ts` hides TTY input, supports backspace/cancellation, restores the terminal, and trims piped input. SL requires deterministic success-path synchronization. These are real PTY/pipe integration cases, not mocked unit tests.

| File / case | Class | Retained observable assertion |
|---|---|---|
| `test/remote-prompt.integration.test.ts` — does not echo typed input and restores the terminal | rewrite | ECHO flag disabled before input; no typed secret before result; exact result; restored termios and successful exit |
| same — deletes the previous character on backspace | rewrite | exact edited result, restored termios, successful exit |
| same — cancels with a Canceled error on Ctrl-C and restores the terminal | rewrite | Canceled result, no success result, restored ECHO and termios, successful exit |
| same — reads a piped value to the end, trims it, and writes no prompt | keep | exact trimmed result, empty stderr, successful exit |

Replace three fixed 150 ms waits and 10 ms polling with a fixture readiness marker emitted only after the actual `readHidden` function has registered its listener and raw mode. Subscribe directly to real PTY output; reject pending waits on child exit/terminal close. Bun's existing 15 s test deadline remains the failure bound. No production behavior or assertion changes.

Baseline `bun test --cwd packages/cli test/remote-prompt.integration.test.ts --reporter=junit --reporter-outfile=<temporary-output>`: exit 0, 4 pass, 18 assertions, 1.135 s. First rewritten run failed because PTYs emit CRLF; readiness matching now uses the marker without assuming newline encoding. Revised check: exit 0, 4 pass, 18 assertions, 0.428 s. Three subsequent per-file runs: exit 0 each, 4 pass each, 0.446 / 0.424 / 0.420 s. Other lanes were active, so these timings are not exclusive-machine measurements.

Mutation probe: change `remote-prompt.ts` `stdin.setRawMode(true)` to `false`, then run `bun test --cwd packages/cli test/remote-prompt.integration.test.ts -t 'does not echo'`: exit 1, expected ECHO mismatch (expected 0, received 8), 1 fail, 3 filtered. Restore exact line; `git diff --exit-code -- packages/cli/src/remote-prompt.ts` exits 0 and all four cases pass. This proves the rewritten harness still detects loss of hidden input.

`bun run --cwd packages/cli typecheck`: exit 0. `bunx --no-install oxlint packages/cli/test/remote-prompt.integration.test.ts packages/cli/test/remote-prompt-pty.fixture.ts`: exit 0, zero warnings/errors.

Candidate loaded run: background package typecheck and PTY suite both exit 0 (4 pass, 18 assertions, 0.497 s), but notification order does not prove actual interval overlap. Do not count this as loaded evidence. Root lint exits 0 with 2,969 warnings and 0 errors; touched-file lint has zero warnings. Brand and Effect checks exit 0; `git diff --check` exits 0. Production file unchanged after probe.

Files/cases: 1 test + 1 fixture unchanged, 4 cases unchanged. Lines including fixture: 158 → 171. Functional/stability checks passed and the group was committed as `ecfaff06`; timestamp-proven loaded evidence is still required. The remaining CLI inventory is not complete.

## CLI file-separated baseline

46 test files in `packages/cli/test`, 400 runtime cases, all exit 0. Exact per-file command: `bun test --cwd packages/cli <relative-test-file> --timeout 30000 --reporter=junit --reporter-outfile=<temporary-output>`, sequential files under an 8 GiB process-tree cap and fresh config/data/state/cache/database paths per file. Sum of per-file process wall times: 203.031 s, with other lanes active. Separate `test-integration` files were not part of this baseline and remain required inventory. CLI release/security gates remain kept; individual redundant-group review continues. No package-wide completion claim.

## Owned transport deadline groups

`test/remote-compact.integration.test.ts`: rewrite the same case, retaining stable compaction ID, backend-derived Location headers, failed settlement reason and exact request bodies. Hold the real HTTP compaction response behind a Promise gate, wait for an ordinary keep-awake read's actual timeout, then release the response. This proves compaction outlives the ordinary budget without an arbitrary 70 ms fixture sleep. Baseline file 1 pass, 0.479 s. Revised initial 1 pass, 5 assertions, 0.308 s. Three final-shape per-file runs: 0.312 / 0.171 / 0.171 s, exit 0 each. Mutation using the ordinary timeout for compaction causes the required fulfilled outcome to be rejected; exit 1. Exact production line restored. Touched lint: two pre-existing warnings, zero errors.

`test/remote-goal-deadline.test.ts`: rewrite the same case, retaining both goal-only and mixed goal/YOLO acceptance plus refusal to extend the unrelated YOLO-only deadline. Wait until both actual goal requests reach the local HTTP fixture, hold them until the ordinary write times out, then release. The two table-shaped fulfilled outcomes retain both original assertions. Baseline file 1 pass, 0.487 s; initial revised 1 pass, 2 array assertions, 0.224 s. Mutating goal transport to the ordinary timeout makes both goal results reject, exit 1; exact production line restored. Touched lint zero warnings/errors. Final stability and loaded evidence pending.

`test/remote-scheduler.test.ts`: rewrite four existing cases. Retain control priority, two-event/one-bulk fairness, per-Session and response rotation, batch and serialized-size bounds, reset's unsent settlements, and stale-fence refusal. Runtime and installed `bun:test` declarations both expose Jest-compatible fake timers. Advance the real scheduler's external native timers deterministically and observe actual transmitted frames, replacing 5/100/60 ms success-path waits. Reset also asserts owned timers are cleared before advancing the clock. Baseline four cases, 0.358 s; initial revised four pass, 13 assertions, 0.128 s. Fairness mutation changes transmitted order and fails the retained exact vector; omitted reset timer cancellation fails the zero-owned-timer assertion. Both probes exit 1 and are precisely restored. Touched lint two existing warnings, zero errors. Final stability and loaded evidence pending.

The 03:12:55Z transport/recorder test loop did not overlap the parent typecheck's actual 03:12:23Z–03:12:42Z interval. It passed but is not loaded evidence; use explicit process intervals rather than delayed notifications.

## Retained relay connector groups at `7450b851`

Six tests remain distinct at their current assertion sites: `remote-bridge.test.ts` (51 cases) tests bridge-level operation/status forwarding; `remote-bridge-socket.test.ts` (1) tests a real socket boundary; `remote-connector.test.ts` (6) tests the connector's lifecycle; `remote-connector-lock.test.ts` (3) tests lock ownership; `remote-host.test.ts` (6) tests host startup and failure; and `remote-operations.test.ts` (90) tests backend-derived Session Location and operation mapping. Apparent overlap crosses different boundaries—lock primitive versus connector/host, status projection versus reconnect/dirty/retry, and fake bridge versus real socket—so no assertion was removed.

Focused per-file `bun test --cwd packages/cli ./test/<file>.test.ts --timeout 30000 --only-failures` across the six files: 157 pass, 0 fail. CLI typecheck exits 0; touched oxlint exits 0 with 37 warnings/0 errors in unchanged code; diff check exits 0 and the worktree remains clean. No mutation probe applied because no test changed. A live authenticated relay and broader integration suite were not run.

## Retained remote enrollment and transport groups at `7450b851`

Six more files remain distinct at their current assertion sites: `remote-config.test.ts` (4), `remote-credentials.test.ts` (11), `remote-device-access.test.ts` (2), `remote-node-transport.test.ts` (1), `remote-transport.test.ts` (5), and `remote-commands.test.ts` (8). Together these 31 cases guard secret material, persistence/challenge/refresh, enrolled ownership, Node and Bun transport boundaries, close/unknown outcomes, and command refusal. An unenrolled status read and refusal to contact a local server are separate observable effects; injected socket, real Bun socket, and Node subprocess checks do not replace one another.

Each file's focused `bun test --cwd packages/cli ./test/<file>.test.ts --timeout 120000 --only-failures` exits 0: 31 pass, 0 fail. No edits, mutation probe, or new package type/lint run were required; the prior CLI typecheck at the same HEAD exits 0, diff/status are clean. Live authenticated relay and wider integration gates remain unrun.

## Package-wide inventory at d30e97bf

Every `packages/cli` test is an always-kept release suite. Within that rule, this pass merged one duplicate CLI spawn and replaced the wall-clock waits that could make a correct implementation fail under load. No assertion was weakened, and no file or required behavior was removed.

Method: each file was run alone from `packages/cli` with `bun test ./<file> --timeout 30000 --reporter=junit`, serialized host-wide through the lane wrapper while other lanes were active (Linux x64, 4 CPUs). Wall times are per-file process times, not exclusive-machine measurements. The `remote-integration.test.ts` baseline came from an unmodified copy of the `d30e97bf` file, deleted afterwards.

### Before and after

| Measure | Before | After |
|---|---|---|
| Test files (`test/**` + `test-integration/`) | 46 + 1 | 46 + 1 |
| Cases (JUnit) | 400 + 1 | 399 + 1 |
| Lines, all files under `test/` and `test-integration/` | 12,094 | 12,023 |
| Summed isolated wall time | 325.7 s | 295.0 s |

The after wall sum uses, for each of the three touched files, the mean of its three isolated after-runs; the 44 untouched files keep their baseline times.

Environment-blocked on this Linux host (skipped, never counted as passing), six cases in total:

- `test-integration/node-build.test.ts`: macOS arm64 only.
- `computer-use-packaging.test.ts`: two darwin-only cases.
- `install-local.test.ts`: two darwin-only cases.
- `update.test.ts`: one darwin-only case.

### Per-file classification

| File | Cases | Behaviors guarded | Layer | Wall before | Class |
|---|---|---|---|---|---|
| `binary-name.test.ts` | 1 | Published binary names and the single bin wrapper | package contract | 0.2 s | keep |
| `chrome-extension-packaging.test.ts` | 6 | Extension files beside the executable; the v0.7.15 updater's exact archive list; bundling into `service-worker.js`; lifecycle and marker suite in the packaged worker | release packaging | 7.4 s | keep: release archive contract |
| `commands.test.ts` | 17 → 16 | Shipped TUI help; run help with `--model` and YOLO levels; invalid or missing `--yolo`; removed `--auto`; YOLO persisted before prompt admission; no prompt after a failed autonomy write; root `--model` routing | CLI subprocess against a local HTTP stand-in | 22.4 s | merge one row; rewrite process waits (below) |
| `computer-use-packaging.test.ts` | 9 (2 skipped) | Helper planning, signing identity, host availability, package verification | packaging unit; macOS build | 0.5 s | keep; macOS cases environment-blocked |
| `config.test.ts` | 3 | Obsolete `tui`/`kv` configuration ignored; updates do not read obsolete files; JSONC comments preserved | unit over files | 0.8 s | keep |
| `import-boundaries.test.ts` | 5 | Package entrypoints; current-only source denylist; run and Mini graph separation; standalone TUI artifact boundary; Mini independent of Core/Server/CLI | bundle graph + source scan | 2.9 s | keep. "keeps source current-only" is a source-text denylist, retained only because CLI suites are always kept. It is a candidate for the parent if that rule changes |
| `install-local.test.ts` | 6 (2 skipped) | Executable and extension installed together; an incomplete build leaves the previous install; macOS signed helper | unit over files | 0.5 s | keep; macOS cases environment-blocked |
| `mini-host.test.ts` | 7 | TTY ownership, controlling-terminal cleanup, signals, host capabilities | unit with injected host | 0.4 s | keep (reviewed group: mini/target/connection) |
| `mini.test.ts` | 12 | Mini input merge, replacement clients, target re-resolution, preview CLI `mini`/`run` help and exit codes | unit + CLI subprocess | 8.4 s | keep: the `src/index.ts` preview entrypoint is distinct from `commands.test.ts`'s `src/tui.ts` |
| `preload.test.ts` | 1 | The test preload isolates XDG data | harness guard | 0.3 s | keep: prevents writes to real user data |
| `remote-bridge-socket`, `remote-bridge`, `remote-connector`, `remote-connector-lock`, `remote-host`, `remote-operations` | 1, 51, 6, 3, 6, 90 | Relay connector (reviewed group above) | various | 0.5, 12.3, 0.7, 0.4, 2.1, 1.3 s | keep |
| `remote-config`, `remote-credentials`, `remote-device-access`, `remote-node-transport`, `remote-transport`, `remote-commands` | 4, 11, 2, 1, 5, 8 | Remote enrollment and transport (reviewed group above) | various | 0.5, 0.5, 3.6, 0.4, 0.3, 18.4 s | keep |
| `remote-prompt.integration.test.ts` | 4 | Hidden PTY input (reviewed group above) | PTY integration | 1.2 s | keep |
| `remote-compact.integration`, `remote-goal-deadline`, `remote-scheduler` | 1, 1, 4 | Transport deadlines and scheduler (reviewed group above) | local HTTP / fake timers | 0.5, 0.5, 0.3 s | keep |
| `remote-keep-awake.integration.test.ts` | 1 | Keep-awake uses authenticated global routes without Session or Location headers | local HTTP | 0.5 s | keep: remote envelope |
| `remote-diagnostics.test.ts` | 1 | The server-owned connector writes its diagnostic to the server log in service and stdio modes | subprocess | 7.7 s | keep |
| `remote-integration.test.ts` | 11 | Real server + connector: skill metadata admission, prompt reconciliation, activity ordering, goal deadline, authorized operations, guardrail replies through the root Session, shell output paging and Unicode | cross-component flow | 43.3 s | keep; rewrite the goal-deadline case (below) |
| `remote-push-burst.test.ts` | 1 | A fast provider stream keeps the explicit completion push without an idle alert | flow | 2.8 s | keep: regression |
| `remote-work-completion.integration.test.ts` | 1 | A task declaration and settled answer reach the completion API and one relay notice | flow | 3.7 s | keep |
| `remote-workspace.test.ts` | 1 | Backend Locations listed, created, adopted, and a root Session prompted | flow | 2.8 s | keep: backend-derived Location |
| `run/files.test.ts` | 2 | `-f` inputs become file URIs; directories rejected before admission | unit | 0.6 s | keep: CLI flag contract |
| `run/human-input.integration.test.ts` | 1 | Required human review stays pending and continues without a completion receipt | flow | 3.0 s | keep |
| `run/image-admission.integration.test.ts` | 2 | Image admission for file and data inputs (one table) | flow | 3.1 s | keep |
| `run/noninteractive.test.ts` | 13 | Non-interactive run refuses permission, question and guardrail blockers instead of approving them; form cancellation scope; step and failure output order and JSON shape | unit with SDK boundary stubs (request assertions) | 0.4 s | keep: permission trust boundary and output contract |
| `run/skill.integration.test.ts` | 3 | Explicit skills reach the first provider request; denied instructions cannot leak; unavailable skill content blocks the provider | flow with provider stand-in | 3.6 s | keep |
| `serve-shared.test.ts` | 1 | Bounded startup failure recorded for the parent | unit | 0.7 s | keep |
| `server-connection.test.ts` | 1 | Effect-native lifecycle grouping only for the managed service | unit | 0.7 s | keep |
| `service.test.ts` | 19 | Managed-service ports, filenames and channel isolation; preview registration migration; registration written once; owner stops when its registration is deleted, corrupted or replaced; clean shutdown; election among ten contenders without resuming suspended Sessions; an unterminated execution settled as failed; port override; conflict reporting; incumbent recognition during the bind race; stale registration replacement; a failed service keeps its port | real subprocesses | 125.9 s | keep; rewrite exit races (below) |
| `session-target.test.ts` | 4 | Explicit Session adoption, implicit workspace pagination, fresh Session Location, no retry of ambiguous creation | unit with stub client | 0.4 s | keep |
| `standalone.test.ts` | 1 | A standalone server exits when its owner is killed | subprocess | 5.6 s | keep. It polls a non-child PID, for which no exit event exists. The 5 s attempt bound lets a failing run still kill the server in `finally` |
| `tui-entrypoint.test.ts` | 2 | Service and remote subcommands registered and dispatched without starting a server | CLI subprocess | 6.0 s | keep |
| `update-handler`, `update-progress`, `update` | 11, 5, 54 (1 skipped) | Updater (reviewed group) | unit + subprocess | 26.1, 0.2, 0.9 s | keep |
| `test-integration/node-build.test.ts` | 1 (skipped) | macOS Node build with signed computer app and attention sounds | packaged build | 0.2 s | keep; environment-blocked on Linux |

### Changes and retained assertions

| Change | Retained behavior → surviving assertion |
|---|---|
| `commands.test.ts`: the `["run"]` help row ("Run YCoding with a message", `--model`) merged into the run help case, which spawned the same `run --help` | Same two `toContain` assertions, now in "run help describes the command, exposes --model and the durable YOLO levels, and removes --auto" |
| `commands.test.ts`: `Bun.spawnSync(..., { timeout: 10_000 })` and `setTimeout(() => child.kill(), 10_000)` replaced by one `spawnCli` helper that awaits the real process exit. The file's 30 s test timeout bounds the wait, and the helper kills the child in `finally` | Every exit-code and output assertion is unchanged. Before the rewrite, the loaded run failed "root --model forwards the prompt and session through the run transport" (`Expected: 1, Received: 130`, 14.4 s): the 10 s kill timer fired under load. With the `spawnSync` timeouts, a killed process also satisfied the `not.toBe(0)` checks for invalid `--yolo` values; awaiting the real exit removes that false pass |
| `remote-integration.test.ts`: "two delayed goal model calls cross the ordinary connector deadline" took 31 s (two 15.5 s provider delays against the 30 s default) | The connector's `createLocalServer` gets an explicit ordinary `timeoutMs` of 5 s, and each provider call is delayed 2.6 s. The goal operation still settles successfully after more than the ordinary deadline (`Date.now() - started > ordinaryTimeoutMs`), still makes exactly two provider requests, and still returns the active goal. Under load, elapsed time only grows, and the goal deadline is 5 minutes |
| `service.test.ts`: `Promise.race([exited, Bun.sleep(10–60 s)])` and the `waitForExit` helper replaced by awaiting the actual process exit or recognition promise, bounded by each test's timeout | Exit codes (`0`, `1`), registration contents, port availability and loser output assertions are unchanged. The always-true check on the losers' `exited` array became a tautology once each exit is awaited, so it is removed; the per-loser exit-code check remains |

Retained timing, with reasons:

- `service.test.ts` "writes its registration once" keeps its 6 s observation across the 5 s ownership poll. No event exists for a write that must not happen, and a correct implementation passes at any load.
- `service.test.ts` keeps the 8 s positioning delay in "port contender recognizes an incumbent registered during the bind race". It places the registration late in production's 15 s recognition window, and removing it would weaken the late-registration coverage.
- `service.test.ts` keeps its 250 ms negative wait before checking that suspended Sessions were not resumed.
- The attempt-bounded registration and health polls (`waitForInfo`, `waitForReady`, `waitForFailed`) are kept. They count attempts, not wall time.
- The `waitFor` state polls in the remote integration files have 15–30 s deadlines. They await actual relay or store state and passed the loaded runs.
- The 15–20 s conflict cases are kept. They wait for production's own `recognizeIncumbent` 15 s timeout inside a child process, which a test clock cannot drive.

### Mutation probes

For each probe, the guarded production line was mutated and the retained test was run. The line was then restored with `git checkout -- <file>`, and `git diff --exit-code` on the production file exited 0.

| Production line | Mutation | Retained test result |
|---|---|---|
| `src/commands/run.ts:16` description "Run YCoding with a message" | changed text | the merged run help case fails, exit 1 |
| `src/remote-local.ts:365` goal deadline `RemoteLimits.goalSetTimeoutMs` | ordinary `timeoutMs` | "two delayed goal model calls cross the ordinary connector deadline" fails after 5.7 s with `goal operation failed: outcome_unknown`, exit 1 |
| `src/server-process.ts:221` `Effect.andThen(shutdown)` on registration loss | `Effect.andThen(Effect.void)` | "deleting a managed service registration stops its owner" times out at 30 s, exit 1. Afterwards no orphan owner process remained |

### Stability

Three isolated per-file runs and one loaded run per touched file, all exit 0 with JUnit `failures="0"`:

- `commands.test.ts` (16 cases): isolated 20.99 / 20.60 / 19.71 s. Loaded 2026-10-03T15:19:42Z–15:20:48Z, 65.6 s, with 10 `tsgo`/`turbo` processes still running at file end.
- `remote-integration.test.ts` (11 cases): isolated 17.57 / 17.90 / 17.67 s (43.3 s before). Loaded 2026-10-03T15:01:34Z–15:02:04Z, 30.2 s, with 8 typecheck processes at file end.
- `service.test.ts` (19 cases): isolated 116.4 (bun-reported) / 125.3 / 126.5 s. Loaded 2026-10-03T15:47:16Z–15:50:10Z, 174.3 s. The forced typecheck started 5 s before the file; no typecheck process remained at file end, so overlap covers only the first part of this 174 s run (the run was 39% slower than isolated).

The earlier loaded run of the pre-rewrite `commands.test.ts` (2026-10-03T15:00:24Z–15:01:34Z) is the failure recorded above.

### Checks

- `bun run --cwd packages/cli typecheck` (wrapper): exit 0.
- `bunx --no-install oxlint -f unix` on the three touched CLI files: exit 0. 36 warnings, 0 errors, none on a changed line.
- `bun run lint:effect-patterns` (wrapper): exit 0.
- The node-build integration and the macOS-only cases were not run on this Linux host (environment-blocked, see above). No live authenticated relay was used.
- Production files are unchanged after all probes.
