# R0-08 — Audit existing delivery chain (lane E, read-only)

Repo `/Users/viadz/Workspace/Project/ycoding`, `main`, HEAD `a4bb99e`.
Read-only; only kit writable. No `git` mutation, no merge `--apply`, no Godot/export/build.
All hashes below are Git blob SHA-1 via `git hash-object <path>`.

## 1. Live workflow inventory (`.github/workflows/`)

| File | Triggers | Jobs |
|---|---|---|
| `containers.yml` | push to paths; workflow_dispatch | `build` (bun `packages/containers/script/build.ts --push`, ghcr) |
| `nix-eval.yml` | push/PR `dev`; workflow_dispatch | `nix-eval` |
| `nix-hashes.yml` | push `dev,beta` on paths; workflow_dispatch | `compute-hash` (matrix), `update-hashes` |
| `pages.yml` | push `main`; workflow_dispatch | `build`, `deploy` (environment `github-pages`) |
| `release.yml` | push tags `v*`; workflow_dispatch (`inputs.version`) | `verify-source`, `build`, `isolated-browser-acceptance`, `office` (matrix darwin-universal/linux-x64/windows-x64), `package`, `release` |
| `test.yml` | push/PR branches; workflow_dispatch | `unit` (matrix linux/windows) |
| `typecheck.yml` | push/PR `dev,v2`; workflow_dispatch | `typecheck` |

`release.yml` (20648 B) already owns an `office` job: `needs: verify-source`, pins Godot `4.7.2` + export templates with publisher SHA-512, calls `apps/office/tools/build-release.sh` (line 353), uploads artifact `office-<target>` (lines 372–373); `package` merges office archives and one `ycoding-$version-checksums.txt` into `release/` (lines 433–436). Publish job `release` has `permissions: contents: write` and env `GH_TOKEN` (lines 452, 475).

## 2. `apps/office/tools/build-release.sh` behavior (exec read, EXIT=0)

- Usage: `build-release.sh --version <semver> --target <darwin-universal|linux-x64|windows-x64> --outdir <dir>`.
- Version source: caller-supplied `--version`; injected into `apps/office/project.godot` `config/version=` (line ~14), restored via `trap` on exit. Live `project.godot` currently `config/version="0.2.4"`.
- Requires Godot binary (`GODOT_BIN` or discovered), enforces engine `4.7*`; darwin target requires macOS (`ditto`/`hdiutil`).
- Artifacts per target: `ycoding-office-$version-darwin-universal.dmg` (`.app` + `/Applications` symlink), `ycoding-office-$version-linux-x64.tar.gz` (`ycoding-office` + `ycoding-office.pck`), `ycoding-office-$version-windows-x64.zip` (`.exe` + `.pck`).
- Checksums: writes `ycoding-office-$version-checksums.txt` (one `sha256  name` line), same format as CLI release.
- Signing: none. Unsigned export (`docs/SIGNING_AND_UPDATES.md`, kit, marks macOS unsigned; Windows signing absent in live `script/sign-windows.ps1` scope for CLI only).
- Note: CI-side `release.yml` `package` job regenerates the combined `ycoding-$version-checksums.txt`, so `build-release.sh`'s own checksums file is not the published one.

## 3. Installer behavior

- Root `install` (14431 B, bash): CLI-only. Options `-v/--version -b/--binary -r/--repository --no-modify-path`. No `--office` and no Office reference (grep EXIT=1 → no matches).
- `script/install.sh` (16557 B, `/bin/sh`, 385 lines) is the Office-capable installer: `--office` opt-in (lines 91–95); resolves version from `YCODING_VERSION` or GitHub `releases/latest`; verifies every asset against `ycoding-$version-checksums.txt` via `fetch_verified`.
  - macOS: `install_office_bundle` mounts the DMG, requires `YCoding Office.app` with a runnable binary, stages with `ditto`, `rm -rf` existing target then `mv` (replace); target `/Applications` when writable else `$HOME/Applications`, overridable via `YCODING_OFFICE_DIR`.
  - Linux: `install_office_linux` validates tar entries exactly `{ycoding-office, ycoding-office.pck}`, installs `.pck` before binary into `$HOME/.local/bin`.
  - Upgrade: CLI binary/helper use a backup/restore transaction; Office replaces in place (bundle `rm -rf` + move; Linux `mv -f`), no Office backup/rollback.
- Live `pages.yml` is the plain CLI pages pipeline; no Office downloads.

## 4. Kit vs live file table

Kit `integration/additions/` (all destinations absent live):

| Kit path | Live | equal? | kit blob |
|---|---|---|---|
| `.github/workflows/office-ci.yml` | MISSING | — | `fcd6f54398343bac94724e3c358d1f926989477f` |
| `Taskfile.office.yml` | MISSING | — | `99e6b1dfcfa17e6b0e752b4f2c5608a1ba625583` |
| `script/install-office.ps1` | MISSING | — | `94dc22d192c615005ff96d71974d14f924bb3092` |
| `script/office_readiness.py` | MISSING | — | `fc3e8b5c503d9cb8ca2fa09ea846b86079cb2d83` |
| `script/office_release.py` | MISSING | — | `b23f1029a52d5831c53f6afc8f064816bbe6a971` |
| `script/office_tasks.py` | MISSING | — | `87e1c036e2dcf8adc244981dbbc32b4dfcd24191` |
| `script/office_tests/test_delivery.py` | MISSING | — | `cf876358d7f25ff9ded9590335029be909f2439c` |
| `script/setup_office_godot.py` | MISSING | — | `bc27ecd3cfa8d0c6f4720a95b81498a58872a286` |

