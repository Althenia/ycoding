# Configuration reference

Status: **implemented**

This document is the canonical configuration reference for the current YCoding repository. It is derived from the live Schema and runtime discovery code. Historical upstream documentation is not authoritative for YCoding.

## Configuration surfaces

YCoding has three independent configuration surfaces:

| Surface                       | Files                                                                                                         | Scope                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime configuration         | `ycoding.json`, `ycoding.jsonc`, `.ycoding/ycoding.json`, `.ycoding/ycoding.jsonc`                            | Models, agents, permissions, MCP, providers, plugins, skills, commands, references, compaction, formatters, LSP, and runtime behavior. |
| CLI/TUI configuration         | `cli.json` in the YCoding global config directory                                                             | Theme, keybindings, notifications, prompt behavior, transcript presentation, mouse, and terminal integration.                          |
| Managed-service configuration | `service.json`, `service-local.json`, or `service-<channel-hash>.json` in the YCoding global config directory | Managed background-server hostname, port, and private password.                                                                        |

The obsolete files `tui.json` and `kv.json` are ignored. Project-local `.ycoding/tui.json` is not a supported configuration source.

## Global directories

YCoding resolves directories through `xdg-basedir` and appends the `ycoding` namespace.

| Purpose                             | Base                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| Configuration                       | `$XDG_CONFIG_HOME/ycoding`, or the platform XDG fallback |
| State and service registration      | `$XDG_STATE_HOME/ycoding`, or the platform XDG fallback  |
| Data and logs                       | `$XDG_DATA_HOME/ycoding`, or the platform XDG fallback   |
| Cache and installed helper binaries | `$XDG_CACHE_HOME/ycoding`, or the platform XDG fallback  |

`YCODING_CONFIG_DIR` overrides the global configuration directory used by the process.

## Runtime configuration discovery and precedence

Configuration entries are assembled from lowest to highest priority. For scalar values, the latest document that defines the field wins. Agents, commands, providers, plugins, permissions, and similar domains apply their own ordered merge behavior.

The tested document order is:

1. Global `ycoding.json`.
2. Global `ycoding.jsonc`.
3. The file named by `YCODING_CONFIG`, when set.
4. Direct `ycoding.json` and `ycoding.jsonc` files discovered from broad ancestors toward the current working directory.
5. `ycoding.json` and `ycoding.jsonc` inside ancestor `.ycoding` directories, from broad ancestors toward the current working directory.
6. Authenticated well-known integration configuration.
7. `YCODING_CONFIG_CONTENT`, which has the highest priority.

Example tested order:

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

YCoding does not currently publish a public schema endpoint. Do not point `$schema` at an upstream product URL or invent a YCoding URL.

## Removed configuration keys

A document containing any removed key is ignored as a whole. Current removed keys are:

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

The legacy MCP shape where server names appear directly under `mcp` is also rejected. Use `mcp.servers`.

## Complete top-level runtime fields

| Field                   | Type                                  | Purpose                                                                                     |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `$schema`               | string                                | Optional editor metadata only.                                                              |
| `shell`                 | string                                | Preferred shell for terminal and shell execution.                                           |
| `shell_sandbox`         | `disabled`, `optional`, or `required` | Shell isolation policy.                                                                     |
| `shell_memory_limit_mb` | non-negative integer                  | Default shell command process-tree memory limit in MiB; zero disables the default.          |
| `model`                 | model selector                        | Default model.                                                                              |
| `default_agent`         | string                                | Default selectable primary agent.                                                           |
| `autoupdate`            | boolean or `notify`                   | Update automatically or only notify.                                                        |
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
| `efficiency`            | object                                | Helper-model, prompt-cache, and provider-continuation policy.                               |
| `experimental`          | object                                | Subagent depth and resource policies.                                                       |

### Shell memory limits

`shell_memory_limit_mb` sets the Location-wide default for non-interactive shell commands. The shell tool's `memory_limit_mb` input overrides it for one command; zero explicitly selects unlimited memory. Omission uses the configured default, and omission with no default remains unlimited.

