# Local wire runtime

## Provider configuration boundary

`provider.configure` registers an OpenAI-compatible custom endpoint with explicit Chat/Responses selection, configured models or an optional OpenAI model-list source. Localhost endpoints use the same boundary. Credential connection follows successful configuration reload and integration registration; secrets stay out of the configuration RPC. `plugin.list` reports active capabilities from the Location generation, including only the six native provider plugins: Anthropic, Cursor, Muse, OpenAI-compatible, OpenAI and OpenRouter.

Dropped built-in provider declarations produce nonfatal config diagnostics and are excluded from the effective catalog while other document settings load. A dropped package on one model excludes that model without dropping kept siblings. Saved credentials remain stored; excluded accounts do not trigger model discovery. Unknown executable packages and unsafe configuration remain subject to the existing rejection rules.

## Launcher and disposable readiness harness

The CLI passes `--frontend-executable <absolute path>` to identify the installed frontend owning native assets. The extracted runtime resolves `YCoding Computer Use.app` only beside that frontend executable, not beside its own extraction path. A direct runtime launch without the flag keeps serving but helper-dependent computer operations return `helper_unavailable` with the missing flag named. No environment variable or executable-relative fallback supplies the asset owner.

`ycoding-runtime [serve] --service` composes the production Core and Store, installs Core observability, serves authenticated `/health`, the TypeScript discovery endpoint `/api/health`, the exact-instance stop endpoint `/api/service/stop`, and `/ws/v5/local`. Its atomic private registration is the complete service-discovery contract. The executable needs no files beside it. Distribute it only as an embedded CLI payload extracted to a versioned path; never add a release-archive entry. `--stdio --port 0` publishes one JSON readiness line and exits when stdin closes. `--meeting`, off by default, starts one Meeting runtime for each Location the server composes, matching `serve --meeting`. That runtime uses the Location's Meeting directory, lock and loopback bridge, survives Location reload, and stops before Session execution at shutdown. Each such Location adds the hidden `meeting-intelligence` agent, the `meeting_history` tool and the analysis restriction to its runner; analysis Sessions run through the process-global Session execution. A Location whose Meeting runtime fails to start logs the failure and keeps serving without it. See [runtime configuration](../../../docs/configuration.md#rust-runtime-executable) for flags, paths, authentication, contention, and shutdown.

Each production Location generation composes its configuration, catalogs, platform services, tools, runner, and process extensions together.

Catalog, agent, command, reference, skill, configuration, integration, MCP, shell and PTY event sources belong to one Location generation and publish into the shared Core feed with that Location reference. The global account-discovery cache retains catalog facts, not a Location's publisher; cache hits return a distinct Catalog event source. Global model-discovery events retain global scope. Reload keeps held generations' publishers scoped to their original Location and gives the replacement generation its own publishers; no source is rebound or shared across Locations.

- **Configuration reload:** the generation watches its configuration directories and files. A debounced change rebuilds the Location only while that generation is current, and publishes `config.updated` after the replacement. Calls holding the earlier generation keep its snapshot. A failed rebuild keeps the current generation, and its watcher keeps watching.
- **Managed artifacts:** a project-artifact source per Location overlays managed agents, commands, and skills onto the discovered catalogs before permissions and the runner see them. Its governor records terminal accounting against one process-wide accounting service and source registry.
- **Source ownership:** each generation retains its registry registration. Retired generations update and release only their own registration; closing a failed replacement restores the held predecessor, and closing a predecessor preserves the current snapshot. The shared artifact Store exposes its attached accounting service for Session movement.
- **MCP tools:** a watcher registers the configured MCP tool catalog and keeps it current. Background MCP calls run as Execution jobs and report completion to their Session.
- **Session tools:** the generation binds subagent launch/control/report, goal, question, decision, todos and verified completion to the shared execution and orchestration owners. Root Sessions do not advertise the managed-child report tool. The compaction Advisor observes assembled requests and settles rising-edge advisory work without exposing a model tool.
- **Browser and computer tools:** direct-only tools share the process-wide pairing/admission and native computer coordinators. Composition does not start Chrome or the native helper. Session movement, deletion and archive release claims; execution settlement relinquishes paired control, and Location close releases isolated browsers and native Location claims.
- **Process extensions:** configured extensions launch under configuration trust. A configured `extension.launch` or family-grant rule that denies or asks fails closed. The failure is logged and appears in `config.diagnostics` as a fail-closed `extensions` diagnostic. Active extension identities appear in `plugin.list`.
- **Runner inputs:** the runner receives the generation's configuration, image analyzer, Git snapshots, and extension handles. Provider attempts to process-supplied packages are authorized against the calling Session.
- **Project copies:** the first boot of a Location refreshes project copies in the background.
- **Location close:** closing a Location stops its watchers, extensions, MCP tool watcher, and artifact governor, then its MCP, shell, PTY, browser, and integration owners.

