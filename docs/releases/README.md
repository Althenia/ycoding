# Release targets

The release workflow resolves a target and its source suites before running builds or publication. Tag pushes require a nonempty note at the target's notes path. The tag must point to the event commit, and that commit must be reachable from `main`.

| Target | Tag | Notes | Output |
| --- | --- | --- | --- |
| Combined | `v<version>` | `docs/releases/v<version>.md` | Apple Silicon CLI archive and Desktop zip, `LICENSE`, `NOTICE`, and `ycoding-<version>-checksums.txt` covering those four assets; GitHub release and Web deployment |
| Desktop | `desktop-v<version>` | `docs/releases/desktop/v<version>.md` | Apple Silicon Desktop zip, `LICENSE`, `NOTICE`, and `ycoding-desktop-<version>-checksums.txt` covering those three assets; GitHub release |
| Web | `web-v<version>` | `docs/releases/web/v<version>.md` | Verified Web build deployed to Cloudflare; no GitHub release, Desktop archive, or checksum manifest |

Combined runs all seven source suites, builds both archives, finalizes their checksums, publishes the notes with a comparison link, and then deploys Web. Republishing an existing `v<version>` release uses `script/release-publish.ts` replacement, which never deletes replaced assets. Desktop runs all source suites except Web, builds the Desktop zip without the CLI archive, and finalizes its checksums. Publication verifies the manifest digest and checks every listed asset. A Desktop release is created with Latest disabled, fails if the tag already has a release, and checks that GitHub Latest has not changed. It never overwrites a published release or its assets. Web runs the types and Web suites and checks tag provenance before deployment.

Manual workflow runs select `target` (default `full`) and an optional `version`. They verify the selected target without publishing or deploying. The version is specified explicitly or resolved from the newest shared `docs/releases/v<version>.md` note, regardless of target; the selected note must be nonempty.

Native-layout Desktop installations read `releases?per_page=20` and consider stable, non-draft, non-prerelease `v<semver>` and `desktop-v<semver>` releases. They choose the newest version, preferring the combined release on a tie, and download its Desktop zip and matching checksum manifest. They ignore Web and other tags. With an explicit `targetVersion`, Desktop permits prereleases and uses `desktop-v<target>` only when that non-draft release exists and no non-draft `v<target>` release exists; otherwise it downloads `v<target>` and `ycoding-<target>-checksums.txt`. Bun-era Desktop uses `releases/latest`. The CLI/TUI updater and `script/install.sh` consider only `v*` releases.
