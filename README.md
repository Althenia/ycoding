# YCoding

[![Latest release](https://img.shields.io/github/v/release/Althenia/ycoding?style=flat&color=67D7A4)](https://github.com/Althenia/ycoding/releases/latest)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](./LICENSE)
[![Platforms](https://img.shields.io/badge/macOS%20%7C%20Linux%20%7C%20Windows-supported-lightgrey)](https://github.com/Althenia/ycoding/releases/latest)
[![Docs](https://img.shields.io/badge/docs-ycoding.althenia.app-67D7A4)](https://ycoding.althenia.app/docs)

**A terminal-first coding agent that runs on your own machine.** YCoding keeps every Session durable, lets you decide how much it may do on its own, and puts the same local runtime in your browser and on your phone when you step away from the terminal.

Your repository, shell, tools, and model calls stay on your machine. In the Rust-backend beta, `ycoding` launches the local Rust runtime; the terminal and web app control it through the same revision 5 contract. The web app is a remote control, not a hosted agent.

Latency and client-timing telemetry stays in local storage and is disabled until you enable the machine-wide consent choice; token and cost usage remain available independently.

<p align="center">
  <img src="./assets/showcase/ycoding-showcase.png" alt="YCoding in a terminal, a desktop browser, and a phone: the terminal shows a Session paused on a guardrail review, the browser shows the remote Session conversation, and the phone shows a guardrail review and a question waiting for an answer" width="900">
</p>

## Why YCoding

- **Durable Sessions.** History, pending prompts, todos, and subagents survive restarts and reconnects. Steer a running Session or queue work for when it goes idle.
- **Autonomy you choose.** YOLO 0 (Ask first) is manual; 1 (Allow tools) auto-approves ask permissions only; 2 (Tools + reviews) also auto-approves ordinary guardrail reviews while awake. Goals grant no permissions, answers, or review approvals. Automatic answers use a separate per-Session `/auto-answer` toggle, default off. See [runtime autonomy](./docs/runtime.md#autonomy).
- **Guardrails across the whole Session family.** High-impact actions are governed by guardrails in the main Session and every subagent. Model-based review is opt-in with `guardrails.decide_reviews` (default false); hard-review grading has a separate setting, and sleep never enables YOLO review approval. See [guardrail configuration](./docs/configuration.md#guardrail-configuration-and-custom-files) and [runtime review behavior](./docs/runtime.md#session-guardrails).
- **Background subagents.** Delegate work to durable child Sessions that inherit your permission limits, and watch their progress in the Session rail.
- **Use your accounts side by side.** Keep several named profiles per provider — API keys or subscription sign-ins such as Claude Code, Codex, or Muse — and pick one per Session or subagent with `profile#provider/model#variant`. See [provider profiles](./docs/configuration.md#provider-profiles).
- **Beta providers.** OpenAI (API key and Codex subscription), Anthropic (API key and Claude Code subscription), OpenRouter, Cursor, Meta (Muse and API key), Cline (`cline-pass`), Z.ai, MiniMax, Kimi, and OpenAI-compatible custom endpoints. Other provider configurations load with an unsupported-provider diagnostic.
- **Your phone as a remote.** The Focus workspace puts Sessions, Usage, and Settings in a collapsible desktop rail or a three-item phone bar, with explicit New session and Back actions. Enroll your machine once, then read transcripts, send prompts, and answer permissions, guardrail reviews, and questions from any browser or the installable phone app, with opt-in push alerts when a Session needs you.
- **Repository-native customization.** Agents, commands, skills, trusted process extensions, and MCP servers live next to your code; presentation plugins customize the terminal. See [repository resources](./docs/repository-resources.md).
- **Browser and computer control.** Work in [paired Chrome tabs or agent-owned tabs](./docs/browser-extension.md) and in [scoped macOS windows](./docs/computer-use.md), with per-site and per-tool permissions.
- **Workspace memory.** Save and search [linked Markdown knowledge](./docs/memory.md) with an offline graph, kept separate from transcripts and prompts.
- **Next-message prediction.** Run `/suggest [hint]` in the TUI or web composer to get a suggested next message from recent conversation text, optionally with project or global memory: fill, never send.
- **Prompt drafts.** Run `/prompt <intent>` in the TUI or web composer to turn a rough intent into one draft prompt for review. Choose a mode and, optionally, project or global memory: fill, never send.
- **Opt-in meeting intelligence.** Run `ycoding meeting` for consented browser-tab capture from the [local live page](./docs/meeting-intelligence.md): configurable Thai Whisper transcription, evidence-backed plans and reviewed MCP proposals.

## Quick start

**macOS (Apple Silicon) and Linux (x64)** — requires `curl`, `tar`, and `shasum` or `sha256sum`:

```sh
curl -fsSL https://ycoding.althenia.app/install.sh | sh
```

The installer downloads the latest release, verifies its SHA-256 checksum, and installs `ycoding` in `~/.local/bin`. Follow the PATH instructions it prints, then open a new terminal in your project:

```sh
ycoding
```

Type `/connect` in the composer to add a provider profile, then describe your task.

**Windows (x64):** download the ZIP from [GitHub Releases](https://github.com/Althenia/ycoding/releases/latest), extract `ycoding.exe`, and run it in your terminal.

Run a single prompt without opening the interface:

```sh
ycoding --model <[profile#]provider/model[#variant]> "Explain this repository"
```

Keep up to date with `ycoding update`. See [installation](https://ycoding.althenia.app/docs/installation) for macOS permissions, quarantine, and upgrade notes.

## Install the beta

The Rust backend ships through a separate beta channel, starting at `0.11.0-beta.1`; stable releases stay separate. The beta is built for macOS on Apple Silicon only. Intel Macs are unsupported, and Linux and Windows beta builds are not published for this release. On an Apple Silicon Mac:

```sh
curl -fsSL https://raw.githubusercontent.com/Althenia/ycoding/v0.11.0-beta.1/script/install.sh | sh -s -- --beta
```

`--beta` or `YCODING_CHANNEL=beta` selects the newest published, non-draft beta prerelease. Add `YCODING_VERSION=0.11.0-beta.1` to pin this exact version. The installer URL is the script in the `v0.11.0-beta.1` release tag. The beta uses the `ycoding-beta` configuration, state, data, and cache namespace. On first start it imports a private copy of stable Session data; each Meeting Location imports its stable history when first opened with Meeting enabled. Stable files remain unchanged, and later stable changes are not merged into beta data. See [first-start import](./docs/configuration.md#global-directories) and [Meeting storage](./docs/configuration.md#meeting-capture).

Configure providers and terminal preferences in the beta configuration directory. Runtime JavaScript/npm plugins are unsupported in beta; use explicit trusted process extensions or MCP servers, and keep TUI presentation plugins in `cli.json`. Beta and stable data remain separate when switching channels.

On a beta build, `ycoding update` selects the higher of the newest beta and newest stable; a newer stable supersedes the beta. Stable builds never update to a beta automatically. The hosted beta web client and relay are not part of this macOS prerelease; the local TUI and CLI are the published surface. Deploy the matching web client and relay separately and use them with the enrolled backend; revision 5 connections require matching contracts.

Switch back with the normal stable installer:

```sh
curl -fsSL https://ycoding.althenia.app/install.sh | sh
```

## Three surfaces, one runtime

| Terminal                                                                                                                                                                                                           | Web                                                                                                                                                                     | Phone                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| <img src="./assets/showcase/ycoding-tui.png" alt="YCoding terminal interface with the transcript, a guardrail review dialog, and the Session rail showing context, todos, subagents, and MCP servers" width="420"> | <img src="./assets/showcase/ycoding-web.png" alt="YCoding remote web workspace showing a Session conversation with completed tool output and the composer" width="420"> | <img src="./assets/showcase/ycoding-phone.png" alt="YCoding phone app showing a human-only guardrail review and a pending question" width="200"> |
| The primary surface: transcript, Session rail, reviews, shells, and subagents in your terminal.                                                                                                                    | Sessions, conversations, usage, and settings for every Session on your enrolled machine.                                                                                | The same workspace on a phone, with opt-in push alerts for reviews, finished work, and offline machines.                                         |

To use the [remote workspace](https://ycoding.althenia.app/remote/), sign in, open **Settings → Devices → Create enrollment code**, and run the displayed command on your machine. It prompts for the one-use code, so the code never lands in shell history. Then turn on the connection:

```sh
ycoding remote enroll <enrollmentID>
ycoding remote connect
```

> [!WARNING]
> While the machine is connected, the signed-in account can reach every existing and future Session on that machine. Connect only machines and accounts you trust.

See [remote workspace](https://ycoding.althenia.app/docs/usage/remote) for sign-in options, recovery, and connection states.

### Relay MCP

Relay MCP is a separate, off-by-default control surface for approved MCP clients. After enrolling the machine and connecting Remote, enable it locally:

```sh
ycoding remote mcp on
ycoding remote mcp status
```

Configure the returned device URL in an MCP client supporting `2026-07-28`, then complete Google sign-in and client consent. Consent grants control of every existing and future Session on that backend, including persistent approvals and autonomy changes. It also permits Session creation in existing directories strictly below the machine's home directory. Starting Remote alone does not enable MCP. Use `ycoding remote mcp off` to disable it; see [Relay MCP configuration](./docs/configuration.md#relay-mcp).

## Guardrails

Permissions decide what an agent may attempt; guardrails review or deny high-impact operations across the main Session and its subagents. An approval never overrides an explicit permission denial or a built-in catastrophic denial.

Add your own rules as one Markdown file per rule:

- **Workspace:** `.ycoding/guardrails/*.md` in the project.
- **User:** `~/.config/ycoding/guardrails/*.md`.

See the [guardrail guide](./docs/guardrails-and-provider-usage.md#session-guardrails) and the tested [AWS resource protection example](./docs/guardrails-and-provider-usage.md#aws-example-deny-destructive-resource-operations). Guardrails inspect supported tool actions and resource strings; they do not replace filesystem isolation or cloud IAM policies.

## Documentation

- [Getting started](https://ycoding.althenia.app/docs/getting-started) and [quickstart](https://ycoding.althenia.app/docs/quickstart)
- [Working in the terminal](https://ycoding.althenia.app/docs/usage/tui) and [command line](https://ycoding.althenia.app/docs/usage/cli)
- [Providers and profiles](https://ycoding.althenia.app/docs/configuration/providers), [agents](https://ycoding.althenia.app/docs/configuration/agents), [MCP](https://ycoding.althenia.app/docs/configuration/mcp), [goal](https://ycoding.althenia.app/docs/configuration/goal), and [YOLO mode](https://ycoding.althenia.app/docs/configuration/yolo)
- [Troubleshooting](https://ycoding.althenia.app/docs/troubleshooting) and the [changelog](https://ycoding.althenia.app/changelog)
- Engineering references: [runtime](./docs/runtime.md), [configuration](./docs/configuration.md), [architecture](./docs/architecture.md), and the [documentation index](./docs/README.md)

<details>
<summary>Build from source</summary>

With **a current Bun release**, **Rust 1.98 or newer**, and **Protocol Buffers `protoc`** installed (`PROTOC` selects its executable):

```sh
bun install --frozen-lockfile
cargo build --locked --manifest-path rust/Cargo.toml -p ycoding-runtime --bin ycoding-runtime
bun run dev
```

Source execution uses `rust/target/debug/ycoding-runtime` by default; `YCODING_RUNTIME_EXECUTABLE` selects another local build. Build and smoke-test the terminal application on its matching native host, then install it locally on macOS or Linux:

```sh
bun run build:tui
bun run smoke:tui
bun run smoke:runtime
bun run install:local
```

Build and test the web app:

```sh
bun run build:web
bun run test:web
bun run test:remote
```

See [contributing guidance](./AGENTS.md) for targeted tests, repository checks, and the release process.

</details>

## License

YCoding is licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). See [LICENSE](./LICENSE) for the full text and [NOTICE](./NOTICE) for the upstream MIT notice it retains.
