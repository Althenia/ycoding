# Rust beta continuation

Recorded: 2026-10-17. Target version: `0.11.0-beta.1`.

## Main behavior reconciled into native beta (2026-10-17)

This section supersedes the historical main-integration and publication-scope
statements below. The durable prior handoff was restored with exact tree
`6653a2bbfc2d457e8bb2c53e9156e8cdfeef2979`, then main was audited through
`1783930b81144a13e5259c50a9b722c9979a8ee9` (v0.10.14). All 43 first-parent
commits and four merged child commits were classified against the native beta.
The user authorized reconciling main and publishing to remote `beta` or opening
a PR. That authorization does not include merging main, tagging, releasing,
deploying, remote migrations, secret changes, or live-beta acceptance.

The native Rust/Store/revision-5 runtime remains authoritative. Reconciled
behavior includes dedicated Usage presentation, transcript cost-section removal,
machine-wide shell queue retirement, native shared-context snapshots and family
cache partitioning, effort-only prompt-cache continuity, question timeout and
automatic-answer provenance, built-in guidance, and Meeting lifecycle/evidence
updates. Retired wire fields, enum values, and events are reserved, not reused.
The canceled Task MCP endpoint/setup/OAuth/tunnel work remains excluded (main
commits `6720fa01` and `53f98d5e`); existing native MCP client behavior is preserved.

Fresh verification and remaining gates are recorded in the accompanying portable
verification report. The historical 475/479 native target count below predates
this reconciliation and is not acceptance for the new changes. Fresh focused
native suites include 210 workspace library tests, 234 orchestration/audit tests,
and 351 shell/usage/guardrail cases; these groups include documented overlap.
All-target Clippy passes with warnings denied. Real native/client fixtures pass.
Optimized CLI and TUI production graphs pass, followed by both real packaged
TUI/runtime smokes. The owning CLI suite passes 323 cases with 8 guarded skips;
skipped platform/packaged gates do not count as acceptance.
The isolated packaged-browser harness now uses revision-5 client contracts;
21 focused lifecycle/environment cases pass, with real Chrome acceptance pending.
Whole-workspace and whole-package integration checks must be interpreted from
their latest reported command results, never from an earlier handoff count.

Fresh capability-gated reruns compiled all four targets: 15 cases passed and
8 failed because this cloud sandbox rejects Unix sockets or workerd network
interface enumeration. These failures remain acceptance gaps, not ignored tests.

Remaining external gates include cloud-blocked Unix-socket/browser tests,
macOS Chrome/extension and Safari rendering, native Windows stale-PID execution,
macOS ARM64 three-release updater behavior, and separately authorized live-beta
acceptance. Session-family price discovery also retains an O(retained family
request history) prepass; global dated discovery uses the existing time index.
The local continuation prompt identifies the exact commands and boundaries.

The original interrupted operation remains human-only. Neither these changes nor
fresh isolated tests authorize replay. Inspect the original action and actual
human decision using the preserved task/recovery/question identifiers below.

## Historical pre-reconciliation Linux continuation (2026-10-17)

This continuation started from a separate clone of `stage-3d14` at
`bf3358ec98096d936a86361637741588574fea4b`. That commit already contains the
migration described as uncommitted in the original handoff below. The original
checkout and recovery item have not been resumed or changed. The user authorized
continuation, pinned tool installation, and the existing JPEG decoder's
platform-independent feature; publication and deployment remain separate.

Confirmed corrections include the web type errors, explicit operation identities
and role allocations, the missing incident fixture table, predecessor backup
inspection without mutating its evidence, Meeting's mutating Bun partial matcher,
and asynchronous cancellation receipt settlement. Linux-specific fixture repairs
preserve exact guardrail, ownership, and persistence assertions. Native JPEG
normalization now matches the unchanged npm/WASM byte oracle. Unix PTY writes
return `BrokenPipe` on sticky write-closed readiness instead of starving runtime
expiry and shutdown.
Usage reports keep their five-second deadline with an explicit cross join that
correctly associates correlated enrichment with request rows. The SQLite parity
harness explicitly enables immutable URI reads on Linux while preserving
read-only access, lossless integers, source hashes, and WAL/SHM bytes.
Cursor's native HTTP/2 transport enables low-latency TCP writes; oversized-image
fixtures recognize exact heartbeat frames without relaxing refusal assertions.

