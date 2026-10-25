# Configuration reference

This document is the canonical configuration reference for the current YCoding repository. It is derived from the live Schema and runtime discovery code.

## Configure by task

| Task                                      | Read                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose which configuration wins           | [Discovery and precedence](#runtime-configuration-discovery-and-precedence), [JSON/JSONC](#json-and-jsonc-behavior).                                                       |
| Connect an account and choose a model     | [Providers and models](#providers-and-models), [profiles](#provider-profiles), [Claude Code accounts](#claude-code-account-profiles), [model selectors](#model-selectors). |
| Control agent authority                   | [Permissions](#permissions), [agents](#agents), [guardrails](#guardrail-configuration-and-custom-files).                                                                   |
| Extend repository behavior                | [Commands](#commands), [skills and instructions](#skills-and-ambient-instructions), [plugins](#plugins-and-hooks), [MCP](#mcp).                                            |
| Turn capabilities off for an evaluation   | [Capability toggles](#capability-toggles), [isolated runs](#per-run-configuration-and-isolated-runs).                                                                      |
| Manage context and knowledge              | [Compaction](#compaction-and-experimental-settings), [workspace memory](#workspace-memory), [provider efficiency](#provider-efficiency).                                   |
| Adjust presentation and service operation | [CLI/TUI](#cli-tui-configuration), [managed service](#managed-service-configuration).                                                                                      |

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

While the full-screen TUI owns the terminal, Node process warnings go to the YCoding log as `Node process warning` entries with their name, message and stack. Node's default stderr warning output is restored when the TUI exits.

The server-hosted remote connector writes warning-level diagnostics to the active YCoding log file in `$XDG_DATA_HOME/ycoding/log` with `component=remote-connector`. A relay-close entry records the close code and whether the connector reconnects. A state transition records `from`, `state`, and, when known, `retryable`. A startup or recovery failure records a fixed `cause` category (`authorization_rejected`, `setup_failed`, or `startup_failed`); a rejected credential exchange also records its `operation` (`enroll`, `challenge`, `token`, or `refresh`) and HTTP `status`. Failure entries omit raw error bodies, so credentials, bearer tokens, and frame payloads never reach the log. A remote request that takes 1 s or longer on the machine writes `slow remote request <operation> took <N>ms on this device`, naming only the operation and duration. A failed relay MCP Events authorization request writes `MCP Events authorization <action> failed: <cause>`, with action `capabilities`, `resolve`, or `check` and cause `rate_limited`, `unauthorized`, `forbidden`, `unsupported`, or `unavailable`, at most once per minute for each action and cause. Session-scoped reads verify the Session with one `session.get` at its recorded Location, scanning the full Session inventory only for an ID the connector has not yet seen; captured-change summaries are reused while every member Session's durable event position is unchanged and read paged `message.capturedInputs` projections when recomputed.

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
- unknown properties, which are dropped individually with diagnostics;
- `$schema` metadata;
- environment substitution with `{env:NAME}`;
- file substitution with `{file:path}`.

Only an unparsable JSON/JSONC document is skipped as a whole. For a parsed document, the runtime drops removed or unknown keys and the smallest schema-invalid unit, preserving unrelated settings. Invalid named MCP server, provider, command, or reference values drop only that entry; invalid agent fields are dropped individually when the agent remains structurally valid. Invalid permission rules fail closed: a readable nonempty action is denied on every resource, and an unreadable action or non-array ruleset denies every action in that global or agent ruleset. Valid rules retain their order, followed by the recovered denies, so later rules in the same ruleset cannot override recovery; normal precedence between configuration scopes is unchanged. Any invalid `guardrails` value becomes `{ "enabled": true }`, using default limits. The runtime logs `ignored config file with invalid JSON` for unparsable documents and one `recovered config item` warning per dropped or fail-closed item. The Location-scoped `GET /api/config/diagnostics` endpoint returns the document `path`, `reason`, and short `message`, plus `jsonPath` for parsed items and `failClosed: true` for security recovery. The TUI shows error toasts and lists diagnostics under Configuration in Status, with wrapping JSON-path/message details and a `fails closed` marker.

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

Missing environment variables become an empty string. A missing `{file:...}` reference fails configuration loading for that Location and is shown as a configuration error.

The configuration JSON Schema is generated from the runtime-owned `Config.Info` Schema during the public web build. Its public endpoint is [`https://ycoding.althenia.app/ycoding.schema.json`](https://ycoding.althenia.app/ycoding.schema.json). Publish the built web assets before using the endpoint.

After deployment, use the endpoint in `ycoding.jsonc` for editor validation:

```jsonc
{
  "$schema": "https://ycoding.althenia.app/ycoding.schema.json",
}
```

Use the generated YCoding schema endpoint rather than a different product's schema.

## Capability toggles

The `capabilities` object controls runtime capability availability so a Session sees exactly the instructions, skills, tools, and integrations a run intends, for example an evaluation without `AGENTS.md`, with one skill, or without MCP. Every field is optional; an omitted field keeps its documented default. The object works in every configuration layer, including global and project files, `YCODING_CONFIG_CONTENT`, and `ycoding run --config`. Each leaf field is last-wins across layers in the normal [precedence](#runtime-configuration-discovery-and-precedence) order, and a list replaces the list from a lower layer instead of merging with it.

```jsonc
{
  "capabilities": {
    "instructions": { "global": false, "project": true, "exclude": ["*/vendor/*/AGENTS.md"] },
    "builtin_instructions": { "deny": ["environment", "date"] },
    "skills": { "allow": ["review"] },
    "tools": { "deny": ["websearch", "webfetch", "browser", "computer"] },
    "mcp": { "enabled": false },
    "plugins": { "enabled": false },
    "project_artifacts": false,
    "home_roots": false,
    "websearch_provider": "exa",
  },
}
```

`builtin_instructions`, `skills`, `tools`, `mcp`, and `plugins` share one selection shape:

| Field     | Type     | Effect                                                                  |
| --------- | -------- | ----------------------------------------------------------------------- |
| `enabled` | boolean  | `false` turns off every item; default `true`.                           |
| `allow`   | string[] | When set, only matching items stay available; an empty list keeps none. |
| `deny`    | string[] | Matching items are unavailable; deny wins over allow.                   |

Names in `skills`, `tools`, `mcp`, and `plugins` are wildcard patterns: `*` matches any characters and `?` matches one character. `builtin_instructions` accepts only the closed block names listed below.

| Field                  | Effect                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `instructions.global`  | `false` skips `<global YCoding config>/AGENTS.md`.                                                                                                                                                                                                                                                                                         |
| `instructions.project` | `false` skips every project `AGENTS.md`: upward discovery from the project root and nested files the `read` tool would otherwise inject after a read.                                                                                                                                                                                      |
| `instructions.exclude` | Wildcard patterns matched against absolute `AGENTS.md` paths; a matching file is skipped by both upward discovery and `read` injection.                                                                                                                                                                                                    |
| `builtin_instructions` | Built-in blocks by name: `environment`, `date`, `subagent-reuse`, `shell-memory`, `project-artifact-authoring`, `git-worktree`, `git-attribution`, `human-input`, `decision-use`, `task-completion`, `memory`, and `model-guidance`.                                                                                                       |
| `skills`               | Skills by ID from every source: global and ancestor `.ycoding`, `~/.agents` and `~/.claude` and their ancestor roots, the `skills` array, managed project artifacts, MCP-served skills (IDs as shown in the skill catalog), and the built-in `ycoding` and `report` skills. `enabled: false` also hides the `skill` tool.                  |
| `tools`                | Tools by registered name (see below). A hidden tool is absent from the model's tool list and from CodeMode, and a call to it fails as an unknown tool.                                                                                                                                                                                     |
| `mcp`                  | MCP servers by configured name under `mcp.servers`. An excluded server never starts, so its tools, instructions, prompts, resources, and skills are absent; a server added at runtime under an excluded name stays `disabled`.                                                                                                             |
| `plugins`              | External plugins by plugin ID: configured packages and files and auto-discovered `plugin`/`plugins` files. `enabled: false` loads none of them. `allow`/`deny` match the plugin's exported ID, so a listed package or file is imported to read its ID but an excluded plugin never activates. Built-in `ycoding.*` plugins are unaffected. |
| `project_artifacts`    | `false` applies no managed project artifacts (skills, commands, agents) to the Location and hides the `project_artifact` tool.                                                                                                                                                                                                             |
| `home_roots`           | `false` omits the `~/.agents` and `~/.claude` ecosystem roots, including their skills and global skill artifacts stored under `~/.agents/skills`. Project `.agents` and `.claude` directories below the home directory still load.                                                                                                         |
| `websearch_provider`   | `exa` or `parallel` pins the `websearch` provider for every Session. Without it the provider comes from `YCODING_WEBSEARCH_PROVIDER`, then `YCODING_ENABLE_PARALLEL`/`YCODING_ENABLE_EXA`, then a stable choice derived from the Session ID.                                                                                               |

Built-in tool names are `browser`, `computer`, `decision`, `edit`, `glob`, `goal`, `grep`, `memory`, `patch`, `project_artifact`, `question`, `read`, `shell`, `skill`, `subagent`, `subagent_control`, `subagent_report`, `task_complete`, `todowrite`, `webfetch`, `websearch`, `worktree`, and `write`. MCP tools are named `<server>_<tool>` with characters other than letters, digits, `_`, and `-` replaced by `_`, so `"deny": ["github_*"]` hides one server's tools; plugin tools use their registered name or `<namespace>_<tool>`. CodeMode's `execute` wrapper is shown whenever at least one CodeMode tool remains; it is hidden only by `enabled: false` or an explicit deny, and `allow` lists need not name it. Tool toggles filter the same catalog that permission rules filter: a tool also disappears when an effective permission wholly denies its action.

A built-in instruction block that describes a tool is omitted while the selected agent cannot call that tool, whether a capability toggle hides it, a permission or Session ceiling wholly denies it, or the subagent mode removes it: `subagent-reuse` needs `subagent`, `shell-memory` needs `shell`, `project-artifact-authoring` needs `project_artifact`, `human-input` needs `question`, `decision-use` needs `decision`, `task-completion` needs `task_complete`, and `memory` needs `memory` and `memory.enabled`. `model-guidance` has no tool dependency; turning it off hides the model's [incident guidance](./runtime.md#model-incidents) and reports `enabled: false` for that Location. `project-artifact-authoring` covers both project-artifact guidance blocks. MCP server instructions follow the same rule for the server's tools and `execute`.

Toggles are evaluated per Location, so a main Session and its subagents in the same Location see the same capabilities, and `YCODING_CONFIG_CONTENT` or `--config` applies to every Location of that server. MCP toggles, like `mcp.servers`, are read when a Location's services boot; other toggles follow configuration reloads and apply from the next model step or tool call. A block that is turned off during a Session is removed from its instruction state. Toggles narrow capabilities only: they never grant a permission, and a skill or tool hidden by a toggle cannot be loaded or called by explicit ID.

### Per-run configuration and isolated runs

`ycoding run` accepts two flags for reproducible runs. Both start a private server for the run, like `--standalone`, and cannot be combined with `--server`:

| Flag              | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config <file>` | Reads a JSON/JSONC runtime configuration document (relative paths resolve from the current directory) and passes it to the private server as `YCODING_CONFIG_CONTENT`, so it is the highest-priority layer above global, `YCODING_CONFIG`, project, and well-known configuration. `{file:…}` references inside it resolve from the run directory. An unreadable or unparsable file fails the run before a server starts, and so does a `YCODING_CONFIG_CONTENT` already set in the environment. |
| `--isolated`      | Gives the private server a new temporary data directory (`XDG_DATA_HOME`) and a database inside it, overriding `YCODING_DB`, and removes the directory after the server stops. The server's Sessions, logs, managed tool output, project-artifact store, and default workspace-memory location live there, so it never opens the user's database. Global configuration, cache, and state directories are unchanged.                                                                             |

Stored provider credentials live in the database, so an `--isolated` run cannot use them: supply provider keys through environment variables or providers declared in the configuration (for example in the `--config` document). Each `--isolated` run starts with no Sessions, so `--continue` and `--session` find nothing from earlier runs.

```sh
ycoding run --isolated --config eval.jsonc --model openai/gpt-5 "Fix the failing test"
```

### JSON run output

`ycoding run --format json` writes one JSON object per line to standard output. Every line has `type`, `timestamp` (epoch milliseconds), and `sessionID`. Besides `text`, `reasoning`, `tool_use`, and `error` lines, the run reports its metrics in three line types. Default text output prints none of them. Fields the runtime does not report are absent, never zero.

- `step_start`: `part.agent` and `part.model` (`providerID`, `id`, and `variant` or `profile` when selected) for the step.
- `step_finish`: `part.reason`, `part.cost` (USD), and `part.tokens` (`input`, `output`, `reasoning`, `cache.read`, `cache.write`). It adds `part.contextLimit`, `part.contextBreakdown`, and `part.providerCache` only when the step reports them.
- `run_finish`: exactly one line after the last event, including after an `error` line and after an interrupted run. It is not written when the run fails before the prompt is submitted or when prompt admission fails with an error.

`run_finish` fields:

| Field        | Meaning                                                                                                                                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`     | `succeeded`, `failed` (an error line, a failed execution, or a rejected permission, question, form, or guardrail), or `interrupted`.                                                                                                                                                                                 |
| `durationMs` | Wall time from just before prompt admission to the end of the run.                                                                                                                                                                                                                                                   |
| `steps`      | Ended and failed steps of the run's own Session.                                                                                                                                                                                                                                                                     |
| `turns`      | Turns of the run's own Session in the run (see the turn rule below).                                                                                                                                                                                                                                                 |
| `tokens`     | Token usage summed over those steps, and `cost`, their summed USD cost.                                                                                                                                                                                                                                              |
| `context`    | `limit`, the last positive context window a step reported, and `peakInput`, the largest `input + cache.read + cache.write` of one step. Each is omitted when no step reported it.                                                                                                                                    |
| `models`     | Distinct model references the steps used.                                                                                                                                                                                                                                                                            |
| `total`      | Provider-request usage of the whole run window: `tokens`, `requests` (`logical` requests, `physical` attempts including retries, and `helpers`, the non-step requests such as titles and compaction), `cost` with `costProvenance`, and `steps` and `turns` summed over the run's Session and its subagent Sessions. |
| `children`   | One entry per descendant Session: `sessionID`, `kind`, `agent`, `tokens`, `requests`, and `cost` with `costProvenance`, plus `status`, `steps`, and `turns` for subagents and `steps` for helpers when observed.                                                                                                     |
| `usageError` | Replaces `total` and `children` when the usage reads fail; the other fields are still written.                                                                                                                                                                                                                       |

`total` and `children` come from the Session usage report of the run's Session, which covers the Session, its subagent Sessions, and their hidden compaction helper Sessions, limited to provider requests recorded from the prompt's admission time to the run's last event. Title requests are recorded under the Session they name. `cost` is absent when no request in scope has a recorded or catalog-estimated price; `costProvenance` is `recorded` or `current_catalog`. A `subagent` child has the task `status` (`starting`, `running`, `waiting`, `cancelling`, `cancelled`, `completed`, `failed`, or `lost`) read at the end of the run and zero usage when it made no request in the window. A `helper` child is a hidden Session without a task record and has no `status`. The run ends when its own Session settles, so background subagents may still be running; `total` and `children` include the requests recorded up to that moment, and a request still in flight reports the usage recorded so far. A step is one logical model call, counted when it ends or fails. A turn is one execution of a Session, from `session.execution.started` to its terminal execution event, that promoted at least one input; steers promoted during that execution belong to the same turn, while a queued input or a notice that wakes an idle Session starts another. An execution that promoted no input (an empty wake or a compaction-only drain) is not a turn. Counts come from the events the run observes for the run's Session and its descendants, so a subagent reports `steps` and `turns` only for the part of its work that happens before the run ends, and a helper reports `steps` only when the run observed its steps, never a fabricated zero. The run ends at the first terminal execution event of its own Session, so its own `turns` is 1 unless it ends before promoting any input, in which case it is 0. Exit codes are unchanged.

```json
{"type":"step_start","timestamp":1791950288605,"sessionID":"ses_1","part":{"type":"step-start","agent":"god","model":{"providerID":"openai","id":"gpt-5"}}}
{"type":"run_finish","timestamp":1791950288735,"sessionID":"ses_1","status":"succeeded","durationMs":405,"steps":2,"tokens":{"input":110,"output":30,"reasoning":0,"cache":{"read":140,"write":0}},"cost":0.02,"context":{"limit":400000,"peakInput":150},"models":[{"providerID":"openai","id":"gpt-5"}],"turns":1,"total":{"tokens":{"input":110,"output":30,"reasoning":0,"cache":{"read":140,"write":0}},"requests":{"logical":2,"physical":2,"helpers":0},"cost":0.02,"costProvenance":"recorded","steps":2,"turns":1},"children":[]}
```

## Terminal installation and commands

After the public site and a native release are published, `curl -fsSL https://ycoding.althenia.app/install.sh | sh` installs a checksum-verified release executable in `~/.local/bin`. Installation does not require a separate Bun runtime. The installer applies the same archive checks as `ycoding update`. It checks the shell configuration and adds the binary directory to PATH only when needed; unsupported shells receive manual PATH guidance.

`ycoding` opens the interactive terminal interface. `ycoding --model <[profile#]provider/model[#variant]> "prompt"` executes a direct non-interactive run instead. `ycoding run --help` lists the explicit run command's options; `--config <file>` and `--isolated` give one run its own configuration document and data directory (see [per-run configuration and isolated runs](#per-run-configuration-and-isolated-runs)). These paths share the existing durable Session execution and permission handling.

The installed executable includes `ycoding service start`, `restart`, `status`, `stop`, `get`, `set`, and `unset` for the managed background server. `ycoding service --help` lists these controls. `status` reports the running endpoint or `stopped` without starting a server. `restart` interrupts executing Sessions; let their work finish before restarting to apply an update.

**Keep machine awake** controls the backend, not the viewing browser. Toggle its manual preference with `/keep-awake`, the TUI palette, or web **Settings → Machine**. Effective keep-awake is the manual preference OR any sleeping Session family. Turning the preference off during sleep retains the hold until the last family wakes. The manual preference starts off on every backend start; durable sleeping families rehydrate their holds. TUI and web show idle, lid, and sleep-hold status, including errors and unsupported parts; an older connector without additive fields remains readable. On macOS, `/usr/bin/caffeinate -i -w <pid>` prevents idle sleep and unprivileged IOKit selector `kPMSetClamshellSleepState` (12) on `IOPMrootDomain` controls lid-closed sleep. Reassert lid control every second while effective keep-awake is on, on AC or battery, so a reset by `powerd` after wake, power-source, display, or assertion changes is restored before the lid closes; the machine stays awake with the lid closed until the battery reaches its critical-sleep level. Only the exclusive global-state lid-lock owner arms or disarms lid control. Disable and shutdown release its claim; startup restores normal lid sleep before rehydration only for an armed record left by a dead holder. A non-owner never changes a live owner's lid control. An unavailable Node FFI reports unsupported without preventing Session construction. With the one-time sudoers rule installed by `ycoding keep-awake setup`, the lid-lock owner also runs `sudo -n /usr/bin/pmset -a disablesleep 1` when effective keep-awake turns on and `... disablesleep 0` when it turns off or the backend stops; the setup rule permits only those two commands without a password, and removal is `sudo rm /etc/sudoers.d/ycoding-keep-awake`. While the system part is `on`, a closed lid on battery stays awake until the battery shuts the machine down, choosing Sleep does not sleep, and low-battery sleep does not apply. Without the rule the system part reads `setup` and only the idle and lid holds apply, so a closed lid can still sleep when macOS re-evaluates lid sleep after a display, power-source, or wake change. The armed record also stores the system hold; startup restores system sleep for a record left by a dead holder, and a failed restore reports `error` with the restore command. Battery operation drains the battery and a closed lid traps heat; physical lid-close behavior requires device verification. Linux and Windows report unsupported.


Web **Settings → Machine** presents machines in a horizontal row with their online state and a Connect action. Double-click a displayed name or activate its **Edit name** button to edit it in place; Enter or Save applies the name after account confirmation and Escape or Cancel discards it. Empty input or the hostname clears the alias. Display aliases are trimmed, single-line names of 1–48 characters stored against the stable device ID in the owner's account and shared across browsers through account reads. Saving requires an authenticated same-origin request for a nonrevoked device; offline devices can be renamed. The real hostname remains unchanged and visible. Failed saves preserve the draft and reported name; uncertain requests are not replayed automatically. Browser-local names are not read or imported.

If another YCoding process owns the lid lock, lid status is `held`, not `on`, and identifies that foreign ownership separately from this process's idle assertion. A sleeping non-owner acquires the lock on its next reapply, within one second after the owner releases it; lid control can lapse until that tick.

`guardrails.decide_reviews` is on when omitted; only an explicit `false` disables it, and no additional key gates the behavior. It gates only model standard-match verification, and only while the root family's guardrails mode is `yolo`; with it off, the deterministic match stands without a helper call. Autonomy modes are not configuration keys: each Session stores durable `permissions`, `guardrails`, and `answers` modes, each `manual` (default), `yolo`, or `auto`, independent of each other. `manual` never calls a helper model: unresolved requests ask humans awake or defer asleep with reason `disabled`. `yolo` runs that category's evaluator, and every assessment ends in exactly one strict typed outcome, `allow`, `deny`, or `escalate`, with a bounded reason and evidence, judging the actual operation, targets and data, side effects, and bounded authorization; an outside-repository path alone never by itself requires a human. Advisory `decision` calls remain separate.

The guardrail settings (`guardrails.decide_reviews`, `guardrails.decide_hard_reviews`, and the caps) are read when a Location's services start. A configuration reload does not rebuild a running Location's services, so changes apply after the backend restarts or that Location's services are rebuilt; no immediate hot reload is provided. The autonomy modes are durable Session state and take effect immediately within their scopes. `guardrails` resolves as the highest-priority defined object, not a deep merge: a higher-priority `guardrails` object that omits `decide_reviews` leaves verification on, because omission means on; only an explicit `false` in the winning object disables it, whatever lower-priority files say.

The root family's guardrails mode `auto` approves ordinary standard reviews while awake, independently of these switches and with no model fallback; reviews it leaves unresolved ask humans awake or defer asleep. Asleep, no deterministic guardrail auto-approval applies. With guardrails `yolo`, `guardrails.decide_hard_reviews` defaults to true; explicit false skips all model assessment of hard matches, including standard-match verification (ordinary matches are still verified), and a graded hard review can only be denied or escalated, never approved. Approval of a hard or custom-rule review needs a human in every mode. While hard assessment is enabled, a standard hard match shown to be a false positive may be reclassified onto the ordinary path; explicit denies and real hard policy are never model-waived. `allow` requires ≥0.8 and approves the current attempt only; `deny` requires ≥0.8. Highest escalation (including ties), conflicting qualifying approval and rejection, no qualifying grade, an unsupported strict route, refusal, invalid output, ambiguity, failure, or a 60-second deadline escalates awake or defers asleep, always with a visible bounded reason and the next action. Provenance retains selected choice/confidence and optional redacted grades with evidence bounded to 500 characters. Refusal, error, and timeout omit grades. Denies block before helper calls.

`/sleep` stores the root-family `sleep: {}` presence marker, publishes a trusted System sleep notice, and holds keep-awake. It does not enable either automation switch. `/wake` or any user prompt in the family clears sleep, publishes a System wake notice, and releases the hold; no other review setting is restored. Disabled or uncertain automatic answers, free-text questions, and unsettled permission asks defer to the review box; entering sleep converts pending human reviews, waiting questions/forms, subagent questions, and permission asks. Deciding an item does not wake the family. Interrupted prompts and actions are not restored or replayed. Explicit denies retain their contracts.

The TUI palette, Status dialog, and web control report **Checking** until the backend answers, rather than assuming Off. The web control shows **Unavailable** for an unreachable machine or unavailable operation, **Unsupported** for an unsupported platform, and **Error** for a backend inhibitor failure. A failed or unknown change remains visible without claiming it took effect; reconnect does not replay or rearm it. Keep-awake does not preserve execution or network connectivity through manual sleep. Lid-closed operation requires reported lid control and device verification; an unavailable or unconfirmed lid part may allow the machine to sleep.

`ycoding update` checks GitHub Releases and replaces an installed release only after verifying its archive checksum and contents. It checks every archive entry, accepting only regular files and directories and rejecting links, devices, absolute or parent-relative paths, unsafe or duplicate names, entries above the size limit, and archives with more than 1024 entries; it requires the files the release version needs and extracts only those, so additional archive entries are ignored and never written. In a terminal it redraws one progress line: a download bar with percentage and megabytes when the release reports its size (otherwise the megabytes received), then checksum verification and installation; redirected output prints each phase once. macOS releases from 0.2.0 through 0.7.0 contain `ycoding` and `ycoding-computer-helper`; 0.7.1 contains those files plus the signed `ycoding-computer-helper.app` bundle. Later macOS releases contain `ycoding`, the `YCoding Computer Use.app` bundle, and `ycoding-chrome-extension`; the installer and updater require the app's signature to verify (`codesign --verify --deep --strict`) but do not compare its signing identity with the installed app's, and macOS may request renewed Privacy & Security authorization when an update changes the app's signing identity, as described under native computer use; installing one removes a sibling `ycoding-computer-helper` and `ycoding-computer-helper.app`. Self-update preserves and restores the installed files and apps together if replacement fails. Explicit rollback to a published pre-0.2.0 macOS version accepts its historical single-file archive and leaves any sibling helper unchanged. Linux releases through 0.7.1 are single-file, and later Linux releases add `ycoding-chrome-extension`; installing a later release on either platform replaces that folder and restores it if replacement fails. Self-update supports macOS arm64/x64 and Linux x64, matching the shell installer. Development builds must be rebuilt locally: `bun run build:tui` writes the executable, the macOS `YCoding Computer Use.app`, and `ycoding-chrome-extension` together under `dist/tui/<target>/bin`, and `bun run install:local` copies all of them into `~/.local/bin` on macOS and Linux. It fails without changing the installation when the build is incomplete or the macOS app fails signature verification, and replaces each installed item by rename so a running `ycoding` keeps its open executable. Each build re-signs the app ad hoc unless `YCODING_MACOS_SIGNING_IDENTITY` names a signing identity. After installing, `install:local` reads the installed app's actual signature and prints whether it is ad-hoc signed, in which case each build has a different code requirement and you remove the old **YCoding Computer Use** Privacy & Security entries and allow the new one when prompted, or signed by a named certificate, in which case macOS decides whether existing grants apply. Windows users must exit YCoding and replace the executable from the release ZIP manually.

After `ycoding update` installs a release, it applies the release to the running background server without opening the TUI. It looks for a background server of any version; when none is running it prints `No background server is running; nothing to restart`. Otherwise it reads the server's work with `GET /api/session/outstanding` and counts the Sessions in its `running` list: Sessions with an executing drain or a live background shell. When none is running it restarts the server through the managed restart that `ycoding service restart` uses, so the replacement starts from the newly installed executable, and prints `Restarted the background server`. Admitted inputs, settled shell notices, subagent notices, and active goals that are not running do not delay the restart. A restart interrupts executing Sessions and a server start never resumes them, so a server with running Sessions keeps running: the command prints how many Sessions have running work and that `ycoding service restart` applies the update once they finish. `ycoding update --force` (`-f`) restarts the server even while Sessions are running: it prints `Interrupting <n> running Session(s) to restart the background server...` with the number of running Sessions read just before the restart, then `Restarted the background server`; without running Sessions the flag changes nothing. When the outstanding-work read fails or takes longer than five seconds, an unforced update leaves the server running and reports `ycoding service restart`. With `--force`, the command reports that running work could not be checked and restarts anyway, potentially interrupting it. Neither outcome changes the exit status. A failed restart leaves the update installed, reports the failure and `ycoding service restart` on standard error, and exits with status 1. A failed or rolled-back install, and an installation that is already current, never query or restart the server. The executable that runs `ycoding update` performs these steps, not the release it installs, so an update run by a release without them installs the new release but still requires `ycoding service restart` or opening the TUI to run it in the background server.

The background update check resolves the newest release from the same GitHub Releases source and only announces its availability with the explicit `ycoding update` command. It never downloads release assets, installs an update, replaces executables, or restarts the application. An omitted `autoupdate`, `true`, and `"notify"` all enable notice-only checks for patch, minor, and major releases; `false` disables the check. Installation requires the user to run `ycoding update`.

### Meeting capture

Meeting requires the native Bun-built `ycoding` executable. The Node CLI excludes Meeting; `meeting` and `serve --meeting` exit nonzero with an error directing you to the native executable, without starting a meeting server or arming capture.

`ycoding meeting [directory] [--no-open]` starts a private server with the bundled meeting runtime for the directory (default: the current directory), arms a meeting, and opens or prints its local live page; it reuses a meeting runtime that already serves the directory. `ycoding serve --meeting` starts a server with the same runtime plugin. The live page owns browser-tab audio capture using its per-bridge view key, with fresh participant consent and an optional microphone; no capture extension or pairing is required. Keep it open while recording. Speech prerequisites and recording consent are described in [meeting intelligence](./meeting-intelligence.md#ycoding-meeting).

### Local coordination

Use **Projects** to name a Project, choose its Master Session, and add root Sessions across directories. Each Session belongs to at most one Project. Removing a member from a Project leaves its Session and history intact. Creating a Session for a Project composes Session creation with a membership update; deleting a member Session uses the existing Session delete operation.

The local operations are `coordination.settings`, `list`, `create`, `get`, `update`, and `delete` under `/api/coordination`. Updates require the current revision. See the [Project contract](../specs/coordination.md) for request and response shapes.

Project settings contain optional delegated-decision narrowing and `concurrency`, a positive integer or null. At the limit, a send to an idle member is refused rather than placed in a Project queue. A user message in the Master chat activates the Project. Interrupting the Master or restarting the backend pauses dispatch; another user message resumes it. Failure and decision-request notifications still wake the responsible supervising subagent or Master while paused. Completed and interrupted notifications wait in the Master chat without starting a turn. Pending requests remain answerable or escalatable while dispatch is paused.

Routine delegated decisions are enabled by default through the user-level `coordination.delegated_decisions` configuration. Its `enabled`, `categories`, `actions`, `resources`, and `expires_at` fields centrally constrain every group; project configuration cannot broaden this policy. Per-group decision policy can only narrow it. Set `enabled` to false in the global configuration to revoke routine delegation for all groups. Invalid coordination policy fails closed. Delegation changes no autonomy mode and cannot bypass it for approvals or answers: Manual requires a human, Auto uses deterministic rules only, and YOLO uses the category evaluator. A coordinator decline rejects a routine permission ask or ordinary review only while that category is Auto or YOLO; under Manual it escalates to the human unsettled, and it never settles a hard review or human-only request. Proposed coordinator answers cannot supply generated free text outside the YOLO answer path. Hard and custom-rule reviews, irreversible or external actions, credential/account changes, installs/downloads, production migrations, CI/CD or public-contract changes, scope expansion, and uncertain/conflicting cases still require human review.

The default categories are `question`, `permission`, and `review`. Optional `actions` and `resources` contain wildcard patterns; every requested resource must match. `expires_at` is a Unix timestamp in milliseconds. An empty category list disables delegation. Omitted group narrowing inherits the global policy; a group's empty `delegatedDecisions.categories` list disables its delegation.

```json
{
  "coordination": {
    "delegated_decisions": {
      "enabled": false
    }
  }
}
```

External-notification filters are client preferences, not Project settings. TUI `attention.coordination` stores `scope` (`all`, `coordinators`, or `selected`), selected Master `sessionIDs`, and optional `categories` (`question`, `permission`, `review`, `failure`, `completion`). The persisted value `coordinators` selects Masters. Web preferences are per browser and phone push preferences are per subscription. Pending controls and in-app notices remain visible; filtering grants no decision authority.

### Remote access

`ycoding remote` gives the authenticated owner of an enrolled machine access to every Session in that machine's backend through a relay deployment. The local process keeps execution authority; see [Runtime behavior](./runtime.md#remote-relay-agent) for backend-derived Location, authorization, reconnection, and frame-bounding rules.

The connected Web workspace automatically sends bounded, content-free timing batches to its selected machine through that authenticated relay. Only the local Server stores these samples in SQLite: reads include at most 10,000 rows from the last seven days, and expired rows are pruned while the Server runs or at its next start. The relay retains no samples. Settings → Web latency shows the last 60 tab-local measurements and can read saved rows from the selected machine; clearing the tab report does not delete SQLite rows. Account and relay-local timings remain tab-local. See [remote runtime behavior](./runtime.md#remote-relay-agent) for bounds and failure states.

The standalone terminal artifact and the full CLI expose the same remote subcommands and handlers. Remote access does not require a separate full-CLI installation.

In the browser, **New session** selects from existing repositories recorded by that backend. Open a missing repository locally, then use **Refresh repositories**. New Sessions use the selected directory's configured `default_agent` and `model` when no Session-specific selection exists; configure providers and credentials on the machine. The browser does not accept an arbitrary directory or create repositories.

| Command                                                                               | Purpose                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ycoding remote enroll <enrollmentID> [--name <name>] [--relay <origin>] [--replace]` | Enroll this machine with a relay. The one-use enrollment code is read from the terminal, never argv.                                                                                                                           |
| `ycoding remote connect [--relay <origin>] [--server <url> \| --standalone]`          | Turn on the resolved server's remote connection and return once it is on; `--standalone` stays in the foreground until Ctrl-C.                                                                                                 |
| `ycoding remote disconnect [--server <url> \| --standalone]`                          | Turn off the resolved server's remote connection, disable Relay MCP, and revoke that device's MCP client grants. Reconnecting Remote leaves Relay MCP off.                                                                     |
| `ycoding remote status [--server <url> \| --standalone]`                              | Show enrollment, credential validity, local server address, backend Session count, and the remote connection state. An unenrolled machine reports only that it is not enrolled, without starting or contacting a local server. |
| `ycoding remote sessions [--server <url> \| --standalone]`                            | List every Session in the backend through its authoritative Location.                                                                                                                                                          |
| `ycoding remote mcp on [--server <url> \| --standalone]`                              | Enable Relay MCP and print its authority notice, state, and device URL. Requires Remote on; otherwise the error names `ycoding remote connect`, or `ycoding remote enroll` when unenrolled.                                    |
| `ycoding remote mcp off [--server <url> \| --standalone]`                             | Disable Relay MCP and revoke every client grant.                                                                                                                                                                               |
| `ycoding remote mcp status [--server <url> \| --standalone]`                          | Show the Relay MCP state, any message, and the device URL when on.                                                                                                                                                             |

`ycoding remote enroll` requires a relay origin, and `--replace` is required before an existing device identity can be overwritten. `ycoding remote connect` requires an enrolled device and refuses to bridge a local server over a LAN or public-network endpoint.

The machine's remote connection belongs to the local server. The managed background service hosts it, so it stays enabled while that service runs, including when no TUI is open; a `--standalone` private server hosts its own connection for its lifetime. The TUI and the CLI switch and read it only through the server's authenticated `GET /api/remote` and `PUT /api/remote` (`{ enabled }`) operations. `off` means disabled, `connecting` means enabled and starting or recovering, `on` means the relay socket is open, and `error` means setup or authentication requires attention; an optional message supplies details. The TUI command palette offers one **Remote connection** toggle whose indicator is green for ● on and grey for ● off, ● connecting, or ● error; every TUI attached to the same server shows the same backend state, refreshed every 2 seconds outside a pending switch. Selecting `off` enables the connection; selecting `connecting`, `on`, or `error` disables it. A second toggle during a pending enable requests disable, and stale reads or replies cannot restore the superseded state. Turning it on shows the owner-access notice: connecting grants the machine owner access to every existing and future Session on that backend. An unenrolled machine reports an error with the command to run, `ycoding remote enroll <enrollmentID>`. The server stores the on/off choice atomically in `remote.json` under the YCoding state directory, restores it when it starts, and stops the connection without clearing that choice when it shuts down; an unreadable stored choice reports an error instead of connecting.

While enabled, the server retries recoverable startup failures and local connector-lock contention after 1, 2, 4, 8, 16, then at most 30 seconds between attempts; the transport owns ordinary socket reconnection. Each authentication exchange and socket opening has a 30-second deadline. Credential-rotation and connection-recycle failures return to the server's recovery owner instead of leaving an enabled connector without a socket. Disabling or shutting down aborts pending authentication, cancels recovery, and prevents late startup work from reopening the connection. Missing or invalid enrollment, rejected device credentials, relay-origin mismatch, and unsafe local endpoints remain actionable errors rather than automatic reenrollment. After repairing a terminal setup or authentication error, an explicit `ycoding remote connect` makes a fresh attempt; in the TUI, turn the errored connection off and then on. One connector lock under the YCoding data directory allows a single connection per machine; a stale lock is reclaimed when acquisition is retried.

#### Relay MCP

Remote `on` reports the connector socket; Relay MCP `on` reports the acknowledged device gate, not
an OAuth client's authorization. Explicitly turning either service off retires the MCP epoch and
revokes that device's client grants, including access and refresh tokens. Turning Remote on leaves
Relay MCP off. To restore MCP access, enable Relay MCP, then complete a fresh sign-in and consent in
each client through its existing authorization flow. An ordinary same-epoch socket reconnect keeps
grants. Reusing a single-use refresh token also revokes its client grant; do not reuse a revoked token
or switch accounts to avoid reauthorization. The two revocation paths are distinct.

Relay MCP lets an MCP client such as ChatGPT control the machine's Sessions through the relay. It is off by default. Turning Remote on never enables it, and it runs only while Remote is on. The server's authenticated `GET` and `PUT /api/remote/mcp` (`{ enabled }`) operations switch and read it for both the CLI and the TUI, and the state is `off`, `connecting`, `on`, or `error` with an optional message and, when `on`, the device URL `<relay origin>/api/mcp/devices/<device ID>`. Use that URL as the MCP server URL in the client. The relay is the OAuth issuer; the client registers by Client ID Metadata Document or Dynamic Client Registration as a public client, then an allowlisted Google owner of the device signs in again and consents to the client. One scope, `ycoding:remote`, grants the published tool surface: remote operations except browser subscriptions, message streaming, attachment upload, telemetry consent, latency samples, and the `session.dots.*` controls, plus `session_create_in_directory`. Dots controls stay excluded because a published tool would let MCP clients send external Dot messages or control its runtime. That scope covers every Session on the backend, including prompts, interrupts, question, form, permission, and review decisions, persistent Always approvals where the runtime offers them, autonomy category mode and goal changes, provider connections, shell controls, and usage reads. Local HTTP apps require separate explicit registration. The existing autonomy, guardrail, and hard-review rules apply to these tools unchanged. Access tokens last five minutes and refresh tokens rotate within a 30-day absolute limit.

`artifact_demo_preview({})` and `artifact_demo_export({})` are fixed, read-only client-capability tools. The preview references `ui://ycoding/artifact-demo/v1.html` with MIME `text/html;profile=mcp-app` and empty network/resource/frame CSP allowlists. The export links only `ycoding-demo.png`, with original-byte size and SHA-256, and expires 15 minutes after the connector's MCP server initializes. Discovery and resource reads use the same per-request authorization as tool calls. No Session, workspace path, generated HTML or arbitrary file can be selected. The chat host must ingest the exported bytes into its native attachment facility; a resource link does not establish delivery. Actual-host rendering and native delivery require verification. See [the fixed demo contract](../specs/relay-mcp-demo.md).

`session_create_in_directory` takes an absolute path to an existing directory whose real path is strictly below the real path of the machine's home directory, and creates a root Session there. It never creates a directory. The home directory itself, missing paths, paths outside home, and symlinks or `..` that escape home are rejected; Git and non-Git directories are accepted. Both Session creation tools accept an optional `title`: a trimmed, nonblank string of at most 120 Unicode code points without control or directional-override characters. Creation stores it atomically; adopting an existing Session preserves its title. `session_create` and `session_prompt` require a client-generated `input.id` for idempotent retries. Message IDs must start with `msg_` followed by one or more letters, digits, underscores, or hyphens, up to 128 characters total. Use a fresh ID for each new prompt; reuse it only for an exact retry in the same Session. Permission and guardrail replies take the complete request ID returned by their listing tools. After updating the connected machine, refresh the MCP client's tool catalog to pick up the published schemas. A tool result above 2 MiB fails with `message_too_large`, so narrow the request or page through it.

The TUI command palette offers one **Relay MCP** toggle showing ● off, ● connecting, ● on, or ● error, enabling from off and disabling from the other states, and the Status dialog adds a **Relay MCP** row with the state, any actionable error, and the URL when on. Enabling shows the authority notice.

The server stores the choice and a random enable epoch atomically in `remote-mcp.json` under the YCoding state directory. A missing file means off, and a restart restores Relay MCP only when Remote is on as well. Turning it off, or turning Remote off, closes local admission, persists a new epoch, and asks the relay to delete every grant before reporting off. If the relay cannot confirm the revocation, the pending revocation is persisted (repeated off, disconnect, and restart keep the error), the status reports an error, and the next connection synchronizes the off state before any enable. A transient Remote reconnect keeps grants when the epoch is unchanged; turning Relay MCP on again after off requires fresh client consent. Requests already dispatched before the disable are not undone.

The connector runs each mutating tool in order per Session, holding the Session's lane until the response, so an interrupt can wait behind a compaction, model switch, or goal calculation for up to that operation's five-minute limit. Reads and discovery do not wait. An unknown mutation outcome holds only its Session's lane, or the backend lane for a Sessionless action. Before a later mutation, a held model selection is checked against one fresh authorized Session read. An exact provider, model, variant, and profile match confirms the selected state without repeating the switch; an already-selected explicit profile or an unavailable baseline cannot confirm a profile rebind. An uncertain prompt permits an explicit retry with its original prompt ID through durable idempotent admission. Other uncertain outcomes, mismatches, and failed reads retain the hold and refuse further mutations unexecuted. The Relay MCP Status row keeps `on` and its URL while reporting `MCP lane read-only; recovery needed.`; reads and unaffected lanes remain available. Socket reconnection preserves holds. Connector shutdown discards these in-memory holds without replaying requests; it does not establish their outcomes or authorize another action.

Operators deploy it with the existing relay configuration: apply D1 migration `0006_relay_mcp.sql`, keep the existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_ALLOWED_EMAILS` settings, and add `<relay origin>/api/mcp/oauth/google/callback` to the Google OAuth client's authorized redirect URIs. It needs no new binding, secret, or signing key; see [Remote relay deployment](./remote-deployment.md).

Relay MCP Events adds Session-scoped webhook subscriptions when the host supports the extension. Core stores subscriptions and the outbox in the local database and encrypts callback signing secrets with `mcp-events.key` in the global data directory. The key requires protected POSIX storage; Windows reports Events unavailable. The relay rechecks the exact OAuth grant and the connected device before delivery. Callback URLs and signing secrets are never browser-fetch credentials. See the [Events contract](../specs/mcp-events.md) for lifetimes, payloads, failures, and host setup requirements.

Registered local HTTP apps require an explicit `local_app_register` call with a Session, literal-loopback port, and route/method allowlist. Registration grants no blanket localhost access and does not publish the service. It is HTTP-only: WebSocket, SSE, and upstream cookie login are unsupported. See [registered local HTTP apps](../specs/local-http-apps.md).

App preview is off by default and requires the deployment prerequisites in [registered local HTTP apps](../specs/local-http-apps.md#deployment-prerequisites). The `appPreview` entry of the global configuration `remote.json` enables it on this machine:

```json
{
  "sessions": [],
  "appPreview": {
    "origins": ["https://<preview host 1>", "https://<preview host 2>"],
    "ports": [8767],
    "frameAncestors": ["https://<embedding host origin>"]
  }
}
```

| Field            | Value                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `origins`        | The relay's exact `PREVIEW_ORIGINS` list: 1–64 distinct HTTPS origins without a path or wildcard. Missing or empty disables preview.           |
| `ports`          | Loopback ports whose registrations may be previewed, 1–65535, at most 64. Missing or empty disables preview.                                   |
| `frameAncestors` | Exact HTTPS origins allowed to embed the preview frame, at most 16, listing every ancestor of the frame. Empty sends `frame-ancestors 'none'`. |

Each preview origin serves one registration ever: `local_app_open` receives an origin the relay has never bound, and re-opening the same registration keeps it. Once every listed origin is bound, `local_app_open` fails with `preview_exhausted`. An app must use relative URLs, because it is served under `/_r/<lease tag>/` on its origin; absolute-path links fail with `404`. An invalid `appPreview` fails the remote connection with a setup error; changes apply when the remote connection next starts. `local_app_open` reports `preview_unconfigured` until the relay acknowledges the same origin list on the current connection, and fails for a registration whose port is not listed. Revoking an app, turning Relay MCP or Remote off, and disconnecting end its preview access at the relay without freeing an origin.

Local state lives outside any repository checkout:

| File                    | Location                                                                            | Contents                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `remote.json`           | Global configuration directory: `$XDG_CONFIG_HOME/ycoding`, or `YCODING_CONFIG_DIR` | Optional relay origin and optional `appPreview` settings. Existing Session entries are preserved but do not authorize or restrict remote access. |
| `remote-device.json`    | Global state directory: `$XDG_STATE_HOME/ycoding`                                   | The device identity: device ID, name, relay origin, P-256 public key, P-256 private key, and the rotated refresh credential.                     |
| `remote.json`           | Global state directory: `$XDG_STATE_HOME/ycoding`                                   | The machine's remote connection on/off choice, written atomically by the local server.                                                           |
| `remote-connector.lock` | Global data directory: `$XDG_DATA_HOME/ycoding`                                     | The PID of the server process that holds this machine's remote connection.                                                                       |
| `remote-mcp.json`       | Global state directory: `$XDG_STATE_HOME/ycoding`                                   | The Relay MCP on/off choice, enable epoch, and any pending revocation, written atomically with mode `0600`.                                      |

The configuration and device files are written through a temporary file and renamed into place with mode `0600`, and a symbolic link at either path is refused instead of followed. The device private key never leaves the machine, and credentials travel only in request bodies and the WebSocket upgrade header, never in a URL, a flag, or an environment variable. A malformed file fails explicitly and is left in place for the operator. Credential requests never follow redirects, and a rejected, revoked, or expired device credential is terminal: the device must be enrolled again.

Relay sign-in is restricted by a server-only allowlist. `GOOGLE_ALLOWED_EMAILS` holds comma-, whitespace-, or newline-separated Google addresses matched exactly after trimming and lowercasing, with no wildcards or domain suffixes, and it is never returned through an API, a redirect, a log, or the browser bundle. Admission requires a configured entry, a Google-verified email, and an exact match; a missing or empty list denies every Google sign-in. The relay deployment also supplies `GOOGLE_CLIENT_ID` and the `GOOGLE_CLIENT_SECRET` secret.

Provisioning is an operator action in `infra/cloudflare`. `wrangler.jsonc` selects the Durable Object and D1 bindings, the static-assets binding for the built web client, and the custom domain; the Google secrets are set with `wrangler secret put`.

## Rejected configuration keys

A rejected key is dropped with a diagnostic; the rest of its document still loads. Rejected keys are:

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
decisions
```

Removed or unknown keys are dropped individually without discarding unrelated settings. Each dropped item is logged and exposed through `GET /api/config/diagnostics` with its document path, JSON path, reason, and message; security recovery also carries `failClosed: true`. The TUI reports ignored documents, dropped items, and fail-closed recovery with distinct error toasts and Configuration entries in Status.

The MCP shape where server names appear directly under `mcp` is also rejected. Use `mcp.servers`.

## Complete top-level runtime fields

| Field                   | Type                                  | Purpose                                                                                               |
| ----------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `$schema`               | string                                | Optional editor metadata only.                                                                        |
| `shell`                 | string                                | Preferred shell for terminal and shell execution.                                                     |
| `shell_sandbox`         | `disabled`, `optional`, or `required` | Shell isolation policy.                                                                               |
| `shell_memory_limit_mb` | non-negative integer                  | Default shell command process-tree memory limit in MiB; zero disables the default.                    |
| `model`                 | model selector                        | Default model.                                                                                        |
| `model_fallbacks`       | record                                | Models that rerun a failing Step, keyed by `provider/model`; see [Model fallbacks](#model-fallbacks). |
| `default_agent`         | string                                | Default selectable primary agent.                                                                     |
| `autoupdate`            | boolean or `notify`                   | Notice-only update checks; `false` disables checks. Installation is always manual.                    |
| `share`                 | `manual`, `auto`, or `disabled`       | Session sharing policy accepted by Schema.                                                            |
| `enterprise.url`        | string                                | Enterprise sharing endpoint accepted by Schema.                                                       |
| `username`              | string                                | Display and telemetry identity.                                                                       |
| `permissions`           | permission rules                      | Global ordered tool permission rules.                                                                 |
| `agents`                | record                                | Built-in overrides and custom agents.                                                                 |
| `snapshots`             | boolean                               | Undo/revert snapshot behavior.                                                                        |
| `watcher.ignore`        | string array                          | Watcher ignore patterns.                                                                              |
| `formatter`             | boolean or formatter record           | Built-in formatter enablement and overrides.                                                          |
| `lsp`                   | boolean or LSP record                 | Built-in language-server enablement and overrides.                                                    |
| `attachments`           | object                                | Attachment processing, currently image limits and resizing.                                           |
| `tool_output`           | object                                | Tool-output truncation limits.                                                                        |
| `mcp`                   | object                                | MCP defaults and named servers.                                                                       |
| `account_connectors`    | object                                | Opt-in ChatGPT and Claude account tools, selected profiles, and per-connector policy.                   |
| `dots`                  | object                                | Opt-in external Dot conversation peer; `enabled` defaults to false.                                   |
| `compaction`            | object                                | Selective-compaction retention, budget, manifest, and advisory policy.                                |
| `session_retention`     | object                                | Global-only idle Session family deletion; see [Session retention](#session-retention).                |
| `analytics_retention`   | object                                | Global-only usage and latency fact retention; see [Analytics retention](#analytics-retention).        |
| `skills`                | string array                          | Additional skill directories or HTTP(S) sources.                                                      |
| `commands`              | record                                | Named slash commands.                                                                                 |
| `instructions`          | string array                          | Accepted by Schema, but no current runtime consumer reads this field. Do not rely on it.              |
| `capabilities`          | object                                | [Capability toggles](#capability-toggles) for instructions, skills, tools, MCP, plugins.              |
| `instruction_max_bytes` | positive integer                      | Maximum bytes loaded from each ambient instruction file; default 51,200, maximum 1,048,576.           |
| `references`            | record                                | Named local or Git context sources.                                                                   |
| `plugins`               | array                                 | Ordered plugin additions, options, and removals.                                                      |
| `providers`             | record                                | Provider and model overrides.                                                                         |
| `memory`                | object                                | On-demand workspace knowledge enablement, base path, and concept/bundle limits.                       |
| `efficiency`            | object                                | Helper-model, prompt-cache, and provider-continuation policy.                                         |
| `image_analyzer`        | object                                | Image analysis fallback for text-only models.                                                         |
| `experimental`          | object                                | Subagent depth and resource policies.                                                                 |

### Shell memory limits

`shell_sandbox` delegates isolation to an enforceable runtime backend. No shell sandbox backend is bundled: `optional` runs without sandboxing and reports a warning, while `required` rejects execution when no backend is available. A managed worktree is not sandbox-allowed by default.

The model-facing shell `timeout` input is not a configuration field. It accepts whole milliseconds up to 3,600,000 (one hour); omission or `0` selects the finite 600,000 ms default. Values above one hour are rejected. A foreground command that remains active after 300,000 ms is moved to the background without being terminated; its selected timeout still applies.

`shell_memory_limit_mb` sets the Location-wide default for non-interactive shell commands. The shell tool's `memory_limit_mb` input overrides it for one command; zero explicitly selects unlimited memory. Omission uses the configured default, and omission with no default remains unlimited.

A finite limit supplies `GOMEMLIMIT=<limit>MiB` to Go runtimes and appends `--max-old-space-size=<limit>` to `NODE_OPTIONS` for Node processes. Bun does not expose an inherited heap-size option equivalent to Node's, so Bun itself is governed by the sampled process-tree ceiling while child Go or Node runtimes receive their soft hints.

On macOS and Linux, YCoding samples aggregate resident memory for the detached shell process group every 250 milliseconds and terminates the group with status `memory-limit` after a sample exceeds the limit. Sampling can overshoot between checks, shared pages can be counted more than once, and a command that deliberately creates a new process group can escape aggregate accounting. This is resource control, not a security boundary or a kernel hard limit. Windows rejects a finite shell memory limit because the current process abstraction cannot assign the command to a Job Object before it starts.

POSIX shell termination records the original leader's PID and start identity, checks group membership before each signal, sends SIGTERM, and allows three seconds before escalating to SIGKILL. An observed empty group or a live replacement leader permanently ends that handle's ownership; otherwise cleanup signals the group even after its leader exits. Confirmation after SIGKILL is bounded to one second, independently of stream closure. These intervals apply to explicit removal, timeout, memory-limit enforcement, failed output capture, and service or process-scope cleanup; they are not configurable. Descendants that leave the group are outside this boundary and are not signalled; one that holds the capture pipe open delays a normal exit's settlement until timeout, memory-limit enforcement, removal, or teardown, while timeout and memory-limit enforcement end capture at end of file, 100 ms without new data, or 1 s after the forced drain began, whichever comes first. Ownership-read, signalling, or confirmation failures make removal fail and retain live process tracking, its ledger row, and output. Timeout and memory-limit commands receive their corresponding terminal statuses only after successful cleanup; cleanup errors fail waiters rather than report successful cancellation. Windows retains `taskkill /T /F` tree termination.

### Field defaults and nested Schema contract

The field reference below expands the overview. `unset` means the field is optional in Schema and has no default specified here.

| Field path                                        | Exact type or closed values                                                    | Default         | Operational remark                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------- |
| `$schema`                                         | string                                                                         | unset           | Editor metadata only.                                                                                    |
| `shell`                                           | string                                                                         | unset           | Shell executable or command selector.                                                                    |
| `shell_sandbox`                                   | `disabled` \| `optional` \| `required`                                         | unset           | Shell isolation policy.                                                                                  |
| `shell_memory_limit_mb`                           | non-negative integer `<= 1048576`                                              | unset           | Default sampled resident-memory limit in MiB; zero means unlimited.                                      |
| `model`                                           | model selector                                                                 | unset           | Session/agent model fallback.                                                                            |
| `model_fallbacks`                                 | record of `provider/model` to at most 3 distinct model selectors               | unset           | Ordered models that rerun a Step when its model is unavailable, out of quota, or exhausts retries.       |
| `default_agent`, `username`                       | string                                                                         | unset           | Primary agent ID and display identity.                                                                   |
| `autoupdate`                                      | boolean \| `notify`                                                            | unset           | Notice-only checks; `false` disables them.                                                               |
| `share`                                           | `manual` \| `auto` \| `disabled`                                               | unset           | Sharing policy.                                                                                          |
| `enterprise.url`                                  | string                                                                         | unset           | Enterprise endpoint.                                                                                     |
| `permissions`                                     | ordered `[{ action: string, resource: string, effect: allow \| deny \| ask }]` | unset           | Global permission rules.                                                                                 |
| `agents`                                          | record of `Config.Agent`                                                       | unset           | Inline agent definitions and overrides.                                                                  |
| `snapshots`                                       | boolean                                                                        | unset           | Snapshot switch.                                                                                         |
| `watcher`                                         | `Config.Watcher`                                                               | unset           | Watcher filters.                                                                                         |
| `formatter`                                       | boolean \| record of `Config.Formatter.Entry`                                  | unset           | Formatter enablement and overrides.                                                                      |
| `lsp`                                             | boolean \| record of `Config.LSP.Entry`                                        | unset           | Language-server enablement and overrides.                                                                |
| `attachments`, `tool_output`, `mcp`, `compaction` | their named `Config.*` object                                                  | unset           | Runtime tooling and context controls.                                                                    |
| `guardrails`                                      | `Config.Guardrail`                                                             | unset           | Root-Session-family guardrail configuration; custom-source and reply rules are documented below.         |
| `skills`, `instructions`                          | string[]                                                                       | unset           | Extra skill sources; `instructions` has no current ambient-discovery consumer.                           |
| `instruction_max_bytes`                           | positive integer `<= 1048576`                                                  | `51200`         | Per-ambient-instruction UTF-8 byte cap.                                                                  |
| `commands`                                        | record of `Config.Command`                                                     | unset           | Inline slash commands.                                                                                   |
| `references`                                      | record of `Config.Reference.Entry`                                             | unset           | Named local or Git context sources.                                                                      |
| `plugins`                                         | (`string` \| `{ package: string, options?: Record<string, unknown> }`)[]       | unset           | Ordered runtime plugin directives.                                                                       |
| `providers`                                       | record of `Config.Provider`                                                    | unset           | Provider/model overrides.                                                                                |
| `provider_usage`                                  | `Config.ProviderUsage`                                                         | unset           | Read-only provider-usage client bridge.                                                                  |
| `efficiency`                                      | `Config.Efficiency`                                                            | runtime-derived | Helper-model, cache, and continuation policy.                                                            |
| `image_analyzer`                                  | `Config.ImageAnalyzer`                                                         | unset           | Vision fallback for text-only models: provider/model, prompt, and thresholds.                            |
| `dots`                                            | `Config.Dots`                                                                  | disabled        | Set `enabled: true` to enable the external Dot conversation peer for the Location.                       |
| `capabilities`                                    | `Config.Capabilities`                                                          | unset           | Capability toggles; each leaf is last-wins across layers. See [Capability toggles](#capability-toggles). |
| `experimental`                                    | `Config.Experimental`                                                          | unset           | Experimental runtime policy.                                                                             |

| Nested field path                                                                                                            | Exact type or closed values                                                                                     | Default                         | Operational remark                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.<id>.model`                                                                                                          | model selector                                                                                                  | unset                           | Agent model override.                                                                                                                                                             |
| `agents.<id>.request.headers`, `.request.body`                                                                               | string record, JSON record                                                                                      | unset                           | Provider request overlays.                                                                                                                                                        |
| `agents.<id>.system`, `.description`                                                                                         | string                                                                                                          | unset                           | System instruction and display description.                                                                                                                                       |
| `agents.<id>.mode`                                                                                                           | `subagent` \| `primary` \| `all`                                                                                | unset                           | Agent availability.                                                                                                                                                               |
| `agents.<id>.hidden`, `.disabled`                                                                                            | boolean                                                                                                         | unset                           | Visibility and disable switches.                                                                                                                                                  |
| `agents.<id>.color`                                                                                                          | `#RRGGBB` \| `primary` \| `secondary` \| `accent` \| `success` \| `warning` \| `error` \| `info`                | unset                           | TUI color.                                                                                                                                                                        |
| `agents.<id>.steps`                                                                                                          | positive integer                                                                                                | unset                           | Agent step allowance.                                                                                                                                                             |
| `agents.<id>.permissions`                                                                                                    | `Permission.Rule[]`                                                                                             | unset                           | Agent permission additions.                                                                                                                                                       |
| `commands.<name>.template`                                                                                                   | string                                                                                                          | required                        | Command prompt template.                                                                                                                                                          |
| `commands.<name>.description`, `.agent`                                                                                      | string                                                                                                          | unset                           | Picker description and agent ID.                                                                                                                                                  |
| `commands.<name>.model`                                                                                                      | model selector                                                                                                  | unset                           | Command model override.                                                                                                                                                           |
| `commands.<name>.subtask`                                                                                                    | boolean                                                                                                         | unset                           | Subtask request.                                                                                                                                                                  |
| `references.<name>`                                                                                                          | string \| `{ repository: string, branch?, description?, hidden? }` \| `{ path: string, description?, hidden? }` | required per entry              | Reference source.                                                                                                                                                                 |
| `mcp.timeout.startup`, `.catalog`, `.execution`                                                                              | positive integer milliseconds                                                                                   | runtime-derived                 | Global timeout overrides.                                                                                                                                                         |
| `mcp.servers.<name>`                                                                                                         | local \| remote server object                                                                                   | required per entry              | Discriminated by `.type`.                                                                                                                                                         |
| local `.command`                                                                                                             | string[]                                                                                                        | required                        | Stdio command and arguments.                                                                                                                                                      |
| local `.cwd`, `.environment`, `.disabled`, `.timeout`                                                                        | string, string record, boolean, timeout object                                                                  | unset                           | Local-server options; relative `cwd` resolves from workspace.                                                                                                                     |
| remote `.url`                                                                                                                | string                                                                                                          | required                        | Remote MCP endpoint.                                                                                                                                                              |
| remote `.headers`, `.disabled`, `.timeout`                                                                                   | string record, boolean, timeout object                                                                          | unset                           | Remote-server options.                                                                                                                                                            |
| local/remote `.codemode`                                                                                                     | boolean                                                                                                         | `true`                          | Code Mode catalog exposure.                                                                                                                                                       |
| remote `.oauth`                                                                                                              | `false` \| OAuth object                                                                                         | unset                           | OAuth configuration.                                                                                                                                                              |
| `.oauth.client_id`, `.client_secret`, `.scope`, `.redirect_uri`                                                              | string                                                                                                          | unset                           | OAuth client fields.                                                                                                                                                              |
| `.oauth.callback_port`                                                                                                       | integer `1..65535`                                                                                              | unset                           | Local OAuth callback port.                                                                                                                                                        |
| `providers.<id>.name`, `.package`                                                                                            | string                                                                                                          | unset                           | Provider identity/implementation override.                                                                                                                                        |
| `providers.<id>.env`                                                                                                         | string[]                                                                                                        | unset                           | Credential variable names; never place credential values in config.                                                                                                               |
| `providers.<id>.settings`, `.headers`, `.body`                                                                               | JSON record, string record, JSON record                                                                         | unset                           | Provider request overlays.                                                                                                                                                        |
| `providers.<id>.catalog.source`                                                                                              | `openai-models`                                                                                                 | unset                           | Optional model catalog discovery for a configured provider.                                                                                                                       |
| `providers.<id>.models.<id>.modelID`, `.family`, `.name`, `.package`                                                         | model ID, model family, string, string                                                                          | unset                           | Model identity.                                                                                                                                                                   |
| model `.settings`, `.headers`, `.body`                                                                                       | JSON record, string record, JSON record                                                                         | unset                           | Model request overlays.                                                                                                                                                           |
| model `.capabilities.tools`                                                                                                  | boolean                                                                                                         | unset                           | Tool-call declaration.                                                                                                                                                            |
| model `.capabilities.input`, `.output`                                                                                       | string[]                                                                                                        | unset                           | Input/output modality names.                                                                                                                                                      |
| model `.variants[]`                                                                                                          | `{ id: variant ID, settings?, headers?, body? }`                                                                | unset                           | Named request variants.                                                                                                                                                           |
| model `.cost`                                                                                                                | cost object \| cost object[]                                                                                    | unset                           | USD-per-million input/output cost; optional cache and context-tier data.                                                                                                          |
| model `.disabled`                                                                                                            | boolean                                                                                                         | unset                           | Model disable switch.                                                                                                                                                             |
| model `.limit.context`, `.input`, `.output`                                                                                  | integer                                                                                                         | unset                           | Declared model limits.                                                                                                                                                            |
| model `.api`                                                                                                                 | `chat` \| `responses`                                                                                           | unset                           | OpenAI-compatible request surface; `responses` overrides the source default and the catalog value.                                                                                |
| `formatter.<name>`                                                                                                           | `{ disabled?, command?: string[], environment?: Record<string, string>, extensions?: string[] }`                | unset                           | Formatter override.                                                                                                                                                               |
| `lsp.<name>`                                                                                                                 | `{ disabled: true }` \| `{ command: string[], extensions?, disabled?, env?, initialization? }`                  | unset                           | LSP override.                                                                                                                                                                     |
| `attachments.image.auto_resize`                                                                                              | boolean                                                                                                         | unset                           | Image resizing.                                                                                                                                                                   |
| `attachments.image.max_width`, `.max_height`, `.max_base64_bytes`                                                            | positive integer                                                                                                | unset                           | Image limits.                                                                                                                                                                     |
| `tool_output.max_lines`, `.max_bytes`                                                                                        | positive integer                                                                                                | unset                           | Output truncation thresholds; `max_bytes` also bounds stored base64 strings in structured tool metadata.                                                                          |
| `watcher.ignore`                                                                                                             | string[]                                                                                                        | unset                           | Watcher ignore patterns.                                                                                                                                                          |
| `compaction.keep_recent_messages`                                                                                            | non-negative integer                                                                                            | `20`                            | Number of newest complete messages protected from selective exclusion. Model-switch boundary advice requires an explicit value.                                                   |
| `compaction.reserved_output_tokens`                                                                                          | non-negative integer                                                                                            | `0`                             | Output-token reservation used by compaction helper requests.                                                                                                                      |
| `compaction.context_safety_margin_tokens`                                                                                    | non-negative integer                                                                                            | `4096`                          | Tokens reserved from the model input budget before context-pressure and model-switch fit calculations.                                                                            |
| `compaction.timeout_seconds`                                                                                                 | non-negative integer                                                                                            | `60`                            | Total provider-assisted checkpoint-generation budget across all helper calls; expiry stops helper traffic and uses the local canonical checkpoint, while `0` disables the budget. |
| `compaction.max_output_tokens`                                                                                               | non-negative integer                                                                                            | `0`                             | Compaction helper output cap; `0` uses the model cap.                                                                                                                             |
| `compaction.max_manifest_bytes`                                                                                              | non-negative integer                                                                                            | `65536`                         | UTF-8 cap for one strict ContextManifest candidate.                                                                                                                               |
| `compaction.max_internal_passes`                                                                                             | non-negative integer                                                                                            | `8`                             | Maximum physical manifest-generation calls, including repair attempts.                                                                                                            |
| `compaction.advisory`                                                                                                        | `false` \| `{ consider_percent, strongly_advised_percent }`                                                     | `{ 70, 90 }`                    | Disables automatic soft-pressure admission or sets ordered integer thresholds from 1 through 99. Mandatory pressure at the hard cap is independent of this switch.                |
| `guardrails.enabled`                                                                                                         | boolean                                                                                                         | unset                           | Guardrail switch.                                                                                                                                                                 |
| `guardrails.max_concurrent_shells`, `.max_concurrent_subagents`, `.max_pending_reviews`, `.shell_wait_seconds`               | positive integer                                                                                                | unset                           | Root-Session-family caps for running shells, running subagents, pending reviews, and open review-box items; seconds a shell waits for a slot.                                     |
| `provider_usage.codex_app_server.command`                                                                                    | non-empty string                                                                                                | required when object is present | Direct executable, not a shell command.                                                                                                                                           |
| `provider_usage.codex_app_server.args`                                                                                       | string[]                                                                                                        | unset                           | Executable arguments.                                                                                                                                                             |
| `provider_usage.codex_app_server.cwd`                                                                                        | string                                                                                                          | unset                           | Client working directory.                                                                                                                                                         |
| `provider_usage.codex_app_server.timeout_ms`                                                                                 | positive integer `<= 30000`                                                                                     | unset                           | App-server timeout.                                                                                                                                                               |
| `efficiency.title`                                                                                                           | `local` \| `model` \| `off`                                                                                     | `local`                         | Title policy.                                                                                                                                                                     |
| `efficiency.helper_models.title`, `.goal`, `.decision`, `.prediction`, `.prompt`, `.compaction.main`, `.compaction.subagent` | model selector \| `session`                                                                                     | `session`                       | Independent model selection for title, goal, decision, next-message prediction, prompt drafting, and ContextManifest helpers.                                                     |
| `efficiency.prompt_cache.anthropic_ttl`                                                                                      | `adaptive` \| `5m` \| `1h`                                                                                      | `adaptive`                      | Cache lifetime policy.                                                                                                                                                            |
| `efficiency.prompt_cache.openai_mode`                                                                                        | `auto` \| `implicit` \| `explicit`                                                                              | `auto`                          | OpenAI cache lowering.                                                                                                                                                            |
| `efficiency.prompt_cache.openai_extended_retention`                                                                          | boolean                                                                                                         | `false`                         | Pre-GPT-5.6 OpenAI and Meta Muse Spark `24h` retention request.                                                                                                                   |
| `efficiency.prompt_cache.family_scope`                                                                                       | `session` \| `family-experiment`                                                                                | `session`                       | Experimental compatible-family cache keys for selected-context direct public OpenAI HTTP requests; other routes retain Session isolation.                                         |
| `efficiency.openai_responses_continuation`                                                                                   | `auto` \| `on` \| `off`                                                                                         | `auto`                          | Response continuation policy.                                                                                                                                                     |
| `efficiency.openai_responses_state`                                                                                          | `stored` \| `stateless`                                                                                         | `stored`                        | Direct OpenAI Responses storage mode. Stored mode permits compatible response-ID continuation; stateless mode replays opaque provider state.                                      |
| `experimental.subagent_depth`                                                                                                | non-negative integer                                                                                            | `1`                             | Maximum nesting depth.                                                                                                                                                            |
| `experimental.policies`                                                                                                      | `Config.Policy.Info[]`                                                                                          | unset                           | Ordered configured-resource policies.                                                                                                                                             |

### Provider-usage reporting

`provider_usage` configures only the optional Codex app-server fields above. Its output appears separately as **Codex app-server** with unknown account attribution; it does not replace or inherit a stored profile's quota. Provider usage refreshes use credentials already stored for the matching YCoding integration; they do not discover credentials from another application's files, keychain, or browser cookies. GitHub Copilot reuses the OAuth credential configured for `github-copilot`.

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

The variant is optional; omission uses the selected model's settings and is not a named variant. YCoding does not create `default` or `base` variants for omission. Every explicit variant ID must be offered by the selected model, or model resolution fails with `VariantUnavailableError`; source-offered IDs retain their names and settings. An offered `none` variant can select reasoning effort `none` on OpenAI models or disable thinking on DeepSeek. The TUI variant cycle includes an offered `none` variant.

Catalog reasoning variants reach the provider request in each provider's own format: DeepSeek variants send `thinking: { type: "enabled" | "disabled" }` and the requested `reasoning_effort`, which DeepSeek maps server-side; native OpenRouter variants send their `reasoning` object (`effort`, `enabled`, or `max_tokens`), merged with any configured OpenRouter reasoning options.

## Model fallbacks

`model_fallbacks` maps a `provider/model` key to an ordered list of at most three model selectors:

```jsonc
{
  "model_fallbacks": {
    "anthropic/claude-opus-5": ["openai/gpt-6-sol#high", "Work#anthropic/claude-opus-5"],
  },
}
```

- The key covers every variant and profile of that model. The model ID may contain `/`; `#` is not allowed in a key.
- Entries use the model selector forms above. An entry may name the same model with another variant or profile, but not the bare key itself; entries must be distinct.
- An entry runs on the profile it names, or on the provider default when it names none.
- Only the list of the Session's selected model is used; the lists of fallback models are ignored, so chains do not continue or cycle.
- The nearest configuration document that sets `model_fallbacks` supplies the whole map.
- Entries are resolved when used. An entry whose model, variant, or provider package is unavailable counts as a failed candidate, and the next entry is tried. An entry whose profile is missing or unavailable fails the Step without trying further entries.

A Step switches to the next untried entry only before observable output, and only when the model is unavailable, reports exhausted quota or no route, asks for a retry delay beyond 120 seconds, or still fails after its retries. See [model fallback](./runtime.md#model-fallback) for the full failure classes and Step behavior.

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
| `helper_models.prediction`               | model selector, `session`      | `session`  | Model for next-message prediction; an explicit `agents.prediction.model` takes precedence.                       |
| `helper_models.prompt`                   | model selector, `session`      | `session`  | Model for `/prompt` drafts; an explicit `agents.prompt.model` takes precedence.                                  |
| `helper_models.goal`                     | model selector, `session`      | `session`  | Model for model-based goal synthesis.                                                                            |
| `helper_models.decision`                 | model selector, `session`      | `session`  | Model for hidden decision-agent judgments; an explicit `agents.decision.model` takes precedence.                 |
| `helper_models.compaction.main`          | model selector, `session`      | `session`  | Model for ContextManifest generation in main chats.                                                              |
| `helper_models.compaction.subagent`      | model selector, `session`      | `session`  | Model for ContextManifest generation in child Sessions.                                                          |
| `prompt_cache.anthropic_ttl`             | `adaptive`, `5m`, `1h`         | `adaptive` | Choose Anthropic-compatible cache lifetime behavior.                                                             |
| `prompt_cache.openai_mode`               | `auto`, `implicit`, `explicit` | `auto`     | Select OpenAI prompt-cache behavior according to model and route capabilities.                                   |
| `prompt_cache.openai_extended_retention` | boolean                        | `false`    | Request `24h` cache retention for supported pre-GPT-5.6 OpenAI and Meta Muse Spark models.                       |
| `prompt_cache.family_scope`              | `session`, `family-experiment` | `session`  | Select default Session-local keys or the capability-gated family experiment.                                     |
| `openai_responses_continuation`          | `auto`, `on`, `off`            | `auto`     | Reuse compatible durable direct OpenAI Responses state when state mode is `stored` and effective storage allows. |
| `openai_responses_state`                 | `stored`, `stateless`          | `stored`   | Select provider-stored response-ID continuation or stateless opaque replay for direct OpenAI Responses.          |

`prompt_cache.anthropic_ttl: "adaptive"` gives root Session steps the one-hour bucket from their first request. Child Sessions and title, goal, and compaction requests get the five-minute bucket. A request source never changes its TTL, because changing it misses every cache entry written earlier. Models without published extended-TTL support always use five minutes.

`prompt_cache.family_scope: "family-experiment"` applies only to direct public OpenAI HTTP Responses requests with GPT-5.6-or-later generated breakpoints, a valid admitted shared-context snapshot and verified account identity. Compatible requests within the stored root family can share the experimental key; account, model, variant, effective options, permissions, tools, system, Location, connection or snapshot differences partition it. `openai_mode: "implicit"`, Codex, WebSockets, OpenRouter and other routes keep Session-local keys. The setting changes neither provider retention nor continuation ownership. It makes no live cache-hit or savings guarantee; see [provider efficiency](./provider-efficiency.md#selected-context-and-compatible-family-experiments).

## Image analysis fallback

Text-only models cannot natively receive `image/*` media. When `image_analyzer` is configured, YCoding replaces provider images with a deterministic text description so any agent gets consistent understanding. Provider images are managed user attachments and inline `data:` PNG, JPEG, GIF, or WebP images in completed local tool results. A tool-result image's description replaces that image in place inside the same tool result, so the tool call ID and the tool's text are unchanged. Durable Session history keeps the original image. Provider-executed tool results are sent unchanged, and YCoding never fetches a tool-result URI to analyze it.

Multimodal models (those whose `capabilities.input` contains `image/*` or `vision`) bypass the fallback and receive media natively.

Configuration:

```jsonc
{
  // Preferred selector string ([profile#]provider/model[#variant])
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

`prompt_cache.openai_mode: "auto"` uses hybrid caching for direct OpenAI Responses requests on GPT-5.6 and later. Requests without a plugin-owned volatile suffix send request-wide implicit mode, keep OpenAI's managed implicit breakpoint, and reserve that breakpoint one of OpenAI's latest 50 read candidates. A request ending in plugin-owned volatile context instead compiles with request-wide explicit mode, keeps that suffix unmarked, and uses all 50 candidates for stable explicit boundaries. In ordinary implicit mode YCoding emits at most 49 explicit `input_text` candidates: one combined system-text marker when system text exists, then eligible non-volatile user and local tool-result text boundaries. `"explicit"` disables the managed breakpoint and uses at most 50 explicit candidates. OpenAI can write the latest three explicit candidates plus the managed breakpoint in implicit mode, or the latest four explicit candidates in explicit mode. Assistant replay remains unmarked `output_text`; marked local tool results use `input_text` inside `function_call_output.output` while structured media remains unchanged. Tool definitions, tool calls, provider-executed tool results, and plugin-owned volatile messages receive no generated marker. Older public OpenAI models remain implicit. ChatGPT Codex requests are key-only for every model: YCoding emits none of `prompt_cache_breakpoint`, `prompt_cache_options`, or `prompt_cache_retention`, and uses the Session-scoped prompt-cache key for `session-id`, `thread-id`, and `x-client-request-id`; the explicitly selected WebSocket route also uses it for process-local socket affinity. Default provider keys derive from the Session ID and baseline namespace; the explicit `family_scope` experiment changes only eligible public OpenAI HTTP keys. Request-shape tests do not verify live Codex cache reuse, which remains provider-controlled without a hit-rate guarantee. OpenAI-compatible gateways and unsupported model families omit GPT-5.6-only fields. `"implicit"` disables YCoding's generated explicit markers.

Direct OpenAI GPT-5.6 Responses requests automatically request `reasoning.context: "all_turns"` and enable server-side compaction at `200000` rendered tokens. In `stateless` mode, encrypted compaction items are retained outside public Session messages and replayed only for the same provider model. In `stored` mode, compatible requests may instead continue with `previous_response_id`. Direct OpenAI is Responses-only; configured third-party OpenAI-compatible Chat remains a separate route family. ChatGPT OAuth uses Codex HTTP/SSE by default. Set `providers.openai.settings.transport` to `"websocket"` to select the distinct Codex WebSocket route; `"http"` or omission selects HTTP/SSE, and neither route falls back to the other.

The native OpenAI and ChatGPT/Codex routes do not consume `chunkTimeout`, `headerTimeout`, or `timeout` from `providers.openai.settings`. `chunkTimeout` and `timeout` are AI-SDK adapter controls for providers resolved through an AI-SDK package, while `headerTimeout` currently has no runtime consumer. These fields do not prevent an established Codex SSE socket from being reset; native Codex recovery uses the bounded transport retry policy documented in [`runtime.md`](./runtime.md).

ChatGPT OAuth authorization uses the `Codex Desktop` originator. Authenticated model, catalog, quota, account connector, native Library and Dots requests share `originator: Codex Desktop` and `User-Agent: Codex Desktop/26.1013.31256 (<platform>; <architecture>)`. Local Codex app-server quota initialization uses the same name and version. Direct OpenAI API-key requests retain their own identity. Signed file-transfer destinations receive only the transfer headers required by their signature, never the account bearer or account identity.

Daybreak is OpenAI's Trusted Access for Cyber program with two access levels, `daybreak_blue` and `daybreak_red`, selected per Session as `session.daybreak`; an absent value is off and requests keep standard safeguards. ChatGPT connections discover Daybreak availability from the authenticated Codex model catalog at startup and when the active connection changes. Catalog requests use Codex catalog client version `0.163.0-alpha.10.2`, independently of the YCoding release version. Each ordinary model entry advertising `daybreak_blue` or `daybreak_red` in `available_access_programs.cyber` carries an advertised `daybreak` list containing exactly those programs. Discovery runs in the background with a three-second timeout; missing, unknown, invalid, or unavailable metadata never blocks ordinary model use. Changing the connection clears the previous account's discovery, and late responses cannot restore it.

Use `/daybreak blue`, `/daybreak red`, or `/daybreak off`, or the Daybreak command in the landing or Session command palette. Without an argument, `/daybreak` cycles off → blue → red → off, offering only programs the selected model profile advertises. An explicit named profile uses its own advertised programs, including an empty list; it does not inherit model-wide programs. The provider default uses the model-wide advertisement. The model picker lists ordinary models, not separate Daybreak entries. A landing selection updates the header immediately without creating a Session; it is saved durably as `session.daybreak.set` after Session creation and before the first prompt or explicit goal starts. A Session toggle saves the selection immediately. If saving fails, the prompt or goal does not start. The header shows `Daybreak Blue` or `Daybreak Red` beside the current model name; an unsupported model, profile, or provider shows the saved selection as `(inactive)`. Switching back to a supported model or profile restores the selected mode; `/daybreak off` clears it and removes the indicator.

Requests carry `access_programs: { cyber: <program> }` only when the provider is `openai`, the credential is ChatGPT OAuth, the resolved route is a Codex HTTP or WebSocket backend route, and the active model advertises the selected program. Unsupported models, API-key credentials, custom providers, GPT through OpenRouter, Anthropic, and DeepSeek omit the field while retaining the stored Session selection. Discovery is not entitlement: missing metadata does not establish an authorization denial, and neither plan names nor a ChatGPT UI toggle grant inference access. OpenAI still enforces authorization. Daybreak does not change YCoding permissions, guardrails, or autonomy.

The Core `websearch` tool is provider-independent local search backed by Exa or Parallel. It is distinct from `OpenAI.webSearch(...)`, which adds OpenAI-hosted `web_search` to a direct Responses request and executes at OpenAI.

When `openai_extended_retention` is true, supported pre-GPT-5.6 direct OpenAI requests and Meta Muse Spark requests use `prompt_cache_retention: "24h"`. GPT-5.6-and-later `auto` and `explicit` requests use `prompt_cache_options.ttl: "30m"`; `30m` is that model family's only supported minimum reuse lifetime, not a hard expiry, and OpenAI applies a separate 24-hour maximum. The setting remains false by default because pre-GPT-5.6 extended provider retention may have different privacy and eligibility properties.

`openai_responses_continuation` never changes `openai_responses_state`. The default `stored` state sends `store: true` on direct OpenAI Responses requests; choose `stateless` to send `store: false` and disable response-ID continuation. Enabling extended cache retention or stored Responses state may change provider data-retention behavior; make that choice explicitly.

The default `local` title mode makes no provider request. Set `title` to `model` for model-generated titles; `title: "off"` leaves the initial generated Session title unchanged. Explicit `/goal <text>` calculation always uses a model, while resuming a retained goal does not recalculate it.

### Next-message prediction

| Key                                        | Type                        | Default   | Contract                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `efficiency.helper_models.prediction`      | model selector or `session` | `session` | Resolve like the title helper: explicit `agents.prediction.model` wins, otherwise use this selection or the Session/default model.                                                              |
| TUI `keybinds["prompt.prediction.accept"]` | key binding                 | `right`   | Tab or this configurable shortcut fills only while the prompt is empty and a matching ghost suggestion is shown; never sends. Tab and the configured shortcut retain normal behavior otherwise. |

Predictions run only when requested with `/suggest [hint]` in the TUI or web composer; no configuration key enables or disables them. The command opens a dialog with **Project memory (this repository)** and **Global memory (shared knowledge)**, both unselected by default. The hidden primary `prediction` agent has its own prediction system prompt and no tools. Override its prompt with `agents.prediction.system` if needed. The helper receives the latest user and assistant text, bounded to 2,000 and 4,000 characters, and the optional hint, bounded to 2,000 characters. Each selected memory scope adds at most three search hits with snippets of at most 600 characters when the selected agent's effective `memory_read` is `allow` or `ask`; `deny` skips that scope, and memory failures degrade to conversation-only prediction. Accepted output is a single line of 2–40 words and at most 400 characters. Prediction requests use ordinary provider pricing, usage, and privacy policies, including accounting for partial usage before cancellation. Input admission or agent, model, or profile selection cancels in-flight prediction. The TUI and web dismiss on typing, Escape, or new Session activity and reject late suggestions for the dismissed assistant source. TUI acceptance uses Tab or its configurable shortcut, defaulting to Right; web acceptance uses Tab, Right, or **Use suggestion**. Tab retains normal behavior when no suggestion is shown. Neither acceptance path sends or replaces a nonempty draft.

```json
{
  "efficiency": { "helper_models": { "prediction": "session" } }
}
```

### Prompt generation

| Key                               | Type                        | Default   | Contract                                                                                                                       |
| --------------------------------- | --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `efficiency.helper_models.prompt` | model selector or `session` | `session` | Resolve like the title helper: explicit `agents.prompt.model` wins, otherwise use this selection or the Session/default model. |

Prompt drafts run only when requested with `/prompt <intent>` in the TUI or web composer; no configuration key enables or disables them. The hidden primary `prompt` agent has its own prompt-drafting system prompt and no tools; override it with `agents.prompt.system` if needed. The helper receives the mode (`start`, `steer`, `queue`, or `goal`), the trimmed intent of at most 4,000 characters, the latest user text and assistant text parts bounded to 2,000 and 4,000 characters when present, and at most three snippets of at most 600 characters from each selected memory scope whose selected agent's effective `memory_read` is `allow` or `ask`; `deny` skips that scope, and memory failures degrade to drafting without snippets. Accepted output is at most 8,000 characters and may span lines. Prompt requests use ordinary provider pricing, usage, and privacy policies and are accounted under source `prompt`, including partial usage before cancellation. A newer request for the same Session, or moving, deleting, or archiving the Session, cancels an in-flight request; input admission and execution do not.

```json
{
  "efficiency": { "helper_models": { "prompt": "session" } }
}
```

### Goal helper selection

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

For titles, goals, and decision judgments, an explicit model on the matching hidden agent takes precedence over `efficiency.helper_models.<role>`; a missing value or `session` uses the current Session model. Local selective-compaction manifests resolve `helper_models.compaction.main` for main chats and `.subagent` for child Sessions before creating the helper child. An explicit configured compaction model takes precedence over the agent-pinned model; a missing value or `session` retains the existing `agent model`, then owner-Session-model precedence. A subagent owner's `session` value means that subagent's own model. An explicitly selected helper model without a profile uses that provider's default profile, even when the helper owner selected another profile; inheriting the whole Session model retains its profile. Local jobs reuse a deterministic taskless child Session with the hidden primary `compaction` agent, the selected model, and provider/cache identity isolated from the owner. On a ChatGPT/Codex Responses route, remote compaction uses the owner Session's model regardless of the helper selection; if remote compaction fails, the same job uses the configured local helper. Direct OpenAI and eligible Copilot Responses can compact inline on their Session model without calling a helper. This changes no configuration shape.

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

Interactive and deferred permission approval for the Session remember the exact canonical action and the displayed resource patterns. Matching later requests in that Session proceed without another permission prompt; other actions, resources and Sessions remain subject to their own rules. These approvals survive TUI reconnects and Location runtime recreation within the same backend, and are cleared when the Session is deleted or the backend restarts. Existing explicitly saved Project permissions retain their stored scope. Explicit denies, ceilings and human-only requests take precedence.

Automatic handling is controlled by durable Session autonomy `{ mode: "normal", permissions, guardrails, answers, goal?, sleep? }`, each category `manual` (default), `yolo`, or `auto`. Set them with `/autonomous`, one dialog with Permissions, Guardrails, and Answers rows: Up/Down selects a row, Left/Right cycles Manual, YOLO, and Auto with wrapping, and `1`, `2`, and `3` set every row to Manual, YOLO, or Auto. The dialog shows each row's effective mode and, when an ancestor or root supplies it, the source Session; a local Manual never hides inherited authority and cannot cancel it. `manual`: only a human settles unresolved requests, and no helper model runs. `auto`: deterministic rules only, with no model fallback. Permissions approve `ask` requests by rule; guardrails approve ordinary standard reviews for the root family while awake, never hard or custom-rule reviews; answers supply only a valid explicit default or exactly one `Recommended` option in the Session itself. `yolo`: the category's hidden evaluator (`yolo-permission`, `yolo-guardrail`, or `yolo-answer`; all tools denied) judges requests deterministic rules leave unresolved, and only `yolo-answer` generates required free text, after typed bounded validation. Inheritance: effective permissions take `auto` over `yolo` over `manual` across the managed-task ancestor chain, preferring the Session itself on ties; guardrails read the root family's choice; answers take the Session's own `auto`, otherwise `yolo` from the Session or a managed-task ancestor, and an ancestor's `auto` never propagates. An active goal approves no permissions, answers no questions or forms, and settles no guardrail reviews. Explicit denies, caps, and inherited permission ceilings settle first and remain enforced. Manual permission decisions, including approval for the current Session, remain available.

Stored autonomy migrates once, idempotently, per category: a stored `autoPermission`, `autoGuardrail`, or `autoAnswer` of `true` becomes `auto` for permissions, guardrails, or answers; otherwise a stored `yolo` of `true` becomes `yolo`; otherwise `manual`. Migration preserves goal and sleep and removes the obsolete keys; a state written in the current format afterward is unchanged. A malformed or unmigrated shape reads as every category `manual`.

For noninteractive runs, `ycoding run --permissions <mode>`, `--guardrails <mode>`, and `--answers <mode>` (each `manual`, `yolo`, or `auto`) set the corresponding durable Session categories before admitting the prompt; each is independent, and omitting one preserves an adopted Session's stored value. A failed autonomy update prevents prompt admission.

The noninteractive client does not approve requests locally: any remaining permission, question, form, or human guardrail blocker is rejected or cancelled and the run exits unsuccessfully. Runtime graded review delegation and sleep handling operate independently of this client.

Home-directory expansion applies to path resources for `external_directory`, `read`, and `edit`. It does not rewrite shell command text.

System temporary directories are exempt from ordinary outside-repository review and the `external_directory` ask: the runtime's temporary directory (`TMPDIR` when set), `/tmp`, `/private/tmp`, `/var/tmp`, `/private/var/tmp`, `/var/folders`, and `/private/var/folders`. Resolve targets and roots through symlinks before checking containment, including existing ancestors of new files. `/tmp` and `/private/tmp` identify the same directory where the system aliases them. Prefix lookalikes, `..` escapes, and symlinks resolving outside these roots receive no temp exemption. Explicit permission denies and Session ceilings still apply, including across directory aliases. This exemption grants only path scope: other tool permissions, mandatory human decisions, custom guardrails, destructive-action rules, and hard reviews remain in force. Project, ancestor, and home deletion protections also apply when those directories are inside temp.

The `worktree` permission controls listing and creating managed Git worktrees; its built-in default is `allow`, and the read-only BTW advisor asks. Creation also passes through the Session `file_mutation` guardrail. Managed worktrees are stored at `<data>/worktrees/<repo-key>/<name>`, where `repo-key` is `repo_` plus the SHA-256 of the canonical Git common directory, and branch names match directory names. Every checkout listed for the same Git repository (the main checkout and its linked worktrees) is treated as internal for `external_directory`. Built-in agents also allow `external_directory` for `<data>/worktrees/*`, so every managed worktree, including another repository's, is reachable without an outside-directory prompt, and the Session guardrail exempts it as a data-directory descendant. Other outside paths remain external unless covered by the temporary-directory exemption above. Checkout trust comparisons use strict native filesystem resolution for Windows short-name aliases and require both checkout containment and matching canonical Git common directories. Canonicalization failures do not grant checkout trust.

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

When `default_agent` is omitted, YCoding selects the maintained `god` primary agent. Agent listings place the effective default first, so a new TUI session starts with `god` while an explicit `default_agent` remains authoritative. The selectable built-in primaries are `GSD`, `architech`, `god`, and `yangi`; maintained subagents are `occam`, `omoikane`, `wittgenstein`, and `zeus`. `GSD` (Get shit done) is the one-shot delivery profile: it implements directly when fastest, delegates independent work in parallel when useful, and verifies root-cause fixes with focused tests and required affected checks. The visible `btw` advisor and hidden `compaction`, `title`, `goal`, `decision`, and `summary` helpers remain registered. `decision` is a hidden primary helper with all tools denied. `compaction` remains `mode: primary`; its internal taskless child Session does not create a managed subagent task. `build`, `plan`, `explore`, `general`, `analyze`, and `brainstorm` are not built-ins.

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
- `AGENTS.md` discovered from the project root toward the current directory, plus nested `AGENTS.md` files injected after a `read` below the current directory;
- MCP server instructions;
- activated skills;
- explicit durable session instruction injection.

The top-level `instructions` field is Schema-accepted but not connected to current instruction discovery. [`capabilities.instructions`](#capability-toggles) turns off global or project `AGENTS.md` files or excludes individual files.

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

The native-only [meeting runtime](./meeting-intelligence.md#configuration) configures speech, processing, analysis, knowledge bindings and retention through runtime plugin `options`. Its TUI entrypoint belongs in global `cli.json` `plugins`; there is no top-level `meeting` configuration key. In the native Bun-built executable, `ycoding meeting [directory] [--no-open]` loads the bundled runtime plugin without a `plugins` entry; it uses the meeting data directory's saved `settings.json`, or the documented defaults. `ycoding serve --meeting` starts a server with that plugin. Plugin loading never downloads weights or starts recording.

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

MCP server definitions are read when a Location's services boot. Changes to `mcp.servers` take effect after the server restarts or the Location is evicted and initialized again.

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
- `cwd`: optional, relative to the workspace; the resolved working directory (the Location directory when unset) must exist and be a directory, otherwise the server fails with `Working directory does not exist: <path>` or `Working directory is not a directory: <path>` without starting a process;
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

YCoding negotiates the MCP protocol revision with local stdio and remote Streamable HTTP servers alike. It first sends `server/discover` offering revision `2026-07-28`. A server that supports that revision connects on it: no `initialize` handshake runs, every request carries the `io.modelcontextprotocol/protocolVersion`, client-information, and client-capabilities `_meta` envelope, and Streamable HTTP requests also carry the `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers. An unsupported-protocol-version error (`-32022`) that lists a revision of `2026-07-28` or later fails the connection, because the server is a 2026-era server without a revision YCoding supports. Any other answer falls back to the `initialize` handshake offering `2025-11-25`; the server may answer with `2025-06-18`, `2025-03-26`, `2024-11-05`, or `2024-10-07`. A local server receives the probe in the process YCoding starts for the connection. When that process answers with an error, the `initialize` handshake runs in the same process. When it exits or does not answer within 5 seconds, or within the startup timeout if that is shorter, YCoding stops it and starts the command once more for the `initialize` handshake, which has its own startup timeout. A remote server that answers the probe with HTTP 5xx or an unusable reply, or does not answer within the startup timeout, fails to connect; HTTP 401 runs the OAuth handling below. For the life of the YCoding process, a server configuration that connected on a 2025-era revision connects again with `initialize` and no probe; a connection failure discards that knowledge, so the next connection probes again. A `2026-07-28` server receives `server/discover` on every connection because its answer supplies the server's capabilities.

On `2026-07-28` connections, a server asks for input by returning `input_required` from a tool call, prompt, or resource read; YCoding answers form and URL elicitations through the same forms it uses for 2025-era `elicitation/create` requests and retries the call. A URL elicitation completes when the form is answered, because `2026-07-28` has no elicitation-complete notification. Tool, prompt, and resource list changes arrive on a `subscriptions/listen` stream that YCoding opens once per connection when the server advertises `listChanged`; changes made after the server ends that stream are not received until the server reconnects. YCoding does not request server log notifications on `2026-07-28` connections. When a 2025-era Streamable HTTP server answers a request in an existing session with HTTP 404, YCoding runs `initialize` once for the expired session and retries the request, unless the request was cancelled or timed out meanwhile; if that `initialize` fails, the connection closes. A tool whose `outputSchema` cannot be compiled is called without output validation; the other tools of that server keep theirs.

A remote server's OAuth credentials are stored as profiles of its integration, keyed by server name and URL, and every Location and process sharing the data directory uses them. Each connection uses the integration's active profile and reads the stored credential on every request, so a token refreshed or rotated by one connection is used by all of them. When the server rejects the access token, the connection refreshes it with the stored refresh token and retries the request. It keeps the stored refresh token when the token response omits one and stores the rotated token when one is returned. Within one process, a refresh token is exchanged once. Concurrent identical refresh requests share that exchange. When the exchange returns a rotated refresh token, later requests presenting the exchanged token reuse its result until a request presents the rotated token. When a refresh is rejected after the stored token has already been replaced, the connection retries with the replacement. When the token still stored is rejected, the connection removes that profile and reports `needs_auth`. Access tokens are refreshed only after the server rejects them, not ahead of their expiry. Simultaneous refreshes of one single-use refresh token from different processes are not coordinated. Stored tokens and dynamically registered client information record the issuer of the authorization server that produced them, and a credential recorded for a different authorization server is not presented; a credential stored without an issuer is treated as issued by the authorization server discovered when it is used and records that issuer the next time its tokens are saved. The interactive login checks the callback's `state` and then validates its `iss` parameter against the authorization server's metadata before redeeming the code or showing an error the callback reports, and dynamic client registration declares `application_type` `native` for loopback or custom-scheme redirect URIs and `web` otherwise.

A mid-session rejection of the latest refresh token fails the current tool call with an authentication requirement and withdraws the server's tools. Further tool calls fail without contacting the server until the connection is authenticated; no other stored profile is used to retry the failed call.

Default MCP timeouts are:

| Phase                                                       | Default    |
| ----------------------------------------------------------- | ---------- |
| Transport startup, protocol negotiation, and initialization | 30 seconds |
| Catalog discovery such as `tools/list` and `prompts/list`   | 30 seconds |
| Tool and prompt execution                                   | 12 hours   |

Override a phase globally under `mcp.timeout` or per server under that server's `timeout`. Package-manager launchers such as `npx -y ...` may need a larger startup or catalog timeout on first use.

The TUI displays configured MCP servers in `/mcps`, the status dialog, the sidebar, and the Home/Session footer. Footer counts use `connected/configured` form so failed or pending servers remain visible.

Initial MCP failures and authentication requirements are shown in MCP and Status rather than corner toasts, including the first transition from `pending` to either state. Once a server has settled, a later transition into `failed` or `needs_auth` produces a toast; repeated reads of the same state do not repeat the alert. Selecting an MCP entry in Status opens the MCP dialog for details and connection actions.

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

Each failed or authorization-blocked connection logs an `mcp connect failed` warning with the server name, the Location `directory`, the resolved `cwd` for local servers, and the status.

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
(`/connect`, the TUI command palette's `Connect integration`, its model selector's connect action, or the web palette's `Connect provider`),
and re-using a name updates that profile instead of replacing the provider's credentials.

In the web, **Connect provider** uses the selected machine and current Session or landing repository.
API keys and manual authorization codes pass through the authenticated relay and are stored only by
the machine's credential owner. A successful connection creates or replaces the named profile and
makes it that provider's global default; it does not reselect an existing Session's explicit profile.
The dialog offers registered key, remote-capable OAuth, and command methods. Loopback-only or
undeclared OAuth methods state that sign-in must happen on the backend machine. A registered command
runs on that machine and may still require local browser interaction. Failed or unknown outcomes
require checking authentication status or refreshing profiles before an explicit retry; writes are
never automatically replayed. Model/profile selection uses **Select provider and model** and retains
the composer's existing pending-selection and draft behavior.

Browser model switches allow five minutes for settlement. An unknown outcome permits one fresh read
of the same selected Session on the same connection, without repeating the mutation. All four model
reference fields must match. An already-selected explicit profile cannot confirm an uncertain profile
rebind. An unresolved outcome stays unknown and asks for state inspection; rejection stays failed.

One profile per provider is its default profile; a model reference without a profile uses it. A Session
can select an eligible named profile alongside its model independently of that default, so two Sessions
or subagents can use different accounts for the same provider and model simultaneously. Selecting a
Session profile does not change the default. In the TUI provider dialog, the default profile is marked
**Default profile** and every other stored profile offers **Make `<name>` the default**.
**Use provider default** clears explicit selection. Provider usage reports supported stored profiles;
provider-wide local spend is not per-profile billing.

Model availability, effort variants, and Daybreak access follow the selected profile. A model offered
only by another named profile stays selectable with that profile; it is not usable through an
ineligible provider default. Authenticated custom-provider discovery maintains each stored profile's
own inventory and request settings.

Provider and model configuration overlays apply to every eligible profile, including the default
profile. Configured packages, endpoints, headers, request bodies, and effort variants remain
authoritative after account-specific discovery; selecting a profile does not discard them or
borrow another account's discovered settings.

The public model reference carries the user-chosen `profile` name. Structured configuration selectors
accept it too. String shorthand uses `[profile#]provider/model[#variant]`; omitting the profile uses
the provider's default profile:

```text
Work#openai/gpt-6-luna#high
openai/gpt-6-luna#high
```

Use structured selectors for profile names containing `/` or `#`.

```jsonc
{
  "model": {
    "providerID": "openai",
    "model": "gpt-6-luna",
    "variant": "high",
    "profile": "Work",
  },
}
```

Profile names resolve only within that provider's integration. A missing, renamed, removed, or replaced
explicit profile blocks provider work instead of selecting another account. Re-selecting the same
named profile explicitly restores its binding after replacement. Ordinary token refresh does not
change the selected account. Reusing a Session or admitted-input ID retains its original binding.

Model controls and the Session header distinguish explicit profiles from the provider default. Pending
changes apply before prompt admission; failure preserves the draft. An unavailable saved selection
stays visible with a recovery action. Helpers and subagents keep their existing model precedence. An
explicitly chosen helper model with no profile uses the chosen provider's default profile; only
inheriting the whole owning Session model retains its profile. Explicit profile names select accounts
only within their provider. See the
[profile isolation contract](../specs/provider-profiles.md).

### ChatGPT account connectors

`account_connectors.chatgpt` enables the selected account's native Library tools and hosted MCP catalog. It is disabled when omitted or when `enabled` is false; disabled configuration makes no discovery requests and advertises neither surface.

```jsonc
{
  "account_connectors": {
    "chatgpt": {
      "enabled": true,
      "profile": "personal",
      "connectors": {
        "connector_allowed": "allow",
        "connector_blocked": "deny",
      },
    },
  },
}
```

`profile` selects an existing named OpenAI ChatGPT OAuth profile. When omitted, an OpenAI Session uses its selected model profile; other Sessions use the active OpenAI profile. API keys are not supported. Connector policies use stable catalog connector IDs, not display names. Omitted connector policies allow discovery; `deny` removes that connector's tools and rejects previously captured calls. Tools without a valid connector identity are rejected.

Tools appear in Code Mode at `tools.chatgpt.<connector>.<operation>`, for example `tools.chatgpt.sites.get_project`. See [Account connector Code Mode paths](#account-connector-code-mode-paths). Tool schemas and executable bindings are captured per model request. Profile replacement, changes to implicit profile selection, and configuration disablement invalidate captured calls. Explicit model-profile bindings remain pinned across global activation changes. Calls recheck these boundaries after permission settlement. A disabled captured connector call returns a configuration error instructing the agent not to retry that connector and to use a permitted native or local tool.

Local Sessions use native tools or the local service for YCoding operations, not YCoding's ChatGPT connectors. To enforce this in configuration, deny each installed YCoding connector's stable ID in `account_connectors.chatgpt.connectors`. A matching `permissions` deny on its registered `chatgpt_<normalized connector ID>_*` action also blocks captured permission requests. Friendly Code Mode paths are not permission-rule keys.

Account connector actions default to the `ask` permission, including externally writing actions. Explicit permission rules, inherited ceilings, saved grants, Session guardrails, and autonomy remain applicable. Tool descriptions and read-only annotations are untrusted provider data and grant no execution authority.

The client uses only YCoding's stored ChatGPT credential and existing refresh flow. It connects directly to `https://chatgpt.com/backend-api/ps/mcp` with the `Authorization` bearer and `ChatGPT-Account-Id` headers, without launching native clients, reading their credential stores, copying desktop cookies, or claiming desktop attestation. The endpoint advertises MCP revision `2026-07-28` through `server/discover` but omits that revision's required `resultType` on list results, so the client always uses the `initialize` handshake, which negotiates `2025-11-25`. Tool definitions keep their output schemas as published, including top-level `anyOf` unions; YCoding validates arguments and results against them. A confirmed HTTP 401 permits one same-profile refresh and retry. Other HTTP failures and tool failures are surfaced without account rotation or uncertain-call replay. Backend access and subscription restrictions remain authoritative.

Only tools returned by the authenticated catalog are available. Install or reconnect a connector and complete additional consent in ChatGPT. YCoding does not automatically initiate connector setup or grant consent. When catalog discovery fails, including missing profiles, required authorization, backend rejection, unsupported schemas, and listings that violate the negotiated MCP revision, that provider's tools are unavailable for the model request and the Session continues without them. The backend log records the warning `account connector tools unavailable` with the connector server (`chatgpt-account-connectors` or `claude-account-connectors`) and the failure message, never credentials. Each later model request retries discovery. Connector requests do not change model reasoning, prompt-cache policy, usage accounting, or quota reporting.

#### Native Library files

The native Library surface calls ChatGPT's first-party file APIs directly; it does not pass through the hosted MCP catalog. A hosted catalog failure does not remove these tools when their selected profile and managed attachment storage remain available.

| Code Mode operation | Input | Result |
| --- | --- | --- |
| `tools.chatgpt.library.list` | Optional `cursor`, `limit` from 1–100, and `query` | One page of file metadata and its opaque next cursor. An empty page can still have a cursor. |
| `tools.chatgpt.library.materialize` | Mounted `fileID`, `name`, optional `mimeType` | The resulting file ID. Creates a file copy without retrieval indexing. |
| `tools.chatgpt.library.download` | Library `fileID` | A verified managed attachment URI, byte count and confined local file path. |
| `tools.chatgpt.library.upload` | Managed `attachmentURI`, `name`, `mimeType` | File and Library identities after confirmed processing and persistence. |

File transfers use the existing 20 MiB managed-attachment limit. Callers cannot select an arbitrary download URL or output directory. Authentication stays on the fixed ChatGPT API origin; signed transfers reject redirects and unsupported destinations and never receive the account bearer. Upload creation, byte transfer and processing are separate phases; an uncertain write is not retried automatically. Permission actions are `chatgpt_library_list`, `chatgpt_library_materialize`, `chatgpt_library_download`, and `chatgpt_library_upload`; ordinary permission, guardrail and account-binding checks apply to each call. Account replacement or profile changes invalidate captured operations.

Successful Library listing does not establish upload or materialization eligibility. Unsupported transfer destinations and unverified processing responses fail explicitly without reporting successful persistence.

Run the provider boundary checks locally:

```sh
bun test --cwd packages/core ./test/account-connector-library.test.ts ./test/account-connectors.test.ts ./test/plugin/provider-openai.test.ts ./test/decision-agent-codex-resolve.test.ts
```

These checks use synthetic accounts and injected transports. Live file writes require an explicitly selected account and approved synthetic payload; a passing local test is not service-eligibility evidence.

### Dots profiles

Dots is disabled by default. Enable it for the Location with:

```json
{ "dots": { "enabled": true } }
```

The top-level `dots` section owns Dots configuration. Its optional `enabled` boolean defaults to false; an empty section enables nothing. The field follows normal configuration-layer precedence. While disabled, the backend rejects discovery, binding, sending and runtime controls before native authentication or network requests. Status reports `enabled: false`, Dots tools and UI entry points are hidden, and existing bindings stop receiving peer messages. Turning the feature off does not pause the external Dot. Enabling it grants no permission and selects no destination.

Destination selection lists the `openai` integration's named credential profiles. Only a ChatGPT OAuth profile with an account identity resolves; any other profile fails with `profile_unavailable`. The user selects the profile explicitly on every binding. YCoding never falls back to the active profile, the Session model profile, or another account. The binding stays pinned to that profile's exact account, and replacing the account fails the binding closed until the user confirms a destination again.

The agent's `dots_send` tool requests these checks before transmitting:

- the `dots_send` permission, with resource `<dotID>/<threadID>`;
- the `read` permission for each attached file;
- the Session `dots_send` guardrail.

The runtime-state-specific `dots_pause` and `dots_resume` tools each require their own permission and Session guardrail check. Pause stops the Dot's autonomous runtime until an explicit Resume; Resume can continue its work and goals. Ordinary permission rules, inherited ceilings, autonomy modes, and guardrails apply unchanged. `capabilities.tools` can deny `dots_send`, `dots_pause`, or `dots_resume` by name. See [Dots conversation peer](./runtime.md#dots-conversation-peer).

### Claude account connectors

`account_connectors.claude` independently enables connectors installed in a Claude account. It is off when omitted or when `enabled` is false; disabled configuration reads no Claude credentials and makes no connector requests.

```jsonc
{
  "account_connectors": {
    "claude": {
      "enabled": true,
      "profile": "personal",
      "connectors": {
        "installed-server-id": "allow",
        "blocked-server-id": "deny",
      },
    },
  },
}
```

`profile` selects an existing YCoding-managed Claude OAuth profile. When omitted, an Anthropic Session uses its selected model profile; other Sessions use the active Anthropic profile. API keys, federation credentials, and inference-only setup tokens are unsupported. The existing grant must include `user:mcp_servers`; missing scope requires reconnecting that profile, never copying another client's credentials or switching accounts.

Discovery reads `https://api.anthropic.com/v1/mcp_servers?limit=1000&include_additional_installs=true` with the `mcp-servers-2025-12-04` beta and API version `2023-06-01`. Connector policies address the returned server installation IDs, not names or upstream URLs. Omitted policies allow discovery. Denied and ineligible connectors are not connected. Tools are discovered and called only through `https://mcp-proxy.anthropic.com/v1/mcp/<encoded-server-id>`; the account credential is never forwarded to the returned upstream URL. Requests use the Claude Code client identity: discovery sends the same `claude-cli/<version> (external, sdk-cli)` user agent as Claude Code account model requests, and proxy requests send `User-Agent: claude-code/<version> (cli)`, `Accept-Encoding: identity`, and a process-stable `X-Mcp-Client-Session-Id`, which the proxy requires. `ANTHROPIC_CLI_VERSION` sets `<version>`. Incomplete catalogs requiring further account-discovery pagination are explicit failures. MCP tool discovery follows pagination and caps the combined catalog at 8,192 tools.

Tools appear in Code Mode at `tools.claude.<connector>.<operation>`, built the same way from the server's display name and tool name. Calls retain their request-local profile binding, recheck configuration and credential generation after permission review, validate input and output schemas, and use existing Session guardrails. Actions default to `ask`; explicit rules and permission ceilings still apply. Organization-blocked tools and invalid organization permission values are excluded. Organization-`ask` tools and tools marked `anthropic/requiresUserInteraction: true` require a fresh human decision on every call: saved approvals, allow rules, and every permissions mode cannot approve them. These prompts offer one-time approval or rejection. While asleep, the review box holds the decision.

### Account connector Code Mode paths

- `<connector>` is the connector's display name (ChatGPT `connector_name`, Claude `display_name`) in lowercase, with each run of characters other than letters and digits replaced by `_`, trimmed and limited to 40 characters.
- `<operation>` is the upstream tool name normalized the same way without lowercasing and limited to 56 characters. A leading `<connector>_` is dropped when a valid name remains, so the ChatGPT tool `ycoding_session_catalog` of connector `YCoding` is `tools.chatgpt.ycoding.session_catalog`.
- A connector segment that is empty, does not start with a letter, or comes from `constructor`, `prototype` or `__proto__` becomes `connector_<suffix>`; an operation segment in the same case becomes `operation_<suffix>`. `<suffix>` is the first six hex digits of the SHA-256 of the connector ID, or of the connector ID, a NUL character and the tool name.
- Connectors whose segments match, and operations of one connector whose segments match, all get `_<suffix>` appended, independent of catalog order. A segment that still matches another fails that provider's catalog with the colliding path named, and the backend log records it.
- The account and profile are not part of the path; each request binds one profile per provider.
- The path is only the Code Mode call path. Permission rules, saved approvals, `capabilities.tools` patterns and the default `chatgpt_*` and `claude_*` `ask` rules match the tool's registered name, `<provider>_<normalized connector ID>_<normalized tool name>_<12-digit hash>`, and permission resources and guardrail targets keep the connector ID and original tool name.

Authentication uses the existing managed Claude credential source and refresh implementation. Refreshed grants preserve their scopes when the response omits scope and persist explicit reductions. An unclassified HTTP 401 permits one same-profile reload or refresh and retry. A classified `X-Mcp-Error-Code` failure, entitlement rejection, or other failure never rotates accounts or replays an uncertain tool call. Install connectors and complete upstream authentication in Claude; connector setup, resource browsing, and consent initiation are not performed by this path. Account access remains subject to Anthropic's backend policy.

### Claude Code account profiles

The Anthropic integration offers **Claude Code account** as an OAuth method alongside the separate `ANTHROPIC_API_KEY` method. Claude Code account profiles require the `claude` executable on `PATH`. Start from `/connect`, the command palette's **Connect integration**, or the model selector's connect action; choose **Anthropic**, then **Claude Code account**, and name the profile. YCoding runs `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR` set to an isolated profile directory under `<YCoding data directory>/claude-code/profiles/`. The ordinary Claude CLI login and its default configuration remain separate.

The Claude CLI opens the browser; the TUI shows the authorization URL and polls the automatic sign-in attempt. If the pending attempt advertises manual code entry, press `e` and enter the code; the same attempt continues polling until it settles. In the Anthropic integration's profile menu, **Add profile** starts another sign-in, **Use <name>** activates an existing profile, and **Disconnect <name>** removes one. Reusing a profile name replaces that profile's sign-in and activates it; new names retain their own account. The first available name is `default`, and when that name is taken, the prompt offers the next unused `profile-<number>` name.

The isolated Claude CLI profile owns its OAuth credentials. On macOS, Claude Code stores credentials in a Keychain service scoped to that profile; on other platforms, the profile uses its own `.credentials.json`. YCoding does not expose the profile's internal source identifier or Keychain service name. Existing named Claude profiles remain listed, but a profile without its corresponding isolated CLI credentials requires a fresh sign-in; YCoding cannot infer separate account identities from shared CLI credentials. A missing selected profile, or expired credentials that refresh cannot restore, requires reconnect before its model request proceeds. API-key authentication remains separate and is not converted into a Claude Code account profile.

## Decisions

Standard guardrail match verification runs while the root family's guardrails mode is `yolo` and `guardrails.decide_reviews` is on (the default when omitted; explicit `false` disables). Before human review or delegated approval, a narrow strict-choice assessment (not a Boolean predicate) checks whether the action actually matches a `standard.review.*` rule's ID and reason. Command and resource text is redacted and framed as untrusted evidence, never instructions; the classifier supplies its matched segment and resolved targets separately. Comments, embedded claims, quoted/printed text, and names do not establish a non-match. Unit tests verify this framing, not a model's behavioral resistance. Dismiss only `allow` (nonmatch: the action does not perform the matched rule's behavior) at confidence ≥0.9; dismissing a standard hard match reclassifies the false positive onto the ordinary path. Refusal, errors, helper unavailability, lower confidence, and the 15-second deadline preserve the existing review path with a visible bounded reason. Ordinary reviews already auto-approved by guardrails `auto` and `skipReview` skip verification. Catastrophic denies, explicit denies, and custom rules are never verified. Reevaluate remaining rules after dismissal; retain permissions and caps. Durable dismissal provenance contains root and reviewed Session attribution, rule ID, and confidence. Status supplies the reviewed Session and event timestamp; the TUI displays and rehydrates outcomes chronologically only in that Session, keeping still-pending family requests at the tail. Surviving delegated reviews retain the separate 0.8 threshold and 60-second deadline.

Agent judgments use the `decision` tool with `provider: "agent"` and `request: { state, questions }`, within effective permissions and inherited ceilings. Questions are typed `predicate`, `choice`, `score`, or `text`; a text question takes instructions and an optional `maxLength` (1 to 8192, default 8192), and its answer adds a bounded `text` value without changing any existing answer field. Choice questions accept `grade: true` for one `{ choice, confidence, evidence }` per listed choice without a pick; default false preserves single-pick behavior. Evidence is non-whitespace and at most 500 characters, confidence is finite in `[0,1]`, and missing, duplicate, extra, or invalid grades fail validation. The runtime uses the same helper, Decision API, and authentication route for the hidden `yolo-permission`, `yolo-guardrail`, and `yolo-answer` evaluators (all tools denied) only while the matching category is effective `yolo`, and for standard-match verification while guardrails are `yolo` and `guardrails.decide_reviews` is on (the default when omitted), with redacted evidence and separate thresholds; the explicit tool depends on none of these switches. Main, child, and side-chat Sessions share its guidance. The top-level `decisions` configuration key is unsupported; helper model settings remain supported.

The selected decision model receives bounded [Session task context](./runtime.md#explicit-work-completion) automatically, including explicit `decision` tool calls. Supply request-specific facts and criteria in `state`; no separate context toggle is required. The runtime labels evidence provenance, excludes queued future work from current authority, and invalidates results when the context changes. Explicit judgments remain advisory. A `yolo` mode permits ordinary reversible choices within authorized scope, not fabricated facts, wider permissions, or substitutes for required human consent.

Unreadable or invalid guardrail configuration requires human review even if a decision model selects allow. Correct the configuration before relying on automatic assessment; model approval cannot substitute for unknown policy.

The hidden decision agent uses the selected model's regular authentication, privacy, quota, and billing route. Credentials are managed through the selected model integration and never passed as decision-tool inputs or results. Shared agent guidance directs bounded classification, option choice, grading, ranking, unverifiable predicates, and recommendations before `question`, using only authorized evidence.

Requests supply JSON state and 1–32 uniquely named `predicate`, `choice`, `score`, or `text` questions. Choices use `{ value, description }`; scores use `{ label, description }` levels with distinguishable adjacent criteria; text questions use optional `maxLength` (1 to 8192, default 8192). Batch independent questions and separate dependent ones. Verify factual claims with tests, grep, typechecks, or inventory rather than judging them. Reuse unchanged judgments and preserve explicit owner choices. See [explicit runtime judgments](./runtime.md#explicit-decision-judgments) and the [decision contract](../specs/decisions.md).

### Decision agent

The hidden primary `decision` agent evaluates JSON state and bounded questions without execution tools. Its ID is reserved for the decision tool, not foreground Session or command selection. Baseline and advisory judgments select `agents.decision.model`, then `efficiency.helper_models.decision`, then the owner Session/default model. A helper value of `"session"` selects the owner model unless an agent pin takes precedence.

YOLO judgments first select the matching `agents.yolo-permission.model`, `agents.yolo-guardrail.model`, or `agents.yolo-answer.model`. Their bounded recovery chain then considers `agents.decision.model`, an explicit `efficiency.helper_models.decision`, and the owner Session/default model. Exact model references are deduplicated with their variants and profiles intact. An unavailable profile is never replaced with another account. The chain does not enumerate connected models or consume the Session-Step `model_fallbacks` setting. Explicit helper pins remain independent of main-model switches.

Without an agent pin or explicit helper model, each evaluation reads the current owner Session model. Subsequent Session-model changes apply to subsequent evaluations. Before the Session selects a model, normal default-model resolution applies. Unsupported inherited routes retain a typed failure and human review; they do not imply approval or select an unrelated model.

| Key                                 | Selection                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `efficiency.helper_models.decision` | Shared helper override, or `"session"` for inheritance; omission also inherits. |
| `agents.decision.model`             | Ordinary decision-agent pin, ahead of the shared helper override.               |
| `agents.yolo-permission.model`      | Highest-priority pin for YOLO permission judgments.                             |
| `agents.yolo-guardrail.model`       | Highest-priority pin for YOLO guardrail judgments.                              |
| `agents.yolo-answer.model`          | Highest-priority pin for YOLO question and form judgments.                      |

Select an explicit shared helper:

```jsonc
{
  "efficiency": {
    "helper_models": { "decision": "openai/gpt-6.1-sol" },
  },
}
```

Model selections also accept `{ "providerID": "openai", "model": "gpt-6.1-sol", "profile": "Work" }`. The short form `"Work#openai/gpt-6.1-sol"` selects the same named profile; append `#<variant>` to select an advertised variant. The named profile must exist for that provider.

The implemented adapter requests schema-constrained generation and validates the complete typed result locally. Admitted native routes are OpenAI Responses HTTP/WebSocket, OpenAI Chat, Anthropic Messages, and ChatGPT Codex HTTP (`openai-codex-responses`). Codex WebSocket and unverified compatibility/AI SDK bridge routes remain unsupported. Adapter support establishes the encoded request shape, not support by every endpoint or model using that protocol. A provider rejection remains a typed failure. The selected model's existing authentication, privacy, quotas, and pricing apply; local Session history and results remain durable.

Retain the owner Session model for the helper:

```jsonc
{
  "efficiency": { "helper_models": { "decision": "session" } },
}
```

Confidence is self-reported and uncalibrated. Every question type can abstain for insufficient evidence: the helper returns `type: refusal`, null `answer`, `choice`, and `score`, and confidence `0`. Refusal is distinct from a real option or low-confidence pick. The tool preserves that structured result and adds a model-visible explanation to gather missing evidence or ask the user. Set the action threshold by the cost of being wrong; treat refusal, errors, low or close confidence, and disagreement with evidence as uncertainty. Judgments never grant permission, supply the user's answer, or prove completion.

Advisory evaluations make at most two provider attempts on their selected route. YOLO evaluations make at most three provider attempts across the configured recovery chain, with at most two on one candidate. Both share a 60-second total deadline covering model-key preflight, resolution, attempts, joined waits, and cache rechecks, with a 25-second per-attempt limit; standard-match verification retains its 15-second outer deadline. Unavailable or unsupported candidates consume no provider attempt. Malformed or truncated output, timeouts, and eligible transient failures can recover within those bounds. Invalid-output repair adds a fixed schema reminder without replaying the malformed text. Refusal, authentication failure, invalid input, non-retryable provider failures, and interruption do not trigger route hopping. Exhaustion returns a typed failure for human handoff, not a fabricated answer.

The initial output limit is 4,096 tokens; truncation can raise it to 8,192 within the model's output limit. Input and output are each bounded to 1 MiB. Every dispatched attempt settles its usage ledger; reported usage is aggregated across candidates. YOLO results are checked against current inherited autonomy before application, including revocation followed by restoration. Permission assessment also rechecks current denies and ceilings. Recovery changes neither automatic toggles nor mandatory human approval for genuine hard reviews.

Schema-invalid calls return tool errors identifying the field path, expected shape/allowed values, and a minimal valid request without echoing evidence or secrets. Empty questions explicitly request one bounded question or skipping the tool. Settled errors distinguish unavailable models, invalid requests, oversized input, provider failure, timeout, invalid or truncated output, refusal, and unsupported structured output. Guardrail handoffs retain the reason without inventing a choice or confidence. A caller must not retry an unchanged failed judgment automatically. See the [decision contract](../specs/decisions.md#decision-agent-inputs).

### Muse (Meta)

The builtin `muse` provider supports a **Meta Muse Code account** or a **Meta Model API key**. Run `ycoding`, open `/connect`, choose **Muse (Meta)**, and name the profile:

- **Meta Muse Code account** starts Meta's OAuth device flow. Open the displayed verification URL and enter the code; YCoding polls until authorization succeeds, is denied, or expires. Access tokens and optional refresh tokens stay in YCoding's credential store.
- **Meta Model API key** stores a direct key; alternatively set `META_API_KEY` in the server process environment. Direct keys use `https://api.meta.ai/v1` and skip account key minting.

For an account, YCoding lazily mints an inference key with `POST https://api.meta.ai/muse-code/key` using the Meta access token and `{"onboard":false}`. A response requiring payment or reporting an inactive subscription fails with a subscription/payment setup message and the action URL when supplied. The key and returned base URL are cached only in memory for that credential ID and generation. An inference HTTP 401 remints once and retries once; a second rejection requires re-login. Direct-key requests do not remint.

Model discovery reads `GET <origin of base URL>/muse-code/models` on connection startup or change and reconciles stored credentials every minute. Model data comes from each row's `metadata["muse-code"]`: names use `name` when present, otherwise the row's `id`, release dates use `release_date`, and input/output capabilities use `modalities`. Hidden models, non-tool models, models without text output, and rows without integer `limit.context` and `limit.output` are skipped with a warning; limits are never inferred. Failed discovery retains only the same account's existing inventory and retries on reconciliation. Effort choices follow the catalog's `variants` keys in catalog order, including `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` when advertised. Each variant sends its catalog `reasoningEffort`; the default effort comes from `options.reasoningEffort` and is omitted when absent. Catalog temperature and top-p hints are not sent.

Inference uses streaming OpenAI Responses with `store: false`, encrypted reasoning, automatic reasoning summaries, full-input replay, and YCoding's Session-scoped prompt cache key. Requests carry `x-client-id: tbh:exec` and matching Muse session UUID headers; the SDK hook has no Session identity, so those headers use one process-stable UUID. Provider thoughts remain reasoning in the transcript. Commentary message phases, function tool calls, cached-input usage, and reasoning-token usage use the Responses adapter. Trailing `response.subscription_usage` events update subscription quota without changing inference bytes: the reported window duration supplies its label (300 minutes is a **5-hour window**), alongside **Weekly** usage and reset times. These snapshots have source `response_stream` and stability `observed`; they are isolated per credential profile, while environment-key observations remain unbound.

Limits: account token refresh is unsupported. Tokens with a reported expiry, or tokens rejected by Meta, require re-login through `/connect` → **Muse (Meta)**. When authorization reports no expiry, YCoding stores expiry as unknown. Minted key lifetime is unknown; YCoding relies on the bounded HTTP 401 remint rather than a guessed expiry. Model cost is unreported. Subscription quota is unreported until an inference response supplies it and is retained only in memory; account-bound observations are shared across Locations on the same backend, while environment-key observations stay Location-local. A quota read never mints a key or calls a separate usage endpoint. The quota view keeps Muse visible before its first observation with a next-response message and no numeric quota. Missing metrics stay absent rather than becoming zero; catalog rows do not establish pricing or remaining usage.

### Antigravity

The builtin `antigravity` provider runs models from a Google account's Antigravity subscription through Antigravity's Cloud Code gateway, presenting the Antigravity Hub client identity (`antigravity/hub/2.26.0`). Use it only with a Google account you own; Google may change or restrict that gateway without notice. Set the nonempty `YCODING_ANTIGRAVITY_CLIENT_ID` and `YCODING_ANTIGRAVITY_CLIENT_SECRET` environment variables on the local server process, using a Google OAuth client authorized for that gateway. The values are read at runtime, not embedded in source or release binaries, and builds do not require them. GitHub Actions secrets are available only to jobs that explicitly consume them; installed clients require their own runtime environment. Restart the local server after changing its environment. Then run `ycoding`, open `/connect`, choose **Antigravity**, and name the profile:

- **Google account (Antigravity subscription)** starts Google's OAuth flow with the configured client, PKCE (S256), offline access, and the `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, and `experimentsandconfigs` scopes. The browser returns to a one-time listener on `http://localhost:51121/oauth-callback`. Missing or empty client configuration rejects sign-in before opening the listener and rejects token refresh before an HTTP request. Access and refresh tokens stay in YCoding's credential store, and YCoding refreshes the access token before expiry.

After sign-in, YCoding resolves the account's managed project with `POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` (`metadata.ideType` is `ANTIGRAVITY`), onboarding the default allowed tier with `v1internal:onboardUser` when no project exists yet. The project ID is stored in the credential's metadata and rediscovered on startup when absent. Model discovery reads `v1internal:fetchAvailableModels` on connection startup or change and reconciles stored credentials every minute. Display names use `displayName`, context limits use `maxTokens`, output limits use `maxOutputTokens` when reported (otherwise 8,192), and image, video, and PDF input follow `supportsImages`, `supportsVideo`, and `supportsPdf`. Effort-specific entries that share a base model, such as `gemini-4-argon-low`, `gemini-4-argon-medium`, and `gemini-4-argon-high`, pivot into one catalog model (`gemini-4-argon`, displayed as Gemini 4 Argon) whose effort variants (`low`, `medium`, `high`, plus `minimal` or `max` when advertised) each carry that entry's gateway model ID and thinking configuration; select the model once and switch effort with the variant control. The pivoted model without a variant runs the advertised `medium` entry when present, otherwise the nearest advertised entry in `high`, `low`, `max`, `minimal` order, or the unsuffixed gateway entry when one is advertised. A single effort-specific entry with no sibling or unsuffixed entry keeps its gateway ID and display name as its own model. Thinking models request thought output and use the gateway's reported `thinkingLevel` (1 = low, 2 = medium, 3 = high, 4 = minimal), or its `thinkingBudget` when no supported level is reported. A model without either value keeps the gateway's thinking default. Every advertised model is listed, including image-output models (marked with image output and no tool support); entries the gateway reports as disabled or internal, and model IDs listed in `deprecatedModelIds`, are skipped. A model without a reported context limit keeps an unreported (0) context limit; limits are never inferred beyond the stated output fallback. Failed discovery retains only the same account's existing inventory.

Inference uses the Gemini request format wrapped in the gateway envelope (`project`, `model`, `userAgent: antigravity`, `requestType: agent`, and a per-request `requestId`) against `v1internal:streamGenerateContent` or `v1internal:generateContent`; a selected effort variant routes the envelope `model` to that variant's gateway model ID, and trailing model-role contents are stripped so a request never ends on a model turn; the gateway's `{ response, traceId }` envelope is unwrapped before the Gemini adapter parses the stream, so tool calls, thought parts, and usage metadata keep the Gemini adapter's semantics. Requests carry the account bearer token and the Antigravity Hub user agent; no API key header is sent.

Streaming decodes complete SSE events before unwrapping the gateway response, including multiline data and fragmented UTF-8 input. Thinking parts, assistant text, tool-call signatures, and usage fields remain in their original response order. Cancelling the response closes its source stream; read failures remain failures.

The Google SDK omits empty reasoning parts during history encoding. A reasoning block containing only a signature cannot be replayed on this route; signatures are not moved onto unrelated text or tool-call blocks.

Prompt reuse is gateway-controlled. Keep initial instructions, tool definitions, and chronological history stable; YCoding adds no Anthropic cache markers, OpenAI cache controls, or cache-retention guarantees to Antigravity requests. Reported `cachedContentTokenCount` is retained as cached input usage, including an explicit zero; an omitted count remains unreported rather than becoming a cache miss. A cache hit does not establish that a response contains an answer; empty-response validation and bounded text-only recovery remain enabled.

Subscription quota appears in the TUI and web Usage views with source `provider_internal_api` and stability `client_contract`: each model's `quotaInfo.remainingFraction` becomes a percent-used window labelled with the model's display name, with `quotaInfo.resetTime` as its reset. Models without a reported fraction have no window; missing values stay unreported rather than becoming zero. A quota refresh only reads `fetchAvailableModels` with the stored credential; it never sends a model request. Limits: model cost is unreported, quota windows are per model rather than account-wide, and the gateway host is fixed to the daily Cloud Code host.

### Cursor

The `cursor` provider runs models from a Cursor subscription through YCoding's native Cursor client, which speaks Cursor's private Connect-RPC agent protocol with a CLI-shaped client identity. Use it only with a Cursor account you own; Cursor may change or restrict that protocol without notice.

Connect it with `ycoding auth login` (or `/connect`) and choose **Cursor**:

- **Cursor account (browser login)** opens Cursor's PKCE sign-in page and stores the returned access and refresh tokens; YCoding refreshes the access token within five minutes of its expiry.
- **Cursor API key (crsr\_…)** stores a key from cursor.com settings; the package exchanges it for an access token and refreshes that token itself.
- `CURSOR_API_KEY` in the environment is used as a connection without storing it.

Credentials stay in YCoding's integration store; YCoding never writes them to Protocol, events, or logs. Model discovery, the model cache (`cursor-models.json`), Cursor project metadata (`projects/<slug>/`), and 24-hour conversation snapshots (`cursor-conversations/`) live under `$XDG_CACHE_HOME/ycoding/cursor`.

The Cursor request context reads project `.ycoding` configuration up to the filesystem root and YCoding's global configuration, including `ycoding.json` and `ycoding.jsonc`. It can discover `.claude/skills` and `.agents/skills` from the project ancestry and home directory, but sends only skill paths and descriptions in provider context: activated skill content still comes from the Session's instructions. This filesystem collector does not see inline or explicit `YCODING_CONFIG` sources or Location-scoped configuration overrides, so those sources may not appear in provider-side resource hints. Cursor's project metadata stays in YCoding's cache, not in the repository. These context sources do not grant tool authority or replace the Session's Location.

The Cursor adapter appends a stable SYSTEM instruction after the existing system content: identify as an AI agent rather than Cursor, follow user instructions within higher-priority instructions, permissions and guardrails, and use only declared tools and MCP capabilities. It requires task-relevant authorized use before claiming a declared capability is unavailable, distinguishes permission denial from unavailability, and prohibits unrelated probes, repeated denied actions and invented capabilities. This supplement applies only to the Cursor provider package; it does not change durable Session instructions, tool discovery or permissions.

YCoding discovers the account's models when the connection starts or changes, and reconciles the stored connection every minute, so a connection made by another YCoding process is picked up without restarting. A failed discovery keeps the models already published and is retried by the next reconcile; with no usable connection, or after failed discovery with no cached list and nothing published yet, the provider has no models. Each advertised context size is a distinct catalog model: the base size uses `<model>`, and alternatives use a size suffix such as `<model>-500k` or `<model>-1m`. When Cursor offers effort choices, their IDs are `low`, `medium`, `high`, or `xhigh`; selecting one sends its full source-offered parameter tuple, including context size. A single non-effort tuple is the model's setting rather than an extra picker choice. Fast tuples use a separate `<model>-fast` entry, with a distinct cost only when Cursor publishes one. Base entries use Cursor's advertised context (200,000 when unpublished, 256,000 for `default`) and a 32,000 output limit; 1M entries use a 128,000 output limit. An explicitly saved old variant label that is not offered remains unavailable until the user selects a current choice; YCoding does not silently remap it. Image input is advertised only when Cursor's model list reports image support. Costs are the package's published Cursor token rates; they are local estimates, not Cursor billing.

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
          "limit": { "context": 32768, "output": 4096 },
        },
      },
    },
  },
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
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
        },
      },
    },
  },
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

Location file monitoring becomes ready after its applicable workspace and Git-directory subscriptions have acquired their watchers and registered consumers. Watcher startup retains the native-subscription timeout and fallback behavior; disabled monitoring does not block Location initialization.

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

`guardrails.max_pending_reviews` applies to newly deferred Form, Question, permission, child-question, and guardrail items across the root family. Sleep-entry conversion and managed-child restart recovery holds are exempt from the cap (so they may exceed it) and sleep-entry conversion isolates producer failures. Required free-text fields defer unless answers `auto` supplies a valid explicit default or the YOLO answer evaluator generates text passing typed bounded validation. Human review decisions do not wake the family; invalid answers and already-settled items preserve their existing validation/conflict errors. Open items remain unfinished work after wake, and a committed revert withdraws affected items and unused grants with replayable notices.

`guardrails` controls the Location-scoped root-Session-family safety service:

```jsonc
{
  "guardrails": {
    "enabled": true,
    "decide_reviews": true,
    "decide_hard_reviews": true,
    "max_concurrent_shells": 8,
    "shell_wait_seconds": 60,
    "max_concurrent_subagents": 8,
    "max_pending_reviews": 16,
  },
}
```

| Field                                 | Exact type       | Default             | Operational remark                                                                                                                                                                                                                                               |
| ------------------------------------- | ---------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guardrails.enabled`                  | boolean          | `true`              | Enables the guardrail service; no configuration or approval reply overrides a standard catastrophic deny.                                                                                                                                                        |
| `guardrails.decide_reviews`           | boolean          | `true` when omitted | Enables standard-match verification while guardrails are `yolo`. Explicit `false` disables it; the deterministic match stands.                                                                          |
| `guardrails.decide_hard_reviews`      | boolean          | `true`              | While guardrails are `yolo`, permits hard-review grading; false sends hard reviews to humans awake or the review box asleep, with no hard-match model assessment including standard-match verification. Ordinary standard verification requires `decide_reviews`. |
| `guardrails.max_concurrent_shells`    | positive integer | `8`                 | Running-shell cap per root Session family, including background shells.                                                                                                                                                                                          |
| `guardrails.shell_wait_seconds`       | positive integer | `60`                | How long a shell over the cap waits, first come first served, before failing with the limit.                                                                                                                                                                     |
| `guardrails.max_concurrent_subagents` | positive integer | `8`                 | Running-subagent cap per root Session family.                                                                                                                                                                                                                    |
| `guardrails.max_pending_reviews`      | positive integer | `16`                | Cap on pending live reviews plus open review-box items of every kind per root Session family. Sleep-entry conversion and restart recovery holds are exempt.                                                                                                      |

Temporary-path exemptions apply only to outside-repository scope. Deny filesystem-root, exact user-home, and system-directory deletion. Require hard review for project/ancestor and direct home-child deletion, destructive Git, force push, and destructive database statements. Destructive Git and force-push rules match each command of a compound command separately, including Git directory options; flags of another command, such as a later `rm -f`, never count toward a Git command. Require ordinary review for outside-repository mutations. Reviews follow the guardrails mode, YOLO evaluator, graded delegation, and hard-review configuration rules above. Exempt every checkout of this repository sharing its Git common directory, temporary roots, recognized read-only shell commands (including `cd`, `exit`, `ps`, `pgrep`, `lsof`), read-only compound segments without outside redirection, and YCoding's global config/data/cache/state/tmp/bin/log/repos descendants from ordinary review. Treat interpreter script arguments and non-shell heredoc bodies as executed code, not outside operands; a non-exempt outside working directory still requires review. Effective `external_directory: allow` paths use the same directory-glob and `~` expansion as permissions; `ask` and `deny` do not otherwise exempt them. Mixed non-exempt targets stay reviewed. These exemptions never weaken hard reviews or denies. Publication, production deployment, security-policy changes, and MCP execution have no standard guardrail rule.

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

| Field path                                                         | Exact type or closed values                       | Default               | Operational remark                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme.name`                                                       | string                                            | unset                 | Discovered theme ID: a built-in such as `ycoding`, `one-dark`, `one-dark-pro`, or `high-contrast`, or a custom theme file. A standalone theme that omits `text.separator`, `text.hint`, or `text.label` reads them as its own `text.subdued`; an unreadable custom theme file is skipped without affecting the others. |
| `theme.mode`                                                       | `system` \| `dark` \| `light`                     | unset                 | `system` follows the terminal.                                                                                                                                                                                                                                                                                         |
| `keybinds.<command>`                                               | key-sequence override                             | unset                 | The supported command names and default bindings are owned by `packages/tui/src/config/keybind.ts`.                                                                                                                                                                                                                    |
| `plugins[]`                                                        | string \| `{ package: string, options?: record }` | unset                 | TUI-side plugin directives, separate from Core runtime plugins.                                                                                                                                                                                                                                                        |
| `leader.timeout`                                                   | positive integer milliseconds                     | `2000`                | Wait time after the leader key.                                                                                                                                                                                                                                                                                        |
| `scroll.speed`                                                     | number `>= 0.001`                                 | unset                 | Distance per scroll-input tick.                                                                                                                                                                                                                                                                                        |
| `scroll.acceleration`                                              | boolean                                           | unset                 | Repeated-input acceleration.                                                                                                                                                                                                                                                                                           |
| `attention.enabled`, `.notifications`, `.sound`                    | boolean                                           | `true`                | Master alerts, system notifications, and attention sound.                                                                                                                                                                                                                                                              |
| `attention.volume`                                                 | number `0..1`                                     | `0.4`                 | Attention-sound volume.                                                                                                                                                                                                                                                                                                |
| `attention.sound_pack`                                             | string                                            | `ycoding.default`     | Active sound-pack ID.                                                                                                                                                                                                                                                                                                  |
| `attention.sounds.<event>`                                         | string                                            | unset                 | Event is `default`, `question`, `permission`, `error`, `done`, or `subagent_done`.                                                                                                                                                                                                                                     |
| `diffs.wrap`                                                       | `word` \| `none`                                  | unset                 | Diff line wrapping.                                                                                                                                                                                                                                                                                                    |
| `diffs.tree`, `.single`                                            | boolean                                           | unset                 | File-tree visibility and single-patch view.                                                                                                                                                                                                                                                                            |
| `diffs.view`                                                       | `auto` \| `split` \| `unified`                    | unset                 | `auto` selects from terminal width.                                                                                                                                                                                                                                                                                    |
| `terminal.title`                                                   | boolean                                           | unset                 | Terminal title updates.                                                                                                                                                                                                                                                                                                |
| `terminal.copy_on_select`                                          | boolean                                           | `true` except Windows | Copy a dialog's mouse selection when it is released; main screens require an explicit copy action.                                                                                                                                                                                                                     |
| `prompt.editor`                                                    | boolean                                           | unset                 | Adds active editor file or selection to prompt context.                                                                                                                                                                                                                                                                |
| `prompt.paste`                                                     | `compact` \| `full`                               | unset                 | Large-paste presentation.                                                                                                                                                                                                                                                                                              |
| `session.sidebar`                                                  | `auto` \| `hide`                                  | unset                 | `auto` shows the sidebar when width permits.                                                                                                                                                                                                                                                                           |
| `session.scrollbar`                                                | boolean                                           | unset                 | Transcript scrollbar.                                                                                                                                                                                                                                                                                                  |
| `session.thinking`                                                 | `show` \| `hide`                                  | unset                 | Default reasoning visibility.                                                                                                                                                                                                                                                                                          |
| `session.grouping`                                                 | `auto` \| `none`                                  | unset                 | Related transcript-item grouping.                                                                                                                                                                                                                                                                                      |
| `hints.onboarding`, `debug.devtools`, `debug.timing`, `animations` | boolean                                           | unset                 | Guidance, diagnostics, and animation switches.                                                                                                                                                                                                                                                                         |
| `mouse`                                                            | boolean                                           | `true`                | Terminal mouse capture.                                                                                                                                                                                                                                                                                                |

Attention sound names are `default`, `question`, `permission`, `error`, `done`, and `subagent_done`. System notifications for attention events are requested while the terminal is blurred or before it has reported its focus, and are suppressed while it is known to be focused; delivery also depends on the terminal's notification support and the operating system's notification settings for that terminal.

`terminal.copy_on_select` controls copy-on-select in dialogs. When enabled (the default except on Windows), releasing a dialog's mouse selection copies it. Main screens, including the transcript, always require an explicit copy action regardless of this setting. Use `Ctrl+C` on every supported platform or `Cmd+C` on macOS to copy a selection, and press `Esc` to clear it. Selection copy consumes `Ctrl+C` and cannot exit the application. Without a selection, `Ctrl+C` keeps its prompt behavior and requires two presses to exit from an empty prompt; `Esc` never exits YCoding.

`keybinds` is a record of command names to key sequences. The complete current key map lives in `packages/tui/src/config/keybind.ts`; that file is authoritative when bindings are added or renamed.

`session_find` opens Find in loaded history in the current Session. Its default is `ctrl+shift+g`; set `keybinds.session_find` in `cli.json` to override it. The command palette also provides **Find in loaded history**.

`keybinds.session_task_pin_toggle` defaults to `p` and pins or unpins the selected child task while the TUI Subagents composer list is focused.

The TUI `plugins` array has the same string or `{ package, options }` shape, but it configures terminal-side plugins rather than Core runtime plugins.

Built-in TUI selectors settle before optional plugin loading; see [terminal plugin ordering](./repository-resources.md#ordered-enablement-and-removal). Optional plugins do not delay the Home or Session shell. Status lists their loading and failure states.

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

One managed service owns a file-backed database at a time, across installation channels and ports. The `latest`, `beta`, and `prod` channels share `ycoding.db`, so only one of their managed services runs at once. Before unsupported-database recovery and application startup, the service acquires an OS process lock at `<database>.service.lock`; a contender whose database is already owned exits without replacing the active service. The lock is released when the owning process exits. In-memory databases are not locked.

Database initialization adds a partial index for Session IDs whose autonomy goal status is `active`. Its migration preserves existing Session, message, and event records and does not change the database format.

The matching registration file is stored in the YCoding state directory. It contains the service instance ID, version, URL, PID, and private password. Do not hand-edit a live registration file.

Managed-service startup checks readiness more frequently during its initial wait, then uses a slower polling cadence. Polling delays are capped by the remaining startup wait and do not shorten the backoff between server spawn attempts. Both Effect and Promise clients return only a healthy, compatible service in the `ready` state.

## Chrome extension connection

The landing command palette also offers **Connect Chrome**. It scopes the connection to a Session in the current Location, creating an idle Session only when none is available.

The **Connect Chrome** command in both the Mini and full Session palettes displays the connected loopback service address and current pairing state. A paired but disconnected extension is reported as **Paired; waiting for Chrome to reconnect** and does not offer another pairing code. Use **f** to explicitly forget the saved trust; when unpaired, **p** creates a one-time code. The full dialog keeps a generated code visible through status polls and **r** refreshes until the code is used or expires. The dialog also shows the extension folder to load unpacked: `ycoding-chrome-extension` beside the installed executable, or `extensions/chrome` in a source checkout. Enter the code in the extension's popup. The popup uses `http://127.0.0.1:4096` by default; if the view shows another address, enter it once under **Local service address**. The extension remembers the address and reconnect credential, so pairing does not require the initiating Session to remain active. Pairing authorizes eligible existing and future tabs in that Chrome profile, including the active tab. The manifest requests `tabs`, `tabGroups`, `alarms`, `debugger`, and `storage`, with host access limited to loopback. Omitted browser mode uses the paired profile; `mode: "owned"` opens Session-owned background tabs. Model-driven profile reads require site permissions without a standard access review; mutations require site permissions, and group changes also require control permission. Owned-tab open requires target-site permissions. Approved site actions may cause incidental downloads; explicit download/upload access is not configured. See [Chrome browser bridge](./browser-extension.md) for ownership, badges, and safety limits.

The popup shows **Local service address**, **Pairing code**, and **Connect YCoding** only before pairing. It then shows a connection indicator, with **Forget pairing** to revoke browser access. A temporary outage retains the pairing and retries without another code, including after Chrome startup or YCoding service restart; an explicit stop leaves it paused until **Retry connection** is chosen. The popup supports light and dark themes.

## Isolated browser availability

Temporary headless browsing is started explicitly from the current Session's **Isolated browser** command, not by enabling a config key. The implementation requires macOS arm64 and installed Google Chrome major 152 or newer in its standard application location. It does not install Chrome, accept an arbitrary executable or debugging endpoint, or reuse a personal profile. Unsupported environments report unavailable; matching the version does not bypass startup capability checks.

The URL must use HTTP or HTTPS without embedded credentials. Stop the paired Chrome bridge before starting isolated mode, or stop isolated mode before creating extension pairing. Browser permissions and Session guardrails still govern model actions. See the [isolated-browser contract](../specs/isolated-browser.md) for temporary-state semantics, restrictions, and environment-specific validation evidence and limits.

## Session retention

```json
{
  "session_retention": {
    "days": 7,
    "records_days": 7
  }
}
```

| Key                              | Type             | Default | Effect                                                                                                                                           |
| -------------------------------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_retention.days`         | positive integer | `7`     | Delete a root Session family once every member has been idle for longer than this many days.                                                     |
| `session_retention.records_days` | positive integer | `7`     | Remove Session-owned provider-request, usage, file-change and context-exclusion records after this idle period; skip locally executing Sessions. |

`session_retention` is global-only: the server reads it from the global configuration directory, `YCODING_CONFIG`, and `YCODING_CONFIG_CONTENT`, and ignores it in project configuration, because one SQLite database serves every project. Retention is read when a sweep runs; the first sweep loads it in the background. See [automatic Session retention](./runtime.md#automatic-session-retention) for family scope, exemptions, scheduling, and the cross-process limitation.

`records_days` does not change whole-family deletion under `days` or analytics retention. Exactly the configured idle interval remains retained; cleanup applies only after that boundary. Resuming after record cleanup preserves available ordinary transcript content but cannot replay deleted provider reasoning/tool state or recover expired captured-change and context-exclusion records from analytics. Both keys require integers greater than zero.

## Analytics retention

```json
{
  "analytics_retention": {
    "usage_days": 30,
    "latency_days": 30,
    "incident_days": 30
  }
}
```

| Key                                 | Type             | Default | Effect                                                                                                                  |
| ----------------------------------- | ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `analytics_retention.usage_days`    | positive integer | `30`    | Retain usage analytics by request creation time independently of Session deletion and activity.                         |
| `analytics_retention.latency_days`  | positive integer | `30`    | Retain machine-local latency samples by server receipt time, subject to the existing 10,000-row cap.                    |
| `analytics_retention.incident_days` | positive integer | `30`    | Retain [model incidents](./runtime.md#model-incidents) by incident time independently of Session deletion and activity. |

These keys are global-only and use the global configuration directory, `YCODING_CONFIG`, and `YCODING_CONFIG_CONTENT`; project configuration cannot change them. Each sweep reads current global values. Exactly the configured period remains retained; older facts are eligible for cleanup. Values must be integers greater than zero. Usage and incident cleanup run at startup and hourly in bounded, yielding batches; latency cleanup keeps its startup/read/write/hourly schedule. Provider quota observations remain bounded process-local history and are not persisted by either setting.

## Question lifetime

Required-answer questions, Forms, and task-backed child questions have no elapsed-time expiry or configuration knob. They remain pending until answered, explicitly cancelled, or invalidated by their owning lifecycle. The Session's effective answers mode governs automatic answers; time enables neither and approves no permission or guardrail request.

Ordinary Forms and Question-service requests are process-local and are not restored after a server restart. Task-backed child questions preserve their durable waiting state. See [question and Form lifetime](./runtime.md#question-and-form-lifetime) for lifecycle and restart constraints.

## Automatic SQLite space reclamation

Database initialization automatically converts `auto_vacuum=NONE` databases to `INCREMENTAL` using a one-time SQLite `VACUUM`. Later initializations reclaim at most 256 free pages without rebuilding the database. An existing `FULL` auto-vacuum setting is preserved. Each initialization then runs `PRAGMA optimize=0x10002`. These operations reclaim unused pages and refresh query-planner statistics; they do not delete records. Pruning of compacted history and settled executions (see [automatic Session retention](./runtime.md#automatic-session-retention) and [settled execution pruning](./runtime.md#settled-execution-pruning)) triggers the same bounded incremental reclaim.

After a [Session retention](#session-retention) sweep deletes any Session, the server reclaims every free page in bounded `PRAGMA incremental_vacuum(32)` batches, yielding between batches, so no single write transaction holds the database lock for long. Each hourly sweep runs `PRAGMA optimize`.

The initial conversion requires a write lock and may need temporary free disk space up to twice the database size. It can delay startup. If SQLite cannot obtain the lock within the five-second busy timeout, or the conversion fails, startup fails rather than silently skipping conversion; existing records remain intact and the next start retries. Keep a backup before upgrading a large database and close other writers during the first start.

## Pruning backup

Session history pruning has no configuration key. Before its first pass that would delete anything, the server writes a one-time copy of the database beside it as `<database>.pre-prune-backup`, for example `~/.local/share/ycoding/ycoding.db.pre-prune-backup`, using `VACUUM INTO` and verifying it with `PRAGMA quick_check` before recording it. The copy is a compacted, standalone database file and needs free space in the database directory of at least the database size plus 1 GiB. With less free space, the server prunes nothing, logs one warning, and shows a warning toast at most once an hour until enough space is available. The copy runs on a worker thread, so the server keeps serving requests while it copies; pruning waits until the copy is complete and verified.

Pruning is irreversible except through this backup, which also loses every change made after it was taken. To restore it, stop every YCoding process, replace the database file with the backup, and delete the database's `-wal` and `-shm` files. Delete the backup file with `rm` once it is no longer needed; the server records that it took the backup and never recreates it. See [pruning backup](./runtime.md#pruning-backup).

## Runtime environment variables

Stable operator-facing variables:

| Variable                         | Effect                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `YCODING_CONFIG`                 | Explicit runtime config file.                                                 |
| `YCODING_CONFIG_CONTENT`         | Highest-priority inline runtime config.                                       |
| `YCODING_CONFIG_DIR`             | Override global configuration directory.                                      |
| `YCODING_CONFIG_PROJECT_DISABLE` | Disable project config discovery.                                             |
| `YCODING_DISABLE_PROJECT_CONFIG` | Alias for disabling project config discovery.                                 |
| `YCODING_PASSWORD`               | Password for an explicitly connected or standalone server.                    |
| `YCODING_SERVER_PASSWORD`        | Server-password alias.                                                        |
| `YCODING_DB`                     | Override database path.                                                       |
| `YCODING_MODELS_URL`             | Override model catalog URL.                                                   |
| `YCODING_MODELS_PATH`            | Read model catalog from a local file.                                         |
| `YCODING_DISABLE_MODELS_FETCH`   | Disable model-catalog network refresh.                                        |
| `YCODING_ANTIGRAVITY_CLIENT_ID` | Google OAuth client ID required for local Antigravity sign-in and token refresh. |
| `YCODING_ANTIGRAVITY_CLIENT_SECRET` | Google OAuth client secret required for local Antigravity sign-in and token refresh. |
| `YCODING_DISABLE_AUTOUPDATE`     | Disable update checks.                                                        |
| `YCODING_LOG_LEVEL`              | Logging threshold.                                                            |
| `YCODING_PRINT_LOGS`             | Print logs to the terminal.                                                   |
| `YCODING_CLIENT`                 | Client identity reported by the process.                                      |
| `YCODING_SIMULATE`               | Enable simulation backend behavior.                                           |
| `YCODING_GIT_BASH_PATH`          | Windows Git Bash path.                                                        |
| `YCODING_FILEWATCHER_DISABLE`    | Disable filesystem watcher.                                                   |
| `YCODING_DISABLE_FILEWATCHER`    | Alternate filesystem-watcher disable switch.                                  |
| `YCODING_DISABLE_FFF`            | Disable the FFF filesystem backend.                                           |
| `YCODING_WEBSEARCH_PROVIDER`     | Select web-search provider unless `capabilities.websearch_provider` pins one. |
| `YCODING_TERMINAL`               | Override terminal identity used by shell and PTY behavior.                    |
| `YCODING_REMOTE_URL`             | Relay origin used by the `ycoding remote` commands.                           |

Build, packaging, test, and internal diagnostic variables are not stable end-user configuration. Examples include `YCODING_VERSION`, `YCODING_CHANNEL`, native-library paths, Drive simulation variables, and the internal managed-service startup-error file.

`YCODING_REMOTE_URL` is a relay origin: HTTPS only, except that plain HTTP is accepted for `localhost`, `127.0.0.1`, and `[::1]` development. It must not carry credentials, a query, a fragment, or a path. A `--relay` flag takes precedence over the environment, which takes precedence over the origin stored by `ycoding remote enroll`. Device credentials are bound to the enrolled origin, so an override that changes the origin is refused before any credential is sent.

## Reload behavior

YCoding watches runtime configuration directories and explicit files. Changes are debounced by 100 ms and publish `config.updated`.

Agent, command, plugin, and skill files inside watched `.ycoding` or global config directories reload even when the JSON document list itself is unchanged.

Ecosystem skill roots such as `~/.claude/skills` and `~/.agents/skills` are not watched. Skill files are re-read whenever skills are listed so edits and deletions are still reflected.

Project `ycoding.json`, `ycoding.jsonc`, and `.ycoding` entries are watched only when they existed at the last discovery, so one created afterwards is not detected automatically. The TUI command palette's **Refresh models and providers** command calls `POST /api/provider/refresh` for the current Location. The server rediscovers every configuration source, publishes `config.updated` even when the document list is unchanged, and reruns provider model discovery such as `openai-models` catalogs; the refreshed catalog arrives through `catalog.updated`, and the TUI then reloads that Location's model and provider lists. Environment variables are read by the running server process and do not change through a refresh.

CLI/TUI `cli.json` updates are serialized, written atomically through a temporary file, and preserve existing JSONC comments.

## Troubleshooting

- Unparsable JSON/JSONC skips the affected document and logs `ignored config file with invalid JSON`. For parsed documents, removed or unknown keys and schema-invalid units are dropped individually, with one `recovered config item` warning each. Invalid permission rules become action-wide or scope-wide denies; invalid `guardrails` values keep guardrails enabled with default limits. Inspect `GET /api/config/diagnostics` or the TUI Status dialog for the document path, JSON path, reason, message, and `fails closed` marker. The TUI also shows an error toast when a diagnostic is loaded.
- A missing `{file:...}` reference fails configuration loading for that Location and surfaces as a configuration error; it does not skip only that document.
- `instructions` is accepted but currently inactive; use `AGENTS.md` or skills.
- `tui.json`, `kv.json`, `config.json`, and project `.ycoding/tui.json` are not read.
- A managed-service port conflict is not fixed by deleting session data. Change the channel service config port or use `ycoding --standalone`.
- Run with `--log-level all` and `YCODING_PRINT_LOGS=1` when investigating configuration discovery.
- Each `location services booted` log line records the Location `directory`, total `durationMs`, and a `stages` map of per-service construction milliseconds; use it to identify a slow Location boot stage.

## Inbound task MCP

`ycoding mcp serve` is an opt-in localhost task endpoint with an external OAuth issuer, JWKS URL, exact public resource URL, and one approved subject. It is separate from configured outbound MCP servers and from the primary API listener. See [Task MCP configuration and Cloudflare Tunnel setup](./task-mcp.md) for all flags, access controls, limits, and lifecycle behavior.
