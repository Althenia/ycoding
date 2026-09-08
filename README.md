# YCoding

<p align="center">
  <img src="./assets/brand/ycoding-wordmark.svg" alt="YCoding — terminal coding agent" width="520">
</p>

YCoding is a TUI-first coding agent for durable repository work. This repository contains the terminal application, local runtime, protocol, client, plugin system, provider integrations, and supporting libraries required to build and ship the `ycoding` executable.

## Product direction

YCoding is:

- **TUI only.** The terminal application is the sole product and release surface.
- **One runtime.** Removed session, configuration, plugin, SDK, event, and UI compatibility paths are not restored.
- **Durable.** Sessions, prompt admission, orchestration, goals, subagents, instructions, compaction, and transcript recovery use durable state.
- **Customizable.** Agents, commands, skills, hooks, plugins, providers, and project artifacts are repository-native extension points.
- **Provider-efficient.** Stable prompt prefixes, provider-specific request lowering, cache telemetry, and prompt caching are product contracts.

Start with [`docs/README.md`](./docs/README.md). Product scope, architecture, configuration, and runtime behavior are maintained in the root `docs` directory.

## Implemented capabilities

- Durable sessions with location-scoped runtime services.
- Normal, yolo, and goal-driven execution modes.
- Durable background subagents with parent-session reporting.
- Session skill activation, conflict reporting, and rehydration.
- Project and global artifacts for skills, commands, agents, and plugin drafts.
- Provider cache diagnostics and explicit prompt-cache support.
- Complete resident transcript loading for the currently open Session.
- TUI session timeline, diagnostics, project-artifact management, and session-skill inspection.

See [`docs/runtime.md`](./docs/runtime.md) for behavior details.

## Install

After the `0.1.0` release and GitHub Pages deployment are published, install on macOS (Apple Silicon or Intel) or Linux x64:

```sh
curl -fsSL https://althenia.github.io/ycoding/install.sh | sh
```

The installer verifies the release archive's SHA-256 checksum, installs `ycoding` in `~/.local/bin`, and adds that directory to a supported shell profile when missing. It does not require `sudo` or a separate Bun installation. Windows users can extract `ycoding.exe` from the release ZIP.

## Run and update

```sh
# Open the interactive terminal interface
ycoding

# Run a prompt directly without opening the TUI
ycoding --model <provider/model> "Explain this repository"

# Use the explicit command for additional run options
ycoding run --help

# Update an installed release binary
ycoding update
```

Direct runs use the same durable Session runtime and permissions as the terminal interface. Configure a provider before running a model. Self-update is supported on the installer platforms; local development builds and Windows binaries are not self-updated. On Windows, download and replace the executable manually after exiting YCoding.

## Documentation site

The GitHub Pages workflow publishes YCoding's maintained documents at <https://althenia.github.io/ycoding/>. Enable **Settings → Pages → Source → GitHub Actions** in this repository before deployment.

The site includes configuration guidance and a generated JSON Schema for editor validation:

```jsonc
{
  "$schema": "https://althenia.github.io/ycoding/ycoding.schema.json",
}
```

Build the static site locally with `bun script/build-pages.ts`. Generated output lives in `dist/pages`; edit the maintained Markdown or configuration Schema, not the generated output.

## Release 0.1.0

The release workflow verifies workspace types, CLI suites, transcript and approval regressions, goal continuation, installer, and documentation before building macOS arm64/x64, Linux x64, and Windows x64 binaries with `YCODING_VERSION=0.1.0`. Dependency installation uses the frozen lockfile, and every native build runs artifact/runtime smoke checks. Manual dispatch from `main` prepares downloadable workflow artifacts without publishing. Pushing the exact tag `v0.1.0` from a commit reachable from `main` publishes the release after those checks succeed.

Release downloads contain native executable archives, their SHA-256 checksum manifest, and GitHub's automatic source archives. No npm package or container publication is part of this workflow.

## Requirements

- Bun `1.4.2` for development, pinned by `packageManager` in [`package.json`](./package.json). Prebuilt binaries do not require a separate Bun installation.
- A supported terminal on macOS, Linux, or Windows.

## Local development

```bash
bun install --frozen-lockfile
bun run dev
```

The root `dev` command starts the CLI/TUI entrypoint from `packages/cli`.

## Build and smoke tests

```bash
bun run build:tui
bun run smoke:tui
bun run smoke:runtime
```

Build output is written to `dist/tui`.

## Verification

The root `test` script intentionally refuses an unbounded repository test run. Run targeted package tests, then repository checks.

```bash
cd packages/tui
bun test test/branding.test.ts test/app-lifecycle.test.tsx

cd ../..
bun run check:ycoding-workspace
bun run check:ycoding-brand
bun run typecheck
bun run lint
bun run lint:effect-patterns
```

## Package boundaries

The active workspace is explicitly limited to the packages required by the terminal product. See [`docs/architecture.md`](./docs/architecture.md) and [`script/ycoding-workspace.ts`](./script/ycoding-workspace.ts) for the enforced package set.

## Configuration and repository extensions

YCoding uses the `ycoding` executable, `YCODING_*` environment variables, `.ycoding` repository resources, and `ycoding.json` or `ycoding.jsonc` runtime configuration files.

- [`docs/configuration.md`](./docs/configuration.md) documents runtime, CLI/TUI, service, provider, MCP, permission, and environment configuration.
- [`docs/repository-resources.md`](./docs/repository-resources.md) documents agents, commands, skills, plugins, hooks, tools, themes, instructions, references, and discovery precedence.
- [`docs/guardrails-and-provider-usage.md`](./docs/guardrails-and-provider-usage.md) documents subagent shell permissions, Session guardrails, custom rule files, and provider quota/credit sources.
- [`docs/ycoding-migration.md`](./docs/ycoding-migration.md) documents identity migration and intentional external-provider exceptions.

## License

MIT. See [`LICENSE`](./LICENSE).
