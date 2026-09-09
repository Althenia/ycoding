---
type: Runbook
title: Configuration Surfaces
description: YCoding uses three independent configuration surfaces for runtime behavior,
  terminal presentation, and managed-service identity with explicit precedence and
  schema validation.
tags:
- configuration
- schema
- precedence
- environment
sources:
- id: config-doc
  resource: repo:///docs/configuration.md
- id: repo-resources
  resource: repo:///docs/repository-resources.md
- id: migration
  resource: repo:///docs/ycoding-migration.md
---

## Configuration Surfaces

YCoding has three independent surfaces: runtime configuration in ycoding.json or ycoding.jsonc, CLI and TUI presentation in global cli.json, and managed-service identity in service.json variants; obsolete tui.json and kv.json are ignored and project-local .ycoding/tui.json is unsupported.[^config-doc]

Global directories resolve through XDG bases with a ycoding namespace for configuration, state, data, cache, and helper binaries; YCODING_CONFIG_DIR overrides the global configuration directory.[^config-doc]

## Runtime Discovery and Precedence

Runtime documents assemble from lowest to highest priority across global files, YCODING_CONFIG, upward project discovery, well-known integration configuration, and YCODING_CONFIG_CONTENT; within one directory, ycoding.jsonc loads after ycoding.json.[^config-doc]

Both JSON and JSONC support comments, trailing commas, unknown ignored properties, schema metadata, and env and file substitution; a missing file reference invalidates that document.[^config-doc]

A document containing any removed key is ignored as a whole, including legacy logLevel, server, agent, provider, tools, and related keys; the legacy MCP shape with server names directly under mcp is also rejected in favor of mcp.servers.[^config-doc]

## Repository Resources and Identity

Repository resources load from upward .ycoding directories with nearer definitions overriding broader ones; supported domains are runtime configuration, agents, commands, skills, plugins, themes, and guardrail rules, with no generic .ycoding/tool loader.[^repo-resources]

Canonical YCoding identity uses YCoding product prose, ycoding executable, @ycoding-ai package scope, YCODING_ environment prefix, .ycoding directory, and x-ycoding headers; OpenCode Zen and OpenCode Go remain only as external provider identities.[^migration]

## Related Concepts

- [Package Architecture](./architecture.md)
- [Repository Resources and Discovery](./repository-resources.md)
- [Session Guardrails](./session-guardrails.md)
- [Provider Integration and Cache](./provider-integration.md)

[^config-doc]: repo:///docs/configuration.md
[^repo-resources]: repo:///docs/repository-resources.md
[^migration]: repo:///docs/ycoding-migration.md
