# YCoding

Use this guide for work involving YCoding itself: configuration, terminal behavior, plugins, hooks, providers, agents, commands, skills, project artifacts, sessions, subagents, and the local API.

## Authority

YCoding is TUI-only and V2-only. Use sources in this order:

1. Current executable behavior and targeted tests.
2. Public shapes in `packages/schema`.
3. HTTP operations in `packages/protocol` and handlers in `packages/server`.
4. Runtime behavior in `packages/core`.
5. Terminal behavior in `packages/tui` and CLI ownership in `packages/cli`.
6. Root documentation in `docs` and contracts in `specs/v2`.
7. Historical upstream material only when a migration or comparison explicitly requires it.

Do not use removed V1, desktop, web, console, website, or legacy SDK paths as current behavior.

## Product identity

Use:

- `YCoding` in product prose.
- `ycoding` for the executable, process, package slugs, paths, and configuration values.
- `YCODING_*` for environment variables.
- `.ycoding` for repository configuration and project extensions.
- `ycoding.json` or `ycoding.jsonc` for configuration files.
- `x-ycoding-directory` and `x-ycoding-workspace` for location headers.

OpenCode Zen and OpenCode Go remain unchanged only where they identify the external provider integration. See `docs/ycoding-migration.md`.

## Configuration

YCoding configuration uses JSON or JSONC. Do not add an external `$schema` URL unless a real YCoding schema endpoint exists.

Global configuration lives under the platform configuration directory in the `ycoding` namespace. Project configuration can use `ycoding.json`, `ycoding.jsonc`, `.ycoding/ycoding.json`, or `.ycoding/ycoding.jsonc`.

Configuration merges from broader scope to narrower scope. Preserve unrelated settings when editing an existing file. Verify field names and shapes in current config Schema and tests instead of guessing.

Common areas include models, default agents, permissions, agents, commands, plugins, providers, MCP, skills, instructions, references, formatters, LSPs, terminal behavior, and attention settings.

## Plugins, hooks, and project artifacts

Plugins are loaded through the current Effect or Promise plugin entrypoints in `packages/plugin`. Project artifacts can supply agents, commands, skills, and plugin drafts. Verify package exports, configuration adapters, validation, and persistence before documenting or changing an extension point.

Do not describe an unimplemented hook or compatibility bridge as available.

## Sessions and subagents

Sessions are durable V2 aggregates. Prompt admission, autonomy state, goals, instructions, orchestration, subagents, compaction, and transcript history must survive restart and rehydration according to current tests.

Subagents are durable child sessions and run in the background. Parent notification and status projection must not depend on opening the child session in the TUI.

## Terminal application

The terminal application is the only product surface. Build it with:

```sh
bun run build:tui
```

Run the artifact smoke check and runtime smoke check with:

```sh
bun run smoke:tui
bun run smoke:runtime
```

For user help, use the TUI `/help` command or `ycoding --help`.

## Local service and API

YCoding uses a local client-server architecture. The TUI discovers or starts the background service. Service commands include:

```sh
ycoding service status
ycoding service restart
```

The running server exposes its OpenAPI document at `/openapi.json`. Use the current Protocol and generated Client as the API contract.

## Verification

Run the smallest targeted tests first, then the relevant repository checks:

```sh
bun run check:ycoding-workspace
bun run check:ycoding-brand
bun run typecheck
bun run lint
bun run lint:effect-patterns
```

Never report a check as passing unless it completed successfully on the final diff.
