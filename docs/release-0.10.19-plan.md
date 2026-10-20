# Manual release plan: stable 0.10.19

Status: manual plan only. It is not a specification of current behavior, not a release note, and not evidence that any step has run. No check here is marked passed.

Publication hold: stop at the hold gate below. This plan authorizes no remote write, tag, workflow run, deployment, or setting change. This file sits outside the `docs/releases/v*.md` glob that release tooling scans for version notes; keep it there.

## Scope

- Stable target: `0.10.19`, plain semver, no suffix. Intended marking if later published: latest stable.
- Beta line, separate: `0.11.0-beta.2`. Keep beta staging, assets, notes, and changelog handling apart from stable. Status of beta tags or notes in any one checkout is not evidence about the beta line; verify against the remote inventory when that matters.
- Build version authority: `YCODING_VERSION` consumed by `packages/script/src/index.ts`, with the matching note file. Workspace `package.json` version fields are not the release version; do not bump them.
- Set `YCODING_CHANNEL=latest` for stable. Without `YCODING_VERSION`, the channel derives from the Git branch and the stamped version becomes `0.0.0-<channel>-<build>`. Always export both:

```sh
export YCODING_VERSION=0.10.19
export YCODING_CHANNEL=latest
```

## Verified source facts vs unverified server behavior

Verified by reading source in this checkout:

- `.github/workflows/release.yml` triggers on `push` of `v*` tags and on `workflow_dispatch` (optional `version` input). Publish and web-deploy jobs run only for tag pushes; manual runs prepare assets only. `test.yml` and `typecheck.yml` trigger on pushes to `dev`/`v2` and on pull requests; no workflow here triggers on a push to `main`.
- `release.yml` resolves version from dispatch input, else tag name, else newest `docs/releases/v*.md` by version sort. Pass the version explicitly in any later approved run so a beta note can never be picked up by the default.
- `release.yml` fails when `docs/releases/v<version>.md` is missing or empty and, for tag pushes, when the tagged commit is unreachable from `main`. It creates one GitHub Release after web deployment and fails if that release already exists.
- `packages/cli/script/computer-use.ts` ad-hoc signs the macOS helper when `YCODING_MACOS_SIGNING_IDENTITY` is unset; a default local build is not release-grade. The workflow requires the identity and certificate fingerprint named by its `YCODING_MACOS_SIGNING_IDENTITY` / `YCODING_MACOS_SIGNING_SHA1` variables and asserts the designated requirement at staging.
- `packages/core/src/browser/extension.ts` freezes the extension list at ten files: four icons, `manifest.json`, `popup.css`, `popup.html`, `popup.js`, `protocol.js`, `service-worker.js`. Archive layout at every depth is enforced by installer/updater checks; extra entries are rejected by older installed updaters.
- The updater (`packages/cli/src/update/update.ts`) and `script/install.sh` resolve the newest release through the GitHub latest-release endpoint and verify entries and checksums.

Not verified, and not established by repository source: whether creating or publishing a GitHub Release via web UI/API with user credentials emits a tag-push event that starts `release.yml`, and whether commit-message skip markers suppress tag-push runs here. Treat claims either way as speculation until confirmed from GitHub documentation or an observed run; do not rely on skip markers.

## Prerequisites (local)

- [ ] The 0.10.19 change set, note, and changelog updates are landed and reachable from `main`; `bun install --frozen-lockfile` completed in this checkout.
- [ ] macOS release-grade signing: keychain holds the identity named by the workflow variables and `YCODING_MACOS_SIGNING_IDENTITY` is set. No secret values, account names, or machine paths in files or logs.
- [ ] Browser legs: installed Chrome 152 or newer on macOS arm64, warmed once; Chrome for Testing provisioned via `script/chrome-for-testing.ts`.
- [ ] Native build hosts for darwin-arm64, darwin-x64, linux-x64, windows-x64. One host proves only its own target; complete macOS artifacts require a macOS host.

## Local checks (mirror the workflow verification legs)

Run from the repository root; one typecheck, build, or package-wide suite at a time. Record command, exit status, and commit for each.

