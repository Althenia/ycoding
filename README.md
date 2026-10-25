# YCoding

[![Latest release](https://img.shields.io/github/v/release/Althenia/ycoding?style=flat&color=67D7A4)](https://github.com/Althenia/ycoding/releases/latest)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](./LICENSE)
[![Platforms](https://img.shields.io/badge/macOS%20%7C%20Linux%20%7C%20Windows-supported-lightgrey)](https://github.com/Althenia/ycoding/releases/latest)
[![Docs](https://img.shields.io/badge/docs-ycoding.althenia.app-67D7A4)](https://ycoding.althenia.app/docs)

**A terminal-first coding agent that runs on your own machine.** YCoding keeps every Session durable, lets you decide how much it may do on its own, and puts the same local runtime in your browser and on your phone when you step away from the terminal.

Your repository, shell, tools, and model calls stay in the local `ycoding` process. The web app is a remote control for that process, not a hosted agent.

Latency and client-timing telemetry stays in local SQLite and is disabled until you enable the machine-wide consent choice; token and cost usage remain available independently.

<p align="center">
  <img src="./assets/showcase/ycoding-showcase.png" alt="YCoding in a terminal, a desktop browser, and a phone: the terminal shows a Session paused on a guardrail review, the browser shows the remote Session conversation, and the phone shows a guardrail review and a question waiting for an answer" width="900">
</p>

## Why YCoding

- **Durable Sessions.** History, pending prompts, todos, and subagents survive restarts and reconnects. Steer a running Session or queue work for when it goes idle.
- **Autonomy you choose.** `/autonomous` sets Permissions, Guardrails, and Answers independently to Manual (default; you decide every request), YOLO (a hidden helper model evaluates requests that deterministic rules leave unresolved), or Auto (deterministic rules only: approve ask permissions, approve ordinary standard guardrail reviews while you are awake, and answer with a valid explicit default or the single Recommended option). Hard and custom-rule guardrail reviews always need you. Set a `/goal` to continue until completion, stop, or exhausted attempts; a goal approves no permissions, settles no reviews, and answers no questions.
- **Guardrails across the whole Session family.** High-impact actions require review in the main Session and every subagent. Explicit denies, caps, and permission ceilings block before any automation. With guardrails set to YOLO, unresolved reviews receive assessment from a hidden helper model through the graded Decision API; `guardrails.decide_reviews: false` turns off its standard-match verification. Manual never calls a helper model. Each assessment ends in allow, deny, or escalate with a reason, judging the actual action and its targets, not just its path. A hard review can be model-denied or escalated, never model-approved; approval is yours alone, and a proven false-positive match is reclassified instead. Anything unsettled comes to you with its reason, or waits in the review box while you sleep.
- **Work while you sleep.** `/sleep` durably marks the family asleep and holds macOS keep-awake, including lid-closed control. Asleep, deterministic guardrail auto-approval stops; enabled model evaluation still settles confident requests, and everything else waits in the review box. Each switch is independent. `/wake` or any user prompt ends sleep. `/keep-awake` controls the manual machine preference; a sleeping family keeps its hold. Run `ycoding keep-awake setup` once to let keep-awake disable system sleep, so a closed-lid Mac on battery stays awake until the battery runs out. Watch battery drain and heat with the lid closed.
- **Background subagents.** Delegate work to durable child Sessions that inherit your permission limits, and watch their progress in the Session rail.
- **Projects.** Manage coordination groups and their Sessions in dedicated TUI and web screens, with explicit roles, per-dispatch agent and reasoning choices recorded in receipts, one-writer leases, bounded event waits, delegated routine decisions, and notification filters. CLI and Relay MCP expose the same controls; stopping a group leaves workers intact, and restart requires human re-arm. See [the coordination contract](./specs/coordination.md).
- **Use your accounts side by side.** Keep several named profiles per provider — API keys or subscription sign-ins such as Claude Code, ChatGPT, or GitHub Copilot — and pick one per Session or subagent with `profile#provider/model#variant`. See [provider profiles](./docs/configuration.md#provider-profiles).
- **Many providers.** OpenAI, Anthropic, Google, GitHub Copilot, Muse (Meta), OpenRouter, xAI, Amazon Bedrock, Azure, Mistral, Groq, and more, plus any OpenAI-compatible endpoint.
- **Your phone as a remote.** The Focus workspace puts Sessions, Usage, and Settings in a collapsible desktop rail or a three-item phone bar, with explicit New session and Back actions. Enroll your machine once, then read transcripts, send prompts, and answer permissions, guardrail reviews, and questions from any browser or the installable phone app, with opt-in push alerts when a Session needs you.
- **Repository-native customization.** Agents, commands, skills, hooks, plugins, and MCP servers live next to your code.
- **Browser and computer control.** Work in [paired Chrome tabs or agent-owned tabs](./docs/browser-extension.md) and in [scoped macOS windows](./docs/computer-use.md), with per-site and per-tool permissions.
- **Workspace memory.** Save and search [linked Markdown knowledge](./docs/memory.md) with an offline graph, kept separate from transcripts and prompts.
- **Next-message prediction.** Run `/suggest [hint]` in the TUI or web composer to get a suggested next message from recent conversation text, optionally with project or global memory: fill, never send.
- **Prompt drafts.** Run `/prompt <intent>` in the TUI or web composer to turn a rough intent into one draft prompt for review. Choose a mode and, optionally, project or global memory: fill, never send.
- **Opt-in meeting intelligence.** Run `ycoding meeting` for consented browser-tab capture from the [local live page](./docs/meeting-intelligence.md): configurable Thai Whisper transcription, evidence-backed plans and reviewed MCP proposals.

## Quick start

**macOS (Apple Silicon or Intel) and Linux (x64)** — requires `curl`, `tar`, and `shasum` or `sha256sum`:

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

Relay MCP is an opt-in way for an MCP client such as ChatGPT to control the Sessions on a connected machine through the same relay. It is off by default, and connecting the machine does not enable it. Turn it on with `ycoding remote mcp on` or the TUI **Relay MCP** toggle, then add the URL printed by `ycoding remote mcp status` (`<relay origin>/api/mcp/devices/<device ID>`) to the client.

```sh
ycoding remote mcp on
ycoding remote mcp status
ycoding remote mcp off
```

> [!WARNING]
> An approved client acts on every existing and future Session on the machine with the same abilities as the web workspace, including persistent Always approvals where YCoding offers them and autonomy mode changes, and it can start a Session in any existing folder below your home directory. Each client needs a fresh Google sign-in by an allowlisted owner and an explicit approval. `ycoding remote mcp off` or disconnecting revokes every client.

It exposes the closed remote tool surface on MCP revision 2026-07-28, including a fixed UI/PNG feasibility demo, explicitly registered local HTTP apps, and Session webhook Events. Registered apps remain bound to one Session, client grant, literal-loopback port, and route/method allowlist; registration does not make the service public. Embedded presentation requires separately configured isolated HTTPS origins and host iframe support. Actual-chat rendering and native-file delivery remain unverified. The demo is not a general artifact pipeline: arbitrary Session artifacts, PDFs, and complete proposal bundles are outside its contract. See [registered HTTP apps](specs/local-http-apps.md), [MCP Events](specs/mcp-events.md), and [relay deployment](docs/remote-deployment.md#relay-mcp). This is separate from the localhost task interface below.

### Dots conversation peer

Dots is off by default; enable it with `"dots": { "enabled": true }` in YCoding configuration. `/dots` in the TUI or web composer binds the current Session to one Dot conversation, after you confirm the ChatGPT profile, Dot, and conversation. `/dots <text>` sends only that text and the files you attach, and only after explicit Send. While a Session is bound, its agent can send to that Dot with the permission-checked `dots_send` tool; other Sessions don't get the tool. Relay MCP does not expose Dots controls.

Committed room messages authored by the selected Dot enter the bound Session with external-peer attribution; raw assistant-generation snapshots remain non-final. Pause Dot stops its autonomous runtime until Resume Dot, which can continue its work and goals. Runtime controls do not cancel an individual response or retract a message. Service eligibility is account-specific; image/paste delivery and reconnect recovery still require live acceptance. See [Dots conversation peer](docs/runtime.md#dots-conversation-peer).

## Guardrails

Permissions decide what an agent may attempt; guardrails review or deny high-impact operations across the main Session and its subagents. An approval never overrides an explicit permission denial or a built-in catastrophic denial.

Add your own rules as one Markdown file per rule:

- **Workspace:** `.ycoding/guardrails/*.md` in the project.
- **User:** `~/.config/ycoding/guardrails/*.md`.

See the [guardrail guide](./docs/guardrails-and-provider-usage.md#session-guardrails) and the tested [AWS resource protection example](./docs/guardrails-and-provider-usage.md#aws-example-deny-destructive-resource-operations). Guardrails inspect supported tool actions and resource strings; they do not replace filesystem isolation or cloud IAM policies.

## Documentation

- [Getting started](https://ycoding.althenia.app/docs/getting-started) and [quickstart](https://ycoding.althenia.app/docs/quickstart)
- [Working in the terminal](https://ycoding.althenia.app/docs/usage/tui) and [command line](https://ycoding.althenia.app/docs/usage/cli)
- [Providers and profiles](https://ycoding.althenia.app/docs/configuration/providers), [agents](https://ycoding.althenia.app/docs/configuration/agents), [MCP](https://ycoding.althenia.app/docs/configuration/mcp), [goal](https://ycoding.althenia.app/docs/configuration/goal), and [autonomous mode](https://ycoding.althenia.app/docs/configuration/autonomous)
- [Troubleshooting](https://ycoding.althenia.app/docs/troubleshooting) and the [changelog](https://ycoding.althenia.app/changelog)
- Engineering references: [runtime](./docs/runtime.md), [configuration](./docs/configuration.md), [architecture](./docs/architecture.md), and the [documentation index](./docs/README.md)

<details>
<summary>Build from source</summary>

With **a current Bun release** installed:

```sh
bun install --frozen-lockfile
bun run dev
```

Build and smoke-test the terminal application, then install it locally on macOS or Linux:

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

### Remote task MCP

`ycoding mcp serve` exposes an opt-in, single-owner OAuth-protected task interface through a separate localhost listener. Start, inspect, list, and cancel durable coding Sessions in isolated Git worktrees. See [Task MCP setup](docs/task-mcp.md) for external OAuth and Cloudflare Tunnel requirements.
