# Local wire runtime

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
