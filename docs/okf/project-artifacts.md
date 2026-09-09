---
type: Workflow
title: Project Artifacts and Customization
description: Project artifacts are the managed customization system for skills, commands,
  agents, and plugin drafts with validated lifecycle, provenance, and rollback.
tags:
- artifacts
- customization
- lifecycle
- skills
sources:
- id: runtime-doc
  resource: repo:///docs/runtime.md
- id: product-dir
  resource: repo:///docs/product-direction.md
- id: repo-resources
  resource: repo:///docs/repository-resources.md
---

## Supported Kinds and Scopes

Project artifacts support skill, command, agent, and plugin kinds, with project and global scopes; project artifacts can shadow global artifacts through the explicit lifecycle.[^runtime-doc]

Agent artifacts define subagents, command artifacts are non-subtask commands, and plugin artifacts store validated drafts rather than arbitrary executable mutation.[^runtime-doc]

## Lifecycle Stages

Validated lifecycle stages are trial, active, degraded, disabled, and quarantine with tested transition rules.[^runtime-doc]

Versions preserve content digests, provenance, parent versions, state transitions, and fallback identity; manual destructive or cross-scope operations use preview and confirmation tokens.[^runtime-doc]

## Mutation Rules

Artifact mutations must use the validated store lifecycle, revisions, digests, preview and confirmation tokens, provenance, and version transitions, and never write directly into adapter-owned source directories.[^runtime-doc]

Adapters expose active artifacts to agent, command, skill, and plugin discovery paths; the TUI exposes a project-artifact manager and dialog for lifecycle operations.[^runtime-doc]

## Session Skill Status

Session skill status derives from durable messages and current instruction keys with no second independent authority; agent switch and completed compaction deactivate prior skills with explicit reasons, and conflicts are computed against active skills and instruction declarations.[^runtime-doc]

Repository filesystem resources under .ycoding directories remain valid for direct edits and watcher reload, while project artifacts are durable managed records used when provenance and rollback matter.[^repo-resources]

## Related Concepts

- [Session Execution and Autonomy](./session.md)
- [Package Architecture](./architecture.md)
- [Repository Resources and Discovery](./repository-resources.md)

[^runtime-doc]: repo:///docs/runtime.md
[^repo-resources]: repo:///docs/repository-resources.md
