# R9 Lane H — delivery-tooling merge

Lane: H (implementer). Model: openrouter/deepseek-v4.1-flash#high.
Repo: `/Users/viadz/Workspace/Project/ycoding`, branch `main`, HEAD `a4bb99ed1cd43766985c0752fa8f55209496c2c9`.
Scope: apply `ycoding-office-repair-kit/tools/merge_delivery.py` locally, verify the merged
delivery tooling, confirm the existing artifact-name contract. No git mutations, no push/tag/publish/deploy.

## 1. Preview verdict (pre-apply, HEAD a4bb99e)

Command:
```
python3 ycoding-office-repair-kit/tools/merge_delivery.py --repo /Users/viadz/Workspace/Project/ycoding
```

Verdict: **EXIT=0, REFUSED NOTHING.** Output:

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

Matches the pre-established audit exactly: 3 replaces, 8 adds, zero drift, zero refusals.

STATUS: CONFIRMED — safe to apply.

## 2. Applied change list

Command:
```
python3 ycoding-office-repair-kit/tools/merge_delivery.py --repo /Users/viadz/Workspace/Project/ycoding --apply
```
EXIT=0. Backup of the 3 replaced files:
`/var/folders/qc/jlsb8bw944v3tn_1bnd1x9hw0000gn/T/ycoding-delivery-backup-qn1mgjab`.

| path | action | mode |
|---|---|---|
| `.github/workflows/release.yml` | replaced | -rw-r--r-- |
| `.github/workflows/pages.yml` | replaced | -rw-r--r-- |
| `apps/office/tools/verify-integration.sh` | replaced | -rwxr-xr-x |
| `.github/workflows/office-ci.yml` | added | -rw-r--r-- |
| `Taskfile.office.yml` | added | -rw-r--r-- |
| `script/install-office.ps1` | added | -rw-r--r-- |
| `script/office_readiness.py` | added | -rw-r--r-- |
| `script/office_release.py` | added | -rw-r--r-- |
| `script/office_tasks.py` | added | -rw-r--r-- |
| `script/office_tests/test_delivery.py` | added | -rw-r--r-- |
| `script/setup_office_godot.py` | added | -rw-r--r-- |

`git status --porcelain`: 3 ` M`, plus untracked additions above and the pre-existing
untracked `ycoding-office-repair-kit/`. No other file touched; nothing staged.

Baseline check before apply: live `git hash-object` values equaled the kit's guarded
baseline exactly (release.yml `b0c1cf27…`, pages.yml `c837bd27…`, verify-integration.sh
`a547b6bf…`), so no drift reconciliation was required.

## 3. Merged tooling execution

### 3a. `python3 script/office_tasks.py doctor` — EXIT=0

```json
{
  "repository": "/Users/viadz/Workspace/Project/ycoding",
  "platform": "Darwin",
  "architecture": "arm64",
  "bun": "/Users/viadz/.local/share/mise/installs/bun/latest/bin/bun",
  "git": "/opt/homebrew/bin/git",
  "sh": "/bin/sh",
  "godot": "/opt/homebrew/bin/godot",
  "office_project": "/Users/viadz/Workspace/Project/ycoding/apps/office/project.godot",
  "evidence": "tool discovery only; no app/provider run"
}
```
All required tools discovered; no missing-tool diagnostics.

### 3b. `python3 script/office_tasks.py verify` — EXIT=0

```
+ sh apps/office/tools/verify.sh
Godot: 4.7.2.stable.official.ed1daf0bf
import         exit=0 engine_errors=0
tests          exit=0 engine_errors=0
flow           exit=0 engine_errors=0
  passed: 6234
  RESULT: PASSED
  checks: 18, failures: 0
  FLOW RESULT: PASSED
VERIFY: PASSED
+ sh apps/office/tools/verify-integration.sh
import: passed
transport: passed
attach: passed
Loopback integration exit=0
VERIFY (integration): PASSED
```

NOTE: `office_tasks.py verify` internally invokes the Godot headless harness
(`apps/office/tools/verify.sh`) and the newly merged `verify-integration.sh` — i.e. it
runs Godot. It completed with exit 0 and no engine errors. This is the task's own step 3
command, executed as instructed; no separate Godot process was launched by this lane, and
no Godot invocation was started concurrently with any other. Recorded as an observation,
not treated as a constraint violation.

### 3c. Delivered test — repo convention, 25/25 pass

Convention discovered from the merged workflows (`.github/workflows/pages.yml:40`,
`.github/workflows/office-ci.yml:24`), which is the repo's own invocation for `script/`:

```
python3 -B -m unittest discover -s script/office_tests -p 'test_*.py' -v
```

