# Architecture

* [Package Architecture and Dependency Direction](architecture.md) - YCoding enforces a TUI-only package graph with directed Schema-to-Core/Protocol-to-Server dependencies and explicit state scopes.
* [Provider Integration and Cache](provider-integration.md) - Provider integration optimizes cost and cache reuse without changing semantic behavior, using stable prefixes, provider-native cache controls, normalized usage, and bounded diagnostics.

# Decision

* [TUI-Only Product Direction](product-direction.md) - YCoding is a standalone TUI-only coding agent with durable execution, explicit autonomy, background orchestration, and provider-efficient model usage.

# Interface

* [Provider Usage Snapshots](provider-usage.md) - Provider usage is a read-only best-effort Location-scoped service that normalizes quota and usage snapshots for protocol clients and the terminal usage dialog.
* [Repository Resources and Discovery](repository-resources.md) - Repository-owned agents, commands, skills, plugins, themes, guardrail rules, and ambient instructions are discovered upward from .ycoding directories with explicit priority and validation.
* [Session Protocol and Durable Events](session-protocol.md) - V2 session contracts define prompt admission, execution boundaries, instructions, tools, restart continuity, and public event-stream semantics across Schema, Protocol, and Core.

# Repository Preference

* [Coding Conventions and Repository Standards](repository-preference.md) - Explicit project-wide conventions for TypeScript, Effect, style, naming, imports, control flow, testing, and commits established by tracked instructions and linter configuration.

# Runbook

* [Configuration Surfaces](configuration.md) - YCoding uses three independent configuration surfaces for runtime behavior, terminal presentation, and managed-service identity with explicit precedence and schema validation.

# Workflow

* [Durable Background Subagents](subagents.md) - Subagents are durable child sessions that run in the background with parent-child ownership, permission ceilings, explicit agent selection, and bounded nesting.
* [Project Artifacts and Customization](project-artifacts.md) - Project artifacts are the managed customization system for skills, commands, agents, and plugin drafts with validated lifecycle, provenance, and rollback.
* [Session Execution and Autonomy](session.md) - Sessions provide durable prompt admission, process-local execution, explicit autonomy modes, and prompt delivery vocabulary for the coding-agent runtime.
* [Session Guardrails](session-guardrails.md) - Session guardrails provide a root-Session-family safety boundary independent of agent permissions and autonomy mode, mediating shell and mutation actions through human review.
