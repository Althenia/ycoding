# Verification plan

## Separate evidence tiers

1. Pack tests: validate scripts, task graph, settings coverage, release naming, checksum/ZIP structure, scoped merge, and reference hashes. These do not prove the app works.
2. Source audit: current repo and exact commands/contracts compared with pinned snapshot. Static findings remain static.
3. Godot headless/import/scene suites and explicit loopback integration: run production code with controlled inputs; fixture server is not a live external provider.
4. Native GUI tests: launch actual Office, click/type/resize/walk/switch projects/settings/stats; inspect all rendered states against references.
5. Live provider: existing configured account, small prompt, output settlement, supported tool, stop/history/restart; never log credentials. No credential setup guessed from a model label.
6. Platform candidate/release: native exported builds, correct app version, actual install/upgrade, signing validation, GitHub run and Pages links.

## Required matrices

Shell: 1024x768, 1280x720, 1440x900, 1920x1080 plus an ultrawide; 100/150/200% UI scale; dark/light; 1x/2x display where available. Measure physical vs logical size; inspect clipping, minimums, full-height content and composer safe area. Do not demand every room remain visible at every zoom.

Settings: every catalog row disposition; save/readback/restart/override/reset/conflict/error. Every TUI action maps to desktop equivalent, terminal-only explanation, or unresolved task with owner. Active permissions/hard reviews retain all safety semantics.

Projects/player: at least two repos, non-Git folder, nested folder, worktrees/symlinks and missing path. Late response race, background approval, no cross-scope send. Keyboard and click-to-walk cannot activate under any text field/modal; focus loss clears movement.

Statistics: hand-calculated test-only records and one actual session crosscheck; retries, helpers, child totals, cache/reasoning overlap, unknown price, stale quota, unsupported provider, parallel account limits, DST, hard-budget concurrency when offered. Export privacy and CSV formula safety.

Recovery: lost response after admission, SSE overflow/disconnect, changed epoch, malformed frame, long burst, canceled run, provider timeout/rate limit, reload during edits, service version mismatch and window close without stopping shared daemon.

Release: macOS universal on native arm64 and Intel when supported, Linux x64, Windows x64. Cross-export is NOT native verification. Check archive allowlists and app version (Godot --version is engine version), downloaded signatures/notary state, checksum mismatch failure and no quarantine bypass. Preserve user settings/sessions on update/uninstall. Pages deploy keeps existing docs/schema/install paths and advertises only complete published artifacts.

## Evidence discipline

Use tracking/evidence.json. A pass needs actual time/revision/dirty-state/scenario and a real sanitized artifact. Reference screenshots and generated designs cannot close runtime gates. Code and logs do not close visual gates. User review requires real user feedback, not an agent's imagined approval. If credentials, target host or signing secrets are unavailable, mark that specific gate blocked and continue independent work.
