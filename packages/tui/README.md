# TUI local transport

The full TUI and Mini use `@ycoding-ai/client/v5`. Application requests and decoded public events share the authenticated binary `/ws/v5/local` connection. The client derives `server.connected` from Ready; it is not a wire event. Reconnection replaces connection ownership without replaying requests. Unsent and unknown-outcome failures remain typed and reach the existing submission, toast, or Mini error display.

## Launcher boundary

The full TUI accepts `server.endpoint: Discovery` (`{ url: string, auth?: { type: "basic", username: string, password: string }, wireRevision?: number, contractDigest?: string }`). Optional `server.service.reconnect(signal: AbortSignal): Promise<Discovery>` rediscoveries supply fresh endpoints; `server.service.restart(): Promise<void>` controls the launcher-owned service. The TUI owns and closes its v5 clients. Its initial Location is the process working directory; backend Location responses resolve subsequent Location-scoped reads.

Mini accepts `sdk: V5Client`, `directory: string`, optional `reconnect(signal: AbortSignal): Promise<V5Client>`, and the existing `target(sdk, signal)` / `createSession(sdk, input, signal)` callbacks. The CLI must construct these clients with `YCoding.make({ endpoint, location: { directory } })`, or `YCoding.make({ discover: async () => endpoint, location: { directory } })`. Mini closes replaced and final clients; the launcher retains service/process ownership. Target callbacks must resolve a real Session ID and its backend-owned Location before Session reads; they must preserve durable agent/model/profile/variant selection.

Specialized PTY connections and authorized editor connections retain their separate protocols; their control and discovery operations use canonical client methods.

## Frontend ownership

The TUI production graph contains no Core or Server module. Schema, Protocol, Client, the pure TUI Plugin API, and the Core-free Simulation TUI entry own its workspace imports. `bun packages/tui/script/check-boundary.ts` resolves every production entry's static and literal dynamic workspace import transitively and rejects Core or Server reachability.

Frontend version and channel come from the executable's build constants. Status reports the backend version separately from `health.get`. Frontend preference, theme, and UI-history paths use the frontend's XDG roots without initializing backend directories. Backend path labels, project-copy worktree destinations, and Skill scopes use backend projections. The installed Chrome extension directory is derived from the same executable used to launch the frontend.

Custom endpoint saving invokes `provider.configure` for the backend's global configuration target before connecting or activating a credential profile and refreshing provider read models. The TUI never writes provider configuration documents or embeds credential material in that configuration request.

Family economics, activity, and captured changes are local presentation folds over loaded history and resident Session information. Captured changes retain T10's known/incomplete labelling, available root and authorized child patches, and failed-child-only retry. The shared Client correlation codec identifies dispatched inputs without importing runtime orchestration. The canonical captured-change list is all-or-error and cannot provide per-child retry. The three family projections admit Remote Client and Relay roles; the local TUI connection cannot invoke them.

## Provider presentation

Integration and model dialogs use the backend's lists without a frontend provider allowlist. Supported providers are OpenAI (API key and Codex subscription), Anthropic (API key and Claude Code subscription), OpenRouter, Cursor, Meta (Muse and API key), Cline (`cline-pass`), Z.ai, MiniMax, Kimi, and custom OpenAI-compatible endpoints, including local servers. Integration authentication methods, profile labels, and environment connection summaries come from the backend.

OpenAI and Anthropic appear in the Popular integration group; other backend integrations appear alphabetically under Services. Models sort by availability, provider name, newest release, and model title. Connect offers a Custom OpenAI-compatible endpoint action; its dialog configures a URL, Chat or Responses API, optional model catalog and models, and credential profile. Local servers use that same dialog; it has no local-server preset selector. Retry links use the standard dialog treatment. Vendor-named themes remain independent of provider support.

## Protocol limitations

Global Form reply/cancel and attachment/asset reads require the client/protocol phase-B contract. The TUI calls canonical methods and displays their explicit failures; it does not use another transport. The Rust runtime must serve `location.get` and the Session command, compact, switchAgent, switchModel, skill, skills, resolveSkillConflict, shell, subagent.launch, generate, and move methods before those reads/actions can succeed. File-bearing prompt admission requires runtime attachment resolution. `generate.text` has a registered Location-scoped runtime handler.

The runtime event connection must forward ephemeral public events as well as durable Session events. The TUI depends on live text/reasoning/tool-input deltas, usage/diagnostics/prediction updates, permissions, questions, forms, guardrails, catalog/config/resource/MCP changes, shell/PTY changes, todo changes, and TUI controls. Snapshot and reconnect reconciliation remain canonical, but cannot substitute for absent live event delivery.

## Transcript reload reconciliation

The TUI reloads the canonical newest message window when a durable Session sequence gap is detected. Durable events at or below the snapshot watermark are discarded before store and row consumers. A reload remains read-only and never resumes provider execution.

Reconcile assistant parts even when live events touch the resident message during the read. Match text and reasoning by type ordinal and tools by call ID. Preserve touched or active resident metadata and matching live parts, include recovered canonical-only parts, and retain resident-only live parts when the canonical part set shrinks. For untouched incomplete assistants, retain prefix-extending live text, reasoning, and streaming tool input over the canonical prefix. Each message and part identity appears once; rows reference only resident messages and parts.

## Regression boundary

The fixture uses the real v5 client, handshake, binary codecs, request settlement, bulk results, event batches, cancellation, and reconnect ownership against a scripted protocol peer. Existing URL/Request/Response values are scenario notation for retained assertions, not an HTTP transport; the listening screen harness accepts only the v5 WebSocket upgrade. The peer uses the protocol package's connection state machine with one monotonic clock and unique bulk-transfer IDs.

Retain the newest-100 snapshot, opaque older paging, watermark discard, resident compaction stop, canonical copy/export, Timeline identity, zero-line unresolved rows, reconnect subagent rehydration, Session resume selection, prediction acceptance, and approval/form/status display assertions. Client/Rust interoperability and the CLI's construction of Mini clients are separate owning-lane checks.

`bun run --cwd packages/tui test:integration:browser` requires `YCODING_V5_TEST_URL` to identify a disposable Rust runtime with ready Core and isolated-browser services, plus optional `YCODING_V5_TEST_PASSWORD` for Basic authentication. It also requires macOS arm64 and installed Chrome 152 or newer. The harness exercises the real v5 client and actual Start/Stop display against that backend; it does not launch the TypeScript HTTP server.

The custom-endpoint credential integration suite requires the same disposable runtime endpoint and `YCODING_V5_TEST_CONFIG_DIR`, its empty watched configuration directory. The caller owns disposal of that runtime and directory. Provider-side Chat/Responses SSE remains an external provider protocol, not a TUI-to-backend transport.
