# Architecture

This document specifies the Rust-backend beta's package boundaries and runtime flow. TypeScript presentation contracts live in `packages/schema`, `packages/protocol`, and Client; binary operation descriptors live in `protocol/ycoding/v5`. Rust domain validation and storage codecs live in `ycoding-schema`.

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
- `apps/web` (`@ycoding-ai/web`)

The native CLI embeds and launches `ycoding-runtime`. The full TUI, Mini, and SolidJS browser client share that local execution runtime through binary revision 5 operations. The TypeScript Core, Server, AI, and database-support packages remain source/reference and test surfaces; they do not execute the beta's Sessions. Console, hosted-agent execution, and legacy SDK packages are outside the product boundary.

`infra/cloudflare/` is deployment infrastructure outside the Bun workspace. It owns edge authentication, device metadata, and the relay transport. It imports no Core or Server implementation and has no model, shell, repository, or tool execution authority.

## Dependency direction

The TypeScript contract/reference package graph below is separate from the Rust execution graph. The beta CLI and TUI call Client rather than constructing a TypeScript Server.

The Rust workspace keeps Core independent of application Protocol. Core owns
trusted extension processes and the self-contained private stdio descriptor at
`protocol/ycoding/extension/v5/extension.proto`, compiled by the Core build script
with workspace Prost/Prost Build. Application descriptors remain under
`protocol/ycoding/v5/` and are owned by `ycoding-protocol`; only `ycoding-runtime`
combines Core and Protocol. See the [process-extension contract](../specs/process-extension-v5.md).

```text
schema ───────────────┐
                      ├─> core ───────┐
schema ─> protocol ───┘               ├─> server ─> client ─> cli ─> tui
                                      │
ai / plugin / database support ───────┘
```

Rules:

- Schema owns browser-safe and durable contract values.
- TypeScript Protocol owns the reference Effect `HttpApi` and the generated revision 5 contract metadata and codecs.
- TypeScript Core and Server own the reference implementation and its targeted tests; Rust Core and Runtime own beta execution.
- Client provides generated revision 5 bindings, codecs, request settlement, subscriptions, and service discovery.
- CLI owns the executable, local-service discovery, build, packaging, and TUI startup. Native terminal and Node CLI builds embed the Rust runtime; bootstrap, Store refusal/recovery, observability, registration, and shutdown remain backend-owned. CLI production source/dependencies exclude Core, Server, Meeting, and Plugin packages. Meeting controls use authenticated loopback requests from the private descriptor; MIME lookup and cancellation waiters are frontend-owned.
- TUI owns presentation and interaction, never canonical durable state. Its production import graph is Core- and Server-free, including literal dynamic imports and its Simulation TUI entry. Frontend build metadata, local preference roots, project-copy names, install-layout derivation, and PTY frame presentation remain frontend-owned; backend paths, Skill scopes, package resolution, and provider configuration use Client operations and projections.
- Remote owns the closed relay envelopes and device-authentication request shapes shared by the CLI, browser, and edge relay. It does not redefine local Session semantics.
- Web owns the responsive browser presentation and curated public content. It must not import Core or Server implementation code. The remote browser store is a TanStack Store that owns event-sourced Session state, selection, subscriptions, notices, Team state, and mutations; connection-scoped read resources (provider usage, keep-awake, workspace lists) are TanStack Query resources keyed by device and connection generation, and one Query client discards them when the connection ends. Views read those resources through a non-suspending observer (`apps/web/src/remote/query.ts`) because a Solid Query resource read reaches the router's Suspense boundary and would detach the shell; route loaders preload a view's reads on link intent, and the shell warms the Usage, keep-awake, and workspace reads once after the selected Session settles. Browser-persisted notification preferences are a TanStack Store persisted through browser storage.

Client, TUI, and Web code must not import Core or Server implementation modules to mutate durable state.

### Rust backend

