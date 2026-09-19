# Product direction

YCoding is a standalone coding agent. The terminal application is the primary supported surface. This document specifies maintained product scope; it is not a roadmap and does not promise unimplemented features.

## Product identity

YCoding owns its runtime, terminal experience, package names, configuration, storage, protocol, client, plugin API, and release artifact.

The product goal is a dependable, highly customizable coding-agent runtime with durable execution state, explicit orchestration, and provider-efficient model usage.

## Priorities

### Concepts at a glance

| Concept                    | Purpose                                                                               | Read more                                            |
| -------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Session                    | Durable intent, history, pending input, and execution state.                          | [Runtime](./runtime.md)                              |
| Location                   | The folder-scoped runtime environment for configuration, tools, and model resolution. | [Architecture](./architecture.md)                    |
| Agent and subagent         | Configured behavior and durable background delegation with inherited limits.          | [Repository resources](./repository-resources.md)    |
| Autonomy                   | Explicit control over automatic answers, approvals, and goal continuation.            | [Runtime](./runtime.md)                              |
| Permission and guardrail   | Tool authority and family-wide review of high-impact actions.                         | [Operator guide](./guardrails-and-provider-usage.md) |
| Skill and project artifact | Loadable guidance and managed reusable agent customization.                           | [Repository resources](./repository-resources.md)    |
| Workspace memory           | Explicit linked knowledge, separate from transcripts and prompt caches.               | [Memory](./memory.md)                                |
| Provider cache and quota   | Provider-owned reuse telemetry and read-only usage reporting.                         | [Provider efficiency](./provider-efficiency.md)      |

### 1. Terminal-first delivery

The terminal application is the primary product and release surface. A native Godot desktop client is an explicitly approved additional presentation surface that ships from `apps/office/` as a release artifact alongside the CLI; it is a client of the existing public service contracts, never a second runtime.

The desktop client is distributed as a platform archive attached to the same GitHub Release as the CLI, and the maintained installer can place it. It is not notarized: macOS refuses a downloaded bundle until the user allows it deliberately. State that limit rather than describing the download as ready to open.

Changes that affect sessions, prompts, tools, permissions, subagents, skills, project artifacts, cache diagnostics, or transcript history must be proven through the CLI/TUI path. The desktop client consumes those same contracts and owns no execution authority.

The supported surfaces are the terminal application and the native Godot desktop client. There is no Electron, browser-application, console, website, or hosted-application runtime; the native Godot client is a presentation client, not an embedded-browser shell.

### 2. Current runtime architecture

Supported contracts are the current session, configuration, plugin, client, event, and TUI paths.

New changes extend current contracts; there is one current runtime. Changing stored data requires an explicit, tested migration.

### 3. Durable execution

Sessions preserve user intent and execution state across ordinary process lifecycle boundaries.

Durable state owns prompt admission, session history, instructions, compaction results, orchestration records, autonomy state, and project artifacts. Process-local coordinators may optimize execution but cannot become the sole owner of user-visible state.

### 4. Explicit autonomy

The runtime supports three explicit modes:

- `normal`: standard interactive execution;
- `yolo` (`0-3`): tiered autonomous execution — `1` questions/forms, `2` + permissions (`true` → `2`), `3` + guardrail reviews; `goal` active also auto-answers questions/permissions at `0` but guardrails still require `3`;
- `goal`: repeated progress toward a durable goal until completion, stop, or a bounded no-progress terminal state.

Autonomy remains visible, inspectable, interruptible, and subject to permission ceilings and Session guardrails. Only effective YOLO 3 auto-approves ordinary guardrail reviews; `normal`, YOLO 0-2, and active `goal` below YOLO 3 keep reviews enforced. Hard reviews always require a fresh human decision and cannot be bypassed by autonomy or reusable approval. The expanded AUTONOMY sidebar reports Guardrails as `auto · YOLO 3` only at effective YOLO 3 and as `enforced` otherwise, with Hard reviews separately marked `human only`. Completion claims require verification evidence.

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

The terminal executable is distributed as native release archives with SHA-256 checksums. Source archives are provided by GitHub Releases. The release workflow builds and smoke-tests native artifacts before publishing; a manual workflow run prepares artifacts without publishing a release. Each release ships its per-version notes at `docs/releases/v<version>.md`, which is also attached to the GitHub release.

GitHub Pages publishes maintained YCoding documentation, the generated configuration JSON Schema, an example `ycoding.jsonc`, and the shell installer. The site is static documentation, not a separate application package. GitHub Pages must be enabled with GitHub Actions as its source before the public links become available.

## Compatibility policy

- **Durable data:** preserve current data or provide an explicit tested migration.
- **Protocol and client:** generated Client output must match the assembled public `HttpApi`.
- **Plugins:** current contracts only; breaking changes require Schema, API, tests, and documentation updates.
- **Configuration:** current Schema is authoritative; rejected keys are not accepted through hidden fallback paths.
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
