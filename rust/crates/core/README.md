# YCoding Core

Successful local read-tool calls load nearby `AGENTS.md` files into Session
history as durable synthetic instructions. The Location-scoped loader deduplicates
concurrent and repeated reads, respects the current `instruction_max_bytes`
limit, and skips missing files, external reads, and the Location-root file.

## Session movement

Session movement adopts a destination Project's previous artifact scope in its
own transaction and writes the scope marker only after commit, before interrupting
execution. A failed adoption transaction leaves scope ownership and files intact;
a marker failure reports an error with the adoption already committed.

Cross-Project movement records `session.project-artifacts-ended` and closes only
the Session's open activations in the old Project in one transaction. Activation
rows receive that event's sequence and the sampled millisecond timestamp. A
project-scoped current agent selects the destination's default, even if its ID is
still available; standard and global agents retain their selection. Agent selection
and `session.moved` are separate subsequent publications. Movement projects the
new Location, Project and subpath and clears the instruction epoch. Same-Project
moves publish only movement; an unchanged Location is a no-op.

## Derived Session retention and maintenance ownership

`session::cleanups::Cleanups` removes only derived context exclusions, file-change
ledgers, provider requests and usage aggregates. Each sweep samples its injected
`session::runner::Clock` once and uses the strict cutoff `now - 30 * 86_400_000`
milliseconds. `WallClock` uses UTC Unix milliseconds, equivalent to `Date.now()`.
The only Session exemption is executor-active membership, supplied by
`Execution::active()` through `Cleanups::process(client, roots)`. Pins, goals,
suspension, pending work, family membership and `time_active` do not independently
exempt projections. Session rows, transcripts, durable events, context revisions
and manifest blobs are retained.

File-change and usage sweeps commit pages of at most 200 Sessions ordered by
`(time_updated, id)` with SQLite-compatible UTF-8 binary ID ordering. Context
exclusions commit in one transaction. One sweep snapshot selects Session and
projection values; transactions recheck Session freshness and current executor
activity, and delete only unchanged projection rows present at that boundary.
New or changed rows survive until a subsequent eligible sweep. Initially active
Sessions remain exempt throughout the sweep. Failed transactions roll back their
complete page; restart begins at the first key and already deleted rows contribute
zero. Counts are deleted exclusions, file changes and provider requests
respectively; usage aggregate rows are excluded from the usage count.

`Cleanups::usage().await` waits for committed canonical receipts, then runs the
attached analytics handle's blocking `purge()` on a blocking task before returning
success. It also retries pending purge when no new rows were deleted. An absent,
stopped or failing engine returns an error; durable pending-purge markers keep
report reads fenced. No canonical report fallback is used.

`Maintenance::start(cleanups).await` admits one process owner, runs all startup
sweeps and exposes counts and failures through `startup()`. It then schedules each
cleanup independently after hourly delays measured from its previous completion.
Failures use the existing stderr diagnostics path and do not stop other cleanups
or scheduling. `close().await` stops scheduling and joins the current sweep,
including receipts and purge. Close is idempotent; drop signals stop but does not
replace joining before Store shutdown.

### Composition handoff

1. Open the selected Store after offline import/activation. Install process
   Session execution before admitting live Session work.
2. Construct `Cleanups::process(store.client(), &roots)` and retain
   `Maintenance::start(cleanups).await`. Await startup before starting analytics
   or admitting report reads. Inspect `startup().failures`; usage
   `Analytics(Unavailable)` after canonical deletion means pending physical purge,
   not cleanup success.
3. Start and retain `analytics::reports::start(store.client(), private_directory)`
   outside executor threads. Complete `handle.purge()` and `handle.rebuild()`
   before admitting reports. This resolves startup's absent-engine fence;
   subsequent usage sweeps purge themselves.
4. Stop live intake/execution, await maintenance `close()`, close/join the analytics
   Engine outside executor threads, then shut down the Store. Keep both Store
   and analytics alive until maintenance has drained.

Tool-output maintenance uses one global `tool_output_store::Store` without
Location configuration, a seven-day mtime cutoff and the `tool_` name filter.
Directory, metadata and removal failures are best effort as in TS. Writers hold
their path during `bound`; consumers retain `Store::hold` while an output is live.
Holds are process-shared across Location and global Store instances; deletion
waits until the last hold drops. Shell live outputs use the separate `shell`
directory and are outside this sweep.

Safety rechecks, sweep-boundary write preservation and failure-resilient schedules
strengthen TS's active-ID snapshot, unchecked ID deletes and uncaught
`Effect.orDie` failures. Without an updated-time index, Store selects ordered
Session pages through bounded primary scans without schema changes. These are
required concurrency and failure differences; retention eligibility,
counts and retained data match TS.

`tests/session_cleanups.rs` exercises real Store/DuckDB deletion and purge,
injected clocks, interleaved writes, startup/hourly ownership, failure continuity,
held outputs and close/drain. Store boundary checks reside in
`tests/session_tables.rs`.

## Diagnostics and OTLP

The launcher calls `observability::install(Options::new(&roots, version, channel,
local)) -> Result<Guard, Error>` once and retains the guard. This module does not
install itself at runtime startup. `Guard::close(&mut self)` stops intake, drains
accepted diagnostics, flushes the file and OTLP batches, joins the worker and
releases the optional event-feed subscription; Drop performs the same cleanup.
Close is idempotent. File and worker failures return safe categories; exporter
failures leave local logging available without recording transport errors.

Files append under `Roots.log` (`$XDG_DATA_HOME/ycoding/log`): `ycoding.log`, or
`ycoding-<sanitized-channel>.log` for local installs. Unix files are created and
tightened to 0600 and the log directory to 0700. Records use timestamp/level/run
key-value text, flattened structured fields and span annotations, JSON quoting
where needed, and one shared eight-hex-digit run identity. `YCODING_LOG_LEVEL`
accepts DEBUG, INFO, WARN or ERROR case-insensitively, otherwise INFO;
`YCODING_PRINT_LOGS=1` mirrors the same filtered records to stderr.

`Options.environment` captures process environment and may be supplied explicitly.
`OTEL_EXPORTER_OTLP_ENDPOINT` enables HTTP JSON logs at `<endpoint>/v1/logs` and
traces at `<endpoint>/v1/traces`; `OTEL_EXPORTER_OTLP_HEADERS` supplies comma-separated
headers, splitting on the first equals sign. Percent-decoded
`OTEL_RESOURCE_ATTRIBUTES` are accepted only when every entry is valid. Service
name/version, deployment channel, `YCODING_CLIENT` (default `cli`), run and instance
identity override conflicting resource entries. Native tracing parents and links
preserve trace/span correlation, independently of the diagnostic level threshold.
The bounded worker batches logs each second and traces each five seconds, also
flushing at batch capacity and shutdown. HTTP requests time out after three seconds;
a failed signal export pauses that signal for sixty seconds. No metrics or global
OpenTelemetry context manager is installed.

Set `Options.events` to the shared `event_feed::Feed` to log only `agent.updated`,
`catalog.updated`, `command.updated` and `config.updated` ephemeral events. Credentials,
auth/header fields, raw provider payload fields and configured OTLP header values
are redacted before every sink, including span fields and resource attributes.
Callers must still keep sensitive data out of free-form diagnostic messages and
unclassified fields; the sink cannot identify arbitrary secret text. Export HTTP
instrumentation is suppressed to prevent recursion and header/error disclosure.

## Process extensions

`extension::{Configuration, Extension}` resolves explicit trusted executable
configuration and supervises tools over Core-owned Protobuf stdio. The canonical
descriptor is `protocol/ycoding/extension/v5/extension.proto`; the Core build
script generates its bindings and structural rules without importing application
Protocol or changing its digest. `Extension::start` takes resolved configuration,
deadlines, the existing registry, captured leaf policy, and the Location
`Launch`: configured `extension.launch` and family-grant rules where `deny` and
`ask` fail closed and no matching rule admits the launch, plus the Location
lifetime cancellation.
Host-granted tool scopes govern registration/execution, with independent
direct/Code Mode visibility, structured/content output, progress, safe failures,
and normal output validation/bounding. Executable JS/TS/npm configuration is
rejected with a diagnostic, not loaded through a compatibility adapter.

Exact revision 5 and fresh process generations fence registrations/calls.
Cancellation waits for cleanup acknowledgement or process reaping. Replacement
stops intake, cancels/drains calls, revokes registrations, then closes the child;
uncertain effects never replay. Await `shutdown` to join cleanup, or `closed` to
observe an exited generation. Diagnostics retain enum categories, not stderr or
payloads. Processes are trusted and have ambient OS authority, not a sandbox.

Failed Session context hooks emit a Core warning with extension, hook, Session
and route identities, without request payloads. Preparation appends the bounded
failure notice and continues through subsequent hooks.

Cursor model-discovery failures emit a warning and a provider diagnostic without
blocking Location preparation. Each account retains its last inventory, or an
empty inventory when none was loaded. Failed discovery remains eligible for
the next reconciliation; credential-backed inventories retain account-generation
fences.

`extension::Activation` owns one Location's configured processes. Construct it
with the Location directory, deadlines, `Arc<Registry>`, captured leaf policy,
the Location `Launch`, and `Host`. Bind `activation.event_source` to the backend feed
with `bind(core.events.clone(), Some(location.clone()))` before activation.
`reload(&configuration).await` resolves process configurations and activates
them; call it after initial configuration loading and after each successful
`configuration.reload()`. Resolution errors preserve the active generation.
Await activation before exposing a ready Location catalog.

`activate(configurations).await` serializes complete passes. An identical ordered
configuration vector emits nothing. Equality includes identity, executable,
arguments, directory, tool grants, family grants, and registration order. Every
definition in a changed pass closes its previous process and starts a new one;
failed starts restore the previous configuration, and failed restores deactivate
that identity. Other definitions still load. Removed entries close in reverse
registration order. Each successful start, including restoration, publishes
Location-bound `plugin.added`; each changed pass publishes one `plugin.updated`.
Failures log identity/category without arguments, grants, or process output.
Duplicate identities and collisions with native capability IDs reject the pass
before changing active state.

`list().await` returns active process identities in registration order.
`failures().await` returns each configuration identity that failed in the latest
changed pass with its categorical error; failures are also logged.
`plugin_list().await` returns native pre-capabilities, active process identities
in the configured-extension slot, then native post-capabilities. Supply this
snapshot to `CatalogServices.plugins` after activation and on each reload;
catalog queries must obtain the current snapshot, not retain the initial vector.
`extensions().await` supplies generation handles to `Resources::materialize`,
`context::prepare`, and extension event delivery. Shutdown revokes held handles.
On Location eviction, stop reload admission, await `close().await`, then release
the registry and Location services. Close shuts all processes down in reverse
registration order, joins cleanup, emits no activation events, and prevents
later activation. Native IDs describe available Rust capabilities, not JS plugin
instances or compatibility adapters.

### Native capability enumeration

The order follows `packages/core/src/plugin/internal.ts`: pre, configured
extensions, post. Paths in this table are relative to `rust/crates/core/src`.

| Included IDs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Native implementation evidence                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ycoding.agent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `resources/agent/builtin.rs::catalog` supplies the embedded primary/helper agents.                                                                                                                  |
| `ycoding.tool.conversation-compact`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `session/runner/compaction.rs` and `session/compaction_gate.rs` implement native request compaction.                                                                                                |
| `ycoding.tool.computer`, `ycoding.tool.browser`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `tools/builtin/computer.rs`, `tools/builtin/browser.rs` implement policy-bound native controls.                                                                                                     |
| `ycoding.models-dev`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `resources/catalog/models_dev.rs::Service` loads, normalizes, caches, and refreshes model catalogs.                                                                                                 |
| `ycoding.provider.amazon-bedrock`, `ycoding.provider.anthropic`, `ycoding.provider.azure`, `ycoding.provider.github-copilot`, `ycoding.provider.google`, `ycoding.provider.google-vertex-anthropic`, `ycoding.provider.google-vertex`, `ycoding.provider.openai-compatible`, `ycoding.provider.openai`, `ycoding.provider.openrouter`, `ycoding.provider.xai`                                                                                                                                                                                          | `resources/model/mod.rs::family` and `resources/model/route.rs::from_catalog_model` select native routes; implementations live in the AI crate.                                                     |
| `ycoding.provider.cursor`, `ycoding.provider.muse`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `resources/cursor`, `resources/muse.rs`, and `resources/auth/{cursor,muse}.rs` supply native account/catalog/provider integrations.                                                                 |
| `opencode.provider.opencode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `resources/auth/opencode.rs::Console` implements console authorization, credential enrichment, and refresh; the TS plugin uses this exact non-`ycoding` ID.                                         |
| `ycoding.provider.alibaba`, `ycoding.provider.azure-cognitive-services`, `ycoding.provider.cerebras`, `ycoding.provider.cloudflare-ai-gateway`, `ycoding.provider.cloudflare-workers-ai`, `ycoding.provider.cohere`, `ycoding.provider.deepinfra`, `ycoding.provider.gateway`, `ycoding.provider.gitlab`, `ycoding.provider.groq`, `ycoding.provider.mistral`, `ycoding.provider.perplexity`, `ycoding.provider.sap-ai-core`, `ycoding.provider.snowflake-cortex`, `ycoding.provider.togetherai`, `ycoding.provider.vercel`, `ycoding.provider.venice` | `resources/model/mod.rs::family`, `resources/model/route.rs`, and `resources/catalog/builtin.rs` select native hosted and vendor routes; implementations live in the AI crate.                      |
| `ycoding.provider.kilo`, `ycoding.provider.llmgateway`, `ycoding.provider.nvidia`, `ycoding.provider.zenmux`                                                                                                                                                                                                                                                                                                                                                                                                                                           | `resources/catalog/builtin.rs` applies their endpoint headers to the native OpenAI-compatible route.                                                                                                |
| `ycoding.tool.patch`, `ycoding.tool.edit`, `ycoding.tool.glob`, `ycoding.tool.grep`, `ycoding.tool.read`, `ycoding.tool.shell`, `ycoding.tool.project-artifact`, `ycoding.tool.memory`, `ycoding.tool.webfetch`, `ycoding.tool.websearch`, `ycoding.tool.write`, `ycoding.tool.worktree`                                                                                                                                                                                                                                                               | Corresponding implementations in `tools/builtin`; `search.rs` provides glob and grep.                                                                                                               |
| `ycoding.tool.skill`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `tools/builtin/skill.rs::load_local` supplies policy-bound skill loading and instructions.                                                                                                          |
| `ycoding.tool.question`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `tools/policy/questions.rs::Questions` supplies admission, answers, rejection, and pending reads.                                                                                                   |
| `ycoding.tool.subagent`, `ycoding.tool.subagent-control`, `ycoding.tool.subagent-report`                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `session/orchestration/service.rs::Service` supplies launch, send, answer, cancel, resume, progress, and child questions.                                                                           |
| `ycoding.tool.todowrite`, `ycoding.tool.task-complete`, `ycoding.tool.goal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `session/todo.rs::update_todos`, `session/completion.rs::complete`, and `session/autonomy/service.rs` implement durable native controls.                                                            |
| `ycoding.tool.decision`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `resources/decision` evaluates bounded predicate, choice, and score judgments through the Decision helper model; composition binds it with the other `SessionTools`.                                |
| `ycoding.config.reference`, `ycoding.config.agent`, `ycoding.config.command`, `ycoding.config.skill`, `ycoding.config.provider`                                                                                                                                                                                                                                                                                                                                                                                                                        | `resources/{reference,agent,command,skill}` consume configuration entries; `resources/catalog/mod.rs::configure` applies provider/model configuration.                                              |
| `ycoding.variant`, `ycoding.config.policy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `resources/catalog/variants.rs`, `resources/model/mod.rs::with_variant`, `resources/config/validation.rs`, `tools/policy`, and `process/guardrails` supply variant and fail-closed policy behavior. |
| `ycoding.project-artifact.source`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `resources/project_artifact/source/service.rs::Service` refreshes managed project overlays and records provenance, activations, and terminal accounting through its `Governor`.                     |

Native Session controls are implemented as Core services; their model-tool
bindings are supplied by composition through `tools/context/consumers.rs::SessionTools`.
An available generic provider route does not imply a provider-specific adapter.
The following TS internal IDs are excluded:

| Omitted IDs                                                                                                                                                                                  | Evidence and reason                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ycoding.wellknown`                                                                                                                                                                          | `resources/discovery/wellknown.rs` parses/stores command-auth manifests but does not register or execute their authentication commands; it does not provide the TS command-auth integration from `packages/core/src/wellknown/plugin.ts`. |
| `ycoding.command`                                                                                                                                                                            | `resources/command/mod.rs::Service::from_documents` loads configured commands; it does not register the TS bundled `init`/`review` templates from `packages/core/src/plugin/command.ts`.                                                  |
| `ycoding.skill`                                                                                                                                                                              | `resources/skill/mod.rs::Service::from_entries` discovers configured sources; it does not register the TS bundled YCoding/report skills from `packages/core/src/plugin/skill.ts`.                                                         |
| `ycoding.system-prompt.openai`, `ycoding.system-prompt.google`, `ycoding.system-prompt.anthropic`, `ycoding.system-prompt.kimi`, `ycoding.system-prompt.arcee`, `ycoding.system-prompt.meta` | `session/runner/mod.rs` assembles instructions and the selected agent system prompt, not the six model-family prompt selectors in `packages/core/src/plugin/system-prompt.ts`.                                                            |
| `ycoding.provider.dynamic`                                                                                                                                                                   | Executable custom-provider loading is unsupported. `config::ENDPOINT_PACKAGES` admits only two declarative native endpoint identities; `resources/model/mod.rs::family` selects their fixed native routes.                                |

The channel also defines ordered domain/context/tool transforms and hooks,
bounded receipt-owned event subscriptions, and generation-scoped resource
registrations. `extension::Resources::materialize` returns validated native
resource views without mutating its input services; `extension::context::prepare`
transforms an ephemeral AI request before route preparation. Closed generations
are excluded from fresh views, and hook-altered output uses normal bounding.
Context messages retain host-owned origin/identity/trust fields, including when
they have no durable ID. Tool transforms run before context hooks. Event quotas
cover queued and handed frames until consumption receipts, not just native writes.
`mcp` grants expose scoped MCP server listing, tool listing, resource reads, and
tool calls to a child through `extension::Host`, only for an owned in-flight call.
`auth` grants let a child register OAuth methods on an integration `Registry` supplied
through `extension::Host`; the host drives authorize, callback or submit-code, refresh,
and label requests over the channel, validates returned credentials, and redacts them
from `Debug` output. Provider and scoped Session families and Meeting are unsupported by
this endpoint.
See [the channel contract](../../../specs/process-extension-v5.md) for schemas,
bounds, configuration, failure categories, and lifecycle rules.

From the repository root, run real-child and wire checks with:

```sh
CARGO_BUILD_JOBS=3 ~/.cache/ycoding/cargo-gate.sh cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-core --test extension_auth --test extension_activation --test extension_contract --test extension_families --test extension_mcp --test extension_process --test extension_wire
```

## MCP

`resources::mcp::Service` accepts resolved configuration entries, a Location
directory, client version, environment overrides, and optional elicitation
handling. Global timeout fields overlay in document order; duplicate server names
replace their definitions in place; server timeout fields override the resulting
global defaults. Runtime `add`, `connect`, `disconnect`, and `remove` operate on
live registrations without writing configuration. Configured enabled servers
start in the background. Tool and instruction reads await initial startup;
server status and prompt snapshots remain nonblocking. Lifecycle operations
serialize per server, and obsolete connection callbacks cannot replace live
catalogs. Call `shutdown().await` to join owned work and finish transport cleanup.

The client uses pinned `rmcp` 3.5.1, advertises `ycoding` and the supplied version,
and supplies the Location as its workspace root. Local stdio and remote
Streamable HTTP connections first offer `2026-07-28` through `server/discover`.
Modern connections omit initialization and carry protocol-version, client-info,
and client-capabilities request metadata; HTTP requests also carry
`MCP-Protocol-Version`, `Mcp-Method`, and applicable `Mcp-Name` headers. A legacy
answer selects `initialize`/`notifications/initialized`, offering `2025-11-25`
and accepting `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`.
An unsupported-version error advertising only unsupported modern revisions fails
without legacy initialization. Stdio probes run in the connection's process:
an answer permits handover in place; exit or silence stops that process and starts
one fresh process for initialization. The probe is bounded by 5 seconds or the
shorter startup timeout; initialization has its own startup timeout. A successfully
connected legacy configuration skips discovery on subsequent connections within
the process, until a connection failure clears that knowledge. Local servers use
`platform::process`, newline JSON-RPC framing, Location-relative `cwd`, inherited
environment plus explicit overrides, and process-tree shutdown. Stderr is drained
without logging. Remote servers use Streamable HTTP with JSON or SSE POST
responses and SDK session/stream handling; no legacy SSE transport is selected.
An expired legacy HTTP session is reinitialized and its request retried once;
requests abandoned during renewal are not resent, and failed renewal closes the
connection. Modern list changes use one `subscriptions/listen` stream for the
advertised tool, prompt, and resource `listChanged` capabilities. Subscription
failure does not fail startup; an ended stream stays ended until reconnection.
Modern connections do not subscribe to server logs. Modern `input_required`
tool, prompt, and resource results dispatch the same caller-owned elicitation
handler and retry with input responses and the opaque request state, with a
maximum of ten fulfillment rounds.
Catalog requests omit progress metadata; tool calls retain progress tokens while
enforcing a hard wall-clock execution timeout. Defaults are 30 seconds for startup
and catalogs and 12 hours for execution. Cancellation signals and dropped request
futures send cancellation notifications without closing unrelated requests.

Tools, prompts, resources, templates, and declared Skills extension operations
use cursor pagination with duplicate-cursor rejection.
Resource and template listings, resource content parts, and Skills directory
entries project exactly the contract fields (`name`, `uri` or `uriTemplate`,
`description`, `mimeType`; content `type`, `uri`, `text` or `blob`, `mimeType`;
directory `uri`, `name`, `mimeType`) and drop server-specific extras.
`Service::read_resource` adds the `server` and requested `uri` to the result.
`Error::NeedsAuth` carries the server name and renders as `MCP server requires
authentication: <server>`. Unsupported resource list
methods are remembered independently for resources and templates. RPC errors,
tool `isError`, structured content, text, image/audio, resource links, and embedded
resources retain distinct outcomes. The raw MCP client does not grant tool or
skill permission, register Session tools, or bypass guardrails; `builtin::mcp`
registers the catalog as registry tools.

Tool output validation uses `jsonschema` 0.58.6 with offline reference resolution.
An absent or non-string `$schema` selects draft 2020-12; declared 2019-09 selects
that draft; declared draft-06 or draft-07 selects draft-07 with validation of
keywords adjacent to `$ref`. Known formats are asserted, unknown formats are
ignored, and `email`, `uuid`, and `regex` use Core ECMAScript adapters. Validation
does not coerce values, insert defaults, or remove additional properties. Tool
output schemas remain available across every catalog page. Compiled validators
are reused by calls and unchanged catalog refreshes; changed schemas are
recompiled and absent tools release their cached validators.

Invalid structured content returns RPC code `-32602` with the message
`Structured content does not match the tool's output schema: <details>`.
Details collect validation failures with `data<instancePath>` prefixes.
Missing structured content returns `-32600` with
`Tool <name> has an output schema but did not return structured content`.
Results marked `isError` bypass output validation. Validator-construction
failures retain the schema in the catalog and tolerate structured content
without validation; the structured-content presence requirement still applies.

This validator differs from the TypeScript MCP client's AJV configuration:
`jsonschema` meta-validates schemas after normalization, and any schema it
rejects at construction leaves that tool's structured results unvalidated.
`patternProperties` uses the crate's best-effort ECMAScript regex engine;
some `ajv-formats` extensions are unsupported or have different semantics,
and error details and ordering are not universally AJV-equivalent. The MCP
transport rejects lone UTF-16 surrogates in schemas, keys, and instances rather
than replacing them; domain `JsonValue` retains those code units losslessly.
Valid surrogate pairs are preserved and string lengths count Unicode code points.

Skills discovery retrieves metadata only. Static manifests validate names, URI
containment, unique resources, inclusion of `SKILL.md`, the 512-resource limit,
and the 16 MiB total limit. Reads verify the held server origin, membership, byte
size, and SHA-256 digest before returning text or canonical base64. Dynamic
manifests are not loadable. Frontmatter comparison includes every field and
compares nested objects independently of insertion order. Origin IDs are
canonical base64url encodings of the server/URI pair. Content-bound approval
identities include the complete manifest. These producers do not activate skills
or persist Session instruction epochs. Instruction summaries use existing tool
permissions, normalize line endings and trailing whitespace, and cap each server
at 2048 UTF-8 bytes without splitting characters; supply the host locale comparator
to the `*_by` producers.

Browser launch and background tool-job/Session delivery remain caller-owned.
The optional elicitation callback is caller-owned; the service does not create
Forms or manage URL-completion acknowledgements. Service catalog ordering is
lexical.

Run the focused checks from `rust` with
`cargo test --locked -p ycoding-core --test 'mcp_*'`.
`mcp_table` drives a table-configured Python stdio server (`tests/mcp_table.py`)
for resource, Skills extension, list-changed, and Service lifecycle behavior; it
needs `python3` only. The SDK subprocess checks require Bun and cached
`@modelcontextprotocol/server` 2.3.1; set `YCODING_MCP_SERVER_ROOT` to an existing
installation when the standard Bun cache is unavailable. `extract-fixture.mjs`
reads upstream fixture sources through `git show main` and the Rust-owned HTTP
fixture from `tests/mcp_protocol_http.ts`, rewrites server package import
locations, and installs nothing. HTTP tests use real isolated loopback servers
for JSON and SSE responses.

### MCP OAuth

`resources::mcp::oauth::authorize` returns a caller-owned authorization attempt
with a browser URL and an independently running loopback callback server.
Callbacks validate state before interpreting the callback, then validate `iss`
against the held authorization-server metadata before redeeming a code or
displaying callback error text. An issuer is required when metadata advertises
`authorization_response_iss_parameter_supported`; a supplied issuer must match
exactly. Callbacks serve the existing branded HTML pages.
`finish` exchanges the PKCE verifier, returns a credential-store `Secret`, and
joins callback-server cleanup; `cancel` joins cleanup without an exchange.
Dropping the attempt requests cancellation. The caller owns browser launch and
attempt expiry.
Callback binding uses `callback_port`, then the explicit `redirect_uri` port,
then an ephemeral port. State and the S256 verifier use independent secure
random values. Wrong callback paths return 404; rejected state never reaches
the token endpoint.

Discovery supports path-aware protected-resource metadata, root discovery after
a client-error response, OAuth authorization-server metadata, and both OIDC
well-known path forms. The advertised resource must contain the configured
server URL on the same origin. Registration uses the TypeScript client metadata,
including the `ycoding` name, authorization-code and refresh-token grants, and
public-client authentication. Registration declares `application_type: native`
for loopback or custom-scheme redirect URIs and `web` otherwise. Static client
configuration skips registration.
Requested scopes take precedence over resource scopes; supported
`offline_access` adds explicit consent. Token authentication honors the
registration method, then server-supported Basic, POST, or public-client
authentication. Credentials preserve the complete dynamic registration, server
URL, token type, scope, and authorization-server issuer; expiry zero represents
unknown or non-expiring tokens. Issuer-stamped refresh tokens and dynamic client
information are not presented to a different authorization server. Unstamped
credentials acquire the discovered issuer when their tokens are saved; stored
issuer comparison tolerates a single trailing slash, while callback comparison
uses exact string equality.

