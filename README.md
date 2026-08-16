# YCoding

<p align="center">
  <img src="./assets/brand/ycoding-wordmark.svg" alt="YCoding — terminal coding agent" width="520">
</p>

YCoding is a TUI-first coding agent for durable repository work. This repository contains the terminal application, local runtime, protocol, client, plugin system, provider integrations, and supporting libraries required to build and ship the `ycoding` executable.

## Product direction

YCoding is:

- **TUI only.** The terminal application is the sole product and release surface.
- **V2 only.** Removed V1 session, configuration, plugin, SDK, event, and UI paths must not be restored.
- **Durable.** Sessions, prompt admission, orchestration, goals, subagents, instructions, compaction, and transcript recovery use durable state.
- **Customizable.** Agents, commands, skills, hooks, plugins, providers, and project artifacts are repository-native extension points.
- **Provider-efficient.** Stable prompt prefixes, provider-specific request lowering, cache telemetry, and prompt caching are product contracts.

Start with [`docs/README.md`](./docs/README.md). Product scope, architecture, runtime behavior, and inherited-system differences are maintained in the root `docs` directory.

## Implemented capabilities

- Durable V2 sessions with location-scoped runtime services.
- Normal, yolo, and goal-driven execution modes.
- Durable background subagents with parent-session reporting.
- Session skill activation, conflict reporting, and rehydration.
- Project and global artifacts for skills, commands, agents, and plugin drafts.
- Provider cache diagnostics and explicit prompt-cache support.
- Complete resident transcript loading for the currently open Session.
- TUI session timeline, diagnostics, project-artifact management, and session-skill inspection.

See [`docs/runtime.md`](./docs/runtime.md) for behavior details.

## Requirements

- Bun `1.3.14`, pinned by `packageManager` in [`package.json`](./package.json).
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

## Upstream attribution

Historical origin, retained external-provider identifiers, and adoption policy are isolated in [`docs/upstream-differences.md`](./docs/upstream-differences.md). Those references are comparison material, not runtime or documentation authority.

## License

MIT. See [`LICENSE`](./LICENSE).
