# YCoding documentation

This directory is the canonical documentation home for YCoding.

YCoding is a standalone terminal coding agent. Current code, tests, Schema, Protocol, and these documents define behavior.

## Authority

Use this order when sources disagree:

1. Executable behavior and targeted tests in the current checkout.
2. Public contracts in `packages/schema` and `packages/protocol`.
3. Runtime implementation in `packages/core`, `packages/server`, and `packages/ai`.
4. Terminal implementation in `packages/cli` and `packages/tui`.
5. Current documentation in `docs` and accepted contracts in `specs/v2`.
6. Package-level `AGENTS.md` guidance.

A plan, deleted package, or stale generated file does not override current code.

## Index

| Document                                                                 | Purpose                                                                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`product-direction.md`](./product-direction.md)                         | Terminal-first product scope, priorities, and compatibility policy.                                                                          |
| [`architecture.md`](./architecture.md)                                   | Active package graph, ownership, runtime flow, and constraints.                                                                              |
| [`runtime.md`](./runtime.md)                                             | Session, autonomy, subagent, skill, artifact, cache, guardrail, provider-usage, and transcript behavior.                                     |
| [`browser-extension.md`](./browser-extension.md)                         | Selected-tab Chrome bridge installation, isolation boundary, operations, and mutation limits.                                                |
| [`computer-use.md`](./computer-use.md)                                   | Native computer capability, macOS iTerm/Finder boundary, helper development, and packaging.                                                  |
| [`memory.md`](./memory.md)                                               | On-demand workspace knowledge, Markdown concepts, permissions, conflict-safe updates, and offline graph export.                              |
| [`tui-redesign-backlog.md`](./tui-redesign-backlog.md)                   | Proposed post-rebuild design baseline, blocked-contract, diagnostics, provider-reproduction, and scoring backlog.                            |
| [`provider-efficiency.md`](./provider-efficiency.md)                     | Provider request amplification, prompt-cache capability matrix, OpenAI continuation, diagnostics, privacy, and reproducible benchmarks.      |
| [`configuration.md`](./configuration.md)                                 | Canonical runtime, CLI/TUI, service, provider, MCP, permission, and environment configuration.                                               |
| [`repository-resources.md`](./repository-resources.md)                   | `.ycoding` agents, commands, skills, plugins, hooks, tools, themes, instructions, and discovery rules.                                       |
| [`guardrails-and-provider-usage.md`](./guardrails-and-provider-usage.md) | Operator configuration for agent permissions, custom guardrail sources, caps, replies, transient approval reuse, and provider quota sources. |
| [`ycoding-migration.md`](./ycoding-migration.md)                         | Canonical YCoding identifiers and external-provider exceptions.                                                                              |
| [`releases/`](./releases/)                                               | Per-version release notes (`v<version>.md`); the file matching the tag ships as the GitHub release notes and asset.                          |
| [`../specs/v2/README.md`](../specs/v2/README.md)                         | Detailed cross-module contracts and accepted decisions.                                                                                      |
| [`../AGENTS.md`](../AGENTS.md)                                           | Mandatory contributor and coding-agent invariants.                                                                                           |

## Documentation placement

Use `docs` for maintained product, contributor, and operator behavior. Use `specs/v2` for detailed cross-module contracts and accepted architectural decisions that are difficult to recover from one source file.

The static GitHub Pages site is generated from maintained documents in this directory; it is not a second documentation source or application package. The Pages workflow publishes the site to `https://althenia.github.io/ycoding/` after repository Pages settings are enabled. Build locally with `bun script/build-pages.ts`; output is restricted to `dist/pages`. The build generates `ycoding.schema.json` from the runtime configuration Schema and includes `script/install.sh`.

Temporary implementation plans belong under an explicitly temporary planning directory and must not be cited as current behavior.

### Local documentation preview

The generated navigation groups maintained guides into Start, Concepts, Components, Configuration, Runtime, and Capabilities. Proposed backlog documents remain source-only. Each guide has an on-page heading index; configuration schema, example, and installer downloads use the same site base.

Build and mount the output at `/ycoding/`, matching deployment:

```sh
bun script/build-pages.ts
preview=$(mktemp -d)
ln -s "$PWD/dist/pages" "$preview/ycoding"
python3 -m http.server 4174 --bind 127.0.0.1 --directory "$preview"
```

Open `http://127.0.0.1:4174/ycoding/`. Stop the preview with Ctrl-C. Use another free port if needed; do not replace a pre-existing server. Previewing does not publish the site.

## Required updates

| Change                                                                                                 | Required documentation                                     |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Product scope or release surface                                                                       | `product-direction.md` and root `README.md`                |
| Package ownership or dependency direction                                                              | `architecture.md` and root `AGENTS.md`                     |
| Session, autonomy, subagent, skill, artifact, cache, guardrail, provider-usage, or transcript behavior | `runtime.md`                                               |
| Provider request amplification, cache/continuation capability, diagnostics, or efficiency measurement  | `provider-efficiency.md` and `runtime.md`                  |
| Public HTTP operation or Schema                                                                        | relevant `specs/v2` contract and regenerated Client output |
| Runtime, CLI/TUI, service, provider, MCP, permission, or environment configuration                     | `configuration.md`                                         |
| Agent, command, skill, plugin, hook, tool, theme, or repository resource discovery                     | `repository-resources.md`                                  |
| Product identity, path, environment, or provider exception                                             | `ycoding-migration.md`                                     |
| Contributor invariant or verification requirement                                                      | root or package-level `AGENTS.md`                          |

## Authoring guidance

Write product documentation as specifications of current behavior, configuration, interfaces, constraints, and examples.

- Describe the current contract directly. Do not narrate change history ("no longer", "previously", "has been removed"); keep migration instructions and release history in their dedicated documents.
- Do not add implementation-status banners, progress labels, delivery ledgers, or test-run tracking. Keep delivery evidence and unfinished work in the task's tracking artifacts.
- State functional limitations in the relevant specification section. Keep functional state values (`pending`, `connected`, `rejected`, `uncertain`) as specified behavior.
- Never present proposals, historical plans, or unverified behavior as current capabilities; keep proposals separate from current product guides.

Documents that record history or proposals (`ycoding-migration.md`, `tui-redesign-backlog.md`, `specs/v2/schema-changelog.md`, and the decision records under `specs/v2`) are exempt and are not current product guides.