Production shutdown stops Meeting runtimes, Session execution, Jobs, the maintenance workers, Locations, the process-global owners, credentials and finally the composition runtime; the caller closes the Store last. A bootstrap failure releases every owner it started in that order and returns the original error. Startup settles interrupted Steps, the shell ledger and stale tasks and drains the subagent notification outbox before serving; it never replays a provider attempt. Later durable task updates drain the outbox again, and a failed drain is retried on the next update.

Production catalogs include the Location runner and transient Session generator. Destination resolution records the backend-resolved Project; invalidation retires the cached generation without revoking held calls. The executable owns the remote connector, starts it with the same Core owners and an independent connection-scoped subscription/upload environment, and joins it before Core and Store shutdown. Remote access remains off until the persisted machine preference enables it. Core starts one analytics report Engine on the composition owner thread; telemetry and usage report reads share that Engine. Startup does not wait for the analytics purge/rebuild: a background maintainer runs them and retries failures with a diagnostic log, report reads return the analytics unavailable error until the rebuild succeeds, and Session admission and canonical redb reads never wait on DuckDB.

Session movement resolves the destination's filesystem Project identity, records
that Project, adopts its previous artifact scope and completes the post-commit
scope marker before interrupting active execution. Cross-Project moves retire the
destination generation, compose its default agent, and use the shared artifact
accounting owner to close the old Project's open Session activations atomically
with `session.project-artifacts-ended`. A project-scoped current agent selects the
destination default before `session.moved`; standard and global selections stay
unchanged. Same-Project movement skips deactivation and reselection, and an
unchanged Location publishes nothing. Later failures preserve earlier committed
adoption and publications; requests report the failure rather than replaying them.

`YCODING_CHANNEL=beta ycoding-runtime --paths` is the shared namespace/path authority for the Rust runtime and beta TypeScript CLI. It prints resolved JSON without creating files. Beta uses `ycoding-beta`, imports stable SQLite only through a private copy, and retains a completion marker and verified Store provenance for retry-safe first start.

`tests/support/launcher.rs` provides disposable temporary-XDG roots, real-binary spawning, bounded readiness, registration reads, and child cleanup for Rust tests. `tests/support/launcher-client.ts` provides the same registration-driven fixture to TypeScript tests and exposes its `configDir`. It creates that directory initially empty, starts the runtime with it as `YCODING_CONFIG_DIR`, and removes it with the owned fixture root on teardown. Managed startup persists its private service configuration there; test commands can write `ycoding.json` or `ycoding.jsonc` into the same runtime configuration directory.

`tests/support/ready-runtime.ts` runs a supplied test command against a disposable ready production runtime. It exports `YCODING_V5_TEST_URL`, optional `YCODING_V5_TEST_PASSWORD`, and `YCODING_V5_TEST_CONFIG_DIR` for the client Rust integration and TUI native browser/custom-endpoint suites; those commands need no persistent server:

```sh
CARGO_BUILD_JOBS=3 ~/.cache/ycoding/cargo-gate.sh cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-runtime --test launcher
YCODING_TEST_RUST_RUNTIME="$PWD/rust/target/debug/ycoding-runtime" bun test --cwd packages/client ./test-integration/launcher-rust.integration.test.ts
bun run rust/crates/runtime/tests/support/ready-runtime.ts "$PWD/rust/target/debug/ycoding-runtime" bun run --cwd packages/client test:integration:rust
```

