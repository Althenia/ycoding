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

`CatalogServices.models` and `CatalogServices.generate.models` must be the same Arc; requests reject divergent services. Generation uses the runner's credential service, integration registry, provider Executor, and optional Cursor host. Its selection retains provider, catalog model, profile, and variant, while provider requests use the API model identity. It makes one stateless provider generation and stores no Session messages. Named-profile or variant failures do not switch models or accounts. Muse receives its credential snapshot; Cursor uses the supplied native route host.

Wire conversion preserves complete model/default selection metadata, optional values, ordered permissions, and lossless strings. Secret-bearing configuration keys are excluded recursively from provider/model/agent request overlays; provider execution errors expose a fixed message and provider identity, not raw payloads or headers.

The replacement extension contract exposes loaded IDs through `plugin.list`; do not execute npm plugin entrypoints to populate it.

```sh
cargo test --locked -p ycoding-runtime --test catalog_ops
cargo test --locked -p ycoding-core --test generate_text
```