The Rust workspace under `rust/` contains six crates: `ycoding-schema`, `ycoding-store`, `ycoding-protocol`, `ycoding-ai`, `ycoding-core`, and `ycoding-runtime`. Runtime supplies both a library and the `ycoding-runtime` executable. Their crate manifests fix this dependency direction:

```text
ycoding-schema ─> ycoding-ai ────┐
ycoding-schema ─> ycoding-store ─┴─> ycoding-core ─┐
ycoding-protocol ──────────────────────────────────┴─> ycoding-runtime
```

- `ycoding-schema` owns the lossless string and JSON codec and the typed domain contract: branded IDs, durable and ephemeral event payloads, Session and orchestration shapes, and validation shared across process boundaries. It depends on no other workspace crate.
- `ycoding-store` owns the redb storage engine and its transaction, snapshot, catalog, and ordered-key boundary. Domain owners supply compiled table declarations and Schema-owned record codecs; the engine supplies no foreign-key or cascade framework. It depends only on `ycoding-schema`.
- `ycoding-protocol` owns the revision 5 wire contract described below. Its manifest depends on no other workspace crate; its build generates the Rust operation table from the canonical protobuf descriptors.
- `ycoding-ai` owns provider-native request lowering and incremental response settlement. It performs exactly one physical attempt per route execution and does not own Sessions, permissions, provider discovery, configuration, credential storage, quota refresh, or durable events. It depends only on `ycoding-schema`.
- `ycoding-core` owns the Rust runtime behavior built on Schema, Store, and AI: Session creation, prompt admission, execution, history, compaction, and retention; configuration, resources, instructions, permissions, guardrails, forms, and questions; models, providers, and credentials; durable subagent orchestration and autonomy; skill and project-artifact handling; MCP; shell, PTY, browser, computer, meeting, and tool execution boundaries; and the event feed.
- `ycoding-runtime` maps revision 5 operations onto Core. It owns the Sans-IO connection's socket adapter, dispatch, local authentication boundary, per-Location service construction, and the server entry points `serve` and `serve_with`, which serve one WebSocket route, `/ws/v5/local`, on a caller-supplied multi-thread Tokio listener.

The revision 5 wire contract is declared in `protocol/ycoding/v5/` (`foundation.proto`, `operations.proto`, `shared.proto`, `session.proto`, `resources.proto`, `platform.proto`, and `connector.proto`). Each file declares one protobuf service per operation group and one RPC per operation with an explicit operation ID, diagnostic name, typed errors, roles, scope, mutation, settlement, paging, streaming, and sensitivity annotations; these declarations describe binary WebSocket operations and do not enable gRPC. Field constraints and `domain_obligations` are generated metadata: structural validators enforce the bounds, while wire-to-domain conversion in `ycoding-schema` must enforce the obligations before a handler runs. The TypeScript generation owner is `bun run --cwd packages/protocol generate:v5`; the Rust protocol build generates the matching `OPERATIONS` table and `DOMAIN_OBLIGATIONS` from the same descriptors. Neither generated table grants permission or implements dispatch. Exact operation shapes and coverage rules are specified in [`specs/wire-resources.md`](../specs/wire-resources.md) and the sibling wire contracts.

The standard runtime dispatcher registers Session execution and reads, catalogs and credentials, configuration, permissions, Forms and guardrails, filesystem/assets, shell/PTY, native controls, usage and telemetry, and remote connector controls. Role and scope metadata constrain admission; a descriptor alone does not make an operation served. Relay-owned notices are served by the hosted relay, not the local runtime.

`launch` resolves channel roots, installs logging, imports/opens the Store, composes `Core::production`, installs signal handling, binds the listener, and publishes readiness and owned service registration. Production shares global credential, provider, shell, native-control, event-feed, artifact, and execution owners. Each Location composes a generation of configuration, resources, MCP, trusted process extensions, tools, and runner/helper services. Configuration reload installs a replacement generation; held calls keep their generation until it is retired and released. Meeting is opt-in and survives Location reload under its own owner.

