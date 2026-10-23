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
```

Rules:

- Schema owns browser-safe and durable contract values.
- Protocol owns the Effect `HttpApi`, transport schemas, and middleware declarations.
- Core owns persistence and runtime behavior.
- Server maps Protocol operations to Core services and owns process lifecycle.
- Client consumes the assembled Protocol and provides generated and composed APIs.
- CLI owns the executable, local-service discovery, build, packaging, and TUI startup.
- TUI owns presentation and interaction, never canonical durable state.
- Remote owns the closed relay envelopes and device-authentication request shapes shared by the CLI, browser, and edge relay. It does not redefine local Session semantics.
- Web owns the responsive browser presentation and curated public content. It must not import Core or Server implementation code. The remote browser store is a TanStack Store that owns event-sourced Session state, selection, subscriptions, notices, Team state, and mutations; connection-scoped read resources (provider usage, keep-awake, workspace lists) are TanStack Query resources keyed by device and connection generation, and one Query client discards them when the connection ends. Views read those resources through a non-suspending observer (`apps/web/src/remote/query.ts`) because a Solid Query resource read reaches the router's Suspense boundary and would detach the shell; route loaders preload a view's reads on link intent, and the shell warms the Usage, keep-awake, and workspace reads once after the selected Session settles. Browser-persisted notification preferences are a TanStack Store persisted through browser storage.

Client, TUI, and Web code must not import Core or Server implementation modules to mutate durable state.

### Remote presentation boundary

The local CLI connects outbound to the relay and maps a fixed operation set onto the existing authenticated local service. An enrolled machine's authenticated owner can access every Session in that backend. The bridge derives each Location from the paginated backend inventory; a browser cannot supply an arbitrary local URL, HTTP method, filesystem path, or Location header.

Relay MCP is a second ingress to the same operation set. The relay authenticates MCP clients as an OAuth authorization server (opaque, hashed grant and token metadata in D1) and forwards only the fixed `mcp.request` operation with a verified owner, device, and client identity. `packages/remote` owns its frame vocabulary; Core owns the SDK-based MCP transport, which takes tool definitions and a callback and imports neither CLI nor Server; `packages/cli` owns the tool mapping, which calls `executeRemoteOperation` for every tool, and the directory-creation operation. The server state file `remote-mcp.json` holds the toggle and enable epoch, and the existing remote status interface carries the Relay MCP state to the authenticated `/api/remote/mcp` routes.

Core's global MCP Events service owns local subscription/outbox persistence, callback signing, and bounded delivery independently of the lazy MCP request handler. Server supplies the CLI connector's authorization interface through a replaceable global node. The connector uses its existing device credential to resolve forwarded requests and recheck exact grants at the relay; no OAuth bearer is added to connector frames. Protocol owns the authenticated global Events endpoints. See [MCP Events](../specs/mcp-events.md).

CLI owns the ephemeral local HTTP-app registry, constrained upstream dispatcher, MCP facade, trusted embedded wrapper, and the connector's preview host, which runs the gateway against that registry. Remote owns the injectable preview-gateway component, which authenticates short-lived app cookies and delegates each HTTP request to a grant-checked dispatcher, and the preview relay frames. `infra/cloudflare` owns the separate `ycoding-preview` Worker and the `PreviewDirectory` Durable Object, which binds each single-use preview origin permanently to one owner, device, and registration and maps ticket and cookie digests to one lease; the preview Worker reaches devices only through the relay's `DEVICE_RELAY` namespace. Application HTML never shares the primary authentication origin or another registration's origin. The checked-in configuration leaves preview disabled. See [registered local HTTP apps](../specs/local-http-apps.md).

The browser batches fixed, content-free latency samples through this same authenticated device connection. The relay forwards them without persistence; the connector writes through a machine-global authenticated Server operation into Core's bounded SQLite store. The browser reads only the selected machine's saved samples through a separate bounded operation, and account/relay-only events are never misattributed to that machine.

The edge authenticates browser users and enrolled devices separately, checks device/account ownership, and routes bounded frames. Each device Durable Object reports current authenticated agent presence to the owner-only device-list API; enrollment and `lastSeenAt` do not imply online status. D1 owns authentication and device metadata, not presence, conversation history, or streamed tool/model output. Durable Session facts remain in the local runtime.

The web Office presentation is a Phaser scene loaded only while Office is shown. It reads the same browser store through a read-only adapter and emits only local selection and camera intents; prompts, replies, interruption, and settings stay in Solid components. It adds no transport, relay operation, or execution authority.

The public build includes only curated `apps/web` content and the installer/configuration downloads exported by `script/build-web-assets.ts`. The engineering `docs` directory is not a public-site input.

## Package ownership

### `packages/schema`

Owns branded IDs, public domain records, durable event payloads, session and orchestration shapes, project-artifact contracts, and validation shared across process boundaries.

A Schema change is a public-contract change unless proven otherwise.

### `packages/core`

Owns:

- session creation, prompt admission, execution, history, compaction, and restart continuation;
- instructions, permissions, forms, questions, shell execution and durable shell process ownership, PTY, and filesystem behavior;
- models, providers, credentials, and configuration;
- durable subagent orchestration and autonomy;
- skill discovery, activation, and session status;
- project-artifact storage, validation, packaging, lifecycle, and accounting;
- Location-scoped on-demand Markdown knowledge storage and derived offline graph export;
- machine-scoped, seven-day Web latency sample retention in local SQLite;
- database schema, migrations, event history, and projections;
- process-global and location-scoped runtime services.

Core remains independent of any specific UI.

`Memory.Service` derives repository identity from the canonical Git common directory so linked worktrees share one collection, reads current configuration lazily, and owns concept validation, bounded retrieval, compare-and-swap writes, and derived files. Shared knowledge uses a separate collection under the same configured base. The built-in `memory` tool applies permissions and Session file-mutation guardrails before calling that service. It exposes no separate HTTP group or hosted application. See [workspace memory](./memory.md).

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

Effect and Promise plugins can inspect/call the existing Location-scoped MCP registry through `context.mcp`; this is a trusted runtime plugin interface, not an agent permission grant. `extensions/meeting` consumes it and tool-free Session generation. Its capture bridge and separate SQLite store outlive TUI components. The bridge serves `/view`; that authenticated live page owns audio capture and sends strict messages to `/view/capture` under the per-bridge view key. Native control has separate authority, and capture heartbeats preserve the runtime's disconnect watchdog. `packages/cli` depends on `@ycoding-ai/meeting` only to compose the bundled runtime plugin into `ycoding meeting`: `serve --meeting` passes it to `packages/server` as a host plugin, which registers it through the existing `SdkPlugins` registry before the server accepts requests. Core and Server do not import the extension. See [meeting intelligence](./meeting-intelligence.md).

### `packages/cli`

Owns:

- the `ycoding` executable;
- command parsing and non-interactive execution;
- local managed-service discovery and restart;
- TUI startup dependency construction;
- native and Node build output; native executables are minified, code-split ESM bundles with embedded Bun bytecode, and one executable provides both the TUI and the local service;
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

`infra/cloudflare` owns the `ycoding-cloud` Worker configuration, D1 binding, and SQLite-backed `DeviceRelay` declaration. A relay instance is addressed by `userId:deviceId` and serializes per-WebSocket role and connection metadata so hibernation never depends on ordinary JavaScript memory. The Worker also serves the OAuth endpoints and MCP resource for each device under `/api/mcp` and `/.well-known`, using the same `DB` and `DEVICE_RELAY` bindings.

The local outbound WebSocket client is process-owned in `packages/cli`. It is transport-only and opt-in through the remote connection toggle. One socket carries three delivery classes scheduled by the connector under the relay's frame rate: control frames (responses, status, inventory invalidations, receipts, heartbeats) first, then per-Session `events` batches and chunked bulk responses interleaved so no Session's stream or large read blocks another; socket backpressure defers bulk only. A browser's `priority` hint lengthens the coalescing window for its Sessions while it is hidden, and a browser `cancel` releases a pending request on the relay and aborts it on the connector. The server process that hosts the local backend owns it: `packages/cli` creates one remote host per server listener, the managed service or a `--standalone` private server, and passes `packages/server` a narrow status and on/off interface that backs the authenticated `/api/remote` routes, so Server never imports the connector. Core remains the owner of durable Sessions, Location-scoped execution, tools, filesystem access, and model calls; the TUI remains a client and never owns the remote connection's agent Session.

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

Models, providers, provider usage, tools, permissions, Session guardrails, instructions, filesystem access, plugins, and related services are resolved through a Location. Session execution resolves the Session's Location when a drain starts. Location-service cache keys normalize absolute-directory path segments and trailing separators before acquisition and invalidation, so equivalent directory references share one service graph; explicit workspace identities remain separate keys.

`SessionGuardrail` is Location-scoped but evaluates by Session ID. It resolves the root Session through `SessionStore`, shares counters across that family, and mediates mutation immediately before side effects. `ProviderUsage` is Location-scoped and resolves credentials through the existing credential service; it returns normalized, cached snapshots without becoming part of model execution.

`ModelIncident` is a process-global service over the global database: its facts, report, recent reads, per-model guidance watermark, and retention are backend-wide. Only guidance capability (`model-guidance` in `capabilities.builtin_instructions`) resolves through a Location, so the guidance routes carry Location middleware and the report and recent routes do not. Remote guidance operations resolve their Location from the verified Session, never from browser input.

The Location-scoped Shell records process identity and owed completion notices in the global database. At managed startup, `SessionRestart` reconciles dead shell owners before Server readiness. Protocol reports lost Session notices separately from running and failed work; the CLI maps them to root-family attention without resuming a provider request.

## Event flow

Durable events record facts. Projections and read models derive display state from ordered history. Public event streaming and local execution ownership remain separate concerns.

The TUI applies events to a Solid store and reconciles canonical Client reads. A missing or evicted UI row is never durable state.

## State scopes

| Scope                               | Examples                                                                                                   | Owner                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Process-global                      | execution coordinator, application service nodes                                                           | Core process runtime                    |
| Process-global durable              | background shell process ownership and lost completion notices                                             | Core shell ledger in the local database |
| Process-global durable              | model incidents and per-model guidance clear watermarks                                                    | Core `ModelIncident` service            |
| Location                            | models, providers, provider usage, tools, plugins, permissions, guardrail policy, filesystem, instructions | Core Location services                  |
| Session durable                     | messages, pending prompts, autonomy, orchestration, compaction                                             | Core database and event history         |
| Project durable                     | project artifacts and project configuration                                                                | Core project-artifact store             |
| Global durable                      | global project artifacts and shared artifact state                                                         | Core project-artifact store             |
| Process-local Session-family safety | pending guardrail reviews and running shell/subagent/review reservations                                   | Core `SessionGuardrail` service         |
| UI resident                         | complete projected messages for each resident Session, guardrail/provider snapshots, dialogs, scroll state | TUI only                                |

## Generated and tool-owned content

- Regenerate Client output after public Protocol changes.
- Update database migrations through the owning Core migration workflow.
- Update lockfiles only through Bun dependency operations.
- Update generated model catalogs through the owning CLI command.
- Do not edit generated files, vendor content, or tool-managed output directly.

## Constraints

- The product includes only current runtime paths.
- One logical model step has one explicit provider stream call per physical attempt; documented retries, compaction recovery, and configured model fallback add attempts within the same Step.
- Session execution ownership is process-local.
- Public HTTP contracts come from Protocol and Schema, not handler-local types.
- Durable state remains replayable, except message rows and message-only events below a valid local compaction checkpoint and message-only events of settled executions, which history pruning deletes; projected messages are the record for pruned history, and caches remain rebuildable.
- TUI Session eviction releases resident transcript windows; a newest-window snapshot read rebuilds them.
- Project artifacts use their validated lifecycle instead of writing directly into source directories.
- Agent permissions and Session guardrails are separate mediation layers; neither approval widens the other layer.
- Provider usage failures remain isolated from Session startup and model execution.

## Account-hosted connector tools

Core owns account connector composition and ChatGPT discovery in `account-connectors.ts`, Claude account-list and fixed-proxy transport in `account-connectors/claude.ts`, and shared canonical tool construction in `account-connectors/tools.ts`. Configuration selects each provider independently. ChatGPT reuses Integration credential snapshots and refresh; Claude resolves its existing managed profile reference through the Claude credential source and refresh implementation. Both reuse the MCP client, Permission, and SessionGuardrail. Session model-request preparation supplies provider-specific profile bindings and request-local registrations to ToolRegistry; materialization captures executable bindings without changing Location-wide registrations. Schema owns the default ask rules for account connector actions. Permission owns mandatory human-only decisions for Claude organization controls. No native client process, desktop bridge, copied credential store, or browser execution participates.

## Task MCP gateway

Core owns the opt-in task MCP transport, OAuth resource-server verification, and durable ownership/admission index. CLI owns the localhost listener and adapts existing generated Client operations to the gateway. The existing service owns Session execution and transcript persistence. The main HttpApi, remote relay, and generated Client surface are unchanged. See [task contract](../specs/task-mcp.md).