A finite limit supplies `GOMEMLIMIT=<limit>MiB` to Go runtimes, including compatible `tsgo` builds, and appends `--max-old-space-size=<limit>` to `NODE_OPTIONS` for Node processes. Bun does not expose an inherited heap-size option equivalent to Node's, so Bun itself is governed by the sampled process-tree ceiling while child Go or Node runtimes receive their soft hints.

On macOS and Linux, YCoding samples aggregate resident memory for the detached shell process group every 250 milliseconds and terminates the group with status `memory-limit` after a sample exceeds the limit. Sampling can overshoot between checks, shared pages can be counted more than once, and a command that deliberately creates a new process group can escape aggregate accounting. This is resource control, not a security boundary or a kernel hard limit. Windows rejects a finite shell memory limit because the current process abstraction cannot assign the command to a Job Object before it starts.

### Field defaults and nested Schema contract

The preceding overview is completed by this field-level ledger. `unset` means the field is optional in Schema and no consumer default is asserted here. This prevents an omitted field from being mistaken for a documented product default.

| Field path                                        | Exact type or closed values                                                    | Default         | Operational remark                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------ |
| `$schema`                                         | string                                                                         | unset           | Editor metadata only.                                                                            |
| `shell`                                           | string                                                                         | unset           | Shell executable or command selector.                                                            |
| `shell_sandbox`                                   | `disabled` \| `optional` \| `required`                                         | unset           | Shell isolation policy.                                                                          |
| `shell_memory_limit_mb`                           | non-negative integer `<= 1048576`                                              | unset           | Default sampled resident-memory limit in MiB; zero means unlimited.                              |
| `model`                                           | model selector                                                                 | unset           | Session/agent model fallback.                                                                    |
| `default_agent`, `username`                       | string                                                                         | unset           | Primary agent ID and display identity.                                                           |
| `autoupdate`                                      | boolean \| `notify`                                                            | unset           | Update policy.                                                                                   |
| `share`                                           | `manual` \| `auto` \| `disabled`                                               | unset           | Sharing policy.                                                                                  |
| `enterprise.url`                                  | string                                                                         | unset           | Enterprise endpoint.                                                                             |
| `permissions`                                     | ordered `[{ action: string, resource: string, effect: allow \| deny \| ask }]` | unset           | Global permission rules.                                                                         |
| `agents`                                          | record of `Config.Agent`                                                       | unset           | Inline agent definitions and overrides.                                                          |
| `snapshots`                                       | boolean                                                                        | unset           | Snapshot switch.                                                                                 |
| `watcher`                                         | `Config.Watcher`                                                               | unset           | Watcher filters.                                                                                 |
| `formatter`                                       | boolean \| record of `Config.Formatter.Entry`                                  | unset           | Formatter enablement and overrides.                                                              |
| `lsp`                                             | boolean \| record of `Config.LSP.Entry`                                        | unset           | Language-server enablement and overrides.                                                        |
| `attachments`, `tool_output`, `mcp`, `compaction` | their named `Config.*` object                                                  | unset           | Runtime tooling and context controls.                                                            |
| `guardrails`                                      | `Config.Guardrail`                                                             | unset           | Root-Session-family guardrail configuration; custom-source and reply rules are documented below. |
| `skills`, `instructions`                          | string[]                                                                       | unset           | Extra skill sources; `instructions` has no current ambient-discovery consumer.                   |
| `instruction_max_bytes`                           | positive integer `<= 1048576`                                                  | `51200`         | Per-ambient-instruction UTF-8 byte cap.                                                          |
| `commands`                                        | record of `Config.Command`                                                     | unset           | Inline slash commands.                                                                           |
| `references`                                      | record of `Config.Reference.Entry`                                             | unset           | Named local or Git context sources.                                                              |
| `plugins`                                         | (`string` \| `{ package: string, options?: Record<string, unknown> }`)[]       | unset           | Ordered runtime plugin directives.                                                               |
| `providers`                                       | record of `Config.Provider`                                                    | unset           | Provider/model overrides.                                                                        |
| `provider_usage`                                  | `Config.ProviderUsage`                                                         | unset           | Read-only provider-usage client bridge.                                                          |
| `efficiency`                                      | `Config.Efficiency`                                                            | runtime-derived | Helper-model, cache, and continuation policy.                                                    |
| `experimental`                                    | `Config.Experimental`                                                          | unset           | Experimental runtime policy.                                                                     |

