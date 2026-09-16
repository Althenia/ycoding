# YCoding

<p align="center">
  <img src="./assets/brand/ycoding-wordmark.svg" alt="YCoding — terminal coding agent" width="520">
</p>

Work on repositories from your terminal, with durable sessions and explicit control over autonomous execution.

- **Durable work:** preserve session history, pending prompts, and orchestration state.
- **Background subagents:** delegate work with inherited permission limits.
- **Repository-native customization:** configure agents, commands, skills, hooks, and MCP tools.

YCoding is terminal-first—the TUI is the primary surface. An approved native Godot desktop client is in development under [`apps/office`](./apps/office); it is a presentation client of the same local service and owns no execution authority.

## Install

**macOS (Apple Silicon or Intel) and Linux (x64)** — requires `curl`, `tar`, and `shasum` or `sha256sum`:

```sh
curl -fsSL https://althenia.github.io/ycoding/install.sh | sh
```

The installer downloads the latest release, verifies its SHA-256 checksum, and installs `ycoding` in `~/.local/bin`. Follow its PATH instructions, then open a new terminal and run:

```sh
ycoding
```

[Configure a provider](./docs/configuration.md) before sending your first model request.

### Desktop client

The native desktop client is an opt-in addition to the same install. It presents the same local service in a window; it does not replace the terminal application.

```sh
curl -fsSL https://althenia.github.io/ycoding/install.sh | sh -s -- --office
```

macOS ships a disk image (`ycoding-office-<version>-darwin-universal.dmg`). Double-click it and drag `YCoding Office.app` into Applications, or let the installer do the same move. The installer puts the bundle in `/Applications` when that is writable and in `~/Applications` otherwise; set `YCODING_OFFICE_DIR` to choose the directory. Linux installs `ycoding-office` and its data pack beside `ycoding`.

The desktop client is not notarized. On macOS the app opens without a warning when it is built from source; a bundle you downloaded may instead be refused as coming from an unidentified developer. Allow it deliberately in System Settings → Privacy & Security, or build it yourself with `apps/office/tools/build-release.sh`.

The client is a presentation surface: it needs a running `ycoding` service for live sessions and works offline with synthetic playback otherwise.

**Windows (x64):** download the ZIP from [GitHub Releases](https://github.com/Althenia/ycoding/releases/latest), extract `ycoding.exe`, and run it in your terminal. Native archives for all supported platforms are available there too, including `ycoding-office-*-windows-x64.zip` for the desktop client.

Update installer-supported binaries with `ycoding update`; replace development builds and Windows binaries manually.

Upgrading an existing installation? Back up session data and review the [SQLite upgrade notes](./docs/configuration.md#automatic-sqlite-space-reclamation): the first startup may rebuild the database and require extra disk space.

## Use

With an installed binary and a configured provider, run a prompt directly using your chosen model:

```sh
ycoding --model <provider/model> "Explain this repository"
```

Run `ycoding run --help` for options. See [runtime behavior](./docs/runtime.md) for sessions and autonomy, or [repository resources](./docs/repository-resources.md) for customization.

## Guardrails and customization

Agent permissions and Session guardrails are separate checks. Permissions control what an agent may attempt; guardrails review or deny high-impact operations across the main Session and its subagents. An approval does not override an explicit permission denial or a built-in catastrophic denial.

Customize guardrails with one Markdown rule per file:

- **Workspace:** `.ycoding/guardrails/*.md` in the project.
- **User:** `~/.config/ycoding/guardrails/*.md` with the default global configuration location.

See the [guardrail guide](./docs/guardrails-and-provider-usage.md#session-guardrails) for decisions, approval lifetime, limits and rule precedence; the [workspace/user instructions](./docs/guardrails-and-provider-usage.md#workspace-and-user-configuration) for placement; and the [AWS resource protection example](./docs/guardrails-and-provider-usage.md#aws-example-deny-destructive-resource-operations) for a tested deny-rule template. Guardrails inspect supported tool actions and resource strings; they are not a replacement for filesystem isolation or AWS IAM policies.

## Development

From a checkout, with **Bun 1.4.2** installed:

```sh
bun install --frozen-lockfile
bun run dev
```

Build and smoke-test the terminal application:

```sh
bun run build:tui
bun run smoke:tui
bun run smoke:runtime
```

For targeted tests and repository checks, see [contributing guidance](./AGENTS.md). The [documentation index](./docs/README.md) links to architecture, configuration, and runtime details.

## License

MIT. See [LICENSE](./LICENSE).