Supply `client::Hooks::credentials` to present and refresh persisted credentials
on HTTP requests. Supply `client::Hooks::integrations` with the shared Integration
registry to register OAuth methods for remote servers, including disabled ones.
Registration disposal follows server replacement, removal, and service shutdown.
Credential-change events reconnect current enabled registrations under their
server lock; obsolete identities cannot reconnect a replacement. Integration
identity matches
`packages/core/src/mcp/index.ts:262–270`: SHA-1 of the server name, a NUL, and URL,
with the first 16 hexadecimal digits prefixed by `mcp_`. A connection binds to the
integration's active OAuth profile and reads that credential row at the start of
every request, so tokens another connection or process refreshed are presented
without a new exchange. Initialization presents the stored credential without
proactive refresh. An authentication challenge refreshes and replays the request
with a per-request authentication loop guard, so concurrent requests on one
connection each recover from one rejection. Different 403 scope challenges permit distinct upscoping attempts;
repeated identical challenges stop. A refresh token is exchanged once per process: identical in-flight refreshes
share one exchange, and a response that rotated the token stays reusable for
requests still presenting the exchanged token until a request presents the
rotated token. A refresh rejected after the stored token was replaced retries
once with the replacement and keeps the stored row; a rejection of the token
still stored removes that credential, then repeats discovery/registration before
reporting that authorization is needed. Simultaneous refreshes of one
single-use token from different processes are not coordinated.
Challenge-provided metadata URLs and scopes drive discovery. Refreshed tokens
are replayed even when their access-token value is unchanged. Auth-gated requests
without credentials perform discovery and registration without opening a browser
or exchanging a code. The HTTP adapter delegates JSON/SSE/session handling to
rmcp and uses its public `BoxedSseResponse` alias without additional dependencies.
Refresh updates the same row, preserves an omitted refresh token, and stores a rotated one. Credential
storage uses the existing Rust service; this module creates no separate token
file and does not log token responses.

The OAuth protocol operations use existing Reqwest, Ring, and URL dependencies.
The `rmcp` authorization manager is not used for those operations; Core preserves
the complete validated dynamic registration, including its client secret.
Metadata accepts opaque issuer strings and validates required fields, optional
arrays, URLs, and booleans for OAuth/OIDC and protected-resource documents.
Registration validates the SDK client-information/metadata fields, removes empty
optional logo/TOS URLs, and discards unknown response fields before persistence.
Protected-resource discovery failures select the MCP server's authorization
server fallback; authorization-server discovery failures remain errors.
Discovery carries its OAuth/OIDC dialect independently from issuer path text.
`Service::servers` returns `Result<Vec<ServerInfo>, Error>` and reads Integration
connection metadata synchronously, including for disabled servers; read failures
propagate without a cached substitute. Empty form elicitations accept an empty
answer without invoking the host handler. URL acknowledgement returns only the
action, never internal host content. Host Forms creation and URL completion
notification delivery remain caller-owned.
Remaining verification limits include full AJV output validation,
GET/DELETE authentication edge behavior, and exhaustive
SDK validation/error-envelope parity beyond the covered loopback cases.
Login does not install a Session tool or background-job delivery mechanism.

Run OAuth loopback and credential checks with
`cargo test --locked -p ycoding-core --test mcp_oauth --test mcp_oauth_rotation`.

## Browser and computer client domains

`platform::browser::service::Service::new(credentials, admission, sessions,
options)` constructs the backend-wide paired-extension coordinator. Supply the
existing Credential service, one shared `Arc<Admission>`, and a Session predicate
that rejects missing or archived Sessions. `start` produces a two-minute one-use
pairing by default; `attach(origin, handshake, transport)` checks the exact Chrome
extension origin and protocol version, persists only the SHA-256 credential
digest through Credential storage, and returns an attachment. Trust is bound to
the extension and server identities, independent of the bootstrap Session's
continued existence. Authentication restores no tabs. Attachment identity fences
late frames after replacement; `detach` retains trust, `stop` ends control, and
`forget` revokes trust. `shutdown` closes the transport and releases admission.
The caller owns WebSocket upgrade/authentication routing and Session lifecycle
event delivery; the coordinator does not start an HTTP listener. Forward execution
success, failure, and interruption to `Service::lifecycle` using the corresponding
`Lifecycle` variant. Forward movement, deletion, and archival using `Moved`,
`Deleted`, and `Archived`. Execution endings retain owned tabs and wait for a
pending command before relinquishing profile control. Ownership endings settle
pending work, release owned tabs and admission, then relinquish profile control
without requiring the ended Session to remain active. A profile lease remains
held until the extension acknowledges cleanup. Cleanup failures are returned;
other held tabs are still attempted.

`service::Service::bridge()` returns the attached `Arc<bridge::Bridge>` for paired
tab operations. `bridge::{Transport,SessionCheck}` are the transport and Session
lookup seams; transports preserve bounded output admission and close codes and
reasons. The bridge checks generations, document generations, observation
revisions, semantic references, and profile-tab leases before dispatch. Mutations
retain exact settlement identities and never automatically replay an uncertain
outcome. `browser::boundary::{decode_input,execute,model_output}` expose the tool
execution body without registering a tool. `execute` takes `Services`, the
computer boundary's shared `Policy` and `Context`, and typed `Input`, returning
Schema `JsonValue`; `model_output` emits capture data as a separate media part.
Pass `&Arc<service::Service>` as `Services.paired` for durable pairing status,
unattached tab lists, and attached execution. `boundary::Paired` also accepts
`&Arc<bridge::Bridge>` for direct transport-boundary checks. Isolated operations
accept `&Arc<isolated::Service>` through `Services.isolated`.
`isolated::Service::new(executor, admission, sessions, options)` takes an explicit
`Arc<dyn Executor>`, the shared admission coordinator, and a predicate that rejects
missing, archived, and foreign-Location Sessions. `Executor` owns availability and
launch; its `Runtime` owns observation, action dispatch, pause/resume, closure, and
a retained closure signal. Snapshots and action results preserve the typed Schema
fences and ordered semantic references. Logical action identities are retained
without eviction; conflicting retries and capacity exhaustion fail before
dispatch. Predispatch failures reject actions; postdispatch mutation failures and
caller cancellation settle uncertain ownership and close the runtime once.

Call isolated `start` only for explicit operator startup. `stop` removes the owned
instance, settles pending work, and closes resources; a late launch is closed
without publishing readiness. Forward Session movement, deletion, and archival
to `release_session`. The Location owner must call `shutdown().await` before
dropping the service; shutdown joins owned startup, action, and closure-watcher
tasks. Default operation timeout is 30 seconds and action identity capacity is 256.
`Executor::availability` defaults to the installed Google Chrome producer:
macOS arm64 only, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
a three-second `platform::process` version probe, and minimum major version 152.
Unsupported placement performs no probe. Failed, missing, timed-out, malformed,
or truncated version output reports unavailable; the producer opens no browser
window or debugging endpoint. `chrome::availability` accepts an explicit executable
and placement for operator-owned adapters and stand-in tests. An executor may
provide its own availability producer. The injected executor must bound and honor
launch cancellation and enforce browser safety. `browser::chrome_executor::IsolatedChrome::installed()` is the
Unix-only concrete `Executor` for the installed Google Chrome; pass it to
`isolated::Service::new`. Default tests drive it through a Python stand-in that
speaks NUL-delimited CDP on fd 3/4; no live Chrome check is part of the suite.
The executor owns a mode-0700 temporary root and download directory, an isolated
profile, the detached child, control pumps, and joined cleanup. Launch refuses
non-macOS-arm64 placement and non-credential-free HTTP(S) pages before probing or
allocating anything. One startup deadline covers the executable version probe,
allocation, spawn, the `Browser.getVersion` recheck, target configuration, the
initial navigation, and the document-ready wait; a hung or canceled version probe
is killed and reaped before any profile exists. Configuration creates a
disposable browser context, denies downloads and clipboard read/write for the
page origin, creates and attaches an `about:blank` target, enables page,
inspector, DOM, and accessibility events, file-chooser interception, and request
interception, then discovers and auto-attaches new page targets paused for the
debugger. Only after every gate is installed does it send `Page.navigate` to the
requested page, wait for the main frame to report the approved origin, and settle
for 150 ms. A failed step fails the launch and cleans up. While running, the
guard blocks disallowed top-level requests and child-frame documents, contains
popups (scripts disabled, requests held, closed and confirmed destroyed), closes
any other new target exactly, advances the document generation on each main-frame
navigation, and treats a target crash, a destroyed controllable target, an
unconfirmed destruction, or a lagged event stream as fatal. File choosers and
disallowed navigations record the first failure and pause control; download
attempts are counted. `observe` lists up to 200 accessibility nodes with
interactive roles as `bN` references, omits file and password inputs, bounds
titles and names, reports credential-free link destinations, and rejects a page
outside the approved origins. Actions replace the allowed origins, deny their
clipboard permissions, and run `navigate`, `click` (refusing downloads, new
tabs, unapproved links, protected inputs, and invisible elements), `type`
(valid Unicode only), `scroll`, or `capture` (refused while a password field is
present); a blocked popup is reported as rejected and a download attempt fails
the action. `pause` blocks observation and actions; `resume` refuses while a
safety failure is recorded. Shutdown stops the guard, then disposes the context
and closes the browser inside one bounded race, closes the control pipe, allows
a bounded grace for natural exit, escalates TERM to KILL after 500 ms, and
finally terminates the browser's process group so helper processes do not
survive. Timeout, cancellation, dropped startup callers, crash, pipe closure,
spawn failure, and fatal guard failures reap the child before removing the
profile. A cleanup failure settles the owner and is returned by every `close`,
and `isolated::Service::shutdown` joins the owned process and profile.
`browser::{cdp,capture}` expose
the bounded NUL-delimited control client and complete-document screenshot safety
inspection independently.

`platform::computer::service::Coordinator::new(invoke, platform)` owns process-wide
native calls and claims. Its `service()` returns a Location-scoped service; retain
one such service per Location. Inject `computer::bridged::Client` for native and
PID-owned Electron routing, or `computer::macos::NativeClient` for native-only
execution. `macos::LaunchServices` launches the separately packaged native helper;
`electron::Runtime` supplies process inspection and signaling. Neither Swift nor
extension assets are embedded by these modules. The coordinator serializes native
focus mutations, chains settled revisions, invalidates unknown outcomes, and
owns settlement even when a caller drops its future. Route Session lifecycle
events to `Coordinator::release_session` and await owned client/coordinator
shutdown. `computer::boundary::{decode_input,execute,result_output,model_output}`
expose the computer tool body using the shared permission/path/review `Policy`
and Session/message/call/agent `Context`; results are `serde_json::Value`.
`Policy::permission` returns `PermissionFailure::{Blocked,Corrected,Fault}`;
preserve those categories when adapting the runtime's permission service. Only
denial and correction trigger cleanup of a newly opened tab. Operational faults
retain their error and never dispatch cleanup. Failed denial cleanup identifies
the remaining tab and requires manual Chrome recovery.
Guardrail reservations are released on every settled path, and browser/computer
reviews carry `skip_review: true` without bypassing deny decisions.

`macos::NativeClient` lazily bootstraps one persistent app service with a private
0700 control directory and 0600 `service.json` containing `action: "service"`,
`controlDirectory`, and the backend's `ownerPID`. LaunchServices receives only
that file. The shared Swift service authenticates the Unix peer PID and exits
on owner death. Calls are serialized on `computer-use.sock` as JSON-RPC 2.0,
with a four-byte little-endian length prefix and an 8 MiB UTF-8 JSON frame cap.
A version-1 ping precedes requests; each request includes its absolute deadline.
Connections reconnect to a surviving service; failed handshakes and timeouts
terminate it, with lazy replacement on a later call. Lost or invalid mutation
responses report `unknown_outcome` without replay. Cancellation retains the
target lock through settlement and requires reinspection. Await `shutdown` to
drain calls, send shutdown, close the socket, and remove the control directory.
`display.hold` keeps its separate request/response-file launch and lifetime.

Paired Chrome bridge version 4 accepts worker results without an `input` field.
Public Schema, tool output, and v5 projections omit that field. The shared Chrome
worker owns focus emulation at debugger attachment and always dispatches CDP
click/scroll input; the Rust backend does not inject visibility-dependent scripts.

Regenerate the browser tool definition with
`bun rust/crates/core/tests/generate-browser-tool.ts [reference-checkout]` from
the repository root. The optional reference supplies the TypeScript source and
installed Effect version; the generated JSON stays in the invoking worktree.

Run focused client checks from `rust` with exact Cargo test targets:

```sh
cargo test --locked -p ycoding-core --test browser_protocol --test browser_capture --test browser_cdp --test browser_fences --test browser_lifecycle --test browser_owned --test browser_auth --test browser_boundary --test browser_isolated --test browser_relinquish --test browser_chrome --test computer_client --test computer_service --test computer_ownership --test computer_electron --test computer_boundary
```

These checks use local control-pipe, credential-store, WebSocket, Unix-socket, and
fake-native boundaries. `computer_service` starts a Python process stand-in, not
the Swift app. They do not launch installed Chrome or prove native desktop input,
Space placement, privacy grants, extension assets, or debugger UI. Live browser
and native integration are separate environment-dependent suites.

## Meeting

`meeting` is the native backend for local meeting capture and transcription. It
does not use the process-extension channel.

`config::MeetingConfig::parse(&serde_json::Value)` validates the complete Meeting
configuration. Unknown keys, `null` for a defaulted field, an overlap that is not
shorter than the chunk, `knowledge.autoApply: true`, `knowledge.requireApproval:
false`, and `storage.retainAudio: true` are rejected. Every omitted section takes
its documented default; `to_value()` emits the same shape the live page reads.
The default model cache is `HF_HUB_CACHE`, then `~/.cache/huggingface/hub`; parsing
fails when neither can be resolved instead of choosing another directory.

`discovery::directory(location, xdg_data_home, home)` returns
`<data>/ycoding/meeting/<32 hexadecimal characters>` for a canonical Location.
`RuntimeLock::acquire` creates that directory with mode `0700`, replaces a lock
whose process no longer exists, and refuses a live owner. `publish_descriptor`
writes `bridge.json` with mode `0600`; `remove_descriptor` deletes it on unload.
`Control::connect(directory)` accepts only a regular, non-symlink file of at most
4096 bytes owned by the current user with no group or other access, whose JSON is
exactly `{url, token, pid}` with a numeric `http://127.0.0.1:<port>` URL and a
64-character lowercase hexadecimal token. `Control::send` and
`client::send_control` post to `/control` with a bearer credential, no proxy, no
redirects, a 10-second bound, and distinct errors for rejection, an unknown
outcome and an invalid reply.

`bridge::Bridge::start(Options, Arc<dyn Handlers>)` serves Axum on `127.0.0.1`
only. `Handlers` supplies the control, capture, disconnect, state-view and ask
callbacks. `Options.assets` and `ServiceOptions.assets` default to the complete
compile-time embedded `extensions/meeting/view` page, including its combined
font and page stylesheet, JavaScript modules and brand mark, with the same
content-security policy as the presentation client. A packaged runtime serves
those exact bytes without adjacent page files or a source checkout. The host
can supply an explicit asset set in `Options.assets`. The bridge issues one random view
key per run, available only through the authenticated `{"action":"view"}`
control request. The controller credential and the view key are separate:
`/control` requires the controller credential and no `Origin`; `/view/*` requires
the view key and an absent or exact loopback `Origin`. Every request needs the
exact `127.0.0.1:<port>` `Host`, no query, and `application/json` for bodies.
Bodies are limited to 1 MiB, or 16 KiB for `/view/control` and `/view/ask`.
`/view/state` exposes only the allow-listed view fields. `/view/control` accepts
only `stop` and `retry`. Capture messages (`start` with consent, `audio`,
`stop`, `heartbeat`) are validated field by field, including canonical base64,
finite PCM in `[-1, 1]`, and at most one second of samples, before any callback.
A second non-heartbeat delivery while one is running, or a callback `busy` reply,
returns `429` with `Retry-After: 1`; heartbeats are never blocked by an audio
delivery. A capture with no heartbeat for `capture_timeout` (default 20 seconds)
is disconnected once, and `close` disconnects an active capture once. Callback
failures return only a fixed error code.

`transcription` runs the existing Python worker (`extensions/meeting/python/worker.py`,
embedded and passed as `-c`) over newline JSON on stdin/stdout through
`platform::process`. Requests are limited to 12 MiB, responses to 2 MiB, retained
stderr to 8192 characters and 33 lines, and each request to the configured
`requestTimeoutMs`. The worker starts lazily with `HF_HUB_CACHE` set to the
configured cache. Packaged runs do not resolve a worker file beside either
executable: the same source is embedded in the runtime and passed to the configured
`pythonExecutable`. An unavailable executable fails visibly without child state.
A timeout, protocol violation, write failure, crash or
cancellation fails every pending request, marks the provider unhealthy and
reaps the child; a crash message carries only the last stderr line. Disposal
closes stdin, sends `SIGTERM`, escalates to `SIGKILL` after two seconds and waits
for exit. `install_model` refuses to start any worker unless called with
`authorized = true`; initialization never installs a model, so a missing local
model is reported as a failure. `list_models` reports local availability for the
registered Hugging Face Whisper models.

`audio::AudioProcessor` turns validated capture packets into transcription
windows. Input is admitted synchronously by `accept` and inferred by `drain`, so
a blocked or failed inference never rejects new volatile input until the buffer
bound (`streaming.maxBufferedSeconds`, counting queued windows, resampler
history and the finalized tail every source would still emit) is reached; then
`accept` returns `AudioError::Backpressure` before admitting the sequence.
Packets resample to `streaming.sampleRate` with a Hann-windowed sinc filter
whose output does not depend on packet fragmentation, and each source emits
`chunkSeconds` windows that overlap by `overlapSeconds`. Window ids are stable
SHA-256 digests of capture, source, origin and offset, so a retried window keeps
its job. Each source keeps its own sequence and clock: a repeated sequence with
identical content within the last 256 sequences is a duplicate, changed or
expired replays and clocks that move backwards are rejected, and a sequence,
timestamp or sample-rate discontinuity finalizes the previous window and
reports a gap instead of blending clocks. With `streaming.vad` enabled, a
window whose RMS is below 0.005 is counted as processed without inference. A
failed inference leaves its window and everything behind it queued, records
the sanitized error, rejects new input until an explicit `drain(true)`, and is
never retried automatically; concurrent drains join one inference and share its
result. `reconcile_overlap` removes only the text that repeats across a real
time overlap, comparing grapheme clusters and keeping Latin or numeric matches
that continue a word.

`store::MeetingDatabase` is the facade over the isolated redb Meeting database
(`meetings.redb` in the Meeting directory, mode `0600`). Records are JSON values
validated by the store crate. A dedicated thread owns the thread-affine
`MeetingStore`; reads use snapshots, writes are single transactions, and
`delete_meeting` and `retain` run the store's secure erasure while the facade
keeps serving the replacement file. `update_meeting` sets or clears the optional
`captureID` and `error` fields explicitly through `Change`.

`runtime::MeetingRuntime` owns capture state and persistence. `control` accepts
the strict command set (`start`, `stop`, `status`, `transcript`, `config`,
`select`, `configure`, `model-select`, `model-install`, `models`, `retry`,
`confirm`, `reject-finding`, `correct`, `delete`, `summary`, `plan`, `reconcile`,
`approve` and `reject`) one mutation at a time; `capture` implements the live-page protocol: a `start`
needs an armed `ready` meeting, enabled streaming and a loaded provider,
heartbeats keep the capture alive, audio that the buffer cannot hold replies
`busy`, and an inference failure stops the capture once and keeps the failed
windows for an explicit `retry`, a replacement `model-select` or `configure`.
Windows become `temporary` segments and are finalized when the next window
supplies text, when the capture stops, or on `stop` for a meeting that a restart
interrupted. A configured fallback model takes over only after the selected
provider fails. `expire_capture` interrupts a capture without a heartbeat for
`heartbeat_timeout` (15 seconds). Raw audio is never persisted: a capture that
is interrupted by `close`, expiry or a restart leaves untranscribed audio
unrecoverable, startup recovery marks `recording` and `stopping` meetings
`interrupted`, and `retry` works only for failed windows retained by the current
process. `close` joins scheduled work and in-flight controls, disposes the
provider and closes the database; later controls other than `status` and
`retry` are refused.

`intelligence::Intelligence` analyzes finalized evidence through two seams that
the host supplies in `RuntimeOptions` and `ServiceOptions`. `Generate` maps a
Session id and a prompt to text; `Mcp` lists tools and calls one, and
`ServiceMcp::new` adapts the live Core MCP `Service`. `ServiceMcp::shared`
adapts a shared `Arc<Service>`, and `replace` points later calls at a
replacement service while calls already started keep theirs.
`intelligence::from_generator` builds that `Generate` from a Session-backed
`session::analysis::Generator`; `ServiceOptions.generator` applies it when
`ServiceOptions.generate` is absent. Summary, plan, reconciliation, incremental
and final analysis run on registered analysis Sessions with no tools and one
bounded user message; without a `Generator` (or `Generate`) the explicit
unavailable error is kept. `ServiceOptions` also takes the matching `analysis`,
and `start` registers every persisted meeting analysis Session id with
`Analysis::register`, mirroring `listMeetings`. Analysis requests for one meeting
coalesce into a single generation owner that re-reads evidence until no newer
request is pending. A model reply must be one JSON object (optionally inside one
complete `json` fence) with a summary, findings and proposals. Every finding and
proposal cites finalized segments of that meeting; a model cannot set a status,
and a speaker, owner or deadline needs verbatim support in the cited text.
Finding ids are digests of meeting, kind and normalized summary, so a repeated
finding keeps its identity, and a changed owner, deadline or speaker returns it
to `unconfirmed`. A knowledge proposal needs a canonical document read through
the configured MCP binding and records that revision. Context is bounded by
`analysis.maxCharacters` without cutting a segment. `approve` and `reject`
record an immutable approval; only an approved proposal whose binding has a
revision-aware writer (`id`, `content` and `expectedRevision` advertised) is
written, after re-reading the canonical document, and the write is verified by
read-back. Any other outcome is `manual`, `stale`, `uncertain` or `failed`, and
a write is never replayed. `plan` accepts only confirmed decisions and
requirements and discards its result when the cited evidence changes during
generation. `correct` marks dependent findings, proposals and plans, records an
approval, and re-analyzes. `knowledge.mcpEnabled: false`, or a host without `Mcp`,
retrieves nothing and leaves proposals `manual`.

