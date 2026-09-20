# Package validation — 2026-09-16

This is evidence about the handoff/utilities only, not completed YCoding behavior.

## Executed in this preparation environment

- `python3 -B -m unittest discover -s tools -p 'test_*.py' -v`: **17 passed**. Settings-schema classification, coverage-vs-implementation distinction, geometry checker, source audit guard, baseline drift rejection, workflow transformation and preview/apply behavior are covered. Merger tests use a synthetic minimal workflow, not the actual local Mac checkout.
- `python3 -B -m unittest discover -s integration/additions/script/office_tests -p 'test_*.py' -v`: **25 passed**. Release versions, asset contract, checksum parsing, archive allowlists, unsafe entries, download selection, additive Pages, editor pins and fail-closed readiness checks are covered. Test archives/usage/release records are synthetic inputs only.
- Python AST parse of every supplied Python script: **passed**.
- YAML parsing of the supplied Pages workflow, Office CI workflow and Taskfile: **passed**. This does not validate remote action availability or prove a GitHub run.
- `sh -n` on the included shell replacement: **passed**.
- Pack verifier: JSON parsing, task dependencies, evidence rules, reference image hashes and internal Markdown links: **passed**.
- ZIP member CRC/integrity and per-file SHA-256 manifest verified during final packaging.

Logs: evidence/kit-validation/pack-tests.log and delivery-tests.log. The task ledger intentionally has no application pass records.

## Not executed / not claimed

Secure files local checkout access (FORBIDDEN); local Git edits; Godot import/build/native window; real provider requests; settings save/restart; live project/player/statistics paths; actual engine/template downloads; native macOS/Linux/Windows installation; PowerShell native parse/execution; macOS signing/notarization or Windows signing; GitHub Actions/release/Pages execution. These remain explicit tasks/gates. No running app, compiled app, provider keys, font files or production asset license is bundled.

Python environment: 3.13 in the preparation container. Utilities target Python 3.10+; supported native runtime/runner validation must still run in the real checkout.