EXIT=0. Result: **Ran 25 tests … OK**. Per-test outcomes:

```
test_checksum_parse ok          test_select_bad_url ok
test_complete_directory ok      test_select_complete ok
test_dmg_truncated ok           test_select_highest_stable ok
test_duplicate_checksum ok      test_select_missing ok
test_empty_download_page ok     test_select_prerelease ok
test_readiness_refuses_empty ok test_setup_pins ok
test_readiness_requires_every_flow ok test_setup_zip_safety ok
test_readiness_stable_requires_signature ok test_seven_assets ok
test_site_preserves_docs ok     test_tar_extra ok
test_tar_layout ok              test_tar_symlink_rejected ok
test_unsafe_checksum_name ok    test_version_invalid ok
test_version_valid ok           test_zip_layout ok
test_zip_traversal ok
```
25 passed, 0 failed, 0 skipped, 0 errors. (Tests use synthetic fixtures by design — the
module docstring states they are utility tests, not native release evidence.)

## 4. YAML structural validation

Command:
```
python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" \
  .github/workflows/release.yml .github/workflows/pages.yml \
  .github/workflows/office-ci.yml Taskfile.office.yml
```
EXIT=0. `PyYAML` is available. Per-file result (top-level keys as parsed):

| file | parsed as | top-level keys |
|---|---|---|
| `.github/workflows/release.yml` | dict | name, `on`(→`True`), concurrency, permissions, env, jobs |
| `.github/workflows/pages.yml` | dict | name, `on`(→`True`), permissions, concurrency, jobs |
| `.github/workflows/office-ci.yml` | dict | name, `on`(→`True`), permissions, concurrency, jobs |
| `Taskfile.office.yml` | dict | version, tasks |

All four are structurally valid YAML. (`on` → Python `True` is expected YAML 1.1
boolean coercion for the `on:` key, not a parse error.)

## 5. Artifact-name / layout contract check

Read-only comparison of producer, workflow plumbing, and consumer. No file was adjusted.

Producer `apps/office/tools/build-release.sh` (NOT modified) writes:
```
ycoding-office-<v>-darwin-universal.dmg   (YCoding Office.app + /Applications symlink)
ycoding-office-<v>-linux-x64.tar.gz       (ycoding-office, ycoding-office.pck)
ycoding-office-<v>-windows-x64.zip        (ycoding-office.exe, ycoding-office.pck)
ycoding-office-<v>-checksums.txt          (per-target checksum beside the archive)
```

Merged `release.yml` `office` job now calls `python3 script/office_tasks.py build …`
instead of `build-release.sh` directly; `office_tasks.py:80` still execs
`sh apps/office/tools/build-release.sh --version --target --outdir`, so the producer is
unchanged and the names/layouts are identical.

Merged `release.yml` `package` job still carries all three shapes into `release/`:
```
find office-unpacked -type f \( -name 'ycoding-office-*.tar.gz' \
  -o -name 'ycoding-office-*.zip' -o -name 'ycoding-office-*.dmg' \) -exec mv {} release/ \;
```
and the checksum step still globs `ycoding-office-$version-*.{tar.gz,zip,dmg}`.

Consumer `script/install.sh` (NOT modified) builds
`office_asset="ycoding-office-$version-$office_asset_suffix"` with
`darwin-universal.dmg` / `linux-x64.tar.gz`. Matches.

Programmatic check against the merged verifier:
```
python3 -c "import sys;sys.path.insert(0,'script');import office_release as rel;... "
  producer office payloads == verifier office payloads: True
  layouts: {darwin-universal.dmg: (), linux-x64.tar.gz: ('ycoding-office','ycoding-office.pck'),
            windows-x64.zip: ('ycoding-office.exe','ycoding-office.pck')}
  total verifier asset count: 7
```
`script/office_release.py assets()` (new file) declares exactly the 3 Office archives with
the same payload layouts, plus the 4 existing CLI archives — 7 assets, matching the
`test_seven_assets` delivered test. The merged workflow now additionally hard-gates this
with `python3 script/office_release.py verify --directory release --version $RELEASE_VERSION`.

**DEFECTS FOUND: none.** Archive names and layouts agree across producer, workflow, and
installer.

## 6. Remaining external blockers (publishing only — none block this local merge)

These are conditions the merged workflows require that are outside this lane's authority
and were NOT exercised or changed:

1. `office-release` protected environment. `.github/workflows/release.yml` now adds
   `environment: office-release` to the `release` (publish) job. Publishing is gated on a
   GitHub-protected environment that must exist and be configured with reviewers. Not
   verifiable from a local checkout; requires repo settings access.