The CLI embeds the runtime payload at build time and extracts it into a version-and-SHA-256-addressed private executable path before launch. A cached payload must match its embedded digest. Native builds require a matching host target; release archives retain the installed updater's accepted entries, with no separate runtime entry. Source execution uses a local Rust debug build or `YCODING_RUNTIME_EXECUTABLE`. See [runtime executable configuration](./configuration.md#rust-runtime-executable).

The backend stores canonical data in redb. Usage and latency reporting use derived DuckDB analytics owned by Store's report engine; those derived tables are not an independent authority for Session history. Beta first start imports stable SQLite through private scratch and verified candidate publication. Core and per-Location Meeting imports have separate completion markers. See [global directories](./configuration.md#global-directories) and [Meeting capture](./configuration.md#meeting-capture).

### Remote presentation boundary

The Rust runtime connects outbound to the relay and dispatches its closed revision 5 operation set directly to Core. CLI enrollment and connection controls use the local v5 client. An enrolled machine's authenticated owner can access every existing and future Session in that backend. The runtime resolves each Session's recorded Location; a browser cannot supply an arbitrary local URL, HTTP method, filesystem path, or Location header.

The browser batches fixed, content-free latency samples through this same authenticated device connection. The relay forwards them without persistence; the connector dispatches machine-global authenticated telemetry operations into the backend's bounded local store. The browser reads only the selected machine's saved samples through a separate bounded operation, and account/relay-only events are never misattributed to that machine.

The edge authenticates browser users and enrolled devices separately, checks device/account ownership, and routes bounded frames. Each device Durable Object reports current authenticated agent presence to the owner-only device-list API; enrollment and `lastSeenAt` do not imply online status. D1 owns authentication and device metadata, not presence, conversation history, or streamed tool/model output. Durable Session facts remain in the local runtime.

The web Office presentation is a Phaser scene loaded only while Office is shown. It reads the same browser store through a read-only adapter and emits only local selection and camera intents; prompts, replies, interruption, and settings stay in Solid components. It adds no transport, relay operation, or execution authority.

The public build includes only curated `apps/web` content and the installer/configuration downloads exported by `script/build-web-assets.ts`. The engineering `docs` directory is not a public-site input.

## Package ownership

### `packages/schema`

Owns branded IDs, public domain records, durable event payloads, session and orchestration shapes, project-artifact contracts, and validation shared across process boundaries.

A Schema change is a public-contract change unless proven otherwise.

### Rust Core and Store

Owns:

- session creation, prompt admission, execution, history, compaction, and restart continuation;
- instructions, permissions, forms, questions, shell execution and durable shell process ownership, PTY, and filesystem behavior;
- models, providers, credentials, and configuration;
- durable subagent orchestration and autonomy;
- skill discovery, activation, and session status;
- project-artifact storage, validation, packaging, lifecycle, and accounting;
- Location-scoped on-demand Markdown knowledge storage and derived offline graph export;
- machine-scoped bounded client telemetry and consent;
- canonical Store transactions, event history, and projections;
- process-global and location-scoped runtime services.

Core remains independent of any specific UI.

The Rust memory service derives repository identity from the canonical Git common directory so linked worktrees share one collection, reads current configuration, and owns concept validation, bounded retrieval, compare-and-swap writes, and derived files. Shared knowledge uses a separate collection under the same configured base. The built-in `memory` tool applies permissions and Session file-mutation guardrails before calling that service. It exposes no hosted application. See [workspace memory](./memory.md).

### `packages/protocol`

Owns the public Effect `HttpApi`: operation groups, request and response transport shapes, middleware placement, error contracts, and OpenAPI assembly inputs.

### `ycoding-runtime`

Owns beta dispatch and local authentication, CORS/origin policy, readiness, registration, remote connector, and managed-process lifecycle. Runtime converts canonical protobuf requests to Schema-validated domain inputs before calling Core. `/health`, `/api/health`, and `/api/service/stop` serve bootstrap/discovery and exact-instance stop; application controls use `/ws/v5/local`, not the reference HTTP API.

