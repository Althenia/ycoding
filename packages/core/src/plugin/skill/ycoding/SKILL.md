---
name: ycoding
description: "Use this skill for questions about YCoding behavior, configuration, troubleshooting, plugins, hooks, Clients, Server, API, agents, commands, skills, tools, permissions, MCP, providers, models, themes, keymaps, the CLI, the TUI, and contributing to this repository."
metadata:
  display-name: "YCoding"
  purpose: "Answer questions about YCoding behavior, configuration and contribution from the repository's own documents."
  applicability: "Questions about YCoding itself; not for unrelated coding tasks."
  triggers: "ycoding configuration, ycoding troubleshooting, plugins and hooks, permissions, providers and models, contributing"
  capabilities: "locate the owning document, explain configuration, diagnose runtime behavior"
  prerequisites: "repository documents readable from the Session"
  related: "report"
---
# YCoding

Use this guide to diagnose, configure, or contribute to the Rust runtime that powers YCoding's terminal client and local service.

## Find the owner

Start with the running service and a focused test. Use the native source that owns the behavior:

- `rust/crates/runtime`: `ycoding-runtime` executable, service startup, operation dispatch, and handlers.
- `rust/crates/core`: Location-scoped configuration and resources, Session admission and runner, agents, tools, permissions, extensions, and Project coordination.
- `rust/crates/ai`: provider request encoding, streaming, and usage. Core resolves the provider, model, credential profile, and route before calling the adapter.
- `rust/crates/store`: durable state and event storage. `rust/crates/schema` and `rust/crates/protocol` enforce domain and wire contracts.
- `packages/schema` and `packages/protocol`: shared schema and operation descriptor sources. Check the Rust decoder and dispatcher before assuming that the native service implements a declared operation.
- `packages/cli` and `packages/tui`: client commands and terminal UI. Trace client symptoms across the native operation before changing either side.

Use Bun releases only as comparison baselines for runtime behavior. Identify the installed version with `ycoding --version`; confirm the service and its supported commands with `ycoding service status` and `ycoding --help`. Use `/help` for terminal commands.

## Configuration and extensions

Use `ycoding.json` or `ycoding.jsonc`. Global configuration lives in the platform configuration directory under `ycoding`; project configuration can also live under `.ycoding/`. Check the native configuration resolver for precedence, scope, and supported fields. Preserve unrelated settings. Do not add a `$schema` URL without verifying the endpoint.

Inspect the native catalog and saved profile binding before diagnosing provider availability. Keep credentials out of commands and diagnostic output. Verify extension activation, capabilities, and permission checks in `rust/crates/core/src/extension` before documenting a plugin or hook. Verify discovery and activation for agents, commands, skills, and MCP against their native owners. Do not infer support from a Bun plugin entrypoint.

Use `YCoding` in prose, `ycoding` in commands and configuration, and `YCODING_*` for environment variables. Preserve protocol names such as `x-ycoding-directory` and `x-ycoding-workspace`.

## Sessions and operations

Read a Session with `ycoding api session.get --param sessionID=<id>`. Verify operation inputs in Protocol and read durable events when diagnosing admission, instructions, compaction, or resume. Do not replay a pending input to inspect its status. Subagents run in background child Sessions; check parent notifications and TeamView without opening the child. Project coordination has its own roles and write boundaries; do not infer control from Session ancestry.

## Verify native changes

From `rust/`, run the smallest named case and the affected static checks. Replace placeholders with the owning crate, test target, and case:

```sh
cargo test --locked -p <crate> --test <target> -- <case> --exact
cargo check --locked -p <crate> --all-targets
cargo fmt --all -- --check
cargo build --locked -p ycoding-runtime --bin ycoding-runtime
```

Run the runtime build when the executable is affected. Use the configured toolchain and compile targets. Distinguish a Cargo build from the installed service, and report local checks separately from live verification. Do not restart the installed service to validate a local edit unless the restart is authorized.