| Nested field path                                                                       | Exact type or closed values                                                                                     | Default                         | Operational remark                                                                                                                                 |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.<id>.model`                                                                     | model selector                                                                                                  | unset                           | Agent model override.                                                                                                                              |
| `agents.<id>.request.headers`, `.request.body`                                          | string record, JSON record                                                                                      | unset                           | Provider request overlays.                                                                                                                         |
| `agents.<id>.system`, `.description`                                                    | string                                                                                                          | unset                           | System instruction and display description.                                                                                                        |
| `agents.<id>.mode`                                                                      | `subagent` \| `primary` \| `all`                                                                                | unset                           | Agent availability.                                                                                                                                |
| `agents.<id>.hidden`, `.disabled`                                                       | boolean                                                                                                         | unset                           | Visibility and disable switches.                                                                                                                   |
| `agents.<id>.color`                                                                     | `#RRGGBB` \| `primary` \| `secondary` \| `accent` \| `success` \| `warning` \| `error` \| `info`                | unset                           | TUI color.                                                                                                                                         |
| `agents.<id>.steps`                                                                     | positive integer                                                                                                | unset                           | Agent step allowance.                                                                                                                              |
| `agents.<id>.permissions`                                                               | `Permission.Rule[]`                                                                                             | unset                           | Agent permission additions.                                                                                                                        |
| `commands.<name>.template`                                                              | string                                                                                                          | required                        | Command prompt template.                                                                                                                           |
| `commands.<name>.description`, `.agent`                                                 | string                                                                                                          | unset                           | Picker description and agent ID.                                                                                                                   |
| `commands.<name>.model`                                                                 | model selector                                                                                                  | unset                           | Command model override.                                                                                                                            |
| `commands.<name>.subtask`                                                               | boolean                                                                                                         | unset                           | Subtask request.                                                                                                                                   |
| `references.<name>`                                                                     | string \| `{ repository: string, branch?, description?, hidden? }` \| `{ path: string, description?, hidden? }` | required per entry              | Reference source.                                                                                                                                  |
| `mcp.timeout.startup`, `.catalog`, `.execution`                                         | positive integer milliseconds                                                                                   | runtime-derived                 | Global timeout overrides.                                                                                                                          |
| `mcp.servers.<name>`                                                                    | local \| remote server object                                                                                   | required per entry              | Discriminated by `.type`.                                                                                                                          |
| local `.command`                                                                        | string[]                                                                                                        | required                        | Stdio command and arguments.                                                                                                                       |
| local `.cwd`, `.environment`, `.disabled`, `.timeout`                                   | string, string record, boolean, timeout object                                                                  | unset                           | Local-server options; relative `cwd` resolves from workspace.                                                                                      |
| remote `.url`                                                                           | string                                                                                                          | required                        | Remote MCP endpoint.                                                                                                                               |
| remote `.headers`, `.disabled`, `.timeout`                                              | string record, boolean, timeout object                                                                          | unset                           | Remote-server options.                                                                                                                             |
| local/remote `.codemode`                                                                | boolean                                                                                                         | `true`                          | Code Mode catalog exposure.                                                                                                                        |
| remote `.oauth`                                                                         | `false` \| OAuth object                                                                                         | unset                           | OAuth configuration.                                                                                                                               |
| `.oauth.client_id`, `.client_secret`, `.scope`, `.redirect_uri`                         | string                                                                                                          | unset                           | OAuth client fields.                                                                                                                               |
| `.oauth.callback_port`                                                                  | integer `1..65535`                                                                                              | unset                           | Local OAuth callback port.                                                                                                                         |
| `providers.<id>.name`, `.package`                                                       | string                                                                                                          | unset                           | Provider identity/implementation override.                                                                                                         |
| `providers.<id>.env`                                                                    | string[]                                                                                                        | unset                           | Credential variable names; never place credential values in config.                                                                                |
| `providers.<id>.settings`, `.headers`, `.body`                                          | JSON record, string record, JSON record                                                                         | unset                           | Provider request overlays.                                                                                                                         |
| `providers.<id>.models.<id>.modelID`, `.family`, `.name`, `.package`                    | model ID, model family, string, string                                                                          | unset                           | Model identity.                                                                                                                                    |
| model `.settings`, `.headers`, `.body`                                                  | JSON record, string record, JSON record                                                                         | unset                           | Model request overlays.                                                                                                                            |
| model `.capabilities.tools`                                                             | boolean                                                                                                         | unset                           | Tool-call declaration.                                                                                                                             |
| model `.capabilities.input`, `.output`                                                  | string[]                                                                                                        | unset                           | Input/output modality names.                                                                                                                       |
| model `.variants[]`                                                                     | `{ id: variant ID, settings?, headers?, body? }`                                                                | unset                           | Named request variants.                                                                                                                            |
| model `.cost`                                                                           | cost object \| cost object[]                                                                                    | unset                           | USD-per-million input/output cost; optional cache and context-tier data.                                                                           |
| model `.disabled`                                                                       | boolean                                                                                                         | unset                           | Model disable switch.                                                                                                                              |
| model `.limit.context`, `.input`, `.output`                                             | integer                                                                                                         | unset                           | Declared model limits.                                                                                                                             |
| `formatter.<name>`                                                                      | `{ disabled?, command?: string[], environment?: Record<string, string>, extensions?: string[] }`                | unset                           | Formatter override.                                                                                                                                |
| `lsp.<name>`                                                                            | `{ disabled: true }` \| `{ command: string[], extensions?, disabled?, env?, initialization? }`                  | unset                           | LSP override.                                                                                                                                      |
| `attachments.image.auto_resize`                                                         | boolean                                                                                                         | unset                           | Image resizing.                                                                                                                                    |
| `attachments.image.max_width`, `.max_height`, `.max_base64_bytes`                       | positive integer                                                                                                | unset                           | Image limits.                                                                                                                                      |
| `tool_output.max_lines`, `.max_bytes`                                                   | positive integer                                                                                                | unset                           | Output truncation thresholds.                                                                                                                      |
| `watcher.ignore`                                                                        | string[]                                                                                                        | unset                           | Watcher ignore patterns.                                                                                                                           |
| `compaction.keep_recent_messages`                                                       | non-negative integer                                                                                            | `0`                             | Number of newest complete messages protected from selective exclusion.                                                                             |
| `compaction.reserved_output_tokens`                                                     | non-negative integer                                                                                            | `0`                             | Output-token reservation used by compaction helper requests.                                                                                       |
| `compaction.context_safety_margin_tokens`                                               | non-negative integer                                                                                            | `4096`                          | Tokens reserved from the model input budget before context-pressure and model-switch fit calculations.                                             |
| `compaction.timeout_seconds`                                                            | non-negative integer                                                                                            | `0`                             | Compaction helper timeout; `0` disables the timeout.                                                                                               |
| `compaction.max_output_tokens`                                                          | non-negative integer                                                                                            | `0`                             | Compaction helper output cap; `0` uses the model cap.                                                                                              |
| `compaction.max_manifest_bytes`                                                         | non-negative integer                                                                                            | `65536`                         | UTF-8 cap for one strict ContextManifest candidate.                                                                                                |
| `compaction.max_internal_passes`                                                        | non-negative integer                                                                                            | `8`                             | Maximum physical manifest-generation calls, including repair attempts.                                                                             |
| `compaction.advisory`                                                                   | `false` \| `{ consider_percent, strongly_advised_percent }`                                                     | `{ 70, 90 }`                    | Disables advisory tool use or sets ordered integer thresholds from 1 through 99. Mandatory pressure at the hard cap is independent of this switch. |
| `guardrails.enabled`                                                                    | boolean                                                                                                         | unset                           | Guardrail switch.                                                                                                                                  |
| `guardrails.max_concurrent_shells`, `.max_concurrent_subagents`, `.max_pending_reviews` | positive integer                                                                                                | unset                           | Root-Session-family caps for running shells, running subagents, and pending reviews.                                                               |
| `provider_usage.codex_app_server.command`                                               | non-empty string                                                                                                | required when object is present | Direct executable, not a shell command.                                                                                                            |
| `provider_usage.codex_app_server.args`                                                  | string[]                                                                                                        | unset                           | Executable arguments.                                                                                                                              |
| `provider_usage.codex_app_server.cwd`                                                   | string                                                                                                          | unset                           | Client working directory.                                                                                                                          |
| `provider_usage.codex_app_server.timeout_ms`                                            | positive integer `<= 30000`                                                                                     | unset                           | App-server timeout.                                                                                                                                |
| `efficiency.title`                                                                      | `local` \| `model` \| `off`                                                                                     | `local`                         | Title policy.                                                                                                                                      |
| `efficiency.goal_synthesis`                                                             | `local` \| `model`                                                                                              | `local`                         | Goal synthesis policy.                                                                                                                             |
| `efficiency.helper_models.title`, `.goal`, `.compaction.main`, `.compaction.subagent`   | model selector \| `session`                                                                                     | `session`                       | Independent model selection for title, goal, and ContextManifest helpers.                                                                          |
| `efficiency.prompt_cache.anthropic_ttl`                                                 | `adaptive` \| `5m` \| `1h`                                                                                      | `adaptive`                      | Cache lifetime policy.                                                                                                                             |
| `efficiency.prompt_cache.openai_mode`                                                   | `auto` \| `implicit` \| `explicit`                                                                              | `auto`                          | OpenAI cache lowering.                                                                                                                             |
| `efficiency.prompt_cache.openai_extended_retention`                                     | boolean                                                                                                         | `false`                         | Pre-GPT-5.6 `24h` retention request.                                                                                                               |
| `efficiency.openai_responses_continuation`                                              | `auto` \| `on` \| `off`                                                                                         | `auto`                          | Response continuation policy.                                                                                                                      |
| `efficiency.openai_responses_state`                                                     | `stored` \| `stateless`                                                                                         | `stored`                        | Direct OpenAI Responses storage mode. Stored mode permits compatible response-ID continuation; stateless mode replays opaque provider state.       |
| `experimental.subagent_depth`                                                           | non-negative integer                                                                                            | `1`                             | Maximum nesting depth.                                                                                                                             |
| `experimental.policies`                                                                 | `Config.Policy.Info[]`                                                                                          | unset                           | Ordered configured-resource policies.                                                                                                              |

