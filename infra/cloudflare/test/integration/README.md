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

Groups are `lifecycle`, `permissions`, `guardrails`, `children`, `attachments`, `admin`, `offline`, `completion`, `interrupt`, `oversized`, and `logout`. The interrupt group explicitly retains the same admit-only BTW input as the sequential lifecycle scenario: native outstanding includes the BTW child, while the connector projects it to the shared root's outstanding status. Interruption does not create an obligation.

The closed-page completion path verifies service-worker Web Push delivery. `--page-alert` instead verifies the open workspace's page-level service-worker notification call. Neither path substitutes for the other. The provider stand-in does not verify real provider credentials, quota retrieval, vendor-specific payloads, or retry behavior. No deployment or publication occurs.
