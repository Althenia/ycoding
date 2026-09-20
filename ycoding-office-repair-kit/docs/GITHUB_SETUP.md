# GitHub setup and pipeline

Repository: `Althenia/ycoding`. Intended existing project website: `https://althenia.github.io/ycoding/` (the inspected site builder uses this path; this is not a deployment verification).

## Setup checklist

1. Review/apply the guarded integration locally and review its diff with current CI owners. Keep the existing pinned actions, CLI build, browser acceptance and documentation tests. Merge only after affected tests pass; the merger does not commit.
2. In repository Settings → Pages, select GitHub Actions as the source. Keep the `github-pages` environment and correct branch protection. Test a manually dispatched Pages build.
3. Configure the `office-release` environment with a required maintainer reviewer. Confirm repository plan/settings support the intended protection; do not assume a newly named environment is protected.
4. Confirm Actions access, runner labels, current Godot editor/template pins and native-platform dependencies. The release keeps existing macOS/Windows/Linux runners and Godot 4.7.2 checksums; this kit has not run those jobs.
5. Establish signing and notarization secrets only for trusted jobs. No provider API keys are required for the deterministic CI checks. Keep paid live-provider testing explicit and controlled; never expose provider keys to pull requests.
6. Run release workflow_dispatch for a real candidate version with notes. Download candidate artifacts, perform native GUI/install/live-provider checks and record results before tagging.

## Existing release graph after merge

```
verify-source (existing CLI/TUI/schema/installer gates)
  ├── build (existing native CLI matrix)
  │    └── isolated-browser-acceptance (existing)
  └── office (existing native export matrix)
       ├── pinned Godot + templates
       ├── verify.sh + verify-integration.sh
       └── existing build-release.sh
all required builds → package → archive/checksum gate
  → office-release environment approval → GitHub Release
  → Pages workflow_run refresh → static docs + Office downloads
```

The loopback integration script uses a fixture HTTP server. It tests the real transport but is NOT evidence of a real external provider. The release still requires native and real-provider acceptance recorded locally.

## Pages behavior

The updated workflow runs on main pushes, manual dispatch and completion of the named `release` workflow. The completion path checks success, a tag-push origin and the same repository; it checks out trusted `main`, does not execute a downloaded artifact or an untrusted PR head. Build and deploy use the existing Pages concurrency group. The build obtains releases from GitHub and chooses the highest stable version that contains the complete Office + CLI asset set and checksum file. Incomplete/newer CLI-only releases do not generate broken Office links. No matching release produces an honest not-yet-available page, not fictional buttons.

The new page sits under `/ycoding/office/` and links actual versioned GitHub Release assets. Documentation, configuration schema, examples and the maintained Unix installer stay intact. No web Godot client is published and no browser page connects to localhost or gets service credentials. Personal screenshots in this kit must NEVER be copied into public Pages/release output.

A release created using GITHUB_TOKEN does not generally trigger another release-event workflow. That is why this integration uses the existing release workflow's completion rather than relying on `release: published`. See official GitHub sources in SOURCES.md.

## Required repository permissions

Build jobs: contents read. Publish: contents write, protected by office-release. Pages deploy: pages write and id-token write in github-pages. A protected environment review is a human gate, not an automatic certification. Do not use pull_request_target to run a contributor's code with signing or provider secrets.

## First-release evidence

Record Actions run URLs, tag/source commit, all artifact names/hashes, native Mac/Linux/Windows smoke results, signing status, chosen provider/model and redacted actual prompt/response evidence, and the deployed Pages URL. Test every visible download from the public site, the Unix `--office` path, Windows portable install and a reinstall/update scenario. The absence of credentials or a supported host blocks the affected claim; report it rather than marking the platform verified.
