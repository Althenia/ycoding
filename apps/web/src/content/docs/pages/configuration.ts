import type { DocBlock, DocPage } from "../types"

const surfaces: DocBlock = {
  kind: "table",
  head: ["Surface", "Files", "Scope"],
  rows: [
    [
      "Runtime",
      "`ycoding.json`, `ycoding.jsonc`, `.ycoding/ycoding.json`, `.ycoding/ycoding.jsonc`",
      "Models, agents, permissions, providers, plugins, MCP, commands, references, guardrails, compaction, formatters, LSP.",
    ],
    ["Terminal", "`cli.json` in the global YCoding config directory", "Theme, keybindings, notifications, prompt behavior, transcript presentation, mouse."],
    ["Managed service", "`service.json`, `service-local.json`, or `service-<SHA-1-of-channel>.json`", "Background server hostname, port, and private password."],
  ],
}

const domainCards: DocBlock = {
  kind: "cards",
  items: [
    { title: "Agents", text: "Specialized behavior, availability, and step limits.", href: "/docs/configuration/agents" },
    { title: "Models", text: "Model entries, variants, capabilities, and limits.", href: "/docs/configuration/models" },
    { title: "Providers", text: "Provider entries, credentials, and profiles.", href: "/docs/configuration/providers" },
    { title: "Plugins", text: "Plugin ordering, options, and removal.", href: "/docs/configuration/plugins" },
    { title: "MCP", text: "Local and remote servers, timeouts, and OAuth.", href: "/docs/configuration/mcp" },
    { title: "Goal", text: "Objectives and automatic continuation.", href: "/docs/configuration/goal" },
    { title: "YOLO mode", text: "Tiered autonomous execution.", href: "/docs/configuration/yolo" },
    { title: "Guardrails", text: "Session-family reviews and custom rules.", href: "/docs/configuration/guardrails" },
    { title: "Notifications", text: "Attention categories, sounds, and ntfy.", href: "/docs/configuration/notifications" },
    { title: "Permissions", text: "Ordered tool rules and inheritance.", href: "/docs/configuration/permissions" },
    { title: "Tools", text: "Tool surfaces and resource limits.", href: "/docs/configuration/tools" },
    { title: "Appearance", text: "Theme, keybindings, and terminal behavior.", href: "/docs/configuration/appearance" },
  ],
}

