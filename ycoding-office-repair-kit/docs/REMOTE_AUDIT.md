# Pinned GitHub source audit — not local runtime verification

Repository: `Althenia/ycoding`. Source revision: `77ef4315fa66a8c51c4288e00bfa0a77a635eb63`, read through the GitHub connector on 2026-09-16. Secure files still returned a conversation-level FORBIDDEN. Uncommitted files on the user's Mac are unknown. Read the current checkout before applying these findings.

| Finding | Exact inspected source | Consequence |
|---|---|---|
| A real Godot project exists | `apps/office/project.godot`, `apps/office/AGENTS.md` | Repair it; do not scaffold a second client or repeat the old M0 workspace migration |
| `_ready()` calls `_start_demo()` | `apps/office/app/main.gd`, startup section | Production default is synthetic in this revision; replace with honest connection/setup state, not cosmetic removal of the DEMO label |
| Floating, full-bleed overlays are an explicit old contract | `apps/office/AGENTS.md`, `ui/shell/office_shell_layout.gd` | Latest user request supersedes this composition. Update layout, assertions and documentation together; do not preserve tests that encode the rejected design |
| Sidebar width grows from `297 * text_scale`; composer floor from `477 * text_scale` | `ui/shell/office_shell_layout.gd::overlays` | Investigate width amplification and missing responsive reflow. This is source evidence, not proof of the exact screenshot's scale or root cause |
| Scene drawer uses provisional fixed dimensions | `app/main.gd::_apply_regions` | Include drawer placement, scaling and resize in R2 rather than patching the composer alone |
| Engine train is 4.7; release downloads pin 4.7.2 | `project.godot`, `.github/workflows/release.yml` | Keep the train unless the local audit proves otherwise. Verify editor + template checksums; do not download an arbitrary latest version |
| Native builds already exist | `apps/office/tools/build-release.sh` | Reuse macOS universal DMG, Linux x64 tar.gz and Windows x64 ZIP naming/layout |
| Maintained Unix installer supports `--office` | `script/install.sh` | Reuse it to install the CLI and client together; don't create a competing curl installer |
| Existing release job builds Office but does not call its two verify scripts | `.github/workflows/release.yml` office job | Add headless and loopback integration checks before exporting; native acceptance remains separate |
| Integration script scans only one of its logs for script errors | `apps/office/tools/verify-integration.sh` | The included replacement checks import, transport, and attach logs/exits, with cleanup and distinct logs |
| Pages already deploys static docs | `.github/workflows/pages.yml`, `script/build-pages.ts`, `script/pages.ts` | Extend the current site at `/ycoding/office/`; do not replace docs/schema/installer assets or create a web-hosted local agent |
| Release workflow publishes with GITHUB_TOKEN | `.github/workflows/release.yml` | Pages must not depend solely on release:published firing. Proposed workflow_run refresh checks a successful trusted release workflow and builds trusted main |
| Export signing is explicitly disabled by current guidance | `apps/office/AGENTS.md` | Unsigned builds must be labeled; signing/notarization is an explicit release task, not a promise from a successful export |

## What was NOT verified

The Mac working tree, provider authentication, settings persistence, process startup, runtime screenshots, Godot test outcomes, signed packages, successful GitHub Actions execution, release asset availability and live Pages deployment. The latest commit message saying “complete” is not acceptance evidence.

## Source references

Each row refers to the pinned path, not the moving main branch. Full clickable source URLs and expected blob identities for guarded integrations are in `integration/BASELINE.json` and `docs/SOURCES.md`. GitHub's fetched source is sufficient for these static findings only. The local agent must reconcile any drift, preserve user edits and retest.
