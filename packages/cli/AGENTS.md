# CLI and TUI package guide

- The CLI owns the `ycoding` executable, command parsing, non-interactive execution, local service discovery and restart, TUI startup, and build, installer, and updater integration. Keep Session persistence and execution in Core and Server.
- Keep TUI Session views on `@ycoding-ai/client` contracts and location-scoped data in `packages/tui/src/context/data.tsx`; do not add a second Session-state authority.
- Preserve established TUI behavior unless the task intentionally changes it.
- Load the `ycoding` skill before interactively running, debugging, or verifying the CLI, TUI, or server.
- Keep production CLI imports and dependencies free of Core, Server, Meeting and Plugin packages; run `test/frontend-boundary.test.ts` after changing the frontend graph.
- The packaged isolated-browser gate (`script/isolated-browser-smoke.ts --binary=<packaged ycoding>`) runs on macOS arm64 against the packaged runtime through `@ycoding-ai/client/v5`. Preserve the real Chrome semantic observe/click, exactly-once fixture action, private-marker redaction, Session ownership, bounded shutdown, and browser/Session cleanup checks. `script/isolated-browser-smoke.test.ts` verifies the harness over a scripted binary v5 peer; it does not replace packaged real-browser acceptance.
