import type { DocBlock, DocPage } from "../types"

const surfaces: DocBlock = {
  kind: "table",
  head: ["Surface", "Files", "Scope"],
  rows: [
    ["Runtime", "`ycoding.json`, `ycoding.jsonc`, `.ycoding/ycoding.json`, `.ycoding/ycoding.jsonc`", "Models, agents, permissions, providers, plugins, MCP, commands, references, compaction, formatters, LSP."],
    ["Terminal", "`cli.json` in the YCoding config directory", "Theme, keybindings, notifications, prompt behavior, transcript presentation, mouse."],
    ["Managed service", "`service.json` or the channel-specific service file", "Background server hostname, port, and private password."],
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
    description: "Where YCoding configuration lives, which file wins, and the keys that are rejected.",
    sections: [
      {
        heading: "Configuration surfaces",
        blocks: [
          {
            kind: "paragraph",
            text: "YCoding reads three independent configuration surfaces. They do not substitute for each other.",
          },
          surfaces,
        ],
      },
      {
        heading: "Discovery and precedence",
        blocks: [
          {
            kind: "paragraph",
            text: "Runtime configuration is assembled from lowest to highest priority. For scalar values the latest document that defines the field wins; agents, commands, providers, permissions, and plugins merge with their own rules.",
          },
          {
            kind: "list",
            ordered: true,
            items: [
              "Global `ycoding.json`.",
              "Global `ycoding.jsonc`.",
              "The file named by `YCODING_CONFIG`, when set.",
              "Project `ycoding.json` and `ycoding.jsonc` from broad ancestors toward the current directory.",
              "`ycoding.json` and `ycoding.jsonc` inside ancestor `.ycoding` directories, from broad ancestors toward the current directory.",
              "Authenticated well-known integration configuration.",
              "`YCODING_CONFIG_CONTENT`, which has the highest priority.",
            ],
          },
          {
            kind: "paragraph",
            text: "Within one directory, `ycoding.jsonc` loads after `ycoding.json`. Project discovery walks upward from the current directory and is not limited to a detected project root. Set `YCODING_CONFIG_PROJECT_DISABLE` to disable it.",
          },
        ],
      },
      {
        heading: "JSON and JSONC behavior",
        blocks: [
          {
            kind: "list",
            items: [
              "`//` comments, trailing commas, and a `$schema` reference are accepted.",
              "Environment substitution uses `{env:NAME}`; a missing variable becomes an empty string.",
              "File substitution uses `{file:path}`, resolved relative to the containing document, with `~/` and absolute paths supported.",
              "Unknown properties are ignored by schema decoding instead of failing the document.",
            ],
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Substitution",
            code: '{\n  "username": "{env:USER}",\n  "providers": {\n    "example": {\n      "env": ["EXAMPLE_TOKEN"],\n    },\n  },\n}',
          },
        ],
      },
      {
        heading: "Rejected configuration keys",
        blocks: [
          {
            kind: "paragraph",
            text: "A document containing any rejected key is ignored as a whole, so a single stale key can disable an entire file. Warning logs name the exact keys.",
          },
          {
            kind: "code",
            language: "text",
            label: "Rejected keys",
            code: "logLevel, server, command, reference, snapshot, plugin, autoshare,\ndisabled_providers, enabled_providers, small_model, mode, agent,\nprovider, permission, tools, attachment, layout",
          },
          {
            kind: "callout",
            tone: "warning",
            title: "MCP shape",
            text: "Server names must be nested under `mcp.servers`. Declaring them directly under `mcp` is rejected.",
          },
        ],
      },
      {
        heading: "Top-level fields",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Purpose"],
            rows: [
              ["`model`", "Default model selector."],
              ["`default_agent`", "Selectable primary agent for a new session."],
              ["`shell`, `shell_sandbox`, `shell_memory_limit_mb`", "Shell selection, isolation policy, and default memory limit."],
              ["`permissions`", "Global ordered tool permission rules."],
              ["`agents`, `commands`, `skills`, `plugins`, `mcp`, `references`", "Customization domains."],
              ["`providers`", "Provider and model overrides."],
              ["`compaction`, `efficiency`, `experimental`", "Context, helper-model, and runtime policy."],
              ["`memory`, `ntfy`", "Knowledge memory and attention notifications."],
              ["`formatter`, `lsp`, `attachments`, `tool_output`, `watcher`", "Processing and output controls."],
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
    description: "Define and override primary agents and background subagents, their models, and their limits.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "An agent is configured behavior plus a model choice. Primary agents are selectable for the foreground session; subagents run as durable background child sessions.",
          },
        ],
      },
      {
        heading: "Minimal example",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: '{\n  "default_agent": "god",\n  "agents": {\n    "reviewer": {\n      "description": "Review changes without editing files",\n      "mode": "subagent",\n      "model": "openrouter/anthropic/claude-sonnet-4",\n      "color": "info",\n      "steps": 20,\n      "permissions": [{ "action": "edit", "resource": "**", "effect": "deny" }],\n    },\n  },\n}',
          },
        ],
      },
      {
        heading: "Options",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Meaning"],
            rows: [
              ["`model`", "Agent-specific model selector, with an optional variant."],
              ["`description`", "Picker and status description."],
              ["`mode`", "`primary`, `subagent`, or `all`."],
              ["`hidden`", "Hide the agent from normal selection."],
              ["`color`", "Semantic name or six-digit hex color for the terminal."],
              ["`steps`", "Step allowance for one prompt."],
              ["`disabled`", "Remove or disable the agent definition."],
              ["`permissions`", "Agent-specific permission rules, appended after global rules."],
              ["`system`", "System instruction; in Markdown agents this is the file body."],
              ["`request.headers`, `request.body`", "Provider request overlays."],
            ],
          },
        ],
      },
      {
        heading: "Markdown agents",
        blocks: [
          {
            kind: "paragraph",
            text: "Agents can also live in the repository. Files are discovered recursively under `agent` or `agents`, and the agent ID is the relative path without the extension.",
          },
          { kind: "code", language: "text", label: "Location and ID", code: ".ycoding/agents/backend/reviewer.md  ->  backend/reviewer" },
          {
            kind: "code",
            language: "markdown",
            label: ".ycoding/agents/reviewer.md",
            code: '---\ndescription: Reviews backend changes\nmode: subagent\ncolor: info\npermissions:\n  - action: read\n    resource: "**"\n    effect: allow\n  - action: edit\n    resource: "**"\n    effect: deny\n---\n\nReview the current change and report concrete defects.',
          },
        ],
      },
      {
        heading: "Defaults and interactions",
        blocks: [
          {
            kind: "list",
            items: [
              "When `default_agent` is omitted, the maintained `god` primary is used.",
              "An agent with the same ID updates an earlier or built-in definition; request objects merge and permission rules append.",
              "Global permission rules apply to every agent, and an agent cannot widen a permission ceiling set by its parent.",
              "Promoting any new user input resets the selected agent's step allowance.",
            ],
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
    description: "Model selectors, variants, declared capabilities, cost, and context limits.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "A model selector names the model a session or agent should use. Model entries add identity, request overlays, declared capabilities, cost, and limits for models that are not in the shared catalog.",
          },
        ],
      },
      {
        heading: "Minimal example",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "Model selector",
            code: '{\n  "model": "openrouter/anthropic/claude-sonnet-4",\n  "agents": { "reviewer": { "model": "openai/gpt-5" } },\n}',
          },
        ],
      },
      {
        heading: "Model entries",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "Declared model",
            code: '{\n  "providers": {\n    "example": {\n      "models": {\n        "example-large": {\n          "modelID": "example-large-2026",\n          "family": "example",\n          "name": "Example Large",\n          "capabilities": { "tools": true, "input": ["text", "image"], "output": ["text"] },\n          "limit": { "context": 200000, "output": 32000 },\n          "variants": [{ "id": "fast", "settings": { "reasoning": "low" } }]\n        }\n      }\n    }\n  }\n}',
          },
          {
            kind: "list",
            items: [
              "`modelID` is the identifier the provider receives; the catalog key is the selector name.",
              "`capabilities.tools` declares tool calling, and `capabilities.input`/`output` declare modalities.",
              "Variants add named request settings, headers, or body overlays for one model.",
              "`cost` and `limit` feed context budgeting and usage reporting.",
            ],
          },
        ],
      },
      {
        heading: "Switching models in a session",
        blocks: [
          {
            kind: "paragraph",
            text: "Selecting another model interrupts active requests and tools, waits for settlement, and checks the target model's context budget before committing. If needed it joins compaction or admits one additional target-budget compaction. Interrupted work is not replayed, and raw history is retained.",
          },
          {
            kind: "callout",
            tone: "info",
            title: "Refused switches",
            text: "If context still cannot fit the target, the switch is refused: nothing changes and you can summarize first.",
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
    description: "Provider entries, credential variable names, request overlays, and named credential profiles.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "A provider entry describes how to reach a model provider and which environment variables hold its credentials. Credential values are never written into configuration files.",
          },
        ],
      },
      {
        heading: "Minimal example",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: '{\n  "providers": {\n    "example": {\n      "name": "Example",\n      "env": ["EXAMPLE_API_KEY"],\n      "models": { "example-large": { "name": "Example Large" } },\n    },\n  },\n}',
          },
        ],
      },
      {
        heading: "Options",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Meaning"],
            rows: [
              ["`env`", "Names of credential environment variables. Never put credential values here."],
              ["`name`", "Display name override."],
              ["`package`", "Provider implementation override."],
              ["`settings`, `headers`, `body`", "Provider-level request overlays."],
              ["`models`", "Model entries with identity, overlays, capabilities, variants, cost, and limits."],
            ],
          },
        ],
      },
      {
        heading: "Profiles",
        blocks: [
          {
            kind: "paragraph",
            text: "One provider can hold several named profiles: multiple accounts or API keys. A profile is the user-facing name of a stored credential. Connecting asks for that name, and reusing a name updates that profile instead of replacing the provider's credentials.",
          },
          {
            kind: "list",
            items: [
              "Exactly one profile per provider is active; it is the credential a model request resolves and the one usage reporting describes.",
              "Switching the active profile keeps the others, and removing the active profile promotes the remaining one.",
              "The active profile appears above the provider in the context sidebar; a provider with a single profile keeps the plain `provider/model` label.",
            ],
          },
        ],
      },
      {
        heading: "Related",
        blocks: [{ kind: "related", slugs: ["configuration/models", "usage/cli", "troubleshooting"] }],
      },
    ],
  },
  {
    slug: "configuration/plugins",
    title: "Plugins",
    group: "Configuration",
    description: "Add, order, configure, and remove runtime plugins, and how hooks are registered.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Plugins extend runtime domains: they can register tools, hooks, agents, commands, skills, integrations, references, provider transforms, and session behavior.",
          },
        ],
      },
      {
        heading: "Minimal example",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: '{\n  "plugins": [\n    "ycoding.some-built-in",\n    { "package": "@example/ycoding-plugin", "options": { "strict": true } },\n    "./.ycoding/plugins/local.ts",\n    "-ycoding.unwanted-plugin",\n  ],\n}',
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
              "Local plugin files are auto-discovered from `.ycoding/plugin/*.ts|js` and `.ycoding/plugins/*.ts|js`; nested files are not discovered.",
              "A string entry adds a built-in ID, package, or file path.",
              "`{ package, options }` adds a plugin with options.",
              "A leading `-` disables or removes a matching plugin ID.",
              "`*` and `<prefix>.*` selectors match several plugins.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            title: "Hooks belong to plugins",
            text: "There is no top-level `hooks` configuration key. Plugins register hooks for the AI SDK, session, and tool domains.",
          },
        ],
      },
      {
        heading: "Example plugin",
        blocks: [
          {
            kind: "code",
            language: "ts",
            label: ".ycoding/plugins/project.ts",
            code: 'import { define } from "@ycoding-ai/plugin/effect/plugin"\nimport { Effect } from "effect"\n\nexport default define({\n  id: "company.project-policy",\n  effect: Effect.fn(function* (context) {\n    // register tools, hooks, or agents on `context`\n  }),\n})',
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
    description: "Configure local and remote Model Context Protocol servers, timeouts, and OAuth.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "MCP servers add external tools, prompts, and resources to a session. Servers can run as a local process or connect to a remote endpoint.",
          },
        ],
      },
      {
        heading: "Minimal example",
        blocks: [
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: '{\n  "mcp": {\n    "servers": {\n      "docs": {\n        "type": "local",\n        "command": ["bun", "run", "./tools/mcp.ts"],\n        "cwd": ".",\n        "codemode": true,\n      },\n      "remote": {\n        "type": "remote",\n        "url": "https://mcp.example.com",\n        "headers": { "Authorization": "Bearer {env:MCP_TOKEN}" },\n      },\n    },\n  },\n}',
          },
        ],
      },
      {
        heading: "Options and defaults",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Meaning"],
            rows: [
              ["local `command`", "Required command and arguments for a stdio server."],
              ["local `cwd`, `environment`", "Working directory and environment additions."],
              ["remote `url`, `headers`", "Endpoint and request headers."],
              ["`codemode`", "Expose the server's catalog through Code Mode. Defaults to enabled."],
              ["`disabled`", "Skip a configured server without deleting it."],
              ["`timeout`", "Per-server overrides for the startup, catalog, and execution phases."],
              ["`oauth`", "OAuth configuration, or `false` to disable it. Fields are `client_id`, `client_secret`, `scope`, `callback_port`, and `redirect_uri`."],
            ],
          },
          {
            kind: "table",
            head: ["Phase", "Default"],
            rows: [
              ["Transport startup and initialization", "30 seconds"],
              ["Catalog discovery such as `tools/list`", "30 seconds"],
              ["Tool and prompt execution", "12 hours"],
            ],
          },
        ],
      },
      {
        heading: "Status and troubleshooting",
        blocks: [
          {
            kind: "table",
            head: ["Status", "Meaning"],
            rows: [
              ["`pending`", "The transport is starting or the catalog is still loading."],
              ["`connected`", "Initialization and the first `tools/list` completed."],
              ["`disabled`", "Disabled by configuration or disconnected for this run."],
              ["`needs_auth`, `needs_client_registration`", "The remote server requires its OAuth flow."],
              ["`failed`", "Startup, initialization, or catalog discovery failed; open the MCP dialog for the error."],
            ],
          },
          {
            kind: "callout",
            tone: "tip",
            title: "Slow package launchers",
            text: "A first run through a package manager may need a larger startup or catalog timeout than the default.",
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
    description: "Set one objective, how continuation works, and how goals terminate.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "A goal is a durable objective that keeps a session working until it completes, you stop it, or it exhausts its no-progress budget. You own the objective text: ordinary prompts and agent tools cannot replace it.",
          },
          { kind: "code", language: "text", label: "Prompts", code: "/goal <text>   create or replace the objective\n/goal          stop an active goal, resume a retained one, or ask for text" },
        ],
      },
      {
        heading: "Model configuration",
        blocks: [
          {
            kind: "paragraph",
            text: "Goal calculation always uses a model. The hidden goal agent's explicit model wins, then the configured helper selection, then the session model.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "Choose the goal model and prompt",
            code: '{\n  "agents": {\n    "goal": {\n      "model": "openai/gpt-5",\n      "system": "Restate the objective as verifiable work.",\n    },\n  },\n  "efficiency": {\n    "helper_models": { "goal": "openai/gpt-5-mini" },\n  },\n}',
          },
          {
            kind: "callout",
            tone: "info",
            title: "Failed calculation changes nothing",
            text: "If the configured model is unavailable or the response is empty, the previous goal and your draft are preserved. Raw text is never activated silently.",
          },
        ],
      },
      {
        heading: "Continuation and terminal states",
        blocks: [
          {
            kind: "list",
            items: [
              "The agent reports only blockers, each of which consumes one no-progress attempt; progress alone does not reset the consumed budget.",
              "A successful settled execution advances the durable iteration and admits the next continuation without a report.",
              "Active background work blocks automatic continuation: unfinished work is not a no-progress attempt.",
              "Terminal states are `completed`, `stopped`, and `exhausted`.",
            ],
          },
        ],
      },
      {
        heading: "Related",
        blocks: [{ kind: "related", slugs: ["configuration/yolo", "configuration/guardrails", "usage/sessions"] }],
      },
    ],
  },
  {
    slug: "configuration/yolo",
    title: "YOLO mode",
    group: "Configuration",
    description: "What each autonomous level answers, how descendants inherit it, and what never becomes automatic.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "table",
            head: ["Level", "Answers automatically"],
            rows: [
              ["`0`", "Nothing. Every question, permission request, and guardrail review needs a reply."],
              ["`1`", "Questions and deterministic forms."],
              ["`2`", "Level 1 plus `ask` permission decisions."],
              ["`3`", "Level 2 plus ordinary guardrail reviews."],
            ],
          },
          {
            kind: "paragraph",
            text: "An active goal also answers questions, forms, and `ask` permissions at level 0, but guardrail reviews still require level 3. Explicit deny rules and inherited permission ceilings remain enforced at every level.",
          },
        ],
      },
      {
        heading: "Setting the level",
        blocks: [
          { kind: "code", language: "sh", label: "Non-interactive", code: "ycoding run --yolo 2 \"Regenerate the client and run its tests\"" },
          {
            kind: "list",
            items: [
              "Omitting the flag preserves an adopted session's autonomy; `--yolo 0` explicitly selects manual handling.",
              "A child session inherits the maximum effective level from its ancestors.",
              "A failed autonomy update prevents prompt admission rather than running under the wrong level.",
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
              "Hard guardrail reviews always require a fresh human decision, at every level, and cannot reuse an approval.",
              "Non-interactive runs never approve locally; unresolved requests fail the run.",
              "The rail reports guardrails as automatic only at effective level 3 and as enforced otherwise.",
            ],
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
    description: "Session-family safety reviews, concurrency caps, and custom rule files.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Guardrails review high-impact actions across a root session and all of its subagents, independently of tool permissions. Shell commands, file edits, writes, patches, subagent launches, mutation-capable MCP tools, and project-artifact changes all pass through the same service.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: '{\n  "guardrails": {\n    "enabled": true,\n    "max_concurrent_shells": 8,\n    "max_concurrent_subagents": 8,\n    "max_pending_reviews": 16,\n  },\n}',
          },
        ],
      },
      {
        heading: "Options and defaults",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Default", "Meaning"],
            rows: [
              ["`guardrails.enabled`", "`true`", "Enable the guardrail service. A standard catastrophic deny is not overridable."],
              ["`guardrails.max_concurrent_shells`", "`8`", "Running-shell cap for one root session family."],
              ["`guardrails.max_concurrent_subagents`", "`8`", "Running-subagent cap for one root session family."],
              ["`guardrails.max_pending_reviews`", "`16`", "Pending-review cap for one root session family."],
            ],
          },
        ],
      },
      {
        heading: "Custom rule files",
        blocks: [
          {
            kind: "paragraph",
            text: "Custom rules are direct `guardrails/*.md` children of the global config directory and of each discovered repository configuration directory. Nested directories are not scanned.",
          },
          {
            kind: "code",
            language: "markdown",
            label: ".ycoding/guardrails/aws.md",
            code: '---\nid: aws-deny-destructive\nenabled: true\ndecision: deny\nactions: ["shell"]\nresources: ["aws * delete-*", "aws * terminate-*"]\nreason: Destructive AWS operations need a human\nauto-approve: false\npriority: 10\n---\n\nThe operator note below is for humans; only the frontmatter is evaluated.\n\nAsk an operator before deleting or terminating AWS resources.',
          },
          {
            kind: "list",
            items: [
              "Fields are `id`, `enabled`, `decision` (`allow`, `ask`, or `deny`), `actions`, `resources`, `reason`, and `priority`.",
              "Nearest repository layer decides first, then broader repositories, then the global directory.",
              "Within one layer, rules sort by descending priority and then by file path and rule ID.",
              "An enabled but invalid file fails mutation actions closed with a review.",
            ],
          },
        ],
      },
      {
        heading: "Replies and approvals",
        blocks: [
          {
            kind: "table",
            head: ["Reply", "Effect"],
            rows: [
              ["`once`", "Settle this single review. Not reusable."],
              ["`always`", "Reuse for the exact action, rules, and resources in this process after a fresh evaluation still asks."],
              ["`reject`", "Deny the action."],
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            title: "Hard reviews",
            text: "A hard review accepts only one-time approval or rejection. Autonomy, disabled optional guardrails, custom allow rules, and earlier approvals cannot settle it.",
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
    description: "Attention categories, sounds, and the optional ntfy delivery tool.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Notifications ask for your attention when work needs a human decision: an unresolved permission, question, guardrail review, an error, or session completion. Terminal presentation lives in `cli.json`; remote delivery uses the optional ntfy tool.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "cli.json",
            code: '{\n  "attention": {\n    "enabled": true,\n    "notifications": true,\n    "sound": true,\n    "volume": 0.4,\n    "sound_pack": "ycoding.default",\n  },\n}',
          },
        ],
      },
      {
        heading: "Options and defaults",
        blocks: [
          {
            kind: "table",
            head: ["Setting", "Default", "Meaning"],
            rows: [
              ["`attention.enabled`", "`true`", "Master switch for attention alerts."],
              ["`attention.notifications`", "`true`", "System notifications."],
              ["`attention.sound`", "`true`", "Attention sounds."],
              ["`attention.volume`", "`0.4`", "Sound volume from 0 to 1."],
              ["`attention.sound_pack`", "`ycoding.default`", "Active sound pack."],
              ["`attention.sounds.<event>`", "unset", "Per-event sound override."],
            ],
          },
          {
            kind: "paragraph",
            text: "Sound events are `default`, `question`, `permission`, `error`, `done`, and `subagent_done`.",
          },
        ],
      },
      {
        heading: "Remote attention with ntfy",
        blocks: [
          {
            kind: "paragraph",
            text: "The built-in ntfy tool posts one plain-text attention message to a topic you choose. It is disabled by default and requests permission for the external write.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: '{\n  "ntfy": {\n    "enabled": true,\n    "topic": "project-attention",\n  },\n}',
          },
          {
            kind: "list",
            items: [
              "Automatic lifecycle delivery waits 500 ms for a request to resolve, sends at most once, and posts only when the effective permission already allows it.",
              "Automatic delivery never opens a permission prompt; explicit tool calls keep ordinary permission behavior.",
              "Routine progress, retries, and background updates do not notify. Blockers, unresolved human input, and verified completion do.",
            ],
          },
        ],
      },
      {
        heading: "Related",
        blocks: [{ kind: "related", slugs: ["configuration/appearance", "usage/remote", "configuration/guardrails"] }],
      },
    ],
  },
  {
    slug: "configuration/permissions",
    title: "Permissions",
    group: "Configuration",
    description: "Ordered tool rules, the three effects, evaluation order, and inherited ceilings.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Permissions decide whether a tool action is allowed, denied, or needs a question. Rules are evaluated in order, and the first matching rule decides.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "ycoding.jsonc",
            code: '{\n  "permissions": [\n    { "action": "read", "resource": "**", "effect": "allow" },\n    { "action": "edit", "resource": "src/**", "effect": "ask" },\n    { "action": "external_directory", "resource": "~/secrets/**", "effect": "deny" },\n  ],\n}',
          },
        ],
      },
      {
        heading: "Rule shape",
        blocks: [
          {
            kind: "table",
            head: ["Field", "Meaning"],
            rows: [
              ["`action`", "Tool action name, for example `read`, `edit`, `shell`, `external_directory`, or `mcp_execute`."],
              ["`resource`", "Resource pattern such as a path glob, command prefix, or URL pattern."],
              ["`effect`", "`allow`, `deny`, or `ask`."],
            ],
          },
          {
            kind: "list",
            items: [
              "Home-directory expansion applies to path resources for `external_directory`, `read`, and `edit`. It does not rewrite shell command text.",
              "Global rules apply to every agent; agent rules are appended in source order.",
              "A subagent inherits a permission ceiling from its parent and cannot widen it.",
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
              ["Ordinary mode", "`ask` rules surface a request that waits for your reply."],
              ["YOLO 2 or higher", "`ask` requests are answered automatically."],
              ["Active goal", "`ask` requests and questions are answered automatically."],
              ["Deny rule", "Always denied, at every level."],
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            title: "Permissions are not guardrails",
            text: "Approving a guardrail review never widens a permission denial, and approving a permission never bypasses a guardrail review.",
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
    description: "Tool surfaces, output truncation, shell resource limits, and attachment handling.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Tools are what the agent can do in your environment. Each tool action is checked against ordered permission rules, and mutation-capable actions also pass through guardrails.",
          },
          {
            kind: "table",
            head: ["Surface", "Examples"],
            rows: [
              ["Files", "Read, write, edit, patch, and directory-scoped file search."],
              ["Shell", "Foreground commands with a finite timeout, memory limit, and background handoff."],
              ["Web", "Page fetch and web search through the configured provider."],
              ["Browser", "Selected shared tabs through the Chrome bridge, or a session-owned isolated browser."],
              ["Desktop", "Native macOS operations for exact iTerm sessions and Finder paths."],
              ["Knowledge", "Explicit workspace memory reads, writes, search, and offline graph export."],
              ["Orchestration", "Subagent launch and control, plus session todos."],
            ],
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
            code: '{\n  "shell": "/bin/zsh",\n  "shell_memory_limit_mb": 4096,\n  "tool_output": { "max_lines": 2000, "max_bytes": 200000 },\n  "attachments": {\n    "image": { "auto_resize": true, "max_width": 2048, "max_height": 2048 },\n  },\n}',
          },
          {
            kind: "list",
            items: [
              "A shell command timeout is bounded to 600,000 ms. A foreground command still running after 300,000 ms moves to the background instead of being stopped.",
              "`shell_memory_limit_mb` supplies Go and Node runtime hints and samples aggregate resident memory; it is resource control, not a security boundary.",
              "Windows rejects a finite shell memory limit because the current process abstraction cannot assign a job object before the command starts.",
              "Tool output is truncated at the configured line and byte thresholds, keeping the terminal responsive.",
            ],
          },
        ],
      },
      {
        heading: "Related",
        blocks: [{ kind: "related", slugs: ["configuration/permissions", "configuration/mcp", "usage/tui"] }],
      },
    ],
  },
  {
    slug: "configuration/appearance",
    title: "Appearance",
    group: "Configuration",
    description: "Theme, keybindings, scroll behavior, transcript presentation, and terminal integration.",
    sections: [
      {
        heading: "What it controls",
        blocks: [
          {
            kind: "paragraph",
            text: "Terminal preferences live in one global `cli.json`. The file accepts JSONC and keeps your comments when the terminal updates a setting.",
          },
          {
            kind: "code",
            language: "jsonc",
            label: "cli.json",
            code: '{\n  "theme": { "name": "ycoding", "mode": "dark" },\n  "leader": { "timeout": 2000 },\n  "scroll": { "speed": 1, "acceleration": true },\n  "diffs": { "wrap": "word", "tree": true, "view": "auto" },\n  "session": { "sidebar": "auto", "thinking": "show", "grouping": "auto" },\n  "terminal": { "title": true, "copy_on_select": true },\n  "mouse": true,\n  "animations": true,\n}',
          },
        ],
      },
      {
        heading: "Options and defaults",
        blocks: [
          {
            kind: "table",
            head: ["Setting", "Default", "Meaning"],
            rows: [
              ["`theme.name`", "unset", "Discovered theme ID."],
              ["`theme.mode`", "unset", "`system`, `dark`, or `light`. `system` follows the terminal."],
              ["`leader.timeout`", "`2000` ms", "How long the leader key waits for the next key."],
              ["`mouse`", "`true`", "Terminal mouse capture."],
              ["`terminal.copy_on_select`", "`true` except Windows", "Copy a mouse selection when it is released."],
              ["`session.sidebar`", "unset", "`auto` shows the rail when width permits."],
              ["`session.thinking`", "unset", "Default reasoning visibility: `show` or `hide`."],
              ["`diffs.view`", "unset", "`auto`, `split`, or `unified`; `auto` selects from terminal width."],
              ["`prompt.paste`", "unset", "`compact` or `full` presentation for large pastes."],
            ],
          },
        ],
      },
      {
        heading: "Themes and keybindings",
        blocks: [
          {
            kind: "list",
            items: [
              "Custom themes are JSON files direct under `themes/` in the global config directory or `.ycoding/themes/`; the file name without `.json` is the theme ID.",
              "Later files with the same ID replace earlier ones.",
              "`keybinds` maps command names to key sequences and overrides the built-in map.",
              "Copy-on-select consumes the copy gesture: with a selection, pressing the copy key copies instead of exiting, and Escape clears the selection.",
            ],
          },
          {
            kind: "callout",
            tone: "tip",
            title: "Reduced motion",
            text: "`animations: false` disables terminal animation for users who prefer reduced motion.",
          },
          { kind: "related", slugs: ["configuration/notifications", "usage/tui", "configuration"] },
        ],
      },
    ],
  },
]