### `packages/client`

Owns generated and handwritten Client APIs and local-service discovery helpers. Beta presentation uses `@ycoding-ai/client/v5`; generate Protocol metadata with `bun run --cwd packages/protocol generate:v5` and Client bindings with `bun run --cwd packages/client generate:v5`. The HTTP generator owns the reference Client surface separately. Do not edit generated files directly.

### `ycoding-ai`

Owns provider request lowering and response normalization, including OpenAI, Anthropic, compatible-provider protocols, reasoning, tool calls, media, prompt-cache controls, and normalized usage telemetry.

Core chooses policy and context. AI translates that decision into provider wire formats.

### Extensions and presentation plugins

Rust Core owns configured trusted process extensions over its private revision 5 stdio channel. Configuration supplies executable, identity, and host grants; Location lifetime owns launch, reload, cancellation, and cleanup. Runtime JS/TS/npm plugins and dynamic provider loading are unsupported. `packages/plugin` supplies presentation contracts and reference test surfaces; terminal plugins load through `cli.json`. See [repository resources](./repository-resources.md#plugins).

Rust Core owns Meeting capture coordination, speech-worker orchestration, local history, and tool-free analysis Sessions. `extensions/meeting` supplies TUI presentation, discovery/bridge consumers, live-page assets, and reference/fixture checks. The authenticated loopback bridge serves `/view` and `/view/capture`; page capture uses a separate view key and fresh consent. The runtime compiles its page and Python worker assets, while configured Python and speech dependencies remain external prerequisites. See [Meeting capture](./configuration.md#meeting-capture).

### `packages/cli`

Owns:

- the `ycoding` executable;
- command parsing and non-interactive execution;
- local managed-service discovery and restart;
- TUI startup dependency construction;
- native and Node frontend build output; native executables are minified, code-split ESM bundles with embedded Bun bytecode and a native Rust runtime payload;
- installer and updater integration;
- artifact and runtime smoke tests.

The release workflow verifies source suites alongside native builds, with independent macOS arm64 legs for isolated-browser integration and source/packaged Chrome extension integration. Packaging and packaged isolated-browser acceptance run in parallel after all native builds succeed. Cloudflare deployment requires every source leg, packaging, and packaged acceptance to succeed; TUI publication requires successful deployment. Manual runs prepare artifacts without deployment or publication.

### `packages/tui`

Owns:

- the YCoding wordmark, terminal title, startup and exit presentation;
- transcript rendering and windowed resident transcript loading;
- prompt, autocomplete, commands, keymaps, dialogs, themes, and notifications;
- session, subagent, shell, permission, form, skill, and project-artifact interaction;
- cache and context diagnostics;
- plugin slots and feature plugins.

The TUI keeps bounded read models. It does not own canonical Session state.

### Supporting packages

- `packages/codemode`: code-mode parsing and support behavior.
- `packages/httpapi-codegen`: Client code generation.
- `packages/http-recorder`: deterministic provider and HTTP fixtures.
- `packages/effect-drizzle-sqlite` and `packages/effect-sqlite-node`: database adapters.
- `packages/simulation`: deterministic runtime and provider simulation.
- `packages/script`: shared build and release helpers.

### Remote ingress infrastructure

`infra/cloudflare` owns the `ycoding-cloud` Worker configuration, D1 binding, and SQLite-backed `DeviceRelay` declaration. A relay instance is addressed by `userId:deviceId`; the smoke implementation fixes those identifiers and serializes per-WebSocket role and connection metadata so hibernation never depends on ordinary JavaScript memory.

`ycoding-runtime` owns the opt-in outbound revision 5 connector. It shares Core owners with the local dispatcher but keeps connection-scoped subscriptions and uploads separate. `remote.enroll`, `remote.get`, and `remote.set` expose closed machine controls to the CLI/TUI. Remote device credentials bind the device and relay origin; the hosted relay enforces account ownership. The browser uses the REMOTE_CLIENT binding from `packages/remote`, not an arbitrary local proxy. The server joins the connector before releasing Core and Store. Core remains the owner of durable Sessions, Location-scoped execution, tools, filesystem access, and model calls; the TUI never owns the remote connection.

## Runtime flow

```text
terminal input
  -> TUI Client request
  -> binary revision 5 Protocol operation
  -> Rust Runtime dispatch and domain validation
  -> Location resolution
  -> Rust Core service
  -> effective permission and Session guardrail mediation
  -> durable admission or state transition
  -> process-local execution wake
  -> provider request through Rust AI
  -> durable events and projections
  -> event feed and canonical Client reads
  -> bounded TUI read model
  -> terminal render
```

Prompt admission and provider execution are separate. A prompt is admitted durably before the process-local coordinator wakes execution. One Session is serialized locally; different Sessions may run concurrently.

## Location scope

Models, providers, provider usage, tools, permissions, Session guardrails, instructions, filesystem access, plugins, and related services are resolved through a Location. Session execution resolves the Session's Location when a drain starts. Location-service cache keys normalize absolute-directory path segments and trailing separators before acquisition and invalidation, so equivalent directory references share one service graph; explicit workspace identities remain separate keys.

`SessionGuardrail` is Location-scoped but evaluates by Session ID. It resolves the root Session through `SessionStore`, shares counters across that family, and mediates mutation immediately before side effects. `ProviderUsage` is Location-scoped and resolves credentials through the existing credential service; it returns normalized, cached snapshots without becoming part of model execution.

The Location-scoped Shell records process identity and owed completion notices in the global Store. Production startup reconciles dead shell owners, interrupted execution, and stale child tasks before readiness. Protocol reports lost Session notices separately from running and failed work; the connector maps them to root-family attention without resuming a provider request.

## Event flow

Durable events record facts. Projections and read models derive display state from ordered history. Public event streaming and local execution ownership remain separate concerns.

The TUI applies events to a Solid store and reconciles canonical Client reads. A missing or evicted UI row is never durable state.

## State scopes

| Scope                               | Examples                                                                                                   | Owner                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Process-global                      | execution coordinator, application service nodes                                                           | Core process runtime                    |
| Process-global durable              | background shell process ownership and lost completion notices                                             | Core shell ledger in the local database |
| Location                            | models, providers, provider usage, tools, plugins, permissions, guardrail policy, filesystem, instructions | Core Location services                  |
| Session durable                     | messages, pending prompts, autonomy, orchestration, compaction                                             | Core database and event history         |
| Project durable                     | project artifacts and project configuration                                                                | Core project-artifact store             |
| Global durable                      | global project artifacts and shared artifact state                                                         | Core project-artifact store             |
| Process-local Session-family safety | pending guardrail reviews and running shell/subagent/review reservations                                   | Core `SessionGuardrail` service         |
| UI resident                         | complete projected messages for each resident Session, guardrail/provider snapshots, dialogs, scroll state | TUI only                                |

## Generated and tool-owned content

- Regenerate Client output after public Protocol changes.
- Preserve Store catalog/codec validation and use the owning importer for approved stored-data transitions; never rewrite an incompatible store at startup.
- Update lockfiles only through Bun dependency operations.
- Update generated model catalogs through the owning CLI command.
- Do not edit generated files, vendor content, or tool-managed output directly.

## Constraints

- The product includes only current runtime paths.
- One logical model step has one explicit provider stream call except documented compaction recovery.
- Session execution ownership is process-local.
- Public beta wire contracts come from canonical protobuf descriptors and Schema, not handler-local types.
- Durable state remains replayable; caches and projections remain rebuildable.
- TUI Session eviction releases resident transcript windows; a newest-window snapshot read rebuilds them.
- Project artifacts use their validated lifecycle instead of writing directly into source directories.
- Agent permissions and Session guardrails are separate mediation layers; neither approval widens the other layer.
- Provider usage failures remain isolated from Session startup and model execution.
