# Configuration reference

This document is the canonical configuration reference for the current YCoding repository. It is derived from the live Schema and runtime discovery code.

## Configure by task

| Task                                      | Read                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Choose which configuration wins           | [Discovery and precedence](#runtime-configuration-discovery-and-precedence), [JSON/JSONC](#json-and-jsonc-behavior).                     |
| Connect an account and choose a model     | [Providers and models](#providers-and-models), [profiles](#provider-profiles), [model selectors](#model-selectors).                      |
| Control agent authority                   | [Permissions](#permissions), [agents](#agents), [guardrails](#guardrail-configuration-and-custom-files).                                 |
| Extend repository behavior                | [Commands](#commands), [skills and instructions](#skills-and-ambient-instructions), [plugins](#plugins-and-hooks), [MCP](#mcp).          |
| Manage context and knowledge              | [Compaction](#compaction-and-experimental-settings), [workspace memory](#workspace-memory), [provider efficiency](#provider-efficiency). |
| Adjust presentation and service operation | [CLI/TUI](#cli-tui-configuration), [managed service](#managed-service-configuration).                                                    |

Runtime settings belong in `ycoding.json` or `ycoding.jsonc`; terminal preferences belong in `cli.json`. These surfaces do not substitute for each other.

## Workspace memory

The `memory` runtime object enables explicit repository-memory and shared-knowledge operations. It defaults to `enabled: true`, `max_concept_bytes: 65536`, `max_bundle_bytes: 8388608`, and `max_concepts: 1000`. Its optional `path` selects the managed base instead of `<YCoding data directory>/memory`; `~/` uses the user home and relative paths use the repository's main checkout, or the current Location outside Git. Fields merge independently in normal configuration order.

Setting `enabled: false` preserves existing files. Enabling memory does not create storage, extract transcripts, or recall concepts into prompts. See [Workspace knowledge memory](./memory.md) for examples, workspace identity, permissions, update conflicts, retrieval bounds, and offline graph use.

## Configuration surfaces

YCoding has three independent configuration surfaces:

| Surface                       | Files                                                                                                         | Scope                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime configuration         | `ycoding.json`, `ycoding.jsonc`, `.ycoding/ycoding.json`, `.ycoding/ycoding.jsonc`                            | Models, agents, permissions, MCP, providers, plugins, skills, commands, references, compaction, formatters, LSP, and runtime behavior. |
| CLI/TUI configuration         | `cli.json` in the YCoding global config directory                                                             | Theme, keybindings, notifications, prompt behavior, transcript presentation, mouse, and terminal integration.                          |
| Managed-service configuration | `service.json`, `service-local.json`, or `service-<channel-hash>.json` in the YCoding global config directory | Managed background-server hostname, port, and private password.                                                                        |

The obsolete files `tui.json` and `kv.json` have no effect. Project-local `.ycoding/tui.json` is not a supported configuration source.

## Global directories

YCoding resolves directories through `xdg-basedir` and appends the `ycoding` namespace.

| Purpose                        | Base                                                     |
| ------------------------------ | -------------------------------------------------------- |
| Configuration                  | `$XDG_CONFIG_HOME/ycoding`, or the platform XDG fallback |
| State and service registration | `$XDG_STATE_HOME/ycoding`, or the platform XDG fallback  |
| Data and logs                  | `$XDG_DATA_HOME/ycoding`, or the platform XDG fallback   |
| Cache                          | `$XDG_CACHE_HOME/ycoding`, or the platform XDG fallback  |

`YCODING_CONFIG_DIR` overrides the global configuration directory used by the process.

### Native computer helper

Native computer use has no JSON/JSONC configuration or helper-path environment override. A packaged macOS executable resolves `YCoding Computer Use.app` beside itself. Release installation places the verified executable and app bundle in `~/.local/bin`. Every computer operation launches the app bundle. The first desktop operation requests Accessibility access, the first capture requests Screen Recording access, and the first iTerm, Finder, Safari, or Chrome operation requests Automation access to that application; macOS lists **YCoding Computer Use** under Privacy & Security, and the operation succeeds after the user allows it and retries. The release workflow signs the app with the release signing identity `YCoding Code Signing`, a self-signed certificate that is not an Apple Developer ID and does not notarize the app. The app's designated requirement names the bundle identifier `app.ycoding.computer-use` and that certificate, so it stays the same across releases signed this way; macOS and the user still decide whether a grant applies. An ad-hoc signed release has a different requirement that pins one build, so after installing the first release signed with this identity, macOS may ask for authorization again: if an operation still reports a denied permission, remove the existing **YCoding Computer Use** entry from each Privacy & Security list with **−**, and allow the new entry that the next operation adds. An archive downloaded with a web browser carries the `com.apple.quarantine` attribute; after extracting it, run `xattr -dr com.apple.quarantine <extracted-folder>` before starting `ycoding`. The curl installer and `ycoding update` download without that attribute.

Safari `webbrowser.eval`, `webbrowser.back`, `webbrowser.forward`, and `webbrowser.reload` require Safari's **Develop > Allow JavaScript from Apple Events** setting; Chrome `webbrowser.eval` requires Chrome's **View > Developer > Allow JavaScript from Apple Events** setting. When these calls fail, they report `native_failure` with an unknown outcome and a message that points to the setting.

For source development on macOS, run `bun run build:computer-use` explicitly before `bun dev`. The build writes the app bundle to the repository-ignored `packages/core/.cache/computer-use/` directory; Bun source execution resolves that fixed path. Set `YCODING_MACOS_SIGNING_IDENTITY` to a code-signing identity in your keychain to sign the build with it and keep privacy grants across rebuilds; a self-signed certificate that your login keychain trusts for code signing is sufficient, and each developer creates their own, never committing it to the repository; without it the build is ad-hoc signed, and after each rebuild you remove the existing **YCoding Computer Use** Privacy & Security entry so the next operation adds it again. Runtime startup never compiles or installs the app, and it never writes beside the user's Bun executable. Windows and Linux expose no native computer capabilities. See [Native computer use](./computer-use.md).

On POSIX systems, YCoding restricts its log directory to mode `0700` and the active YCoding log file to `0600`, whether that file is new or pre-existing. Startup repairs more-permissive modes without deleting or rewriting existing log content.

The server-hosted remote connector writes warning-level diagnostics to the active YCoding log file in `$XDG_DATA_HOME/ycoding/log` with `component=remote-connector`. A relay-close entry records the close code and whether the connector reconnects; failure entries omit error details, so credentials, bearer tokens, and frame payloads never reach the log.

When `$XDG_CONFIG_HOME` is `~/.config`, the global JSONC source is `~/.config/ycoding/ycoding.jsonc`. Compaction helper selection reads the merged runtime configuration from this normal discovery chain; it does not use a separate helper-only configuration file.

## Runtime configuration discovery and precedence

Configuration entries are assembled from lowest to highest priority. For scalar values, the latest document that defines the field wins. Agents, commands, providers, plugins, permissions, and similar domains apply their own ordered merge behavior.

The document order is:

1. Global `ycoding.json`.
2. Global `ycoding.jsonc`.
3. The file named by `YCODING_CONFIG`, when set.
4. Direct `ycoding.json` and `ycoding.jsonc` files discovered from broad ancestors toward the current working directory.
5. `ycoding.json` and `ycoding.jsonc` inside ancestor `.ycoding` directories, from broad ancestors toward the current working directory.
6. Authenticated well-known integration configuration.
7. `YCODING_CONFIG_CONTENT`, which has the highest priority.

Example order:

```text
global -> explicit file -> project -> inline content
```

Within one directory, `ycoding.jsonc` is loaded after `ycoding.json` and therefore has higher priority for fields it defines.

Project discovery walks upward from the current directory. It is not limited to the detected project root. Set `YCODING_CONFIG_PROJECT_DISABLE=true` or `YCODING_DISABLE_PROJECT_CONFIG=true` to disable project discovery.

## JSON and JSONC behavior

Both JSON and JSONC support:

- `//` comments;
- trailing commas;
- unknown properties, which are ignored by Schema decoding;
- `$schema` metadata;
- environment substitution with `{env:NAME}`;
- file substitution with `{file:path}`.

`{file:path}` is resolved relative to the containing configuration file. Absolute paths and `~/` are supported. The referenced file is trimmed and inserted as a JSON string fragment. A `{file:...}` token inside a `//` comment is not resolved.

Example:

```jsonc
{
  "username": "{env:USER}",
  "mcp": {
    "servers": {
      "private": {
        "type": "remote",
        "url": "https://mcp.example.com",
        "headers": {
          "Authorization": "Bearer {file:./secrets/mcp-token.txt}",
        },
      },
    },
  },
}
```

Missing environment variables become an empty string. A missing file reference invalidates that configuration document.

The configuration JSON Schema is generated from the runtime-owned `Config.Info` Schema during the public web build. Its public endpoint is [`https://ycoding.althenia.app/ycoding.schema.json`](https://ycoding.althenia.app/ycoding.schema.json). Publish the built web assets before using the endpoint.

After deployment, use the endpoint in `ycoding.jsonc` for editor validation:

```jsonc
{
  "$schema": "https://ycoding.althenia.app/ycoding.schema.json",
}
```

Use the generated YCoding schema endpoint rather than a different product's schema.

## Terminal installation and commands

After the public site and a native release are published, `curl -fsSL https://ycoding.althenia.app/install.sh | sh` installs a checksum-verified release executable in `~/.local/bin`. Installation does not require a separate Bun runtime. The installer applies the same archive checks as `ycoding update`. It checks the shell configuration and adds the binary directory to PATH only when needed; unsupported shells receive manual PATH guidance.

`ycoding` opens the interactive terminal interface. `ycoding --model <provider/model> "prompt"` executes a direct non-interactive run instead. `ycoding run --help` lists the explicit run command's options. These paths share the existing durable Session execution and permission handling.

The installed executable includes `ycoding service start`, `restart`, `status`, `stop`, `get`, `set`, and `unset` for the managed background server. `ycoding service --help` lists these controls. `status` reports the running endpoint or `stopped` without starting a server. `restart` interrupts executing Sessions; let their work finish before restarting to apply an update.

**Keep machine awake** is an opt-in, runtime-only control in the TUI command palette and the web client's **Settings → Machine** section. The TUI Status dialog also reports its state. It controls the selected backend machine, not the phone or browser viewing it. On macOS it prevents idle system sleep while enabled; closing the lid or requesting sleep manually still allows sleep. Disabling it or stopping, restarting, updating, or crashing the backend releases the inhibitor. Each backend starts with it off. Linux and Windows report unsupported. There is no saved preference or automatic re-enabling, and the web control requires a reachable machine.

The TUI palette, Status dialog, and web control report **Checking** until the backend answers, rather than assuming Off. The web control shows **Unavailable** for an unreachable machine or unavailable operation, **Unsupported** for an unsupported platform, and **Error** for a backend inhibitor failure. A failed or unknown change remains visible without claiming it took effect; reconnect does not replay or rearm it. Keeping the machine awake does not preserve execution or network connectivity through manual sleep or lid closure.

`ycoding update` checks GitHub Releases and replaces an installed release only after verifying its archive checksum and contents. It checks every archive entry, accepting only regular files and directories and rejecting links, devices, absolute or parent-relative paths, unsafe or duplicate names, entries above the size limit, and archives with more than 1024 entries; it requires the files the release version needs and extracts only those, so additional archive entries are ignored and never written. In a terminal it redraws one progress line: a download bar with percentage and megabytes when the release reports its size (otherwise the megabytes received), then checksum verification and installation; redirected output prints each phase once. macOS releases from 0.2.0 through 0.7.0 contain `ycoding` and `ycoding-computer-helper`; 0.7.1 contains those files plus the signed `ycoding-computer-helper.app` bundle. Later macOS releases contain `ycoding`, the `YCoding Computer Use.app` bundle, and `ycoding-chrome-extension`; the installer and updater require the app's signature to verify (`codesign --verify --deep --strict`) but do not compare its signing identity with the installed app's, and macOS may request renewed Privacy & Security authorization when an update changes the app's signing identity, as described under native computer use; installing one removes a sibling `ycoding-computer-helper` and `ycoding-computer-helper.app`. Self-update preserves and restores the installed files and apps together if replacement fails. Explicit rollback to a published pre-0.2.0 macOS version accepts its historical single-file archive and leaves any sibling helper unchanged. Linux releases through 0.7.1 are single-file, and later Linux releases add `ycoding-chrome-extension`; installing a later release on either platform replaces that folder and restores it if replacement fails. Self-update supports macOS arm64/x64 and Linux x64, matching the shell installer. Development builds must be rebuilt locally: `bun run build:tui` writes the executable, the macOS `YCoding Computer Use.app`, and `ycoding-chrome-extension` together under `dist/tui/<target>/bin`, and `bun run install:local` copies all of them into `~/.local/bin` on macOS and Linux. It fails without changing the installation when the build is incomplete or the macOS app fails signature verification, and replaces each installed item by rename so a running `ycoding` keeps its open executable. Each build re-signs the app ad hoc unless `YCODING_MACOS_SIGNING_IDENTITY` names a signing identity. After installing, `install:local` reads the installed app's actual signature and prints whether it is ad-hoc signed, in which case each build has a different code requirement and you remove the old **YCoding Computer Use** Privacy & Security entries and allow the new one when prompted, or signed by a named certificate, in which case macOS decides whether existing grants apply. Windows users must exit YCoding and replace the executable from the release ZIP manually.

After `ycoding update` installs a release, it applies the release to the running background server without opening the TUI. It looks for a background server of any version; when none is running it prints `No background server is running; nothing to restart`. Otherwise it reads the server's work with `GET /api/session/outstanding` and counts the Sessions in its `running` list: Sessions with an executing drain or a live background shell. When none is running it restarts the server through the managed restart that `ycoding service restart` uses, so the replacement starts from the newly installed executable, and prints `Restarted the background server`. Admitted inputs, settled shell notices, subagent notices, and active goals that are not running do not delay the restart. A restart interrupts executing Sessions and a server start never resumes them, so a server with running Sessions keeps running: the command prints how many Sessions have running work and that `ycoding service restart` applies the update once they finish. `ycoding update --force` (`-f`) restarts the server even while Sessions are running: it prints `Interrupting <n> running Session(s) to restart the background server...` with the number of running Sessions read just before the restart, then `Restarted the background server`; without running Sessions the flag changes nothing. `--force` never overrides a failed outstanding-work read. When that read fails or takes longer than five seconds, the server is not restarted, with or without the flag, and the command reports the failure with the same instruction. Neither outcome changes the exit status. A failed restart leaves the update installed, reports the failure and `ycoding service restart` on standard error, and exits with status 1. A failed or rolled-back install, and an installation that is already current, never query or restart the server. The executable that runs `ycoding update` performs these steps, not the release it installs, so an update run by a release without them installs the new release but still requires `ycoding service restart` or opening the TUI to run it in the background server.

The background update check resolves the newest release from the same GitHub Releases source and only announces its availability with the explicit `ycoding update` command. It never downloads release assets, installs an update, replaces executables, or restarts the application. An omitted `autoupdate`, `true`, and `"notify"` all enable notice-only checks for patch, minor, and major releases; `false` disables the check. Installation requires the user to run `ycoding update`.

### Remote access

`ycoding remote` gives the authenticated owner of an enrolled machine access to every Session in that machine's backend through a relay deployment. The local process keeps execution authority; see [Runtime behavior](./runtime.md#remote-relay-agent) for backend-derived Location, authorization, reconnection, and frame-bounding rules.

The standalone terminal artifact and the full CLI expose the same remote subcommands and handlers. Remote access does not require a separate full-CLI installation.

In the browser, **New session** selects from existing repositories recorded by that backend. Open a missing repository locally, then use **Refresh repositories**. New Sessions use the selected directory's configured `default_agent` and `model` when no Session-specific selection exists; configure providers and credentials on the machine. The browser does not accept an arbitrary directory or create repositories.

| Command                                                                                 | Purpose                                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ycoding remote enroll <enrollmentID> [--name <name>] [--relay <origin>] [--replace]`   | Enroll this machine with a relay. The one-use enrollment code is read from the terminal, never argv. |
| `ycoding remote connect [--relay <origin>] [--server <url> \| --standalone]`            | Turn on the resolved server's remote connection and return once it is on; `--standalone` stays in the foreground until Ctrl-C. |
| `ycoding remote disconnect [--server <url> \| --standalone]`                            | Turn off the resolved server's remote connection.                                                    |
| `ycoding remote status [--server <url> \| --standalone]`                               | Show enrollment, credential validity, local server address, backend Session count, and the remote connection state. An unenrolled machine reports only that it is not enrolled, without starting or contacting a local server. |
| `ycoding remote sessions [--server <url> \| --standalone]`                             | List every Session in the backend through its authoritative Location.                                |

`ycoding remote enroll` requires a relay origin, and `--replace` is required before an existing device identity can be overwritten. `ycoding remote connect` requires an enrolled device and refuses to bridge a local server over a LAN or public-network endpoint.

The machine's remote connection belongs to the local server. The managed background service hosts it, so it stays on while that service runs, including when no TUI is open; a `--standalone` private server hosts its own connection for its lifetime. The TUI and the CLI switch and read it only through the server's authenticated `GET /api/remote` and `PUT /api/remote` (`{ enabled }`) operations, which report `off`, `connecting`, `on`, or `error` with an optional message. The TUI command palette offers one **Remote connection** toggle whose indicator is green for ● on and grey for ● off, ● connecting, or ● error; every TUI attached to the same server shows the same state, refreshed every 2 seconds. Selecting the row turns the connection off when it is on and on otherwise. Turning it on shows the owner-access notice: connecting grants the machine owner access to every existing and future Session on that backend. An unenrolled machine reports an error with the command to run, `ycoding remote enroll <enrollmentID>`. The server stores the on/off choice atomically in `remote.json` under the YCoding state directory, restores it when it starts, and stops the connection without clearing that choice when it shuts down; an unreadable stored choice reports an error instead of connecting. One connector lock under the YCoding data directory allows a single connection per machine: a server that cannot take a live lock reports an error, and a stale lock is reclaimed on the next start.

Local state lives outside any repository checkout:

| File                    | Location                                                                            | Contents                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `remote.json`           | Global configuration directory: `$XDG_CONFIG_HOME/ycoding`, or `YCODING_CONFIG_DIR` | Optional relay origin. Existing Session entries are preserved but do not authorize or restrict remote access.                |
| `remote-device.json`    | Global state directory: `$XDG_STATE_HOME/ycoding`                                   | The device identity: device ID, name, relay origin, P-256 public key, P-256 private key, and the rotated refresh credential. |
| `remote.json`           | Global state directory: `$XDG_STATE_HOME/ycoding`                                   | The machine's remote connection on/off choice, written atomically by the local server.                                       |
| `remote-connector.lock` | Global data directory: `$XDG_DATA_HOME/ycoding`                                     | The PID of the server process that holds this machine's remote connection.                                                   |

The configuration and device files are written through a temporary file and renamed into place with mode `0600`, and a symbolic link at either path is refused instead of followed. The device private key never leaves the machine, and credentials travel only in request bodies and the WebSocket upgrade header, never in a URL, a flag, or an environment variable. A malformed file fails explicitly and is left in place for the operator. Credential requests never follow redirects, and a rejected, revoked, or expired device credential is terminal: the device must be enrolled again.

Relay sign-in is restricted by a server-only allowlist. `GOOGLE_ALLOWED_EMAILS` holds comma-, whitespace-, or newline-separated Google addresses matched exactly after trimming and lowercasing, with no wildcards or domain suffixes, and it is never returned through an API, a redirect, a log, or the browser bundle. Admission requires a configured entry, a Google-verified email, and an exact match; a missing or empty list denies every Google sign-in. The relay deployment also supplies `GOOGLE_CLIENT_ID` and the `GOOGLE_CLIENT_SECRET` secret.

Provisioning is an operator action in `infra/cloudflare`. `wrangler.jsonc` selects the Durable Object and D1 bindings, the static-assets binding for the built web client, and the custom domain; the Google secrets are set with `wrangler secret put`.

## Rejected configuration keys

A document containing any rejected key is ignored as a whole. Rejected keys are:

```text
logLevel
server
command
reference
snapshot
plugin
autoshare
disabled_providers
enabled_providers
small_model
mode
agent
provider
permission
tools
attachment
layout
```

The MCP shape where server names appear directly under `mcp` is also rejected. Use `mcp.servers`.

## Complete top-level runtime fields

| Field                   | Type                                  | Purpose                                                                                     |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `$schema`               | string                                | Optional editor metadata only.                                                              |
| `shell`                 | string                                | Preferred shell for terminal and shell execution.                                           |
| `shell_sandbox`         | `disabled`, `optional`, or `required` | Shell isolation policy.                                                                     |
| `shell_memory_limit_mb` | non-negative integer                  | Default shell command process-tree memory limit in MiB; zero disables the default.          |
| `model`                 | model selector                        | Default model.                                                                              |
| `default_agent`         | string                                | Default selectable primary agent.                                                           |
| `autoupdate`            | boolean or `notify`                   | Notice-only update checks; `false` disables checks. Installation is always manual.           |
| `share`                 | `manual`, `auto`, or `disabled`       | Session sharing policy accepted by Schema.                                                  |
| `enterprise.url`        | string                                | Enterprise sharing endpoint accepted by Schema.                                             |
| `username`              | string                                | Display and telemetry identity.                                                             |
| `permissions`           | permission rules                      | Global ordered tool permission rules.                                                       |
| `agents`                | record                                | Built-in overrides and custom agents.                                                       |
| `snapshots`             | boolean                               | Undo/revert snapshot behavior.                                                              |
| `watcher.ignore`        | string array                          | Watcher ignore patterns.                                                                    |
| `formatter`             | boolean or formatter record           | Built-in formatter enablement and overrides.                                                |
| `lsp`                   | boolean or LSP record                 | Built-in language-server enablement and overrides.                                          |
| `attachments`           | object                                | Attachment processing, currently image limits and resizing.                                 |
| `tool_output`           | object                                | Tool-output truncation limits.                                                              |
| `mcp`                   | object                                | MCP defaults and named servers.                                                             |
| `compaction`            | object                                | Selective-compaction retention, budget, manifest, and advisory policy.                      |
| `skills`                | string array                          | Additional skill directories or HTTP(S) sources.                                            |
| `commands`              | record                                | Named slash commands.                                                                       |
| `instructions`          | string array                          | Accepted by Schema, but no current runtime consumer reads this field. Do not rely on it.    |
| `instruction_max_bytes` | positive integer                      | Maximum bytes loaded from each ambient instruction file; default 51,200, maximum 1,048,576. |
| `references`            | record                                | Named local or Git context sources.                                                         |
| `plugins`               | array                                 | Ordered plugin additions, options, and removals.                                            |
| `providers`             | record                                | Provider and model overrides.                                                               |
| `memory`                | object                                | On-demand workspace knowledge enablement, base path, and concept/bundle limits.             |
| `efficiency`            | object                                | Helper-model, prompt-cache, and provider-continuation policy.                               |
| `image_analyzer`        | object                                | Image analysis fallback for text-only models.                                               |
| `experimental`          | object                                | Subagent depth and resource policies.                                                       |

### Shell memory limits

The model-facing shell `timeout` input is not a configuration field. It accepts whole milliseconds up to 3,600,000 (one hour); omission or `0` selects the finite 600,000 ms default. Values above one hour are rejected. A foreground command that remains active after 300,000 ms is moved to the background without being terminated; its selected timeout still applies.

`shell_memory_limit_mb` sets the Location-wide default for non-interactive shell commands. The shell tool's `memory_limit_mb` input overrides it for one command; zero explicitly selects unlimited memory. Omission uses the configured default, and omission with no default remains unlimited.

A finite limit supplies `GOMEMLIMIT=<limit>MiB` to Go runtimes, including compatible `tsgo` builds, and appends `--max-old-space-size=<limit>` to `NODE_OPTIONS` for Node processes. Bun does not expose an inherited heap-size option equivalent to Node's, so Bun itself is governed by the sampled process-tree ceiling while child Go or Node runtimes receive their soft hints.

On macOS and Linux, YCoding samples aggregate resident memory for the detached shell process group every 250 milliseconds and terminates the group with status `memory-limit` after a sample exceeds the limit. Sampling can overshoot between checks, shared pages can be counted more than once, and a command that deliberately creates a new process group can escape aggregate accounting. This is resource control, not a security boundary or a kernel hard limit. Windows rejects a finite shell memory limit because the current process abstraction cannot assign the command to a Job Object before it starts.

### Field defaults and nested Schema contract

The field reference below expands the overview. `unset` means the field is optional in Schema and has no default specified here.

| Field path                                        | Exact type or closed values                                                    | Default         | Operational remark                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------- |
| `$schema`                                         | string                                                                         | unset           | Editor metadata only.                                                                             |
| `shell`                                           | string                                                                         | unset           | Shell executable or command selector.                                                             |
| `shell_sandbox`                                   | `disabled` \| `optional` \| `required`                                         | unset           | Shell isolation policy.                                                                           |
| `shell_memory_limit_mb`                           | non-negative integer `<= 1048576`                                              | unset           | Default sampled resident-memory limit in MiB; zero means unlimited.                               |
| `model`                                           | model selector                                                                 | unset           | Session/agent model fallback.                                                                     |
| `default_agent`, `username`                       | string                                                                         | unset           | Primary agent ID and display identity.                                                            |
| `autoupdate`                                      | boolean \| `notify`                                                            | unset           | Notice-only checks; `false` disables them.                                                          |
| `share`                                           | `manual` \| `auto` \| `disabled`                                               | unset           | Sharing policy.                                                                                   |
| `enterprise.url`                                  | string                                                                         | unset           | Enterprise endpoint.                                                                              |
| `permissions`                                     | ordered `[{ action: string, resource: string, effect: allow \| deny \| ask }]` | unset           | Global permission rules.                                                                          |
| `agents`                                          | record of `Config.Agent`                                                       | unset           | Inline agent definitions and overrides.                                                           |
| `snapshots`                                       | boolean                                                                        | unset           | Snapshot switch.                                                                                  |
| `watcher`                                         | `Config.Watcher`                                                               | unset           | Watcher filters.                                                                                  |
| `formatter`                                       | boolean \| record of `Config.Formatter.Entry`                                  | unset           | Formatter enablement and overrides.                                                               |
| `lsp`                                             | boolean \| record of `Config.LSP.Entry`                                        | unset           | Language-server enablement and overrides.                                                         |
| `attachments`, `tool_output`, `mcp`, `compaction` | their named `Config.*` object                                                  | unset           | Runtime tooling and context controls.                                                             |
| `guardrails`                                      | `Config.Guardrail`                                                             | unset           | Root-Session-family guardrail configuration; custom-source and reply rules are documented below.  |
| `skills`, `instructions`                          | string[]                                                                       | unset           | Extra skill sources; `instructions` has no current ambient-discovery consumer.                    |
| `instruction_max_bytes`                           | positive integer `<= 1048576`                                                  | `51200`         | Per-ambient-instruction UTF-8 byte cap.                                                           |
| `commands`                                        | record of `Config.Command`                                                     | unset           | Inline slash commands.                                                                            |
| `references`                                      | record of `Config.Reference.Entry`                                             | unset           | Named local or Git context sources.                                                               |
| `plugins`                                         | (`string` \| `{ package: string, options?: Record<string, unknown> }`)[]       | unset           | Ordered runtime plugin directives.                                                                |
| `providers`                                       | record of `Config.Provider`                                                    | unset           | Provider/model overrides.                                                                         |
| `provider_usage`                                  | `Config.ProviderUsage`                                                         | unset           | Read-only provider-usage client bridge.                                                           |
| `efficiency`                                      | `Config.Efficiency`                                                            | runtime-derived | Helper-model, cache, and continuation policy.                                                     |
| `image_analyzer`                                  | `Config.ImageAnalyzer`                                                         | unset           | Vision fallback for text-only models: provider/model, prompt, and thresholds.                     |
| `experimental`                                    | `Config.Experimental`                                                          | unset           | Experimental runtime policy.                                                                      |

| Nested field path                                                                       | Exact type or closed values                                                                                     | Default                         | Operational remark                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.<id>.model`                                                                     | model selector                                                                                                  | unset                           | Agent model override.                                                                                                                                                             |
| `agents.<id>.request.headers`, `.request.body`                                          | string record, JSON record                                                                                      | unset                           | Provider request overlays.                                                                                                                                                        |
| `agents.<id>.system`, `.description`                                                    | string                                                                                                          | unset                           | System instruction and display description.                                                                                                                                       |
| `agents.<id>.mode`                                                                      | `subagent` \| `primary` \| `all`                                                                                | unset                           | Agent availability.                                                                                                                                                               |
| `agents.<id>.hidden`, `.disabled`                                                       | boolean                                                                                                         | unset                           | Visibility and disable switches.                                                                                                                                                  |
| `agents.<id>.color`                                                                     | `#RRGGBB` \| `primary` \| `secondary` \| `accent` \| `success` \| `warning` \| `error` \| `info`                | unset                           | TUI color.                                                                                                                                                                        |
| `agents.<id>.steps`                                                                     | positive integer                                                                                                | unset                           | Agent step allowance.                                                                                                                                                             |
| `agents.<id>.permissions`                                                               | `Permission.Rule[]`                                                                                             | unset                           | Agent permission additions.                                                                                                                                                       |
| `commands.<name>.template`                                                              | string                                                                                                          | required                        | Command prompt template.                                                                                                                                                          |
| `commands.<name>.description`, `.agent`                                                 | string                                                                                                          | unset                           | Picker description and agent ID.                                                                                                                                                  |
| `commands.<name>.model`                                                                 | model selector                                                                                                  | unset                           | Command model override.                                                                                                                                                           |
| `commands.<name>.subtask`                                                               | boolean                                                                                                         | unset                           | Subtask request.                                                                                                                                                                  |
| `references.<name>`                                                                     | string \| `{ repository: string, branch?, description?, hidden? }` \| `{ path: string, description?, hidden? }` | required per entry              | Reference source.                                                                                                                                                                 |
| `mcp.timeout.startup`, `.catalog`, `.execution`                                         | positive integer milliseconds                                                                                   | runtime-derived                 | Global timeout overrides.                                                                                                                                                         |
| `mcp.servers.<name>`                                                                    | local \| remote server object                                                                                   | required per entry              | Discriminated by `.type`.                                                                                                                                                         |
| local `.command`                                                                        | string[]                                                                                                        | required                        | Stdio command and arguments.                                                                                                                                                      |
| local `.cwd`, `.environment`, `.disabled`, `.timeout`                                   | string, string record, boolean, timeout object                                                                  | unset                           | Local-server options; relative `cwd` resolves from workspace.                                                                                                                     |
| remote `.url`                                                                           | string                                                                                                          | required                        | Remote MCP endpoint.                                                                                                                                                              |
| remote `.headers`, `.disabled`, `.timeout`                                              | string record, boolean, timeout object                                                                          | unset                           | Remote-server options.                                                                                                                                                            |
| local/remote `.codemode`                                                                | boolean                                                                                                         | `true`                          | Code Mode catalog exposure.                                                                                                                                                       |
| remote `.oauth`                                                                         | `false` \| OAuth object                                                                                         | unset                           | OAuth configuration.                                                                                                                                                              |
| `.oauth.client_id`, `.client_secret`, `.scope`, `.redirect_uri`                         | string                                                                                                          | unset                           | OAuth client fields.                                                                                                                                                              |
| `.oauth.callback_port`                                                                  | integer `1..65535`                                                                                              | unset                           | Local OAuth callback port.                                                                                                                                                        |
| `providers.<id>.name`, `.package`                                                       | string                                                                                                          | unset                           | Provider identity/implementation override.                                                                                                                                        |
| `providers.<id>.env`                                                                    | string[]                                                                                                        | unset                           | Credential variable names; never place credential values in config.                                                                                                               |
| `providers.<id>.settings`, `.headers`, `.body`                                          | JSON record, string record, JSON record                                                                         | unset                           | Provider request overlays.                                                                                                                                                        |
| `providers.<id>.catalog.source`                                                        | `openai-models`                                                                                                 | unset                           | Optional model catalog discovery for a configured provider.                                                                                                                     |
| `providers.<id>.models.<id>.modelID`, `.family`, `.name`, `.package`                    | model ID, model family, string, string                                                                          | unset                           | Model identity.                                                                                                                                                                   |
| model `.settings`, `.headers`, `.body`                                                  | JSON record, string record, JSON record                                                                         | unset                           | Model request overlays.                                                                                                                                                           |
| model `.capabilities.tools`                                                             | boolean                                                                                                         | unset                           | Tool-call declaration.                                                                                                                                                            |
| model `.capabilities.input`, `.output`                                                  | string[]                                                                                                        | unset                           | Input/output modality names.                                                                                                                                                      |
| model `.variants[]`                                                                     | `{ id: variant ID, settings?, headers?, body? }`                                                                | unset                           | Named request variants.                                                                                                                                                           |
| model `.cost`                                                                           | cost object \| cost object[]                                                                                    | unset                           | USD-per-million input/output cost; optional cache and context-tier data.                                                                                                          |
| model `.disabled`                                                                       | boolean                                                                                                         | unset                           | Model disable switch.                                                                                                                                                             |
| model `.limit.context`, `.input`, `.output`                                             | integer                                                                                                         | unset                           | Declared model limits.                                                                                                                                                            |
| model `.api`                                                                            | `chat` \| `responses`                                                                                           | unset                           | OpenAI-compatible request surface; `responses` overrides the source default and the catalog value.                                                                                |
| `formatter.<name>`                                                                      | `{ disabled?, command?: string[], environment?: Record<string, string>, extensions?: string[] }`                | unset                           | Formatter override.                                                                                                                                                               |
| `lsp.<name>`                                                                            | `{ disabled: true }` \| `{ command: string[], extensions?, disabled?, env?, initialization? }`                  | unset                           | LSP override.                                                                                                                                                                     |
| `attachments.image.auto_resize`                                                         | boolean                                                                                                         | unset                           | Image resizing.                                                                                                                                                                   |
| `attachments.image.max_width`, `.max_height`, `.max_base64_bytes`                       | positive integer                                                                                                | unset                           | Image limits.                                                                                                                                                                     |
| `tool_output.max_lines`, `.max_bytes`                                                   | positive integer                                                                                                | unset                           | Output truncation thresholds.                                                                                                                                                     |
| `watcher.ignore`                                                                        | string[]                                                                                                        | unset                           | Watcher ignore patterns.                                                                                                                                                          |
| `compaction.keep_recent_messages`                                                       | non-negative integer                                                                                            | `20`                            | Number of newest complete messages protected from selective exclusion. Model-switch boundary advice requires an explicit value.                                                   |
| `compaction.reserved_output_tokens`                                                     | non-negative integer                                                                                            | `0`                             | Output-token reservation used by compaction helper requests.                                                                                                                      |
| `compaction.context_safety_margin_tokens`                                               | non-negative integer                                                                                            | `4096`                          | Tokens reserved from the model input budget before context-pressure and model-switch fit calculations.                                                                            |
| `compaction.timeout_seconds`                                                            | non-negative integer                                                                                            | `60`                            | Total provider-assisted checkpoint-generation budget across all helper calls; expiry stops helper traffic and uses the local canonical checkpoint, while `0` disables the budget. |
| `compaction.max_output_tokens`                                                          | non-negative integer                                                                                            | `0`                             | Compaction helper output cap; `0` uses the model cap.                                                                                                                             |
| `compaction.max_manifest_bytes`                                                         | non-negative integer                                                                                            | `65536`                         | UTF-8 cap for one strict ContextManifest candidate.                                                                                                                               |
| `compaction.max_internal_passes`                                                        | non-negative integer                                                                                            | `8`                             | Maximum physical manifest-generation calls, including repair attempts.                                                                                                            |
| `compaction.advisory`                                                                   | `false` \| `{ consider_percent, strongly_advised_percent }`                                                     | `{ 70, 90 }`                    | Disables automatic soft-pressure admission or sets ordered integer thresholds from 1 through 99. Mandatory pressure at the hard cap is independent of this switch.                |
| `guardrails.enabled`                                                                    | boolean                                                                                                         | unset                           | Guardrail switch.                                                                                                                                                                 |
| `guardrails.max_concurrent_shells`, `.max_concurrent_subagents`, `.max_pending_reviews` | positive integer                                                                                                | unset                           | Root-Session-family caps for running shells, running subagents, and pending reviews.                                                                                              |
| `provider_usage.codex_app_server.command`                                               | non-empty string                                                                                                | required when object is present | Direct executable, not a shell command.                                                                                                                                           |
| `provider_usage.codex_app_server.args`                                                  | string[]                                                                                                        | unset                           | Executable arguments.                                                                                                                                                             |
| `provider_usage.codex_app_server.cwd`                                                   | string                                                                                                          | unset                           | Client working directory.                                                                                                                                                         |
| `provider_usage.codex_app_server.timeout_ms`                                            | positive integer `<= 30000`                                                                                     | unset                           | App-server timeout.                                                                                                                                                               |
| `efficiency.title`                                                                      | `local` \| `model` \| `off`                                                                                     | `local`                         | Title policy.                                                                                                                                                                     |
| `efficiency.helper_models.title`, `.goal`, `.compaction.main`, `.compaction.subagent`   | model selector \| `session`                                                                                     | `session`                       | Independent model selection for title, goal, and ContextManifest helpers.                                                                                                         |
| `efficiency.prompt_cache.anthropic_ttl`                                                 | `adaptive` \| `5m` \| `1h`                                                                                      | `adaptive`                      | Cache lifetime policy.                                                                                                                                                            |
| `efficiency.prompt_cache.openai_mode`                                                   | `auto` \| `implicit` \| `explicit`                                                                              | `auto`                          | OpenAI cache lowering.                                                                                                                                                            |
| `efficiency.prompt_cache.openai_extended_retention`                                     | boolean                                                                                                         | `false`                         | Pre-GPT-5.6 OpenAI and Meta Muse Spark `24h` retention request.                                                                                                                                              |
| `efficiency.openai_responses_continuation`                                              | `auto` \| `on` \| `off`                                                                                         | `auto`                          | Response continuation policy.                                                                                                                                                     |
| `efficiency.openai_responses_state`                                                     | `stored` \| `stateless`                                                                                         | `stored`                        | Direct OpenAI Responses storage mode. Stored mode permits compatible response-ID continuation; stateless mode replays opaque provider state.                                      |
| `experimental.subagent_depth`                                                           | non-negative integer                                                                                            | `1`                             | Maximum nesting depth.                                                                                                                                                            |
| `experimental.policies`                                                                 | `Config.Policy.Info[]`                                                                                          | unset                           | Ordered configured-resource policies.                                                                                                                                             |

### Provider-usage reporting

`provider_usage` configures only the optional Codex app-server fields above. Provider usage refreshes use credentials already stored for the matching YCoding integration; they do not discover credentials from another application's files, keychain, or browser cookies. GitHub Copilot reuses the OAuth credential configured for `github-copilot`.

After unsuccessful Copilot model discovery, YCoding removes previously discovered Copilot model entries so stale models cannot remain selectable.

Copilot model discovery identifies itself as the `vscode-chat` integration, which the Copilot models endpoint requires before returning the account's model catalog.

For `github.com` accounts, the read-only, best-effort refresh queries `GET https://api.github.com/copilot_internal/user`. A paid plan's `premium_interactions` bucket is presented as **AI credits** used against its monthly allotment; enabled, reported overage is **Extra usage**. Free-plan Chat and Completions windows appear only when a finite allowance is reported. Org-managed seats can report a personal AI-credit count without a per-seat percentage; when billing access permits, `GET /user/orgs` and the organization billing usage summary add separate **Org credits** (the whole org's gross credit quantity) and **Org spend** (the whole org's billed net amount). Billing lookup failures do not remove personal credit data. No account email, token, or raw response reaches Protocol or the TUI.

OpenRouter always attempts `GET https://openrouter.ai/api/v1/credits` with its configured account key, even without management metadata. When permitted, **Credits** measures lifetime usage against purchased credits and **Balance** is remaining credit; a 401/403 on this optional call leaves balance absent while `/key` spend remains available. `/key` supplies measured Today, This Week, and This Month spend and a Key Limit only for capped keys. Its current-window used amount is the cap minus `limit_remaining`, not lifetime key usage.

Claude Code OAuth exposes Session, Weekly, model-scoped weekly, and Extra usage from Anthropic's usage endpoint; Codex OAuth or a configured app-server exposes Session, Weekly, Spark, reset credits, and Extra usage. A stored xAI Grok OAuth login exposes the shared weekly pool and pay-as-you-go cap; a stored OpenCode Go key exposes its account-wide Session, Weekly, and Monthly percentages; and a stored Z.ai or Z.ai Coding Plan key exposes Session, Weekly, and Web Searches. These provider-internal metrics are best effort. The Usage view separately shows **YCoding local** Today spend from retained, priced provider requests for available Claude, OpenAI/Codex, Grok, OpenCode Go, and OpenCode Zen providers. This provider-wide local amount is not attributed to a credential profile, does not read another application's session logs, and is not an account-wide provider charge; unpriced requests cannot create a dollar amount, while a recorded $0.00 remains a measured zero. Missing values stay unreported.

## Model selectors

A model selector may be a string:

```json
"openrouter/openai/gpt-5#high"
```

or an explicit object:

```json
{
  "providerID": "openrouter",
  "model": "openai/gpt-5",
  "variant": "high"
}
```

The variant is optional; omit it to select the base model. Every explicit variant ID must be offered by the selected model, or model resolution fails with `VariantUnavailableError`. `default` and `none` are ordinary variant IDs. An offered `none` variant can select reasoning effort `none` on OpenAI models or disable thinking on DeepSeek. The TUI variant cycle includes an offered `none` variant.

Catalog reasoning variants reach the provider request in each provider's own format: DeepSeek variants send `thinking: { type: "enabled" | "disabled" }` and the requested `reasoning_effort`, which DeepSeek maps server-side; native OpenRouter variants send their `reasoning` object (`effort`, `enabled`, or `max_tokens`), merged with any configured OpenRouter reasoning options.

## Provider efficiency

The optional `efficiency` block controls provider-request amplification and prompt caching:

```jsonc
{
  "efficiency": {
    "title": "local",
    "helper_models": {
      "title": "openai/gpt-5-mini#low",
      "goal": "openai/gpt-5-mini#low",
      "compaction": {
        "main": "session",
        "subagent": "openai/gpt-5-mini#low",
      },
    },
    "prompt_cache": {
      "anthropic_ttl": "adaptive",
      "openai_mode": "auto",
      "openai_extended_retention": false,
    },
    "openai_responses_continuation": "auto",
    "openai_responses_state": "stored",
  },
}
```

| Field                                    | Values                         | Default    | Purpose                                                                                                          |
| ---------------------------------------- | ------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `title`                                  | `local`, `model`, `off`        | `local`    | Generate Session titles locally, with a model, or not at all.                                                    |
| `helper_models.title`                    | model selector, `session`      | `session`  | Model for model-generated Session titles.                                                                        |
| `helper_models.goal`                     | model selector, `session`      | `session`  | Model for model-based goal synthesis.                                                                            |
| `helper_models.compaction.main`          | model selector, `session`      | `session`  | Model for ContextManifest generation in main chats.                                                              |
| `helper_models.compaction.subagent`      | model selector, `session`      | `session`  | Model for ContextManifest generation in child Sessions.                                                          |
| `prompt_cache.anthropic_ttl`             | `adaptive`, `5m`, `1h`         | `adaptive` | Choose Anthropic-compatible cache lifetime behavior.                                                             |
| `prompt_cache.openai_mode`               | `auto`, `implicit`, `explicit` | `auto`     | Select OpenAI prompt-cache behavior according to model and route capabilities.                                   |
| `prompt_cache.openai_extended_retention` | boolean                        | `false`    | Request `24h` cache retention for supported pre-GPT-5.6 OpenAI and Meta Muse Spark models.                                       |
| `openai_responses_continuation`          | `auto`, `on`, `off`            | `auto`     | Reuse compatible durable direct OpenAI Responses state when state mode is `stored` and effective storage allows. |
| `openai_responses_state`                 | `stored`, `stateless`          | `stored`   | Select provider-stored response-ID continuation or stateless opaque replay for direct OpenAI Responses.          |

`prompt_cache.anthropic_ttl: "adaptive"` gives root Session steps the one-hour bucket from their first request. Child Sessions and title, goal, and compaction requests get the five-minute bucket. A request source never changes its TTL, because changing it misses every cache entry written earlier. Models without published extended-TTL support always use five minutes.

## Image analysis fallback

Text-only models cannot natively receive `image/*` media. When `image_analyzer` is configured, YCoding replaces provider images with a deterministic text description so any agent gets consistent understanding.

Multimodal models (those whose `capabilities.input` contains `image/*` or `vision`) bypass the fallback and receive media natively.

Configuration:

```jsonc
{
  // Preferred selector string (provider/model#variant)
  "image_analyzer": {
    "enabled": true,
    "model": "anthropic/claude-sonnet-4",
    "prompt": "Custom prompt (optional)",
    "max_images": 4,
    "max_bytes": 5242880,
  },
  // Legacy separate fields also accepted:
  // "image_analyzer": { "enabled": true, "provider": "anthropic", "model": "claude-sonnet-4", "variant": "high" }
}
```

| Field                 | Type                  | Default                                               | Purpose                                                                                                                         |
| --------------------- | --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | boolean               | `true` when `model` is resolvable, otherwise disabled | Enable/disable fallback. `false` forces passthrough to managed-attachment metadata.                                             |
| `model`               | model selector string | unset                                                 | Vision model used to analyze images (e.g. `"anthropic/claude-sonnet-4"` or `"openai/gpt-4o"`). Required when `enabled` is true. |
| `provider`            | string                | unset                                                 | Legacy alternative to `model` selector when `model` is a plain id without `/`.                                                  |
| `variant`             | string                | unset                                                 | Variant id when using `provider`/`model` separate fields. Ignored if `model` already contains `#variant`.                       |
| `prompt` / `template` | string                | standard pattern                                      | Custom prompt that replaces the built-in comprehensive pattern. `template` is an alias for `prompt`.                            |
| `max_images`          | positive integer      | unset                                                 | Maximum images analyzed per request; excess images become failure notes.                                                        |
| `max_bytes`           | positive integer      | unset                                                 | Maximum bytes per image; oversized images become failure notes.                                                                 |

Standard pattern prompt (used when `prompt` is omitted) is deterministic across agents and instructs the vision model to emit ONLY valid TOON matching the structured schema. Schema is defined in `packages/core/src/session/runner/image-analysis.schema.toon` and exported as `IMAGE_ANALYSIS_TOON_EXAMPLE` from `packages/core/src/session/runner/image-analyzer.ts` (version `1`). It preserves the 7 comprehensive sections as structured fields but in token-efficient tabular form per Chad Vision TOON 4.1 (2-space indent, explicit `[N]` and `{fields}`, tabular for uniform arrays, list-form for non-uniform):

- `version`, `image{name,mime,digest,bytes,description?}`, `scene{overview}`, `objects[N]{type,count,description}`, `text_ocr[N]{content,location}`, `layout{arrangement,spatial,composition}`, `colors{palette[],style,mood}`, `details[]`, `confidence{level,uncertainties[]}`

Prompt embeds the TOON header template as a concrete ` ```toon` example and instructs: “Output ONLY valid TOON matching schema below, 2-space indent, explicit `[N]` and `{fields}`, no JSON, no markdown wrapper except optional ` ```toon` block, tabular for uniform arrays, list-form for non-uniform”. Example header: `objects[2]{type,count,description}:` followed by CSV rows. Token-efficient vs prior free-text 7-heading prose; agent extracts the ` ```toon` block verbatim without re-parsing prose. Measured/visible vs inferred separation via `confidence.uncertainties` aligns with Chad Vision practices.

Fallback replaces each `media` part with a single text block preserving TOON verbatim:

````
[Image Analysis: <filename> (<mime>) via <provider/model>]

```toon
version: "1"
image:
  name: photo.png
  ...
scene:
  overview: ...
objects[2]{type,count,description}:
  cat,1,...
...
```

Original description: ... (if present)
SHA-256: ...
Bytes: ...

````

TOON is validated via `@toon-format/toon` decode when available (`stripToonFences` + `isValidToon`), with metadata (SHA-256, Bytes) kept outside the block for efficient extraction.

Graceful degradation: if the configured vision model is unavailable, the provider is not configured, the request fails, or thresholds are exceeded, the image is not dropped. A failure note with the same header prefix and preserved SHA-256/bytes/description is inserted instead of media, so the agent still sees that an image was present.

Caching and TeamView: the vision analysis is a separate provider request and does not change the stable system/tool prompt-cache prefix of the main request. Each successful description is reused per image content digest, vision model, and effective prompt for the life of the runtime process, so later steps replay byte-identical user messages and make no further vision request for that image. Failed analyses are retried on a later step, and a runtime restart analyzes each image once more. TeamView remains a durable chronological Synthetic user-authority observation; tool semantics are unchanged.

`prompt_cache.openai_mode: "auto"` uses hybrid caching for direct OpenAI Responses requests on GPT-5.6 and later. Requests without a plugin-owned volatile suffix send request-wide implicit mode, keep OpenAI's managed implicit breakpoint, and reserve that breakpoint one of OpenAI's latest 50 read candidates. A request ending in plugin-owned volatile context instead compiles with request-wide explicit mode, keeps that suffix unmarked, and uses all 50 candidates for stable explicit boundaries. In ordinary implicit mode YCoding emits at most 49 explicit `input_text` candidates: one combined system-text marker when system text exists, then the newest eligible non-volatile user and local tool-result text boundaries. `"explicit"` disables the managed breakpoint and uses at most 50 explicit candidates. OpenAI can write the latest three explicit candidates plus the managed breakpoint in implicit mode, or the latest four explicit candidates in explicit mode. Assistant replay remains unmarked `output_text`; marked local tool results use `input_text` inside `function_call_output.output` while structured media remains unchanged. Tool definitions, tool calls, provider-executed tool results, and plugin-owned volatile messages receive no generated marker. Older public OpenAI models remain implicit. ChatGPT Codex requests are key-only for every model: YCoding emits none of `prompt_cache_breakpoint`, `prompt_cache_options`, or `prompt_cache_retention`, and uses the Session-scoped prompt-cache key for `session-id`, `thread-id`, and `x-client-request-id`; the explicitly selected WebSocket route also uses it for process-local socket affinity. Every key-carrying route derives its provider `prompt_cache_key` from the Session ID and the prompt-cache namespace, so parallel Sessions never share a provider key. Request-shape tests do not verify live Codex cache reuse, which remains provider-controlled without a hit-rate guarantee. OpenAI-compatible gateways and unsupported model families omit GPT-5.6-only fields. `"implicit"` disables YCoding's generated explicit markers.

Direct OpenAI GPT-5.6 Responses requests automatically request `reasoning.context: "all_turns"` and enable server-side compaction at `200000` rendered tokens. In `stateless` mode, encrypted compaction items are retained outside public Session messages and replayed only for the same provider model. In `stored` mode, compatible requests may instead continue with `previous_response_id`. Direct OpenAI is Responses-only; configured third-party OpenAI-compatible Chat remains a separate route family. ChatGPT OAuth uses Codex HTTP/SSE by default. Set `providers.openai.settings.transport` to `"websocket"` to select the distinct Codex WebSocket route; `"http"` or omission selects HTTP/SSE, and neither route falls back to the other.

The native OpenAI and ChatGPT/Codex routes do not consume `chunkTimeout`, `headerTimeout`, or `timeout` from `providers.openai.settings`. `chunkTimeout` and `timeout` are AI-SDK adapter controls for providers resolved through an AI-SDK package, while `headerTimeout` currently has no runtime consumer. These fields do not prevent an established Codex SSE socket from being reset; native Codex recovery uses the bounded transport retry policy documented in [`runtime.md`](./runtime.md).

Daybreak is OpenAI's Trusted Access for Cyber program with two access levels, `daybreak_blue` and `daybreak_red`, selected per Session as `session.daybreak`; an absent value is off and requests keep standard safeguards. ChatGPT connections discover Daybreak availability from the authenticated Codex model catalog at startup and when the active connection changes. Catalog requests use the supported Codex catalog client version `0.157.1`, independently of the YCoding release version, and retain `User-Agent: ycoding/<version>`. Each ordinary model entry advertising `daybreak_blue` or `daybreak_red` in `available_access_programs.cyber` carries an advertised `daybreak` list containing exactly those programs. Discovery runs in the background with a three-second timeout; missing, unknown, invalid, or unavailable metadata never blocks ordinary model use. Changing the connection clears the previous account's discovery, and late responses cannot restore it.

Use `/daybreak blue`, `/daybreak red`, or `/daybreak off`, or the Daybreak command in the landing or Session command palette. Without an argument, `/daybreak` cycles off → blue → red → off, offering only programs the active model advertises. The model picker lists ordinary models, not separate Daybreak entries. A landing selection updates the header immediately without creating a Session; it is saved durably as `session.daybreak.set` after Session creation and before the first prompt or explicit goal starts. A Session toggle saves the selection immediately. If saving fails, the prompt or goal does not start. The header shows `Daybreak Blue` or `Daybreak Red` beside the current model name; an unsupported model or another provider shows the saved selection as `(inactive)`. Switching back to a supported model restores the selected mode; `/daybreak off` clears it and removes the indicator.

Requests carry `access_programs: { cyber: <program> }` only when the provider is `openai`, the credential is ChatGPT OAuth, the resolved route is a Codex HTTP or WebSocket backend route, and the active model advertises the selected program. Unsupported models, API-key credentials, custom providers, GPT through OpenRouter, Anthropic, and DeepSeek omit the field while retaining the stored Session selection. Discovery is not entitlement: missing metadata does not establish an authorization denial, and neither plan names nor a ChatGPT UI toggle grant inference access. OpenAI still enforces authorization. Daybreak does not change YCoding permissions, guardrails, or autonomy.

The Core `websearch` tool is provider-independent local search backed by Exa or Parallel. It is distinct from `OpenAI.webSearch(...)`, which adds OpenAI-hosted `web_search` to a direct Responses request and executes at OpenAI.

When `openai_extended_retention` is true, supported pre-GPT-5.6 direct OpenAI requests and Meta Muse Spark requests use `prompt_cache_retention: "24h"`. GPT-5.6-and-later `auto` and `explicit` requests use `prompt_cache_options.ttl: "30m"`; `30m` is that model family's only supported minimum reuse lifetime, not a hard expiry, and OpenAI applies a separate 24-hour maximum. The setting remains false by default because pre-GPT-5.6 extended provider retention may have different privacy and eligibility properties.

`openai_responses_continuation` never changes `openai_responses_state`. The default `stored` state sends `store: true` on direct OpenAI Responses requests; choose `stateless` to send `store: false` and disable response-ID continuation. Enabling extended cache retention or stored Responses state may change provider data-retention behavior; make that choice explicitly.

The default `local` title mode makes no provider request. Set `title` to `model` for model-generated titles; `title: "off"` leaves the initial generated Session title unchanged. Explicit `/goal <text>` calculation always uses a model, while resuming a retained goal does not recalculate it.

Configure the goal pre-prompt with `agents.goal.system`. This helper synthesizes objectives and generates context-aware synthetic steers for activation, resume, and continuation. Select its model with `agents.goal.model` or `efficiency.helper_models.goal`; leave both unset to use the current Session model. For example:

```jsonc
{
  "agents": {
    "goal": {
      "system": "Derive one concise, verifiable objective from the user's explicit request and conversation. Return only the objective.",
    },
  },
  "efficiency": {
    "helper_models": { "goal": "session" },
  },
}
```

An unavailable configured model, failed provider request, or empty calculation leaves the prior goal unchanged. The runtime does not fall back to raw input or another model on that failure. The user replaces objectives explicitly; ordinary chat and agent goal-tool calls cannot rewrite them.

For titles and goals, an explicit model on the matching hidden agent takes precedence over `efficiency.helper_models.<role>`; a missing value or `session` uses the current Session model. Local selective-compaction manifests resolve `helper_models.compaction.main` for main chats and `.subagent` for child Sessions before creating the helper child. An explicit configured compaction model takes precedence over the agent-pinned model; a missing value or `session` retains the existing `agent model`, then owner-Session-model precedence. A subagent owner's `session` value means that subagent's own model. Local jobs reuse a deterministic taskless child Session with the hidden primary `compaction` agent, the selected model, and provider/cache identity isolated from the owner. On a ChatGPT/Codex Responses route, remote compaction uses the owner Session's model regardless of the helper selection; if remote compaction fails, the same job uses the configured local helper. Direct OpenAI and eligible Copilot Responses can compact inline on their Session model without calling a helper. This changes no configuration shape.

## Permissions

Permissions are evaluated in order. Each rule has:

```json
{
  "action": "read",
  "resource": "src/**",
  "effect": "allow"
}
```

`effect` is `allow`, `deny`, or `ask`.

The TUI has no separate auto-approve permission toggle. Automatic handling is controlled by durable Session autonomy:
YOLO 1 handles questions/forms, YOLO 2 also handles `ask` permissions, and YOLO 3 also handles guardrail reviews.
An active goal also handles questions/forms and `ask` permissions at YOLO 0, but does not auto-approve guardrail reviews
below effective YOLO 3. Explicit denies and inherited permission ceilings remain enforced. Manual permission decisions,
including approval for the current Session, remain available.

For noninteractive runs, `ycoding run --yolo <0-3>` sets the durable Session level before admitting the prompt. Omitting the flag preserves an adopted Session's autonomy; `--yolo 0` explicitly selects manual handling. A failed autonomy update prevents prompt admission.

The noninteractive client does not approve requests locally: any remaining permission, question, form or guardrail blocker is rejected or cancelled and the run exits unsuccessfully. Hard guardrail reviews always require a human decision and cannot be approved by this CLI path.

Home-directory expansion applies to path resources for `external_directory`, `read`, and `edit`. It does not rewrite shell command text.

`glob` and `grep` search roots must resolve inside the active Location, including through symlinks. `grep` also accepts an absolute file path directly inside YCoding's managed tool-output directory. A direct file search checks `read` permission before scanning; a directory search checks `read` for each matched file before returning any results. A denied match rejects the search result. `webfetch` checks its `webfetch` URL permission before every HTTP redirect destination, refusing an unapproved destination and limiting chains to ten redirects.

Example:

```jsonc
{
  "permissions": [
    { "action": "read", "resource": "**", "effect": "allow" },
    { "action": "edit", "resource": "src/**", "effect": "ask" },
    { "action": "external_directory", "resource": "~/secrets/**", "effect": "deny" },
  ],
}
```

## Agents

Agents can be defined inline under `agents` or as Markdown resources. See [`repository-resources.md`](./repository-resources.md#agents).

Inline shape:

```jsonc
{
  "default_agent": "god",
  "agents": {
    "reviewer": {
      "description": "Review changes without editing files",
      "mode": "subagent",
      "model": "openrouter/anthropic/claude-sonnet-4",
      "color": "info",
      "steps": 20,
      "permissions": [{ "action": "edit", "resource": "**", "effect": "deny" }],
    },
  },
}
```

When `default_agent` is omitted, YCoding selects the maintained `god` primary agent. Agent listings place the effective default first, so a new TUI session starts with `god` while an explicit `default_agent` remains authoritative. The selectable built-in primaries are `GSD`, `architech`, `god`, and `yangi`; maintained subagents are `occam`, `omoikane`, `wittgenstein`, and `zeus`. `GSD` (Get shit done) is the one-shot delivery profile: it implements directly when fastest, delegates independent work in parallel when useful, and verifies root-cause fixes with focused tests and required affected checks. The visible `btw` advisor and hidden `compaction`, `title`, `goal`, and `summary` helpers remain registered. `compaction` remains `mode: primary`; its internal taskless child Session does not create a managed subagent task. `build`, `plan`, `explore`, `general`, `analyze`, and `brainstorm` are not built-ins.

Agent fields:

- `model`;
- `request.headers` and `request.body`;
- `system`;
- `description`;
- `mode`: `subagent`, `primary`, or `all`;
- `hidden`;
- `color`: six-digit hex or `primary`, `secondary`, `accent`, `success`, `warning`, `error`, `info`;
- `steps`;
- `disabled`;
- `permissions`.

## Commands

Commands may be inline or Markdown resources. See [`repository-resources.md`](./repository-resources.md#commands).

```jsonc
{
  "commands": {
    "review": {
      "template": "Review the current diff and report concrete defects.",
      "description": "Review the current change",
      "agent": "reviewer",
      "model": "openrouter/anthropic/claude-sonnet-4",
      "subtask": true,
    },
  },
}
```

## Skills and ambient instructions

`skills` accepts local directories, `~/` paths, relative paths, and HTTP(S) URLs.

```jsonc
{
  "skills": ["./team-skills", "~/shared/skills", "https://example.com/skills/archive"],
  "instruction_max_bytes": 102400,
}
```

Ambient instructions currently come from:

- `AGENTS.md` in the global YCoding config directory;
- `AGENTS.md` discovered from the project root toward the current directory;
- MCP server instructions;
- activated skills;
- explicit durable session instruction injection.

The top-level `instructions` field is Schema-accepted but not connected to current instruction discovery.

## References

Reference names cannot contain `/`, whitespace, a backtick, or a comma.

A string beginning with `.`, `/`, or `~` is a local path. Other strings are treated as Git repository references.

```jsonc
{
  "references": {
    "service": "../service",
    "platform": {
      "repository": "https://github.com/example/platform.git",
      "branch": "main",
      "description": "Platform contracts",
      "hidden": false,
    },
    "runbooks": {
      "path": "~/runbooks",
      "description": "Private operational runbooks",
    },
  },
}
```

Relative local paths resolve from the containing configuration file.

## Plugins and hooks

Plugins are applied in order.

```jsonc
{
  "plugins": [
    "ycoding.some-built-in",
    { "package": "@example/ycoding-plugin", "options": { "strict": true } },
    "./.ycoding/plugins/local.ts",
    "-ycoding.unwanted-plugin",
  ],
}
```

Rules:

- a string adds a built-in ID, package, or file;
- `{ package, options }` adds a plugin with options;
- relative files resolve from the containing config file;
- a leading `-` disables/removes a matching plugin ID;
- `*` and `<prefix>.*` selectors are supported;
- local `.ycoding/plugin/*.ts|js` and `.ycoding/plugins/*.ts|js` files are auto-discovered.

Hooks are registered by plugins. There is no top-level `hooks` configuration key. Current hook domains are AI SDK, Session, and Tool.

## MCP

MCP configuration is nested under `mcp.servers`.

```jsonc
{
  "mcp": {
    "timeout": {
      "startup": 15000,
      "catalog": 10000,
      "execution": 120000,
    },
    "servers": {
      "local-tools": {
        "type": "local",
        "command": ["bun", "run", "./tools/mcp.ts"],
        "cwd": ".",
        "environment": { "MODE": "local" },
        "codemode": true,
      },
      "remote-tools": {
        "type": "remote",
        "url": "https://mcp.example.com",
        "headers": { "Authorization": "Bearer {env:MCP_TOKEN}" },
        "oauth": false,
        "codemode": true,
      },
    },
  },
}
```

Local server fields:

- `command`: required string array;
- `cwd`: optional, relative to the workspace;
- `environment`;
- `disabled`;
- `codemode`;
- `timeout`.

Remote server fields:

- `url`;
- `headers`;
- `oauth`: object or `false`;
- `disabled`;
- `codemode`;
- `timeout`.

OAuth fields are `client_id`, `client_secret`, `scope`, `callback_port`, and `redirect_uri`.

Default MCP timeouts are:

| Phase                                                     | Default    |
| --------------------------------------------------------- | ---------- |
| Transport startup and initialization                      | 30 seconds |
| Catalog discovery such as `tools/list` and `prompts/list` | 30 seconds |
| Tool and prompt execution                                 | 12 hours   |

Override a phase globally under `mcp.timeout` or per server under that server's `timeout`. Package-manager launchers such as `npx -y ...` may need a larger startup or catalog timeout on first use.

The TUI displays configured MCP servers in `/mcps`, the status dialog, the sidebar, and the Home/Session footer. Footer counts use `connected/configured` form so failed or pending servers remain visible.

An MCP server that declares both the Resources capability and the `io.modelcontextprotocol/skills` extension can publish MCP skills. YCoding lists only validated entry metadata—server label, `SKILL.md` URI, frontmatter, and declared manifest—during catalog discovery; it does not retrieve `SKILL.md` or supporting-file bytes while connecting or listing. The extension is unavailable when either declaration is absent. Loading a selected skill retrieves its declared entry and content only after approval; see [repository resources](./repository-resources.md#mcp-resources-and-prompts) for the content and activation rules.

Status meanings:

| Status                      | Meaning                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pending`                   | The transport is starting or the initial tool catalog is still loading.                                    |
| `connected`                 | Initialization and initial `tools/list` completed successfully.                                            |
| `disabled`                  | Disabled by configuration or disconnected for the current runtime.                                         |
| `needs_auth`                | The remote server requires its registered OAuth flow.                                                      |
| `needs_client_registration` | OAuth requires an explicit client registration.                                                            |
| `failed`                    | Startup, initialization, or initial tool discovery failed. Open the MCP dialog to inspect the exact error. |

YCoding reads the `ycoding` configuration namespace only. Copy required MCP definitions explicitly into the current configuration format.

## Providers and models

Provider entries support:

- `name`;
- credential environment names in `env`;
- package override in `package`;
- request `settings`, `headers`, and `body` overlays;
- named `models`.

The TUI's `/connect` menu includes a Custom OpenAI-compatible endpoint option. Its dialog writes a provider into the existing global
`ycoding.json` or `ycoding.jsonc` (preferring JSON when both exist), or creates `ycoding.json`
when neither exists. It preserves unrelated provider fields and model entries, and allows an
optional `openai-models` catalog source plus model entries with required IDs and optional names,
families, API types, and disabled flags. API keys are stored as named integration credential
profiles; the provider config refers to that integration so model requests resolve the active
profile. Existing profiles can be selected and activated from the dialog. When profile-backed model
discovery uses the endpoint, its URL must use HTTPS or loopback HTTP, contain no embedded URL
credentials, and not redirect; config-key and header-based catalog discovery keeps its existing
behavior. The dialog highlights the selected catalog source and API type with a filled background.

### Provider profiles

A provider may hold several named profiles: multiple accounts or multiple API keys for the same
provider. A profile is the stored credential's user-facing name. Connecting asks for that name
(`/connect`, the command palette's `Connect integration`, or the model selector's connect action),
and re-using a name updates that profile instead of replacing the provider's credentials.

Exactly one profile per provider is active. The active profile is the one a model request resolves,
the one provider usage reports, and the one named in the Session header and in the model selector; a
provider with a single profile keeps the plain `provider/model` label. Switching the active profile
does not remove the others, and removing the active profile promotes the remaining one.

The Session header names the active profile as its own segment immediately after the agent, keeping
the plain `provider/model` label beside it. A provider with a single stored profile shows no profile
segment. Context keeps the Provider and Model identity rows and never carries the profile.

### Cursor

The `cursor` provider runs models from a Cursor subscription through YCoding's native Cursor client, which speaks Cursor's private Connect-RPC agent protocol with a CLI-shaped client identity. Use it only with a Cursor account you own; Cursor may change or restrict that protocol without notice.

Connect it with `ycoding auth login` (or `/connect`) and choose **Cursor**:

- **Cursor account (browser login)** opens Cursor's PKCE sign-in page and stores the returned access and refresh tokens; YCoding refreshes the access token within five minutes of its expiry.
- **Cursor API key (crsr_…)** stores a key from cursor.com settings; the package exchanges it for an access token and refreshes that token itself.
- `CURSOR_API_KEY` in the environment is used as a connection without storing it.

Credentials stay in YCoding's integration store; YCoding never writes them to Protocol, events, or logs. Model discovery, the model cache (`cursor-models.json`), Cursor project metadata (`projects/<slug>/`), and 24-hour conversation snapshots (`cursor-conversations/`) live under `$XDG_CACHE_HOME/ycoding/cursor`.

YCoding discovers the account's models when the connection starts or changes, and reconciles the stored connection every minute, so a connection made by another YCoding process is picked up without restarting. A failed discovery keeps the models already published and is retried by the next reconcile; with no usable connection, or after failed discovery with no cached list and nothing published yet, the provider has no models. Each Cursor model becomes one catalog entry whose variants are Cursor's parameter tuples (effort, thinking, fast, context tier), named by Cursor's sanitized display label. Selecting a variant sends exactly that tuple; a model without a selected variant uses Cursor's default tuple. Long-context tuples (`context=1m`) form a separate `<model>-1m` entry with a 1M context limit and a 128,000 output limit; base entries use Cursor's advertised context (200,000 when unpublished, 256,000 for `default`) and a 32,000 output limit. Models with a separately priced Fast rate (Composer, Grok) expose Fast tuples as `<model>-fast` (and `<model>-1m-fast`) with their own cost rows. Image input is advertised only when Cursor's model list reports image support. Costs are the package's published Cursor token rates; they are local estimates, not Cursor billing.

Limits: Cursor-native interactions without a YCoding tool (interactive background-shell input, image generation, native web, pull-request, MCP-resource download, and source-control requests) are declined to Cursor and the Run continues. Web search and fetch reach Cursor only when the agent advertises `websearch` or `webfetch` as direct tools. A Run held open with no tool result for 10 minutes is closed and the next step rebuilds from history.

Model entries support:

- `modelID`, `family`, `name`, and `package`;
- request overlays;
- `capabilities.tools`, `capabilities.input`, and `capabilities.output`;
- variants as an array of `{ id, settings?, headers?, body? }`;
- cost information;
- `disabled`;
- `limit.context`, `limit.input`, and `limit.output`;
- `api`, the OpenAI-compatible request surface (`chat` or `responses`) documented below.

OpenAI-compatible endpoints resolve their request surface with the source code default first,
then any value discovered by the catalog, then an explicit `api` on the provider `settings`
(`providers.<id>.settings.api`) or on a model entry (`providers.<id>.models.<id>.api`). The
model entry value wins over the provider value, and either overrides the chat default and any
catalog value. An omitted `api` keeps the chat-completions route; set it to `responses` to use
the OpenAI Responses route against the configured `baseURL`.

A provider with `catalog.source: "openai-models"` discovers models from its authenticated
`GET <baseURL>/models` endpoint. Discovered records may publish `name`, `capabilities`,
`limit`, and `variants`; those values are imported directly and override matching standard
catalog metadata for that provider model. This lets self-hosted OpenAI-compatible endpoints
report their real context/input/output limits and named request variants without duplicating
every model in YCoding configuration.

### Runpod Serverless Jobs workers

Select **Runpod Serverless endpoint** from `/connect` to add each Jobs endpoint as a
separate provider ID. Enter its endpoint-root URL, choose the `vllm` or `ollama`
worker, and add the served model ID. The dialog highlights the selected worker
with a filled background. For vLLM, use the exact name served by the
worker (including any served-name override); for Ollama, the model entry labels
the worker-configured model. Enable tool calling for the entry only when the
deployed model and worker support it. Name the endpoint's credential profile and
enter a Runpod API key; additional profiles for that provider can be selected
and activated through `/connect`. Give each endpoint a distinct provider ID to
show all configured endpoint models in the model picker and switch between them
without changing the endpoint configuration. Endpoint registration does not
enumerate an account's deployments or discover model IDs automatically.

For Runpod Serverless Jobs endpoints running `runpod-workers/worker-ollama` or
`runpod-workers/worker-vllm`, select `@ycoding-ai/ai/providers/runpod` and
set `settings.worker` explicitly to `ollama` or `vllm`. Set `settings.baseURL` to the
endpoint root `https://api.runpod.ai/v2/<ENDPOINT_ID>` (not `/runsync`, `/openai/v1`,
or a load-balancer URL). Supply `RUNPOD_API_KEY` in the process environment or
configure `settings.apiKey`. Example for the Ollama worker:

```jsonc
{
  "providers": {
    "runpod": {
      "package": "@ycoding-ai/ai/providers/runpod",
      "settings": { "worker": "ollama", "baseURL": "https://api.runpod.ai/v2/<ENDPOINT_ID>" },
      "models": {
        "worker": {
          "name": "Ollama worker",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 32768, "output": 4096 }
        }
      }
    }
  }
}
```

For the vLLM worker, use the same package and endpoint-root format:

```jsonc
{
  "providers": {
    "runpod-vllm": {
      "package": "@ycoding-ai/ai/providers/runpod",
      "settings": { "worker": "vllm", "baseURL": "https://api.runpod.ai/v2/<ENDPOINT_ID>" },
      "models": {
        "worker": {
          "modelID": "<SERVED_MODEL_NAME>",
          "name": "vLLM worker",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] }
        }
      }
    }
  }
}
```

Set `modelID` to the model name served by vLLM and set `capabilities.tools`
according to the deployed model. Tool calling requires the worker's vLLM server
to be configured for the model's tool format, including `ENABLE_AUTO_TOOL_CHOICE`
and an appropriate `TOOL_CALL_PARSER` for automatic tool calls. Set model
context/output limits to the deployed model's actual limits; the Ollama example
numbers are illustrative, not discovered by the adapter.

Both worker types send non-streaming text chat through `POST /runsync` and yield
output only when the job completes. Ollama uses `input.messages` and `input.options`,
supports automatic function tools when the deployed model supports them, and uses
the worker-configured `HF_MODEL`/`OLLAMA_MODEL`. It sends the initial system
instruction first and represents later instruction updates as escaped user text
in their chronological positions. vLLM uses its generic
`input.route: "/v1/chat/completions"` proxy and an OpenAI Chat request body:
model name, messages, tool definitions, tool-call history, tool results, and
generation options. It parses vLLM's non-streaming Chat completion response and
normalizes tool calls and usage. Ollama does not support required/named tool choice;
structured output, media, and streaming are unsupported in this adapter. When
`/runsync` returns `IN_QUEUE` or `IN_PROGRESS`, the adapter polls
`GET /status/<job-id>` once per second until the job completes or fails; it
does not resubmit the prompt. Interrupting the Session stops the wait.

The Jobs routes send no OpenAI prompt-cache options. vLLM's automatic prefix
cache is configured on the worker, not through this client; YCoding reports
cached prompt tokens only when the worker includes `usage.prompt_tokens_details.cached_tokens`.
Ollama's model store/keep-alive and Runpod's cached model downloads are distinct
from prompt-prefix caching; Ollama worker responses do not report cache-hit tokens.

OpenCode Zen and OpenCode Go remain external provider identities. Their provider IDs, URLs, credentials, and model selectors are not renamed to YCoding.

## Formatter, LSP, attachment, and output settings

Formatter configuration is `false`, `true`, or a record:

```jsonc
{
  "formatter": {
    "prettier": {
      "command": ["bun", "x", "prettier", "--write", "$FILE"],
      "extensions": [".ts", ".tsx"],
      "environment": { "NODE_ENV": "development" },
    },
  },
}
```

Each formatter entry supports `disabled`, `command`, `environment`, and `extensions`.

LSP configuration is `false`, `true`, or a record. A server entry supports `command`, `extensions`, `disabled`, `env`, and `initialization`. `{ "disabled": true }` is also accepted.

```jsonc
{
  "attachments": {
    "image": {
      "auto_resize": true,
      "max_width": 2048,
      "max_height": 2048,
      "max_base64_bytes": 8000000,
    },
  },
  "tool_output": {
    "max_lines": 2000,
    "max_bytes": 200000,
  },
  "watcher": {
    "ignore": ["node_modules/**", "dist/**"],
  },
}
```

## Compaction and experimental settings

```jsonc
{
  "compaction": {
    "keep_recent_messages": 20,
    "reserved_output_tokens": 4096,
    "context_safety_margin_tokens": 4096,
    "timeout_seconds": 60,
    "max_output_tokens": 4096,
    "max_manifest_bytes": 65536,
    "max_internal_passes": 8,
    "advisory": {
      "consider_percent": 70,
      "strongly_advised_percent": 90,
    },
  },
  "experimental": {
    "subagent_depth": 2,
    "policies": [],
  },
}
```

Soft thresholds are runtime-owned. A Session starts background compaction once when it rises from normal pressure to `consider`, and once more only if it rises to `advised`. A successful or deduplicated admission latches the level until pressure returns to normal; a failed admission unlatches it for a later retry. Mandatory pressure never starts this soft path. No cooldown or polling configuration is required.

`experimental.subagent_depth` defaults to `1` when omitted.

## Guardrail configuration and custom files

`guardrails` controls the Location-scoped root-Session-family safety service:

```jsonc
{
  "guardrails": {
    "enabled": true,
    "max_concurrent_shells": 8,
    "max_concurrent_subagents": 8,
    "max_pending_reviews": 16,
  },
}
```

| Field                                 | Exact type       | Default | Operational remark                                                                                        |
| ------------------------------------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `guardrails.enabled`                  | boolean          | `true`  | Enables the guardrail service; no configuration or approval reply overrides a standard catastrophic deny. |
| `guardrails.max_concurrent_shells`    | positive integer | `8`     | Running-shell cap per root Session family.                                                                |
| `guardrails.max_concurrent_subagents` | positive integer | `8`     | Running-subagent cap per root Session family.                                                             |
| `guardrails.max_pending_reviews`      | positive integer | `16`    | Pending-review cap per root Session family.                                                               |

Custom rule files are direct `guardrails/*.md` children of the global config directory and each discovered repository `Config.Directory`; nested directories are not scanned. Source layers evaluate nearest repository first, then broader repositories, then the global directory. Within a layer, rules sort by descending numeric `priority`, then deterministic lexical file path and rule ID. See [`guardrails-and-provider-usage.md`](./guardrails-and-provider-usage.md#custom-guardrails) for the complete file contract and the unoverrideable catastrophic-deny, reply, and transient-approval rules.

## CLI/TUI configuration

The terminal client reads one global file:

```text
<YCoding config directory>/cli.json
```

It accepts JSONC and preserves comments when the TUI updates settings.

Example:

```jsonc
{
  "theme": { "name": "ycoding", "mode": "dark" },
  "leader": { "timeout": 2000 },
  "scroll": { "speed": 1, "acceleration": true },
  "attention": {
    "enabled": true,
    "notifications": true,
    "sound": true,
    "volume": 0.4,
    "sound_pack": "ycoding.default",
    "sounds": {
      "permission": "~/sounds/permission.wav",
      "done": "~/sounds/done.wav",
    },
  },
  "diffs": { "wrap": "word", "tree": true, "single": false, "view": "auto" },
  "terminal": { "title": true, "copy_on_select": false },
  "prompt": { "editor": true, "paste": "compact" },
  "session": {
    "sidebar": "auto",
    "scrollbar": true,
    "thinking": "show",
    "grouping": "auto",
  },
  "hints": { "onboarding": true },
  "debug": { "devtools": false, "timing": false },
  "animations": true,
  "mouse": true,
}
```

Defaults applied by the TUI:

| Setting                   | Default           |
| ------------------------- | ----------------- |
| `attention.enabled`       | `true`            |
| `attention.notifications` | `true`            |
| `attention.sound`         | `true`            |
| `attention.volume`        | `0.4`             |
| `attention.sound_pack`    | `ycoding.default` |
| `leader.timeout`          | `2000` ms         |
| `mouse`                   | `true`            |

All other `cli.json` fields are optional and remain `unset` until configured. The schema-recognized field paths are:

| Field path                                                         | Exact type or closed values                       | Default               | Operational remark                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `theme.name`                                                       | string                                            | unset                 | Discovered theme ID.                                                                                |
| `theme.mode`                                                       | `system` \| `dark` \| `light`                     | unset                 | `system` follows the terminal.                                                                      |
| `keybinds.<command>`                                               | key-sequence override                             | unset                 | The supported command names and default bindings are owned by `packages/tui/src/config/keybind.ts`. |
| `plugins[]`                                                        | string \| `{ package: string, options?: record }` | unset                 | TUI-side plugin directives, separate from Core runtime plugins.                                     |
| `leader.timeout`                                                   | positive integer milliseconds                     | `2000`                | Wait time after the leader key.                                                                     |
| `scroll.speed`                                                     | number `>= 0.001`                                 | unset                 | Distance per scroll-input tick.                                                                     |
| `scroll.acceleration`                                              | boolean                                           | unset                 | Repeated-input acceleration.                                                                        |
| `attention.enabled`, `.notifications`, `.sound`                    | boolean                                           | `true`                | Master alerts, system notifications, and attention sound.                                           |
| `attention.volume`                                                 | number `0..1`                                     | `0.4`                 | Attention-sound volume.                                                                             |
| `attention.sound_pack`                                             | string                                            | `ycoding.default`     | Active sound-pack ID.                                                                               |
| `attention.sounds.<event>`                                         | string                                            | unset                 | Event is `default`, `question`, `permission`, `error`, `done`, or `subagent_done`.                  |
| `diffs.wrap`                                                       | `word` \| `none`                                  | unset                 | Diff line wrapping.                                                                                 |
| `diffs.tree`, `.single`                                            | boolean                                           | unset                 | File-tree visibility and single-patch view.                                                         |
| `diffs.view`                                                       | `auto` \| `split` \| `unified`                    | unset                 | `auto` selects from terminal width.                                                                 |
| `terminal.title`                                                   | boolean                                           | unset                 | Terminal title updates.                                                                             |
| `terminal.copy_on_select`                                          | boolean                                           | `true` except Windows | Copy the mouse selection when it is released.                                                       |
| `prompt.editor`                                                    | boolean                                           | unset                 | Adds active editor file or selection to prompt context.                                             |
| `prompt.paste`                                                     | `compact` \| `full`                               | unset                 | Large-paste presentation.                                                                           |
| `session.sidebar`                                                  | `auto` \| `hide`                                  | unset                 | `auto` shows the sidebar when width permits.                                                        |
| `session.scrollbar`                                                | boolean                                           | unset                 | Transcript scrollbar.                                                                               |
| `session.thinking`                                                 | `show` \| `hide`                                  | unset                 | Default reasoning visibility.                                                                       |
| `session.grouping`                                                 | `auto` \| `none`                                  | unset                 | Related transcript-item grouping.                                                                   |
| `hints.onboarding`, `debug.devtools`, `debug.timing`, `animations` | boolean                                           | unset                 | Guidance, diagnostics, and animation switches.                                                      |
| `mouse`                                                            | boolean                                           | `true`                | Terminal mouse capture.                                                                             |

Attention sound names are `default`, `question`, `permission`, `error`, `done`, and `subagent_done`. System notifications for attention events are requested while the terminal is blurred or before it has reported its focus, and are suppressed while it is known to be focused; delivery also depends on the terminal's notification support and the operating system's notification settings for that terminal.

`terminal.copy_on_select` controls copy-on-select. When enabled (the default except on Windows), releasing a mouse selection copies it; when disabled, use `Ctrl+C` on every supported platform or `Cmd+C` on macOS, and press `Esc` to clear the selection. Selection copy consumes `Ctrl+C` and cannot exit the application. Without a selection, `Ctrl+C` keeps its prompt behavior and requires two presses to exit from an empty prompt; `Esc` never exits YCoding.

`keybinds` is a record of command names to key sequences. The complete current key map lives in `packages/tui/src/config/keybind.ts`; that file is authoritative when bindings are added or renamed.

The TUI `plugins` array has the same string or `{ package, options }` shape, but it configures terminal-side plugins rather than Core runtime plugins.

Assistant and compaction transcript text always renders as Markdown. There is no syntax-source display setting.

## Managed-service configuration

The background service uses a channel-specific file in the global YCoding config directory:

| Channel                                | File                              |
| -------------------------------------- | --------------------------------- |
| `latest`                               | `service.json`                    |
| `local`                                | `service-local.json`              |
| Other channel, including branch builds | `service-<SHA-1-of-channel>.json` |

Shape:

```json
{
  "hostname": "127.0.0.1",
  "port": 29706,
  "password": "private-generated-value"
}
```

`hostname`, `port`, and `password` are optional. The password is generated and persisted with mode `0600` when absent.
HTTP requests authenticate with `Authorization: Basic` using the username `ycoding` and the configured password. Query-string credentials do not authenticate requests.

Default managed ports are deterministic and product-namespaced:

```text
10000 + (first 32 bits of SHA-1("ycoding:<channel>") mod 50000)
```

This prevents branch builds of YCoding from colliding with another product process using the same channel name.

When a configured port is occupied, edit the channel-specific service file and choose another integer from `1` to `65535`. `ycoding --standalone` is a temporary alternative that starts a private server instead of the managed service.

The matching registration file is stored in the YCoding state directory. It contains the service instance ID, version, URL, PID, and private password. Do not hand-edit a live registration file.

## Chrome extension connection

The landing command palette also offers **Connect Chrome**. It scopes the connection to a Session in the current Location, creating an idle Session only when none is available.

The **Connect Chrome** command in both the Mini and full Session palettes displays the connected loopback service address and current pairing state. A paired but disconnected extension is reported as **Paired; waiting for Chrome to reconnect** and does not offer another pairing code. Use **f** to explicitly forget the saved trust; when unpaired, **p** creates a one-time code. The full dialog keeps a generated code visible through status polls and **r** refreshes until the code is used or expires. The dialog also shows the extension folder to load unpacked: `ycoding-chrome-extension` beside the installed executable, or `extensions/chrome` in a source checkout. Enter the code in the extension's popup. The popup uses `http://127.0.0.1:4096` by default; if the view shows another address, enter it once under **Local service address**. The extension remembers the address and reconnect credential, so pairing does not require the initiating Session to remain active. Pairing authorizes eligible existing and future tabs in that Chrome profile, including the active tab. The manifest requests `tabs`, `tabGroups`, `alarms`, `debugger`, and `storage`, with host access limited to loopback. Omitted browser mode uses the paired profile; `mode: "owned"` opens Session-owned background tabs. Model-driven profile reads require site permissions without a standard access review; mutations require site permissions, and group changes also require control permission. Owned-tab open requires target-site permissions. Approved site actions may cause incidental downloads; explicit download/upload access is not configured. See [Chrome browser bridge](./browser-extension.md) for ownership, badges, and safety limits.

The popup shows **Local service address**, **Pairing code**, and **Connect YCoding** only before pairing. It then shows a connection indicator, with **Forget pairing** to revoke browser access. A temporary outage retains the pairing and retries without another code, including after Chrome startup or YCoding service restart; an explicit stop leaves it paused until **Retry connection** is chosen. The popup supports light and dark themes.

## Isolated browser availability

Temporary headless browsing is started explicitly from the current Session's **Isolated browser** command, not by enabling a config key. The implementation requires macOS arm64 and installed Google Chrome major 152 or newer in its standard application location. It does not install Chrome, accept an arbitrary executable or debugging endpoint, or reuse a personal profile. Unsupported environments report unavailable; matching the version does not bypass startup capability checks.

The URL must use HTTP or HTTPS without embedded credentials. Stop the paired Chrome bridge before starting isolated mode, or stop isolated mode before creating extension pairing. Browser permissions and Session guardrails still govern model actions. See the [isolated-browser contract](../specs/v2/isolated-browser.md) for temporary-state semantics, restrictions, and environment-specific validation evidence and limits.

## Automatic SQLite space reclamation

Database initialization automatically converts `auto_vacuum=NONE` databases to `INCREMENTAL` using a one-time SQLite `VACUUM`. Later initializations reclaim at most 256 free pages without rebuilding the database. An existing `FULL` auto-vacuum setting is preserved. These operations reclaim unused pages; they do not delete records.

The initial conversion requires a write lock and may need temporary free disk space up to twice the database size. It can delay startup. If SQLite cannot obtain the lock within the five-second busy timeout, or the conversion fails, startup fails rather than silently skipping conversion; existing records remain intact and the next start retries. Keep a backup before upgrading a large database and close other writers during the first start.

## Runtime environment variables

Stable operator-facing variables:

| Variable                         | Effect                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| `YCODING_CONFIG`                 | Explicit runtime config file.                              |
| `YCODING_CONFIG_CONTENT`         | Highest-priority inline runtime config.                    |
| `YCODING_CONFIG_DIR`             | Override global configuration directory.                   |
| `YCODING_CONFIG_PROJECT_DISABLE` | Disable project config discovery.                          |
| `YCODING_DISABLE_PROJECT_CONFIG` | Alias for disabling project config discovery.              |
| `YCODING_PASSWORD`               | Password for an explicitly connected or standalone server. |
| `YCODING_SERVER_PASSWORD`        | Server-password alias.                                     |
| `YCODING_DB`                     | Override database path.                                    |
| `YCODING_MODELS_URL`             | Override model catalog URL.                                |
| `YCODING_MODELS_PATH`            | Read model catalog from a local file.                      |
| `YCODING_DISABLE_MODELS_FETCH`   | Disable model-catalog network refresh.                     |
| `YCODING_DISABLE_AUTOUPDATE`     | Disable update checks.                                     |
| `YCODING_LOG_LEVEL`              | Logging threshold.                                         |
| `YCODING_PRINT_LOGS`             | Print logs to the terminal.                                |
| `YCODING_CLIENT`                 | Client identity reported by the process.                   |
| `YCODING_SIMULATE`               | Enable simulation backend behavior.                        |
| `YCODING_GIT_BASH_PATH`          | Windows Git Bash path.                                     |
| `YCODING_FILEWATCHER_DISABLE`    | Disable filesystem watcher.                                |
| `YCODING_DISABLE_FILEWATCHER`    | Alternate filesystem-watcher disable switch.               |
| `YCODING_DISABLE_FFF`            | Disable the FFF filesystem backend.                        |
| `YCODING_WEBSEARCH_PROVIDER`     | Select web-search provider.                                |
| `YCODING_TERMINAL`               | Override terminal identity used by shell and PTY behavior. |
| `YCODING_REMOTE_URL`             | Relay origin used by the `ycoding remote` commands.        |

Build, packaging, test, and internal diagnostic variables are not stable end-user configuration. Examples include `YCODING_VERSION`, `YCODING_CHANNEL`, native-library paths, Drive simulation variables, and the internal managed-service startup-error file.

`YCODING_REMOTE_URL` is a relay origin: HTTPS only, except that plain HTTP is accepted for `localhost`, `127.0.0.1`, and `[::1]` development. It must not carry credentials, a query, a fragment, or a path. A `--relay` flag takes precedence over the environment, which takes precedence over the origin stored by `ycoding remote enroll`. Device credentials are bound to the enrolled origin, so an override that changes the origin is refused before any credential is sent.

## Reload behavior

YCoding watches runtime configuration directories and explicit files. Changes are debounced by 100 ms and publish `config.updated`.

Agent, command, plugin, and skill files inside watched `.ycoding` or global config directories reload even when the JSON document list itself is unchanged.

Ecosystem skill roots such as `~/.claude/skills` and `~/.agents/skills` are not watched. Skill files are re-read whenever skills are listed so edits and deletions are still reflected.

Project `ycoding.json`, `ycoding.jsonc`, and `.ycoding` entries are watched only when they existed at the last discovery, so one created afterwards is not detected automatically. The TUI command palette's **Refresh models and providers** command calls `POST /api/provider/refresh` for the current Location. The server rediscovers every configuration source, publishes `config.updated` even when the document list is unchanged, and reruns provider model discovery such as `openai-models` catalogs; the refreshed catalog arrives through `catalog.updated`, and the TUI then reloads that Location's model and provider lists. Environment variables are read by the running server process and do not change through a refresh.

CLI/TUI `cli.json` updates are serialized, written atomically through a temporary file, and preserve existing JSONC comments.

## Troubleshooting

- A config file containing a rejected key is ignored in full; inspect warning logs for the exact keys.
- Invalid JSON/JSONC or a failed file substitution causes that document to be skipped.
- `instructions` is accepted but currently inactive; use `AGENTS.md` or skills.
- `tui.json`, `kv.json`, `config.json`, and project `.ycoding/tui.json` are not read.
- A managed-service port conflict is not fixed by deleting session data. Change the channel service config port or use `ycoding --standalone`.
- Run with `--log-level all` and `YCODING_PRINT_LOGS=1` when investigating configuration discovery.
