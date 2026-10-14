# ycoding-ai

Provider-native request lowering and incremental response settlement. This AGPL-3.0-only workspace crate depends on `ycoding-schema` and the approved HTTP, WebSocket, Tokio, JSON, error, and tracing libraries. It does not own Sessions, permissions, provider discovery, configuration, credential storage, quota refresh, or durable events. Use Rust 1.98 or newer.

## Supported routes

| Provider                                              | Native boundary                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| OpenAI API                                            | `providers::openai`, Responses HTTP/WebSocket                     |
| Codex/ChatGPT subscription                            | `openai_codex`                                                    |
| Anthropic API and custom Messages endpoints           | `Route::anthropic_provider`, `Route::anthropic_compatible`        |
| Claude Code subscription                              | `claude_code`, with upstream account resolution                   |
| OpenRouter                                            | `providers::openrouter`, stateless Responses                      |
| Cursor                                                | `cursor::provider`, native Connect/h2                             |
| Meta Muse subscription                                | `muse::route`, account-bound Responses                            |
| Meta Llama API and custom OpenAI-compatible endpoints | `providers::compatible`, Chat/Responses with an explicit base URL |
| Standalone images                                     | `image_providers::openai`, `image_providers::zai`                 |

Core selects the closed product provider set, including Cline Pass, Z.ai, MiniMax and Kimi regional/plan identities, through these native wire families. A compatible route does not register another built-in provider. Localhost and remote custom endpoints use the same explicit endpoint and authentication contracts.

## Inputs and execution

Supply a resolved `llm::Model`, `Request`, and `auth::Credential` from the upstream owner. Model/provider identifiers use Schema domain types. Credential identifiers remain upstream handles; secrets have redacted `Debug` implementations. Routes do not read ambient configuration or environment variables.

Resolution applies route defaults, model defaults, then request overrides. `Route::prepare` applies cache policy and lowers the protocol body; `wire_body` and `encoded_body` include permitted transport overlays. Protocol-owned fields cannot be overlaid. Query overrides preserve unrelated parameters; authentication runs after header/body assembly. JSON content type is authoritative. Anthropic protocol metadata uses the `anthropic` namespace for direct and compatible providers.

Inject a configured `reqwest::Client` into `Executor`. `Executor::http_client` disables ambient proxies and redirects. `Executor::stream` returns an owned `EventStream`; `generate` assembles ordered output. Dropping the stream interrupts transport. `generate_object` forces a named tool; the caller validates its dynamic output schema.

The executor reports physical attempt `1`. Muse can remint a rejected inference key once on HTTP 401; other routes perform one physical attempt. SSE retry directives do not reconnect. A rejected WebSocket continuation does not become an HTTP request. Core owns bounded retries, interruption, and durable Step settlement. Typed failures retain classification, bounded redacted HTTP context, retry-after values and rate-limit scopes.

## OpenAI, compatible routes and OpenRouter

`providers::Config` supplies explicit authentication, optional base URL, query parameters and `llm::Defaults`. `OpenAIConfig` adds organization/project headers and `Transport::Http` or `WebSocket`. Direct OpenAI exposes Responses; `providers::compatible` requires a base URL and selects `Api::Chat` or `Responses` without native OpenAI defaults.

GPT-5.6+ direct routes gate their explicit cache options and breakpoints; older supported models use retention fields. Generic compatible deployments stay key-only. Direct Responses defaults to retained reasoning context and server-compaction configuration. Protocol schema order governs encoded bytes.

Responses preserves encrypted reasoning and opaque compaction items, groups stateless summaries by item identity, reconciles final text without duplication, retains phase/citations, and distinguishes completed/incomplete/failed settlement. Hosted tools stay provider-executed. Chat accumulates partial tool identities/arguments, preserves reasoning fields/details including Meta Llama `thought` as reasoning, separates split `<think>` content, and settles after final usage. Unknown telemetry stays absent.

OpenRouter Responses rejects `store:true` and `previous_response_id`, preserves reasoning/usage and cache/session options, and emits top-level automatic cache control only for Anthropic model identities. It uses the shared error, transport, cancellation and redaction boundaries.

## Subscription routes

Codex binds resolved subscription credentials and optional account identity to its Responses endpoint. Claude Code takes an upstream `Account` owner for account resolution and normalized quota observations; Core owns credential generation, source fencing, managed login and refresh. Credentials and account metadata are not HTTP body overlays.

Muse uses OpenAI Responses lowering and `openai` metadata. Direct keys bypass minting. OAuth binds lazy inference-key minting to credential identity/generation, coalesces mints, and remints once after inference 401. Expired/rejected account tokens require login; no refresh grant is sent. Mint/discovery requests have ten-second deadlines and no redirects or automatic retries. The Runtime owns its process-session UUID and redacted key cache.