export const configurationPages: readonly DocPage[] = [
  {
    slug: "configuration",
    title: "Configuration",
    group: "Configuration",
    description: "Where YCoding configuration lives, which file wins, how values merge, and the keys that are rejected.",
    sections: [
      {
        heading: "Configuration surfaces",
        blocks: [
          {
            kind: "paragraph",
            text: "YCoding reads three independent configuration surfaces. A key placed in the wrong surface has no effect: terminal preferences in `ycoding.jsonc` are ignored, and runtime settings in `cli.json` are ignored.",
          },
          surfaces,
        ],
      },
      {
        heading: "File locations",
        blocks: [
          {
            kind: "table",
            head: ["Location", "Path", "Notes"],
            rows: [
              ["Global config directory", "`$XDG_CONFIG_HOME/ycoding`, usually `~/.config/ycoding`", "Holds global `ycoding.json`, `ycoding.jsonc`, `cli.json`, `AGENTS.md`, and the `agents/`, `commands/`, `plugins/`, `guardrails/`, and `themes/` directories. `YCODING_CONFIG_DIR` replaces this path."],
              ["Project file", "`ycoding.json` or `ycoding.jsonc` in the current directory or any ancestor", "Every ancestor is scanned, not only the Git root."],
              ["Project directory", "`.ycoding/` in the current directory or any ancestor", "Holds `ycoding.json`, `ycoding.jsonc`, and the same resource directories as the global config directory."],
              ["Explicit file", "The path in `YCODING_CONFIG`", "Loaded after the global files and before project files."],
              ["Inline document", "The JSON text in `YCODING_CONFIG_CONTENT`", "Loaded last, so it overrides every file."],
            ],
          },
        ],
      },
      {
        heading: "Discovery and precedence",
        blocks: [
          {
            kind: "paragraph",
            text: "Runtime configuration documents are loaded from lowest to highest priority. A higher-priority document overrides a lower one only for the fields it defines.",
          },
          {
            kind: "list",
            ordered: true,
            items: [
              "Global `ycoding.json`.",
              "Global `ycoding.jsonc`.",
              "The file named by `YCODING_CONFIG`, when set.",
              "Project `ycoding.json` and `ycoding.jsonc` files, from the broadest ancestor toward the current directory.",
              "`ycoding.json` and `ycoding.jsonc` inside ancestor `.ycoding` directories, from the broadest ancestor toward the current directory.",
              "Authenticated well-known integration configuration.",
              "`YCODING_CONFIG_CONTENT`.",
            ],
          },
          {
            kind: "paragraph",
            text: "Within one directory, `ycoding.jsonc` loads after `ycoding.json` and wins for the fields it defines. Set `YCODING_CONFIG_PROJECT_DISABLE=1` (or `true`), or the alias `YCODING_DISABLE_PROJECT_CONFIG`, to skip steps 4 and 5.",
          },
          {
            kind: "table",
            head: ["Field", "How documents combine"],
            rows: [
              ["Scalar fields such as `model`, `default_agent`, `shell`", "The highest-priority document that defines the field wins."],
              ["`permissions`", "Rules from every document are concatenated in load order and appended to every agent. The last matching rule decides, so later documents override earlier ones."],
              ["`agents.<id>`", "Each defined field replaces the earlier value; `request.headers` and `request.body` merge; `permissions` append; `disabled: true` removes the agent."],
              ["`providers.<id>`", "`name` and `package` replace; `settings` and `body` merge deeply; `headers` merge; each model field replaces; variants merge by `id`."],
              ["`mcp.servers.<name>`", "A later document replaces the whole server entry. `mcp.timeout` fields merge individually."],
              ["`plugins`", "Entries from every document run in load order, after auto-discovered plugin files."],
              ["`memory`, `tool_output`, `attachments.image`", "Each nested field merges independently."],
            ],
          },
        ],
      },
      {
        heading: "Complete example",
        blocks: [
          {
            kind: "paragraph",
            text: "A global file holds personal defaults; a project file holds settings the repository shares. Both are valid on their own.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "~/.config/ycoding/ycoding.jsonc",
            code: `{
  "$schema": "https://ycoding.althenia.app/ycoding.schema.json",
  "model": "openrouter/anthropic/claude-sonnet-4",
  "default_agent": "god",
  "shell": "/bin/zsh",
  "shell_memory_limit_mb": 4096,
  "ntfy": { "enabled": true, "topic": "my-attention-topic" },
}`,
          },
          {
            kind: "code",
            language: "jsonc",
            label: "<project>/.ycoding/ycoding.jsonc",
            code: `{
  // Project rules are appended after global rules; the last match wins.
  "permissions": [
    { "action": "edit", "resource": "src/**", "effect": "allow" },
    { "action": "shell", "resource": "bun test *", "effect": "allow" },
  ],
  "agents": {
    "reviewer": {
      "description": "Review changes without editing files",
      "mode": "subagent",
      "permissions": [{ "action": "edit", "resource": "*", "effect": "deny" }],
    },
  },
  "mcp": {
    "servers": {
      "docs": { "type": "local", "command": ["bun", "run", "./tools/mcp.ts"] },
    },
  },
}`,
          },
        ],
      },
      {
        heading: "JSON and JSONC behavior",
        blocks: [
          {
            kind: "list",
            items: [
              "Both file names accept `//` comments and trailing commas.",
              "`$schema` is editor metadata. The generated schema is published at `https://ycoding.althenia.app/ycoding.schema.json`.",
              "`{env:NAME}` is replaced with the value of environment variable `NAME`; an unset variable becomes an empty string.",
              "`{file:path}` is replaced with the trimmed contents of a file, escaped as a JSON string fragment. Relative paths resolve from the directory of the containing file; `~/` and absolute paths are supported. A `{file:...}` token on a line that starts with `//` is not resolved.",
              "Unknown properties are ignored.",
            ],
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Substitution",
            code: `{
  "username": "{env:USER}",
  "mcp": {
    "servers": {
      "private": {
        "type": "remote",
        "url": "https://mcp.example.com",
        "headers": { "Authorization": "Bearer {file:./secrets/mcp-token.txt}" },
      },
    },
  },
}`,
          },
        ],
      },
      {
        heading: "Rejected configuration keys",
        blocks: [
          {
            kind: "paragraph",
            text: "A document containing any rejected top-level key is ignored as a whole, so one stale key disables every setting in that file. The runtime logs the warning `ignored config file with removed keys` with the file path and the exact keys.",
          },
          {
            kind: "code",
            language: "text",
            label: "Rejected keys",
            code: "logLevel, server, command, reference, snapshot, plugin, autoshare,\ndisabled_providers, enabled_providers, small_model, mode, agent,\nprovider, permission, tools, attachment, layout",
          },
          {
            kind: "table",
            head: ["Rejected key", "Use instead"],
            rows: [
              ["`agent`, `command`, `provider`, `permission`, `plugin`, `reference`, `snapshot`, `attachment`", "`agents`, `commands`, `providers`, `permissions`, `plugins`, `references`, `snapshots`, `attachments`"],
              ["`tools`", "`permissions` rules, or remove a tool plugin with `plugins`"],
              ["MCP servers directly under `mcp`", "`mcp.servers.<name>`"],
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            title: "MCP shape",
            text: "An `mcp` object without a `servers` key whose values contain `type` is rejected like a removed key. Nest every server under `mcp.servers`.",
          },
        ],
      },
      {
        heading: "Top-level fields",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Type", "Default", "Description"],
            rows: [
              ["`$schema`", "string", "unset", "Editor schema metadata only."],
              ["`model`", "model selector", "unset", "Default `provider/model#variant` when no Session or agent model is selected."],
              ["`default_agent`", "string", "`god`", "Primary agent for a new Session."],
              ["`username`", "string", "unset", "Display and telemetry identity."],
              ["`shell`", "string", "unset", "Shell for terminal and shell-tool execution."],
              ["`shell_sandbox`", "`disabled` | `optional` | `required`", "unset", "`disabled` runs on the host; `optional` uses an enforceable sandbox when available and warns otherwise; `required` rejects the command before approval or spawn when none is available."],
              ["`shell_memory_limit_mb`", "integer 0–1048576", "unset (unlimited)", "Default shell process-tree memory ceiling in MiB; `0` means unlimited."],
              ["`autoupdate`", "boolean | `notify`", "unset (checks enabled)", "Omitted, `true`, and `notify` announce new releases; `false` disables the check. Installation always requires `ycoding update`."],
              ["`share`", "`manual` | `auto` | `disabled`", "unset", "Session sharing policy."],
              ["`enterprise.url`", "string", "unset", "Enterprise sharing endpoint."],
              ["`permissions`", "array of `{ action, resource, effect }`", "unset", "Global ordered tool permission rules."],
              ["`agents`", "record of agent objects", "unset", "Built-in agent overrides and custom agents."],
              ["`snapshots`", "boolean", "unset", "Undo and revert snapshot behavior."],
              ["`watcher.ignore`", "string[]", "unset", "Filesystem watcher ignore patterns."],
              ["`formatter`", "boolean | record", "unset", "Formatter enablement and overrides."],
              ["`lsp`", "boolean | record", "unset", "Language-server enablement and overrides."],
              ["`attachments.image`", "object", "see Tools", "Image resize and size limits."],
              ["`tool_output`", "`{ max_lines?, max_bytes? }`", "2000 lines, 51200 bytes", "Tool-output truncation thresholds."],
              ["`mcp`", "`{ timeout?, servers? }`", "unset", "MCP timeout defaults and named servers."],
              ["`compaction`", "object", "see below", "Selective compaction limits and advisory thresholds."],
              ["`memory`", "object", "`enabled: true`", "Explicit workspace knowledge storage."],
              ["`guardrails`", "object", "`enabled: true`, caps 8/8/16", "Session-family review service and concurrency caps."],
              ["`skills`", "string[]", "unset", "Extra skill directories, `~/` paths, or HTTP(S) sources."],
              ["`commands`", "record of command objects", "unset", "Named slash commands."],
              ["`instructions`", "string[]", "unset", "Accepted but not read by instruction discovery. Use `AGENTS.md` or skills."],
              ["`instruction_max_bytes`", "positive integer ≤ 1048576", "`51200`", "Per-file UTF-8 byte cap for ambient `AGENTS.md` instructions."],
              ["`references`", "record", "unset", "Named local directories or Git repositories used as context."],
              ["`plugins`", "array of string | `{ package, options? }`", "unset", "Ordered plugin additions and removals."],
              ["`providers`", "record of provider objects", "unset", "Provider and model metadata and request overlays."],
              ["`ntfy`", "`{ enabled?: boolean, topic?: string }`", "disabled", "Remote attention-message tool."],
              ["`provider_usage.codex_app_server`", "object", "unset", "Optional local Codex app-server quota source."],
              ["`efficiency`", "object", "runtime-derived", "Helper models, title policy, prompt caching, Responses continuation."],
              ["`image_analyzer`", "object", "unset", "Image-to-text fallback for text-only models."],
              ["`experimental.subagent_depth`", "integer ≥ 0", "`1`", "Maximum subagent nesting depth."],
              ["`experimental.policies`", "array", "unset", "Ordered configured-resource policies."],
            ],
          },
          {
            kind: "table",
            head: ["`compaction` field", "Type", "Default"],
            rows: [
              ["`keep_recent_messages`", "integer ≥ 0", "`20`"],
              ["`reserved_output_tokens`", "integer ≥ 0", "`0`"],
              ["`context_safety_margin_tokens`", "integer ≥ 0", "`4096`"],
              ["`timeout_seconds`", "integer ≥ 0; `0` disables the budget", "`60`"],
              ["`max_output_tokens`", "integer ≥ 0; `0` uses the model cap", "`0`"],
              ["`max_manifest_bytes`", "integer ≥ 0", "`65536`"],
              ["`max_internal_passes`", "integer ≥ 0", "`8`"],
              ["`advisory`", "`false` | `{ consider_percent, strongly_advised_percent }` (integers 1–99)", "`{ 70, 90 }`"],
            ],
          },
        ],
      },
      {
        heading: "Environment variables",
        blocks: [
          {
            kind: "paragraph",
            text: "The YCoding server process reads these variables when it starts. A switch is on when its value is `1` or `true` (case-insensitive).",
          },
          {
            kind: "table",
            head: ["Variable", "Effect"],
            rows: [
              ["`YCODING_CONFIG`", "Path of one extra runtime config file."],
              ["`YCODING_CONFIG_CONTENT`", "Highest-priority inline runtime config as JSON text."],
              ["`YCODING_CONFIG_DIR`", "Replaces the global config directory."],
              ["`YCODING_CONFIG_PROJECT_DISABLE`, `YCODING_DISABLE_PROJECT_CONFIG`", "Disable project config discovery."],
              ["`YCODING_PRINT_LOGS`", "Print logs, including configuration warnings, to the terminal."],
              ["`YCODING_LOG_LEVEL`", "Logging threshold."],
            ],
          },
          {
            kind: "code",
            language: "sh",
            label: "One-off override",
            code: `YCODING_CONFIG_CONTENT='{"model":"openai/gpt-5"}' ycoding run "Summarize the README"`,
          },
        ],
      },
      {
        heading: "Validation errors",
        blocks: [
          {
            kind: "table",
            head: ["Problem", "Result"],
            rows: [
              ["JSON or JSONC syntax error", "The document is skipped."],
              ["A rejected key", "The document is skipped and a warning names the keys."],
              ["A known field with a wrong type or out-of-range value, for example `\"shell_sandbox\": \"strict\"`", "The document fails validation and is skipped entirely; no field from it is applied. No warning is logged."],
              ["An unknown field", "The field is ignored; the rest of the document applies."],
              ["An invalid Markdown agent, command, or guardrail file", "Agents and commands are skipped. An enabled invalid guardrail file turns mutation actions into reviews."],
            ],
          },
          {
            kind: "callout",
            tone: "tip",
            title: "Catch errors in the editor",
            text: "Add `\"$schema\": \"https://ycoding.althenia.app/ycoding.schema.json\"` so the editor flags wrong types before YCoding silently skips the file.",
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "steps",
            items: [
              { title: "Save the file", text: "Runtime config files are watched. A change is picked up after a 100 ms debounce without restarting." },
              { title: "Inspect resolved state", text: "Run `ycoding debug agents` for agents, models, and permissions; `ycoding mcp list` for MCP servers; `ycoding plugin list` for active plugins." },
              { title: "Check for skipped files", text: "Start with `YCODING_PRINT_LOGS=1` and look for `ignored config file with removed keys`. If a value still has no effect and no warning appears, the file failed validation: compare every field against the tables on this page." },
            ],
          },
        ],
      },
      {
        heading: "Configuration domains",
        blocks: [domainCards, { kind: "related", slugs: ["configuration/permissions", "configuration/appearance", "troubleshooting"] }],
      },
    ],
  },
  {
    slug: "configuration/agents",
    title: "Agents",
    group: "Configuration",
    description: "Define and override primary agents and background subagents, their models, permissions, and limits.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "An agent is a system prompt, a model choice, and a permission rule list. Primary agents run the foreground Session. Subagents run as durable background child Sessions. Configure agents under `agents` in `ycoding.jsonc` or as Markdown files.",
          },
          {
            kind: "table",
            head: ["Built-in", "Mode", "Notes"],
            rows: [
              ["`god`", "primary", "Default when `default_agent` is unset."],
              ["`GSD`, `architech`, `yangi`", "primary", "Selectable primary agents."],
              ["`occam`, `omoikane`, `wittgenstein`, `zeus`", "subagent", "Maintained task subagents."],
              ["`btw`", "subagent", "Visible read-only advisor; shell, edit, write, and patch ask."],
              ["`compaction`, `title`, `goal`, `summary`", "primary, hidden", "Internal helpers with every tool denied."],
            ],
          },
        ],
      },
      {
        heading: "Fields",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Type", "Default", "Description"],
            rows: [
              ["`model`", "model selector", "Session or `model` fallback", "Agent-specific `provider/model#variant`."],
              ["`description`", "string", "unset", "Text shown in pickers and status."],
              ["`mode`", "`primary` | `subagent` | `all`", "built-in mode, or runtime default for a new agent", "`primary` is selectable for the foreground Session; `subagent` only runs as a child; `all` is both."],
              ["`hidden`", "boolean", "unset", "Hide from normal selection."],
              ["`color`", "`#RRGGBB` | `primary` | `secondary` | `accent` | `success` | `warning` | `error` | `info`", "unset", "Terminal color."],
              ["`steps`", "positive integer", "unset", "Step allowance per promoted user input."],
              ["`disabled`", "boolean", "unset", "`true` removes the agent, including a built-in."],
              ["`permissions`", "array of `{ action, resource, effect }`", "unset", "Appended after built-in and global rules."],
              ["`system`", "string", "built-in prompt", "System instruction. In Markdown agents it is the file body."],
              ["`request.headers`", "record of strings", "unset", "Extra provider request headers."],
              ["`request.body`", "JSON record", "unset", "Provider request body overlay."],
            ],
          },
          {
            kind: "paragraph",
            text: "`default_agent` is a top-level field, not an agent field. Any other key inside an agent object is ignored.",
          },
        ],
      },
      {
        heading: "Examples",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "Read-only review subagent",
            code: `{
  "agents": {
    "reviewer": {
      "description": "Review changes without editing files",
      "mode": "subagent",
      "model": "openrouter/anthropic/claude-sonnet-4",
      "color": "info",
      "steps": 20,
      "permissions": [
        { "action": "edit", "resource": "*", "effect": "deny" },
        { "action": "write", "resource": "*", "effect": "deny" },
        { "action": "patch", "resource": "*", "effect": "deny" },
        { "action": "shell", "resource": "*", "effect": "ask" },
        { "action": "shell", "resource": "git diff *", "effect": "allow" },
      ],
    },
  },
}`,
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Change the default and override a built-in",
            code: `{
  "default_agent": "GSD",
  "agents": {
    "GSD": { "model": "openai/gpt-5#high" },
    "yangi": { "disabled": true },
    "goal": { "model": "openai/gpt-5-mini" },
  },
}`,
          },
        ],
      },
      {
        heading: "Markdown agents",
        blocks: [
          {
            kind: "paragraph",
            text: "Markdown agents are discovered recursively under `agent/` or `agents/` in the global config directory and in every ancestor `.ycoding/` directory. The agent ID is the path below that directory without `.md`. YAML frontmatter holds the agent fields; the body becomes `system`.",
          },
          { kind: "code", language: "text", label: "Location and ID", code: ".ycoding/agents/backend/reviewer.md  ->  backend/reviewer" },
          {
            kind: "code",
            language: "markdown",
            label: ".ycoding/agents/backend/reviewer.md",
            code: `---
description: Reviews backend changes
mode: subagent
model: openrouter/anthropic/claude-sonnet-4
color: "#e67e22"
steps: 20
permissions:
  - action: edit
    resource: "*"
    effect: deny
---

Review the current change against repository contracts.
Report concrete defects with file and symbol evidence.`,
          },
          {
            kind: "callout",
            tone: "warning",
            title: "Invalid files are skipped",
            text: "A Markdown agent with invalid frontmatter, such as `mode: reviewer` or `steps: 0`, is skipped without a warning. `AGENTS.md` is instruction text, not an agent definition.",
          },
        ],
      },
      {
        heading: "Merge and inheritance",
        blocks: [
          {
            kind: "list",
            items: [
              "An agent ID that already exists, built-in or earlier, is updated field by field; request headers and body merge.",
              "Permission order for one agent is: built-in defaults, then global `permissions` from every document, then that agent's own `permissions`. The last matching rule wins.",
              "A subagent also receives its parent's permission ceiling and cannot widen a parent denial. Subagents always get final `deny` rules for `subagent` and `subagent_control`.",
              "`experimental.subagent_depth` (default `1`) bounds nesting.",
              "Promoting any new user input resets the selected agent's step allowance.",
            ],
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "Run `ycoding debug agents` in the project directory. It prints every resolved agent as JSON, including its mode, model, and final permission list. A missing custom agent means its file or object failed validation.",
          },
          { kind: "related", slugs: ["configuration/permissions", "configuration/models", "configuration/plugins"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/models",
    title: "Models",
    group: "Configuration",
    description: "Model selector syntax, variants, declared capabilities, cost, context limits, and switching.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "A model selector names the model a Session, agent, command, or helper uses. Model entries under `providers.<id>.models` add or adjust identity, request overlays, capabilities, cost, and limits.",
          },
        ],
      },
      {
        heading: "Selector syntax",
        blocks: [
          {
            kind: "code",
            language: "text",
            label: "Grammar",
            code: "<providerID>/<modelID>[#<variant>]\n\nopenai/gpt-5\nopenrouter/anthropic/claude-sonnet-4\nopenrouter/openai/gpt-5#high",
          },
          {
            kind: "list",
            items: [
              "`providerID` is everything before the first `/` and cannot contain `/` or `#`.",
              "`modelID` is everything after the first `/` up to `#`; it may contain `/`.",
              "`variant` is optional. `default` selects the base model. `none` selects the model's `none` variant when it has one, otherwise the base model.",
              "The object form `{ \"providerID\": \"openrouter\", \"model\": \"openai/gpt-5\", \"variant\": \"high\" }` is equivalent.",
            ],
          },
          {
            kind: "table",
            head: ["Field", "Accepts"],
            rows: [
              ["`model`", "selector"],
              ["`agents.<id>.model`", "selector"],
              ["`commands.<name>.model`", "selector"],
              ["`efficiency.helper_models.title`, `.goal`, `.compaction.main`, `.compaction.subagent`", "selector or `session` (default)"],
              ["`image_analyzer.model`", "selector string"],
            ],
          },
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: `{
  "model": "openrouter/anthropic/claude-sonnet-4",
  "agents": { "reviewer": { "model": "openai/gpt-5#high" } },
  "commands": {
    "review": { "template": "Review the current diff.", "model": "openai/gpt-5-mini" },
  },
}`,
          },
        ],
      },
      {
        heading: "Model entry fields",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Type", "Description"],
            rows: [
              ["`modelID`", "string", "Identifier sent to the provider when it differs from the entry key."],
              ["`name`", "string", "Display name."],
              ["`family`", "string", "Model family label."],
              ["`package`", "string", "Provider implementation override for this model."],
              ["`api`", "`chat` | `responses`", "OpenAI-compatible request surface. Overrides the provider `settings.api` and the catalog value."],
              ["`settings`, `body`", "JSON record", "Request overlays, merged deeply."],
              ["`headers`", "record of strings", "Request header overlay."],
              ["`capabilities.tools`", "boolean", "Whether the model accepts tool calls."],
              ["`capabilities.input`, `capabilities.output`", "string[]", "Modalities, for example `[\"text\", \"image\"]`."],
              ["`variants`", "array of `{ id, settings?, headers?, body? }`", "Named request variants; an existing `id` is merged."],
              ["`cost`", "object | object[]", "`input` and `output` in USD per million tokens (required), optional `cache.read`, `cache.write`, and `tier: { type: \"context\", size }`."],
              ["`limit.context`, `limit.input`, `limit.output`", "integer", "Token limits used for context budgeting."],
              ["`disabled`", "boolean", "`true` disables the model."],
            ],
          },
        ],
      },
      {
        heading: "Examples",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "Add a variant to a catalog model",
            code: `{
  "providers": {
    "openrouter": {
      "models": {
        "openai/gpt-5": {
          "variants": [{ "id": "deep", "settings": { "reasoning": { "effort": "high" } } }],
        },
      },
    },
  },
  "model": "openrouter/openai/gpt-5#deep",
}`,
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Declare a model on a custom endpoint",
            code: `{
  "providers": {
    "local-llm": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:8000/v1", "api": "chat" },
      "models": {
        "qwen-coder": {
          "modelID": "Qwen/Qwen2.5-Coder-32B-Instruct",
          "name": "Qwen Coder 32B",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 131072, "output": 8192 },
          "cost": { "input": 0, "output": 0 },
        },
      },
    },
  },
  "model": "local-llm/qwen-coder",
}`,
          },
        ],
      },
      {
        heading: "Switching models in a session",
        blocks: [
          {
            kind: "paragraph",
            text: "Selecting another model validates the target, interrupts active requests and tools, waits for settlement, and checks that context fits the target's context window minus `compaction.context_safety_margin_tokens` (default `4096`). If it does not fit, the switch joins running compaction or admits one additional compaction. Interrupted work is not replayed, and raw history is kept.",
          },
          {
            kind: "callout",
            tone: "info",
            title: "Refused switches",
            text: "If context still cannot fit, or the target has no resolvable context limit, the switch is refused and the previous model stays selected.",
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "Open the model picker in the TUI: a declared model appears under its provider, and a variant appears in the variant cycle. The Session header shows the active `provider/model`. A selector that fails the grammar, such as `gpt-5` without a provider, makes the whole file fail validation.",
          },
          { kind: "related", slugs: ["configuration/providers", "configuration/agents", "usage/sessions"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/providers",
    title: "Providers",
    group: "Configuration",
    description: "Provider entries, credential variable names, request overlays, custom endpoints, and named profiles.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "`providers.<id>` adjusts a catalog provider or adds a new one: its display name, implementation package, request overlays, credential variable names, model catalog source, and models. Credential values are stored as profiles by `/connect`, never in configuration files.",
          },
        ],
      },
      {
        heading: "Fields",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Type", "Description"],
            rows: [
              ["`name`", "string", "Display name."],
              ["`env`", "string[]", "Names of environment variables that hold the credential. Never put the credential value here."],
              ["`package`", "string", "Implementation. `aisdk:@ai-sdk/openai-compatible` selects an OpenAI-compatible endpoint."],
              ["`settings`", "JSON record", "Provider settings overlay, merged deeply. OpenAI-compatible endpoints read `baseURL` and `api` (`chat` or `responses`)."],
              ["`headers`", "record of strings", "Request header overlay."],
              ["`body`", "JSON record", "Request body overlay."],
              ["`catalog.source`", "`openai-models`", "Discover models from `GET <baseURL>/models`."],
              ["`models`", "record of model entries", "See Models."],
            ],
          },
        ],
      },
      {
        heading: "Examples",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "Custom OpenAI-compatible endpoint",
            code: `{
  "providers": {
    "custom-openai": {
      "name": "Team gateway",
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "https://llm.example.com/v1", "api": "chat" },
      "catalog": { "source": "openai-models" },
      "models": {
        "team-large": { "name": "Team Large", "capabilities": { "tools": true } },
      },
    },
  },
  "model": "custom-openai/team-large",
}`,
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Credential from an environment variable",
            code: `{
  "providers": {
    "custom-openai": {
      "env": ["TEAM_GATEWAY_API_KEY"],
    },
  },
}`,
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Select the Codex WebSocket route for ChatGPT sign-in",
            code: `{
  "providers": {
    "openai": { "settings": { "transport": "websocket" } },
  },
}`,
          },
          {
            kind: "paragraph",
            text: "For `transport`, `\"http\"` or omission selects HTTP/SSE, and neither route falls back to the other. `/connect` → Custom OpenAI-compatible endpoint writes the first example into the global `ycoding.json` (or existing `ycoding.jsonc`) and stores the API key as a profile.",
          },
        ],
      },
      {
        heading: "Model discovery",
        blocks: [
          {
            kind: "list",
            items: [
              "With `catalog.source: \"openai-models\"`, YCoding requests `GET <settings.baseURL>/models` with `Authorization: Bearer <key>` from the active profile, with a 5-second timeout.",
              "The response must be `{ \"object\": \"list\", \"data\": [{ \"id\": \"...\" }] }`; each record may add `name`, `capabilities`, `limit`, and `variants`, which override catalog metadata.",
              "With a stored profile, the URL must use HTTPS or loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`), contain no embedded credentials, and must not redirect.",
              "A failure logs `OpenAI model discovery failed` and keeps configured models usable.",
            ],
          },
        ],
      },
      {
        heading: "Profiles",
        blocks: [
          {
            kind: "paragraph",
            text: "One provider can hold several named profiles: multiple accounts or API keys. A profile is the user-facing name of a stored credential. `/connect`, the command palette's Connect integration, and the model selector's connect action ask for that name; reusing a name updates that profile.",
          },
          {
            kind: "list",
            items: [
              "Exactly one profile per provider is active; model requests and usage reporting use it.",
              "Switching the active profile keeps the others. Removing the active profile promotes the remaining one.",
              "The Session header shows the active profile after the agent when a provider has more than one profile; a single profile shows the plain `provider/model` label.",
            ],
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "Open the model picker: the provider appears with its models, and discovered models appear after discovery succeeds. Send one prompt with the new model selected; an authentication error means no active profile or unset `env` variable.",
          },
          { kind: "related", slugs: ["configuration/models", "usage/cli", "troubleshooting"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/plugins",
    title: "Plugins",
    group: "Configuration",
    description: "Add, order, configure, and remove runtime plugins, and how plugins register hooks.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Plugins extend runtime domains: they can register tools, hooks, agents, commands, skills, integrations, references, provider transforms, and Session behavior. Built-in tools and providers are plugins too, so `plugins` can remove them.",
          },
        ],
      },
      {
        heading: "Entry forms",
        blocks: [
          {
            kind: "table",
            head: ["Entry", "Meaning"],
            rows: [
              ["`\"./plugins/local.ts\"`, `\"../shared/p.js\"`, `\"file:///abs/p.ts\"`", "Load a file. `./` and `../` resolve from the directory of the containing config file."],
              ["`\"@scope/package\"`", "Install and load an npm package."],
              ["`{ \"package\": \"@scope/package\", \"options\": { } }`", "Load a package or file and pass `options` to the plugin."],
              ["`\"ycoding.tool.websearch\"`", "Enable a plugin by exact ID."],
              ["`\"-ycoding.tool.websearch\"`", "Remove the plugin with that ID."],
              ["`\"*\"`, `\"ycoding.provider.*\"`", "Select every plugin, or every plugin whose ID starts with the prefix."],
            ],
          },
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: `{
  "plugins": [
    { "package": "@example/ycoding-plugin", "options": { "strict": true } },
    "./.ycoding/extra/policy.ts",
    "-ycoding.tool.websearch",
    "-ycoding.provider.xai",
  ],
}`,
          },
        ],
      },
      {
        heading: "Ordering rules",
        blocks: [
          {
            kind: "list",
            ordered: true,
            items: [
              "Direct `plugin/*.ts|js` and `plugins/*.ts|js` files in the global config directory and in ancestor `.ycoding/` directories are loaded automatically. Nested files are not discovered.",
              "`plugins` entries from every document then apply in configuration load order, so an entry can remove an auto-discovered or built-in plugin.",
              "A later entry for the same package replaces the earlier one.",
              "A plugin that fails to load logs `failed to load plugin` with its target; other plugins still load.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            title: "Hooks belong to plugins",
            text: "There is no top-level `hooks` key and no `.ycoding/hooks/` directory. Plugins register hooks for the AI SDK, Session, and Tool domains.",
          },
        ],
      },
      {
        heading: "Writing a plugin",
        blocks: [
          {
            kind: "paragraph",
            text: "The default export must be `define({ id, effect })` from `@ycoding-ai/plugin/effect/plugin` or `define({ id, setup })` from `@ycoding-ai/plugin/promise/plugin`. Any other shape fails with `Plugin does not implement the V2 contract`.",
          },
          {
            kind: "code",
            language: "ts",
            label: ".ycoding/plugins/project.ts",
            code: `import { define } from "@ycoding-ai/plugin/effect/plugin"
import { Effect } from "effect"

export default define({
  id: "company.project-policy",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.tool.transform((draft) => {
      // Register or modify tool behavior.
    })
  }),
})`,
          },
          {
            kind: "code",
            language: "ts",
            label: ".ycoding/plugins/promise.ts",
            code: `import { define } from "@ycoding-ai/plugin/promise/plugin"

export default define({
  id: "company.promise-policy",
  async setup(ctx) {
    return async () => {
      // Optional cleanup.
    }
  },
})`,
          },
          {
            kind: "paragraph",
            text: "Plugin context domains are `agent`, `aisdk`, `catalog`, `command`, `event`, `integration`, `plugin`, `reference`, `session`, `skill`, and `tool`.",
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "Run `ycoding plugin list`; it prints the ID of every active plugin. A removed plugin is absent, and a loaded file or package appears under the `id` it defines.",
          },
          { kind: "related", slugs: ["configuration/mcp", "configuration/agents", "configuration/tools"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/mcp",
    title: "MCP",
    group: "Configuration",
    description: "Configure local and remote Model Context Protocol servers, timeouts, OAuth, and Code Mode.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "MCP servers add external tools, prompts, and resources to a Session. A `local` server runs a process over stdio; a `remote` server connects to a URL. Every server lives under `mcp.servers.<name>`.",
          },
        ],
      },
      {
        heading: "Examples",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "Local and remote servers",
            code: `{
  "mcp": {
    "timeout": { "startup": 60000, "catalog": 30000 },
    "servers": {
      "docs": {
        "type": "local",
        "command": ["bunx", "@example/docs-mcp"],
        "cwd": ".",
        "environment": { "DOCS_ROOT": "./docs" },
      },
      "tracker": {
        "type": "remote",
        "url": "https://mcp.example.com",
        "headers": { "Authorization": "Bearer {env:TRACKER_TOKEN}" },
        "oauth": false,
      },
      "old-server": { "type": "local", "command": ["old-mcp"], "disabled": true },
    },
  },
}`,
          },
          {
            kind: "code",
            language: "sh",
            label: "Add from the command line",
            code: `ycoding mcp add docs -- bunx @example/docs-mcp
ycoding mcp add tracker --url https://mcp.example.com --header Authorization="Bearer $TRACKER_TOKEN"
ycoding mcp add docs --global -- bunx @example/docs-mcp`,
          },
          {
            kind: "paragraph",
            text: "`ycoding mcp add` writes to the first existing `ycoding.json`, `ycoding.jsonc`, `.ycoding/ycoding.json`, or `.ycoding/ycoding.jsonc` in the current directory (or the global config directory with `--global`), creating `ycoding.json` when none exists. `--env name=value` is local-only; `--header name=value` is remote-only.",
          },
        ],
      },
      {
        heading: "Fields",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Server type", "Type", "Default", "Description"],
            rows: [
              ["`type`", "both", "`local` | `remote`", "required", "Selects the server shape."],
              ["`command`", "local", "string[]", "required", "Executable and arguments."],
              ["`cwd`", "local", "string", "unset", "Working directory; relative paths resolve from the workspace directory."],
              ["`environment`", "local", "record of strings", "unset", "Extra environment variables."],
              ["`url`", "remote", "string", "required", "Endpoint."],
              ["`headers`", "remote", "record of strings", "unset", "Request headers."],
              ["`oauth`", "remote", "`false` | object", "unset (OAuth available)", "`false` disables OAuth registration."],
              ["`oauth.client_id`, `.client_secret`, `.scope`, `.redirect_uri`", "remote", "string", "unset", "Pre-registered OAuth client."],
              ["`oauth.callback_port`", "remote", "integer 1–65535", "unset", "Local callback port."],
              ["`codemode`", "both", "boolean", "`true`", "Expose the server's tools through Code Mode."],
              ["`disabled`", "both", "boolean", "unset", "Keep the entry but do not start it."],
              ["`timeout.startup`, `.catalog`, `.execution`", "both", "positive integer (ms)", "see below", "Per-server overrides."],
            ],
          },
          {
            kind: "table",
            head: ["Phase", "Key", "Default"],
            rows: [
              ["Transport startup and initialization", "`startup`", "30 seconds"],
              ["Catalog discovery such as `tools/list` and `prompts/list`", "`catalog`", "30 seconds"],
              ["Tool and prompt execution", "`execution`", "12 hours"],
            ],
          },
          {
            kind: "paragraph",
            text: "`mcp.timeout` sets defaults for every server; a server's own `timeout` fields override them. If two documents define the same server name, the later document replaces the whole entry.",
          },
        ],
      },
      {
        heading: "OAuth",
        blocks: [
          {
            kind: "code",
            language: "sh",
            label: "Authenticate",
            code: "ycoding mcp auth tracker\nycoding mcp logout tracker",
          },
          {
            kind: "paragraph",
            text: "OAuth credentials are stored in the global credential store, keyed by server name and URL, not in the config file.",
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "Run `ycoding mcp list`, or open `/mcps` in the TUI. The footer shows `connected/configured` counts.",
          },
          {
            kind: "table",
            head: ["Status", "Meaning"],
            rows: [
              ["`pending`", "The transport is starting or the catalog is still loading."],
              ["`connected`", "Initialization and the first `tools/list` completed."],
              ["`disabled`", "Disabled by configuration or disconnected for this run."],
              ["`needs_auth`", "Run `ycoding mcp auth <name>`."],
              ["`needs_client_registration`", "Set `oauth.client_id` (and `client_secret` if required)."],
              ["`failed`", "Startup, initialization, or catalog discovery failed; open the MCP dialog for the error."],
            ],
          },
          {
            kind: "callout",
            tone: "tip",
            title: "Slow package launchers",
            text: "A first run through `npx -y` or `bunx` may exceed 30 seconds while downloading. Raise `timeout.startup` and `timeout.catalog` for that server.",
          },
          { kind: "related", slugs: ["configuration/plugins", "configuration/tools", "troubleshooting"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/goal",
    title: "Goal",
    group: "Configuration",
    description: "Set one objective, choose the goal model, and understand continuation and terminal states.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "A goal is a durable Session objective that keeps work continuing until it completes, you stop it, or it exhausts its no-progress budget. You own the objective text: ordinary prompts and agent tools cannot replace it. Goal state is Session state, not a configuration key.",
          },
          {
            kind: "table",
            head: ["Command", "Effect"],
            rows: [
              ["`/goal <text>`", "Calculate an objective from the text with a model and create or replace the goal, even while one is active."],
              ["`/goal`", "Stop an active goal, resume a retained goal verbatim without recalculation, or ask for text when none exists."],
            ],
          },
        ],
      },
      {
        heading: "Configuration",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Type", "Default", "Description"],
            rows: [
              ["`agents.goal.model`", "model selector", "unset", "Model for goal calculation and continuation steers. Wins over the helper selection."],
              ["`efficiency.helper_models.goal`", "model selector | `session`", "`session`", "Used when `agents.goal.model` is unset. `session` means the current Session model."],
              ["`agents.goal.system`", "string", "built-in prompt", "Instructions for the hidden goal helper."],
            ],
          },
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: `{
  "agents": {
    "goal": {
      "system": "Derive one concise, verifiable objective from the user's explicit request and conversation. Return only the objective.",
    },
  },
  "efficiency": {
    "helper_models": { "goal": "openai/gpt-5-mini#low" },
  },
}`,
          },
          {
            kind: "callout",
            tone: "info",
            title: "Failed calculation changes nothing",
            text: "If the configured model is unavailable, the request fails, or the result is empty, the previous goal and your draft are kept. Raw text is never activated, and no other model is tried.",
          },
        ],
      },
      {
        heading: "Continuation and terminal states",
        blocks: [
          {
            kind: "list",
            items: [
              "An active goal auto-answers questions, forms, and `ask` permissions at YOLO 0. Guardrail reviews still need effective YOLO 3 or a human.",
              "Each successful settled step sequence advances the iteration and admits the next continuation, steered by the hidden goal agent.",
              "The agent calls `report` only for an unresolved blocker. Each report consumes one no-progress attempt; the default budget is `3`, and progress does not reset consumed attempts.",
              "A running subagent or background shell pauses continuation without consuming an attempt; its completion wakes the goal.",
            ],
          },
          {
            kind: "table",
            head: ["State", "Reached when"],
            rows: [
              ["`completed`", "The agent calls the goal tool's `complete` action after verification."],
              ["`stopped`", "You or the runtime leave goal mode."],
              ["`exhausted`", "Accepted reports consume the no-progress budget."],
            ],
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "The rail's `GOAL` section shows the objective and status, and the top-right Session status includes goal mode while active.",
          },
          { kind: "related", slugs: ["configuration/yolo", "configuration/guardrails", "usage/sessions"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/yolo",
    title: "YOLO mode",
    group: "Configuration",
    description: "What each autonomous level answers, how to set it, how descendants inherit it, and what stays manual.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "YOLO is a durable per-Session autonomy level from `0` to `3`. It is Session state, not a `ycoding.jsonc` key.",
          },
          {
            kind: "table",
            head: ["Level", "Answers automatically"],
            rows: [
              ["`0`", "Nothing. Every question, form, permission request, and guardrail review waits for you."],
              ["`1`", "Questions and deterministic forms."],
              ["`2`", "Level 1 plus `ask` permission decisions."],
              ["`3`", "Level 2 plus ordinary guardrail reviews."],
            ],
          },
          {
            kind: "paragraph",
            text: "An active goal also answers questions, forms, and `ask` permissions at level 0, but guardrail reviews still require level 3. `deny` permission rules and inherited permission ceilings apply at every level.",
          },
        ],
      },
      {
        heading: "Setting the level",
        blocks: [
          {
            kind: "table",
            head: ["Surface", "Input", "Result"],
            rows: [
              ["TUI prompt", "`/yolo`", "Cycle `0 → 1 → 2 → 3 → 0`."],
              ["TUI prompt", "`/yolo 2`", "Set level 2 exactly; accepts `0`–`3`."],
              ["Command palette", "Toggle YOLO", "Same cycle as `/yolo`."],
              ["Keybinding", "`<leader>y` (`session_autonomy_normal`)", "Disable YOLO."],
              ["Non-interactive run", "`ycoding run --yolo <0-3> \"prompt\"`", "Set the level before the prompt is admitted."],
            ],
          },
          { kind: "code", language: "sh", label: "Non-interactive", code: 'ycoding run --yolo 2 "Regenerate the client and run its tests"' },
          {
            kind: "list",
            items: [
              "Omitting `--yolo` keeps an adopted Session's level; `--yolo 0` selects manual handling. Any other value exits with `ycoding: --yolo requires one of 0, 1, 2, or 3`.",
              "A failed autonomy update prevents prompt admission instead of running at the wrong level.",
              "A child Session inherits the maximum effective level from its ancestors.",
            ],
          },
        ],
      },
      {
        heading: "What stays manual",
        blocks: [
          {
            kind: "list",
            items: [
              "Hard guardrail reviews require a fresh human `Allow once` or `Deny` at every level.",
              "Non-interactive runs never approve locally: a remaining permission, question, form, or guardrail request is rejected and the run exits unsuccessfully.",
            ],
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "`/yolo` shows the toast `YOLO <n> enabled` or `YOLO disabled`. The rail's `AUTONOMY` section shows Guardrails as `auto · YOLO 3` only at effective level 3 and `enforced` otherwise; hard reviews are labeled `human only`.",
          },
          { kind: "related", slugs: ["configuration/guardrails", "configuration/permissions", "configuration/goal"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/guardrails",
    title: "Guardrails",
    group: "Configuration",
    description: "Session-family safety reviews, the built-in rule tiers, hard reviews, caps, and custom rule files.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Guardrails review high-impact actions across a root Session and all of its subagents, independently of tool permissions. Shell commands, direct Session shell, edits, writes, patches, subagent launches, mutation-capable MCP tools, and project-artifact changes pass through the same service. A pending review blocks the whole Session family and appears in every Session view it blocks.",
          },
        ],
      },
      {
        heading: "Options and defaults",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: `{
  "guardrails": {
    "enabled": true,
    "max_concurrent_shells": 8,
    "max_concurrent_subagents": 8,
    "max_pending_reviews": 16,
  },
}`,
          },
          {
            kind: "table",
            head: ["Field", "Type", "Default", "Description"],
            rows: [
              ["`guardrails.enabled`", "boolean", "`true`", "`false` turns off ordinary reviews and custom `allow`, `ask`, and `deny` rules. Catastrophic denies, built-in hard reviews, and custom `hard_review` rules still apply."],
              ["`guardrails.max_concurrent_shells`", "positive integer", "`8`", "Running shells per root Session family."],
              ["`guardrails.max_concurrent_subagents`", "positive integer", "`8`", "Running subagents per root Session family."],
              ["`guardrails.max_pending_reviews`", "positive integer", "`16`", "Pending reviews per root Session family."],
            ],
          },
        ],
      },
      {
        heading: "Built-in rule tiers",
        blocks: [
          {
            kind: "paragraph",
            text: "Built-in patterns inspect `shell` command text case-insensitively after collapsing whitespace. Unless noted, a pattern matches anywhere in the command after a space or at its start. The matcher follows `cd <dir> &&` for relative deletion targets but does not expand aliases, functions, command substitution, or `find`/`xargs` deletion.",
          },
          {
            kind: "table",
            head: ["Tier", "Rule ID", "Matches", "Who can settle it"],
            rows: [
              ["Catastrophic deny", "`standard.catastrophic.rm-root`", "A command starting with `rm` or `sudo rm`, one flag group with `r` before `f` (`-rf`, `-Rf`, `-rfv`), optional `--`, then `/`, `~`, or `$HOME` as a whole word. Also any recursive `rm` (`-r`, `-R`, a flag group containing `r`/`R`, or `--recursive`) whose target resolves to the filesystem root or home directory, including `/*`, `~/.*`, and `${HOME}`.", "Nobody. Always denied."],
              ["Catastrophic deny", "`standard.catastrophic.format-disk`", "`mkfs`, `mkfs.<type>` such as `mkfs.ext4`, `diskutil eraseDisk`, or `format <letter>:`.", "Nobody."],
              ["Catastrophic deny", "`standard.catastrophic.block-device-write`", "`dd` with an `of=/dev/disk…`, `of=/dev/sd…`, `of=/dev/nvme…`, or `of=/dev/vd…` operand.", "Nobody."],
              ["Catastrophic deny", "`standard.catastrophic.fork-bomb`", "`:(){ :|:& };:`, with optional spaces.", "Nobody."],
              ["Ordinary review", "`standard.review.git-destructive`", "`git reset --hard`; `git clean` whose first flag group contains `f` (`-f`, `-fd`, `-xdf`); `git checkout -- .`; `git restore … --worktree`.", "Human, YOLO 3, earlier Allow for this session, or a custom `allow` rule."],
              ["Ordinary review", "`standard.review.force-push`", "`git push` followed later by the word `--force`, `--force-with-lease`, or `-f`.", "Same as above."],
              ["Ordinary review", "`standard.review.publish`", "`npm`, `pnpm`, `yarn`, or `bun` followed by `publish` or `release`; `docker push`.", "Same as above."],
              ["Ordinary review", "`standard.review.production`", "`kubectl` with `production` or `prod` later in the command; `terraform apply`; `helm install` or `helm upgrade` with `production` or `prod` later.", "Same as above."],
              ["Ordinary review", "`standard.review.database-destructive`", "`drop database`, `drop schema`, `drop table`, `truncate table`, or `delete from <table>` that ends the command (optional `;`, no `WHERE`).", "Same as above."],
              ["Ordinary review", "`standard.review.security-mutation`", "`security add-generic-password`, `security delete-generic-password`, `chmod` with `777` or `a+w`, `ufw disable`, `ufw reset`, `iptables -F`.", "Same as above."],
              ["Ordinary review", "`standard.review.mcp-execute`", "Every `mcp_execute` action; the resource is `<server>/<tool>`.", "Same as above."],
              ["Ordinary review", "`standard.review.broad-deletion`", "A recursive `rm` with more than one target when no target is the project, an ancestor, a direct child of home, root, or home.", "Same as above."],
              ["Hard review", "`standard.review.broad-deletion`", "A recursive `rm` with any target that resolves to the current project directory, one of its ancestors, or a direct child of the home directory such as `~/Documents`.", "A fresh human `Allow once` or `Deny` only."],
            ],
          },
        ],
      },
      {
        heading: "Hard reviews (human only)",
        blocks: [
          {
            kind: "callout",
            tone: "warning",
            title: "Hard reviews need a fresh human decision",
            text: "A hard review offers only `Allow once` and `Deny`. YOLO 3, an active goal, agent automation, `Allow for this session`, earlier reusable approvals, custom `allow` rules, and `guardrails.enabled: false` cannot settle it. An `always` reply sent to a hard review is recorded as `reject`, and the action is denied.",
          },
          {
            kind: "list",
            items: [
              "Built-in: `standard.review.broad-deletion` when a recursive `rm` targets the current project directory, one of its ancestors, or a direct child of the home directory. The same rule ID with multiple other targets is an ordinary review.",
              "Custom: any rule file with `decision: hard_review`. A matching `hard_review` rule in any source layer applies even when a nearer layer matched `allow` or `ask`.",
              "A custom `deny` and every catastrophic deny still win over a hard review.",
            ],
          },
          {
            kind: "code",
            language: "markdown",
            label: ".ycoding/guardrails/aws-account-deletion.md",
            code: `---
id: protect-aws-account-deletion
decision: hard_review
actions: [shell]
resources:
  - "aws organizations delete-organization*"
  - "aws account close-account*"
reason: AWS organization or account deletion
priority: 200
---
Verify the authenticated AWS account and require one-time human approval.`,
          },
        ],
      },
      {
        heading: "Custom rule files",
        blocks: [
          {
            kind: "paragraph",
            text: "Each rule is one Markdown file with YAML frontmatter. Files are direct `guardrails/*.md` children of the global config directory (`~/.config/ycoding/guardrails/`) and of each discovered `.ycoding/` directory; nested directories are not scanned. The body is operator-facing and is not sent to the model.",
          },
          {
            kind: "table",
            head: ["Field", "Required", "Type", "Default", "Description"],
            rows: [
              ["`id`", "yes", "non-empty string", "—", "Stable rule identifier shown in reviews."],
              ["`enabled`", "no", "boolean", "`true`", "`false` ignores the file, even if it is invalid."],
              ["`decision`", "yes", "`allow` | `ask` | `hard_review` | `deny`", "—", "What a match does."],
              ["`actions`", "yes", "non-empty string[]", "—", "Action patterns, for example `shell`, `edit`, `write`, `patch`, `subagent`."],
              ["`resources`", "yes", "non-empty string[]", "—", "Resource patterns. For `shell` the resource is the full command text."],
              ["`reason`", "yes", "non-empty string", "—", "Text shown in the review."],
              ["`priority`", "no", "integer", "`0`", "Higher sorts first within the same source layer."],
            ],
          },
          {
            kind: "list",
            items: [
              "Patterns match the whole string. `*` matches any characters, including spaces and `/`; `?` matches one character. A pattern ending in ` *` also matches the text without the trailing part, so `git push *` matches `git push`. Matching is case-sensitive except on Windows.",
              "Prefix a pattern with `*` to match a command that has leading words, for example `*aws *s3 rb *` matches `AWS_PROFILE=x aws s3 rb s3://bucket`.",
              "Source layers are evaluated nearest `.ycoding/` first, then broader ancestors, then the global directory. The first layer with a match decides. Within a layer, rules sort by descending `priority`, then file path and rule ID.",
              "A custom `allow` in the deciding layer skips an ordinary built-in review; it cannot skip a catastrophic deny or a hard review.",
              "An enabled file with missing or invalid fields is listed as invalid. Its layer turns mutation actions into reviews with rule ID `configuration.invalid`; `read`, `glob`, `grep`, `webfetch`, and `websearch` stay available, and a valid `deny` in that layer still denies.",
            ],
          },
          {
            kind: "code",
            language: "markdown",
            label: ".ycoding/guardrails/protect-aws-resources.md",
            code: `---
id: protect-aws-resources
decision: deny
actions: [shell]
resources:
  - "*aws *s3 rb *"
  - "*aws *cloudformation delete-stack*"
  - "*aws *ec2 terminate-instances*"
reason: Destructive AWS resource operation is not permitted by this rule
priority: 100
---
Use a separately reviewed operations procedure.`,
          },
          {
            kind: "code",
            language: "markdown",
            label: ".ycoding/guardrails/production.md",
            code: `---
id: protect-production
decision: ask
actions: [shell]
resources:
  - "kubectl * -n production*"
  - "terraform apply*"
reason: Production infrastructure modification
priority: 100
---
Confirm the account, cluster, namespace, and change plan.`,
          },
        ],
      },
      {
        heading: "Replies and approvals",
        blocks: [
          {
            kind: "table",
            head: ["TUI choice", "Reply", "Effect"],
            rows: [
              ["Allow once", "`once`", "Settle this review only."],
              ["Allow for this session", "`always`", "Reuse for the same root Session family, action, rule IDs, resources, and request metadata in the current process. Each action is re-evaluated first; a deny or a changed match does not reuse it. Not offered for hard reviews."],
              ["Deny", "`reject`", "Deny the action."],
            ],
          },
          {
            kind: "paragraph",
            text: "Approving a guardrail review never widens a permission denial, and approving a permission never bypasses a guardrail review. When a review stays pending for 500 ms, the TUI sends the notification `Guardrail approval needed` with the `permission` sound.",
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "The Session guardrail sidebar shows the profile (`standard` or `disabled`), the custom-rule count, approvals, blocked actions, family counters, and the invalid-file count. After adding a rule, confirm the invalid-file count is zero and check the next matching review names your rule ID. Test with synthetic commands rather than real destructive ones.",
          },
          { kind: "related", slugs: ["configuration/permissions", "configuration/yolo", "troubleshooting"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/notifications",
    title: "Notifications",
    group: "Configuration",
    description: "Terminal attention alerts and sounds in cli.json, and the optional ntfy remote delivery tool.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Notifications ask for attention when work needs a human: an unresolved permission, question, form, or guardrail review, an error, or verified completion. Desktop notifications and sounds are configured in `cli.json`. Remote phone or browser delivery uses the optional `ntfy` tool configured in `ycoding.jsonc`.",
          },
        ],
      },
      {
        heading: "Terminal attention",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "~/.config/ycoding/cli.json",
            code: `{
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
}`,
          },
          {
            kind: "table",
            head: ["Setting", "Type", "Default", "Description"],
            rows: [
              ["`attention.enabled`", "boolean", "`true`", "Master switch for attention alerts."],
              ["`attention.notifications`", "boolean", "`true`", "System notifications."],
              ["`attention.sound`", "boolean", "`true`", "Attention sounds."],
              ["`attention.volume`", "number 0–1", "`0.4`", "Sound volume."],
              ["`attention.sound_pack`", "string", "`ycoding.default`", "Active sound-pack ID."],
              ["`attention.sounds.<event>`", "string (file path)", "unset", "Per-event sound file. Events: `default`, `question`, `permission`, `error`, `done`, `subagent_done`."],
            ],
          },
          {
            kind: "paragraph",
            text: "A pending request alerts after 500 ms and only once per request; replying first suppresses it. Routine child completion and continuation during an active goal are silent. A normal Session alerts on completion only after its own `task_complete` call succeeds with no running child task or shell.",
          },
        ],
      },
      {
        heading: "Remote attention with ntfy",
        blocks: [
          {
            kind: "paragraph",
            text: "The built-in `ntfy` tool posts one plain-text message to `https://ntfy.sh/<topic>`. It is disabled until `ntfy.enabled` is exactly `true` and `ntfy.topic` is non-blank; otherwise it returns a configuration failure without sending.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: `{
  "ntfy": { "enabled": true, "topic": "project-attention" },
  "permissions": [
    { "action": "ntfy", "resource": "https://ntfy.sh/*", "effect": "allow" },
  ],
}`,
          },
          {
            kind: "table",
            head: ["Field", "Type", "Default"],
            rows: [
              ["`ntfy.enabled`", "boolean", "unset (disabled)"],
              ["`ntfy.topic`", "string", "unset"],
            ],
          },
          {
            kind: "list",
            items: [
              "Explicit `ntfy` tool calls check permission action `ntfy` with resource `https://ntfy.sh/*` like any other tool.",
              "Automatic lifecycle delivery waits 500 ms for a pending request, sends at most once, and posts only when that permission is already `allow`; `ask` and `deny` neither prompt nor post. Built-in agents start from an allow-all baseline, so add an `ask` or `deny` rule to stop automatic posts.",
              "Automatic messages are model-generated from Session context, capped at 200 characters, and sanitized; generation failure skips the post.",
            ],
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "Subscribe to the topic in the ntfy app or at `https://ntfy.sh/<topic>`, then leave a permission request unanswered for more than 500 ms. For terminal alerts, change `attention.volume` and trigger a question; the TUI rewrites `cli.json` atomically and keeps comments.",
          },
          { kind: "related", slugs: ["configuration/appearance", "usage/remote", "configuration/guardrails"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/permissions",
    title: "Permissions",
    group: "Configuration",
    description: "Ordered tool rules, the three effects, last-match evaluation, built-in defaults, and inherited ceilings.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Permissions decide whether an agent may attempt a tool action: `allow` runs it, `deny` blocks it, and `ask` waits for a reply. Every rule list is evaluated from the end: the last rule whose `action` and `resource` both match decides. When nothing matches, the effect is `ask`.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: `{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status *", "effect": "allow" },
    { "action": "shell", "resource": "bun test *", "effect": "allow" },
    { "action": "edit", "resource": "src/**", "effect": "allow" },
    { "action": "edit", "resource": "src/generated/**", "effect": "deny" },
    { "action": "external_directory", "resource": "~/secrets/*", "effect": "deny" },
  ],
}`,
          },
          {
            kind: "paragraph",
            text: "Put broad rules first and specific exceptions after them. In the example, `bun test --watch` is allowed, `git push` asks, and edits under `src/generated/` are denied even though `src/**` is allowed.",
          },
        ],
      },
      {
        heading: "Rule shape",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Type", "Description"],
            rows: [
              ["`action`", "string pattern", "Tool action name, or `*` for every action."],
              ["`resource`", "string pattern", "What the action targets. `*` matches everything."],
              ["`effect`", "`allow` | `deny` | `ask`", "Decision when this is the last matching rule."],
            ],
          },
          {
            kind: "list",
            items: [
              "Patterns match the whole string. `*` matches any characters, including `/` and spaces; `?` matches one character. A pattern ending in ` *` also matches without the trailing part. Matching is case-sensitive except on Windows.",
              "For `read`, `edit`, and `external_directory`, a resource starting with `~/`, `~`, or `$HOME` expands to the home directory. Shell command text is never rewritten.",
              "When one call has several resources, any `deny` denies, otherwise any `ask` asks.",
            ],
          },
          {
            kind: "table",
            head: ["Action", "Resource"],
            rows: [
              ["`read`, `edit`, `write`, `patch`", "File path relative to the Location for files inside it; the canonical absolute path for files outside it."],
              ["`external_directory`", "`<absolute directory>/*` for a directory outside the Location, checked before reading or changing files there."],
              ["`glob`, `grep`", "The search pattern."],
              ["`shell`", "The full command text."],
              ["`webfetch`", "The URL."],
              ["`websearch`, `question`, `subagent`, `subagent_control`, `memory`, `computer`", "Tool-specific; use `*` to match every call."],
              ["`ntfy`", "`https://ntfy.sh/*`."],
              ["`<server>_<tool>`", "MCP tool calls, resource `*`. Characters outside `A–Z a–z 0–9 _ -` in the server or tool name become `_`."],
            ],
          },
        ],
      },
      {
        heading: "Rule order and inheritance",
        blocks: [
          {
            kind: "list",
            ordered: true,
            items: [
              "Built-in agent defaults.",
              "Global `permissions` from every config document, in load order.",
              "The agent's own `permissions`.",
              "A subagent's inherited permission ceiling from its parent.",
              "Approvals saved with Always for the project, added as `allow` rules. They are consulted only when no rule from steps 1–4 denies the call.",
            ],
          },
          {
            kind: "table",
            head: ["Built-in default rule", "Effect"],
            rows: [
              ["`*` on `*`", "allow"],
              ["`external_directory` on `*`", "ask, except the tool-output and temporary directories"],
              ["`read` on `*.env` and `*.env.*`", "ask"],
              ["`read` on `*.env.example`", "allow"],
              ["`question`, `plan_enter`, `plan_exit`", "deny for subagents; primaries allow `question` and `plan_enter`"],
              ["`shell` on `*`", "allow for the named built-in agents; ask for `btw`"],
              ["`subagent` on `*`", "deny for subagents"],
            ],
          },
        ],
      },
      {
        heading: "How requests are answered",
        blocks: [
          {
            kind: "table",
            head: ["Situation", "Behavior"],
            rows: [
              ["YOLO 0 or 1, no active goal", "`ask` waits for your reply."],
              ["YOLO 2 or higher", "`ask` is answered automatically."],
              ["Active goal", "`ask` and questions are answered automatically at any level."],
              ["`deny`", "Denied at every level."],
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            title: "Permissions are not guardrails",
            text: "Approving a guardrail review never widens a permission denial, and approving a permission never bypasses a guardrail review.",
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "Run `ycoding debug agents` and read the agent's final `permissions` array; the last matching entry is the one that applies. An invalid `effect` such as `prompt` makes the whole config file fail validation.",
          },
          { kind: "related", slugs: ["configuration/guardrails", "configuration/yolo", "configuration/tools"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/tools",
    title: "Tools",
    group: "Configuration",
    description: "Built-in tools, how to disable them, shell limits, output truncation, and attachment handling.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Tools are what an agent can do in your environment. Each call is checked against permission rules, and mutation-capable calls also pass through guardrails. There is no `tools` key; control tools with `permissions` or by removing their plugin.",
          },
          {
            kind: "table",
            head: ["Tool", "Plugin ID", "Purpose"],
            rows: [
              ["`read`, `glob`, `grep`", "`ycoding.tool.read`, `.glob`, `.grep`", "Read files and search the workspace."],
              ["`edit`, `write`, `patch`", "`ycoding.tool.edit`, `.write`, `.patch`", "Change files."],
              ["`shell`", "`ycoding.tool.shell`", "Run commands with a finite timeout and optional memory limit."],
              ["`webfetch`, `websearch`", "`ycoding.tool.webfetch`, `.websearch`", "Fetch a URL; local web search backed by Exa or Parallel."],
              ["`browser`", "`ycoding.tool.browser`", "Paired Chrome tabs, Session-owned tabs, or an isolated browser."],
              ["`computer`", "`ycoding.tool.computer`", "macOS iTerm sessions, Finder paths, and one identified app window."],
              ["`memory`", "`ycoding.tool.memory`", "Explicit workspace knowledge."],
              ["`ntfy`", "`ycoding.tool.ntfy`", "Remote attention message."],
              ["`subagent`, `subagent_control`, `todowrite`, `question`, `goal`, `skill`", "`ycoding.tool.subagent`, `.subagent-control`, `.todowrite`, `.question`, `.goal`, `.skill`", "Orchestration and Session control."],
            ],
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Disable web search two ways",
            code: `{
  // Remove the tool entirely:
  "plugins": ["-ycoding.tool.websearch"],
  // Or keep it registered but deny every call:
  "permissions": [{ "action": "websearch", "resource": "*", "effect": "deny" }],
}`,
          },
          {
            kind: "paragraph",
            text: "Custom tools come from a plugin using the Tool domain or an MCP server. `.ycoding/tool/*.ts` and `.ycoding/tools/*.ts` are not loaded.",
          },
        ],
      },
      {
        heading: "Resource limits",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: `{
  "shell": "/bin/zsh",
  "shell_sandbox": "optional",
  "shell_memory_limit_mb": 4096,
  "tool_output": { "max_lines": 2000, "max_bytes": 200000 },
  "attachments": {
    "image": { "auto_resize": true, "max_width": 2000, "max_height": 2000, "max_base64_bytes": 5242880 },
  },
  "watcher": { "ignore": ["node_modules/**", "dist/**"] },
}`,
          },
          {
            kind: "table",
            head: ["Field", "Type", "Default", "Description"],
            rows: [
              ["`shell_sandbox`", "`disabled` | `optional` | `required`", "unset", "Shell isolation policy."],
              ["`shell_memory_limit_mb`", "integer 0–1048576", "unset (unlimited)", "Default memory ceiling; the tool's `memory_limit_mb` input overrides it per call, and `0` means unlimited."],
              ["`tool_output.max_lines`", "positive integer", "`2000`", "Lines kept before truncation."],
              ["`tool_output.max_bytes`", "positive integer", "`51200`", "Bytes kept before truncation."],
              ["`attachments.image.auto_resize`", "boolean", "`true`", "Resize images that exceed the limits."],
              ["`attachments.image.max_width`, `.max_height`", "positive integer (px)", "`2000`", "Maximum image dimensions."],
              ["`attachments.image.max_base64_bytes`", "positive integer", "`5242880`", "Maximum encoded image size."],
              ["`watcher.ignore`", "string[]", "unset", "Paths the filesystem watcher ignores."],
            ],
          },
          {
            kind: "list",
            items: [
              "The shell tool's `timeout` input is capped at 600,000 ms; omission or `0` selects 600,000 ms. A foreground command still running after 300,000 ms moves to the background instead of being stopped.",
              "A finite memory limit sets `GOMEMLIMIT=<limit>MiB`, appends `--max-old-space-size=<limit>` to `NODE_OPTIONS`, and samples the command's process group every 250 ms on macOS and Linux, ending it with status `memory-limit`. It is resource control, not a security boundary.",
              "Windows rejects a finite shell memory limit.",
              "Truncated output keeps the head and tail around a marker; the full output is saved under `tool-output/` in the YCoding data directory.",
            ],
          },
        ],
      },
      {
        heading: "Formatters and language servers",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: `{
  "formatter": {
    "prettier": {
      "command": ["bun", "x", "prettier", "--write", "$FILE"],
      "extensions": [".ts", ".tsx"],
      "environment": { "NODE_ENV": "development" },
    },
  },
  "lsp": {
    "typescript": { "disabled": true },
  },
}`,
          },
          {
            kind: "list",
            items: [
              "`formatter` and `lsp` accept `true`, `false`, or a record of named entries.",
              "A formatter entry accepts `disabled`, `command`, `environment`, and `extensions`.",
              "An LSP entry is `{ \"disabled\": true }` or `{ command, extensions?, disabled?, env?, initialization? }`.",
            ],
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "Run `ycoding plugin list`: a removed tool plugin is absent. For a permission deny, the tool call fails with `Permission denied: <action>`. For memory limits, a command that exceeds the limit ends with status `memory-limit`.",
          },
          { kind: "related", slugs: ["configuration/permissions", "configuration/mcp", "usage/tui"] },
        ],
      },
    ],
  },
  {
    slug: "configuration/appearance",
    title: "Appearance",
    group: "Configuration",
    description: "Theme, keybindings, scroll behavior, transcript presentation, and terminal integration in cli.json.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Terminal preferences live in one global file, `cli.json` in the YCoding config directory (usually `~/.config/ycoding/cli.json`). It accepts JSONC and keeps your comments when the TUI updates a setting. There is no project-level `cli.json`.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "~/.config/ycoding/cli.json",
            code: `{
  "theme": { "name": "tokyonight", "mode": "dark" },
  "leader": { "timeout": 2000 },
  "keybinds": {
    "leader": "ctrl+x",
    "session_new": "<leader>n",
    "sidebar_toggle": "<leader>b",
    "app_toggle_animations": "none",
  },
  "scroll": { "speed": 1, "acceleration": true },
  "diffs": { "wrap": "word", "tree": true, "single": false, "view": "auto" },
  "session": { "sidebar": "auto", "scrollbar": true, "thinking": "show", "grouping": "auto" },
  "prompt": { "editor": true, "paste": "compact" },
  "terminal": { "title": true, "copy_on_select": true },
  "hints": { "onboarding": true },
  "mouse": true,
  "animations": true,
}`,
          },
        ],
      },
      {
        heading: "Options and defaults",
        blocks: [
          {
            kind: "table",
            head: ["Setting", "Type", "Default", "Description"],
            rows: [
              ["`theme.name`", "string", "`ycoding`", "Theme ID."],
              ["`theme.mode`", "`system` | `dark` | `light`", "unset (follows the terminal)", "`system` also follows the terminal."],
              ["`leader.timeout`", "positive integer (ms)", "`2000`", "How long the leader key waits for the next key."],
              ["`keybinds.<command>`", "string | `\"none\"` | `false` | array", "built-in map", "Override one binding; `\"none\"` or `false` unbinds it."],
              ["`scroll.speed`", "number ≥ 0.001", "unset", "Distance per scroll tick."],
              ["`scroll.acceleration`", "boolean", "unset", "Accelerate repeated scrolling."],
              ["`diffs.wrap`", "`word` | `none`", "unset", "Diff line wrapping."],
              ["`diffs.tree`, `diffs.single`", "boolean", "unset", "File tree and single-file patch view."],
              ["`diffs.view`", "`auto` | `split` | `unified`", "unset", "`auto` picks from terminal width."],
              ["`session.sidebar`", "`auto` | `hide`", "unset", "`auto` shows the rail when width permits."],
              ["`session.scrollbar`", "boolean", "unset", "Transcript scrollbar."],
              ["`session.thinking`", "`show` | `hide`", "unset", "Default reasoning visibility."],
              ["`session.grouping`", "`auto` | `none`", "unset", "Group related transcript items."],
              ["`prompt.editor`", "boolean", "unset", "Add the active editor file or selection as prompt context."],
              ["`prompt.paste`", "`compact` | `full`", "unset", "Large-paste presentation."],
              ["`terminal.title`", "boolean", "unset", "Update the terminal window title."],
              ["`terminal.copy_on_select`", "boolean", "`true` except Windows", "Copy a mouse selection when released."],
              ["`hints.onboarding`", "boolean", "unset", "Getting-started guidance."],
              ["`debug.devtools`, `debug.timing`", "boolean", "unset", "DevTools sidebar and first-draw timing."],
              ["`mouse`", "boolean", "`true`", "Terminal mouse capture."],
              ["`animations`", "boolean", "unset", "`false` disables interface animation."],
              ["`plugins`", "array of string | `{ package, options? }`", "unset", "Terminal-side plugins, separate from runtime `plugins`."],
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            title: "One bad value resets the file",
            text: "If `cli.json` has a syntax error or any value fails validation, for example `\"theme\": { \"mode\": \"auto\" }`, the whole file is treated as empty and every setting returns to its default.",
          },
        ],
      },
      {
        heading: "Themes and keybindings",
        blocks: [
          {
            kind: "list",
            items: [
              "Built-in themes include `ycoding`, `tokyonight`, `catppuccin`, `dracula`, `gruvbox`, `nord`, `one-dark`, `rosepine`, and `solarized`. Press `<leader>t` to list every available theme.",
              "Custom themes are JSON files directly under `themes/` in the global config directory or an ancestor `.ycoding/themes/`; the file name without `.json` is the theme ID. Later files with the same ID replace earlier ones, nearer project directories last.",
              "The default leader key is `ctrl+x`. Examples of bindings: `session_new` `<leader>n`, `session_list` `<leader>l`, `sidebar_toggle` `<leader>b`, `theme_list` `<leader>t`, `session_compact` `<leader>c`, `session_autonomy_normal` `<leader>y`.",
              "A binding string may list alternatives separated by commas, for example `\"ctrl+c,ctrl+d,<leader>q\"`.",
              "With a selection, `Ctrl+C` (or `Cmd+C` on macOS) copies instead of exiting, and `Esc` clears the selection.",
            ],
          },
        ],
      },
      {
        heading: "Verify it took effect",
        blocks: [
          {
            kind: "paragraph",
            text: "Press `<leader>t` to confirm the active theme is selected in the theme list, and press a rebound key to confirm its command runs. If a change is ignored and other settings also reverted to defaults, the file failed validation; check each value against the table above.",
          },
          { kind: "related", slugs: ["configuration/notifications", "usage/tui", "configuration"] },
        ],
      },
    ],
  },
]