`ask::Questions` implements the live page's Ask handler on a fresh Session per
question: at most one question per meeting runs at a time, the newest 500
segments are cited with their state and source, the history keeps the newest
50 entries, and answers are bounded to 16000 characters. `Questions::with_generator`
builds the handler from the same Session-backed `Generator`, so each fresh Ask
Session is registered analysis work. `history::register`
registers the read-only `meeting_history` tool (meeting list and search, or one
meeting's segments, findings, summary and proposals) in a Core tool `Registry`;
dropping the returned `Registration`, or `MeetingService::shutdown`, removes it.

`service::MeetingService::start(ServiceOptions)` composes the pieces in order:
runtime lock, saved `settings.json` (which takes precedence over
`ServiceOptions.config`), database, runtime recovery and retention, Ask
handler, bridge with a fresh 256-bit controller credential, private descriptor,
and the five-second expiry timer. A failure at any step unwinds the earlier
steps and leaves neither the lock nor the descriptor. `shutdown` stops the
timer, closes the bridge, waits for running questions, closes the runtime,
removes the descriptor and releases the lock, attempting every step and
returning the first error. Control failures reach the caller as
`{"error": "<message up to 300 characters>"}`.

Limitations: only the built-in `huggingface` provider and its two registered
models are available; there is no dynamic model or provider registry. Without a
`Generate` (neither `ServiceOptions.generate` nor `ServiceOptions.generator`),
`summary`, `plan`, `reconcile`, incremental and final analysis and Ask are
unavailable: the three controls fail with `Meeting intelligence is not
available in this runtime`, the state view carries no `ask` field, and the
bridge reports `ask_unavailable`. `approve`, `reject`, `correct`, retrieval and
`meeting_history` do not need it. The host supplies the Session factory
(`ServiceOptions.create_session`) that returns the Session id stored with each
meeting.

Production's Meeting Session factory records the resolved Project through the
existing idempotent Session-store operation before creating an analysis Session.
This supports a fresh Location booted through a read such as `agent.list`, without
requiring a pre-existing foreground Session or marking the directory opened.

Run the focused checks from `rust` with
`cargo test --locked -p ycoding-core --test 'meeting_*'`. They use real loopback
bridges, real files and child processes, and a Python stand-in worker (`python3`
on `PATH`); they do not load a model or touch the Hugging Face cache.

`cargo test --locked -p ycoding-runtime --test meeting_clients` launches a fresh
real runtime copied to a directory without adjacent assets, opts in with
`--meeting`, boots a Location through `agent.list`, and runs the existing Bun
discovery/control client, live-page delivery and rendered TUI against its bridge.
It checks exact assets against the presentation client's `viewAssets`, capture
and stop responses, consent and model-install authority separation, final
transcript rendering, and descriptor/lock cleanup. Only speech inference is
replaced by a local protocol worker; no model download or provider request is
needed. Native audio and Windows are outside that Unix integration check.

## Durable Session foundation

`session::store::Service` accepts a Store client without a tool registry or
Location runtime. It adopts existing Session identities, admits user and
synthetic inputs with first-admission-wins semantics, rejects cross-Session and
cross-kind identity reuse, and reconstructs promoted retries from the original
durable admission. Steer batches and single queued inputs promote transactionally
in admission order. A pending compaction blocks promotion. Pending storage holds
only unconsumed inputs; visible messages carry promotion sequence and time.

The Session projector folds creation, selection, observations, assistant text,
reasoning, tool parts, retries, consumption, and execution terminals into Store
read models in the event transaction. Tool-part folding does not execute tools.
Terminal usage and activity preserve Session list update time. History uses one
snapshot for Session metadata, chronological message windows, and the durable
watermark. Backward cursors are Session-bound canonical base64url values; completed
legacy checkpoints bound history while running checkpoints do not.

`session::execution::Execution::install(store, locations, jobs, steer)` installs the explicit
process-global owner. `steer` is an optional `Arc<dyn autonomy::Steer>` supplied
by the host; without it, settlement skips goal continuation. `jobs()` returns the
shared `job::Jobs` the owner settles against. `Locations::get(&location::Ref)` resolves a Location-owned
`Arc<dyn Runner>` only when a drain begins. `Runner::drain(DrainRequest) ->
RunFuture` receives a typed Session ID, the explicit-resume `force` flag, and a
watch-backed cancellation signal; its boxed, sendable future returns `Outcome`.
The runner owns nested work. Its optional `settled` hook joins and finalizes
owned work after its drain future is dropped and before execution settlement.
Execution retains the runner selected at drain start for that cleanup; it does
not resolve a moved Session's Location again during settlement.
Awaited work can call `request_interrupt` without waiting on its own settlement.
Runner errors preserve their typed Session error; owner interruption preserves
its user, shutdown, or superseded reason.

Execution admits no provider work for a managed task unless its state is
`running`; a waiting or terminal child's pending inputs remain durable. Advisory
wakes require eligible inbox work. At execution start, retained restart-loss
notifications are admitted to the parent without a provider wake.

Successful settlement generates and revision-fences an eligible goal steer,
advancing the goal before publishing `session.execution.succeeded.1`. It then
runs work Completion, settles a still-running managed child, dispatches ordinary
subagent notifications, admits the deterministic goal input, and wakes only when
the admission is eligible. Goal continuation waits for active direct children
(`starting`, `running`, `waiting`, `cancelling`) and outstanding shell work or
owed shell notices. Success neither spends nor resets the no-progress budget.
Goal and child excerpts read the newest assistant through history `latest` and
concatenate only its text parts, without separators; absent assistant and empty
assistant text remain distinct.

Failure publishes the execution failure and fails a still-running task with
error and excerpt bounded to 16 KiB at UTF-8 code point boundaries, without goal
continuation or Completion. Successful child excerpts use the same bound.
Interruption preserves suspension and does not settle the child task or continue
the goal. Task settlement checks the running state in the publication transaction,
so a cancellation or terminal transition committed first wins. Notifications use
deterministic parent input identities and durable delivery marking; repeated
dispatch cannot duplicate an admitted notification. Goal generation, task
settlement, and notification-dispatch errors are reported without changing a
successful drain into a false goal completion.

`session::runner::Local` accepts explicit Location services: Session Store, model
resolver, agents, credentials, tool registry, managed attachments, ordered
instruction sources, optional loaded configuration and image-analyzer service,
active process extensions, AI executor, and clock. It implements both the execution
Runner and coordinator Drain boundaries. It promotes steers at step boundaries
and one queued input when the Session would otherwise become idle, reloads
projected history for each continuation, holds the advertised materialization
while tools settle, and calls `Executor::stream` once per physical attempt.
Text, reasoning, tool input, tool settlement, usage, retries, and terminal Steps
are published through the real Session event transaction. Owned tool tasks are
joined before terminal settlement; cancellation aborts and joins them, fails
unsettled tool parts, and closes the open Step before its waiter resolves.

Rate-limit, internal-provider, and transport failures without retry evidence
retry within one logical Step, with two-second minimum, two-minute maximum
exponential backoff and a ten-attempt ceiling; a provider retry hint extends the
wait but never shortens it. A provider retry hint above two minutes fails
without a retry. Interruption during backoff closes the Step with one `aborted`
failure. A settled empty terminal answer receives one additional
text-only recovery Step with no synthetic user prompt. A second empty answer
fails; recovery cannot create a third Step.

`Services::snapshots` supplies the Location's optional `Snapshots` provider. A Step
captures its starting tree before execution and stores it on `session.step.started`.
After the stream and owned tools settle, both successful and failed Steps capture
the final tree and the changed, non-ignored paths. Snapshot capture unavailability
leaves the ID absent; a file-comparison failure leaves the paths absent. Shell and
external-tool edits are included without requiring tool-returned file metadata.
Revert stages, clears and commits those paths through the same snapshot provider.
The production constructor leaves `Services::snapshots` unset. Composition must
supply the Location's `GitSnapshots` shared with revert; the runner does not
discover a repository or construct snapshot storage.

Request assembly verifies managed image attachments before lowering history.
Vision-capable running models receive image media. Non-vision models receive
TOON analysis from the supplied `image_analyzer::Service`, or an explicit
failure description when the analyzer is absent, disabled, unavailable, or
limited. The same policy applies to completed local-tool inline images;
provider-executed tool results retain provider ownership. Analysis changes only
the outgoing request, not durable attachment or tool output records.

`Services::extensions` supplies the Location's active `Vec<Arc<Extension>>`.
Assembly runs ordered tool-definition transforms before ordered Session-context
hooks, then computes canonical tools and cache fingerprints from the hooked
request. Context hooks may change system/history content and the descriptions
and input schemas of advertised tools, or omit advertised tools; unregistered,
denied, step-limited and recovery-disabled tools cannot be introduced. Registered
handlers and provider-native tool ownership remain captured. Context execution
failures append a model-visible warning and allow later hooks to run; permission
and identity violations fail before provider execution. Catalog aliases retain
their selected model reference while the request uses the resolved API model ID.

Location composition supplies `Services::configuration`, `image_analyzer`, and
`extensions` from its loaded configuration, analyzer owner, and extension
activation owner's `extensions()` result. A `None` configuration uses efficiency
defaults; a `None` analyzer still produces non-vision image failure descriptions;
an empty extension list runs no hooks. The production construction site currently
supplies those disabled inputs and requires the composition owner to wire them.

Before each Step the runner records the trusted Session state (todos, autonomy,
permission ceiling, goal reminder) as a System `session-state` observation, the
child-task TeamView as a user-authority `team-view` observation, and the
step-limit notice or its reset as a System `step-limit` observation. A source
is published only when its text differs from the latest resident observation
of that source; a TeamView whose children have all been removed is announced
once as an empty team. Analysis Sessions record neither Session state nor
TeamView because their request carries only the bounded user-data input. A
Step whose tool returns non-object structured output stores it as
`{"value": <output>}`.

A model whose provider package is the Cursor package resolves through the
Location's optional Cursor host (`Services::cursor`); without a host the model
is unavailable. Requests routed through the `cursor-connect` route append the
non-Cursor identity instruction to the system prompt after instruction assembly
and analysis restriction, so context-limit checks and the recorded system
digest include it.

`session::runner::mcp_notifier(store, clock, wake)` builds the MCP `Notifier`
for background tool completions: it admits one synthetic `steer` input whose
text is the completion notice, whose description is the tool name, and whose
metadata is `{"source":"mcp","state":<state>}`, then wakes the Session unless
it has a staged revert. The `Jobs` instance placed in the MCP `Background` is
the one the composition root also gives the shell tool; the runner holds no
Jobs of its own.

`Service::model_history` applies legacy checkpoints, project-artifact boundaries,
digest-verified local rolling summaries, and current digest-aware message/part
exclusions. `first_user_message_if_only` reads at most two indexed user rows.
Named model profiles resolve the uniquely named credential independently from
the provider's active account. The runner publishes a versioned profile-binding
fact before execution and validates its credential identity and account generation
on subsequent requests. Replacing that account fails before another provider
request; explicit model reselection clears the binding and permits a new pin.

`session::usage` normalizes provider usage into step tokens and cost. Cost uses
the catalog tier for the request's input-side context, and prices a provider
reported Anthropic one-hour cache-write count at twice the input rate when it
does not exceed the reported cache writes; any other count keeps the catalog
cache-write rate for all writes. `session.step.ended` also carries the model
context limit and `providerCache`: the route's cache mechanism
(`session::cache_diagnostics`) with `readReported` and `writeReported`. Missing
provider cache telemetry is unreported, not a reported zero; the token totals
stay numeric zero.

Each logical Step ends with one durable `session.provider.request.recorded`
fact folded into the provider request and per-model usage tables. It carries the
request number, physical attempt count, route, prompt-cache namespace
(`session::prompt_cache`), system and tool digests, the account identity digest,
invalidation classification, cache-read reporting, estimated cost and tokens. A
Step that never settled records `provider-not-reported` with zero usage; an
interrupted Step records its request best effort after terminal failure. The
account identity digest hashes the saved credential identity and account
generation, or the configured API key material, endpoint and organization; it
does not include OAuth, bearer-token or Vertex access-token material.

The publisher stores each reasoning, tool-call and tool-result provider state and
each text phase on the durable event with `opaqueCompactionItem` removed. The
removed item is captured instead: each assistant content part (text, reasoning
and tool, numbered in the order its start event is published) that carries an
`opaqueCompactionItem` yields one `session::provider_state::Capture` keyed by
message, content ordinal and kind (`reasoning`, `tool-call`, `tool-result`).
`publish_step_end` appends and projects `session.step.ended`, captures the
content-addressed blob (SHA-256 of the canonical JSON, item type from its `type`)
and one link per part under the active context revision, and remembers eligible
Responses continuation in one store transaction. A failed state or continuation
write rolls back the terminal event and its projection too; stale continuation
authority refuses the continuation without revoking the settled Step. Compaction
activation deletes the links of every message through the covered boundary.
Replay into later requests is account-bound: a prior assistant message reuses its
stored state only when the current model matches, the message has no error, and
one of its provider request records carries the current account identity digest.
Otherwise reasoning is sent as plain text and tool metadata is omitted. When the
effective request options set `store` to false (`openai.store`, or `copilot.store`
on the GitHub Copilot SDK route),
`provider_states` materializes the captured items of the account-matched messages
for the current provider and model, and the replay merges each item into the
matching part's state as `opaqueCompactionItem`.

Requests carry the session prompt-cache options. The wire prompt-cache key is a
per-generation hash of the Session, the namespace and generation 0; routes that
do not wire the key receive the namespace itself. GPT-5.6 and later on public
OpenAI routes use `efficiency.prompt_cache.openai_mode`: `auto` sends implicit
prompt-cache options with a 30-minute TTL and system/tail-message breakpoints;
`explicit` uses explicit mode with the same placement; `implicit` leaves
provider-native caching uncontrolled. Earlier public OpenAI models receive
`prompt_cache_retention: "24h"` only when `openai_extended_retention` is enabled
and the API model supports it. Copilot GPT-5.6 routes remain key-only.
Anthropic-family routes keep tool, system and two-message tail placement;
`anthropic_ttl` selects `5m`, `1h`, or `adaptive`. Adaptive uses one hour for
root Sessions and five minutes for children. Models without extended-TTL
capability always use five minutes. Claude Sonnet 5.5 and Haiku 5.5 have a
512-token cache minimum and support the one-hour TTL; diagnostics distinguish
a 511-token prefix from one at the 512-token minimum. Canonical cache keys compare Unicode code
points while preserving lone UTF-16 surrogates and the original JSON key text.

Direct OpenAI Responses requests honor `efficiency.openai_responses_state`
(`stored` by default, or `stateless`) and `openai_responses_continuation`
(`auto`/`on`, or `off`). Stateless requests set `store: false`, materialize
account-matched private provider state, and never use a stored-response
continuation. The runner captures the Session's continuation authority (generation
and context revision), fingerprints the request (Session, route, model, variant,
connection identity, represented message boundary, prompt-cache namespace,
instruction, tool and option digests), and sends `previous_response_id` with
`continuationInputStart` only when the stored fingerprint matches. A changed
account, model, tools or options yields a full replay. The settled response is
remembered under the same authority; a stale generation or revision is refused
by the store. Provider requests record `continued` or `full`.

Provider request records include `firstOutputMs`, `totalMs` and `retryWaitMs`
only while telemetry consent is enabled, and an interrupted Step records its
request with `provider-not-reported`.

Step and helper requests reserve their ordinal before opening the provider stream
in the store writer transaction, using the existing resource sequence keyed by
Session. Overlapping requests keep initiation order even if they settle in reverse
order. Reserved ordinals are not reused after cancellation or restart; Session
deletion removes its reservation sequence. Completion
publishes the request fact and projects usage once. An overflow-triggered
compaction rebuild keeps the logical Step's original reservation.

Generation timing is recorded independently from latency consent. Provider-timed
generation counts normalized output plus reasoning tokens. Observed timing begins
at the earliest non-whitespace text or tool-input delta; reasoning deltas begin the
span only when reasoning is folded into output. Unreported hidden reasoning hides
observed samples. Observed durations shorter than one second remain absent rather
than exposing buffered bursts as generation speed. Diagnostics include the
Session-only request summary and speed from the newest eight Step requests, with
the trend filtered to the newest request's provider, model and variant. Helpers
count in the summary but not the trend. A newest request without a valid speed
sample has no `latest`; older matching samples remain in `recent`. Snapshots read
the same speed under their store snapshot and expose it only when a measured
assistant remains after the resident compaction and before the revert boundary.
The runtime wire preserves absent speed and timing values, separately from
provider quota and prompt-cache reporting.

After a valid provider StepFinish is projected by the publisher, the runner emits
one ephemeral `session.diagnostics.updated` through `Services::events`, scoped to
the Session and its Location, before waiting for owned tools. The payload carries
that request's model, tokens, cost, context breakdown, cache reporting and speed,
including the current Step in its eight-request trend. It does not carry the
retrospective request summary; `Service::diagnostics` supplies that ledger view
after terminal settlement. Diagnostics emission creates no durable event.

A provider rejection that names an invalid, expired, missing or unknown previous
response (or a bare `invalid_prompt` rejection), received before any output on a
continued request, clears the continuation (the generation advances and the
stored response is deleted) and repeats the same logical Step once as a full
replay without a retry delay. The provider request records `fallback` with
`retry-fallback` and counts both physical attempts.

`session::analysis` provides the Session-backed analysis seam for Meeting
intelligence. `analysis_agent` is the hidden `meeting-intelligence` agent that
denies every permission; the host registers it with the Location's agents.
`Generator::create_session` creates a child Session of the optional parent (the
parent must belong to the Generator's Location) on that agent and the configured
model, and registers it in the `Analysis` guard. `Generator::generate` admits one
user message to a registered Session through `Service::admit_input` (a staged
revert commits first), runs it through the coordinator and returns
the answer text; an unregistered Session is refused. With an `Analysis` supplied
in `runner::Services`, every request for a registered Session is rebuilt from the
analysis system prompt, the single latest user message and no tools, and that
message must be text only and no longer than the configured character limit;
earlier messages are never sent. Continuation is disabled for these Sessions.
`Generator::generate` takes and returns strings so that the Meeting module can
wrap it as its `Generate` closure.

`session::compaction_job` owns the compaction job lifecycle over the existing job
table, one store transaction per transition. `compaction_admit` validates the
active context revision and canonical boundary, reuses an existing active job for
`consider` and `advised` triggers, answers a repeated identity idempotently or
rejects a changed one, extends a compatible pending job's boundary, and supersedes
an incompatible pending job as failed before admitting the new one.
`compaction_claim` starts the oldest pending job or reclaims a running job only
after its lease expired; `compaction_heartbeat`, `compaction_end` and
`compaction_fail` enforce lease ownership, the admitted revision and boundary, a
durable manifest, and the status rules (a pending job can only be cancelled or
superseded). Transitions publish the v2 `session.compaction.admitted`, `started`,
`ended` and `failed` events, which fold into one `compaction` message per job
(pending, running, completed or failed); the instruction epoch is derived from the
`ended` event. Failure codes carry their fixed message; deterministic failures
(`context_limit_unresolved`, `invalid_manifest`) are remembered per unchanged
admission.

`session::compaction::manifest` builds the manifest of a claimed job from the
canonical rows through its boundary. The uncovered rows (all of them for a
`mandatory` job, otherwise all but the newest `keep_recent_messages`) become one
canonical TOON `conversation_memory` checkpoint (`session::summary_toon`,
`session::compaction_summary`) that `context_manifest` validates against the
token reduction and protected-state evidence. The helper model comes from
`runner::Services.helpers` (`tools::policy::helper::Settings`): a model configured
for the owner's chat type (`main`, or `subagent` when the owner has a parent) wins,
otherwise the model pinned on the `compaction` agent, otherwise the owner's
selected model. It is resolved like the owner's model, including the profile
binding, and its context window and cost drive the helper batches and records;
when it cannot be resolved the checkpoint is built locally without a helper
Session or request. Each helper request runs in a hidden child Session of the
owner on the `compaction` agent and the helper model (id
`ses_compaction_<first 24 hex of the job id's SHA-256>`, the owner's permission
ceiling, plus a `session.profile.bound` event when the helper model selects a
profile), uses the fixed template as its system prompt with no tools, and is
recorded as a provider request with source `compaction`. Batches are fitted to the
smaller of the job target and the helper context window minus the safety margin,
at most `max_internal_passes` helper calls are made, generation is bounded by
`timeout_seconds`, and a failed, empty, timed-out or unparseable helper answer
completes from the local checkpoint. The checkpoint keeps the active skills and
the rendered live-state text. The live-state loader, a single function parameter
of `compaction::Input`, is `session::live_state::load` over the Store and
`runner::Services.guardrails`; its text is retained in the summary and its eight
protected-state entries (instructions, todos, goal, autonomy, permissions,
guardrails, pending work, orchestration) are stored in the manifest and compared
with the evidence, and a failed load fails the job with `migration_failed`.
`session::compaction_execution::run` claims the job (30 s lease, 10 s
heartbeat), builds and activates the manifest (three attempts while protected state
changed), stores the manifest row and calls `compaction_end` in one settlement, or
fails the job with the mapped failure code.

Before each Step request the runner gates the local input estimate (and, when the
request is not smaller than its raw estimate, the last assistant's provider-reported
input and total tokens) against the hard cap, the context window minus the safety
margin. Over the cap, the gate settles an already pending job; otherwise it admits a
`mandatory` job when a complete boundary and an active context state exist, the
request can be reduced (the system prompt, tools and the retained rows estimate
below `consider_percent` of the context window, 70% by default, once every
removable consumed user and completed assistant message is dropped) and no unchanged
deterministic failure is remembered. A Step admits at most two jobs; each ended job
clears the provider continuation and rebuilds the whole request from projected
history. A provider context-overflow rejection received before any output evidence
keeps the same Step and assistant message, forces the gate to compact once more and
sends one more physical attempt. The Step keeps one provider request across the
restart: the rejected first attempt is not recorded separately, and the single
record counts both attempts. A second overflow fails the Step with `context.limit`;
without reducible history the original provider error fails the Step.

Remote (Codex) compaction and the synthetic `remoteCompactionV2` replay message
are not exposed by this runner.

A Step that fails after the provider settled it carries the settled tokens, cost,
context limit and `providerCache` on `session.step.failed`. When the selected
agent has a step allowance, the runner appends a durable `step-limit` System
observation once the allowance is reached (tools are disabled for that Step) and
a reset observation when a later promoted input restores the allowance. The
text-only recovery Step receives neither.

The coordinator joins explicit same-Session resumes, coalesces advisory wakes,
permits different Sessions to progress concurrently, and forwards late doorbells
to a visible successor before resolving original waiters. Per-Session transition
reservations serialize state changes and defer doorbells until the last release.
Interrupting an idle known Session is inert; public execution rejects unknown
Sessions. Interruption after terminal cleanup begins is inert. Explicit shutdown
stops intake, cancels owned drains, and joins their tasks. Lifecycle hooks run once
per busy period, including runner panics, before waiters resolve.

Restart actions are explicit and inert until called: `Execution::suspend_active`
preserves the original suspension timestamp, and `Service::reconcile_interrupted`
uses lifecycle/type indexes to append missing Step and execution failures without
resuming work. Starting or completing execution clears stale suspension;
interruption preserves it. Suspension consumption is atomic.

`instructions` owns ordered JSON-valued sources, concurrent read settlement,
canonical SHA-256 hashing, changed/removed deltas, and nonempty rendering. Explicit
unavailability retains an admitted value and blocks only an unavailable initial
baseline. Rendered strings preserve UTF-16 code units. Domain producers remain
with their resources; callers supply their ordered sources explicitly.

Session instruction observation reads each source once. Commit inserts immutable
values into `instruction_blob` and publishes only source keys and hashes in
`session.instructions.updated.2`, transactionally with the rebuildable state
cache. Assembly dereferences values and renders the initial baseline and ordered
System-message updates without rereading sources. Preview reads through absent or
stale caches without repairing them or admitting its private changes. Missing
blobs and mismatched blob hashes fail rather than fabricate instruction content.
Epoch folding follows completed compaction, movement, and committed revert facts
in durable history, including bounded fork ancestry. Canonical transcript and
snapshot reads derive instruction-key notices; they do not persist rendered
notices or count them against projected-message page limits. Notices are placed
at their update event's sequence among the messages, in the full transcript and
in every backward window.

Bounded history reads use the message type index after the latest completed legacy
compaction: `store::Service::latest` returns the newest message of one type,
`recent` the newest N messages in order, and `unsettled_tool_messages` the
assistant messages holding a streaming or running tool call, decoding only
matching rows. `observation_state` pages the newest `system` and `synthetic`
rows (100 per page) through the model-visible window and returns, per
`session-state`, `team-view`, and `step-limit` source, whether any observation is
present and the newest text whose `session.context.observed.1` event confirms the
source and text. Model history reads only rows after an active summary's covered
sequence, so covered payloads stay undecoded; snapshot windows accept 1 to 200
messages and reject other limits as an invalid cursor. `session.guardrail.approved.1`
events project no message.

`Service::instruction_entries`, `put_instruction_entry`, and
`remove_instruction_entry` own Session context entries. Values are limited to
8192 serialized UTF-8 bytes; unchanged writes and duplicate removals are no-ops.
Removed entries retain tombstones for chronological instruction removal.
The runner appends their `api/<key>` sources to the Location's explicit ordered
sources and prepares them before inbox promotion. Entries render as mechanism-neutral
context blocks; changes and removals supersede earlier values.

`instructions::builtins::load` produces environment, injected-clock date and
the eight current runtime guidance sources. `session::instruction_sources::ambient`
adapts the existing resource observer's global/upward-project AGENTS files,
inline-size limits, unavailable retention and removal semantics. Supply these
sources in `runner::Services.instructions` with other Location guidance; the
runner combines them directly with Session entries through the shared algebra.
There is no instruction registry, implicit global-path lookup or second state
authority. Instruction assembly renders admitted values without rereading files.

This boundary does not implement dynamic tool-read file injection, Session
fork/movement/deletion, compaction
execution, autonomy,
orchestration, skills, or guardrails. Unsupported durable events fail publication
transactionally. Stream deltas are not persisted. Session tests use the actual
Store and in-process runner doubles outside the execution boundary. The explicitly
named `session_runner_integration` suite runs the actual Local runner, AI HTTP/SSE
route, registry and Session projection against isolated loopback provider servers;
only provider responses and its retry clock are stand-ins.

From `rust`, run the focused checks through the shared Cargo gate:

```sh
CARGO_BUILD_JOBS=4 ~/.cache/ycoding/cargo-gate.sh cargo test --locked -p ycoding-core --test 'session_*'
```

### Session live state

`session::live_state` renders the protected Session state the runner places in
volatile system context and reports the per-source revisions and digests that
compaction protects. All reads are pure functions of Store state.

- `capture(&Snapshot, &session::Id)` and `capture_in(&mut Write, &session::Id)`
  return a `DatabaseCapture` (autonomy, deny-only permission ceiling, todos by
  position, and a `DatabaseSources` value) from one snapshot or the caller's
  transaction. A missing Session fails with `Error::Domain { kind: "not_found" }`.
- `load(&Client, &session::Id, guardrails)` takes a fresh snapshot per attempt
  and calls the `guardrails` closure (returning the Session guardrail `Source`)
  before and after the database read. It retries until both guardrail sources
  match, then returns a `LiveState`: `text` (`AUTHORITATIVE_STATE_PREFIX`, a
  newline, canonical JSON of `todos`, `autonomy`, and `permissionCeiling`, then
  the goal reminder after a blank line), the volatile system `rendered` message,
  the orchestration `team_view` observation when the Session has child tasks,
  and `Sources`. `LoadError` distinguishes Store failures from guardrail failures.
- `protected_state(&Sources)` returns the compaction protected-state entries in
  order `instructions`, `todos`, `goal`, `autonomy`, `permissions`, `guardrails`,
  `pending_work`, `orchestration`. `database_protected_state(&DatabaseSources)`
  omits `guardrails`. `project_artifacts` is never reported.

Each `Source` is `{ sequence, digest }` and contains no state content. Instruction
sequence is the newest `session.instructions.updated.2`,
`session.compaction.ended.1|2`, `session.moved.1`, or `session.revert.committed.1`
event and its digest covers the cached instruction values (empty when absent).
Pending-work sequence is the newest `session.input.admitted.1`,
`session.input.promoted.1`, or `session.compaction.admitted|ended|failed.1` event
and its digest covers the ordered pending ids, types, deliveries, and admitted
sequences. Permission sequence is the newest `session.created.2` or
`session.forked.2` event. Todo sequence and digest come from `session_todo_state`,
falling back to a digest of the ordered rows and revision 0. Goal and autonomy
share the Session autonomy revision; orchestration uses the Session
orchestration revision and a digest of child task revisions. Latest-event
probes read one index row per event type.

### Session revert

`session::revert` stages, clears, and commits a Session revert through durable
events. `Snapshots` is the Location file-snapshot boundary
(`capture`, `files`, `restore`, `diff`); `session::snapshot::GitSnapshots` implements
it over the Git tree primitives.

- `plan(&Snapshot, session, message)` fails with `Error::MessageNotFound` when
  the boundary message is absent from that Session. Otherwise it maps each file
  recorded by assistant messages after the boundary to the first
  `snapshot.start` that names it.
- `stage(service, snapshots, session, message, files, now)` reuses the staged
  revert's snapshot or captures one, restores the staged files from the original
  snapshot and (when `files` is true) the planned files from their snapshots,
  diffs the original against a fresh capture over the planned paths, and
  publishes `session.revert.staged.1`.
- `clear` restores the staged files from the original snapshot and publishes
  `session.revert.cleared.1`; `commit` publishes `session.revert.committed.1`
  for the staged boundary. Both are no-ops without a staged revert.
- `stage_idle`, `clear_idle`, and `commit_idle` take a `Runs` port
  (`Execution` implements it) and fail with `Error::Busy` while the Session is
  active and `Error::SessionNotFound` for an unknown Session. `clear_idle`
  wakes the Session after clearing, even without a staged revert.
- `committed_after(&Snapshot, session, seq)` reports whether the Session's latest
  `session.revert.committed.1` event has a sequence greater than `seq`;
  `Completion` calls it, against a snapshot and inside the publishing
  transaction, and rejects its candidate when it holds for the invoking step's
  sequence.

`GitSnapshots::new(git, data, project_id, project_directory, directory,
enabled)` resolves its repositories on first use. It discovers the Git
repository containing `project_directory` and keeps snapshot trees in a
repository at `<data>/snapshot/<project_id>/<sha1 of the canonical worktree>`
that borrows the project's objects. `capture` records the tree of the
`directory` scope, ignoring files larger than 2 MiB that are untracked and
files the project ignores, and returns no ID when snapshots are disabled, the
project is not a Git repository, or Git fails. `restore` checks out each path
from its tree and deletes a path absent from its tree, rejecting paths outside
the worktree. `diff` returns per-path diffs with three lines of context for the
requested paths, omitting paths the project ignores among the changed files; a
path unchanged between the trees yields a modified entry with zero additions
and deletions.

Prompt admission goes through `Service::admit_input`. A user input first
commits a staged revert, then is admitted; a synthetic input is admitted without
committing, and its `wake` result is false while a revert is staged, so the
input is held until the revert commits (which deletes it) or clears.
`Execution::prompt` wakes the Session only when `wake` is true. Goal
continuation, analysis prompts, and orchestration inputs (launch prompt, parent
`send`, parent and automatic answers, subagent notifications) use the same
entry. `continue_goal` returns the `Admitted` record and its caller wakes the
Session only when `wake` is true; orchestration wakes the target Session only
when the admission's `wake` is true, so synthetic work stays pending behind a
staged revert and `clear_idle` wakes the Session.

`Service::update_todos` replaces a Session's `session_todo` rows with the given
`session_todo::Info` list in order (positions from 0) and upserts its
`session_todo_state` row in one transaction: the revision starts at 1 and
increases by one per update, and the digest is the SHA-256 of the ordered rows
serialized as `[{"content","status","priority","position"}]` in that field
order. An unknown Session is rejected as `not_found` and nothing is written.
`todo.updated` is an ephemeral event, not a durable one: no projector fold
exists, and the Core write does not publish it.

The projector stores the staged revert and update time on the Session row;
cleared and committed events clear it. A committed event also deletes the
Session's messages with sequence at or after the boundary message, its pending
inputs admitted at or after that sequence, and the cached instruction state,
and rejects the event transactionally when the boundary message is not in the
Session. Cost and token totals are preserved.

`session.moved.1` sets the Session row's directory and workspace (cleared when
the event carries none), replaces the project and subpath only when present,
updates the update time, and deletes the cached instruction state.

