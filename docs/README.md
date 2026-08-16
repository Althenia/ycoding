# YCoding documentation

This directory is the canonical documentation home for YCoding.

YCoding is a standalone, TUI-only, V2-only product. Current code, tests, Schema, Protocol, and these documents define behavior. Historical upstream material is comparison input only.

## Authority

Use this order when sources disagree:

1. Executable behavior and targeted tests in the current checkout.
2. Public contracts in `packages/schema` and `packages/protocol`.
3. Runtime implementation in `packages/core`, `packages/server`, and `packages/ai`.
4. Terminal implementation in `packages/cli` and `packages/tui`.
5. Current documentation in `docs` and accepted contracts in `specs/v2`.
6. Package-level `AGENTS.md` guidance.
7. Historical upstream documentation or source, only for attribution, migration input, or selective porting.

A plan, deleted package, stale generated file, or upstream page does not override current code.

## Index

| Document                                               | Purpose                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [`product-direction.md`](./product-direction.md)       | TUI-only product scope, priorities, and compatibility policy.                                          |
| [`architecture.md`](./architecture.md)                 | Active package graph, ownership, runtime flow, and constraints.                                        |
| [`runtime.md`](./runtime.md)                           | Implemented Session, autonomy, subagent, skill, artifact, cache, guardrail, provider-usage, and transcript behavior. |
| [`configuration.md`](./configuration.md)               | Canonical runtime, CLI/TUI, service, provider, MCP, permission, and environment configuration.         |
| [`repository-resources.md`](./repository-resources.md) | `.ycoding` agents, commands, skills, plugins, hooks, tools, themes, instructions, and discovery rules. |
| [`guardrails-and-provider-usage.md`](./guardrails-and-provider-usage.md) | Operator configuration for agent permissions, custom guardrails, caps, and provider quota sources. |
| [`ycoding-migration.md`](./ycoding-migration.md)       | Canonical YCoding identifiers and external-provider exceptions.                                        |
| [`upstream-differences.md`](./upstream-differences.md) | Historical upstream attribution and maintained divergence ledger.                                      |
| [`../specs/v2/README.md`](../specs/v2/README.md)       | Detailed cross-module contracts and accepted decisions.                                                |
| [`../AGENTS.md`](../AGENTS.md)                         | Mandatory contributor and coding-agent invariants.                                                     |

## Documentation placement

Use `docs` for maintained product, contributor, and operator behavior. Use `specs/v2` for detailed cross-module contracts and accepted architectural decisions that are difficult to recover from one source file.

Do not maintain a second hosted-documentation package in this repository. Do not add public documentation URLs until a real YCoding documentation endpoint exists.

Temporary implementation plans belong under an explicitly temporary planning directory and must not be cited as current behavior.

## Required updates

| Change                                                                             | Required documentation                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Product scope or release surface                                                   | `product-direction.md` and root `README.md`                |
| Package ownership or dependency direction                                          | `architecture.md` and root `AGENTS.md`                     |
| Session, autonomy, subagent, skill, artifact, cache, guardrail, provider-usage, or transcript behavior | `runtime.md`                                               |
| Public HTTP operation or Schema                                                    | relevant `specs/v2` contract and regenerated Client output |
| Runtime, CLI/TUI, service, provider, MCP, permission, or environment configuration | `configuration.md`                                         |
| Agent, command, skill, plugin, hook, tool, theme, or repository resource discovery | `repository-resources.md`                                  |
| Product identity, path, environment, or provider exception                         | `ycoding-migration.md`                                     |
| Historical upstream divergence                                                     | `upstream-differences.md`                                  |
| Contributor invariant or verification requirement                                  | root or package-level `AGENTS.md`                          |

## Status language

- **Implemented:** verified in current code and a concrete runtime or test path.
- **Partial:** real implementation exists with a named limitation.
- **Proposed:** design only; no production behavior may be claimed.
- **Historical:** retained for context and not authoritative.

Never describe proposed or historical behavior as implemented.
