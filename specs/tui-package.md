# YCoding TUI package contract

Status: implemented.

## Scope

`@ycoding-ai/tui` owns terminal rendering, input, dialogs, transcript presentation, scrollback, session navigation, terminal notifications, and plugin-facing TUI slots.

`packages/cli` owns process startup, command parsing, background-service discovery, updater behavior, and construction of the TUI runtime dependencies.

`packages/core` owns durable runtime behavior. `packages/server`, `packages/protocol`, and `packages/client` expose that behavior to the TUI without making the TUI import Core or Server directly.

## Dependency boundary

The standalone terminal artifact may include only packages in the enforced YCoding workspace closure. The TUI package must not import:

- removed desktop, web, console, website, statistics, or session-UI packages;
- `packages/core` or `packages/server` implementation modules;
- private source paths from another package;
- a removed legacy SDK facade.

The TUI consumes public Client and Plugin contracts. Shared wire values belong in Schema and Protocol.

## Runtime construction

The CLI creates or discovers the local service, constructs the Client, supplies configuration and package-resolution adapters, and starts `@ycoding-ai/tui`.

The TUI must remain testable with a fake Client and renderer. It must not start its own hidden server, read process-global configuration directly, or own persistence.

## Product identity

User-facing product copy is `YCoding`. Commands and paths use `ycoding`. Terminal titles use `YCoding` or the `YC` prefix. OpenCode Zen and OpenCode Go may appear only as external provider identity.

## Build

The distributable terminal artifact is built from the repository root:

```sh
bun run build:tui
```

The artifact must contain only the `ycoding` product executable.

## Verification

```sh
bun run check:ycoding-workspace
bun run check:ycoding-brand
cd packages/cli && bun test test/import-boundaries.test.ts test/binary-name.test.ts
cd ../tui && bun test test/branding.test.ts test/app-lifecycle.test.tsx
```

The import-boundary test is the executable package-closure contract. Changes to the package graph must update that test and `script/ycoding-workspace.ts` in the same change.