`Service::diagnostics(session, boundary)` returns the cache diagnostics of the
latest assistant message that has token usage, reading only the newest
qualifying rows: it ignores messages at or after the staged revert boundary and
at or before the latest completed compaction, and returns nothing when the
boundary message is not in the Session.

### Session work completion

`session::completion::Completion::new(Service, job::Jobs)` records
`session.work.completed.1` for verified work. `complete(session, active)` runs
after `session.execution.succeeded.1`; `active` returns the Sessions the
process-local coordinator currently runs and is read again inside the publishing
transaction.

A candidate exists when, in the events after the latest
`session.execution.started.1`, the execution ended `succeeded`, the last step
ended with finish `stop` and has a non-blank text that is not `commentary`, and
an earlier step of the same execution holds a recorded, non-provider-executed
`task_complete` declaration (`structured.recorded` true) whose `tool.called` is
not provider-executed. A step failure, tool failure, or tool call of the final
step after the declaration, or a declaration by the final step itself, voids it.
The latest `session.input.promoted.1` before the invoking step must name the
latest `session.input.admitted.1` input, and no `session.revert.committed.1`
may follow the invoking step. The receipt ID is `evt_work_` plus the first 24
hex digits of the SHA-256 of `<session>\0<admitted seq>\0<latest revert seq or
-1>`, so repeated and concurrent calls publish at most one receipt per admitted
input and revert state.

Completion is refused while the Session or any descendant is not settled: the
Session must be active and no descendant active; any descendant has a pending
input, a staged revert, an active goal, an active (`starting`, `running`,
`waiting`, `cancelling`) task, or an undelivered task notification; or
`Jobs::outstanding_sessions` or a running job's `sessionID` metadata names a
family member. The publishing transaction recomputes the candidate and the
refusal checks and publishes only when the candidate is unchanged, so an
admission, revert, or new execution racing the publication discards it. The
receipt is appended without projector folding; the projector accepts
`session.work.completed.1` as a durable fact with no projected state.

The execution owner calls `complete` after it records `session.execution.succeeded.1`
for a succeeded settlement, passing its coordinator's active Sessions (the settling
Session is still active at that point) and the `Jobs` given to `Execution::install`.
Failed and interrupted settlements never call it. A `complete` store failure is
returned from the settlement.

`latest(Page { after, limit })` (limit 1 to 200, otherwise `Rejected`) returns
the newest receipt of each root Session in ascending Session ID order after
`after`, with `next` set to the last Session ID when more remain.

### Session retention

`session::retention::days(&Configuration)` reads `session_retention.days` from
the latest defining document; an absent or rejected value yields
`DEFAULT_DAYS` (7). Configuration validation accepts only a positive integer.
Load that `Configuration` with the global configuration directory as its
Location so project documents are not consulted.

`Service::retain(now, days, active)` deletes idle root Session families: a root
(no parent) plus every descendant. `active` returns the Session IDs this process
is executing and is called inside each family's write transaction. The sweep
selects roots whose `time_updated` is before `now - days`, ordered by update
time then ID, and deletes each family through `remove_idle(root, now, cutoff,
active)` in one write transaction that re-reads the family and keeps it whole
when the root has gained a parent or any member:

- has `max(time_updated, time_active)` at or after the cutoff;
- is pinned, suspended, or has an autonomy goal with status `active`;
- has an unconsumed pending input;
- is returned by `active`; or
- is the fork source of a Session outside the family.

A deleted family publishes `session.deleted.2` for each member, children first,
through the same cascade as `Service::remove`, then removes each member's event
and sequence rows and, in the same transaction, compaction-manifest and
provider-state blobs that no remaining row references. After the last family,
instruction blobs those families referenced are deleted in chunks of at most
500 hashes when no remaining instruction event or instruction state references
them. `Sweep` reports the deleted Session count and per-root failures; a failed
family stays intact and the sweep continues. A failed selection scan or
instruction cleanup returns the error. `idle_roots(cutoff)` returns the
selection without deleting. Attachment files and snapshot repositories are not
touched. Execution activity is process-local, so another process sharing the
Store that has an idle family open loses it once the window passes.

### Outstanding work

`session::outstanding::read(sessions, orchestration, jobs, active, include_failures)`
returns four Session ID sets. `sessions` holds every Session that is active, is the
parent of an active (`starting`, `running`, `waiting`, `cancelling`) task or of an
undelivered task notification, has an active goal or any pending input, or is named by
`Jobs::outstanding_sessions`. `running` holds the active Sessions plus the Sessions of
running `shell` jobs. `lost` holds the Sessions of lost shell-ledger rows (see the
shell ledger) and of undelivered notifications whose `evt_task_restart_lost_*` event
exists (`orchestration::Service::lost_sessions`). `failed` is empty unless
`include_failures`; then it holds each root Session whose newest
`session.execution.started.1` or `session.execution.failed.1` event, taken per Session
in creation order and attributed to the Session's root, is a failure.

### Session read models

Three read-only `session::store::Service` methods answer from one store
snapshot each and return `Domain { kind: "not_found" }` for an unknown Session.

`compaction_history(session)` reads the Session's `compaction` messages through
`session_message_session_type_seq_idx` and keeps those whose data holds a
string `jobID`; legacy compactions without one are not counted. It returns the
newest 100 jobs ordered by `time.created` then job ID ascending, `truncated`
when more exist, `completedCount` and `totalSavedTokens` (the sum of
`inputTokens - retainedTokens` of completed jobs) across all of them, and
`completedBefore` as the completed jobs outside the window. Completed jobs carry
`metrics`, failed jobs carry `code`. The history is decoded through
`SessionCompaction.History`, so a record missing a required field is a `Record`
error.

`captured_inputs(session, after, limit)` pages the `user`, `synthetic`, and
`assistant` messages after the exclusive message-sequence cursor `after`
(`0..=2^53-1`) with `limit` 1 to 200; any other value is `Rejected`. A page
holds only attribution data: synthetic `metadata.kind` and `questionID`, and for
assistant messages the `edit`, `patch`, `apply_patch`, `subagent`, and
`subagent_control` tool parts with their status, `subagent_control`
`input.questionID`, `structured.sessionID`, `action`, `task.sessionID`, and the
`structured.files` entries that carry a string `patch`. Patch strings pass
through unchanged. `next` is the sequence of the last returned record when more
remain. A record that does not decode as `SessionCapturedChanges.Input` is a
`Record` error.

`usage(session, pricer)` retains the canonical redb operational summary.
`usage_report(session, input, pricer)` and `usage_report_all` read grouped pages,
full-scope totals/count and selected-row speed through the Store's committed-watermark
DuckDB engine. A root includes its descendant family once; a child reads only itself.
These blocking report calls run outside executor threads. Composition owns the Engine
lifetime through `ycoding_store::analytics::reports::start`; an unavailable engine
fails explicitly and never changes operational Session diagnostics.
`usage_report` supports the `model`, `hour`, `day`, `month`, `session`,
`project`, and `agent` groups, the half-open `from`/`to` range, sorting with
ascending key tiebreak, `offset`/`limit` paging (default limit 100), and per-row
`speed` from ranked first-output and total percentiles plus observed generation
throughput. Hour, day, and month keys use UTC; `timeZone` accepts UTC aliases,
fixed offsets and IANA names through the compiled timezone database. Requests without a recorded cost and
not from the `decision` source are priced through the optional `pricer`, which
maps a `PricingRef` (Location directory, workspace, provider, model, profile) to
provider and OpenRouter cost tables; the estimate is added with
`current_catalog` provenance. Without a `pricer` they carry no cost. Pricing refs
and timezone offsets are prepared in 200-row keyset windows; a concurrent source
change during preparation fails explicitly. Reports never retain all requests or
percentile vectors in Core. Native totals/grouping still process the complete
filtered population; pagination bounds decoded results, not all native query work.

Project lists use descending update time then ascending text IDs; directories use
descending creation time then ascending text paths. Inventory ordering and its
exclusive keyset compare worktree, project ID and directory with the same comparator.
Valid text compares by decoded Unicode scalars, equivalent to SQLite BINARY UTF-8.
Each lone surrogate compares as U+FFFD; equal decoded sequences use the original
UTF-16 units as a deterministic tie-break. Stored strings and returned paths remain
lossless, including distinct lone surrogates.

## Session autonomy, orchestration, and skill status

`session::autonomy::State` is the durable autonomy value stored in the Session
row's `autonomy` column (`{"mode":"normal","yolo":0..3,"goal"?}`) with
`autonomy_revision` as its fence; an absent or undecodable column reads as the
default state. `YoloLevel` accepts only 0 through 3 and is stored as given.
`Effective` is the policy: YOLO 1 auto-approves ask permissions and ordinary
guardrail reviews, YOLO 2 and 3 also auto-answer, and an active goal grants
answers and ask-permission approvals at YOLO 0 but never guardrail approval.
`can_auto_review(ReviewKind::Hard)` is always false. `Service::effective` takes
the strongest level and any active goal across the task-parent chain. Tool policy
authority reads Session and root autonomy through the same `State::read` and
`Effective`.

Every transition runs inside one Store transaction and bumps the revision when
it writes: `report` spends one no-progress attempt (`exhausted` at the budget),
`advance` increments the iteration without spending or resetting the budget,
`complete` and `stop` end a goal, `change` replaces, resumes, or stops, and the
`*_if_current` forms apply only at the expected revision. `stop` always bumps
the revision so a stale calculation cannot revive a missing or stopped goal.
`snapshot` returns the state, the revision, and the SHA-256 of its canonical
JSON. `State::goal_reminder` renders the visible goal reminder text.

`autonomy::continue_goal` implements one goal continuation: it returns without
work unless the goal is active, no shell is active, and no child task is active;
it asks the `Steer` seam for the next steer text, advances the iteration only at
the snapshot revision, and admits one synthetic `steer` input whose identifier is
`msg_goal_<sha256(sessionID NUL iteration)[..24]>`. The caller supplies the
helper-model `Steer` implementation and the active-shell fact.
Execution uses the same continuation stages, separating the fenced advance from
admission so the terminal execution and child-settlement events precede the new
goal input. `Steer::steer(SteerRequest) -> SteerFuture<'_>` receives the Session ID,
current goal and latest assistant text; `SteerFuture` resolves to `Option<String>`.
`None` leaves the goal unchanged. The host-supplied implementation owns model
generation, provider settlement validation, and request/usage accounting.

`session::goal::Service::new(store, provider)` supplies the production `Steer`.
The provider resolves a Session's current Location to `goal::Environment`
(serving Location, agent catalog, and shared `helper_generation::Generate`). A
missing Session, Location environment, goal agent, or model returns `None`.
`goal::agent()` supplies the hidden primary goal agent with the shipped system
prompt and deny-all permissions. The adapter uses that system prompt with the
configured goal agent's model selection: agent model, then
`efficiency.helper_models.goal`, then Session model, then catalog default.
An explicitly selected model that cannot resolve does not fall through to a
different model.

Goal steering sends the newest twelve projected messages as labelled context
(last 6,000 UTF-16 units), the active goal, continuation phase and iteration,
and the trimmed latest assistant text (last 2,000 units). Omitted latest text
reads the newest assistant from history. The shared helper path sends no tools
and records provider-request and usage accounting under source `goal`.
Provider failure, missing settlement, or empty output returns `None`; a settled
nonempty output is trimmed and whitespace-collapsed. Goal steering accepts a
settled non-`stop` finish, while prediction, prompt generation and compaction
retain their `stop` requirement. The adapter does not mutate the goal, admit
input, infer completion, or provide a fallback steer. Composition injects it
with `Execution::install(store, locations, jobs, Some(Arc::new(adapter)))`.

`session::orchestration::Service` owns child Sessions. `launch` derives
`ses_task_*`, `msg_task_*`, and `evt_task_*` identifiers from parent Session,
parent assistant message, and tool call; admits the prompt; publishes `started`;
and wakes the child through the `Execution` seam. Every launch is a background
task; there is no synchronous result path. The child's permission ceiling is the
deny-only union of the parent's ceiling and the caller's rules, so a child
never gains an allowance. `LaunchInput::depth_limit` bounds nesting by ancestor
count. `LaunchInput::guardrails` supplies the parent's Location-owned guardrail
service. Launch reserves a family-wide subagent slot after depth and retry
validation and before creating a child. A successful start transfers the
reservation to the orchestration service; completed, failed, lost, and cancelled
children release it. Launch errors and interrupted launch futures drop their
reservation. A matching launch retry uses the existing child's slot, including
at capacity; a settled retry reserves nothing. Capacity errors name the current
count, limit, running holders, and `guardrails.max_concurrent_subagents`.
Retries with the same identity return the task; a changed agent, model,
or prompt is a conflict. `get`, `send`, `answer`, `cancel`, and `resume` verify
that the task belongs to the named parent. A child question waits for a human
unless the family is effectively auto-answering, in which case the automatic
answer is admitted and the child continues. `settle`, `progress`, and
`question` serve the child side. The `session.task.updated.1` fold maintains the
`session_task` and `session_task_notification` rows and the parent's
`orchestration_revision`, and rejects invalid transitions.

`team_view` and `team_observation` render the TeamView from the task rows, so
the view survives reconnect and restart. The observation omits revisions and
clocks and sorts questions first so unchanged decisions render identical text.
Settled background tasks produce notifications; `dispatch_notifications`
admits each as a deterministic synthetic parent input and wakes the parent.
`reconcile_stale` marks active tasks lost with `evt_task_restart_lost_*`
identifiers; those notifications are delivered by `dispatch_restart_losses`
when the parent's execution starts, without waking provider work.

`Service::recover` is the explicit post-crash continuation design: it never
replays provider work. A `cancelling` task is cancelled; a `running` task whose
`attempt_started` flag is set (written by the `session.step.started.1` fold and
cleared by `session.step.ended.1` and `session.step.failed.1`) is marked lost
with an in-flight excerpt; a `starting` or `running` task without durable
pending input is started and then marked lost; a task with durable pending input
(including a terminal one) is started if needed and woken, so the runner drains
only the durable inbox. `waiting` tasks and terminal tasks without pending input
are left unchanged. `Service::page` orders children pinned first (by pin time),
then by state rank (waiting, starting, running, cancelling, settled), most
recently updated first, then by identifier, and returns at most ten tasks with
`ListAnchor` cursors in both directions plus total, active, running, and waiting
counts. The `session.deleted.2` fold deletes the Session and, for a managed
child, bumps the parent's `orchestration_revision`.

`Preflight::prepare` resolves a launch before any child exists: the target
agent must exist and not be `primary`, the caller defaults to the parent's agent,
and the model is the spawn model, else the agent's model, else the parent's
model, else the catalog default, resolved against the saved credentials. A
profile model binds to its credential (reusing the parent's saved binding unless
the spawn or agent model names a profile), and `launch` publishes the binding on
the child. `authorize` asserts the `subagent` permission for the caller through
`Permissions`.

`session::skill_status::list` derives skill status from resident messages and
instruction keys: reference and completed `skill` tool messages activate (a
completed load marked `alreadyActive` is ignored), explicit deactivation events
and agent switches and completed compactions deactivate with their reasons, and
conflicts combine declared, inbound, and instruction-key declarations among
active skills. `mcp_activation` returns the entry held by the active tool
activation. The `session.skill.activated.1` and `session.skill.deactivated.1`
folds append the `skill` message and record deactivations.
`store::Service::skills` folds the same status from the type index without
loading the transcript: it reads only skill, agent-switch, completed-compaction
and assistant rows that carry a completed `skill` tool or a deactivation, decodes
none of the others, and applies the rows in sequence order.
`session::skill` parses exact known `$id` references with the TypeScript delimiter
rules and reads explicit IDs from `metadata.skills`. `runner::Services::skill_resolver`
supplies the current catalog and full instruction text. `Execution::prompt` invokes
the Location runner's `prepare_input` hook only for new user IDs containing `$`,
so retries retain their original metadata. Before promotion, the runner resolves
selected and mentioned skills and rejects unavailable or denied skills while the
input remains pending. After promotion, it publishes each new activation message
before the first model request. Duplicate active skills are not published again.
A host constructing `runner::Services` injects its Location-scoped resolver through
`skill_resolver`.

## Workspace memory, attachments, and images

`resources::memory::Service` operates on explicitly supplied Location, home,
data, repository-association, and resolved configuration inputs. Repository IDs
are SHA-256 identities of canonical Git common directories, so linked worktrees
share one collection; knowledge is a separate collection under the same base.
Repository discovery and configuration refresh remain caller-owned. `configure`
replaces the resolved limits without altering saved concepts. Reading missing
storage and vacuum previews create no directories or lock files.

Concepts are UTF-8 linked Markdown with YAML `type` metadata and lowercase path
IDs. Replacements and deletions require the read content's SHA-256 digest; exact
write retries reconcile without a digest. Deletion creates a content-bound trash
receipt, restoration never overwrites an occupied ID, and purge targets one exact
receipt. Capacity limits include malformed active files; incomplete trash
inventories cannot admit new archives. Vacuum defaults to preview and binds apply
to active concepts, trash receipts, and obsolete generated-index bytes.
Handwritten indexes and unrelated files are preserved. Committed mutations report
derived-index failures as warnings and invalidate exported graphs. Graph HTML is
self-contained, escapes concept data, and disallows network access through its
Content Security Policy. Search is lexical and preserves UTF-16 snippet cuts.
The shared frontmatter parser rejects unquoted timestamp mapping keys; this
limitation also applies to memory concepts.
`memory::boundary::execute` validates typed inputs, fences the authorized root,
requests read/write authority, checks shared-knowledge reads for repository graph
exports, and owns guardrail-reservation release. It registers no tools.

`resources::attachment_store::Store` imports immutable content-addressed blobs,
verifies bytes and SHA-256 on reads, repairs altered copies on reimport, rejects
symlinked managed paths, and enforces the 20 MiB limit. Its explicit `migration`
operation validates and imports durable attachment payloads before atomically
updating existing event, pending-input, and message Store records and publishing
the completion marker. It does not run migrations at construction.

`platform::project_identity::resolve` reproduces TypeScript `Project.resolve`. In
a Git repository the ID is the SHA-1 of `git-remote:<normalized origin>`, else the
trimmed `<common directory>/ycoding` cache, else the first sorted root commit,
else `global`; the directory is the worktree root and the store is the common
directory. Otherwise the nearest `.hg` gives the cached `<.hg>/ycoding` ID, else
the first sorted `hg log -r roots(all())` node; otherwise the ID is `global` at
the filesystem root. Origin normalization follows WHATWG URL parsing with `file:`
excluded, then the SCP form `[user@]host:path`, strips leading slashes, one
trailing `.git` or `.git/`, and trailing slashes, and lowercases the host.
`session::store::Service::record_project` inserts a Project row and optionally a
directory row, each only when absent, in one transaction.

`session::attachment_admission` serves `Service::materialize_attachment`, the
TypeScript prompt admission rules. A managed `ycoding-attachment://sha256/` URI
reuses the stored blob with a detected MIME type, falling back to the content and
MIME type recorded by an earlier `session.input.admitted.1` event when the stored
copy is unavailable. A `data:` URL decodes canonical base64 or percent-encoded
UTF-8. A `file:` URI reads a file, honours positive integer `start` and `end`
line bounds for text, and turns a directory into a sorted listing with MIME type
`application/x-directory`. Content above 20 MiB is refused; MIME detection uses
the TypeScript signatures and text heuristic; images are normalized to the
supplied limits; the result is imported into the managed Store.

`session::attachment_read` serves `Service::attachment_read`. It accepts only a
64-character lowercase hexadecimal digest, requires the Session, and finds the
first managed file with that digest in the Session's user messages, then in its
pending user inputs. References above 10 MiB fail as too large before any read.
Integrity, path, and missing-blob failures read as not found and log a warning;
other Sessions' references are never consulted.

`resources::image` normalizes base64 content with native Photon 0.3.3, with its
Wasm features disabled. In-limit input remains unchanged. Resizing uses Lanczos3,
PNG first, then JPEG qualities 80, 85, 70, 55, and 40, followed by progressively
smaller dimensions. Metadata survives normalization; decode and size failures
retain their resource and limit details. Memory never automatically persists or
injects transcripts; its instruction producer prohibits secrets and transient
task state. These resources do not analyze images or execute a Session runner.

Run the resource checks from `rust` with
`cargo test --locked -p ycoding-core --test 'memory_*' --test 'attachment_*' --test 'image_*'`.
The checked-in memory generators read committed TypeScript through `git show main`;
the format generator requires `YCODING_MARKED_MODULE` pointing at installed Marked
17.0.6. The image generator requires `YCODING_PHOTON_MODULE` pointing at installed
Photon Node 0.3.4 and reads literal PNG/JPEG inputs. Its `--inputs` option regenerates
those deterministic inputs. Generators do not install packages or contact providers.

## RegExp engine

`ycoding_core::regexp` owns ECMAScript pattern parsing and backtracking matching
for restricted Code Mode. It does not execute JavaScript or delegate matching to a
generic regex library. Patterns, input, captures, group names, replacements and
output use UTF-16 (`&[u16]` / `Vec<u16>`), preserving lone surrogates. Positions and
`d`-flag ranges are UTF-16 code-unit offsets.

### Interpreter integration

Construct with `RegExp::new(pattern, flags)` or
`RegExp::new_with_budget(pattern, flags, &mut budget)`. Invalid syntax or flags
produce `Error::Syntax`. Supported flags are `d`, `g`, `i`, `m`, `s`, `u`, `v`, `y`;
`u` and `v` are exclusive. `source()`, `flags()`, `literal()` and the corresponding
boolean accessors expose native properties. `last_index: u64` is the coerced
matching cursor; the interpreter must retain the original writable JS value and
perform its existing ToLength conversion before invoking the engine. Preserve
that original value after non-global/non-sticky `exec` and `test` and after
`search`, `split` and `matchAll`. Deleting `lastIndex` returns false.

- `exec(input, budget)` returns `Result<Option<Match>, Error>`; `test` returns a
  boolean with the same cursor semantics. `Match.captures` includes capture zero;
  unmatched captures are `None`. `groups`, `indices` and `index_groups` preserve
  named captures, unmatched ranges and presence metadata. Code Mode applies its
  blocked-member filtering when exposing named groups. Native match `input` is
  not exposed by the current TypeScript adapter.
- `string_match(input, budget)` returns an optional `StringMatch::Single(Match)`
  or `StringMatch::Global(Vec<Vec<u16>>)`. `match_all(input, budget)` materializes
  cloned-cursor matches and requires `g`. `search` returns an optional offset.
  `split(input, limit, budget)` returns optional UTF-16 strings, including
  unmatched delimiter captures; pass the interpreter's ToUint32 limit, or
  `u32::MAX` when omitted.
- `replace(input, replacement, budget)` and `replace_all` implement `$$`, `$&`,
  `$` followed by a backtick, `$'`, numeric captures and `$<name>`. `replace_all`
  requires `g`. For function replacers, call
  `replacement_matches(input, require_global, budget)` before invoking callbacks;
  derive arguments from each `Match` as captures, offset, input and optional
  groups. Apply the interpreter's existing synchronous result coercion, then use
  `replace_matches(input, matches, callback, budget)` to assemble the output.
  `substitution` is the replacement-template operation; `escape` implements
  `RegExp.escape` for string inputs. The interpreter rejects non-string escape
  arguments and non-pattern String arguments before calling these APIs.

Pass one shared `Budget { remaining: Option<u64>, cancelled:
Option<&dyn Fn() -> bool> }` through an operation. Matching, backtracking,
lookaround, class/string candidates, repeated searches and parser work consume
steps and check cancellation. `None` is unlimited; there is no default cap.
`Error::StepLimit` and `Error::Cancelled` propagate to the host's execution-limit
and cancellation boundary, not a catchable JavaScript regex error. `RequiresGlobal`
maps to the existing String-method diagnostic.

### Unicode and current parity gap

Unicode property data, strict property/value aliases, Script_Extensions and
`Basic_Emoji` strings come from `icu_properties` 2.3 with compiled data. Case
canonicalization uses mode-specific tables regenerated from the Bun/JSC oracle;
legacy matching excludes non-ASCII-to-ASCII folding and retains the host's case
equivalences rather than assuming String casing uses the same table. Unicode
matching uses scalar pairs while retaining UTF-16 offsets;
legacy matching consumes individual code units. The parser supports host-accepted
Annex-B escapes, lookaround, capture references, disjoint-alternative duplicate
names, modifier groups, `v` intersections/subtraction and class string
disjunctions.

The following host-supported `v` string properties have no approved dataset:
`Emoji_Keycap_Sequence`, `RGI_Emoji_Modifier_Sequence`, `RGI_Emoji_Flag_Sequence`,
`RGI_Emoji_Tag_Sequence`, `RGI_Emoji_ZWJ_Sequence`, `RGI_Emoji`. Construction returns
`Error::UnsupportedStringProperty(name)` rather than invented membership or a
fallback engine. The property dispatch in `src/regexp/class.rs` owns this boundary.
None of the 434 baseline corpus operations uses these six properties.

The explicit unlimited contract also applies to extreme nullable quantifiers.
For example, `(?:){1000000000000000}` matches an empty input in this engine;
the Bun/JSC oracle returns `null` for that example. The engine does not infer an
implicit threshold from the host's result. Use an explicit shared budget or
cancellation hook to bound matching work. This example is outside the baseline
104-group corpus.

### Oracle and checks

Run `bun rust/crates/core/src/regexp/generate.ts` from the repository root with
the existing Code Mode dependencies available. It executes the original
assertions for 104 selected groups, records 434 native intermediate operations,
and regenerates `src/regexp/corpus.json`, `tests/regexp_corpus.rs`,
`tests/regexp_oracle.rs`, `tests/regexp_case_oracle.rs` and `src/regexp/case_data.rs`.
Its synthetic clock is
fixed; it restores modified host intrinsics even on failure. The baseline maps
to 1 codemode, 5 callbacks, 5 parity, 24 stdlib, 8 RegExp Test262 and 61 String
RegExp Test262 groups. Four groups (callbacks:138, parity:858, stdlib:380,
regexp-math-test262:81) are interpreter-only validation/static-discovery checks
and emit no native engine operation; their original assertions still execute.
The String fixture excludes eleven string-only replaceAll groups.

Run engine tests with `cargo test --locked -p ycoding-core --test 'regexp*'` from
`rust`. Generated oracle tests retain native intermediate named groups; the
interpreter lane owns filtered result exposure and callback/runtime-error wiring.

## Configuration

`ycoding_core::resources::config` loads configuration without authentication,
provider execution, resource activation, or Session access. `Configuration::load`
takes `LoadOptions` with a Location directory, explicit `Roots`, a complete
environment map, project-discovery enablement, and optional file/content inputs.
Loading does not write configuration files or initialize runtime directories.
`reload()` replaces the complete entry/diagnostic snapshot after successful
discovery; a file-substitution failure retains the previous snapshot.