## Location catalog services

`Core.catalogs` resolves `CatalogServices` from the canonical, backend-resolved `Location.Info`. Requests must have Location scope, and an explicit request directory must agree with that scope. The resolver supplies the same `Arc<model::Resolver>` and `Arc<agent::Service>` as the Location runner, the discovered command/reference/skill services, configuration diagnostics, and active built-in/process-extension IDs. It does not build a catalog during a request.

The standard dispatcher registers `provider.get`, `provider.integrations`, `provider.list`, `provider.refresh`, `model.default`, `model.list`, `agent.list`, `command.list`, `config.diagnostics`, `plugin.list`, `reference.list`, `skill.list`, and `generate.text` for the existing LOCAL_CLIENT descriptors. An absent resolver or an unavailable Location returns a declared typed failure.

Supply `ready` from Location initialization and `refresh` from its configuration reload and best-effort model-discovery lifecycle. Default-model and provider-integration reads wait at most five seconds for initialization and resolve the service snapshot again afterward. Other reads do not wait for refresh. Refresh must replace the runner and catalog snapshot coherently and publish the normal catalog update notification; discovery failures preserve usable prior state. Skill reads use the shared service's network memoization while rereading files on each list.

`skill.list` projects `Skill_Info.scope` with `skill::scope` from each skill's `location`: `PROJECT` when the Location's project directory contains it, otherwise `GLOBAL` when `<home>/.agents/skills`, `<home>/.claude/skills` or `<config>/skills` from `CatalogServices.roots` contains it, otherwise absent. Containment is lexical and component-wise, and a project directory that is not valid Unicode contains no skill. The shared `Location_Info` conversion omits `backendPaths`.

`CatalogServices.models` and `CatalogServices.generate.models` must be the same Arc; requests reject divergent services. Generation uses the runner's credential service, integration registry, provider Executor, and optional Cursor host. Its selection retains provider, catalog model, profile, and variant, while provider requests use the API model identity. It makes one stateless provider generation and stores no Session messages. Named-profile or variant failures do not switch models or accounts. Muse receives its credential snapshot; Cursor uses the supplied native route host.

Wire conversion preserves complete model/default selection metadata, optional values, ordered permissions, and lossless strings. Secret-bearing configuration keys are excluded recursively from provider/model/agent request overlays; provider execution errors expose a fixed message and provider identity, not raw payloads or headers.

The replacement extension contract exposes loaded IDs through `plugin.list`; do not execute npm plugin entrypoints to populate it.

`session.status` omits Sessions deleted between inventory listing and lifecycle
reads. Store and lifecycle decoding failures still fail the read.

```sh
cargo test --locked -p ycoding-runtime --test catalog_ops
cargo test --locked -p ycoding-core --test generate_text
```

## Backend configuration operations

The standard dispatcher serves `provider.configure` (2060), `mcp.configure`
(2061), and `frontendPackage.resolve` (2062). All require LOCAL_CLIENT and a
backend-resolved Location; remote-client and relay dispatch reject them.
`Core.platform` supplies the generation's configuration and cache roots,
`Core.catalogs.refresh` replaces its configuration/catalog generation, and
`Core.integrations` supplies the resulting real registration. Configuration
scope selects a backend global/project target independently of Location scope.

Production attaches `Configuration::with_mutation_policy(...)` while building
each generation and permits global writes, project writes and registry
presentation-package installation. Non-production constructions deny them until
an explicit mutation policy grants the corresponding operation. Location/path
validation and package validation still apply; a project-only grant never
authorizes a global write.

Provider configuration preserves JSONC, selects the native compatible or Runpod
implementation, validates collisions, reloads and confirms real integration
registration without client polling. It neither writes credentials nor activates
a profile. Those actions remain on `integration.connect.key` and
`credential.activate`. MCP configuration preserves JSONC and persists the typed
definition before reload. Global nested `.ycoding` targets participate in global
discovery after the top-level global files. Reload success does not assert that an external MCP
server connected. `mcp.add` remains live-only.

