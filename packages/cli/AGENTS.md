# CLI and TUI package guide

- The CLI owns the `ycoding` executable, command parsing, non-interactive execution, local service discovery and restart, TUI startup, and build, installer, and updater integration. Keep Session persistence and execution in Core and Server.
- Keep TUI Session views on `@ycoding-ai/client` contracts and location-scoped data in `packages/tui/src/context/data.tsx`; do not add a second Session-state authority.
- Preserve established TUI behavior unless the task intentionally changes it.
- Load the `ycoding` skill before interactively running, debugging, or verifying the CLI, TUI, or server.