Kit `integration/replacements/` vs live:

| Kit path | Live blob | Kit blob | equal? |
|---|---|---|---|
| `.github/workflows/pages.yml` | `c837bd27048fcbce6edcadfdee1b2463681a88b1` | `e25d8339754ad21aa87fbc285d411cea7187a92f` | no |
| `apps/office/tools/verify-integration.sh` | `a547b6bfa56ae96ef4502391329314ef87f9c6cc` | `f29d081d668edfac5ce7da6da52db4e6f725336f` | no |
| `.github/workflows/release.yml` (transformed in tool) | `b0c1cf274d8cc50cb137c42bd6d52dd8ca043f4b` | derived | matches BASELINE |

Live `verify-integration.sh` exists and already runs import + transport + live_attach against a loopback fixture; kit replacement only refactors logging/cleanup and switches `--editor --quit` to `--editor --import`. Live `pages.yml` lacks `workflow_run` Office trigger and Office steps.

## 5. `merge_delivery.py` PREVIEW (no `--apply`, EXIT=0)

Command: `python3 ycoding-office-repair-kit/tools/merge_delivery.py --repo /Users/viadz/Workspace/Project/ycoding`
Output verbatim:
```
replace .github/workflows/release.yml
replace .github/workflows/pages.yml
replace apps/office/tools/verify-integration.sh
add     .github/workflows/office-ci.yml
add     Taskfile.office.yml
add     script/install-office.ps1
add     script/office_readiness.py
add     script/office_release.py
add     script/office_tasks.py
add     script/office_tests/test_delivery.py
add     script/setup_office_godot.py
Preview only. No target file changed.
```
No refusal: all three BASELINE blob hashes match live exactly (verified above), and all 8 addition destinations are absent, so no drift/conflict branch triggered. The release transform refuses if any of its unique markers is missing/changed; none was.

## 6. Pack verification

- `python3 ycoding-office-repair-kit/tools/verify_pack.py --root .../ycoding-office-repair-kit` → EXIT=0: `Pack structure, task dependencies, source-reference hashes and local links: PASS. This is not application acceptance.`
- `python3 -B -m unittest discover -s .../tools -p 'test_*.py' -v` → `Ran 17 tests in 0.043s` `OK` (17 passed, 0 failed, 0 skipped).

## 7. Kit-claimed paths missing live

Checked every backticked `script|apps|docs|tools` path in kit docs/integration:
- MISSING: `script/office_tasks.py`, `script/office_readiness.py`, `script/office_release.py` (all kit additions), `docs/office-release-readiness.json` (kit expects a real readiness record), `tools/merge_delivery.py`, `tools/settings_coverage.py`, `tools/check_layout_capture.py`.
- Live has a `script/` directory, but it holds the CLI/pages/release scripts only; no `office_tasks.py` etc.
- `docs/releases/vX.Y.Z.md` is a placeholder shape (real files `v0.2.1`–`v0.2.5` exist; latest `0.2.5`).
- `docs/SOURCES.md` missing live (kit-only).

## 8. Merge plan for implementer

1. Confirm clean tree except `ycoding-office-repair-kit/`; confirm the three baseline hashes still equal BASELINE.json.
2. Run preview; require exactly the 3 replace + 8 add plan (no drift text).
3. Run `merge_delivery.py --apply` (creates backup outside repo, no git action).
4. Land the 8 additions at repo root; review the `release.yml` transform diff (adds `REQUESTED_VERSION`/`SOURCE_REF_NAME`, `office_tasks.py verify`, `office_tasks.py build`, `office_release.py verify`, `office_readiness.py`, `environment: office-release`, prerelease flag logic, `fetch-depth: 0`).
5. Review `pages.yml` and `verify-integration.sh` replacement diffs (Office downloads + loopback refactor).
6. From checkout, run kit commands: `python3 script/office_tasks.py doctor|run|verify`.
7. Re-run owner build/typecheck/tests for affected packages; do not use root `bun test`.
8. Commit as one change with docs updates; do not tag/publish.

## 9. External blockers (not code tasks)

- **Signing/notarization secrets** (kit `docs/SIGNING_AND_UPDATES.md`): macOS Developer ID cert + notarization; Windows Authenticode/HSM. Unavailable; kit explicitly enables no signing automation.
- **Protected GitHub environment `office-release`**: YAML naming it does not create protection; required reviewers must be configured in repo settings before release.
- **GitHub Pages settings**: replacement `pages.yml` relies on `workflow_run` of `release`; Pages source must be GitHub Actions and the `github-pages` environment present.
- **Release-readiness record**: `docs/office-release-readiness.json` must be created from `templates/RELEASE_READINESS.example.json` only after real verification (native builds, provider evidence, visual evidence). Missing/false record blocks publication.
- **Real host/tooling**: native DMG build needs macOS + Godot 4.7.2 + matching templates; Windows/Linux smoke needs those hosts.
- **Live provider credentials**: required for the live-provider gate; not available.

## 10. Unknowns

- Kit BASELINE was retrieved from public commit `77ef4315...`; live HEAD `a4bb99e` blobs match for the three tracked files, so no observed drift, but no guarantee for other branches.
- Live `release.yml` `build` (CLI) job markers used by the transform were not independently re-verified beyond the preview exiting without refusal.
- Kit `office-ci.yml`, `Taskfile.office.yml` semantics were not executed (no Godot/build), so behavior is unverified.

## Acceptance check

`git status --porcelain` unchanged except the kit:
```
?? ycoding-office-repair-kit/
```
Merger not applied; live baseline blobs unchanged (`b0c1cf27…`, `c837bd27…`, `a547b6bf…`).