```sh
bun install --frozen-lockfile
# types
bun run check:ycoding-workspace && bun run check:ycoding-brand
bun test --cwd script ./typecheck-cache.integration.test.ts
bun run typecheck && bun run lint:effect-patterns
# web + remote (changelog test runs inside test:web)
bun run test:web && bun run test:remote
bun run build:web && bun run test:integration:web && bun run test:integration:remote
bun run test:cloudflare && bun run build:cloudflare
bun test script/install.test.ts script/build-web-assets.test.ts script/release.test.ts script/chrome-for-testing.test.ts
# cli + tui
bun test --cwd packages/cli --timeout 30000 && bun run test:extension
bun test --cwd packages/tui test/session-transcript-live-fixes.test.tsx test/cli/tui/permission-interaction.test.tsx test/cli/tui/permission.test.ts test/cli/tui/guardrail.test.tsx test/util/permission.test.ts test/branding.test.ts
bun test --cwd packages/core test/session-execution.test.ts test/session-autonomy.test.ts
bun test --cwd packages/core test/decision-agent-provider.test.ts test/decision-agent.test.ts test/decision-judgment.test.ts test/decision.test.ts test/session-guardrail-service.test.ts
# browser + extension (macOS arm64)
bun run test:integration:browser
executable="$(bun script/chrome-for-testing.ts "$TMPDIR/chrome-for-testing")"
YCODING_TEST_ISOLATED_BROWSER_CHROME="$executable" bun run test:integration:extension
# performance budgets (developer machine)
bun run --cwd packages/core test:performance && bun run --cwd packages/cli test:performance
```

## Local build, sign, smoke (per native host)

Verified against `packages/cli/script/build.ts`, `tui-smoke.ts`, `runtime-smoke.ts`, `isolated-browser-smoke.ts`, `computer-use.ts`:

```sh
export YCODING_VERSION=0.10.19 YCODING_CHANNEL=latest
# macOS: also export YCODING_MACOS_SIGNING_IDENTITY before building.
bun run build:tui
bun run smoke:tui && bun run smoke:runtime
node -e 'const m=require("./dist/tui/tui-darwin-arm64/package.json"); if(m.version!==process.env.YCODING_VERSION) process.exit(1)'
bun run --cwd packages/cli script/isolated-browser-smoke.ts --binary="$PWD/dist/tui/tui-darwin-arm64/bin/ycoding"
```

- Output: `dist/tui/tui-<platform>-<arch>/` with `bin/ycoding` (`ycoding.exe` on Windows), `bin/ycoding-chrome-extension`, and on macOS `bin/YCoding Computer Use.app`. Substitute the host target in paths above.
- `smoke:tui` checks `<binary> --version` against artifact metadata and verifies the app bundle; its `codesign --verify` accepts ad-hoc, so add the release-grade check with `YCODING_MACOS_SIGNING_SHA1` set from the workflow value:

```sh
app='dist/tui/tui-darwin-arm64/bin/YCoding Computer Use.app'
codesign --verify --deep --strict "$app"
codesign -d -r- "$app" 2>&1 | grep -Ex "designated => identifier \"app\.ycoding\.computer-use\" and certificate (leaf|root) = H\"$YCODING_MACOS_SIGNING_SHA1\""
```

- Stage per target into `unpacked/ycoding-<target>/` (executable, extension, macOS app). Use only fresh empty staging directories; if a staging path already exists, stop and inspect its contents instead of overwriting. Record commit and SHA-256 per staged binary before any transfer.

## Local packaging

Use a fresh version-specific directory. `mkdir` without `-p` fails if it exists; on failure stop and inspect — never delete or overwrite existing artifacts to proceed. Deleting any pre-existing output requires a recoverability check and explicit approval; default is to retain it and pick a new empty directory.

