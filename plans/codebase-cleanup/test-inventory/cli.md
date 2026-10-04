# SL CLI test inventory

Local working evidence; do not commit. Baseline is cleanup `1141158a` on main `c9a2957a`. The remaining CLI inventory is still being reviewed; no package-wide completion claim.

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