Current verification is not a final release pass:

- All 18 workspace typecheck tasks passed, including web.
- The rebuilt native runtime passed real TypeScript client interoperability.
  Cloudflare generated types and all 51 Worker typecheck files passed. Type-aware
  lint completed with 0 errors and 3,480 warnings; effect-pattern and lint-rule
  checks passed. Client unit tests: 216 passed; Protocol: 413; Schema: 156;
  Chrome extension: 46; Meeting: 41; goal/autonomy: 86. Web source: 1,089 passed.
  Web build and both stable/beta Worker dry-run builds passed; neither deploys.
- Focused protocol targets passed; all 52 launcher tests and the original runtime
  handoff failure targets passed. Runtime library rerun: 103 passed; configuration
  operations: 2 passed. MCP/extension repair targets: 65 passed. Core policy,
  precision, image, and discovery repair targets: 66 passed. PTY platform: 4 passed.
- All six workspace libraries passed (204 tests). Usage read/dimension suites:
  46 passed. Shell lifetime: 15 passed. TypeScript baseline/immutable-read checks:
  12 passed with 947 assertions; durable Store: 29 passed, two subprocess-only
  helpers ignored. Native report stack/depth checks: two passed, including
  deadline-free completion at the selected depth. Formatting and all-target
  Clippy with warnings denied passed. The Linux/Darwin `openpty` declaration
  difference uses an explicit raw mutable pointer accepted by both signatures.
- Dependency direction and complete license closure passed after the decoder
  feature change; no package versions or checksums changed.
- A single workspace test invocation exhausted this executor's 32 GiB disk while
  linking test executables. Reproducible integration executables were reclaimed,
  preserving source, dependency caches, runtime, and verification logs. The same
  target inventory was tested serially with executable reclamation after
  each target, a 6 GiB process-tree cap, and a 900-second per-target watchdog.
- A fresh current-tree sweep completed after all native/schema repairs:
  475 of 479 target records pass across 451 successful grouped commands.
  The three Cursor repair targets retain their original deadlines and byte
  limits. Existing ignored native/browser and subprocess-helper tests remain
  ignored and are not acceptance evidence. Four targets require executor
  capabilities unavailable in the normal sandbox: runtime `connector_relay`
  (local Worker network-interface enumeration), and Core `computer_client`,
  `computer_service`, and `extension_activation` (local Unix-domain sockets).
  These are not passing tests. No assertion or product behavior was relaxed to
  work around the restrictions. The normal supported escalation also failed
  before launching the tests because the executor could not create its session
  path on a read-only filesystem. Their unchanged capability failures were
  carried explicitly as blocked in the final sweep, not rerun or counted passing.
- Fresh Linux x86_64 optimized release build passed (60m47s, 5,761 MiB peak).
  Packaged TUI and runtime smokes passed, as did both packaged launcher tests
  (27 assertions), including crash persistence and shutdown interruption.
  Shipped TUI, CLI, and web graph checks passed. Uncompressed release runtime:
  187,426,296 bytes; packaged TUI: 689,412,064 bytes; CLI: 690,968,544 bytes.
  The runtime is embedded in each package, so these sizes are not additive.
  The native runtime is optimized and unstripped, not a debug-size estimate.
  The workflow-equivalent Linux tar.gz is 237,454,475 bytes (226.5 MiB), with
  exact executable/extension entries verified; source executables were unchanged.
  Post-contract workspace/Worker types, lint (0 errors, 3,480 warnings), and
  all 216 Client tests passed. Full CLI: 303 passed, eight platform skips.
  Final full TUI: 2,023 passed, both snapshots, 67,238 assertions. Its earlier
  GC-sensitive signal test was replaced by deterministic all-100 abort and fresh
  episode admission checks; missing-abort/deletion mutations both fail. No
  notification production source changed. Native Windows, macOS browser, Safari,
  and the macOS-only three-release updater acceptance remain required.
- Final remote/Worker/web integration runs found incomplete wire parity for the
  `Status.lost` 500-item cap, `session.status` loss classification, team-shell
  queue positions, and named Incident payload exports. These now pass with their
  owning schemas/generators and native producers: Protocol 413, Remote 196,
  Worker 207; native wire 15, connector status 5, remote-derived 16, and Session
  list 11. Repeated generation is stable; operation/event identities and roles
  are unchanged, and all 95 golden vectors differ only by the new contract digest
  in eight handshake rows. An inactive lost root with a real pending Form stays
  actionable until that Form settles. Final isolated web integration passed all
  516 tests and 2,231 assertions across 31 files. Subscription-refusal fixtures
  use the native operation's declared rejection; notice tests wait for observed
  status delivery without changing opt-in or ownership assertions.