Pre-write failures return `ConfigurationWriteError`; a completed write followed
by failed reload or registration returns `ConfigurationPartialFailure` with its
target and stage. Results and errors contain no MCP environment, headers, OAuth
secret, raw error text or subprocess output. Cancellation/transport loss may
leave an uncertain mutation; do not automatically replay it.

Package resolution uses Core's `resources::frontend_package`, not the extension
supervisor. Installation requires `npm` on the backend PATH, uses its npm
configuration, installs dependencies with lifecycle scripts disabled, and returns
a verified backend-local descriptor with archive and entrypoint SHA-256 digests.
Cache reuse revalidates the archive and installed files. Assets are absent. A
same-host TUI may load that entrypoint; this grants neither remote asset transfer
nor backend JSX/plugin execution.

`tests/config_ops.rs` exercises all three operations through real production
composition, registration and MCP read models, plus closed partial failures,
scope policy and remote rejection. Its presentation fixture is packed and
installed locally with npm offline; no registry traffic is used.

```sh
cargo test --locked -p ycoding-runtime --test config_ops
```

## Location resources and debug reads

`fs.read` resolves the request Location through `Core.platform` and serves one file through `PlatformServices.filesystem` as an asset with its extension MIME type. Paths that escape the Location lexically or through a symlink, directories, missing files and a request directory that disagrees with the scope return `InvalidRequestError`.

`location.get` returns the backend-resolved Location and its Project with `backendPaths`: `home`, `state`, `config` and `worktree` (`<data>/worktree`) from the Location configuration roots. No other `Location_Info` projection carries `backendPaths`. When the Location directory is a directory, the read records it like TypeScript `Project.recordOpened`: one transaction inserts the Project row if absent and a `project_directory` row with no type or strategy if absent.

`session.attachment.read` acquires the Session's backend Location, roots the managed attachment Store at the configuration data root, and serves `session::attachment_read` as an asset. Invalid digests return `InvalidRequestError`, unknown Sessions `SessionNotFoundError`, unreferenced, foreign or failed-verification digests `AttachmentNotFoundError`, and references above 10 MiB `AttachmentTooLargeError`.

`debug.location` lists the cached Location keys. `debug.location.evict` removes the canonical key for the request Location scope; held leases keep their service set, the next acquisition builds a new one, and durable history is unchanged.

## Location Project identity

`Locations::location` resolves the Project with `platform::project_identity::resolve`, as TypeScript `Project.resolve` does, so a never-seen directory opens without a stored row. A recorded Project for the directory (a Session in it, a `project_directory` row, or a Project worktree) takes precedence only when its ID differs from the resolved ID; it then keeps that ID and its recorded worktree so Sessions, permissions and artifacts already bound to it stay attached. When the IDs agree, the resolved worktree is the Project directory, so a linked worktree copy reports its own root. A root `session.create` inserts the Location's Project row if absent, without a directory row.

## Remote device enrollment and connector

`Control::open(state)` composes `Core.remote` from `<state>/remote.json` (the enable preference) and `ycoding_core::remote::Device` over `<state>/remote-device.json`, where `state` is `Roots.state`. Start the outbound connector with `Settings::new(Arc::new(control.device().clone()))`. `Device` implements `Credentials`; the connector resolves `enrolled()` and `access()` on every connection attempt, so an enrollment made after startup is used by the next `remote.set { enabled: true }` without a restart.

`remote.enroll` (LOCAL_CLIENT only) normalizes the relay origin, checks the enrollment-code format, rejects an existing enrollment unless `replace` is true, generates a P-256 device key, enrolls with the relay and stores the identity. Its result and `remote.get.device` are the redacted `RemoteDevice`; failures settle as `RemoteEnrollmentError` codes, or `RemoteEnrollmentPartialFailure` with the relay-assigned device when local persistence fails after the relay enrolled it. A missing machine name is `InvalidRequestError` on `payload.name`. Enrollment does not change the enable preference.

`Enrolled` binds the relay-assigned device ID and the pinned relay origin. `Credential::authenticate` rejects a credential for another device or minted at another origin as `Forbidden` and an expired credential as `Unauthorized`; the agent socket URL derives from the enrolled origin. The device holds no account identity: the relay's enroll response carries only `deviceID` (`packages/remote/src/index.ts:1263`) and its token and refresh responses carry only tokens and expiries (`:1281`). The relay enforces account ownership by taking `ownerID` from the authenticated device credential and routing to the `${ownerID}:${deviceID}` relay instance (`infra/cloudflare/src/router.ts:601`, `:644`, `:663–667`).