### Discovery and precedence

Entries retain their source and order rather than flattening documents into a
generic recursive merge. `values(key)` supplies defined fields from lowest to
highest priority for domain-specific consumers; `latest(key)` returns the last
defined whole field. An omitted field does not overwrite a lower-priority value.

1. Existing global `.claude` and `.agents` directories, then their upward sources
   from the Location toward the filesystem root, remain discovery entries only.
2. Global `ycoding.json`, then `ycoding.jsonc`, then the global directory entry.
   An existing global `.ycoding` directory follows with the same two filenames
   and its directory entry, so every persistent MCP target is a reload source.
3. The explicit file, followed by its file entry, including a missing file.
4. Upward `ycoding.json` and `ycoding.jsonc` documents and file entries, ordered
   from the filesystem root toward the Location. Discovery crosses Git boundaries.
5. Upward `.ycoding` directories, ordered from broader to narrower scope; each
   supplies `ycoding.json`, then `ycoding.jsonc`, then its directory entry.
6. Inline content, identified in diagnostics as `YCODING_CONFIG_CONTENT`.

Disable project discovery with `project: false`. A Location equal to the global
configuration directory also disables upward discovery. Both cases retain global
ecosystem sources and global/file/content inputs. `config.json` is not a source.
Missing, empty, or permission-denied files contribute no document; other read
failures propagate. Invalid JSONC contributes a diagnostic without discarding
valid documents from other sources.

### Substitution and validation

JSONC supports line/block comments and trailing commas. The native scanner uses
UTF-16 offsets and ordered diagnostics matching `jsonc-parser` 3.3.1. Filesystem
text reads match Effect's UTF-8 TextDecoder, including BOM removal and replacement
of malformed byte sequences before parsing or substitution. Domain JSON,
strings, keys, and named-entry order use Schema's lossless codec; no domain value
passes through `serde_json`. The scanner's MIT notice is in
`src/resources/config/JSONC-LICENSE.txt`.

`substitute` applies `{env:NAME}` before `{file:path}`. Missing environment names
become empty text; environment text is inserted without JSON escaping. File paths
are relative to their document or virtual source directory; `~/` uses the OS home,
not the test-home override. File contents receive ECMAScript whitespace trimming
and JSON-string escaping. File tokens on lines whose trimmed prefix begins with
`//` remain untouched. Missing-file handling is explicit (`Error` or `Empty`);
configuration loading uses `Error`.

`decode_document` validates every supported configuration section, normalizes
model selectors, and returns Schema `Diagnostic` values. Unknown keys are removed
individually; invalid named MCP/provider/command/reference entries are removed as
units; invalid optional agent fields and array items retain valid siblings.
Malformed permissions append deny rules after valid rules, and malformed
guardrails become `{ "enabled": true }`. These diagnostics carry `failClosed`.

Provider-level `providers.<id>.package` accepts exactly
`aisdk:@ai-sdk/openai-compatible` and `@ycoding-ai/ai/providers/runpod` as
declarative native route identities. The shared `config::ENDPOINT_PACKAGES`
definition drives endpoint writes, validation, catalog integration identity and
the process-extension guard. Other string packages, model-level packages,
`plugins`, `npm`, `plugin`, and singular `provider` declarations reject their
entire document with an actionable diagnostic. Executable JS/TS/npm provider
configuration is neither translated nor partially loaded. Other valid documents
remain available. Prototype names such as `__proto__` are ordinary lossless keys
subject to validation; configuration cannot acquire inherited settings through
JavaScript prototype mutation.

### Backend configuration mutations

`Configuration::write_provider(scope, input)` and `write_mcp(scope, name, config)`
select files from backend roots; callers cannot supply filenames. Global scope
uses `Roots.config`, and project scope uses the loaded Location directory.
Provider writes choose the first existing `ycoding.json` or `ycoding.jsonc`.
MCP writes choose the first regular file among `ycoding.json`, `ycoding.jsonc`,
`.ycoding/ycoding.json`, and `.ycoding/ycoding.jsonc`. Both create `ycoding.json`
when no candidate exists. Disabled project discovery rejects project writes.

Native JSONC edits retain unrelated keys, comments, BOMs, line endings and
existing formatting. Writes serialize by target and replace a synced temporary
file atomically. Provider writes reject implementation collisions and invalid
endpoint/model input, apply only supplied model fields, and retain explicit
false values. OpenAI endpoints select chat or Responses; Runpod Jobs endpoints
require `https://api.runpod.ai/v2/<ENDPOINT_ID>` and an Ollama or vLLM worker.
Duplicate model IDs, URL credentials and secret-bearing endpoint parameters
are invalid. Provider configuration accepts no credential key or profile.
MCP definitions persist their typed command, environment, headers, OAuth,
working directory, timeout and flags in `mcp.servers.<name>`.

Mutation authorization is explicit through
`Configuration::with_mutation_policy(MutationPolicy)`: configuration callbacks
receive the selected scope and target, and package callbacks receive the npm
selector. A plain `Configuration::load` denies mutations. Runtime production
grants global/project configuration writes and presentation-package installation
to its LOCAL_CLIENT-only operations. A project grant does not grant global scope.

Reload remains owned by the composition runtime. Each generation adds its
configured native endpoints to the authentication Draft through
`Draft::register_endpoints`; its existing registration handle retains those
API-key and configured environment methods. Credentials are connected separately.

### Frontend presentation packages

`resources::frontend_package::Service` validates registry package selectors and
requires installation-policy approval before touching the cache. It runs the
installed `npm` executable with scoped cache directories under
`Roots.cache/packages/<selector>`, preserves npm registry/auth configuration,
installs dependencies and bin links, and disables lifecycle scripts. This is
presentation-package installation, not process-extension or dynamic-provider
activation; Rust does not import or execute the TUI entrypoint.

The service retains the npm distribution archive, verifies its SHA-512 integrity,
and returns its lowercase SHA-256 digest with the exact package name/version,
absolute installed root, and root-relative TUI entrypoint plus its file digest.
It resolves `./tui` exports and wildcard/conditional targets, or a `tui`
file/directory entry when exports are absent. Assets are not enumerated.
Same-selector requests serialize across tasks and hold an installation file
lock; cached receipts bind the selector and archive digest, and reuse rechecks
distribution and installed-file integrity. Missing entrypoints, traversal,
archive links and escaping installed links fail. Archive processing is bounded
to 64 MiB compressed, 256 MiB expanded and 65,536 files; npm commands have a
120-second deadline and bounded output. Errors expose only closed codes, not npm
output or credentials.

Focused configuration and package checks run from `rust`:

```sh
cargo test --locked -p ycoding-core --test config_ops
cargo test --locked -p ycoding-core --lib resources::frontend_package::tests
```

### Runtime and development roots

`Roots::runtime(home, temp, env)` derives the `ycoding` data/config/cache/state
namespace from absolute XDG overrides or the standard home-relative defaults.
`YCODING_CONFIG_DIR` overrides the config root. `YCODING_TEST_HOME` changes only
ambient home discovery; OS-home substitution and XDG roots remain independent.
These explicit overrides retain their supplied path metadata, including relative
or empty values; relative filesystem access uses the process working directory.
Temporary files use `temp/ycoding`; logs and repositories use `data/log` and
`data/repos`; binaries use `cache/bin`.

`Roots::development(root)` constructs every root inside the explicit development
directory without consulting inherited environment values. Development discovery
stops at that directory. Location/explicit-file paths, configured roots, and file
substitutions are checked for lexical and existing-symlink escapes before reads
or initialization. This check assumes trusted ownership of the fixture filesystem;
it is not an OS sandbox against concurrent symlink replacement.

`Roots::initialize()` creates data/config/cache/state/temp/log/bin/repository
directories and sets Unix log-directory permissions to `0700`. The state root
is isolated with the other development roots; loading does not start a service
or mutate a registration.

### Boundary checks

Run `cargo test --locked -p ycoding-core --test 'config_*'` from `rust`.
`config_loading` covers real-file discovery, ordered merge inputs, snapshots,
substitution failures, and normal/development-root isolation. `config_validation`
covers supported sections, rejected units, model/numeric boundaries, fail-closed
security recovery, and obsolete executable rejection. `config_jsonc` checks
baseline parser diagnostic codes, ordering, and UTF-16 offsets.

Automatic watcher/event integration, policy application, resource activation,
provider/catalog resolution, and Session consumers belong to their owning runtime
boundaries; this configuration module performs no such operations.

## Repository resources

`resources::{agent,command,reference,skill,discovery,instruction_discovery}` operate
on explicit configuration entries and filesystem roots. They do not discover the
process home, assemble Session epochs, maintain Session skill activation, load MCP
skills, register extension transforms, or access project artifacts.

### Definitions and precedence

Agent and command registries preserve insertion order. Updating a name preserves
its identity; removing and reintroducing it appends a new entry. Agent selection
uses the configured selectable default, then `god`, then the first selectable
agent. Explicit selection retains an unknown ID rather than adopting a default.
Hidden agents, subagents, and `btw` are not foreground-selectable; hidden agents,
primary agents, and `btw` are not autocomplete-selectable.

`from_entries` consumes `Configuration.entries` in their existing order and reads
recursive `agent/**/*.md`, `agents/**/*.md`, `command/**/*.md`, and
`commands/**/*.md` from each YCoding directory. Files sort by UTF-16 path order,
include dotfiles, and follow symlinks without recursively revisiting an ancestor.
Agent IDs and command names are their paths below the domain directory without
`.md`. Empty command files define an empty template; empty agent files do not
define an agent. Bodies receive ECMAScript whitespace trimming.

Agent fields overlay only when specified. Request headers and body merge
shallowly; global permissions from every document precede agent-specific rules.
Filesystem permission resources expand `~` and `$HOME` against the supplied home;
shell resource text is unchanged. Disabled agents are removed. Locations record
every contributing absolute document or Markdown file once.

Commands replace their template and retain unspecified optional fields from
earlier source layers. Within one directory, the last file defining a name
supplies its complete frontmatter and location; its first occurrence determines
that directory's name ordering. JSON command locations accumulate across layers.

References replace equal aliases in place. Local paths are relative to their
document, or the Location for inline content; `~/` uses the supplied home. Remote
references resolve to the supplied repository-cache root. Invalid aliases,
references, and branches are diagnosed and omitted. Equal repository targets
with different branches retain only the first branch. Repository parsing accepts
GitHub shorthand, host/path, SCP, URL, and distinct local file references; branch
validation preserves the TypeScript character contract. `repository::root`
discovers the nearest `.git` or `.hg`, including worktree `.git` files, without
executing VCS commands. Repository cloning and refresh are cache-adapter work, not
definition discovery.

### Markdown and skills

The Markdown parser uses `yaml-rust2` events with js-yaml scalar, tag, merge-key,
alias, binary, timestamp, duplicate-key, and UTF-16 escape conversions. JSON
frontmatter is supported. Executable JavaScript/TypeScript frontmatter is rejected
with the configuration executable-rejection diagnostic, not evaluated.
Unquoted timestamp mapping keys are explicitly unsupported: js-yaml coerces them
through host-local `Date.toString`, including a localized time-zone label that the
native dependencies do not supply. Timestamp values remain supported. Unsupported
keys remain failures on repeated reads rather than becoming partial cache records.

Markdown parsing shares a process-wide content-keyed cache. The TypeScript
gray-matter partial-cache behavior is retained: a failed parse can leave an empty
data object and the original whole-file content in the cache. The sanitizer
retries unquoted top-level colon values as block scalars; a later read of the
identical original text can return its retained partial cache entry. Field
validation still rejects invalid defined fields as whole resources.

Skill sources deduplicate by source identity. Configuration supplies `.claude`
sources first, then `.agents`, then YCoding `skill` and `skills` directories, then
configured local/HTTP(S) sources. The ecosystem source order remains global,
nearest ancestor, then broader ancestors; YCoding directory order remains global,
broader ancestor, then nearer ancestor. Configured local paths are Location
relative, not document relative.

`skill::Service::list` re-reads root `*.md` and recursive `**/SKILL.md` on every
call. Only URL pulls are memoized. Root-file IDs use the filename; nested IDs use
the containing directory. Later equal IDs replace values without changing list
order. Frontmatter names default to the ID. Metadata flags accept booleans or
trimmed case-insensitive `true`/`false` strings. Conflict arrays trim and dedupe
nonempty strings and validate instruction keys; malformed declarations reject
the skill. `available` uses the last matching permission rule and excludes only
denied skills.

URL catalogs validate every name, relative file path, percent-decoded segment,
destination, and origin before fetching files. Cache namespaces are SHA-1 of the
slash-terminated source URL. Unversioned and unchanged-version catalogs retain
existing files and populate missing files. Version changes publish a complete
replacement only after every file succeeds, retaining the old cache on failure.
Pulls limit work to four skills and eight files per skill and retry transient HTTP
failures twice with jittered exponential backoff.
Versioned replacements buffer downloaded bytes before synchronous filesystem
publication, so cancellation cannot leave staging directories or detached download
workers. Peak memory can include four complete replacement skills; URL catalogs
have no declared byte-size limit.

Reference and skill instruction producers expose initial, changed, and removed
rendering without owning instruction state. Supply a locale comparator to
`summaries_by`; no host-default collation engine is assumed. Reference guidance
includes described references, including hidden ones. Skill guidance receives
permitted skills, includes described autoinvokable skills, and XML-escapes its
interpolated text. Additions/removals render deltas; metadata changes restate the
complete list.

### Ambient instructions and revision inputs

Ambient instructions contain the global `AGENTS.md`, then the current directory's
file, then ancestors through the canonical project root. Paths are canonicalized
and deduplicated. Project opt-out and Locations outside the canonical project
root retain only global discovery. Empty files remain available. A missing global
file is optional; an unreadable discovered project file, read race, or observation
failure produces `Unavailable`. Pass the previous value to `Observation::value`
to retain it; without a previous value the observation stays unavailable. Removing
every source produces `Removed`, not `Unavailable`.

Rendering includes each source path. Files over the default 50 KiB inline limit,
or the supplied byte limit, produce a UTF-8 byte count, SHA-256 digest, and retrieval
notice without exposing partial content. Discovery does not own durable
instruction values or epochs.

`WatchInputs` derives deduplicated YCoding directory and standalone config-file
targets, excluding ecosystem directories. Matching changes advance a plain
revision. Skill source-directory changes advance its plain revision; URL and
embedded sources do not match filesystem signals. Runtime composition owns OS
watchers and event forwarding.

### Well-known configuration

`discovery::wellknown::Service` takes an explicit Store Client and environment.
It reads manifests from `/.well-known/ycoding`, resolves embedded configuration
before remote configuration, and substitutes explicit variables before the
supplied environment in remote URLs and headers. Remote bodies may contain a
nested configuration object. Executable plugin/provider declarations reject with
the same actionable diagnostic as configuration loading.

Sources persist in one `wellknown:sources` KV value. Adding requires an
authentication method, normalizes trailing slashes, and deduplicates sources.
Entries cache by origin; refresh fetches all manifests before replacing the
snapshot and advances a revision only on a semantic change. Failed refreshes
retain the previous snapshot. Removal updates storage and the cache before
signaling its revision. Mutation methods require exclusive service access, and
storage failure does not publish a successful in-memory mutation. This service
does not execute authentication commands or register plugins.

### Resource checks

Run the focused resource checks from `rust`:

```sh
cargo test --locked -p ycoding-core --test 'discovery_*' --test 'skill_*' --test 'agent_*' --test 'command_*' --test 'reference_*' --test 'instruction_*'
```

`discovery_frontmatter` reads literal first/repeat gray-matter results. Regenerate
the corpus with `YCODING_ORACLE_REPO` pointing at an installed TypeScript runtime
checkout and `bun crates/core/src/resources/discovery/generate-frontmatter.mjs`
from `rust`; the generator reads committed `main` test sources rather than a
checkout's working files. Tests use temporary homes/projects, real filesystem
reads, and isolated loopback HTTP/Store fixtures.

## Tool authority

`tools::policy` exposes permission decisions, deny-only child ceilings, helper
selection, and Location-owned Form/question request-reply services.
`process::guardrails` owns standard/custom classification, root-Session-family
review state, durable directory approvals, counters, and approval snapshots. These APIs
authorize work; they do not materialize tools or execute shell, filesystem, Git,
browser, or desktop effects.

### Permissions and captured inputs