The original human-only recovery boundary below remains unresolved. Fresh static
source repairs and isolated tests do not settle that interrupted operation.

### Final local verification and remaining acceptance

After the final test-only correction, all-target Clippy (`-D warnings`), formatting,
TUI typecheck, real TypeScript/Rust socket interoperability, workspace boundaries,
and Rust license closure passed. Installer/release/build-assets/CI/browser-host
contract tests passed 135 tests with ten platform skips and 717 assertions.
Final type-aware lint passed with zero errors and 3,480 warnings. The complete
tracked and untracked change set was reviewed; generated build/cache artifacts
and raw verification logs are excluded from the source change.

The Linux implementation and runnable checks are complete. This is not release or
merge approval. Remaining gates/decisions are:

1. Run the four named blocked native targets in an executor supporting local Unix
   sockets and Worker network-interface enumeration. Do not waive assertions.
2. Run the approved native Windows stale-PID acceptance and macOS Chrome 152+
   source/packaged browser and extension checks. The composed remote flow also
   launches headed macOS Chrome for push acceptance; Linux fixture tests are not
   a substitute.
3. Complete Safari rendered acceptance and the macOS-arm64 three-release updater
   acceptance under their documented platform constraints.
4. Resolve the original human-only recovery item using its original record. Its
   task/review/question identifiers are preserved below; the interrupted action
   itself is not available in this clone and must not be guessed or replayed.
5. Reconcile current-main changes, especially shell-queue UI removal, before
   integration. Obtain approval before publishing, merging, tagging, deploying,
   remote migrations, secret changes, or live beta resource acceptance.

The local Linux archive uses the existing release packaging format and contains
only `ycoding` and `ycoding-chrome-extension`. Its SHA-256 is
`d234719de725e65d282e0a1c4b6f1672289738d0a9a8f3923a5e097faf6048eb`.
It remains a local verification artifact; no release, upload, or deployment was
performed. Existing source history, Git identity, and hooks are preserved.

### Upstream integration decision

The user separately removed the shell-queue UI on current `main` for `0.10.14`.
This older handoff branch retains its existing queue-position contract; migration
parity repairs here do not authorize restoring the removed UI when integrating
with `main`. Reconcile that divergence explicitly before merge. This continuation
has not merged `main` or expanded the queue removal into the Rust branch.

### Portable fixture prerequisites

Use the direct installed Cargo toolchain, the pinned `PROTOC`, one build job, and
this clone's own target directory. MCP tests support `YCODING_MCP_SERVER_ROOT`
pointing at the installed locked server package and `YCODING_MCP_FIXTURE_REF`
pointing at a verified committed fixture source (this continuation verified
`bf3358ec98096d936a86361637741588574fea4b`). The real repository-policy test accepts
`YCODING_TEST_POLICY_ROOT` when Cargo's target directory is inside a globally
exempt temporary root; the test verifies the selected root through the actual
classifier. Do not remove ambient ancestor repositories or configuration folders
to make fixture assertions pass.

The sections below preserve the original handoff evidence and remaining external
requirements; their historical checkout/tool paths are not this clone's state.

## Original handoff record

The following sections preserve the original handoff for traceability. Current
Linux results above supersede its stale error/verification status. The human-only
recovery boundary and external/native-platform acceptance requirements remain
active; fresh isolated tests do not resolve them.

### Checkout and delivery state

- Continue in `.worktrees/stage-3d14` from the outer repository root. All paths below are relative to that worktree unless stated otherwise.
- Working branch: `stage-3d14`; committed HEAD: `00de646aaeefdb6b47c2cc76d1dd4cf06fb4f525`.
- Scope baseline: main `f59eae9c8a18369301344a5f12c91772b50b7f18`. Preserve the current migration scope and defer unrelated work.
- The migration includes substantial uncommitted tracked changes and untracked source files. Preserve both; a patch containing only `git diff` would omit the untracked files.
- The outer checkout is on `feature/redesign-usage-view`, not the migration branch. Do not switch or overwrite it.
- No local `beta` ref or `origin/beta` tracking ref was present. `git ls-remote --heads origin refs/heads/beta` completed successfully with no matching remote branch.
- Commit and push are blocked by failing and unfinished required checks. No checkpoint commit, beta push, release tag, or deployment was performed for this handoff.
- Autonomous implementation is stopped. Resume deliberately after reading this file and checking live state.