### Provider-usage reporting

**Implemented:** `provider_usage` currently configures only the optional Codex app-server fields above. GitHub Copilot usage reporting has no `provider_usage` key and requires no separate credential; it reuses the OAuth credential already configured for the `github-copilot` provider.

After unsuccessful Copilot model discovery, YCoding removes previously discovered Copilot model entries so stale models cannot remain selectable.

Copilot model discovery identifies itself as the `vscode-chat` integration, which the Copilot models endpoint requires before returning the account's model catalog.

For `github.com` accounts, the read-only, best-effort refresh queries `GET https://api.github.com/copilot_internal/user`. It normalizes paid `quota_snapshots` (including `chat`, `completions`, and legacy `premium_interactions`) and free or limited `limited_user_quotas`, `monthly_quotas`, and `limited_user_reset_date` responses. For a token-based-billing seat, it reads organization billing summaries for `aic_quantity` and `aic_gross_amount`, remembers the organization that reported AI-credit data, and re-discovers one after the remembered organization stops reporting. One GitHub AI credit is fixed at `$0.01` USD. Missing values remain absent and render as unreported, never zero.

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

The variant is optional.

## Provider efficiency

The optional `efficiency` block controls provider-request amplification and prompt caching:

```jsonc
{
  "efficiency": {
    "title": "local",
    "goal_synthesis": "local",
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
| `goal_synthesis`                         | `local`, `model`               | `local`    | Normalize goals locally or use the hidden goal agent.                                                            |
| `helper_models.title`                    | model selector, `session`      | `session`  | Model for model-generated Session titles.                                                                        |
| `helper_models.goal`                     | model selector, `session`      | `session`  | Model for model-based goal synthesis.                                                                            |
| `helper_models.compaction.main`          | model selector, `session`      | `session`  | Model for ContextManifest generation in main chats.                                                              |
| `helper_models.compaction.subagent`      | model selector, `session`      | `session`  | Model for ContextManifest generation in child Sessions.                                                          |
| `prompt_cache.anthropic_ttl`             | `adaptive`, `5m`, `1h`         | `adaptive` | Choose Anthropic-compatible cache lifetime behavior.                                                             |
| `prompt_cache.openai_mode`               | `auto`, `implicit`, `explicit` | `auto`     | Select OpenAI prompt-cache behavior according to model and route capabilities.                                   |
| `prompt_cache.openai_extended_retention` | boolean                        | `false`    | Request pre-GPT-5.6 `24h` OpenAI cache retention only on supported routes.                                       |
| `openai_responses_continuation`          | `auto`, `on`, `off`            | `auto`     | Reuse compatible durable direct OpenAI Responses state when state mode is `stored` and effective storage allows. |
| `openai_responses_state`                 | `stored`, `stateless`          | `stored`   | Select provider-stored response-ID continuation or stateless opaque replay for direct OpenAI Responses.          |

`prompt_cache.anthropic_ttl: "adaptive"` starts every namespace at five minutes. After two provider-reported reusable cache reads or writes for the same stable namespace within five minutes, later requests use the one-hour bucket. Missing cache telemetry, a namespace change, a stale observation, or a model without published extended-TTL support keeps the five-minute bucket. This process-local optimization is bounded and is not required for correctness.

`prompt_cache.openai_mode: "auto"` uses hybrid caching for direct OpenAI Responses requests on GPT-5.6 and later. It sends request-wide implicit mode, keeps OpenAI's managed implicit breakpoint, and reserves that breakpoint one of OpenAI's latest 50 read candidates. YCoding emits at most 49 explicit `input_text` candidates: one combined system-text marker when system text exists, then the newest eligible non-volatile user, assistant, and local tool-result text boundaries. `"explicit"` disables the managed breakpoint and uses at most 50 explicit candidates. OpenAI can write the latest three explicit candidates plus the managed breakpoint in implicit mode, or the latest four explicit candidates in explicit mode. Responses uses `input_text` EasyInput blocks for a marked assistant message and otherwise retains `output_text`; marked local tool results use `input_text` inside `function_call_output.output` while structured media remains unchanged. Tool definitions, tool calls, provider-executed tool results, and volatile messages receive no generated marker. Older public OpenAI models remain implicit. The ChatGPT Codex backend, OpenAI-compatible gateways, and unsupported model families omit GPT-5.6-only fields and retain key-based, backend-managed caching. `"implicit"` disables YCoding's generated explicit markers.

Direct OpenAI GPT-5.6 Responses requests automatically request `reasoning.context: "all_turns"` and enable server-side compaction at `200000` rendered tokens. In `stateless` mode, encrypted compaction items are retained outside public Session messages and replayed only for the same provider model. In `stored` mode, compatible requests may instead continue with `previous_response_id`. Direct OpenAI is Responses-only; configured third-party OpenAI-compatible Chat remains a separate route family.

The Core `websearch` tool is provider-independent local search backed by Exa or Parallel. It is distinct from `OpenAI.webSearch(...)`, which adds OpenAI-hosted `web_search` to a direct Responses request and executes at OpenAI.

When `openai_extended_retention` is true, supported pre-GPT-5.6 direct OpenAI requests use `prompt_cache_retention: "24h"`. GPT-5.6-and-later `auto` and `explicit` requests use `prompt_cache_options.ttl: "30m"`; `30m` is that model family's only supported minimum reuse lifetime, not a hard expiry, and OpenAI applies a separate 24-hour maximum. The setting remains false by default because pre-GPT-5.6 extended provider retention may have different privacy and eligibility properties.

`openai_responses_continuation` never changes `openai_responses_state`. The default `stored` state sends `store: true` on direct OpenAI Responses requests; choose `stateless` to send `store: false` and disable response-ID continuation. Enabling extended cache retention or stored Responses state may change provider data-retention behavior; make that choice explicitly.

The default `local` title and goal modes do not make provider requests. Set `title` or `goal_synthesis` to `model` to restore model-generated behavior. `title: "off"` leaves the initial generated Session title unchanged.

For titles and goals, an explicit model on the matching hidden agent takes precedence over `efficiency.helper_models.<role>`; a missing value or `session` uses the current Session model. For selective-compaction manifests, `helper_models.compaction.main` applies to main chats and `.subagent` to child Sessions. An explicit configured compaction model takes precedence over the agent-pinned model; a missing value or `session` retains the existing `agent model`, then current Session-model precedence. A subagent's `session` value always means that subagent's own model. Manifest generation uses the same prompt-cache policy and provider cache accounting.

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

Home-directory expansion applies to path resources for `external_directory`, `read`, and `edit`. It does not rewrite shell command text.

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

When `default_agent` is omitted, YCoding selects the maintained `god` primary agent. The selectable built-in primaries are `TLDR`, `architech`, `god`, and `yangi`; maintained subagents are `occam`, `omoikane`, `wittgenstein`, and `zeus`. The visible `btw` advisor and hidden `compaction`, `title`, `goal`, and `summary` helpers remain registered. `build`, `plan`, `explore`, `general`, `analyze`, and `brainstorm` are not built-ins.

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

Status meanings:

| Status                      | Meaning                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pending`                   | The transport is starting or the initial tool catalog is still loading.                                    |
| `connected`                 | Initialization and initial `tools/list` completed successfully.                                            |
| `disabled`                  | Disabled by configuration or disconnected for the current runtime.                                         |
| `needs_auth`                | The remote server requires its registered OAuth flow.                                                      |
| `needs_client_registration` | OAuth requires an explicit client registration.                                                            |
| `failed`                    | Startup, initialization, or initial tool discovery failed. Open the MCP dialog to inspect the exact error. |

