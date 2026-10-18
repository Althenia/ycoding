# Windows runtime safety backlog

Status: **Deferred; Rust-first implementation proposed**

This backlog records unresolved Windows contracts found while verifying [PR #14](https://github.com/Althenia/ycoding/pull/14). It is not an implementation specification, a claim of Windows feature parity, or approval to change permissions, release gates, or supported capabilities. The larger Windows work is deferred. Current executable behavior and tests remain authoritative.

## Scope and reuse

Keep the bounded inventory, containment, worktree canonicalization, process-close race, and test-fixture corrections separate from this work. Passing their targeted tests does not establish whole-runtime Windows support. Preserve the full test matrix and report remaining failures; do not skip assertions, broaden approvals, or suppress cleanup errors to make a release green.

Implement the eventual native boundaries once in Rust, with reusable contract fixtures. If the TypeScript backend needs a temporary consumer, assess a thin, versioned adapter to the same implementation rather than a second platform layer. An adapter is not automatically justified: process ownership, handle lifetime, cancellation, packaging, and parent death must remain correct across that boundary.

The inspected beta snapshot is [25bba668](https://github.com/Althenia/ycoding/tree/25bba668544b122a159a83f4c6e1f24177fd5c6d). It does not already solve these gaps:

- `rust/crates/core/src/platform/process/tree.rs` uses Windows `taskkill`; Windows identity/liveness operations are unsupported and there is no owned Job implementation there.
- `rust/crates/core/src/platform/shell/ledger.rs` still depends on POSIX process identity and signalling assumptions.
- `rust/crates/core/src/remote.rs` applies Unix mode checks only on Unix; its non-Unix private-file check returns true. This is not Windows ACL verification.
- `rust/crates/core/src/process/guardrails/paths.rs` and `shell.rs` implement POSIX lexical paths and shell parsing. Existing Rust classification tests are useful POSIX contracts, not Windows shell coverage.

Recheck the current Rust branch before implementation. Do not copy these limitations into a new abstraction or describe the language migration as a security fix.

## 1. Process identity, ownership, and recovery

**Observed boundary**

`packages/core/src/shell/ledger.ts` queries `ps`; identity lookup failure becomes unavailable identity. `packages/core/src/shell.ts` can then run without a durable ledger row. Existing runtime documentation describes unavailable tracking. Windows cleanup uses `taskkill /T /F`; root exit alone does not prove descendants have stopped or inherited output pipes have closed.

**Smallest safe implementation sequence**

1. Separate process identity from POSIX process-group membership. Distinguish found, absent, and unknown; denied access, malformed data, timeout, and unavailable tooling are unknown.
2. Preserve durable completion-notice bookkeeping independently of cleanup success. A lost notice does not prove termination. Do not discard unresolved ownership evidence merely because inspection failed.
3. Use an opened process handle and its creation time for identity-sensitive operations. A creation-time query followed by a separate PID-based kill still has a PID-reuse race.
4. For descendant ownership, assign the launched process to an owned Windows Job before user code can execute. Verify assignment, prohibit unintended breakaway, retain existing output-drain semantics, and confirm completion. Jobs are lifecycle containment, not a complete sandbox.
5. Keep the missing-executable path evidence-based: preserve real command resolution and wait for confirmed close. Do not preflight executables, suppress every taskkill exit 128, or treat root exit as whole-tree completion.

**Acceptance**

- Stable identity for owned native processes; absent, reused, inaccessible, malformed, and timed-out identities remain distinguishable.
- A real Windows shell gets its durable completion notice, including completion before a later identity query.
- A live foreign owner or reused PID is never killed. Unknown verification and failed termination remain visible.
- Root exit with a live child, child-held capture pipes, children that close pipes but stay alive, grandchildren, assignment failure, and owner crash are covered without leaked test processes.
- Missing executable settles with the original failure; confirmed-close races succeed, while unconfirmed close and permission errors still fail.
- Lost-notice admission occurs exactly once; reconciliation never replays commands.

**Decisions before implementation**

Choose whether unknown identity refuses execution or retains documented untracked execution; choose owner-crash behavior and whether any cross-restart survival is required; approve the native packaging/adapter boundary. Kill-on-owner-crash is a proposal, not an accepted behavior change. Keeping jobs alive requires a larger persistent-supervisor design.

## 2. Private storage and ownership

**Observed boundary**

`packages/cli/src/remote-credentials.ts` writes signing credentials using mode-0600 temporary files and rename. `extensions/meeting/src/discovery.ts` uses POSIX ownership/mode checks; Meeting stores bearer-token descriptors, locks, settings, and SQLite data with WAL sidecars. Windows mode bits do not prove account isolation. The password-bearing registration in `packages/cli/src/server-process.ts` is an adjacent consumer that must be explicitly included or refused.

**Smallest safe implementation sequence**

1. Define an explicit current-account SID/DACL policy. Establish protected storage before writing secrets, not afterwards.
2. Inspect existing objects using handle-based ownership/security checks and bounded reads. Reject unsafe reparse redirection, writable ancestry, null/broad DACLs, unknown verification, and unsupported filesystems.
3. Preserve atomic replacement, create-only enrollment, and exclusive lock acquisition. Keep temporary files inside protected storage.
4. Protect the Meeting directory before opening SQLite, with verified inheritance for WAL, SHM, journal, lock, and temporary files.
5. Leave existing unsafe files unchanged and provide actionable refusal. Migration or ACL repair needs a separate reviewed decision.

**Acceptance**

Native SID/DACL checks must prove that an unrelated unprivileged identity cannot read secrets or replace protected files. Cover wrong ownership, broad/inherited permissions, reparse substitution, inspection errors, concurrent enrollment, interrupted rotation, lock contention, crash recovery, and SQLite sidecars. Preserve POSIX ownership and mode tests. Use isolated fixtures; do not alter real user directories or machine-wide security settings as a test shortcut.

**Decisions before implementation**

Choose owner-only access versus explicitly permitted SYSTEM/Administrators, registration-file scope, native testing/packaging, and any separately approved existing-file migration. These choices are unresolved; this backlog grants no ACL-change authority.

## 3. Path and shell guardrail semantics

**Observed boundary**

The current TypeScript matcher uses host path semantics with POSIX command tokenization. Its Unix fixtures fail on Windows for reasons distinct from missing native protection. Windows drive/share roots are recognized, but case-variant home paths, other profiles, and Windows system directories need explicit native policy. Backslash escaping and `rm` recognition do not model PowerShell or cmd.

**Smallest safe implementation sequence**

1. Keep a reusable POSIX classification corpus. A narrow explicit lexical path dialect can make Unix fixtures deterministic while preserving every expected decision and the production default.
2. Define authoritative shell selection and separate lexical parsing from canonical filesystem trust. Do not infer shell dialect from the host OS alone.
3. Specify Windows drive, UNC, case, profile, system-root, and temporary-root rules before implementing them in Rust.
4. Preserve custom-deny precedence and original resource evidence. Do not resolve `/tmp` onto arbitrary Windows drives or silently expand exemptions.

**Acceptance**

Preserve all existing POSIX decisions. Add drive/share roots, configured home and case variants, other profiles, project ancestors, direct home children, different drives/shares, traversal and sibling escapes, explicit temp descendants versus near-prefix siblings, and mixed temp/protected deletion. Unconfigured drive or UNC `tmp` paths must not become exempt by accident. Test each supported shell dialect and retain custom-deny behavior for temporary and read-only-looking commands.

**Decisions before implementation**

Choose supported PowerShell/cmd/Git Bash dialects, protected profile/system roots, authoritative temporary directories, and temp-versus-protected-root precedence. Existing POSIX tests allow some temp overrides; that must not silently become a new Windows safety policy.

## Delivery boundary

The larger implementation and any reduced-capability Windows release are both deferred pending a product decision. Explicit refusal can be a safe alternative only when enforced before affected operations execute or private data is accessed. It materially changes the supported feature set and needs corresponding documentation and positive refusal tests, not skipped tests.

Other Windows failures still require independent diagnosis, including service lifecycle, Meeting startup, native-helper fixtures, attachment privacy, repository/file operations, and retention cleanup. Completing the three designs above does not by itself prove that the full suite is green. Keep release readiness based on actual completed gates; do not release v0.10.17 merely because this backlog exists.
