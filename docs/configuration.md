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
| `compaction`            | object                                | Automatic conversation compaction.                                                          |
| `skills`                | string array                          | Additional skill directories or HTTP(S) sources.                                            |
| `commands`              | record                                | Named slash commands.                                                                       |
| `instructions`          | string array                          | Accepted by Schema, but no current runtime consumer reads this field. Do not rely on it.    |
| `instruction_max_bytes` | positive integer                      | Maximum bytes loaded from each ambient instruction file; default 51,200, maximum 1,048,576. |
| `references`            | record                                | Named local or Git context sources.                                                         |
| `plugins`               | array                                 | Ordered plugin additions, options, and removals.                                            |
| `providers`             | record                                | Provider and model overrides.                                                               |
| `experimental`          | object                                | Subagent depth and resource policies.                                                       |

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
  "default_agent": "build",
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
    "auto": true,
    "keep": { "tokens": 16000 },
    "buffer": 8000,
  },
  "experimental": {
    "subagent_depth": 2,
    "policies": [],
  },
}
```

`experimental.subagent_depth` defaults to `1` when omitted.

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
    "markdown": "rendered",
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

Attention sound names are `default`, `question`, `permission`, `error`, `done`, and `subagent_done`.

`terminal.copy_on_select` is deprecated and behaviorally ignored. Passive mouse selection highlights text only. Copy the active selection with `Cmd+C` on macOS or `Ctrl+C` on other supported platforms; press `Esc` to clear it.

`keybinds` is a record of command names to key sequences. The complete current key map lives in `packages/tui/src/config/keybind.ts`; that file is authoritative when bindings are added or renamed.

The TUI `plugins` array has the same string or `{ package, options }` shape, but it configures terminal-side plugins rather than Core runtime plugins.

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
