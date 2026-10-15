# Composed remote relay flow

Run from the repository root on macOS with Rust 1.98 or newer, Bun dependencies, a protobuf compiler, and Google Chrome installed at `/Applications/Google Chrome.app`. Set `PROTOC` when the compiler is not at `/opt/homebrew/bin/protoc`. Keep port 8807 free and serialize this flow with other builds, typechecks, and package-wide suites.

```sh
bun install --frozen-lockfile
bun run build:web
bun run test:integration:remote
```

The flow builds the current checkout's debug Rust runtime with locked dependencies into `rust/target`, then starts two isolated runtime instances. It creates disposable home, XDG, configuration, workspace, and relay storage directories inside `.cache/tmp`; it does not use the developer's running service or configuration. It starts a local Wrangler Worker with real D1 and the device relay, enrolls the real Rust connector, and exercises the production v5 web store and transport. Google sign-in and the model endpoint are local stand-ins. The completion scenario starts headed Chrome in a private profile and reaches the real Chrome push service; network access is required. The default run includes all scenarios and fails on any missing prerequisite or failed assertion.

Use named groups only to diagnose a failed boundary:

```sh
bun run test:integration:remote --group=interrupt
bun run test:integration:remote --group=offline,completion
bun run test:integration:remote --group=completion --page-alert
```

Groups are `heldCommit`, `lifecycle`, `permissions`, `guardrails`, `children`, `attachments`, `admin`, `offline`, `completion`, `interrupt`, `oversized`, and `logout`. The held-commit group withholds a native prompt Result after durable Rust admission, disconnects the browser transport, and checks unknown settlement, canonical reconciliation, newer-draft preservation and absence of replay. It exercises the production web store, not rendered browser controls. The interrupt group explicitly retains the same admit-only BTW input as the sequential lifecycle scenario: native outstanding includes the BTW child, while the connector projects it to the shared root's outstanding status. Interruption does not create an obligation.

The closed-page completion path verifies service-worker Web Push delivery. `--page-alert` instead verifies the open workspace's page-level service-worker notification call. Neither path substitutes for the other. The provider stand-in does not verify real provider credentials, quota retrieval, vendor-specific payloads, or retry behavior. No deployment or publication occurs.

## Native wire ownership and recovery

Run the separate native boundary suite with Bun, Node 24 and the installed Wrangler dependencies:

```sh
bun infra/cloudflare/test/integration/binary-flow.ts
bun infra/cloudflare/test/integration/binary-flow.ts --group=http
```

The suite starts Wrangler's installed Miniflare/workerd on ephemeral numeric-loopback ports with isolated D1 and SQLite Durable Object storage. Its test adapter delegates to the production Worker and DeviceRelay, holds native callbacks, injects SQL transaction faults and invokes native hibernation eviction. Push delivery terminates at a local encrypted-payload receiver; no external push service is contacted. Run it separately from unit suites and serialize it with builds, typechecks and package-wide suites.

Groups are `storage`, `predecessor`, `stall`, `http`, `limits`, `authority` and `d1`. They cover completion rollback/reconstruction, delayed predecessor callbacks, delivery-credit ownership, HTTP bulk termination, native/application frame limits, fresh request/Result authority and atomic D1 browser-session rotation. The read-only inspector records production aggregate reservations and per-connection ledgers alongside isolate-wide V8 heap/backing-store totals. Those totals do not measure per-socket native allocations; unavailable native allocation values remain unreported. Fixture buffers are test-owned, not production relay reservations. The suite fails when the installed tooling cannot expose the required storage, hibernation or reservation observer.
