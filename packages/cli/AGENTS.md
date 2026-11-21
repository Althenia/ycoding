# CLI and TUI package guide

- The CLI owns the `ycoding` executable, command parsing, non-interactive execution, local service discovery and restart, TUI startup, and build, installer, and updater integration. Keep Session persistence and execution in Core and Server.
- Keep TUI Session views on `@ycoding-ai/client` contracts and location-scoped data in `packages/tui/src/context/data.tsx`; do not add a second Session-state authority.
- Preserve established TUI behavior unless the task intentionally changes it.
- Load the `ycoding` skill before interactively running, debugging, or verifying the CLI, TUI, or server.
- Keep `desktop-client` native-only through `#desktop-worker`. Bun and Node select their implementations through package import conditions.
- Bind the installed Node 26.4.0 executable with `NODE_BIN` for the selected recovery tests and `test-integration/node-build.test.ts`. The build smoke uses `--single --skip-install` and verifies the packaged helper, native-only commands and Node service recovery.