Relay refusal of a credential (401, 403 or 410) maps to `Unauthorized`, which stops the connector until the next enable; `remote.get` reports `credentialState` revoked for that device until a new enrollment. Store and enrollment-state failures map to `Setup`; other relay failures map to `Transport` and back off.

The binary v5 connector derives Session interest from relay-owned `SubscriptionSnapshot` controls. It accepts each typed Session target through the backend before registering its subscription identity, shares one bounded global event observer across the union, and releases that observer when the last accepted interest leaves or the connection ends. Repeated clients use the same accepted identity without replacing its queued events. Remote `event.subscribe` requires identical Session targets in the outer scope and typed payload; unknown Sessions return a typed failure without registering interest.

Each new union interest advertises the backend process source epoch with `ResyncRequired` before its subscription Result. Successful Result handoff settles that RPC against the registered identity using the explicit canonical epoch. Public durable and ephemeral events use the same encoder as the local event stream; events wait for subscription settlement, remain ordered, and retain protocol delivery charges until relay consumption. Queue pressure retains one held feed item and stops draining the bounded observer; observer overflow ends the connection for reconciliation. Inventory invalidation has a separate filtered observer. Remote finite `session.log` streams are unavailable.

`tests/connector_relay.rs` starts disposable workerd/D1 through the connector-specific Bun harness, enrolls the real Rust device through `/api/devices`, and verifies the Rust AGENT connection, shared subscriptions, canonical epochs, ordered live/durable delivery and release with REMOTE_CLIENT peers. Install tooling in this checkout with `bun install --frozen-lockfile`; the harness stops its Worker on exit and retains diagnostics in its worktree-owned scratch directory. It waits for the relay's `/api/devices` online state, which proves receipt confirmation beyond the initiator's local `State::On`.

```sh
~/.cache/ycoding/cargo-gate.sh cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-runtime --test connector --test connector_events --test connector_relay --test remote_derived --test remote_enroll
```

### Connector notifications

Each connection publishes the v5 `Status` and `Completions` controls from fresh runtime state. Status derives running, outstanding, lost and failed root families from Core's outstanding read, coalesces changes at 250 ms, and suppresses unchanged frames. Permission, question, form and family guardrail reads use cached Locations and Locations marked by active Sessions or request events; unrelated idle Session directories are not resolved. Pending requests in cached Locations remain visible after reconnect even when their Sessions are idle. Request attention, failed roots and lost roots merge into the bounded attention set, with sanitized root titles and permission-before-question-before-review need precedence. Request and lost attention take precedence over the failed marker.

Completion synchronization replays root-only pages of at most 200 durable receipts in Session-ID order, with `more` marking continuation. A receipt observed during the baseline restarts replay; after baseline settlement, live `session.work.completed.1` receipts are forwarded individually. Read and enqueue failures defer retry on the same connection. Reconnect replays the baseline and current status without replaying mutations.

An oversized subscribed event emits a scoped `ResyncRequired` after the preceding scoped event receipts settle. The relay distinguishes this same-source-epoch invalidation from backend epoch replacement, forwards it only to accepted subscribers of that Session, and keeps its projection-free forwarding owner ready for later events. Each affected client owns canonical snapshot/bulk hydration; unrelated subscriptions and connection epochs stay intact. A genuinely changed backend epoch retains the existing replacement behavior. Status and inventory invalidations skip clients whose handshakes have not established; the latest cached status is delivered when a client establishes.

`tests/connector_status.rs` covers family aggregation, request precedence, failure attention and reconnect. `tests/connector_relay.rs` drives real request state and Core-validated completion receipts through the Rust connector and local workerd, verifies relay attention/completion notices, and decrypts intercepted Web Push records to assert both notification categories and their Session identity. The model/tool exchange is a durable-event fixture; the real Core completion validator owns receipt publication.