## Working implementation

The checkout contains the Rust runtime and revision 5 client migration, native autonomy and review handling, managed-child recovery, shell queue and process lifecycle, model fallback, incident services, retained usage, predecessor imports, and Meeting integration. Focused checks have covered these areas, but the final Rust run below found additional failures. Do not infer complete native coverage from the passing client suites.

The fresh macOS ARM64 beta artifact passed packaged TUI and runtime smoke checks. The runtime smoke covered authentication, archive and autonomy round-trips, goal completion, child cancellation, tools, cache accounting, and OpenAI fallback.

Local executable:

```text
.cache/beta-packaged-9JUaNc/artifact/tui-darwin-arm64/bin/ycoding
```

The debug runtime was rebuilt at `rust/target/debug/ycoding-runtime`. Native bytecode-build verification and the macOS Node CLI build/smoke also passed with the direct Rust toolchain on PATH.

## Verified results

Local evidence directories are ignored artifacts, not portable Git deliverables. The summaries here remain useful if those directories are unavailable.

| Check                                                                                            | Result                                                                                                                      | Evidence                                                              |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `bun run --cwd packages/tui test`                                                                | 2,023 passed, 0 failed; 279 files                                                                                           | `.cache/beta-integration-final-NevnNC/tui.log`, `tui.exit`            |
| `bun test --cwd packages/cli --timeout 30000` with direct Cargo on PATH                          | 309 passed, 2 skipped, 0 failed; 53 files                                                                                   | `.cache/beta-cli-final-nFyrth/`                                       |
| TUI typecheck                                                                                    | 723 files passed                                                                                                            | `.cache/tui-last-four-green-7LFIE6/`                                  |
| CLI typecheck                                                                                    | 586 files passed                                                                                                            | `.cache/beta-cli-refusal-green-D943mj/`                               |
| Non-web workspace typechecks                                                                     | Other scheduled packages passed; some dependency results were Turbo cache hits. CLI subsequently passed after fixture fixes | `.cache/beta-remaining-types-7jVgfm/types.log` and CLI evidence above |
| Cloudflare generated types and typecheck                                                         | Current generated types; 51 files passed                                                                                    | `.cache/beta-integration-final-NevnNC/cloudflare-types.log`           |
| Typecheck-cache integration                                                                      | 5 passed                                                                                                                    | `.cache/beta-remaining-types-7jVgfm/typecheck-cache.log`              |
| Effect-pattern lint                                                                              | Passed                                                                                                                      | `.cache/beta-remaining-types-7jVgfm/effect.log`                       |
| Workspace and brand checks                                                                       | Passed                                                                                                                      | `.cache/beta-static-final-QSCMwK/workspace.exit`, `brand.exit`        |
| Rust notice tests                                                                                | 50 passed                                                                                                                   | `.cache/beta-notice-tests-q2eU7O/`                                    |
| Release and Rust CI contract tests                                                               | 74 passed                                                                                                                   | `.cache/beta-release-contracts-F83Kfq/`                               |
| Web asset publisher tests                                                                        | 6 passed                                                                                                                    | `.cache/beta-web-assets-wRXfrV/`                                      |
| Rust dependency/license boundary                                                                 | Passed                                                                                                                      | `.cache/beta-rust-final-bRMphh/boundary.exit`                         |
| `cargo fmt --manifest-path rust/Cargo.toml --all -- --check`                                     | Passed                                                                                                                      | `.cache/beta-rust-final-bRMphh/format.exit`                           |
| `cargo clippy --locked --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings` | Passed                                                                                                                      | `.cache/beta-rust-final-bRMphh/clippy.exit`                           |
| Final Rust workspace tests                                                                       | Cancelled after recording failures; no successful final exit                                                                | `.cache/beta-rust-final-bRMphh/tests.log`                             |

The two skipped CLI tests require explicit packaged-release inputs:

