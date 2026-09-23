# Product direction

YCoding is a standalone coding agent. The terminal application is the primary supported surface; the responsive remote web client controls the same local runtime. This document specifies maintained product scope; it is not a roadmap and does not promise unimplemented features.

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

The terminal application is the primary product and release surface.

Changes that affect sessions, prompts, tools, permissions, subagents, skills, project artifacts, cache diagnostics, or transcript history must be proven through the CLI/TUI path.

Supported presentation surfaces are the terminal application and the SolidJS remote web client. The public site and remote client share `ycoding.althenia.app`. The browser and relay own no repository, shell, tool, model, or Session execution authority. There is no hosted-agent runtime, Electron shell, or native office client in the current product.

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

The terminal executable is distributed as native release archives with SHA-256 checksums. Source archives are provided by GitHub Releases. A `v<version>` tag verifies the TUI and web application, builds and smoke-tests native artifacts, deploys web to Cloudflare after required checks, and publishes one TUI GitHub Release only after deployment succeeds. Deployment requires a `CLOUDFLARE_API_TOKEN` GitHub Actions secret. A manual workflow run prepares artifacts without publishing or deploying. Each release ships one shared note at `docs/releases/v<version>.md`, which is also attached to the GitHub Release.

The public web build publishes a landing page, curated user documentation, a changelog, the generated configuration JSON Schema, an example `ycoding.jsonc`, and the shell installer. Public content contains usage, configuration, and troubleshooting guidance, not engineering architecture, internal infrastructure, database schemas, or implementation plans.

### 9. Remote ingress boundary

Remote access preserves the local runtime as the only execution authority. The Cloudflare Worker and its per-device Durable Object coordinate an outbound local-agent connection with authenticated browser clients. D1 stores authentication and device metadata, never conversation history, model reasoning, streamed output, or tool events.

Remote control requires an authenticated user, an authenticated enrolled device, and ownership of that device. Running `ycoding remote connect` grants that owner access to all existing and future Sessions on the connected local backend. The backend determines each Session's working directory; the browser cannot choose an arbitrary local Location. The operation set is closed; clients cannot proxy arbitrary local requests. Uncertain mutation outcomes must not trigger automatic replay. Reconnection preserves Session identity and reconciles against the existing local durable history.

The responsive layout reflows at desktop, tablet, and mobile breakpoints. Light and dark themes, keyboard-accessible approvals, bounded tool/terminal output, and an accessible composer are required on each surface. Offline mode never queues remote mutations.

The cached offline page provides Home, Documentation, and Changelog navigation and a **Retry** link to `/remote`. It follows the browser's light or dark color preference. Service-worker caching is limited to the public static shell; API, authentication, and WebSocket traffic is excluded. Activating a new shell-cache version removes the prior shell cache. An install prompt alone does not establish native PWA installation or standalone launch; those remain browser- and platform-managed operations.

Remote questions use the runtime's native Forms. The workspace renders string, multiselect, number, integer, boolean, and external-step fields, preserves defaults and conditional visibility, and submits typed answers or explicit cancellation. External steps expose HTTP(S) links and require acknowledgement. Only pending Forms owned by the selected Session can be answered; the local runtime validates every answer.

The device picker lists online, active enrollments. An account refresh that reports the selected machine offline preserves its name and reconnect action rather than switching to another machine. Settings retains offline and revoked enrollments and exposes notification preferences as five event categories with independent workspace and desktop channels.

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
