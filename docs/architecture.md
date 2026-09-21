# Architecture

This document specifies the current package boundaries and runtime flow. Exact public shapes remain owned by `packages/schema` and `packages/protocol`.

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
- `remote`
- `schema`
- `script`
- `server`
- `simulation`
- `tui`
- `ui`
- `apps/web` (`@ycoding-ai/web`)

The terminal application and the SolidJS browser client share one local execution runtime. Console, statistics, hosted-agent execution, and legacy SDK packages are outside the product boundary.

`infra/cloudflare/` is deployment infrastructure outside the Bun workspace. It owns edge authentication, device metadata, and the relay transport. It imports no Core or Server implementation and has no model, shell, repository, or tool execution authority.

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
- Remote owns the closed relay envelopes and device-authentication request shapes shared by the CLI, browser, and edge relay. It does not redefine local Session semantics.
- Web owns the responsive browser presentation and curated public content. It must not import Core or Server implementation code.

Client, TUI, and Web code must not import Core or Server implementation modules to mutate durable state.

### Remote presentation boundary

The local CLI connects outbound to the relay and maps a fixed operation set onto the existing authenticated local service. An enrolled machine's authenticated owner can access every Session in that backend. The bridge derives each Location from the paginated backend inventory; a browser cannot supply an arbitrary local URL, HTTP method, filesystem path, or Location header.

The edge authenticates browser users and enrolled devices separately, checks device/account ownership, and routes bounded frames. Each device Durable Object reports current authenticated agent presence to the owner-only device-list API; enrollment and `lastSeenAt` do not imply online status. D1 owns authentication and device metadata, not presence, conversation history, or streamed tool/model output. Durable Session facts remain in the local runtime.

The public build includes only curated `apps/web` content and the installer/configuration downloads exported by `script/build-web-assets.ts`. The engineering `docs` directory is not a public-site input.

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
- Location-scoped on-demand Markdown knowledge storage and derived offline graph export;
- database schema, migrations, event history, and projections;
- process-global and location-scoped runtime services.

Core's ntfy attention observer is process-global so it can receive lifecycle events before a Session's Location services are warm. For each Session it resolves the Location-scoped configuration, permission, and HTTP delivery services; the observer owns no cross-Location delivery authority. Global MCP forms remain local TUI desktop/sound attention and do not enter remote ntfy delivery.

Core remains independent of any specific UI.

`Memory.Service` derives repository identity from the canonical Git common directory so linked worktrees share one collection, reads current configuration lazily, and owns concept validation, bounded retrieval, compare-and-swap writes, and derived files. Shared knowledge uses a separate collection under the same configured base. The built-in `memory` tool applies permissions and Session file-mutation guardrails before calling that service. It imports no UI package and exposes no separate HTTP group or hosted application. See [workspace memory](./memory.md).

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
- transcript rendering and complete resident transcript loading;
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

### Remote ingress infrastructure

`infra/cloudflare` owns the `ycoding-cloud` Worker configuration, D1 binding, and SQLite-backed `DeviceRelay` declaration. A relay instance is addressed by `userId:deviceId`; the smoke implementation fixes those identifiers and serializes per-WebSocket role and connection metadata so hibernation never depends on ordinary JavaScript memory.

The local outbound WebSocket client is process-owned in `packages/cli`. It is transport-only and opt-in for the smoke protocol. Core remains the owner of durable Sessions, Location-scoped execution, tools, filesystem access, and model calls; the TUI remains a client and never owns the remote connection's agent Session.

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

The optional development relay adds an outbound edge after local process startup. It does not replace any step in this runtime flow and carries no Session, prompt, tool, shell, or model payload in the smoke milestone.

Prompt admission and provider execution are separate. A prompt is admitted durably before the process-local coordinator wakes execution. One Session is serialized locally; different Sessions may run concurrently.

## Location scope

Models, providers, provider usage, tools, permissions, Session guardrails, instructions, filesystem access, plugins, and related services are resolved through a Location. Session execution resolves the Session's Location when a drain starts.

`SessionGuardrail` is Location-scoped but evaluates by Session ID. It resolves the root Session through `SessionStore`, shares counters across that family, and mediates mutation immediately before side effects. `ProviderUsage` is Location-scoped and resolves credentials through the existing credential service; it returns normalized, cached snapshots without becoming part of model execution.

## Event flow

Durable events record facts. Projections and read models derive display state from ordered history. Public event streaming and local execution ownership remain separate concerns.

The TUI applies events to a Solid store and reconciles canonical Client reads. A missing or evicted UI row is never durable state.

## State scopes

| Scope | Examples | Owner |
| --- | --- | --- |
| Process-global | execution coordinator, application service nodes | Core process runtime |
| Location | models, providers, provider usage, tools, plugins, permissions, guardrail policy, filesystem, instructions | Core Location services |
| Session durable | messages, pending prompts, autonomy, orchestration, compaction | Core database and event history |
| Project durable | project artifacts and project configuration | Core project-artifact store |
| Global durable | global project artifacts and shared artifact state | Core project-artifact store |
| Process-local Session-family safety | pending guardrail reviews and running shell/subagent/review reservations | Core `SessionGuardrail` service |
| UI resident | complete projected messages for each resident Session, guardrail/provider snapshots, dialogs, scroll state | TUI only |

## Generated and tool-owned content

- Regenerate Client output after public Protocol changes.
- Update database migrations through the owning Core migration workflow.
- Update lockfiles only through Bun dependency operations.
- Update generated model catalogs through the owning CLI command.
- Do not edit generated files, vendor content, or tool-managed output directly.

## Constraints

- The product includes only current runtime paths.
- One logical model step has one explicit provider stream call except documented compaction recovery.
- Session execution ownership is process-local.
- Public HTTP contracts come from Protocol and Schema, not handler-local types.
- Durable state remains replayable; caches and projections remain rebuildable.
- TUI Session eviction releases complete resident transcript payloads; canonical reload rebuilds them.
- Project artifacts use their validated lifecycle instead of writing directly into source directories.
- Agent permissions and Session guardrails are separate mediation layers; neither approval widens the other layer.
- Provider usage failures remain isolated from Session startup and model execution.
