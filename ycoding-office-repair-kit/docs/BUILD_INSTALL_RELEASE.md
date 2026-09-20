# Build, install and release workstream

## Use the repository's existing delivery chain

The inspected project already has `apps/office/tools/build-release.sh`, `script/install.sh --office`, `.github/workflows/release.yml`, `.github/workflows/pages.yml`, and `script/build-pages.ts`. This kit adds tasks and narrowly scoped integration files instead of replacing the CLI release or duplicating the website. See [REMOTE_AUDIT.md](REMOTE_AUDIT.md).

## What the integration supplies

`script/office_tasks.py` provides doctor, verify, isolated-copy build, install-release, install-local, and Pages commands. It is dependency-free Python 3.10+. Godot/Bun/platform export tools remain actual prerequisites. `Taskfile.office.yml` is an optional task runner; direct Python commands are equivalent.

`script/office_release.py` validates assembled release archives/checksums and generates the Office download page from actual published GitHub release metadata. It never invents a successful release. It writes only an `office/` subtree and a small navigation link into the existing Pages build output.

The integration merger extends the existing release workflow with actual Office verification before export, safe input-to-shell handling, an asset contract gate, prerelease/latest handling and an `office-release` environment. It replaces the current Pages workflow with an extended version retaining the docs build and existing action pins. No publishing command runs during kit preparation or merge.

The Windows PowerShell installer is an added platform-specific path, not a replacement for the maintained Unix installer. It installs verified versioned CLI + Office portable payloads per user and optionally adds a desktop shortcut. It does not edit PATH or require administrator access.

## Apply locally

First read current root and `apps/office/AGENTS.md`, record `git status --short`, then:

```sh
python3 "$KIT/tools/merge_delivery.py" --repo "$REPO"        # validation/preview only
python3 "$KIT/tools/merge_delivery.py" --repo "$REPO" --apply
```

The merger requires exact inspected Git blob identities for the three existing files and refuses existing destinations for additions. It refuses symlinks, creates an outside-repo backup and never stages or commits. On drift it stops; have the local agent merge deliberately, not force overwrite. An already-applied or changed checkout is refused as baseline drift; inspect the diff rather than reapplying. This does not make the application repaired.

## Local tasks after integration

```sh
python3 script/office_tasks.py doctor
python3 script/office_tasks.py verify
# An explicit sample version; use the version of the actual candidate being built.
python3 script/office_tasks.py build --version 0.2.5 --target darwin-universal --outdir dist/office-local/0.2.5/darwin-universal
python3 script/office_tasks.py install-local --version 0.2.5 --target darwin-universal --artifact dist/office-local/0.2.5/darwin-universal/ycoding-office-0.2.5-darwin-universal.dmg --yes
python3 script/office_tasks.py pages
```

Build copies the current Office tree into a temporary staging project so the existing builder's version injection cannot overwrite `project.godot` in the working checkout. It deliberately builds current uncommitted Office files rather than silently substituting git HEAD. It excludes caches/VCS, refuses symlink escapes, verifies the staged project, and requires a fresh output directory. Build each platform into its own directory; the existing per-version checksum filename would otherwise collide. Exit failures and Godot script errors remain failures. An export is not proof that LIVE startup, providers or UI work.

Set `GODOT_BIN` to the actual 4.7.2 standard engine; install matching export templates. macOS DMG builds require macOS with hdiutil/ditto. The existing Linux/Windows export targets can be built on Linux, but native runtime/install smoke must still run on each claimed OS. On Windows run Python using `py -3`; the existing sh build needs Git Bash or use the Linux CI cross-export job. No new containers are necessary.

## Install published versions

```sh
# Uses the maintained installer, installs CLI plus Office; only writes on --yes.
python3 script/office_tasks.py install-release --version 0.2.5 --yes
```

On Windows, after reviewing the script:

```powershell
powershell -File script/install-office.ps1 -Version 0.2.5 -Yes -DesktopShortcut
```

These commands require a real published version; the example does not assert that 0.2.5 exists. Checksum verification protects content integrity, not independence from a compromised release account. Never strip quarantine, disable Gatekeeper/SmartScreen, auto-approve tool calls or place provider credentials in a release artifact.

`install-local` installs only the GUI into a fresh versioned/per-user location and refuses an existing destination. The CLI/service must already be present and compatible; it does not pretend to bundle it. Validate GUI-launched service discovery independently of shell PATH and configuration. Local update/uninstall is described in INSTALLATION.md.

## Publish

Preserve the existing `vX.Y.Z` release tag convention and CLI checks. Prepare nonempty `docs/releases/vX.Y.Z.md`. Reconcile all R0–R10 tasks, run the candidate locally against a configured real provider, inspect native renders and all platform smoke evidence. A branch workflow_dispatch builds release candidates without publishing; only an intentional tag push publishes under the existing policy.

The supplied merge adds the `office-release` environment to the publish job. Configure required reviewers in GitHub BEFORE release; YAML naming an environment alone does not create protection. A reviewer must check the candidate source, archive hashes, real-provider evidence, visual evidence, native launch/install results, signing status and known limitations. Do not attest an unsigned candidate as signed. Publish operations remain intentional user actions; no script here creates tags or pushes Git.

A version containing '-' is a prerelease and uses `--prerelease --latest=false`. Stable promotion uses the normal release path. Failed gates must not publish or update the Office download page. Do not mutate already-published versioned assets; ship a new version, or explicitly withdraw and document a broken release. Preserve last working published version during rollout.

## Publication is intentionally gated

The guarded workflow calls `script/office_readiness.py` before creating a release. No populated passing record is supplied in this kit. Copy `templates/RELEASE_READINESS.example.json` to `docs/office-release-readiness.json` only after actual verification, filling real evidence and reviewer/date. A missing/false record blocks publication. `tested_commit` must be an ancestor with only that readiness file and the matching release note changed since it; code changes require retesting. Commit this record after testing to avoid a self-referential commit hash. Stable publication requires verified signing; unsigned evaluation uses a clearly described prerelease. Local/manual CI candidate builds remain possible before publish readiness.

`task --taskfile Taskfile.office.yml doctor` is optional convenience; Python commands need no Task installation. `install` previews; `install-confirmed` writes. `python3 script/office_tasks.py run` launches the current app for native audit; it does not claim the current app is repaired.
