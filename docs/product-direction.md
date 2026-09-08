# Product direction

Status: **implemented direction**

YCoding is a standalone, TUI-only coding agent. This document defines maintained product scope; it is not a roadmap and does not promise unimplemented features.

## Product identity

YCoding owns its runtime, terminal experience, package names, configuration, storage, protocol, client, plugin API, and release artifact.

The product goal is a dependable, highly customizable coding-agent runtime with durable execution state, explicit orchestration, and provider-efficient model usage.

## Priorities

### 1. TUI-only delivery

The terminal application is the sole product and release surface.

Changes that affect sessions, prompts, tools, permissions, subagents, skills, project artifacts, cache diagnostics, or transcript history must be proven through the CLI/TUI path. Do not restore desktop, browser, console, website, or hosted-application products.

### 2. Current runtime architecture

YCoding does not restore removed session, configuration, plugin, client, event, or TUI compatibility paths.

New changes extend current contracts. Do not restore removed adapters, duplicate legacy event shapes, or add fallback parsing for obsolete configuration without a documented durable-data migration requirement.

### 3. Durable execution

Sessions preserve user intent and execution state across ordinary process lifecycle boundaries.

Durable state owns prompt admission, session history, instructions, compaction results, orchestration records, autonomy state, and project artifacts. Process-local coordinators may optimize execution but cannot become the sole owner of user-visible state.

### 4. Explicit autonomy

The runtime supports three explicit modes:

- `normal`: standard interactive execution;
- `yolo` (`0-3`): tiered autonomous execution — `1` questions/forms, `2` + permissions (`true` → `2`), `3` + guardrail reviews; `goal` active also auto-answers questions/permissions at `0` but guardrails still require `3`;
- `goal`: repeated progress toward a durable goal until completion, stop, or a bounded no-progress terminal state.

Autonomy remains visible, inspectable, interruptible, and subject to permission ceilings and Session guardrails. Only effective YOLO 3 auto-approves guardrail reviews; `normal`, YOLO 0-2, and active `goal` below YOLO 3 keep reviews enforced. The expanded AUTONOMY sidebar reports Guardrails as `auto · YOLO 3` only at effective YOLO 3 and as `enforced` otherwise. Completion claims require verification evidence.

### 5. Durable background orchestration

Subagents are durable child sessions and run in the background. Parent sessions receive lifecycle updates and can inspect child state after reconnect or restart.

Orchestration preserves explicit agent selection, bounded nesting, permission ceilings, and parent-child ownership. An in-memory task list is not a substitute for durable orchestration.

### 6. Repository-native customization

Customization is a product capability. Supported domains include:

- agents and subagents;
- commands;
- skills and instruction sources;
- hooks and plugins;
- TUI slots;
- MCP servers and tools;
- project and global artifacts;
- model providers;
- Session guardrails and provider-usage sources.

Project artifacts provide managed scope, lifecycle, validation, provenance, and rollback for reusable agent behavior.

### 7. Provider efficiency and correctness

Provider integration optimizes cost and cache reuse without changing semantic behavior.

Priorities include stable prompt prefixes, provider-specific cache controls, accurate cache telemetry, normalized usage and quota reporting, bounded retries, and explicit incompatibility handling. A cache optimization is incomplete if it lowers correctness or hides provider errors. Provider-usage diagnostics must not block model execution or expose credentials.

OpenCode Zen and OpenCode Go remain named as such only because they are external provider identities.

### 8. Documentation and distribution

The terminal executable is distributed as native release archives with SHA-256 checksums. Source archives are provided by GitHub Releases. The `0.1.2` release workflow builds and smoke-tests native artifacts before publishing; a manual workflow run prepares artifacts without publishing a release.

GitHub Pages publishes maintained YCoding documentation, the generated configuration JSON Schema, an example `ycoding.jsonc`, and the shell installer. The site is static documentation, not a separate application package. GitHub Pages must be enabled with GitHub Actions as its source before the public links become available.

## Compatibility policy

- **Durable data:** preserve current data or provide an explicit tested migration.
- **Protocol and client:** generated Client output must match the assembled public `HttpApi`.
- **Plugins:** current contracts only; breaking changes require Schema, API, tests, and documentation updates.
- **Configuration:** current Schema is authoritative; obsolete keys are not accepted through hidden fallback paths.
- **External providers:** preserve provider-owned IDs, URLs, credentials, and names required for interoperability.

## Definition of complete

A product change is complete only when:

- the real runtime path is implemented;
- targeted regression tests pass;
- affected packages typecheck;
- generated output is regenerated through its owning command;
- TUI-visible behavior is verified in the terminal path;
- documentation matches the final behavior;
- no placeholder, mock-only path, stale product reference, or invented external endpoint is presented as production behavior.
