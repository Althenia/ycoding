# Architecture

Status: **implemented**

This document describes the current TUI-only package boundaries and runtime flow. Exact public shapes remain owned by `packages/schema` and `packages/protocol`.

## Workspace boundary

The active package set is explicit and enforced by `script/ycoding-workspace.ts`:

- `ai`
- `cli`
- `client`
- `codemode`
- `core`
- `effect-drizzle-sqlite`
- `effect-sqlite-node`
- `http-recorder`
- `httpapi-codegen`
- `plugin`
- `protocol`
- `schema`
- `script`
- `server`
- `simulation`
- `tui`
- `ui`

Desktop, browser, console, website, statistics, hosted-application, and legacy SDK packages are outside the product boundary and must not be restored accidentally.

## Dependency direction

```text
schema ───────────────┐
                      ├─> core ───────┐
schema ─> protocol ───┘               ├─> server ─> client ─> cli ─> tui
                                      │
ai / plugin / database support ───────┘

ui ───────────────────────────────────────────────────────────────> tui
```

Rules:

- Schema owns browser-safe and durable contract values.
- Protocol owns the Effect `HttpApi`, transport schemas, and middleware declarations.
- Core owns persistence and runtime behavior.
- Server maps Protocol operations to Core services and owns process lifecycle.
- Client consumes the assembled Protocol and provides generated and composed APIs.
- CLI owns the executable, local-service discovery, build, packaging, and TUI startup.
- TUI owns presentation and interaction, never canonical durable state.
- UI provides reusable theme and presentation primitives used by the TUI.

Client and TUI code must not import Core or Server implementation modules to mutate durable state.

## Package ownership

### `packages/schema`

Owns branded IDs, public domain records, durable event payloads, session and orchestration shapes, project-artifact contracts, and validation shared across process boundaries.

A Schema change is a public-contract change unless proven otherwise.

### `packages/core`

Owns:

- session creation, prompt admission, execution, history, compaction, and restart continuation;
- instructions, permissions, forms, questions, shell, PTY, and filesystem behavior;
- models, providers, credentials, and configuration;
- durable subagent orchestration and autonomy;
- skill discovery, activation, and session status;
- project-artifact storage, validation, packaging, lifecycle, and accounting;
- database schema, migrations, event history, and projections;
- process-global and location-scoped runtime services.

Core remains independent of any specific UI.

### `packages/protocol`

Owns the public Effect `HttpApi`: operation groups, request and response transport shapes, middleware placement, error contracts, and OpenAPI assembly inputs.

### `packages/server`

Owns concrete handlers, middleware implementations, CORS and authentication policy, service status, event feeds, and managed-process lifecycle. Server does not redefine public shapes independently of Protocol and Schema.

### `packages/client`

Owns generated and handwritten Client APIs for the public `HttpApi`, plus local-service discovery helpers. Regenerate Client output through the package's owning command after public Protocol changes; do not edit generated files directly.

### `packages/ai`

Owns provider request lowering and response normalization, including OpenAI, Anthropic, compatible-provider protocols, reasoning, tool calls, media, prompt-cache controls, and normalized usage telemetry.

Core chooses policy and context. AI translates that decision into provider wire formats.

### `packages/plugin`

Owns Effect and Promise plugin contracts, hooks, tools, session extensions, integration transforms, and TUI extension APIs. Plugins extend declared surfaces and do not bypass durable services through undocumented side channels.

### `packages/cli`

Owns:

- the `ycoding` executable;
- command parsing and non-interactive execution;
- local managed-service discovery and restart;
- TUI startup dependency construction;
- native and Node build output;
- installer and updater integration;
- artifact and runtime smoke tests.

### `packages/tui`

Owns:

- the YCoding wordmark, terminal title, startup and exit presentation;
- transcript rendering and archive pagination;
- prompt, autocomplete, commands, keymaps, dialogs, themes, and notifications;
- session, subagent, shell, permission, form, skill, and project-artifact interaction;
- cache and context diagnostics;
- plugin slots and feature plugins.

The TUI keeps bounded read models. It does not own canonical Session state.

### Supporting packages

- `packages/ui`: reusable theme and visual primitives.
- `packages/codemode`: code-mode parsing and support behavior.
- `packages/httpapi-codegen`: Client code generation.
- `packages/http-recorder`: deterministic provider and HTTP fixtures.
- `packages/effect-drizzle-sqlite` and `packages/effect-sqlite-node`: database adapters.
- `packages/simulation`: deterministic runtime and provider simulation.
- `packages/script`: shared build and release helpers.

## Runtime flow

```text
terminal input
  -> TUI Client request
  -> Protocol operation
  -> Server handler
  -> Location resolution
  -> Core service
  -> effective permission and Session guardrail mediation
  -> durable admission or state transition
  -> process-local execution wake
  -> provider request through AI
  -> durable events and projections
  -> event feed and canonical Client reads
  -> bounded TUI read model
  -> terminal render
```

Prompt admission and provider execution are separate. A prompt is admitted durably before the process-local coordinator wakes execution. One Session is serialized locally; different Sessions may run concurrently.

## Location scope

Models, providers, provider usage, tools, permissions, Session guardrails, instructions, filesystem access, plugins, and related services are resolved through a Location. Session execution resolves the Session's Location when a drain starts.

`SessionGuardrail` is Location-scoped but evaluates by Session ID. It resolves the root Session through `SessionStore`, shares counters across that family, and mediates mutation immediately before side effects. `ProviderUsage` is Location-scoped and resolves credentials through the existing credential service; it returns normalized, cached snapshots without becoming part of model execution.

## Event flow

Durable events record facts. Projections and read models derive display state from ordered history. Public event streaming and local execution ownership remain separate concerns.

The TUI applies events to a bounded Solid store and reconciles canonical Client reads. A missing, archived, or evicted UI row is never durable state.

## State scopes

| Scope | Examples | Owner |
| --- | --- | --- |
| Process-global | execution coordinator, application service nodes | Core process runtime |
| Location | models, providers, provider usage, tools, plugins, permissions, guardrail policy, filesystem, instructions | Core Location services |
| Session durable | messages, pending prompts, autonomy, orchestration, compaction | Core database and event history |
| Project durable | project artifacts and project configuration | Core project-artifact store |
| Global durable | global project artifacts and shared artifact state | Core project-artifact store |
| Process-local Session-family safety | pending guardrail reviews and running shell/subagent/review reservations | Core `SessionGuardrail` service |
| UI resident | hot messages, one expanded archive page, guardrail/provider snapshots, dialogs, scroll state | TUI only |

## Generated and tool-owned content

- Regenerate Client output after public Protocol changes.
- Update database migrations through the owning Core migration workflow.
- Update lockfiles only through Bun dependency operations.
- Update generated model catalogs through the owning CLI command.
- Do not edit generated files, vendor content, or tool-managed output directly.

## Constraints

- V1 paths are not part of the product.
- One logical model step has one explicit provider stream call except documented compaction recovery.
- Session execution ownership remains process-local until clustering is implemented explicitly.
- Public HTTP contracts come from Protocol and Schema, not handler-local types.
- Durable state remains replayable; caches and projections remain rebuildable.
- TUI pagination may release payloads but preserves stable placeholders and canonical reload.
- Project artifacts use their validated lifecycle instead of writing directly into source directories.
- Agent permissions and Session guardrails are separate mediation layers; neither approval widens the other layer.
- Provider usage failures remain isolated from Session startup and model execution.