The real-workerd test also publishes a projected 2,320,000-character assistant text event, verifies scoped resync and exact canonical typed-bulk recovery, and proves that the affected stream resumes while another Session keeps delivering with unchanged browser connection epochs.

## Remote request placement

Remote dispatch resolves placement from backend state, independently of local
Location scopes. Session scopes use the recorded Session Location and reject
deleted or unavailable placements. Form scopes name the owning real Session,
not a Form ID or the local global sentinel. Advertised workspace scopes use the
current workspace inventory and revalidate its Project before dispatch.
Machine-scoped provider quota reads use the backend process working directory
with no workspace identity, matching the TypeScript server's default request
placement.

Remote `fs.find`, `shell.output`, `providerUsage.list`, and `session.create`
reject caller-supplied Location fields, including empty Location wrappers.
Filesystem search accepts Session or advertised workspace scope and returns
relative paths with file URIs and no local Location result. Shell output accepts
only its recorded Session owner and omits the local Location result. Provider
quota reads retain the canonical resolved `Location_Info`. Session creation
requires a stable root ID and advertised workspace; reuse must match that
workspace's current placement. Local scopes, path selection, result Locations,
and filesystem entries remain unchanged.

Local Session lists execute the Core query and use its opaque query-bearing
cursors; every nonempty page returns previous and next anchors. Remote Session
lists retain connector paging: pinned/active ordering, status and summary
search, advertised workspace tokens, limits of 1–200, and cursors only where
another page exists. Both use the dispatcher's remote-caller distinction.

`tests/remote_placement.rs` exercises these boundaries with the real Session
store, Location services, filesystem search, shell and quota services through
authenticated connector dispatch.

## Session ingress

`session.autonomy.set` accepts YOLO 0–3 by the selected double's value,
independently of its v5 oneof branch, and emits the first matching branch
(`value_1`) used by the shipped TypeScript domain codec. Literal values are
validated in the runtime; oneof branch ordinals are not numeric literal values.

A nonblank goal string is trimmed and sent to the Location's goal helper for
synthesis and then a `start` user-proxy steer. Both generations must settle with
nonempty normalized text before the autonomy revision-fenced write stores the
raw request and synthesized objective. A concurrent stop or replacement wins
over a late calculation. The start steer is admitted as a synthetic `steer`
input with `Goal · steer` description and autonomy metadata, then execution
wakes. Calculation failures return the v5 `UnknownError` with a bounded public
message and error reference, model resolution failures identify unavailable
goal configuration, and stale calculations return `ConflictError`. No raw
provider failure is returned and no failed calculation replaces the goal or
admits a steer. Null stops and true resumes retain their existing control paths.

```sh
cargo test --locked -p ycoding-runtime --test team --test goal_autonomy
cargo test --locked -p ycoding-core --test session_goal
```

The standard dispatcher registers `session.command`, `session.shell`, `session.skill`, `session.skills`, `session.resolveSkillConflict`, `session.compact`, `session.generate`, `session.move`, `session.switchAgent`, `session.switchModel`, and `session.subagent.launch`. Each resolves the Session's backend Location, then `CatalogServices.session`:

- `runner`: the Location's `session::runner::Local`. Its Location and `models` Arc must equal the catalog's.
- `generate`: the Location's `session::generate::Service`, with the same Location.
- `destination`: optional `DestinationServices` for `session.move`, `resolve: Fn(location::Ref) -> Boxed<Result<location::Info, String>>` and `invalidate: Fn(location::Ref) -> Boxed<Result<(), String>>`. Production composition supplies both.

Absent or disagreeing owners return a declared typed unavailable failure.