YCoding reads the `ycoding` configuration namespace only. It does not automatically read the legacy upstream namespace. Migrate required MCP definitions explicitly; exact legacy identifiers are listed in [`ycoding-migration.md`](./ycoding-migration.md).

## Providers and models

Provider entries support:

- `name`;
- credential environment names in `env`;
- package override in `package`;
- request `settings`, `headers`, and `body` overlays;
- named `models`.

Model entries support:

- `modelID`, `family`, `name`, and `package`;
- request overlays;
- `capabilities.tools`, `capabilities.input`, and `capabilities.output`;
- variants as an array of `{ id, settings?, headers?, body? }`;
- cost information;
- `disabled`;
- `limit.context`, `limit.input`, and `limit.output`.

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

| Field path                                                         | Exact type or closed values                       | Default                     | Operational remark                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `theme.name`                                                       | string                                            | unset                       | Discovered theme ID.                                                                                |
| `theme.mode`                                                       | `system` \| `dark` \| `light`                     | unset                       | `system` follows the terminal.                                                                      |
| `keybinds.<command>`                                               | key-sequence override                             | unset                       | The supported command names and default bindings are owned by `packages/tui/src/config/keybind.ts`. |
| `plugins[]`                                                        | string \| `{ package: string, options?: record }` | unset                       | TUI-side plugin directives, separate from Core runtime plugins.                                     |
| `leader.timeout`                                                   | positive integer milliseconds                     | `2000`                      | Wait time after the leader key.                                                                     |
| `scroll.speed`                                                     | number `>= 0.001`                                 | unset                       | Distance per scroll-input tick.                                                                     |
| `scroll.acceleration`                                              | boolean                                           | unset                       | Repeated-input acceleration.                                                                        |
| `attention.enabled`, `.notifications`, `.sound`                    | boolean                                           | `true`                      | Master alerts, system notifications, and attention sound.                                           |
| `attention.volume`                                                 | number `0..1`                                     | `0.4`                       | Attention-sound volume.                                                                             |
| `attention.sound_pack`                                             | string                                            | `ycoding.default`           | Active sound-pack ID.                                                                               |
| `attention.sounds.<event>`                                         | string                                            | unset                       | Event is `default`, `question`, `permission`, `error`, `done`, or `subagent_done`.                  |
| `diffs.wrap`                                                       | `word` \| `none`                                  | unset                       | Diff line wrapping.                                                                                 |
| `diffs.tree`, `.single`                                            | boolean                                           | unset                       | File-tree visibility and single-patch view.                                                         |
| `diffs.view`                                                       | `auto` \| `split` \| `unified`                    | unset                       | `auto` selects from terminal width.                                                                 |
| `terminal.title`                                                   | boolean                                           | unset                       | Terminal title updates.                                                                             |
| `terminal.copy_on_select`                                          | boolean                                           | unset; behaviorally ignored | Deprecated compatibility field.                                                                     |
| `prompt.editor`                                                    | boolean                                           | unset                       | Adds active editor file or selection to prompt context.                                             |
| `prompt.paste`                                                     | `compact` \| `full`                               | unset                       | Large-paste presentation.                                                                           |
| `session.sidebar`                                                  | `auto` \| `hide`                                  | unset                       | `auto` shows the sidebar when width permits.                                                        |
| `session.scrollbar`                                                | boolean                                           | unset                       | Transcript scrollbar.                                                                               |
| `session.thinking`                                                 | `show` \| `hide`                                  | unset                       | Default reasoning visibility.                                                                       |
| `session.grouping`                                                 | `auto` \| `none`                                  | unset                       | Related transcript-item grouping.                                                                   |
| `hints.onboarding`, `debug.devtools`, `debug.timing`, `animations` | boolean                                           | unset                       | Guidance, diagnostics, and animation switches.                                                      |
| `mouse`                                                            | boolean                                           | `true`                      | Terminal mouse capture.                                                                             |