- `packages/cli/test/rust-launcher.integration.test.ts`: fresh packaged root/child execution, crash persistence, and shutdown interruption.
- `packages/cli/test/rust-update.integration.test.ts`: busy/forced updates and enrolled workerd connector lifecycle; requires three packaged releases.

The packaged smokes are separate evidence, not substitutes for these skipped scenarios.

## Remaining Rust failures

The cancelled `--workspace --no-fail-fast` run recorded at least nine failures across eight targets. Reproduce each target before modifying implementation or expectations. The run ended during Store import tests; absence of further failures is not a pass.

| Package / target                            | Observed failure                                                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ycoding-core` / `session_review`           | `guardrail_decisions_grant_once_record_family_directories_and_reject_hard_always`: `Store(UnregisteredTable("model_incident"))` at `rust/crates/core/tests/session_review.rs:1103`                                           |
| `ycoding-protocol` / `operation_generation` | Descriptor membership assertion: 231 versus 227, at `rust/crates/protocol/tests/operation_generation.rs:170`                                                                                                                 |
| `ycoding-protocol` / `wire_connector`       | Role allowlist assertion: 79 versus 76, at `rust/crates/protocol/tests/wire_connector.rs:199`                                                                                                                                |
| `ycoding-runtime` / `coverage_manifest`     | Two coverage assertions: 231 versus 227 and 83 versus 80, at `rust/crates/runtime/tests/coverage_manifest.rs:62,126`                                                                                                         |
| `ycoding-runtime` / `launcher`              | `startup_upgrades_recognized_native_catalogs_and_preserves_the_first_copy`: byte equality assertion failed at `rust/crates/runtime/tests/launcher.rs:203`                                                                    |
| `ycoding-runtime` / `meeting_clients`       | `packaged_runtime_serves_the_existing_meeting_clients_without_adjacent_assets`: nested Meeting bridge test failed its saved analysis-model assertion in `extensions/meeting/test/rust-bridge-client.integration.test.tsx:76` |
| `ycoding-runtime` / `production`            | `disk_configuration_composes_location_helpers`: expected instruction text missing, at `rust/crates/runtime/tests/production.rs:1353`                                                                                         |
| `ycoding-runtime` / `socket`                | `every_local_operation_answers_with_a_declared_typed_outcome`: actual and expected operation inventories differ, at `rust/crates/runtime/tests/socket.rs:780`                                                                |

Audit descriptor membership and role allocation by operation identity, not by replacing expected counts with observed counts. Preserve predecessor backup, source-data, human-review, and ownership assertions.

## Remaining web errors and recovery boundary

The full workspace typecheck failed with 16 errors in seven files:

| File                                                     | Observed errors                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/web/src/remote/store.ts:4479,4868`                 | Optional calls narrowed to `never`                                           |
| `apps/web/src/remote/ui/subagent-bar.tsx:15,23`          | Duplicate `speed` identifier                                                 |
| `apps/web/test/remote-team.test.ts:117`                  | `.ok` accessed without narrowing all reply variants                          |
| `apps/web/test/session-list-double.ts:106,109,166`       | Broad strings assigned to closed unions; possibly undefined Session Location |
| `apps/web/verify/incident-usage.integration.test.ts:194` | Missing `page_has` name                                                      |
| `apps/web/verify/remote-fixture.tsx:10,29,39,61`         | Duplicate `accountedTask` identifier and function implementation             |
| `apps/web/verify/transcript-fixture.tsx:7,21`            | Duplicate `accountedTask` identifier                                         |

Evidence: `.cache/beta-integration-final-NevnNC/types.log`. Line numbers may move.

The web recovery task remains stopped after an interrupted tool call with uncertain effects. Its continuation requires the existing human-only recovery decision; do not resume it through automatic answers, replay its tool call, or substitute another execution path for that decision.

- Task: `ses_task_f747cbc83144fce0c16365be`
- Recovery item: `rvw_1479f3b3f0011mLlMEiooDvY1F`
- Question: `qst_1035db46106320d57351797e`

After that boundary is resolved, verify current source before edits and finish web approval, review, sleep, lost-result, connection-lifetime, and rendered acceptance. Earlier passing web logs predate this final state and do not clear the current errors.

## Other outstanding gates