- `session.command` admits one prompt per message ID under a per-ID lock. A reused ID returns the admitted record without evaluating again. The command agent wins over the requested agent; the model is the command model, then the command agent's model, then the requested model. Agent and model switch attempts complete before admission. A context-blocked model switch admits the evaluated command on the prior model without a switch-blocked notice; any attempted compaction retains its own lifecycle events. A model resolution failure is a `CommandEvaluationError` with the resolver's message and admits nothing. Commands absent from the catalog evaluate a matching sanitized `server:prompt` MCP prompt through the Location MCP service. Attachments materialize like `session.prompt` attachments before evaluation, and only when the message ID is not yet admitted. Managed commands, agent selections, and Skill loads record project-artifact provenance and activations through the runner store's artifact source (Core README, "Session operation attribution").
- `session.shell` reserves the Session transition, waits for the drain to go idle, asserts the `shell` guardrail, runs the command in the Session directory, and publishes `session.shell.started.1` and `session.shell.ended.1` with up to 1 MiB of output. Optional-sandbox warnings are projected as `metadata.sandboxWarnings` on the Shell message. Live `event.subscribe` delivery enriches `session.shell.started` with this committed projection's metadata through the existing v5 event payload; stored event rows and `session.log` omit publication metadata. A required sandbox without a backend fails before any message. Execution wakes afterwards.
- `session.skill` refuses denied or unknown skills as `SkillNotFoundError`, publishes one activation per active skill, and resumes the Session in the background unless `resume` is `false`. `session.resolveSkillConflict` deactivates the loser of an active skill conflict with reason `conflict_resolved`.
- `session.compact` never interrupts the drain. Under the Session compaction gate it joins a pending job or admits a manual one, then runs it to settlement. Conflicts, including a missing completed boundary or an unresolvable model, return `ConflictError`.
- `session.switchModel` runs inside the Session transition. It resolves the target with a fresh profile binding and refuses a nonpositive input budget before interrupting work. It then interrupts, checks the fit against the target lowering, and compacts at most once with a mandatory job. It returns `ModelSwitchBlockedError` with the pre-compaction metrics when the history still does not fit. Selection publishes `session.model.selected.1` plus `session.profile.bound.1` when a profile is bound or cleared. Resolution and compaction failures return `UnknownError` with a reference; an unavailable profile returns `InvalidRequestError` on `model.profile`. Unavailable models, variants, and provider packages retain distinct `model-unavailable`, `variant-unavailable`, and `unsupported-provider` log categories and the TS server's corresponding user-facing messages. Validation failures leave active execution and durable rows unchanged.
- `session.move` resolves the requested directory against the current Location, resolves the destination, interrupts work, invalidates a destination in another Project, publishes `session.project-artifacts-ended.1` across Projects, and publishes `session.moved.1`.
- `session.switchAgent` refuses the `decision` agent. `session.generate` makes one stateless generation. `session.subagent.launch` preflights and launches a background child with the configured `subagent_depth`.

```sh
cargo test --locked -p ycoding-runtime --test session_ingress
cargo test --locked -p ycoding-core --test session_ingress --test session_compaction_runner
```

## Prompt attachments and uploads

`session.prompt` and `session.command` materialize `files` through the Session's backend Location before admission with `session::attachment_admission`: the managed attachment Store is rooted at the Location configuration data root and image limits come from the Location configuration. A reused message ID returns the admitted record without resolving or importing attachments again. Attachment failures return `InvalidRequestError` on field `files` and admit nothing.

Local clients may attach any `file:`, `data:` or managed URI the backend can read. Remote peers may attach `file:` URIs whose resolved real path lies inside the Session Location, URIs equal to a non-hidden catalog reference or an MCP resource, and `ycoding-upload://` references; anything else returns `Attachment is outside the Session Location and current catalog`. An upload reference resolves only to a completed staged upload of the same Session on the same relay connection and is then imported like any other attachment; an incomplete, expired, replaced or foreign reference returns `Attachment upload is unavailable or incomplete` before admission.

`session.attachment.upload` is remote-only and stages pieces in memory in `Environment.uploads`, a `Staging` owner keyed by connection and upload ID. Pieces of one lowercase UUID v4 upload arrive once, in order, for one Session, with `index` 0–1023, 1–21000 raw bytes, and `offset` equal to the bytes received so far; an upload holds at most 20 MiB, and a connection retains at most 64 uploads and 40 MiB. Intermediate pieces return the received byte count and the last returns `ycoding-upload://<uploadID>`. Repeated, out-of-order and post-completion pieces are rejected. An upload expires 10 minutes after its last piece or resolution, and the connector clears its connection's staging when the connection ends. Errors are `Connector_Error` with code `invalid_message` or `message_too_large`.
