# Source and evidence register

Prepared 2026-09-16. Public source inspection is not native/runtime verification.

User sources: references/REQUEST.md, references/ADDENDUM.md, six files in references/images with hashes in references/manifest.json, and later inline screenshots described in docs/INLINE_REFERENCES.md. The latest explicit requirements govern the target behavior. These are private comparison materials, not licensed production assets.

Pinned YCoding: https://github.com/Althenia/ycoding/tree/77ef4315fa66a8c51c4288e00bfa0a77a635eb63 . Inspected paths include apps/office/{AGENTS.md,project.godot,app/main.gd,ui/shell/office_shell_layout.gd,tools/build-release.sh,tools/verify.sh,tools/verify-integration.sh}, .github/workflows/{release.yml,pages.yml}, script/{install.sh,pages.ts,build-pages.ts}, docs/{configuration.md,guardrails-and-provider-usage.md}, packages/schema/src/provider-usage.ts and packages/protocol/src/groups/{project.ts,location.ts,provider.ts,credential.ts}. Findings are in REMOTE_AUDIT.md and SETTINGS_CATALOG.md. Guarded edits use actual Git blob hashes in integration/BASELINE.json. Source was read via GitHub; direct bulk download in the container was unavailable, so no complete offline source checkout is claimed or included.

Tokscale reference inspected: https://github.com/junhoyeo/tokscale/blob/main/README.md . Use the overview/model/day usage and visualization concepts; do not import its multi-client scanners/public upload workflow into YCoding by default. No Tokscale source code or assets are copied.

Godot release metadata inspected: https://github.com/godotengine/godot-builds/releases/tag/4.7.2-stable . The existing YCoding workflow pins this editor/templates train and SHA-512 values. setup_office_godot.py retains these pins and verifies downloads; no engine was downloaded or executed here.

Official technical references read:
- Input routing: https://docs.godotengine.org/en/stable/tutorials/inputs/inputevent.html
- macOS export/signing: https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_macos.html
- GitHub token event behavior: https://docs.github.com/en/actions/concepts/security/github_token
- Workflow triggers/trust boundaries: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- Pages workflow/permissions: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages

All numerical UI geometry, screen grouping, task decomposition and new budget/player/project behavior in this kit are proposed engineering choices, not externally verified implemented behavior. Re-audit the current source locally.