Muse sends `/responses`, `x-client-id: tbh:exec`, and equal `x-tbh-session-id`/`x-meta-ai-gateway-session-id`. Defaults use `store:false` and encrypted reasoning inclusion; complete input replays encrypted state rather than `previous_response_id`. Trailing subscription-usage events drain after completion, including an unterminated final line. Invalid quota events produce payload-free warnings. Only normalized Schema observations survive; absent metrics and reported zero stay distinct. Quota reads never mint or fetch.

## Cursor wire and host boundaries

`cursor` owns native Connect protobuf encoding, strict decoding, gzip/fragmented framing, typed execution controls and shared LLM settlement. `cursor::request::RunRequest` takes explicit conversation/group/message/model identities, exact variant parameters, tool descriptors, encoded request context, inline images and an optional opaque checkpoint. Replay is byte-preserving; resume does not fabricate another user message. Identity generation, account resolution, workspace discovery and durable storage belong upstream.

Struct keys use JavaScript UTF-16 order; Value strings use TextEncoder replacement semantics, while protobuf message strings preserve protobufjs encoding. Incomplete framing and EOF without terminal settlement fail. Headers combine caller-supplied CLI identity/checksum, Connect/Run fields and resolved authentication. Cursor agent origins must be credential-free HTTPS Cursor subdomains. JSON body/query overlays are rejected.

`cursor::transport::Client` owns per-origin h2 connections, flow control, read/write deadlines, PING-checked reuse and cancellation. Cleartext endpoints are explicit loopback socket addresses. TLS validates certificates/server names with system roots and h2 ALPN. The returned Run has an independent reader and serialized cloneable writer. Shutdown cancels and joins connection drivers. HTTP status precedes gRPC status; trailers precede response headers. Diagnostics redact credentials and retain replay-safety barriers. Caller-supplied proxy environment supports HTTP CONNECT and NO_PROXY; transport reads no ambient environment.

`cursor::provider::Runtime` serializes each Session stream and retains its originating Run across MCP tool steps. Tool-result continuation sends correlated exec-result/close replies on that Run, without resending the user prompt. Missing pending results fail. Typed snapshot/load/save boundaries retain conversation identity, checkpoint, blobs, last input and epoch-held tool descriptors; Core/Store own persistence. Runtime-owned heartbeats and bounded semantic-idle/hard-cap deadlines govern held streams. Visible output, execution and malformed frames block replay; the adapter does not retry.

Advertised host schemas govern MCP argument normalization, tools, display-state mirroring and questions. UI-only headless interactions receive typed rejection/acknowledgement; unknown native exec variants fail. `planning::Host` owns approval, agent selection, plan placement/writes and terminal agent-switch delivery. AI retains approved mode state and request reminders without changing the frozen system prefix. Missing host/Session identity fails closed.

Image input accepts inline bytes and host-resolved URI/file references. Catalog capability takes precedence over the documented capability map; unsupported media fails. Selection preserves MIME/bytes/basenames, enforces a combined 20 MiB bound and deduplicates history without suppressing current input. Generated images stage under opaque IDs with eight entries, ten-minute claims and a 50 MiB byte bound. AI creates no file; Core owns path inspection, containment, permission checks, writes and save receipts. Native read observations also come from a typed Location host, not parsed tool prose.

`cursor::models::available_models` supplies exact model/variant tuples. Model selection rejects malformed/stale tuples before IO and preserves explicit max-mode selection. Unknown pricing remains absent. Unary discovery uses explicit identity/authentication, validated HTTPS origins and bounded response-body deadlines. `src/cursor/LICENSE` and root `NOTICE` retain the upstream MIT attribution.

## Standalone images

`image::Request` supports OpenAI generation/edits and Z.ai generation independently from Session LLM execution. Explicit model/request HTTP options share authentication precedence and redacted failures. OpenAI supports ordered URL/file-ID JSON references and byte-preserving multipart uploads with protected model/prompt/image/mask fields. Z.ai rejects input images and projects only its normalized response metadata. Absent usage is not zero. Invalid JSON, base64 and response shapes fail visibly.

## Framing, cache and tools

SSE retains byte/UTF-8 fragments, supports LF/CRLF/CR, joins multiline data and ignores empty data/comments/retry directives/`[DONE]`. Neither `[DONE]` nor a retry directive certifies completion. WebSocket actors own connections and heartbeats; abnormal close or delayed heartbeat fails visibly. Cursor uses its distinct Connect framing/lifetime.

Cache policy is independent of quota reads and diagnostics. Tool schemas are normalized before provider lowering; local tool dispatch preserves validation, cancellation and success/error results. A route never executes a Session tool loop or owns durable events.

## Checks

Run checks from `rust` through the Cargo gate. `tests/openai_providers.rs` covers native/compatible defaults and OpenRouter stateless/cache/reasoning contracts. `tests/images.rs`, `image_options.rs` and `media_transport.rs` cover image rules and actual loopback HTTP/recorded request bytes. `provider_lifecycle.rs` covers Muse account-generation key pruning. Dedicated OpenAI, Claude Code, Muse and Cursor suites cover streaming, cache, quota, native wire, tool continuation and cancellation. Fixtures are offline; these tests do not certify live subscription access.
