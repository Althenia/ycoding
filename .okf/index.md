# Architecture

* [Package Architecture and Dependency Direction](architecture.md) - The YCoding repository enforces explicit package boundaries, directed dependencies, and state scopes driven by a TUI-only product identity.
* [Provider Integration and Cache](provider-integration.md) - Provider integration optimizes cost and cache reuse without changing semantic behavior, with stable prompt prefixes, cache controls, normalized usage reporting, and session diagnostics.

# Repository Preference

* [Coding Conventions and Repository Standards](repository-preference.md) - Explicit project-wide conventions for TypeScript, Effect, style, naming, imports, control flow, and testing as established by tracked instructions, linter configuration, and repeated authoritative evidence.

# Workflow

* [Durable Background Subagents](subagents.md) - Subagents are durable child sessions that run in the background with parent-child ownership, permission ceilings, explicit agent selection, and bounded nesting.
* [Project Artifacts and Customization](project-artifacts.md) - Project artifacts are the managed customization system for skills, commands, agents, and plugin drafts with validated lifecycle, provenance, and rollback.
* [Session Execution and Autonomy](session.md) - Sessions provide durable prompt admission, process-local execution, explicit autonomy modes, and prompt delivery vocabulary for the coding-agent runtime.
* [Session Guardrails](session-guardrails.md) - Session guardrails provide a root-Session-family safety boundary independent of agent permissions and autonomy mode, mediating shell and mutation actions through human review.