- Type-aware lint: the first attempt exceeded 3 GiB. A single-threaded retry with a 6 GiB cap was cancelled during lint. Leave it stopped until continuation is authorized. There is no passing final lint result; effect-pattern lint passed separately.
- Complete final native/client interoperability, relay flow, Worker, installer, Chrome extension, and browser checks required by `.github/workflows/release.yml`. Reuse evidence only when its inputs match; do not promote older logs to final-state passes.
- Native Windows process acceptance remains required. Its approved workflow gate must observe the named stale-PID test actually running; cross-compilation or static workflow tests are insufficient.
- Safari acceptance remains pending. Follow `apps/web/AGENTS.md`: fresh web build, one Safari driver, Remote Automation enabled, and bounded document-readiness observation. Do not hide `no such window` failures with retries or replacement sessions.
- Beta Worker configuration and live acceptance remain separate approved external operations. The configured beta hostname failed local DNS resolution during the final read-only probe. Verify live resources, bindings, migration state, and secret names; repository configuration alone is not deployment evidence.
- Obtain separate approval for deployment, remote migrations, secret changes, or tags. A branch push does not authorize these operations.
- Non-Unix queue-directory replacement identity fencing is deferred and documented. It does not waive native Windows acceptance.

## Recent verified corrections to preserve

- `packages/tui/test/screen/subagent-answer.screen.test.tsx`: child guardrail status identifies the parent family; approval precedence and no-write assertions remain.
- `packages/tui/test/screen/screen-colour-probe.test.tsx`: explicit fixture model selection and a bounded footer-band locator; colour and ordering assertions remain.
- `packages/tui/test/cli/tui/metadata-residency.test.tsx`: exact refreshed endpoints include guardrail status; cache-size bounds remain.
- `packages/cli/test/run/noninteractive.test.ts`: live-only tool progress has no durable envelope.
- `packages/cli/test/runtime-build.test.ts`: captured environment values may be absent; Cargo metadata selects the runtime artifact.
- `packages/cli/test/service.test.ts`: explicitly selects the synthetic corrupt store and clears inherited SQLite import configuration; verifies refusal without changing the corrupt file.

## Continuation commands and resource limits

Run commands from the migration worktree. Run at most one heavy check at a time through the verification queue. Do not restart cancelled work automatically.

The `mise` Cargo shim failed when tests isolated XDG paths because its configuration was not trusted in that environment. The installed rustup Cargo worked without changing trust settings:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export PROTOC="${PROTOC:-$(command -v protoc)}"
export CARGO_BUILD_JOBS=1
export CARGO_TARGET_DIR="$PWD/rust/target"
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_TEST_DEBUG=0
export CARGO_INCREMENTAL=0
export RUST_TEST_THREADS=2
```

Verify `PROTOC` for another machine. Keep Cargo output in this worktree; do not borrow another worktree's generated bindings. Check disk headroom and active users before cleaning build output. Preserve source, Git data, release artifacts, downloaded dependencies, and verification records. Build-script output can contain environment values; do not publish Cargo caches or raw logs.

Focused Rust reproduction examples:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-core --test session_review
cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-protocol --test operation_generation --test wire_connector
cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-runtime --test coverage_manifest --test launcher --test meeting_clients --test production --test socket
```

After focused repairs, finish the applicable release checks, including:

```sh
cargo test --locked --manifest-path rust/Cargo.toml --workspace --no-fail-fast
bun run rust/crates/runtime/tests/support/ready-runtime.ts "$PWD/rust/target/debug/ycoding-runtime" bun run --cwd packages/client test:integration:rust
bun turbo typecheck --concurrency=1 --filter='./packages/*' --filter='./apps/web' --filter='./extensions/meeting'
bun run typecheck:cloudflare
bun run --cwd packages/tui test
bun test --cwd packages/cli --timeout 30000
```

Use a 6 GiB process-tree cap for typechecks and the final Rust batch, and 12 GiB for the full CLI suite. The TUI suite took about 14 minutes; allow at least 20 minutes. The final Rust batch was cancelled, so its full duration is unknown.

## Git completion

Before delivery, inspect the complete tracked and untracked change set, resolve required failures, and review for secrets and generated artifacts. Include code, tests, documentation, release notes, and this handoff in the complete product change. Keep the existing Git identity and hooks; do not force-push or bypass checks.

Recheck the remote `beta` ref immediately before creating or advancing it. No beta ref was present at handoff inspection. Do not push only the existing stage HEAD while implying it includes the uncommitted migration.