Attention sound names are `default`, `question`, `permission`, `error`, `done`, and `subagent_done`.

`terminal.copy_on_select` is deprecated and behaviorally ignored. Passive mouse selection highlights text only. Copy the active selection with `Ctrl+C` on every supported platform or `Cmd+C` on macOS; press `Esc` to clear it. Selection copy consumes `Ctrl+C` and cannot exit the application. Without a selection, `Ctrl+C` keeps its prompt behavior and requires two presses to exit from an empty prompt; `Esc` never exits YCoding.

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

Default managed ports are deterministic and product-namespaced:

```text
10000 + (first 32 bits of SHA-1("ycoding:<channel>") mod 50000)
```

This prevents branch builds of YCoding from colliding with another product process using the same channel name.

When a configured port is occupied, edit the channel-specific service file and choose another integer from `1` to `65535`. `ycoding --standalone` is a temporary alternative that starts a private server instead of the managed service.

The matching registration file is stored in the YCoding state directory. It contains the service instance ID, version, URL, PID, and private password. Do not hand-edit a live registration file.

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
| `YCODING_DISABLE_FILEWATCHER`    | Filesystem-watcher compatibility alias.                    |
| `YCODING_DISABLE_FFF`            | Disable the FFF filesystem backend.                        |
| `YCODING_WEBSEARCH_PROVIDER`     | Select web-search provider.                                |
| `YCODING_TERMINAL`               | Override terminal identity used by shell and PTY behavior. |

