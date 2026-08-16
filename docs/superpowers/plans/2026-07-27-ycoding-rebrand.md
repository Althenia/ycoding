# YCoding TUI-Only Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the customized OpenCode fork into a TUI-only product named YCoding, with one distributable `ycoding` terminal application and no active desktop, web, console, stats, or website product.

**Architecture:** Retain only the workspace dependency closure required to build, test, and run the TUI. Introduce canonical YCoding identity at every active runtime boundary, keep OpenCode names only in explicit migration readers and upstream attribution, regenerate owned artifacts through their scripts, and enforce the boundary with automated residual and workspace checks.

**Tech Stack:** Bun workspaces, TypeScript, Effect, SolidJS, OpenTUI, SQLite, GitHub Actions, Nix.

## Global Constraints

- Product display name is exactly `YCoding`.
- CLI/process/config slug is exactly `ycoding`.
- The only shipped application is the terminal application.
- The only executable is `ycoding`.
- Workspace package scope is exactly `@ycoding-ai/*`.
- Environment prefix is exactly `YCODING_*`.
- New configuration and data locations use `ycoding`; old OpenCode locations are read only by explicit migration compatibility code.
- Active workspace packages are limited to the verified TUI dependency closure: `ai`, `cli`, `client`, `codemode`, `core`, `effect-drizzle-sqlite`, `effect-sqlite-node`, `http-recorder`, `httpapi-codegen`, `plugin`, `protocol`, `schema`, `script`, `server`, `simulation`, `tui`, and `ui`.
- Remove desktop, app, web, console, stats, website, docs-site, Storybook, Slack, enterprise, function, and session-ui packages from the active repository product surface.
- Do not invent a production domain, signing identity, package registry, container registry, or GitHub organization. Release destinations must be explicit configuration, not fabricated YCoding URLs.
- Generated files and lockfiles must be changed through their owning scripts or deterministic regeneration commands.
- OpenCode remains only in migration compatibility, upstream attribution, external provider/model identities that are genuinely named OpenCode, and patches tied to upstream dependencies.
- Each stable phase ends with targeted tests and a commit.

---

### Task 1: Enforce the TUI-only repository boundary

**Files:**
- Create: `script/ycoding-workspace.ts`
- Create: `script/ycoding-workspace.test.ts`
- Modify: `package.json`, `turbo.json`, `tsconfig.json`, root scripts, CI workflows, and repository documentation.
- Remove: non-TUI application/package directories and product-specific infrastructure that are outside the verified dependency closure.

**Interfaces:**
- Produces: `bun run check:ycoding-workspace`.
- Produces: a workspace containing exactly the 17 verified TUI dependency packages.

- [x] Write a failing test that discovers workspace package manifests and reports any active package outside the approved set.
- [x] Run the test and verify it fails against the current 37-package workspace.
- [x] Implement the checker and replace wildcard workspace discovery with the explicit approved package paths.
- [x] Remove non-TUI product directories and their dedicated workflows, scripts, assets, and infrastructure references.
- [x] Regenerate `bun.lock` with `bun install`.
- [x] Run the checker and monorepo typecheck for the reduced workspace.
- [x] Commit.

### Task 2: Add deterministic rebrand and residual enforcement

**Files:**
- Create: `script/ycoding-rebrand.ts`
- Create: `script/ycoding-rebrand.test.ts`
- Create: `script/ycoding-residuals.ts`
- Create: `script/ycoding-residuals.test.ts`
- Modify: `package.json`.

**Interfaces:**
- Produces: deterministic text/path rename manifest for active TUI files.
- Produces: `bun run check:ycoding-brand` that rejects unapproved active OpenCode identifiers.

- [x] Write failing tests for product names, package scopes, environment names, config paths, protocol headers, upstream URLs, provider IDs, and model names.
- [x] Verify the tests fail before implementation.
- [x] Implement explicit replacement rules and narrow compatibility/upstream allowlists.
- [x] Add `rebrand:ycoding` and `check:ycoding-brand` scripts.
- [x] Run tests and commit.

### Task 3: Rename package scope, binary, and build artifacts

**Files:**
- Modify: root and all 17 retained package manifests and imports.
- Rename: `packages/cli/bin/opencode.cjs` to `packages/cli/bin/ycoding.cjs`.
- Modify: build scripts, platform binary helpers, smoke scripts, test fixtures, shell completions, and artifact names.
- Regenerate: `bun.lock`.

**Interfaces:**
- Produces: retained workspace packages under `@ycoding-ai/*`.
- Produces: `ycoding` executable and `tui-<platform>-<arch>` bundles containing `ycoding`.

