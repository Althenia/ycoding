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

`skill.list` projects `Skill_Info.scope` with `skill::scope` from each skill's `location`: `PROJECT` when the Location's project directory contains it, otherwise `GLOBAL` when `<home>/.agents/skills`, `<home>/.claude/skills` or `<config>/skills` from `CatalogServices.roots` contains it, otherwise absent. Containment is lexical and component-wise, and a project directory that is not valid Unicode contains no skill. The shared `Location_Info` conversion omits `backendPaths`, and `remote.get` omits `device` because the backend does not yet read an enrollment device summary.

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