Build, packaging, test, and internal diagnostic variables are not stable end-user configuration. Examples include `YCODING_VERSION`, `YCODING_CHANNEL`, native-library paths, Drive simulation variables, and the internal managed-service startup-error file.

## Reload behavior

YCoding watches runtime configuration directories and explicit files. Changes are debounced by 100 ms and publish `config.updated`.

Agent, command, plugin, and skill files inside watched `.ycoding` or global config directories reload even when the JSON document list itself is unchanged.

Ecosystem skill roots such as `~/.claude/skills` and `~/.agents/skills` are not watched. Skill files are re-read whenever skills are listed so edits and deletions are still reflected.

CLI/TUI `cli.json` updates are serialized, written atomically through a temporary file, and preserve existing JSONC comments.

## Troubleshooting

- A config file containing a removed key is ignored in full; inspect warning logs for the exact keys.
- Invalid JSON/JSONC or a failed file substitution causes that document to be skipped.
- `instructions` is accepted but currently inactive; use `AGENTS.md` or skills.
- `tui.json`, `kv.json`, legacy `config.json`, and project `.ycoding/tui.json` are not read.
- A managed-service port conflict is not fixed by deleting session data. Change the channel service config port or use `ycoding --standalone`.
- Run with `--log-level all` and `YCODING_PRINT_LOGS=1` when investigating configuration discovery.
