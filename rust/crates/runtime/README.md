# Local wire runtime

## Launcher and disposable readiness harness

`ycoding-runtime [serve] --service` composes the production Core and Store, installs Core observability, serves authenticated `/health`, the TypeScript discovery endpoint `/api/health`, the exact-instance stop endpoint `/api/service/stop`, and `/ws/v5/local`. Its atomic private registration is the complete service-discovery contract. The executable needs no files beside it. Distribute it only as an embedded CLI payload extracted to a versioned path; never add a release-archive entry. `--stdio --port 0` publishes one JSON readiness line and exits when stdin closes. See [runtime configuration](../../../docs/configuration.md#rust-runtime-executable) for flags, paths, authentication, contention, and shutdown.

`YCODING_CHANNEL=beta ycoding-runtime --paths` is the shared namespace/path authority for the Rust runtime and beta TypeScript CLI. It prints resolved JSON without creating files. Beta uses `ycoding-beta`, imports stable SQLite only through a private copy, and retains a completion marker and verified Store provenance for retry-safe first start.

`tests/support/launcher.rs` provides disposable temporary-XDG roots, real-binary spawning, bounded readiness, registration reads, and child cleanup for Rust tests. `tests/support/launcher-client.ts` provides the same registration-driven fixture to TypeScript tests and exposes its `configDir`. It creates that directory initially empty, starts the runtime with it as `YCODING_CONFIG_DIR`, and removes it with the owned fixture root on teardown. Managed startup persists its private service configuration there; test commands can write `ycoding.json` or `ycoding.jsonc` into the same runtime configuration directory.

`tests/support/ready-runtime.ts` runs a supplied test command against a disposable ready production runtime. It exports `YCODING_V5_TEST_URL`, optional `YCODING_V5_TEST_PASSWORD`, and `YCODING_V5_TEST_CONFIG_DIR` for the client Rust integration and TUI native browser/custom-endpoint suites; those commands need no persistent server:

```sh
CARGO_BUILD_JOBS=3 ~/.cache/ycoding/cargo-gate.sh cargo test --locked --manifest-path rust/Cargo.toml -p ycoding-runtime --test launcher
YCODING_TEST_RUST_RUNTIME="$PWD/rust/target/debug/ycoding-runtime" bun test --cwd packages/client ../../rust/crates/runtime/tests/support/launcher-client.integration.test.ts
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

```sh
cargo test --locked -p ycoding-runtime --test catalog_ops
cargo test --locked -p ycoding-core --test generate_text
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

## Session ingress

The standard dispatcher registers `session.command`, `session.shell`, `session.skill`, `session.skills`, `session.resolveSkillConflict`, `session.compact`, `session.generate`, `session.move`, `session.switchAgent`, `session.switchModel`, and `session.subagent.launch`. Each resolves the Session's backend Location, then `CatalogServices.session`:

- `runner`: the Location's `session::runner::Local`. Its Location and `models` Arc must equal the catalog's.
- `generate`: the Location's `session::generate::Service`, with the same Location.
- `destination`: optional `DestinationServices` for `session.move`, `resolve: Fn(location::Ref) -> Boxed<Result<location::Info, String>>` and `invalidate: Fn(location::Ref) -> Boxed<Result<(), String>>`. Production composition supplies both.

Absent or disagreeing owners return a declared typed unavailable failure.

- `session.command` admits one prompt per message ID under a per-ID lock. A reused ID returns the admitted record without evaluating again. The command agent wins over the requested agent; the model is the command model, then the command agent's model, then the requested model. Agent and model switches complete before admission; a failed model switch is a `CommandEvaluationError`. Commands absent from the catalog evaluate a matching sanitized `server:prompt` MCP prompt through the Location MCP service. Attachments materialize like `session.prompt` attachments before evaluation, and only when the message ID is not yet admitted. Managed commands, agent selections, and Skill loads record project-artifact provenance and activations through the runner store's artifact source (Core README, "Session operation attribution").
- `session.shell` reserves the Session transition, waits for the drain to go idle, asserts the `shell` guardrail, runs the command in the Session directory, and publishes `session.shell.started.1` and `session.shell.ended.1` with up to 1 MiB of output. Optional-sandbox warnings are projected as `metadata.sandboxWarnings` on the Shell message; they are not stored on the event row. A required sandbox without a backend fails before any message. Execution wakes afterwards.
- `session.skill` refuses denied or unknown skills as `SkillNotFoundError`, publishes one activation per active skill, and resumes the Session in the background unless `resume` is `false`. `session.resolveSkillConflict` deactivates the loser of an active skill conflict with reason `conflict_resolved`.
- `session.compact` never interrupts the drain. Under the Session compaction gate it joins a pending job or admits a manual one, then runs it to settlement. Conflicts, including a missing completed boundary or an unresolvable model, return `ConflictError`.
- `session.switchModel` runs inside the Session transition. It resolves the target with a fresh profile binding and refuses a nonpositive input budget before interrupting work. It then interrupts, checks the fit against the target lowering, and compacts at most once with a mandatory job. It returns `ModelSwitchBlockedError` with the pre-compaction metrics when the history still does not fit. Selection publishes `session.model.selected.1` plus `session.profile.bound.1` when a profile is bound or cleared. Resolution and compaction failures return `UnknownError` with a reference; an unavailable profile returns `InvalidRequestError` on `model.profile`. Variant and provider-package failures share the `model-unavailable` category.
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