`Authority` reads projected Sessions through `ycoding-store::Client`. Its agent
resolver supplies the selected agent's permissions, including default-primary
resolution when the Session omits an agent; an unresolved agent denies every
action. Resolve configuration with `resources::config` and apply
`expand_permissions` before supplying agent rules. Only `read`, `edit`, and
`external_directory` resources expand `~`, `~/`, `$HOME`, and `$HOME/` or
`$HOME\`; shell resources and wildcard action names remain raw.

Rules use the existing UTF-16 ECMAScript RegExp engine: normalize backslashes,
match `*` and `?` across separators, and let a trailing ` *` match an absent
argument suffix. The last matching rule wins; unmatched resources ask. A
configured deny takes precedence over project-saved allows. Multiple resources
deny if any denies, ask if any asks, and otherwise allow; an empty resource list
allows. `ceiling::inherit` retains every distinct existing/caller deny and drops
allow/ask rules. `ceiling::read` rejects malformed stored rules as an empty
ceiling.

`permissions::Permissions` exposes `evaluate_effective`, `ask`, `assert`, pending
reads, replies, agent-switch cancellation, and shutdown. `ask` retains an asked
request after its returned admission is dropped; cancelling `assert` removes
its request. Rejecting one permission declines every other pending request in
that Session. Always saves only the request's explicit save resources and
settles other pending requests only when their current configured policy and
saved rules allow every resource. `SavedPermissions` uses the real
`PermissionTable`, its project foreign key, and its unique
project/action/resource index; duplicate additions are no-ops. Storage errors,
including uncertain commit results, propagate without automatic replay.

### Guardrails and autonomy

Supply `Settings` with resolved Location/project/home/temporary paths, normalized
global roots, limits, and a fresh custom-layer loader ordered from nearest
repository scope to user scope. `Guardrails` discovers Git from the Location's
`paths.workdir` and reads its worktree list for each outside-target evaluation.
The main checkout and every Git-listed linked checkout count as inside when the
target's canonical path is within the checkout and the checkout shares the
Location repository's canonical common directory. Missing descendants resolve
through their existing directory ancestor; symlink escapes, non-directory
ancestors, unrelated repositories, unavailable Git, and non-Git Locations gain
no checkout exemption. Metadata workdirs do not change repository identity.
Invoke the custom-layer loader for each evaluation; rule changes preserve existing family state but
must be re-evaluated before Always reuse. The global roots are YCoding's config, data, cache, state,
temporary, bin, log, and repository directories. Custom matching uses numeric
priority followed by original rule order; the first matching source layer wins.
Invalid custom files ask for mutations but not read-only actions. A standard
catastrophic deny cannot be weakened; an effective custom deny precedes hard
review, and standard/custom hard review precedes ordinary custom allow.

- Permissions auto-approve ask at YOLO 1–3 or with an active goal.
- Forms/questions auto-answer at YOLO 2–3 or with an active goal.
- Ordinary guardrail reviews auto-approve only at the root Session's YOLO 1–3;
  an active goal alone does not grant review approval.
- Hard project/ancestor deletion, direct home-child deletion, destructive Git,
  force push, and destructive database statements require a fresh once/reject
  reply. Always becomes reject for a hard review. Disabling ordinary guardrails,
  custom allows, goals, YOLO, and outside-directory exemptions do not weaken it.
- A trusted leaf may set `Input.skip_review` for browser/computer operations;
  this admits ordinary/hard reviews but never a deny. Do not derive it from
  untrusted request metadata.

`resources::agent::empty` allows `worktree` through its wildcard default while
asking for external-directory access. Agent services receive their initial
catalog from the caller; Core supplies no built-in `god`/`btw` catalog or
specialized `btw` permission defaults.

The outside-repository exemption applies only to the standard ordinary outside
review. YCoding global roots include descendants. An effective
`external_directory = allow` also exempts a target, using the directory itself
for workdir/cd targets and the containing directory for file targets, followed
by `/*`. Ask/deny do not exempt. Shell classification retains every reachable
workdir after successful/failed `cd`; any remaining non-exempt outside target
keeps the command reviewed. Temporary deletion operands are removed from
semantic evidence only when temporary in every reachable workdir. Proven
read-only shell inspections need no standard review; custom denies still apply.
The recognized readers include `cd`, `exit`, `ps`, `pgrep`, and `lsof`, and each
read-only segment of a compound command contributes no target, including its
workdir; a segment with a non-`/dev/null` redirection or substitution is not
read-only. Shell targets include every operand and every redirection target,
spaced or unspaced (`>file`, `2>>file`, `&>file`); `>&N`/`<&N` duplications,
heredoc delimiters, URLs, `echo`/`printf` arguments, the first non-option
argument (the executed script) of `sh`, `bash`, `zsh`, `node`, `bun`, `deno`,
`python`, `python3`, `ruby`, and `perl`, `git commit|tag|merge|stash|notes`
message values, `gh` title/body/notes/subject values, and the `gh api` endpoint
are not targets. A heredoc body is skipped only when `cat`, `tee`, `git`, `gh`,
`node`, `bun`, `deno`, `python`, `python3`, `ruby`, or `perl` consumes it on an
unpiped line, its closing delimiter is present, and the body is quoted or
contains no `$(` or backtick; otherwise, including shell-fed heredocs, its lines
are classified as commands. Non-file actions (`subagent`, `mcp_execute`,
`project_artifact_mutation`) have no outside targets, so YCoding-managed
operations on global-root resources need no ordinary review while custom rules,
invalid configuration, denies, and counters still apply.

Ordinary outside-repository Always records the reviewed request's outside
directories that no other exemption covered (a directory target itself,
otherwise its parent) as one durable `session.guardrail.approved` event on the
root Session through the Session projector, which folds it as a no-op. Later
evaluations in that root family read these events from the Store, so approvals
survive restarts and apply to every service sharing the database; a target is
exempt when it lies at or under an approved directory. Approvals are checked
only after fresh classification still yields the standard ordinary outside
review, so they never settle a hard review or a custom-rule review. Always for a
review with no outside directories approves only that attempt. A failed approval
write declines the waiting operation and returns the Store error. Replies from
another family or Location instance cannot settle a request. Shell/subagent/review counters are
family-scoped, default to 8/8/16, and reserve before admission; reservations
release once explicitly or when their last owner drops. Dropping a pending
guardrail wait removes its request and releases review capacity. A shell
admitted while the family is at `Limits.shells`, directly or after an approved
review, waits first come first served for a released slot for
`Limits.shell_wait` (default 60 s, configured as `guardrails.shell_wait_seconds`);
`assert` returns an `Allow` admission with only a `wait`, and the wait timer
requires a Tokio runtime. A released slot passes directly to the oldest live
waiter; dropping the wait abandons the queue position, and a slot granted to a
dropped wait is released. Expiry fails with `Error::CapExceeded` carrying the
running holders (`Input.holder`, the tool call ID from `LeafPolicy`) and the
waited milliseconds. Subagent and review caps fail immediately.
`Error::capacity_message` renders the limit, holders, wait, and the setting to
raise; the shell tool returns it unchanged while other guardrail rejections keep
the shell-command message. `LeafPolicy::admit` returns the typed guardrail
error for callers that render it. `shutdown` declines queued waits.

Snapshots hash canonical status, pending requests, and sorted approved
directories with SHA-256. Their sequence records every state transition independently of the
digest; an add/remove ABA transition can restore the digest while advancing the
sequence. `with_snapshot` runs a synchronous bounded callback under the state
fence. Do not reenter the service from this callback or from its synchronous
event publisher. Publishers must queue/record Schema events without performing
tool effects or waiting for a user reply. The owning Location calls `shutdown`
to settle pending requests; durable approvals remain.

### Forms, questions, and helpers

Forms validate duplicate keys, earlier typed conditions, closed options,
cascading inactivity, required values, UTF-16 string lengths/patterns/formats,
finite numbers, integers, selection bounds, and external acknowledgements.
Automatic answers use validated defaults/options/bounds/placeholders; impossible
required fields stay pending. Calendar `date` rejects rollover; `date-time`
accepts JSC-observed ISO/legacy date syntax with day 1–31 normalization and the
ECMAScript time range. URI validation uses absolute WHATWG URLs after USVString
conversion. Production validation does not invoke JavaScript. Literal Bun
acceptance vectors in `form_formats` pin calendar rollover, clocks, offsets,
delimiters, comments, NUL termination, and expanded years.

Created forms remain pending indefinitely; answered/cancelled forms remain
queryable for ten minutes. `with_clock` supplies deterministic retention time
without sleeps. Interruption or an enclosing timeout cancels a Form wait and
removes a question wait. Reply publication failures retain pending state;
creation publication failures remove the new request. Questions return the first
nonempty first-option label or the established automatic-answer text; human
answers retain the Schema answer-array contract. The tool invocation owner must
assert the question permission before requesting its Form/question interaction.

Helper settings consume the latest validated efficiency document, including the
`title`, `goal`, `decision`, `prediction`, `prompt`, and `compaction` helper
models. Agent model selection precedes ordinary role selection and Session inheritance; an explicit
main/subagent compaction model precedes an agent model. Resolver failures remain
best effort. Local titles strip terminal controls and Markdown prefixes,
collapse whitespace, select the first nonempty line, and truncate to 50 Unicode
characters without a provider call.

Run authority checks from `rust` with
`cargo test --locked -p ycoding-core --test 'policy_*' --test 'guardrail_*' --test 'form_*'`.
The tests use real store-backed authority and synthetic Sessions. Event
publication, agent resource discovery, custom Markdown source discovery/reload,
managed-worktree discovery, actual leaf effects, and runtime wiring are caller
boundaries; the component tests do not certify those full-runtime flows.

## Next-message prediction and prompt generation

`session::prediction::Service` and `session::prompt_generator::Service` answer
`Option<String>`: `None` is the wire `unavailable`. Both are built from
`helper_generation::Dependencies` (Session store, agent catalog, `Generate`
model boundary, memory service, permissions, event feed, serving Location);
prediction also takes the autonomy service. `runner::Local` implements
`Generate`: it resolves the helper model (agent model, then
`efficiency.helper_models.prediction` or `.prompt`, then the Session model, then
the default selection), streams one request without tools, and records a
`session.provider.request.recorded` ledger row under source `prediction` or
`prompt`, including a cancelled request. Ledger ordinals are assigned under a
process-wide lock immediately before the row is published, so concurrent helper
requests for one Session cannot collide.

The hidden primary `prediction` and `prompt` agents come from the host agent
catalog; `prediction::agent()` and `prompt_generator::agent()` define them with
the shipped system prompts and a deny-all permission set. A missing agent or an
unresolvable model (`Generate::resolves`) answers unavailable before any memory
permission check or search.

- Prediction requires a root Session at the serving Location with no active
  goal, no pending input or compaction, and a latest completed, error-free
  assistant reply that follows the latest user message. It sends the last 2,000
  user and 4,000 assistant UTF-16 units, an optional trimmed hint (at most 2,000
  units), and memory snippets. Output is accepted only as one line of 2–40 words
  and at most 400 UTF-16 units, without labels, refusals, error text, control or
  bidirectional characters, or a copy of the previous user text. An accepted
  suggestion is published as ephemeral `session.prediction.updated` after the
  Session's latest reply, user message, agent, and model are confirmed
  unchanged.
- Prompt generation accepts any Session at the serving Location with a nonblank
  intent. It sends the mode, the trimmed intent, the same bounded recent text
  when present, and memory snippets. Output is at most 8,000 units, loses one
  wrapping code fence and one wrapping quote pair, and is rejected when empty,
  refusal-like, or containing control or bidirectional characters. Nothing is
  published or admitted.
- A newer request for a Session cancels that Session's earlier request, which
  answers unavailable. Prediction is also cancelled by input admission,
  execution start, movement, deletion, archival, and agent or model selection;
  prompt generation only by movement, deletion, and archival. Provider failures
  and non-`stop` finishes answer unavailable.
- A selected memory scope contributes at most three hits (title at most 200 and
  snippet at most 600 units) only when the acting agent's effective
  `memory_read` is `allow` or `ask`. A disabled, unavailable, or non-Git
  repository scope contributes nothing.

The runtime serves `session.prediction` and `session.promptGenerate` through
`Configuration::helpers`, a per-Location provider of the `Generate` boundary and
memory service. A Location without a provider, and a Session whose helper model
does not resolve, answer the typed `unavailable` result rather than an error;
the Session must exist, and a blank prompt intent is an invalid request.

### Production runtime composition

`ycoding_runtime::Core::production(client, Production)` is the application
composition boundary. `Production` supplies native configuration `LoadOptions`,
models.dev source/cache options, the installed ripgrep path, an optional Cursor
identity and transport runtime, and an optional goal-model `autonomy::Steer`.
The launcher owns path/environment selection, the Store, listening sockets,
authentication, process identity, and shutdown. Core re-exports `ycoding_ai` so
the runtime can name provider inputs through Core without a direct AI dependency.

Each canonical directory/workspace key loads its own configuration and creates
the built-in agent catalog described below, configured model
resolver, tool registry, memory, permissions, guardrails, snapshots, and local
runner. Credentials and provider HTTP execution are shared across Location sets.
Production guardrails use physical Location, Project, home, and managed-root
paths so filesystem targets share their path coordinates; stored Location
identity remains unchanged.
The runner applies selected-agent request headers as HTTP overlays, lowers
generation options (including temperature, seed, and stop) through `llm::Generation`,
and overlays remaining body fields while preserving unrelated model defaults.
Invalid headers and generation option types fail before a Step starts.
The registered direct leaves are read, write, edit, patch, glob, grep, shell,
webfetch, websearch, worktree, memory, and project_artifact. The shell opens on
first execution and uses `Execution::job_shells()` rather than separate Jobs.
Built-in and ambient instruction sources and compaction/helper settings feed
the runner. Prediction and prompt generation use that runner through
`Configuration::helpers`; usage operations use the serving Location's catalog
to price ledger records whose costs are absent.

`LocationServices` leases a cached `ServiceSet`. Wire requests and process-global
Session execution use the same map; an active lease pins the set. The idle
deadline starts when the last lease is released, and maintenance evicts expired
sets after 60 idle minutes. A rebuilt set rereads configuration. Retention runs
at startup and one hour after each completed sweep, loading global-only
configuration and consulting `Execution::active()` before deleting families.
`Core::shutdown()` stops and joins maintenance and closes credential refreshes;
the launcher must stop request intake and Session execution before calling it.

`Production::steer` overrides goal continuation; when omitted, production binds
`goal::Service` to the Location's agents and real runner. It does not install
Session/control/MCP tool consumers, extension hosts, filesystem watches, live
catalog discovery/reconciliation, or provider-quota refresh orchestration.
The supplied Cursor transport receives a Location-owned encoded request context.

Run `cargo test --locked -p ycoding-core --test session_prediction --test session_prompt_generator`
from `rust`; the runtime wire behavior runs with
`cargo test --locked -p ycoding-runtime --test helpers`. The production flow runs
with `cargo test --locked -p ycoding-runtime --test production`; it builds Core
from temporary on-disk configuration, serves helper and usage operations, and
drives the real runner against a local scripted OpenAI-compatible server and a
real memory service. These tests do not script a
mid-stream usage report, so partial usage before cancellation is not covered
and no memory search query is observed beyond the returned snippets.

## Remote device identity

`remote::Device::new(state)` owns the backend's remote device identity at `<state>/remote-device.json` (`remote::FILE`), the location and JSON shape the TypeScript CLI uses (`packages/cli/src/remote-credentials.ts:29–49`): `deviceID`, `name`, `relayURL`, `publicKey` and `privateKey` P-256 JWKs, optional `refreshToken` and `refreshExpiresAt`, and `enrolledAt`. Reads ignore unknown fields; writes emit only those fields.

Reads refuse a symbolic link, a non-regular file, a file larger than 64 KiB, and on Unix a file with any group or other mode bit or owned by another user; the file opens with `O_NOFOLLOW` and the opened handle is checked again. Writes refuse a symbolic-link destination, create a `0600` temporary file beside it and rename it into place. First enrollment refuses an existing destination. One writer lock serializes enrollment and credential rotation.

`enroll` validates the `https` origin (`http` only for `localhost`, `127.0.0.1` or `[::1]`) and the `XXXX-XXXX-XXXX-XXXX-XXXX` code, reads the existing identity, uses the trimmed name or the machine host name, generates a P-256 key, and posts `{ enrollmentID, code, name, publicKey }` to `/api/devices/enroll`. Relay 401, 403, 410 and other 4xx responses are `RelayRejected`; transport failures, timeouts, 408, 429, 5xx and malformed success bodies are `RelayUnavailable`. `access` refreshes through `/api/devices/refresh` while the stored refresh credential is unexpired and otherwise signs `ycoding-device-v1\n<challengeID>\n<nonce>` as a raw 64-byte ECDSA P-256 SHA-256 signature for `/api/devices/challenge` and `/api/devices/token`, then stores the rotated refresh credential. Relay 401, 403 or 410 returns `Revoked` and marks that device revoked in memory, so `summary` reports `Revoked` until another device is enrolled. Every relay call disables redirects, never sends credentials in the URL, reads at most 64 KiB and completes within 30 seconds.

`summary` is the redacted view: device ID, name, origin, enrollment time, credential state (`NotAuthenticated` without a refresh credential, `Valid`, `Expired` at or after the refresh expiry, `Revoked`) and the refresh expiry. Results, errors and log events never contain the enrollment code, keys, tokens or relay response bodies.

## Credentials and authentication

`resources::credential::Service` operates on an explicitly supplied redb Client
whose catalog includes `ycoding_store::resources::TABLES`. It does not discover
credentials in another database, initialize global roots, or write Session state.
Use `resources::config::Roots` when composing runtime or development storage.

Profiles belong to one integration. Creation reuses the matching integration and
label, preserves siblings, and activates the written profile. Value changes
advance both credential and account generations; reconnecting an existing label
advances its account generation even when the value is unchanged. Label changes
and activation preserve account identity. Removing an active profile activates
the newest remaining profile, but an explicit account binding never adopts that
replacement. Duplicate labels, deletion, or account replacement make a binding
unavailable until explicit reselection.

Refreshes coalesce by credential identity and both generations while different
profiles progress independently. A refresh commits only against its expected
generations and preserves the account generation. Another process's newer token
can be adopted only for the same integration, account, OAuth method, and an expiry
more than five minutes ahead. Retain the service and call `shutdown().await` to
cancel and join its refresh workers; dropping a refresh waiter does not cancel the exchange.
An unknown outcome fences that expected snapshot instead of repeating the
exchange. Storage commit uncertainty propagates as an unknown outcome.

`resources::auth::Client` supplies API-key storage, OpenAI ChatGPT browser and
headless exchanges, GitHub Copilot device polling, xAI browser and device
exchanges, and Cursor PKCE browser polling and OAuth refresh. Construct production
endpoints with `Client::provider`; explicit endpoints support isolated fixture
servers. Token requests disable redirects and HTTP retries. Provider payloads,
URLs, tokens, account metadata, and underlying network/storage errors are excluded
from authentication diagnostics. Credential, binding, client, and attempt Debug
output is redacted.

`DeviceAttempt::poll(now)` exposes deterministic next-poll timestamps. Copilot,
OpenAI, and xAI preserve their provider-specific polling cadence, including the
three-second safety margin and slow-down rules. `enroll_device` starts owned
background polling and stores its result as the requested profile. Retain its
`Enrollment`, inspect its status, and join it with `wait`; `cancel` interrupts
pending work, while persistence is not cancellable. Dropping the handle interrupts
its worker and does not authorize replay.

`start_browser` owns the loopback callback listener; its `wait` validates callback
state, exchanges the code once, and closes the listener. OpenAI uses localhost
port 1455 and xAI uses 127.0.0.1 port 56121; explicit ports support fixtures. xAI
callback preflights retain its exact allowed origins. Callback responses render
self-contained branded success/error pages; `auth::page` also supplies the
fragment-relay bootstrap page. Provider input is HTML-escaped, inline script values
escape `<`, and callback diagnostics exclude raw provider error payloads.
`ManualAttempt` accepts a selected
method's one-shot callback, requires a code without closing the pending attempt,
checks integration ownership, and persists at most once. Unknown exchange outcomes
remain terminal and require reconciliation rather than automatic retry.

Call `Client::prepare` before building an AI request. It re-reads the credential,
rejects a replaced or deleted account, and refreshes supported OAuth methods at
the five-minute expiry boundary before supplying the resolved value to the
synchronous `ycoding_ai::auth` request boundary. Copilot tokens are not refreshed.

`Client::prepare_value` additionally resolves managed Claude sources and Cursor
API keys before the synchronous AI auth boundary. It revalidates account identity
after asynchronous token resolution and never replaces the stored managed-source
sentinel or raw Cursor API key with a transient bearer token.

`auth::claude` owns UUID-only managed profile directories, NFC-normalized SHA-256
Keychain service identities, isolated Claude CLI enrollment, and selected-source
token refresh. Supply explicit roots and environment maps. `Source::system` uses
`/usr/bin/security` on macOS with two-second deadlines; updates send hex-encoded
credential blobs through stdin, not process arguments. An injectable `Keychain`
supports isolated fixtures. Missing Keychain items fall back only to the same
profile's file; malformed or failed Keychain reads do not adopt another source.
File reads/writes reject profile and credential symlinks, preserve unrelated blob
fields, and write `0600` permissions. Enrollment uses `0700` directories, filters
provider environment overrides, validates the Claude authorization URL, caps CLI
output at 16,384 UTF-16 units, and expires after two minutes. Its submission handle
can provide a code while the owned completion worker runs. `Store::implementation`
connects this enrollment to the registry. Tokens cache for 30 seconds with a
one-minute freshness buffer. Refresh reconciles newer same-source tokens before
overwriting; uncertain exchanges remain fenced. Retain each Store and join
`shutdown()` to release refresh workers.

`auth::cursor::Store` prefers explicit access tokens, passes already-issued bearer
tokens through, and exchanges only `crsr_` keys. Its shared cache coalesces concurrent
waiters, refreshes at the five-minute buffer, and exchanges again only after a
known refresh rejection. An uncertain refresh/exchange cannot be replayed.

`auth::cursor::register` adds the `cursor` integration to a registry draft: the
remote `browser` OAuth method (PKCE login through `Client::start_cursor`, polled
until the tokens arrive, with the access-token JWT expiry stored or `0` when the
token is opaque), a `Cursor API key (crsr_…)` key method, and a `CURSOR_API_KEY`
environment method. Its OAuth refresh posts the stored refresh token to
`/auth/token` and persists the rotated pair.

`auth::google` discovers an explicit ADC path before the platform's well-known
gcloud file, then selects metadata credentials when neither path exists. Explicit
file failures do not fall through to another account. Authorized-user credentials
use their refresh token; service accounts sign one-hour cloud-platform JWTs with
RS256 before token exchange. Metadata reads require `Metadata-Flavor: Google`.
`Store::prepare` refreshes/coalesces access tokens before constructing synchronous
AI bearer auth. ADC shapes other than authorized-user, service-account, and metadata
credentials are rejected; vendor-specific ADC extensions are not supplied.

`auth::opencode::Console` implements device polling, custom server normalization,
concurrent user/org enrichment, and metadata-preserving refresh. Organization
selection compares names first and IDs on ties using the compiled ICU4X root
collation, matching Bun's default `en-US` `localeCompare` ordering.

`auth::integration::Registry` rebuilds ordered scoped transforms, preserves method
identity, and restores previous registrations on disposal. Stored active profiles
sort before other newest-first profiles; environment connections follow declared
method/name order and exclude empty values. Connection changes publish only
integration identity after successful storage, followed by `Updated`. OAuth and
command attempt lookup enforces namespace and integration ownership. Attempts
expire after ten minutes unless authorization supplies an expiry; a 30-second
scrubber retains terminal states for one minute. Persisting attempts cannot be
cancelled. Command output becomes a stored key only on successful nonempty exit;
raw command diagnostics are not exposed. Registry list ordering requires an
explicit locale comparator through `list_by`. Retain the Registry and join
`shutdown()` to cancel pending work and finish admitted persistence.

`credential::Service::resolve_session` consumes durable Session model/profile
bindings without rotating to an active sibling. `publish_binding` validates the
selected account, appends `session.profile.bound`, and updates its projection in
one transaction. Explicit reselection is required after account replacement.

`auth::bedrock` supplies the AWS default credential chain at Core provider
resolution, mirroring the TypeScript `fromNodeProviderChain` order: static
environment credentials, SSO (cached token plus `GetRoleCredentials`),
shared-files profiles (`AWS_PROFILE`, static keys, `credential_process`,
`source_profile` role assumption, `credential_source`), web identity
(`AssumeRoleWithWebIdentity` through STS), ECS container credentials, then
IMDSv2 with an IMDSv1 fallback. Unreachable metadata endpoints resolve to
nothing; explicitly selected but malformed credentials fail resolution.
`bedrock::region` prefers the `region` setting, then `AWS_REGION`, then the
`bedrock-runtime.<region>.amazonaws.com` endpoint host, defaulting to
`us-east-1`. Bedrock route resolution keeps an explicit key or
`AWS_BEARER_TOKEN_BEDROCK` as bearer auth, otherwise signs with SigV4, and
otherwise keeps no auth. SSO token refresh is not implemented: an expired or
missing token cache fails resolution instead of starting an interactive grant.

Run the focused credential and loopback authentication checks from `rust`:

```sh
cargo test --locked -p ycoding-core --test 'credential_*' --test 'auth_*' --test 'integration_*' --test bedrock_credentials
```

## Provider catalogs and model resolution

`resources::catalog::models_dev` decodes models.dev snapshots through Schema's
lossless JSON representation. Normalization retains provider environment names,
model API identities, capabilities, cost tiers, experimental modes, reasoning
variants, the Daybreak alias, and DeepSeek fallback/dated entries. Costs default
missing cache prices to zero; quota telemetry uses a separate absent-value rule.

Supply `Options` with explicit source, cache path, optional file/bundled snapshot,
fetch enablement, and User-Agent. `cache_path` derives the standard or source-hashed
filename. `Service::get` chooses disk, bundle, then permitted HTTP population and
memoizes the snapshot. `refresh` checks the five-minute disk TTL under a
cross-process file lock, validates before atomic replacement, retains the previous
snapshot on failure, and publishes a watch revision after successful replacement.
Refresh invalidates the memoized load, preserving explicit-file precedence.
Transport failures and HTTP 408/429/500/502/503/504 receive two retries with
200ms exponential, 0.8–1.2 jittered delays inside one ten-second fetch deadline.
Invalid managed cache files are removed; explicit input files are retained.
`cleanup_error` exposes a failed nonrecursive cleanup without blocking a bundled
snapshot or deleting a directory.
`Arc<Service>::start` owns immediate/hourly background refresh; retain its worker,
inspect `last_error`, and join `shutdown` when disposing the resource.

`Catalog::from_config` applies ordered configuration documents without network
discovery. `Catalog::compose` additionally reads configured OpenAI `/models`
inventories, supplies safe provider-only diagnostics on failure, inherits known
catalog capabilities/pricing, and applies explicit configuration last. Managed
discovery rejects URL credentials, non-HTTPS/non-loopback targets, and redirects.
Account inventories are fenced by credential account generation. Provider/model/
variant overlays merge recursively; arrays replace and header names merge
case-insensitively. Disabled/denied providers, unavailable profiles, model defaults,
release ordering, and small-model selection remain catalog-owned.

Muse (Meta) uses `auth::muse::register` (or `builtin` with a version) for remote-capable Meta device login, direct Meta Model API keys and `META_API_KEY`. Device polling starts immediately, respects pending/slow-down intervals and stops at authorization expiry. Optional refresh tokens are stored without enabling a refresh grant; missing expiry is zero (unknown). `resources::muse::Service::reconcile` discovers credential-specific `/muse-code/models` inventories and republishes them through Catalog account-generation fences. Retain the service, call `refresh` on connection updates and `reconcile` on sixty-second boundaries to preserve same-account inventory on transient discovery failures; failed reconciliation does not settle its hashed source fingerprint. `Catalog::compose_with_accounts` retains the Muse owner across reconciliation, and an unconnected provider has no models.

Muse catalog rows require integer context/output limits and text output, and exclude hidden or explicitly non-tool models. Names, families, release dates, modalities and supported effort variants are preserved; sampling metadata and prices are not invented. The Session runner routes Muse through `resources::muse::from_catalog_model` with its stored connection, preserving profile-bound minting, Responses reasoning metadata and full encrypted replay. Direct-key resolution is also available through `model::from_catalog_model`.

Create one `model::Resolver` per Location with its composed catalog. Resolution
returns the selected catalog identity and projected model; `from_catalog_model`
constructs supported native AI routes with the distinct provider API model ID.
It neither assembles Session requests nor refreshes quotas. Unsupported packages,
invalid route settings, missing models, unavailable profiles, and missing variants
return typed errors. `account_identity` hashes non-secret account identity using
the TypeScript field order; resolved-model Debug output is redacted.

`model::quota::Service` performs separate best-effort HTTP reads with supplied
credential storage and endpoints. Selected authentication preparation can refresh
credentials through their owner; quota reads do not write Session state.
Same-account refreshes coalesce; failures return safe status/message snapshots,
and cached values remain available as stale data. Account replacement invalidates
a refresh result. Unknown values remain absent and reported zero remains zero;
provider source/stability labels survive normalization. Retain the service and
join `shutdown` to dispose its workers. Pure normalizers cover Claude, Codex,
Copilot quota lanes, Cursor, OpenRouter, OpenCode Go, Grok, Z.ai, and OpenAI/Meta
organization buckets.

Muse quota observations use `source: response_stream`, `stability: observed`, percent windows and millisecond reset times. The usage adapter reads normalized observations only, isolates profiles by account identity, and returns `Quota is reported after the next Muse response` when no quota has arrived. Refresh performs no Muse network request or credential write. Account replacement invalidates the displayed observation; unknown percentages and reset times remain absent.

`with_version` supplies provider client-version headers. `with_configuration`
reads the latest `provider_usage.codex_app_server` configuration and starts its
trusted command only during an explicit usage-list read. The child receives
`initialize`, `initialized`, and `account/rateLimits/read`, without a shell.
Requests have a clamped 100–30,000ms timeout and a one-MiB UTF-16 response-buffer
bound. Unknown notifications and malformed unrelated lines do not settle a call.
Success, RPC failure, timeout, and dropped ownership dispose the child and stderr
reader; process diagnostics exclude command arguments and response payloads.

Copilot reads retain personal quotas, normalize limited-user aliases, and merge
only matching organization AI-credit billing. Organization discovery is optional
and cached per account generation; required user-status errors and invalid measured
billing amounts remain failures. `with_store` adds read-only daily local-spend
snapshots from `session_provider_request`, without a Session runner dependency.
Local day boundaries follow the OS timezone, including DST transitions. Unknown,
negative, and nonfinite costs contribute no total; a reported zero remains zero.
Store reads run off the async runtime workers. `auxiliary_errors` exposes optional
app-server or local-spend failures while the rest of the usage list remains usable.

These resources do not execute npm/JS provider packages. `ProviderContext` owns
Google ADC/AWS resolution and prepared native model construction; authentication
preparation resolves managed Claude sources and Cursor API-key exchanges.
Calendar parsing covers ISO, numeric, English month-name/RFC, and local-time forms,
with Bun-pinned vectors for
UTC, America/New_York, and Asia/Bangkok. Local conversion uses Chrono and the OS
timezone database, not a bundled IANA database. UTC date arithmetic retains the
JavaScript time-clip boundary; local dates outside Chrono's representable calendar
range are unavailable. The subprocess owner uses Tokio's forced termination rather
than Node's SIGTERM/500ms close behavior. Runtime composition owns integration/policy
changes and forwarding watch revisions into the event runtime.

Run focused catalog/model/quota checks from `rust`:

```sh
cargo test --locked -p ycoding-core --test 'catalog_*' --test 'model_*' --test 'quota_*'
```

### Provider account composition

Keep one `ProviderContext`, `auth::Preparation`, shared Claude source Store,
shared Cursor auth Store, `catalog::AccountCatalog`, and `Arc<model::Resolver>`
for the owning Location. Cloning the context shares ADC and Cursor runtime
ownership. The Cursor auth Store exchanges `crsr_` keys; Cursor inference
runtimes are separate and keyed by credential/account generation or exact
unmanaged authentication identity.

Share the source/auth Stores across Location owners that use the same backend
profiles. Independent Claude Stores have independent refresh deduplication maps;
cloning one shared Store preserves token-rotation ownership.

`ProviderContext::new(environment: BTreeMap<String, String>, version: &str)`
returns `Result<ProviderContext, model::Error>`. Assign its clone to
`Preparation.providers`; assign the shared `auth::cursor::Store` to
`Preparation.cursor`. `Preparation::register(&mut Draft, &environment,
Option<&claude::Store>)` registers the built-in account methods without network
traffic. Call `claude::Store::accounts(now).await` to seed source labels.

`AccountCatalog::new(preparation, environment)` returns a retained account owner.
Assign the same Claude Store to `AccountCatalog.claude`. `seed(&mut Catalog,
&credential::Service)` is network-free. Seed a configured baseline before
publishing initial model availability; it does not borrow disk Claude accounts.

`Catalog::compose_with_accounts(snapshots, documents, &credentials, &mut accounts,
now, force).await` returns `Result<Composition, models_dev::Error>`. It retains
configured OpenAI-model discovery and provider account inventories, performs
credential preparation before discovery, applies provider transforms to public
and account models, then applies project configuration to both. Remote OpenCode
accounts start from the provider baseline, never another account's models.
Same-account discovery failures retain inventories except Copilot; a Copilot
failure clears that account's inventory. Removed/replaced accounts cannot select
retained models. Unknown Daybreak programs are excluded.

Serialize connection-change and timer reconciles through this owner. Compose on
every connection/configuration change; use a 60-second timer for refresh and
`force: true` for an explicit refresh. Ordinary reconciles cache the same source
and credential generation until the deadline, including failed discovery. Publish
only complete catalogs with `Resolver::replace(catalog)`. `Resolver::catalog()`
returns an `Arc<Catalog>`; hold one snapshot for the entire selection operation.

Prepare a selected credential with
`Preparation::prepare_value(&credentials, selected.clone(), now,
Option<&claude::Store>).await`. It returns a secret snapshot and enforces current
account identity. Call
`ProviderContext::selected_model(&model::Info, Option<&credential::Value>,
Option<&credential::Info>, Option<&ClaudeHost>, Option<&cursor::route::Host>,
Option<&auth::cursor::Store>).await`
to construct the native model. The runner's `Local::resolve_model` uses this path;
its helper-generation path uses the same resolver. An async generation factory
must await these calls rather than use the synchronous `from_catalog_model` for
account-backed models. The factory itself belongs to composition.

The selected factory exchanges env/configured Cursor API keys even without a
stored credential. Unmanaged runtime identity follows the original key, not a
rotating exchanged token. A `crsr_` key without its shared auth Store fails before
native transport.

Supply Cursor model/image/planning/observation/persistence hosts through
`cursor::route::Host.extensions`; those hosts retain their permission and storage
authority. Account discovery supplies raw model metadata to the shared context's
Cursor runtimes. Session affinity remains request-owned.

GitLab/SAP exchange routes are reconstructed for each logical request. DWS
workflow models are rejected before exchange. Vertex ADC is resolved before
construction and refreshed again at dispatch. Bedrock resolves the AWS chain at
each signing operation; Mantle signs with `bedrock-mantle`. Credential metadata
overrides settings, never request bodies; resolved auth replaces conflicting auth
settings. `ProviderContext.endpoints` is an owner-supplied route-ID transport
override for controlled endpoints; model settings cannot replace the canonical
Codex endpoint.

Construct quota with `quota::Service::with_auth(preparation.clone(),
Some(claude.clone()))`. Managed Claude cold loads use the selected source at
`/api/oauth/usage`, refresh once after 401 when the token changes, and use a
five-minute TTL. Response observations retain exact account identity. Numeric
Retry-After deadlines apply to cold errors and stale snapshots even on forced
refresh. Unknown values remain absent; reported zero remains zero. Quota failures
remain independent from inference.

On Location shutdown, stop reconcile intake, finish runners, shut down quota and
the shared source/auth Stores, then call `ProviderContext::shutdown().await`.
AccountCatalog owns retained discovery state, not a background task or another
model authority. Shared owners must be shut down once, not by each clone.

### Cursor

`resources::cursor` owns the Core side of the Cursor provider; the Connect wire
boundary stays in `ycoding-ai`.

- `models::from_cursor` converts discovered `ycoding_ai::cursor::models::Info`
  values into `cursor` catalog models on the `aisdk:cursor-opencode-provider`
  package. Long-context variants become `-<size>` entries (the 1M entry allows
  128k output; other entries 32k), separately priced Fast variants become `-fast`
  entries, generated ids that collide with an advertised id take a numeric `-N`
  suffix, and thinking models whose display name collides with a plain twin are
  labelled `Thinking`. Each variant carries its exact `cursorVariantParameters`
  tuple; an entry without effort variants stores its single default tuple as the
  model setting. Costs come from the committed pricing table and are empty when
  unpriced. Models without variants use 256k (`default`) or 200k context.
- `catalog::load` discovers each connection in order. A failed discovery keeps the
  previous inventory only for the same credential ID and account generation (or
  the environment connection) and never inherits a replaced account's models;
  `Loaded::source` is absent after any failure so the next reconcile retries.
  `catalog::source` fingerprints stored credentials and `CURSOR_API_KEY`, and
  `catalog::publish`/`sync` replace the catalog's Cursor provider models and the
  per-credential account inventories.
- `cache` stores discovered models in `cursor-models.json` (schema 3, 24-hour
  freshness). A failed refresh leaves the stored models untouched, `discover`
  serves a fresh cache without fetching, falls back to a stale cache when the
  fetch fails unless forced, and ignores a cache whose schema or entries are
  invalid.
- `route::model` builds the `cursor-connect` model for a catalog model after
  `with_variant`: the real Cursor model ID, a bearer from the key or OAuth access
  token, provider options `{"cursor": settings}` (credential, transport, and
  timeout settings excluded), and the catalog output and context limits. Other
  packages are rejected. The caller supplies the `Host` (identity, request
  context, runtime, known MCP servers).
- `system::system` appends the stable Cursor identity instruction as the final
  system part for `cursor-connect` models, dropping empty parts and leaving every
  other route unchanged.
- `context::build` discovers `.ycoding` project configuration from the workspace
  up through its ancestors (outermost first) plus the global directory,
  merging `ycoding.json` then `ycoding.jsonc` with trailing commas and comments
  allowed; no other host's project configuration is read, and disabled project
  discovery reads none. It collects local instruction rules, skill descriptions
  (never skill bodies), npm and local plugin lines, a shallow project layout, and
  the permission-filtered subagent catalog from the `task` or `subagent` tool
  (a structured `subagent_type`/`agent` enum overrides prose; an unknown catalog
  is incomplete). `Context::encode` produces the `RequestContext` bytes for
  `ycoding_ai::cursor::provider::RequestContext::new`; the ai crate adds tool
  descriptors per Run. `resolve_subagent` maps Cursor subagent types onto the
  catalog and returns nothing when no compatible agent exists.

Limitations: remote and glob instruction entries, Git repository metadata, and the
per-conversation capability hold are not collected; discovery of several
connections runs sequentially; refresh de-duplication across concurrent callers
is the caller's responsibility. The Session runner must call `system::system` and
`route::model`, and startup composition must register `auth::cursor::register`,
supply `route::Host`, and drive `catalog::load` on connection events and a
60-second reconcile.

## Project artifacts

`resources::project_artifact` reuses Schema artifact identities, definitions,
permission rules, revisions, stages, provenance, and digests. `validation`
applies the automatic-authoring text policy through Core's ECMAScript RegExp
engine, including UTF-16 validation, NFKC/case collision detection, byte limits,
and the complete JSX pragma exception. Automatic definitions accept skills,
instruction-only commands, and subagents; plugin activation is unsupported.

`adapter` renders lossless standard Markdown and parses it through resource
frontmatter discovery. Activation registers Skill directories and updates the
real Command and Agent services. Managed commands clear agent/model selection;
managed agents clear model/request overrides and append explicit permissions to
the fixed least-privilege rules. Rendering and activation do not write files.

`package` owns SHA-256 markers, journaled commit and state transactions, archived
and disabled versions, multi-layout trash manifests, restoration, expiry-gated
purging, and reconciliation. `CommitInput.standard` and
`StateMutationInput.standard` select validated standard discovery targets without
duplicating transaction paths. `TransactionHooks<Metadata, Error>` holds the
cross-process reconciliation and artifact locks across reservation, availability,
and finalization, preserves hook errors, and compensates failed finalization.
Successful finalization retains available bytes if journal cleanup fails;
transaction enumeration and cleanup expose the retained finalization journals.
Callers supply an existing scope marker and retain responsibility for durable
artifact revisions, lifecycle decisions, quota accounting, and confirmations.

Filesystem mutations validate root containment, reject symlinks, and compare
device/inode/mode identities immediately before the native operation. Native
identity verification supports Unix; other platforms reject mutations. Package
operations and hooks are blocking. Compose them on an owned blocking executor,
not a Tokio runtime worker. `TransactionHooks.cancellation` observes explicit
cancellation at reservation, availability, finalization admission, and settlement.
Cancellation after successful finalization settles as `Interrupted` without
compensating committed bytes. Blocking callbacks and individual filesystem
operations must return before cancellation is observed. `can_compensate` fences
compensation when a durable writer outcome cannot be determined.

`accounting::Service` uses the real redb artifact graph for activation identity
retries, terminal attribution, observation deduplication, feedback, metrics,
project-move deactivation, rolling matched cohorts, and persisted governor
decisions. Actionable decisions require the caller's owning transaction.
Global cohort buckets use HMAC-SHA-256 rather than exposing project identities.

`store::Service` resolves project/global scopes, restores missing scope markers,
adopts project membership without moving storage, and performs journaled manual
project writes and five-minute single-use global manual confirmations. Updates
require exact revision, version, and digest expectations. Automatic writes use
deterministic operation/version fingerprints, normalized insight identities,
three writes per Session, ten daily project writes, 32 live artifacts, per-kind
caps of 24 Skills/eight Commands/four Agents, 16 retained versions, an 8 MiB owned
byte budget, and a one-hour update cooldown. Reconciliation does not consume a
write allowance. Session locks precede Scope locks; durable reservations and
retained owned bytes participate in quotas. Unrelated files do not consume the
owned-byte budget. Write identity rows expire after 30 days.

Project disable, enable, and revert coordinate Package state journals, exact
Store expectations, version states, revision changes, and deduplicated feedback.
Promotion previews include persisted accounting metrics; confirmation rechecks
the source and destination, copies literal bytes to an independent global
snapshot, records provenance and source shadow identity, and consumes its
five-minute token once. Promotion acquires both Scope locks in identity order.
`sql` projects existing redb rows into Schema values; it defines no replacement
tables or key encodings.

Store recovery validates shared journal identities before finalizing committed
bytes and rows, rejects unowned and available-orphan journals, aborts preparing
orphans, rechecks markers under target locks, rebuilds project/global ownership,
quarantines plugin drafts, and disables missing active bytes without user
feedback. Retained trash manifests recover deletion rows; restored manifests
recover restore feedback and remove the deletion index. Project removal retains
every owned layout, restoration expires at the exact 30-day boundary, and the
bounded expiry purge validates owned manifests before deleting filesystem bytes
and graph rows. Global remove/restore recovery uses the authoritative standard
content and marker paths. Active global removal requires exact managed sources;
disabled removal and global restoration reject occupied standard destinations.
Ordinary lists exclude retained trash.

Fork previews capture exact global bytes, revision, version and digest and reject
project or standard-source collisions. Single-use confirmation expires at the
exact five-minute boundary, acquires both Scope locks in identity order, rechecks
both sources and the destination, and journals an independent project snapshot
with fork provenance and global shadow identity. Shadow confirmation retargets
origin metadata without rewriting bytes, preserves version identity, and avoids
incrementing the revision for an already matching link. The Store origin
constraint permits origin metadata only for promotion/fork versions; shadowing a
user, agent or restore version returns `ReconciliationRequired` without partial
graph writes. Failed confirmations consume their token.

`Service.with_accounting` supplies the configured accounting service for governor
evaluation and governor-context recovery. No bucket secret is synthesized.
Qualification-only evaluation persists its governor state; activation changes
artifact/version state in the same redb transaction. Degradation reevaluates in
the Package finalization transaction, preserves a durable fallback when present,
and records deduplicated automatic-governor feedback. Recovery uses the journal's
model, agent, goal-mode and evaluation-time context.
The Location owner constructs the source service and binds its catalogs,
invocation consumers, refresh triggers, and execution subscription. The tool
registry supplies the artifact-authoring tool.

`legacy_cleanup::run` removes only direct legacy children with the exact
lowercase basename suffix and positive `.ycoding-generated.json` ownership
marker. Its `Service` targets only `config/generated`. Each call scans one to
256 entries in UTF-16 lexical order, uses that same order for its cursor, and
retains the failed entry for retry. Cleanup validates root, parent, child and
marker identities plus unchanged marker bytes, then quarantines the child in its
parent before recursive removal. Removal failure attempts to restore the child
and returns a partial report. Unix metadata supplies identity checks; unsupported
native identity platforms return a failed report without mutation. The existing
`LegacyCleanupTable` is unchanged; the filesystem-only cleanup service does not
create table-backed progress or automatic startup cleanup.

`source_registry::Registry` maintains replaceable, insertion-ordered Location
snapshots with project isolation and managed-identity deduplication.
`source::Service` owns one replaceable managed overlay per Location. `refresh`
validates trial/active project candidates against marker identities, content
digests, and parsed definitions, excludes plugins and inactive stages, and
registers accepted candidates through the existing Skill, Command, and Agent
adapters. Invalid, replaced, and removed candidates leave no retained overlay.
Collisions require exact global shadow scope, origin version, and evidence
digest. `replace_standard(Catalogs)` replaces the unmanaged discovery snapshot
and refreshes the managed overlay; `catalogs()` returns the complete current
services. Failed refreshes preserve the preceding published catalogs and
provenance. Bounded `diagnostics()` categories expose collisions, refresh,
activation, terminal-observation, stale-provenance, and governor failures without
persisting payloads or paths.

`provenance(kind, id)` returns source scope, scope/version identity, artifact
kind/ID, expected revision, and expected digest. Global attribution requires
an exact standard marker and matching current Store version. The TypeScript
source's precedence is preserved: an accepted project overlay can supply the
catalog definition while a matching global standard source supplies provenance.
Refresh observes the currently published catalogs; when an overlay hides the
global path, a subsequent refresh attributes that visible project source.
An authored user/agent version cannot acquire origin fields through
`confirm_shadow`: both backends' origin constraint requires fork/promotion
provenance. A confirmed fork supplies valid shadow evidence.

`activate(ActivationInput)` accepts `AgentSelected`, `Command`, `SkillTool`, and
`SubagentLaunch` sources. Agent selection supplies its committed sequence and
activation time. Commands resolve the original durable input-admission event,
including after promotion; tools resolve the exact assistant-message/call-ID
`session.tool.called` event. Managed invocations without that boundary fail with
`Managed activation requires a durable invocation`; unmanaged IDs are no-ops.
Activation IDs use the TypeScript SHA-256 identity, and exact retries retain the
original sequence and timestamp. `session-skill` publications use fresh UUID
activation IDs. `session::store::Service::with_artifact_source(source)` binds
runner Skill references and subagent launch accounting. Pass the same source to
`builtin::skill::load_local(info, policy, context, Some(&source))` for skill-tool
accounting; resource reads do not create activations. Tool accounting failures
remain best effort and observable through diagnostics.

`start(&event_feed::Feed)` subscribes to only execution started, succeeded,
failed, and interrupted facts before they enter the bounded subscriber queue.
The owned `Governor` serializes terminal submissions on blocking workers, checks
the Session's directory and workspace identity, captures goal mode/start time,
and reads the latest assistant plus markers at or above the completed compaction
floor. It attributes managed tool calls from captured activations, counts
standard invocations and completed/failed tools, records tokens and clamped
latency, and evaluates each observed version once through
`store::Service::evaluate_governor` with exact provenance expectations. No
lifecycle rules are duplicated. Terminal identity is the latest assistant ID or
the durable boundary when no assistant exists. Duplicate identities are skipped
after successful accounting; conflicting persisted facts are rejected.

`Governor::flush()` waits for accepted execution facts through the current feed
watermark; `close().await` drains that boundary, joins in-flight submissions,
unsubscribes, and removes the Location registry snapshot. Feed overflow or worker
failure is an explicit close/flush error, not successful accounting. Like the
TypeScript source, a newly constructed service does not replay historical
execution facts or restore process-local start times, terminal identities, or
managed-tool classifications. Accounting still reads durable open activations;
conflicting repeated terminal observations cannot insert a second record.

### Location composition handoff

- Share the Core Store client, one accounting service, and one standard-source
  registry. Construct `store::Service::new(client, Paths, registry)` with
  `with_accounting(accounting)`, then one `source::Service::new(Options, Catalogs)`
  for each Location. Supply its exact Location reference, project identity/root,
  and managed data root.
- Bind `source.start(&Core.events)` before admitting or resuming execution, retain
  the returned Governor, and await initial refresh before exposing catalogs.
  Feed the returned Agent/Command/Skill services to catalog readers, runner
  resolution, Skill discovery, and subagent preflight. Catalogs are snapshots:
  existing immutable Arcs do not change when the service publishes a replacement.
- After configuration reload, rediscover standard resources and await
  `replace_standard`. After each committed artifact mutation, await refresh and
  publish the resulting catalogs; global authoring/promotion also requires
  standard-file rediscovery. Bind these operations to `ArtifactServices.refresh`.
  Its current synchronous `Fn()` callback cannot await an async refresh itself;
  the composition adapter must own and join refresh work and fence subsequent
  catalog reads, or provide an awaited callback in the runtime handler layer.
  Refresh uses blocking Store/Package operations; execute it on an owned blocking
  worker with the Tokio handle driving its asynchronous discovery.
- On Location eviction or process shutdown, stop new invocations/refreshes,
  drain/interrupt owned Session execution, await pending refreshes, then await
  Governor close while Store, accounting, and feed are alive. Release catalogs,
  source, and finally the shared Store/feed. Do not abort or discard the Governor
  handle as a substitute for close.

### Session operation attribution

`session::runner::Local` attributes managed artifacts through the source bound
to its `runner::Services.store` with `with_artifact_source`:

- `command` captures `provenance("command", name)` after evaluation and any
  agent or model switch, admits the input with user metadata `projectArtifact`,
  then calls `activate` with `ActivationSource::Command { message_id, call_id:
None }` and the Session's agent before the command switch. A failed activation
  is recorded through `record_activation_failure`; the admitted input stands.
  A reused message ID returns the admitted input without attribution.
  A context-blocked model switch retains the prior model and admits the evaluated
  command without a switch-blocked notice; compaction lifecycle events remain
  independent. Model resolution errors refuse admission with the resolver's
  message. Variant and unsupported-package failures retain distinct
  `model.variant` and `model.unsupported` runner categories.
- `switch_agent` publishes `session.agent.selected.1` through
  `publish_activation`, committing provenance and the `agent-selected` row with
  the event.
- `load_skill` without a message ID publishes through `publish_activation`. With
  a message ID it uses that `msg_` to `evt_` event identity and, for a managed
  Skill, appends the event, projection and `session-skill` row with
  `activation.message_id` in one Store transaction.
- `session.subagent.launch` records no activation; the `subagent` tool's launch
  remains the attributed invocation.

`move_to` publishes `session.project-artifacts-ended.1` across Projects without
the accounting service's project deactivation, prior-Project artifact
adoption, or project-agent reselection.

`instructions::KEY` and `CONTENT` supply artifact-authoring guidance without a
second persistence authority.

Run the focused real-filesystem checks from `rust`:

```sh
CARGO_BUILD_JOBS=3 ~/.cache/ycoding/cargo-gate.sh cargo test --locked -p ycoding-core --test 'project_artifact_*'
```

## Jobs

`job::Jobs` is a process-local registry of cancellable work; entries are not
durable, and Session compaction jobs (`session::compaction_job`) are a separate
durable lifecycle. `Jobs` is cheaply cloneable; clones share one registry, and
dropping the last clone or calling `close()` aborts live work without settling it.

```rust
Jobs::new() -> Jobs
start(StartInput { id: Option<String>, kind, title, metadata, run: Run }) -> io::Result<Info>
wait(&str, Option<Duration>) -> WaitResult { info, timed_out }
block(BlockInput { id, session_id, background_after }) -> Option<BlockResult>
background(&str) -> Option<Info>
background_all(&session::Id, Option<&str>) -> Vec<Info>
cancel(&str) -> Option<Info>
get(&str) -> Option<Info>
list() -> Vec<Info>
outstanding_sessions() -> BTreeSet<session::Id>
notice_admitted(&str)
close()
```

`Run` is a boxed future of `Result<String, String>`; `Ok` settles `completed` with
that output, `Err` settles `error` with that message, and a panic settles `error`.
`start` publishes the entry as `running` before the work first polls, generates a
`job_`-prefixed ascending id when none is given, and returns the existing job when
that id is already running; a finished id restarts. `wait` with no timeout waits for
settlement, a zero timeout reports `timed_out` immediately, and an unknown id yields
no info. `block` registers the calling Session as blocking the job and resolves as
`Finished(info)`, or `Backgrounded { info, reason }` with reason `Request` (from
`background`/`background_all`) or `Deadline` (`background_after` elapsed); dropping
a pending `block` releases its Session hold and its deadline. `background_all`
moves only running, not-yet-backgrounded jobs that the Session is blocking,
optionally filtered by kind. `cancel` settles `cancelled`, aborts the work, and
returns after the work has been dropped; settled jobs return their final info.

Jobs of kind `shell` whose metadata carries a `ses_` `sessionID` are outstanding for
that Session while running and, once backgrounded, until `notice_admitted` after
their completion notice is durable. `Jobs::background` on a settled shell job owes a
notice again. `tests/job.rs` covers each behavior of the TypeScript Job service.

`builtin::shell::JobShells::new(jobs, deliver)` implements the shell tool's `Jobs`
trait over this service. `foreground` and `background` share one hold per tool call
ID: the first starts a `shell` job named by the call ID, titled by the command, with
the Session in its metadata, and the job settles `completed` when the last lease is
dropped. `foreground` registers the Session as blocking the job before it returns, so
`background_all` signals the tool's `Notify`. `background` marks the job backgrounded.
`deliver` calls the injected `Deliver` with a steer synthetic input, `<shell
id="<call>" state="<state>" command="<command>">` around the notice text with the
command as description and `{source: "shell", state}` as metadata, or the bare
auto-background text for `Notice::Steer`, and calls `notice_admitted` only after
`Deliver` succeeds. `tests/tool_shell_jobs.rs` exercises it with this service.

`Execution::job_shells()` builds a `JobShells` over the owner's `Jobs` whose `Deliver`
admits the notice through `Execution::prompt` with a fresh message ID and wakes the
Session only when the admission says to wake, so a Session with a staged revert keeps the
notice pending. The tool registry that consumes it is the caller's to build; no Core
registry constructor takes it yet.

## Shell, processes, PTY and tool output

### Usage and ownership

`platform::shell::Shell::new(roots, directory, project, store)` owns a Location's shell
commands and capture files under `Roots.data/shell/<project>`. Prepare schema
`shell::CreateInput` with the current `Configuration`, then consume the returned
capability exactly once with `create`. Preparations cannot cross Shell instances;
captured policy, rather than mutable display fields, controls execution. Call
`wait` before reading a settled capture, `remove` to release a command and its
capture, and `shutdown` to terminate and join owned work before disposing the
Location. Exited captures remain available until removal or the 25-command
retention limit evicts them.

Supply the real store Client with `ycoding_store::resources::TABLES` registered.
The shell ledger records process and owner birth identities in `ShellTable`.
Caller metadata never establishes durable Session ownership. `notice_owed` binds
an owed notice to a validated Session ID; removal preserves that row until
`notice_admitted` deletes it. Exited rows remain available for notice binding
until command removal or retention eviction.

`platform::shell::ledger::Ledger::reconcile(grace)` leaves live owners and reused
PIDs untouched, terminates orphaned groups including groups without a leader,
and retains owed notices with the latest durable execution-start sequence.
`lost_sessions` includes only existing Sessions without a newer execution-start
event. Subsequent reconciliation removes acknowledged or deleted-Session rows.
Process-list failure leaves pending rows untouched; signal failures are returned
in the reconciliation report. Reconciliation and lost-session reads also require
the Session and event tables in the supplied store catalog.

`platform::process::{spawn, run, run_stream}` resolves cwd, environment and stdio
explicitly. `spawn` exposes bounded stdout/stderr and Unix extra-FD chunks, input controls, timeout
replacement, termination and joined settlement. `run` drains both streams while
retaining their configured byte prefixes, or one combined prefix. Signal,
timeout and cancellation settlement fails `run`; ordinary nonzero exits remain
results until `require_success` or `require_exit_in` checks them. `run_stream`
emits nonempty UTF-8 lines and applies nonzero-exit rejection only when a nonempty
`ok_exit_codes` list is supplied. The line decoder strips only the initial UTF-8
BOM. Commands support piped stages with stdout,
stderr, combined output or an output FD routed to stdin or an input FD. Stdio
can be piped, inherited or ignored; input can be bytes or a bounded stream of
fallible byte chunks. Command and run-option input use the same owned pump;
run-option input rejects a pipeline. Run and stream options accept a watch-based
cancellation signal, including cancellation before spawn.

Commands default to a detached Unix session and TERM without a forced-kill
deadline. Per-command kill options and explicit `kill` override the signal and
grace. Shell commands select a three-second escalation deadline.
`Process::is_running` and `Control::is_running` reflect root-process exit,
independently of joined output settlement. `Process::shutdown(grace)` closes stdin,
sends TERM, waits up to the supplied grace, and then forces KILL.
`Process::shutdown_gracefully(grace)` closes stdin, sends TERM and waits up to the
supplied grace without escalation; it returns `None` while the process remains
unsettled. `Process::release` relinquishes termination ownership and leaves the
supervisor to drain discarded output and reap eventual exit. The Codex app-server
uses a non-detached process, a 500-millisecond graceful shutdown, and releases a
TERM-resistant child without sending KILL.
Settlement joins the root, pipe pumps and upstream commands. Drain output while
waiting when a command can exceed the bounded delivery queue.

Additional FD inheritance is available on Unix and rejects on Windows. This
API does not supply JavaScript event-loop `ref`/`unref` liveness controls.

### Configuration and paging

Shell preparation reads `shell`, `shell_memory_limit_mb` and `shell_sandbox` from
the existing configuration service. An explicit memory limit of zero disables a
configured limit. Finite limits set Go/Node memory hints and sample aggregate
process-group RSS every 250 milliseconds, with process identity checks. Windows
rejects memory-limited preparation. A zero timeout clears the deadline.
`Shell` and `Pty` accept `with_shell_options(select::Options)` for an explicit
Git Bash override. Windows selection normalizes MSYS, Cygwin and WSL drive paths,
resolves bare or `/usr/bin/bash` through Git Bash before PATH, and falls back
through PowerShell, Git Bash and COMSPEC. An invalid explicit shell selects the
platform fallback rather than the environment shell.

The current sandbox backend is unavailable. `required` rejects preparation before
spawn; `optional` returns a host-authority warning; `disabled` uses host authority
without that warning. No sandbox label implies enforcement that the backend
cannot supply.

`platform::shell::paging` reads absolute byte cursors. Pages exceed their budget
only by up to three bytes to finish a UTF-8 character. Live incomplete prefixes
remain at the same cursor; settled captures flush them with standard replacement
decoding. Zero limits do not read or advance, and cursors beyond the capture clamp
to its size. Settlement is published only after capture flushing.

### PTY and output-store APIs

`platform::pty::Pty` owns native terminals, with Unix controlling-terminal setup
and a Windows ConPTY adapter. Schema inputs carry Session ownership, generation,
writer fence, terminal size and runtime/output limits. Agent/user/paused control
transitions invalidate stale writers. Replay uses absolute retained byte offsets;
attachments activate after replay, enforce inspect/control access, and end when
the terminal stops producing output. The service limits active terminals and
attachments to eight, input to 64 KiB, and retained output to 2 MiB. Slow
attachments end with overflow instead of accumulating unbounded pending delivery.
Call `shutdown` to join native process and I/O ownership.

`platform::pty::protocol` implements tagged control/data frames, bounded replay
chunks and strict UTF-8 input decoding. Binary decoding strips one leading UTF-8
BOM; text input preserves it. Both forms enforce the original input's byte budget.
`platform::pty::ticket::Tickets` issues
random, one-use, scope-matched tickets with a 60-second default TTL and a
10,000-entry capacity.

`resources::tool_output_store::Store::new(roots)` retains full textual output
under `Roots.data/tool-output`. `bound(output, configuration)` preserves
structured values and native media, aggregates text, and saves oversized content
in one exclusively created file. Provider-facing head/tail previews include its
path within the configured `tool_output.max_lines` and `max_bytes` budgets
(defaults: 2,000 lines and 50 KiB). `cleanup(now)` removes managed files older
than seven days without removing unrelated names. Storage errors propagate;
failed writes do not return a fabricated saved-output path.

Run the component checks from the repository root:

````sh
cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-core \
  --test shell_process --test shell_lifetime --test shell_output \
  --test shell_ledger --test shell_select --test process_spawner \
  --test pty_platform --test pty_transport --test tool_output_store

## Location-scoped platform effects

`platform::filesystem::Location` binds reads and direct-child listings to an
explicit directory and its canonical root. Lexical and existing-symlink escapes
are rejected before reading. `read` returns unchanged bytes and a MIME type;
`list` returns Schema filesystem entries, directories first, with trailing
directory separators and without symlink entries. `resolve_mutation` resolves
prospective internal files through their nearest existing canonical directory.
Unresolved symlinks cannot become prospective internal mutation targets. The
confinement check assumes trusted filesystem ownership, not an OS sandbox
against concurrent symlink replacement. Listing ties use compiled ICU4X 2.3
root collation, verified against Bun's default `en-US` locale comparator.

`filesystem::mutation::Service` serializes cooperating changes by canonical
target within one Location service. `create` uses exclusive creation;
`write_if_unchanged` compares and writes under the same lock. Text writes retain
an existing UTF-8 BOM and emit at most one BOM. Writes create missing parent
directories, and removal reports whether a target existed. Supply a pre-resolved
`Target`; constructing one does not grant filesystem or external-directory
permission. `Location::resolve_mutation_authorized` resolves internal and external
targets and asserts `tools::policy::permissions::Permissions` before returning an
external target. Existing external files use their canonical parent as the
approval boundary; missing targets use their nearest existing canonical
directory. External resources are canonical paths, approval resources are
directory globs, and saved resources use the nearest `.git` or `.hg` ancestor
when present. Internal symlink escapes remain rejected rather than becoming
authorizable external targets. Every external target requires authorization;
the managed-worktree exemption is not part of this resolver API.
Writes are not atomic replacements or multi-file transactions. An
I/O failure does not certify that the target bytes are unchanged.

`filesystem::search::Service` supports the native `fff-search` 0.9.4 engine and an
explicit ripgrep executable. Automatic selection uses native search for VCS
Locations outside Windows and ripgrep otherwise. Native search uses AI mode,
disabled mmap warmup and content indexing, first-page limits, score ordering,
byte-offset submatches and a 1,500 ms grep budget. Ripgrep builds its filename and
directory snapshot in an owned background worker, streams bounded records,
retains partial code-2 results and rejects malformed regular expressions. Initial
non-VCS scans retain at most 100,000 filenames; VCS scans use the TypeScript safe
integer limit. Dropping the service stops its native monitor or kills and joins
its ripgrep index worker. `wait_for_scan` supplies an explicit readiness boundary.
Native filename/directory queries and fuzzysort queries use ECMAScript-exact
whitespace trimming: U+FEFF is stripped and U+0085 is retained.
Search paths reject lexical and existing-symlink escapes, including prospective
native prefixes. Native initialization failures retain an empty search service
and report the failure to stderr; they do not select ripgrep.

`filesystem::glob` translates brace, globstar, character-class, POSIX-class,
extglob and negation patterns through Core's ECMAScript RegExp engine.
`filesystem::ignore` applies whitelist patterns before built-in directory names,
file patterns and caller extras. `filesystem::protected` supplies the TypeScript
macOS and Windows protected names and paths for an explicit platform and home.
`filesystem::util` owns safe UTF-8 reads, lossless JSON, parent creation, upward
discovery and glob scans. Scans follow directory symlinks only when requested and
terminate canonical ancestor cycles. Windows path helpers accept drive, Cygwin
and WSL prefixes, normalize native canonical paths, and preserve directory-glob
suffixes and drive roots.

`filesystem::watcher::Service` shares native notify subscriptions by watch kind,
absolute target and sorted unique ignores. Acquisition is serialized per watch
identity; unrelated identities initialize independently. File watches observe the parent but
publish only target updates; directory watches publish create/update/delete
events. The last subscription releases its native watcher. Native callback errors
are reported to stderr. Directory native startup has a ten-second deadline;
startup errors and timeouts select notify polling with 100-millisecond
content-comparing scans. Polling and non-kernel-recursive native backends
(inotify, kqueue) watch each included directory nonrecursively, pruning
ignored/protected directories during initial inventory and as new subtrees are
registered; entries already inside a newly registered directory publish Create.
macOS FSEvents and Windows use one kernel-recursive watch on the root, which
registers nothing per directory and filters ignored paths from events and the
initial inventory; per-directory registration is not used there because each
registration restarts an FSEvents stream and drops events in the gap. A native
watcher that settles after its deadline is dropped. The fallback uses notify
polling, not Node's recursive `fs.watch`. `LocationWatcher` skips home and non-VCS root watches,
adds configured/built-in/protected ignores, and separately observes the canonical
Git directory with its existing members except `HEAD` ignored. It returns Schema
`ChangedData`. Native rename
events publish a deleted source and created destination; batch normalization
follows notify rather than Parcel.

`platform::git::Service` runs real Git with an explicit per-stream output limit.
Repository discovery retains worktree, per-worktree Git storage and common
storage separately. Clone/fetch/checkout/reset, binary change capture/application,
discard policies, scoped index refresh, ignored paths, seeded snapshot storage,
tree capture/read/diff/preview/restore and checkout are platform-owned. Temporary
preview indexes are removed before settlement. Output limits reject truncated
success; errors after uncertain process settlement expose `unknown_outcome` and
must not authorize automatic replay. History reads do not create commits.

`platform::worktree` supplies linked-worktree creation/list/removal, named-branch
validation, dirty-removal classification and managed destinations derived from
the canonical common-directory SHA-256. Named creation does not detach or switch
the source Location. `platform::project_copy` supplies the Git strategy's
filesystem effects, canonical lists and destination collision handling. Named
branches reject collisions immediately; detached copies try suffixes through
`-10`. Project registration, durable events, tool permissions and Session
guardrails remain runtime composition responsibilities.

`filesystem/generate.ts` accepts installed minimatch 10.2.5, fuzzysort 3.1.0,
mime-types 3.0.2 and mime-db 1.54.0 package directories, generates the glob/ranking oracle and MIME
extension table, formats the generated Rust table, and retains their actual
licenses. Minimatch's supplied notice is Blue Oak 1.0.0; fuzzysort, mime-types,
and mime-db are MIT. The corpus exercises those selected inputs, not every possible pattern
or host-locale behavior. `tests/generate-platform-parity.ts` reads committed
`main` listing/search sources and generates literal Bun default-collation,
ECMAScript-trim and fuzzysort 3.1.0 fixtures. Supply the installed fuzzysort 3.1.0
package directory as its argument; generation is byte-reproducible on the same
Bun/ICU oracle. Run the platform boundary checks from `rust` with:

```sh
cargo test --locked -p ycoding-core --test 'filesystem_*' --test 'file_mutation_*' --test 'git_*' --test 'worktree_*'
````

## Code Mode

`ycoding_core::tools::code_mode` parses restricted JavaScript and erasable
TypeScript with Oxc, lowers the syntax to an owned program, and executes it
without a JavaScript engine. Parser and semantic diagnostics retain UTF-16
indices and source positions. Imported modules, classes, generators and ambient
host capabilities are rejected before program execution. Runtime functions and
values remain execution-owned; tool calls cross only the supplied `ToolHost`.

Construct `Runtime::with_default_collation` with a captured tool host,
`ExecutionLimits` and a `regexp::RegExpEngine` to use the same compiled ICU4X
collator as filesystem listings. `Runtime::new` accepts an explicit host-supplied
UTF-16 locale comparator. `NativeRegExpEngine`
delegates to `crate::regexp`; it provides no alternative parser or matcher.
`Runtime::execute(source, cancellation)` returns a data value or diagnostics,
warnings, console logs, called tool paths and an output-truncation indicator.
`Runtime::catalog()` and `Runtime::instructions(catalog_budget)` expose the
host-provided discovery catalog and its bounded prompt representation.

`timeout_ms`, `max_tool_calls` and `max_output_bytes` are optional. Values must
be safe integers; timeout must be positive and the other limits may be zero.
An omitted execution limit is unlimited. Cancellation and timeout terminate
execution, cancel unfinished tool work, and cannot be caught by program code.
Native RegExp parser and matcher work checks the same cancellation token and
selected deadline. Native work-budget failures also bypass JavaScript catches.

RegExp match arrays expose captures, `index`, filtered named `groups`, and
`d`-flag `indices` with filtered index groups. Match `input` is not exposed.
The original writable `lastIndex` value is retained for operations that do not
update it; `search`, `split` and `matchAll` do not write it. Function replacements
receive captures, UTF-16 offset, input and optional filtered groups, and coerce
their return values synchronously. Native matching and substitution supply
String's RegExp operations; the execution layer owns callback evaluation and
the blocked-member policy.

`Program::parse` and `Runtime::execute` accept source convertible to
`LosslessString`. Programs retain the original UTF-16 source. The Oxc parsing view
replaces lone surrogates without changing UTF-16 offsets; literal lowering reads
the original code units for strings, templates and RegExp patterns. Console logs,
runtime string values and native RegExp inputs preserve lone surrogates. Tool paths,
catalog identities, host-call names, hook names and called-tool records use
`LosslessString`; splitting and joining namespaces preserves UTF-16 units. Search
matches raw canonical names exactly and emits executable escaped bracket paths.
Non-UTF-8 labels in text diagnostics and namespace headings use JSON quoting.
The native Unicode string-property dataset limitations above
also apply to Code Mode construction.

Array member assignment validates canonical indices before evaluating the assigned
expression; deleting `length` returns false. Sorting writes its captured elements
without discarding comparator changes beyond the captured array length.
`JSON.parse` requires a string input. Calling a non-callable identifier or a named
member reports that callee's name and source position.

Async functions adopt returned promises through their owning settlement and reject
direct self-resolution with `TypeError`. Promise race inputs already settled at
admission compete in input order; later settlements retain chronological order.
Callable thenables are not assimilated by Promise statics or `await`.

Tool invocation and output decoding return `Option<JsonValue>`: `None` denotes
JavaScript `undefined`, distinct from `Some(JsonValue::Null)`. Tool arguments omit
undefined object fields; program results replace every undefined value with null.
Optional async `ToolHost` start/end hooks observe admitted calls with their decoded
input and execution-local index. End hooks include elapsed milliseconds and a
sanitized success/failure outcome; interrupted calls emit no end outcome. Built-in
`search` uses the same Promise, admission, limit and hook contract as host tools.

Tool names reject empty dotted segments at Runtime construction. Tool references
may contain blocked property names because their segments are not data properties.
Namespaces with children are enumerable; a namespace without its own definition
is not callable. Unknown namespace enumeration reports `UnknownTool`.
`Object.values` and `Object.entries` reject opaque tool references with discovery
guidance. `for...in` accepts only plain objects, arrays and tool references.
Empty-string repetition validates its count and then returns without iterating it.

`schema::to_typescript` renders JSON-Schema signatures in compact or pretty form.
It supports literal values, enums, unions, intersections, scoped local definitions,
object properties, arrays and index signatures. Reference siblings retain their
constraints; unresolved or recursive references render as `unknown`, with an
eight-level rendering depth bound. Pretty object fields include sanitized JSDoc
descriptions and supported annotation tags. `ToolDescription::from_schemas`
combines those types with a lossless callable path and searchable input metadata.
These JSON-Schema descriptions do not validate host arguments or results; host
decoding retains that responsibility.

`openapi::Host::from_spec` generates captured HTTP tools from an OpenAPI document
and reports unsupported operations in `skipped`. Supply the HTTP client, optional
base URL and namespace, static headers, and call-time credential resolver. Tool
inputs expose path/query/header parameters and JSON body fields, not credentials.
Operation and path servers take precedence over document servers. Unsupported
parameter serialization, malformed security, cookies, SSE, WebSockets, and binary
response contracts are skipped rather than guessed.

Request schemas omit read-only fields; response schemas omit write-only fields.
Local definitions, reference siblings, composed required fields and reference
cycles retain their directional semantics. Schema projection is model-facing;
runtime JSON values pass through unchanged. Input validation and parameter
encoding precede credential resolution. Security alternatives use OR between
requirements and AND within a requirement; unavailable credentials try the next
alternative, while resolution failures and duplicate authentication carriers fail.

HTTP execution supports JSON and text responses, recognizes vendor JSON media
types, bounds response bodies to 50 MiB, and sanitizes transport errors. Non-success
statuses include at most 1,024 UTF-16 units of response-body summary. Cancellation
drops the pending request or body read. Hosts own outbound-network authorization
and client redirect policy.

Core leaves supplied through `ToolHost` retain execution authorization. Capture
`tools::policy::permissions::Permissions` and
`process::guardrails::Guardrails` in each leaf, preserve the outer assistant-message
and execute-call source, and assert policy before side effects. Catalog visibility
does not authorize execution. The interpreter supplies no replacement permission
rules or Session authority.

Run the Code Mode checks from `rust`:

```sh
cargo test --locked -p ycoding-core --test 'code_mode_*'
```

`tests/generate-code-mode-corpora.ts` snapshots committed `main` test sources;
`tests/generate-code-mode-assertions.ts` expands literal assertions without running
the Rust interpreter. Every `expect` call in the covered suites is classified: it
becomes a corpus case observing the value, error message or kind, logs, warnings,
tool calls, or success flag (including `pair` programs, loop-expanded programs, and
`copyOut` data programs), or it is recorded as excluded with a concrete reason.
Assertions that need a host trace, a capturing tool, or execution limits are
translated by hand into the Rust tests named in `tests/code-mode-manual.json`
(`tests/code_mode_promise_trace.rs`); the generator emits them as `manual` entries
and `code_mode_assertions` verifies that each named test exists. A manual entry
that matches no excluded assertion fails generation.
`tests/generate-openapi-corpus.ts` runs the committed TypeScript OpenAPI assertions
with their supplied HTTP fixtures and records literal generation/signature data.
Its diamond-graph case does not render a catalog signature; that original test
inspects projected definitions, so the Rust equivalent is a unit test in
`openapi/spec.rs`. HTTP authentication, body, error-mapping, and response-limit
flows run against loopback servers in `tests/code_mode_openapi_integration.rs`.
The generators read parity sources with
`git show main:<path>` and use installed oracle dependencies without modifying
another checkout.

Run `bun rust/crates/core/tests/generate-string-core.ts` from the repository root
to regenerate `tests/string-core-corpus.json` from the original String Core
Test262-adapted specification vectors. Generation expands the specification's
dynamic inputs and expected assertions, without taking expected values from an
interpreter execution. The source attribution and BSD terms are in
`packages/codemode/test/string-core-test262.test.ts` and its `LICENSE.test262`.

## Tool invocation and materialization

`tools::registry::Registry` takes an explicit output Store, optional resolved
configuration, image limits, and the owning runtime's locale comparator. It owns
atomic registration batches and scoped overlays. Dropping a registration reveals
the preceding definition. Tool names normalize by UTF-16 code unit; dotted
namespaces validate before installation. Direct `execute` registration is reserved.
Materialization sorts direct definitions, filters only wholly denied capabilities
using the last matching action rule, and captures the advertised handlers rather
than consulting later registrations during settlement.

`tools::context::Context` carries the Session, agent, message, and call identities,
cancellation, and optional progress delivery. `DynamicTool` supplies already
projected output; `TypedTool` decodes inputs and encodes outputs before projection.
`tools::materialization` runs ordered scoped hooks, normalizes inline image content
and progress, bounds successful output through the real managed output Store, and
returns typed unknown-tool and execution settlements. Storage failures, defects,
and cancellation propagate independently from model-visible tool failures.

`builtin::execute` adapts captured Code Mode registrations to the native confined
interpreter. Its provider definition is catalog-independent. Nested calls retain
the outer invocation identity, collect inline files in invocation order, settle
running call statuses as errors, and format values, warnings, and logs without
discarding UTF-16 string content. Nested calls do not run outer registry hooks or
perform separate generic output retention.

`builtin::{read,read_filesystem,write,edit,patch,search,webfetch,websearch,http_body,worktree,memory,project_artifact}`
expose real filesystem, mutation, search, Git worktree, and HTTP adapters. Leaves receive captured
`context::policy::LeafPolicy` services; catalog visibility never substitutes for
execution permission or guardrail admission. Read pages stop decoding after the
selected page, retain UTF-16 line truncation, and cap media ingestion. Writes reuse
the filesystem mutation service's BOM and serialization rules. Edit replaces
unique exact matches by default, preserves BOM and line endings, and commits only
when the source content is unchanged. Grep authorizes
every matched file before returning text and accepts only the exact managed-output
file namespace outside the Location. Webfetch authorizes each redirect, rejects
unsupported MIME types, and bounds response bodies. Websearch consumes explicit
operational configuration and endpoints, sends the Exa or Parallel wire contract,
and excludes credentials from settlement and transport diagnostics.
`websearch::WebSearch::new` builds the standard native HTTP client and provider
endpoints and derives the current UTC year. `ShellTool::tool_definition` exposes
the shipped shell schema without opening a Location shell.

Edit and patch share `platform::diff`, which ports `diffLines`, `structuredPatch`,
`createTwoFilesPatch`, and `formatPatch`; patch parsing, fuzzy line derivation, and
BOM joining live in `platform::patch`. Patch validates all targets and requests
edit permission plus a file-mutation guardrail reservation before sequentially
applying its prepared changes.
Memory delegates Markdown validation, digest fences, trash, graph export, and
vacuum to `resources::memory::Service`; reads and vacuum previews remain read-only,
while mutations reserve the `file_mutation` guardrail. Project-artifact automatic writes
delegate lifecycle, quotas, validation, and persistence to
`resources::project_artifact::store::Service`, reject unstable project identity,
and reserve `project_artifact_mutation` before creating a trial artifact.

`builtin::skill` renders local skill instructions, samples supporting files, and
reads a supporting resource against an explicit held activation. It does not fold
Session history, persist activation, or implement MCP skill loading.
`context::consumers::{ReadInstructions,SkillHistory,SessionTools,ControlTools}`
defines the owning consumers. Composition supplies their real implementations;
the registry installs no default Session, control, MCP, or resource handlers.
`builtin::shell::ShellTool` is the model-callable `shell` tool over
`platform::shell::Shell` (`shell.tool.json` carries the committed description and
schemas; register it with `Options::direct()`). Its fields are the Location `Shell`,
the loaded `Configuration`, `Paths`, the shared `LeafPolicy`, a `Jobs`
implementation, and the foreground auto-background duration (`AUTO_BACKGROUND`,
five minutes). One call resolves `workdir` through `Paths::resolve`, prepares the
process (a required sandbox fails closed with no permission request or spawn), asks
`external_directory` for an external workdir, records advisory warnings for absolute
command-argument paths outside the workdir, asks the `shell` permission with the
command as resource and save pattern, requires a directory workdir, and reserves
the `shell` guardrail (ordinary and hard reviews) before creating the process.
Failures other than invalid input, sandbox/memory-limit unavailability, and guardrail
rejection settle as `Unable to execute command: <command>`. Settlement reads at most
`MAX_CAPTURE_BYTES` of the capture file and appends the saved-file path when output
exceeds it; the registry then bounds oversized text through the managed output
Store. A timeout or memory-limit kill settles with its own message and flag, and
`exit` is reported otherwise. A running foreground call reports bounded output
progress once per second and removes its process when the call is cancelled.
Background execution (`background: true`, a signal on the `Notify` handed to
`Jobs::foreground`, or the foreground deadline for commands whose timeout exceeds
it) returns the shell ID, marks the completion notice owed in the shell ledger, and
detaches a task that releases the guardrail reservation, delivers
`Notice::Completed` through `Jobs::deliver`, and marks the notice admitted only
after delivery succeeds. A deadline transfer also delivers `Notice::Steer`. `Jobs`
also owns the `Lease` that keeps a foreground or background shell counted as
outstanding work; the tool does not create or schedule jobs itself.

`builtin::browser::Browser` and `builtin::computer::Computer` adapt the browser and
computer tool bodies to registry tools. Their descriptions and input/output
schemas are the committed TypeScript tool definitions (`browser.tool.json`,
`computer.tool.json`, generated from `Schema.toJsonSchemaDocument` of the tool
input and output). Register them with `Options::direct()`; they are not Code Mode
callable. `Browser` takes `Arc<dyn Paired>`, an optional `Arc<dyn Isolated>`, `Paths`,
and the shared `LeafPolicy`; `Computer` takes the Location `computer::service::Service`.
Each call builds a per-call policy adapter: permissions keep the blocked,
corrected, and fault distinctions the boundary relies on, guardrail reservations
carry the boundary's `skip_review` flag (`LeafPolicy::reserve_with`), and path
resolution reuses `Paths::resolve`. The adapter is not a Location composition
root; callers supply the services.

`builtin::mcp::McpTools::start(service, registry, policy, background)` registers the
live `resources::mcp::Service` tool catalog in the registry and keeps it current:
it reconciles once, then again on every `Event::ToolsChanged` or lagged event
subscription, installing one batch before the previous registration is dropped so
tools never disappear mid-swap. Each server registers under the namespace
`normalize_name(server)` with the server's `codemode` flag (the first tool's value;
absent means Code Mode callable; `false` advertises the tools directly as
`<namespace>_<tool>`). Tool descriptions, input schemas (forced to
`additionalProperties: false`), and output schemas come from the MCP catalog. Every
call asserts the permission action `<namespace>_<tool>` with resources and save `["*"]`
before any request; a rejected or blocked assertion reports `Unable to execute
<action>` and never reaches the server. Tools whose names contain a
shell/exec/command/run/process-style word (`mcp::backgroundable`) also reserve the
`mcp_execute` guardrail for `<server>/<tool>` with the argument names. Results map as
follows: `isError` fails with the trimmed text (or `MCP tool returned an error`);
text parts join with newlines; structured content wins over text, an empty result
is `null`; media parts become `data:` file content; an unavailable server reports
`MCP server "<name>" is not available`. A `background: true` argument is always
stripped from the arguments. `background` is an optional `Background { jobs, notifier }`.
Without it the argument is stripped, `background` is not advertised, and every call
runs in the foreground. With it, backgroundable tools advertise `background`, and
every call runs as a `job::Jobs` job (id: the call id; kind: the permission action;
title: `<tool>` or `<tool> (<argument names>)`; metadata `sessionID`) that holds
its guardrail reservation until the call ends. The foreground call blocks on the
job for its Session; cancelling the call context cancels the job and fails with
`Failure::Cancelled`. A `background: true` call, or a running foreground call moved
by `Jobs::background` / `Jobs::background_all(session_id, ..)`, returns `The MCP
tool was moved to the background.` and delivers one `Notification` when the job
settles: state `completed` (text: the joined text parts), `error` (the error
text, or `MCP tool failed`) or `cancelled` (`MCP tool cancelled`), wrapped as
`<mcp id state tool>`. A job error fails the foreground call with its message,
a cancelled job fails it with `MCP tool cancelled`, and a client cancellation
keeps `Failure::Cancelled`. A registration failure (for example a server name that is
not a valid namespace) leaves the previous registration in place and ends the
watcher; `is_finished()` reports it and `stop()` returns the error. Composition
owns starting the watcher, supplying the shared `Jobs` and `Notifier`, calling
`Jobs::background_all` when the Session moves blocking work to the background, and
delivering the notification as a Session synthetic message. `tests/mcp_tools.rs` drives a
table-configured Python stdio server (`python3` only).

Run these boundary checks from `rust`:

```sh
cargo test --locked -p ycoding-core --test 'tool_*' --test job --test mcp_tools
```

Regenerate the npm `diff` goldens from the worktree root with
`bun packages/core/script/generate-rust-diff-goldens.mjs`.

The tool checks use real filesystem mutations, store-backed authority, ripgrep,
loopback HTTP, the native Code Mode interpreter, and explicit instruction/history
consumer seams. Their assertions and schema projections derive from committed
TypeScript tool and registry tests; they do not certify a composed Session runner.

## Repository cache

`platform::repository_cache::Service::new(roots.repos.clone(), roots.state.clone(), git)`
is a global owner over the shared `Arc<platform::git::Service>`.
`ensure(EnsureInput { reference, refresh, branch })` is blocking; call it on the
blocking executor from async consumers. The repository parser supplies normalized
host/path identity and the checkout path `<repos>/<host split on :>/<segments>`.
Origins are compared with the parsed actual clone remote, including clone URL
overrides. Stale directories, files, and mismatched or missing origins are replaced.
Clones use depth 100. Reuse without refresh or a requested branch change returns
`Cached` without fetching or resetting. Refresh fetches all remotes with pruning,
force-fetches and checks out a requested remote branch, then resets to that branch,
the default remote branch, the current branch, or `HEAD`, in that order. Clone can
select a tag; refresh of an explicit name requires a remote branch. Empty branch
input is treated as absent. Results include identity, path, status, head and branch;
validation, clone, fetch, checkout, reset, cache filesystem, and lock failures have
distinct error variants carrying the TypeScript boundary's fields and messages.

Every ensure holds a native file lock keyed by `repository-cache:<localPath>` under
`<state>/locks/repository-cache` for that call only, with a five-minute acquisition
timeout. Locks serialize the same target across threads, service instances and
processes without blocking unrelated targets; closing the file releases ownership,
including process exit. Lock files remain as unlocked coordination entries. This
uses native ownership rather than the TypeScript heartbeat-directory lock format.
Composition retains one global service and schedules refresh ensures for accepted
Git sources in each Location's Reference service, keeping its source order,
branch-conflict handling and nonblocking materialization/error reporting.

## Ripgrep binary

`platform::ripgrep_binary::Service::new(roots.bin.clone())` constructs the global
lazy acquisition owner; share it with `Arc` and await `filepath()` when a search
consumer needs the executable. Acquisition first searches `PATH`/`Path` plus the
global bin directory for executable `rg` (`rg.exe` on Windows), then accepts an
existing cached regular file `<cache>/bin/rg[.exe]`. Discovery honors quoted PATH
entries, Unix user/group execute permissions, and Windows current-directory and
PATHEXT precedence. Empty PATH does not search the current directory on Unix.
It does not inspect versions or repair execute permissions on cached binaries.
Successes and failures are retained
for the service lifetime. Concurrent callers share one acquisition; cancellation
of a waiter does not cancel that work. Dropping the owner cancels pending async
work; an already-started blocking extraction finishes its scoped cleanup.

Downloads pin version `15.1.0` and the seven TypeScript architecture/OS mappings,
including Linux x64 musl, Linux arm64 GNU, Darwin arm64/x64, and Windows
arm64/ia32/x64 MSVC. `Target::for_key` exposes their triples, filenames and release
URLs. Archives live temporarily in the bin directory; gzip tar and deflated ZIP
extract into a scoped sibling directory, require the expected
`ripgrep-15.1.0-<triple>/rg[.exe]` file, and copy it to the cache. Unix installs set
mode `0755`. Successful extraction removes the archive best effort; failed
extraction retains it and cleans up its temporary directory.

The standard `HttpDownload` uses validated TLS, permits HTTPS requests and redirects
only, and requires a successful HTTP status. Acquisition rejects an empty body.
The URL and version are pinned, but TypeScript supplies no release checksum or signature;
there is no artifact authenticity check beyond TLS, nor verification of system or
cached executable content. `with_download` supplies an explicit trusted transport
and platform seam for offline stand-ins; production uses `new`, not a loopback
transport. Search composition passes the resolved path to
`platform::filesystem::search::Backend::{Ripgrep,Automatic}` and shares that
Location search service with glob/grep and filesystem consumers.

The focused offline boundaries use local `file://` Git remotes, subprocess-isolated
PATH values and loopback HTTP stand-ins:

```sh
CARGO_BUILD_JOBS=3 ~/.cache/ycoding/cargo-gate.sh cargo test --locked --offline -p ycoding-core --test repository_cache --test ripgrep_binary --test reference_parity --test discovery_repository --test git_parity
```

## Event feed

`event_feed::Feed::attach(&Client)` publishes every durable Session event after its
store transaction commits. `Client::observe_events` runs on the single store writer in
commit order, once per committed transaction, with the events in append order; a
rolled-back or uncertain commit publishes nothing. `Feed::publish` adds ephemeral
events (no durable position, optional Session) to the same total order.

Each published item gets the next feed `position` (1-based, per feed instance). The
feed retains the newest `RETAINED_ITEMS` items. `Feed::subscribe(scope, after, wake)`
registers atomically under the feed lock: `after: None` is live-only, and
`after: Some(position)` first replays the retained items after that position, so a
resume has no gap and no duplicate. `ResumeError::Gap` reports a cursor older than
retention (or a replay larger than the subscriber capacity) and `ResumeError::Ahead`
a cursor beyond `watermark()`. Positions do not survive a process restart.

`Scope::Global` receives everything; `Scope::Session(id)` receives that Session's
durable events and ephemeral events tagged with it. A `Subscriber` holds at most
`SUBSCRIBER_CAPACITY` items; a subscriber that falls further behind is removed and
`next()` reports `Overflow`, without blocking publishers or other subscribers. `wake`
runs outside the feed lock after each matching enqueue and on overflow. Dropping the
`Subscriber` unsubscribes.

The runtime serves `event.subscribe` (Global or one Session) from this feed. The v5
wire carries only `SessionLogItem`, so events without a v5 representation (ephemeral
events and unrepresentable durable types) are skipped, and a subscriber overflow
closes the connection with the `Limit` category. `session.log` with `follow` re-reads
the durable log only when the feed reports a new event for its Session. The runtime's
`Core` wraps the injected Location `Publisher` so every event the Location services
emit through it (such as `permission.asked`) and the `todo.updated` that
`session.todo.update` publishes after `Service::update_todos` are also published to the feed as an ephemeral event tagged with the payload's `sessionID`.
Feed subscribers receive them; wire subscribers do not, for the reason above. Boundary
checks:

```sh
cargo test --locked -p ycoding-core --test event_feed
cargo test --locked -p ycoding-runtime --test events
```

## Built-in agent catalog

`builtin::catalog(&Roots)` returns the sixteen built-in definitions in registration order. It reads embedded Markdown metadata and role text, composes the shared project and capability fragments, and expands the shell-output and temporary-directory permission resources from the supplied roots. Invalid Unicode paths return `discovery::Error::InvalidPath`.

`Service::new` starts with exactly the supplied definitions. Use `Service::from_entries` to apply discovered agent documents to the built-ins. User and project documents retain discovery order; narrower documents override only specified scalar fields. Request headers and bodies merge shallowly, while model references replace as a complete selection including profile and variant. All document-level permissions precede every agent-specific permission. Home expansion applies only to `external_directory`, `read`, and `edit` resources. Disabled definitions are removed, and later documents may define the same identity again. Absolute source paths accumulate without duplicates in `locations`.

`Service::list` places the effective default first: the selectable configured default, then selectable `god`, then the first selectable definition. Hidden helpers, subagent-only definitions, and `btw` cannot become the selectable default. Explicit unknown selections retain their identity and have no resolved definition.

The eight visible role prompts are composed as shared project guidance, trimmed Markdown role text, and capability guidance separated by two newlines. Primary definitions include the background notice followed by main-session controls; subagents include child controls. The BTW and seven hidden helper prompts are standalone. Built-in permissions preserve ordered rule evaluation, including the helper's final all-tools deny and BTW's approval requirements for mutation.

The eight role prompts carry the shared checkpoint-testing cadence: design cases
before building, build a complete milestone with its tests, run focused tests at
feature checkpoints, and run affected full checks at integration. IDs remain
stable (`god`, `architech`, `zeus`, and `GSD`); catalog names and encoded agent
projections display `God`, `Architech`, `Zeus`, and `GSD`. Prompt bytes and metadata
are checked against the TypeScript reference and fixed SHA-256 fixtures.

```sh
cargo test --locked -p ycoding-core --test builtin_agents
```