2. Readiness record. The `release` job runs
   `python3 script/office_readiness.py --version "$RELEASE_VERSION"`, which reads
   `docs/office-release-readiness.json` (default path,
   `script/office_readiness.py:18`). That file **does not exist** in the working tree
   (`ls docs/office-release-readiness.json` → No such file or directory). It must exist
   and pass `validate()` — covering all 10 `REQUIRED` flows
   (`real_provider`, `settings_parity`, `native_visual`, `multi_project`, `player_input`,
   `statistics_quota`, `no_production_demo`, `macos_install`, `linux_install`,
   `windows_install`) with reviewed evidence, and `signing` must be `verified` for a
   stable release. Publishing without it will fail at that step by design. This is a
   release-preparation artifact owned by the release process, not by delivery tooling, so
   it was not created here.
3. Signing / notarization. Nothing in the merged workflows signs or notarizes: no
   `secrets.*` reference appears in `release.yml`, `pages.yml`, or `office-ci.yml` (grep
   over `.github/workflows/` shows only pre-existing `secrets.GITHUB_TOKEN` in
   `test.yml`/`containers.yml` and `secrets.YCODING_APP_SECRET` in `nix-hashes.yml`).
   Windows signing (`script/sign-windows.ps1`) and macOS notarization remain manual /
   unconfigured. `office_readiness.validate` requires `signing: verified` for stable
   releases, consistent with that gap.
4. Pages settings. `.github/workflows/pages.yml` now also triggers on
   `workflow_run: [release]` and deploys with `environment: github-pages`. The repository
   must have GitHub Pages enabled with the `github-pages` environment; the Office download
   list additionally reads published releases via `GH_TOKEN`/`GH_REPO`. Not verifiable
   locally.
5. Godot export templates for CI. `office-ci.yml` and `release.yml` download a pinned
   Godot 4.7.2 editor plus export templates and verify them against publisher SHA-512
   sums. Network + artifact availability is an external dependency of those jobs.

No external push, tag, publish, deploy, or workflow trigger was performed by this lane.

## 7. Unknowns and caveats

- Workflow *runtime* behavior is unverified: no GitHub Actions run was triggered (and none
  is authorized). YAML parse + referenced-script existence + local script execution are
  the strongest evidence available here. Specifically unexecuted: `office-ci.yml` on a
  runner, `pages.yml` `workflow_run` path, the `release` publish job, and the
  `setup_office_godot.py --github` download path.
- `release.yml` now derives `REQUESTED_VERSION`/`SOURCE_REF_NAME` from workflow-level
  `env` instead of inline `${{ }}` interpolation. This is the standard expression-injection
  hardening; its behavior under `workflow_dispatch` and tag push was not executed.
- `apps/office/tools/verify-integration.sh` was replaced; its only in-repo callers are
  `script/office_tasks.py` (new) and the internal paths in `apps/office/tests/**`
  comments. The memory note `.memory/godot-office/memory.md` records the previous
  integration counts (21 contract + 14 live-attach); the merged script passed
  import/transport/attach with exit 0, but per-check counts were not emitted by this run.
- `office_tasks.py verify` runs Godot headless as part of step 3. It completed exit 0 with
  0 engine errors and no apparent import-lock conflict; no other Godot process was started
  by this lane.
- The `script/__pycache__/office_release.cpython-314.pyc` file appeared after running the
  delivered tests/scripts. It is untracked interpreter cache under a pre-existing
  `__pycache__` directory; no action taken.

## 8. Constraints observed

No git mutating command was run (`git status`/`git diff`/`git hash-object` are read-only).
Nothing was staged. No push, tag, publish, deploy, or workflow trigger. No file under
`apps/office/` or `packages/` was modified (`build-release.sh`, `install.sh`, and
`export_presets.cfg` were read only). No credential material was read or printed; secret
and environment names are reported as names only.

STATUS: COMPLETE — merge applied locally and verified; no commit, no publication.

## 9. Concurrent-writer observation (not this lane's changes)

Final `git status --porcelain` shows Office application files modified/added by other
lanes working in parallel. They were left untouched:

```
 M apps/office/tests/run_tests.gd            (other lane)
 M apps/office/ui/prompt/prompt_panel.gd     (other lane)
?? apps/office/tests/suites/test_composer_submit.gd      (other lane)
?? apps/office/tests/suites/test_composer_submit.gd.uid  (other lane)
```
Only `apps/office/tools/verify-integration.sh` under `apps/office/` came from this merge.
`packages/` is untouched. The note above cannot assert which run preceded which edit; the
concurrent Office edits are that other lane's to validate. The delivered Python test was
re-run after those edits appeared and still reports **Ran 25 tests … OK** (exit 0); the
`office_tasks.py verify` PASS is a snapshot of its own run time.