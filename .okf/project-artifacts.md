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
- id: product-dir
  resource: repo:///docs/product-direction.md
- id: runtime-doc
  resource: repo:///docs/runtime.md
- id: spec-v2
  resource: repo:///specs/v2/catalog-config-plugin-lifecycle.md
- id: readme
  resource: repo:///README.md
---

## Supported Kinds

Project artifacts support `skill`, `command`, `agent`, and `plugin` kinds. Scopes are `project` and `global`.[^runtime-doc]

## Lifecycle Stages

Validated lifecycle stages are `trial`, `active`, `degraded`, `disabled`, and `quarantine` with tested transition rules.[^runtime-doc]

## Mutation Rules

Artifact mutations must use the validated store lifecycle, revisions, digests, preview/confirmation tokens, provenance, and version transitions. The system does not write directly into adapter-owned source directories.[^runtime-doc]

## Session Skill Status

Session skill status derives from durable messages and current instruction keys. No second independent skill-status authority is stored. Agent switch and completed compaction deactivate prior skills with explicit reasons. Active conflicts are computed against active skills and instruction declarations.[^runtime-doc]

## Related Concepts

- [Session Execution and Autonomy](./session.md) — session skills derive from durable messages and instruction keys
- [Package Architecture](./architecture.md) — artifact storage lives in Core
- [Coding Conventions](./repository-preference.md) — artifact conventions follow repository standards

[^runtime-doc]: repo:///docs/runtime.md
