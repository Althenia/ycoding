---
type: Interface
title: Repository Resources and Discovery
description: Repository-owned agents, commands, skills, plugins, themes, guardrail
  rules, and ambient instructions are discovered upward from .ycoding directories
  with explicit priority and validation.
tags:
- resources
- discovery
- agents
- skills
- plugins
sources:
- id: repo-resources
  resource: repo:///docs/repository-resources.md
- id: config-doc
  resource: repo:///docs/configuration.md
- id: runtime-doc
  resource: repo:///docs/runtime.md
---

## Supported Resource Tree

Supported project resources include runtime configuration, agents, commands, skills, runtime plugins and hooks, terminal themes, and custom guardrail rule files; custom tools must come from a plugin, MCP server, or built-in runtime tool.[^repo-resources]

Agents use recursive agent and agents Markdown discovery with path-derived IDs; commands use recursive command and commands Markdown with required template bodies; skills use root Markdown or recursive SKILL.md layouts.[^repo-resources]

Plugins auto-discover only direct plugin and plugins TypeScript or JavaScript children, while themes use direct themes JSON children and guardrails use direct guardrails Markdown children.[^repo-resources]

## Instructions and References

Ambient instructions load from global AGENTS.md and project-root-to-current-directory AGENTS.md files, with broader context preceding narrower context and per-file truncation through instruction_max_bytes.[^repo-resources]

References are JSON-configured named local or Git context sources; MCP servers contribute tools, prompts, instructions, and resources through mcp.servers rather than source files.[^repo-resources]

## Validation and Reload

A resource file must parse and validate successfully; invalid files are skipped rather than partially loaded, and global plus .ycoding directories are watched with hot reload for supported edits.[^repo-resources]

Hooks are a plugin API rather than a standalone repository file format; .ycoding/hooks paths and top-level hooks configuration are not discovered.[^repo-resources]

## Related Concepts

- [Configuration Surfaces](./configuration.md)
- [Project Artifacts](./project-artifacts.md)
- [Session Execution and Autonomy](./session.md)
- [Package Architecture](./architecture.md)

[^repo-resources]: repo:///docs/repository-resources.md