- [ ] Write manifest and binary-name tests.
- [ ] Verify they fail with current package and executable names.
- [ ] Apply package-scope and binary renames.
- [ ] Regenerate the lockfile.
- [ ] Run typecheck, CLI help tests, and a TUI build.
- [ ] Commit.

### Task 4: Rename runtime identity, environment, configuration, and storage

**Files:**
- Modify: core global paths, config discovery, database paths, auth, cache, logs, snapshots, skills, service registration, CLI/TUI/server/client code, tests, and scripts.
- Rename: repository `.opencode/` to `.ycoding/` and `opencode.jsonc` to `ycoding.jsonc`.
- Add: compatibility helpers that prefer YCoding values and read legacy OpenCode values only when no YCoding value exists.

**Interfaces:**
- Produces: canonical `YCODING_*`, `.ycoding`, `ycoding.json`, and `ycoding.jsonc` behavior.
- Preserves: read-only compatibility for existing OpenCode configuration and data.

- [ ] Write environment precedence tests.
- [ ] Write config discovery order tests.
- [ ] Write legacy data/config migration discovery tests.
- [ ] Implement canonical identity and compatibility helpers.
- [ ] Rename repository-managed configuration and fixtures.
- [ ] Run core, CLI, server, and TUI tests.
- [ ] Commit.

### Task 5: Rename protocol, service, TUI identity, and design the YCoding icon

**Files:**
- Modify: protocol/server/client headers, auth defaults, service names, stdio readiness metadata, terminal titles, browser-opening helpers used by the TUI, storage keys, and TUI copy.
- Rename: active OpenCode-named themes, provider assets, and text fixtures used by the TUI.
- Create: canonical transparent-background YCoding icon and wordmark SVG sources aligned with the Penpot design system.
- Create: terminal-safe monochrome/limited-color YCoding mark for splash, help, and about surfaces.
- Regenerate: transparent PNG release/repository derivatives and generated clients/OpenAPI fixtures through owning scripts.

**Interfaces:**
- Produces: canonical `x-ycoding-*` headers and YCoding TUI/help output.
- Preserves: server acceptance of legacy `x-opencode-*` headers during migration.

- [ ] Write protocol tests for canonical and legacy headers.
- [ ] Write TUI and CLI copy tests for `YCoding` and `ycoding`.
- [ ] Inspect the current Penpot design system, logo, iconography, palette, typography, and TUI frames before drawing the icon.
- [ ] Design the YCoding icon as canonical SVG with transparent background, restrained dark-workbench character, and terminal-safe silhouette; do not reuse the OpenCode logo geometry.
- [ ] Derive the TUI mark and transparent raster release assets from the canonical SVG.
- [ ] Rename service/protocol/TUI identifiers and active text assets.
- [ ] Regenerate clients and OpenAPI fixtures.
- [ ] Run protocol, server, client, CLI, TUI, asset, and codegen tests.
- [ ] Commit.

### Task 6: Convert install, release, Nix, GitHub, and docs to TUI-only YCoding

**Files:**
- Modify: `install`, Nix expressions, GitHub workflows/actions, release scripts, package metadata, contribution/security files, README, AGENTS, and root `docs/`.
- Rename: `.github/workflows/opencode.yml`, `nix/opencode.nix`, and other active tracked filenames containing the old product identity.
- Create: `docs/ycoding-migration.md`.

**Interfaces:**
- Produces: TUI-only install/build/release instructions and artifacts.
- Requires: configurable destinations for any unavailable YCoding distribution endpoint.

- [ ] Write artifact/install command tests.
- [ ] Rename active release and packaging metadata.
- [ ] Remove GUI installation and release instructions.
- [ ] Document binary, package, environment, config, data, and header migration.
- [ ] Verify documentation links and shell/Nix syntax where tools are available.
- [ ] Commit.

### Task 7: Regenerate, scan, and verify the complete TUI-only product

**Files:**
- Regenerate: lockfile, generated clients, OpenAPI fixtures, packaged indexes, and other retained generated artifacts through owning scripts.
- Modify: upstream-difference and migration docs to enumerate every intentional legacy OpenCode reference.

**Interfaces:**
- Produces: clean workspace and brand residual checks.
- Produces: verified `ycoding` terminal artifact.

- [ ] Run all affected generators.
- [ ] Run workspace and brand residual scanners; classify every remaining match.
- [ ] Remove accidental residuals and permit only narrowly documented compatibility/upstream references.
- [ ] Run retained-package tests and monorepo typecheck.
- [ ] Build the TUI and run CLI help, artifact smoke, and runtime smoke checks.
- [ ] Run `git diff --check`, inspect the complete diff, and commit.