```sh
version=0.10.19
mkdir "release-$version"
chmod +x unpacked/ycoding-darwin-arm64/ycoding "unpacked/ycoding-darwin-arm64/YCoding Computer Use.app/Contents/MacOS/ycoding-computer-use" unpacked/ycoding-darwin-x64/ycoding "unpacked/ycoding-darwin-x64/YCoding Computer Use.app/Contents/MacOS/ycoding-computer-use" unpacked/ycoding-linux-x64/ycoding
mac_entries=(ycoding ycoding-chrome-extension "YCoding Computer Use.app")
tar -C unpacked/ycoding-darwin-arm64 -czf "release-$version/ycoding-$version-darwin-arm64.tar.gz" "${mac_entries[@]}"
tar -C unpacked/ycoding-darwin-x64 -czf "release-$version/ycoding-$version-darwin-x64.tar.gz" "${mac_entries[@]}"
tar -C unpacked/ycoding-linux-x64 -czf "release-$version/ycoding-$version-linux-x64.tar.gz" ycoding ycoding-chrome-extension
(cd unpacked/ycoding-windows-x64 && zip -r "../../release-$version/ycoding-$version-windows-x64.zip" ycoding.exe ycoding-chrome-extension)
cp LICENSE NOTICE "release-$version/"
(cd "release-$version" && shasum -a 256 "ycoding-$version-"*.tar.gz "ycoding-$version-"*.zip LICENSE NOTICE > "ycoding-$version-checksums.txt")
```

Before leaving the local phase: every staged target's metadata version equals `0.10.19`; the macOS app tree matches the workflow-asserted list (Info.plist, MacOS executable, `YCoding.icns`, CodeResources; no symlinks; bundle identifier, display name, icon entries); top-level entries are exactly the executable, the extension, and on macOS the app, with nothing extra at any depth and `LICENSE`/`NOTICE` only as separate files; `release-0.10.19/` holds only the four archives, `LICENSE`, `NOTICE`, and the checksums file. Record commit → version → checksums digest together as the release identity.

## Publication hold

STOP here. None of the following is performed or authorized by this plan; each needs a separate explicit decision after the blocker below is resolved: `git push` of any branch or tag; `gh workflow run`; `gh release create`/`upload`/`edit`, draft creation or publication, or UI/API equivalents; `bun run deploy:cloudflare`; any repository, workflow, branch-protection, or environment setting change, including disabling a workflow (never without separate explicit approval).

## No-CI constraint and unresolved blocker

Constraint: under the no-CI preference, do not push a `v*` tag and do not dispatch `release.yml`; verified triggers make either start CI.

Blocker, unresolved: repository source does not establish a publication path that is at once updater-visible, limited to locally verified assets, and guaranteed to start no workflow run. The open point is the unverified release-creation tag-event behavior above. Options for later decision, none preselected:

1. Supported CI path: push `main`, then tag `v0.10.19`; CI verifies, deploys web, publishes. Contradicts the no-CI preference.
2. CI preparation only: dispatch `release.yml` with `version=0.10.19` to prepare assets without deploying or publishing. Still CI; publication mechanics remain open.
3. Manual publication from local assets after a separately approved manual web deploy (`bun run build:web`, then `bun run deploy:cloudflare`), mirroring CI gate order. Depends on the unverified tag-event behavior; if a run starts, its publish step fails on the existing release (verified) after a redundant deploy.
4. Draft-only staging: assets in an unpublished draft, invisible to updater/installer. Staging only, and itself behind the hold above.

Decision inputs still needed: authoritative confirmation of the tag-event behavior; tolerance for a redundant or failed run; approval for a manual Cloudflare deploy; who holds release-creation permission. Until decided, the end state is the packaged `release-0.10.19/` set with recorded digests, retained as-is. Post-publication rollback mechanics, if publication is later approved, are decided with the option; never overwrite a published version's assets or move a published tag.

## Beta separation reminders

Build `0.11.0-beta.2` only with its own `YCODING_VERSION`, in its own fresh staging and asset directories (same fail-if-exists rule), and keep it out of the stable changelog list. Verified gap: the workflow release-creation command carries no prerelease marking, so a beta sent through the tag path would surface as a normal latest release; keep beta publication under the same hold until separately decided, and always pass an explicit version to any later approved workflow run (the default scans `docs/releases/v*.md`).
