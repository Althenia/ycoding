# Repository resources

Status: **implemented**

YCoding discovers repository-owned resources from `.ycoding` directories while walking upward from the current working directory. Broader ancestor directories load before nearer directories, so nearer resource definitions override or extend earlier definitions according to their domain rules.

The same directory structure is supported globally under the YCoding configuration directory.

## Supported resource tree

```text
.ycoding/
├── ycoding.json
├── ycoding.jsonc
├── agent/
│   └── reviewer.md
├── agents/
│   └── backend/
│       └── architect.md
├── command/
│   └── review.md
├── commands/
│   └── release/
│       └── verify.md
├── skill/
│   └── incident-response.md
├── skills/
│   └── backend-practices/
│       └── SKILL.md
├── plugin/
│   └── project.ts
├── plugins/
│   └── policy.js
├── guardrails/
│   └── production.md
└── themes/
    └── company-dark.json
```

Supported project resource domains are:

- runtime configuration;
- agents;
- commands;
- skills;
- runtime plugins and hooks;
- terminal themes.
- custom guardrail rule files.

There is no generic `.ycoding/tool` loader. Custom tools must be provided by a plugin or MCP server.

There is no supported project `.ycoding/tui.json`. Terminal preferences are global in `cli.json`.

## Discovery boundaries and priority

YCoding discovers:

- every ancestor `ycoding.json` and `ycoding.jsonc`;
- every ancestor `.ycoding` directory;
- every ancestor `.claude` and `.agents` directory for skill compatibility;
- the global YCoding config directory;
- global `~/.claude` and `~/.agents` skill directories when present.

Runtime config document order is documented in [`configuration.md`](./configuration.md#runtime-configuration-discovery-and-precedence).

Resource-specific rules:

| Resource   | Discovery                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Agents     | Recursive `agent/**/*.md` and `agents/**/*.md` inside YCoding config directories.                                             |
| Commands   | Recursive `command/**/*.md` and `commands/**/*.md` inside YCoding config directories.                                         |
| Skills     | Root `*.md` and recursive `**/SKILL.md` under each skill source.                                                              |
| Plugins    | Direct children only: `plugin/*.{ts,js}` and `plugins/*.{ts,js}`.                                                             |
| Themes     | Direct `themes/*.json` files.                                                                                                 |
| Guardrails | Direct children only: `guardrails/*.md` under the global config directory and every discovered repository `Config.Directory`. |

A resource file must parse and validate successfully. Invalid files are skipped rather than partially loaded.

## Guardrail custom-file location

`guardrails/*.md` contains direct-child custom rule files under the global YCoding config directory and every discovered repository `Config.Directory`. Nested directories are not scanned. Repository source layers evaluate from the nearest directory to broader ancestors, followed by the global directory. Within one source layer, rules sort by descending numeric priority and then deterministic lexical file path and rule ID.

Each enabled file is one YAML-frontmatter rule with an operator-facing Markdown explanation body. The fields are `id` (non-empty string), `enabled` (boolean, default `true`), `decision` (`allow` \| `ask` \| `deny`), non-empty `actions` and `resources` pattern arrays, `reason` (non-empty string), and `priority` (integer, default `0`). The first matching custom source layer decides after any catastrophic standard deny and before standard review or allow behavior. Enabled invalid configuration fails mutation actions closed with review while preserving its source-layer position. See [`guardrails-and-provider-usage.md`](./guardrails-and-provider-usage.md#custom-guardrails) for reply and notification behavior.

## Custom-file contract index

The detailed sections below are authoritative. This index makes scope, recursion, ID derivation, body handling, and omitted-field behavior explicit in one place. `unset` means the field is optional; it does not imply a default that is not verified by a runtime consumer.

| Resource             | Global and repository paths                                                                                                                                   | Recursion / ID                                                                                                                               | Body and fields                                                                                                                                                                                      | Merge, defaults, and remarks                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents               | `<global config>/agent/**/*.md`, `<global config>/agents/**/*.md`; `.ycoding/agent/**/*.md`, `.ycoding/agents/**/*.md`                                        | Recursive. ID is the path below `agent` or `agents` without `.md`.                                                                           | Markdown body is `system`. Frontmatter: `model`, `request.headers`, `request.body`, `description`, `mode` (`subagent` \| `primary` \| `all`), `hidden`, `color`, `steps`, `disabled`, `permissions`. | Same ID updates the earlier or built-in definition; request objects merge and permission rules append. Every frontmatter field is unset when omitted; the body is optional.              |
| Commands             | `<global config>/command/**/*.md`, `<global config>/commands/**/*.md`; `.ycoding/command/**/*.md`, `.ycoding/commands/**/*.md`                                | Recursive. Name is the path below `command` or `commands` without `.md`.                                                                     | Markdown body is required `template`. Frontmatter: `description`, `agent`, `model`, `subtask`.                                                                                                       | Configured or Markdown command with the same name wins over an MCP prompt. Every frontmatter field is unset when omitted.                                                                |
| Skills               | `<global config>/skill` and `skills`; ancestor `.ycoding/skill` and `skills`; compatible `.claude/skills`, `.agents/skills`; configured local/HTTP(S) sources | Direct root `*.md` or recursive `**/SKILL.md`. Root-file ID is filename; `SKILL.md` ID is its directory.                                     | Markdown is the skill content. Frontmatter: `name`, `description`, `slash`, `metadata`; recognized metadata includes `ycoding/slash`, `ycoding/autoinvoke`, and conflict lists.                      | `name` defaults to the ID. Other fields are unset when omitted. Compatibility roots contribute skills only and are re-read on demand.                                                    |
| Plugins              | `<global config>/plugin/*.{ts,js}`, `<global config>/plugins/*.{ts,js}`; equivalent `.ycoding` paths                                                          | Direct children only; nested files are not auto-discovered. Plugin identity is supplied by its exported plugin definition.                   | TypeScript or JavaScript module; options come from JSON `{ package, options }`.                                                                                                                      | JSON directives run after auto-discovered files and can remove exact, `*`, or `<prefix>.*` IDs. There is no Markdown body or frontmatter format.                                         |
| Themes               | `<global config>/themes/*.json`; `.ycoding/themes/*.json`                                                                                                     | Direct children only. ID is filename without `.json`.                                                                                        | Theme JSON shape is owned by `packages/ui/src/theme/theme.schema.json`.                                                                                                                              | Global, broad ancestor, then nearer project files load in order; later equal IDs replace earlier files.                                                                                  |
| Ambient instructions | `<global config>/AGENTS.md`; project-root-to-current-directory `AGENTS.md` files                                                                              | Direct `AGENTS.md` file at each discovered level; no recursive filename glob. There is no derived instruction ID exposed as a resource name. | Whole file is instruction content, truncated per `instruction_max_bytes`.                                                                                                                            | Broader context precedes narrower context. Top-level JSON `instructions` is Schema-accepted but is not a current discovery source.                                                       |
| Guardrails           | `<global config>/guardrails/*.md`; each discovered repository `Config.Directory` `/guardrails/*.md`                                                           | Direct children only; one file is one rule and its `id` comes from frontmatter.                                                              | Body is operator-facing explanation. Frontmatter is `id`, `enabled`, `decision` (`allow` \| `ask` \| `deny`), `actions`, `resources`, `reason`, `priority`.                                          | `enabled` defaults to `true`; `priority` defaults to `0`. Nearest repository layer, then broader repository, then global. See the dedicated guardrail document for reply/reuse behavior. |

## Agents

Agents can be declared in JSON configuration or Markdown files.

### Markdown location and ID

Files are discovered recursively under `agent` or `agents`.

```text
.ycoding/agents/backend/reviewer.md
```

The agent ID is the relative path without the leading directory or `.md` suffix:

```text
backend/reviewer
```

### Markdown format

YAML frontmatter supplies agent fields. The Markdown body becomes the agent system prompt.

```markdown
---
description: Reviews backend changes for correctness and maintainability
mode: subagent
model: openrouter/anthropic/claude-sonnet-4
color: info
steps: 20
hidden: false
permissions:
  - action: read
    resource: "**"
    effect: allow
  - action: edit
    resource: "**"
    effect: deny
---

Review the current change against repository contracts.
Report concrete defects with file and symbol evidence.
Do not edit files.
```

Supported frontmatter fields:

| Field             | Type                         | Meaning                                    |
| ----------------- | ---------------------------- | ------------------------------------------ |
| `model`           | model selector               | Agent-specific model and optional variant. |
| `request.headers` | record                       | Provider request headers.                  |
| `request.body`    | JSON record                  | Provider request body overlay.             |
| `description`     | string                       | Picker and status description.             |
| `mode`            | `subagent`, `primary`, `all` | Availability and intended use.             |
| `hidden`          | boolean                      | Hide from normal selection.                |
| `color`           | semantic name or `#RRGGBB`   | TUI presentation color.                    |
| `steps`           | positive integer             | Agent step limit.                          |
| `disabled`        | boolean                      | Remove or disable this agent definition.   |
| `permissions`     | permission rules             | Agent-specific permission additions.       |

The body is stored as `system`.

### Merge behavior

- Global permission rules are applied to every agent.
- An agent with the same ID updates the existing built-in or earlier definition.
- `disabled: true` removes the agent.
- Request headers and body objects are merged.
- Permission rules are appended in source order.
- A Markdown agent records its source file as an allowed agent location.

`default_agent` is configured in JSON, not Markdown frontmatter.

### Primary versus subagent

- `primary`: selectable as the foreground Session agent.
- `subagent`: intended for background child Sessions and not selectable as a primary agent.
- `all`: available in both contexts.

An omitted mode preserves a built-in mode or uses the runtime default for a new agent.

## Commands

Commands can be declared in JSON or Markdown files.

### Markdown location and name

```text
.ycoding/commands/release/verify.md
```

The slash-command name is:

```text
release/verify
```

### Markdown format

Frontmatter supplies command options. The body becomes the command template.

```markdown
---
description: Verify the release candidate
agent: reviewer
model: openrouter/anthropic/claude-sonnet-4
subtask: true
---

Inspect the current release diff.
Run the owning verification commands.
Report exact failures and evidence.

User arguments: $ARGUMENTS
```

Supported fields:

| Field         | Type           | Meaning                               |
| ------------- | -------------- | ------------------------------------- |
| `description` | string         | Command picker description.           |
| `agent`       | string         | Agent selected for command execution. |
| `model`       | model selector | Model override.                       |
| `subtask`     | boolean        | Execute as a subtask where supported. |

The body is required because it supplies `template`.

Commands may use the runtime command-template features supported by `packages/core/src/command.ts`, including argument text and shell interpolation. Treat shell interpolation as real shell execution under the selected permission policy.

MCP prompts also appear as commands. A configured or Markdown command with the same name takes priority over an MCP prompt.

## Skills

Skills are reusable instruction bundles discovered from local directories or configured HTTP(S) sources.

### Sources

YCoding adds skill sources from:

- `<global config>/skill`;
- `<global config>/skills`;
- every ancestor `.ycoding/skill`;
- every ancestor `.ycoding/skills`;
- `~/.claude/skills` and ancestor `.claude/skills`;
- `~/.agents/skills` and ancestor `.agents/skills`;
- each local path or HTTP(S) URL in the runtime `skills` array.

`.claude` and `.agents` are compatibility skill roots only. They do not define YCoding agents or commands.

### Supported layouts

A skill source supports either:

```text
skills/
└── incident-response.md
```

or:

```text
skills/
└── incident-response/
    └── SKILL.md
```

For a root Markdown file, the skill ID is the filename. For `SKILL.md`, the skill ID is the containing directory name.

### Skill format

```markdown
---
name: Incident Response
description: Diagnose production incidents with evidence-first triage
slash: true
metadata:
  ycoding/autoinvoke: false
  ycoding/slash: true
  ycoding/conflicts:
    skills:
      - destructive-recovery
    instructions:
      - emergency-readonly
---

# Incident Response

Establish impact, timeline, and current state before proposing changes.
Collect logs and runtime evidence at each component boundary.
```

Frontmatter fields:

| Field         | Type    | Meaning                                  |
| ------------- | ------- | ---------------------------------------- |
| `name`        | string  | Display name; defaults to the skill ID.  |
| `description` | string  | Picker and status description.           |
| `slash`       | boolean | Expose as slash-invokable.               |
| `metadata`    | object  | YCoding-specific and arbitrary metadata. |

YCoding metadata keys:

- `ycoding/slash`: boolean or string `"true"`/`"false"`; overrides `slash`;
- `ycoding/autoinvoke`: boolean or string; controls automatic activation eligibility;
- `ycoding/conflicts.skills`: conflicting skill IDs;
- `ycoding/conflicts.instructions`: conflicting instruction IDs.

A malformed `ycoding/conflicts` declaration causes that skill file to be skipped.

### Loading and reload

Directory skill files are read whenever the skill list is requested. This avoids stale skill content in ecosystem roots that are not watched.

HTTP(S) sources are pulled and their resolved directories are memoized for the current Location lifetime.

Skill availability is filtered through the selected agent's `skill` permission rules.

## Plugins

Plugins extend runtime domains and can register tools, hooks, agents, commands, skills, integrations, references, provider transforms, and Session behavior.

### Auto-discovered files

Project and global YCoding config directories auto-discover direct files only:

```text
.ycoding/plugin/project.ts
.ycoding/plugins/policy.js
```

Nested files are not auto-discovered.

### Effect plugin

```ts
import { define } from "@ycoding-ai/plugin/effect/plugin"
import { Effect } from "effect"

export default define({
  id: "company.project-policy",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.tool.transform((draft) => {
      // Register or modify declared tool behavior.
    })
  }),
})
```

The Effect plugin function runs in a managed Scope. Registrations are cleaned up when the plugin is reloaded or disabled.

### Promise plugin

```ts
import { define } from "@ycoding-ai/plugin/promise/plugin"

export default define({
  id: "company.project-policy",
  async setup(ctx) {
    // Register Promise-plugin behavior.
    return async () => {
      // Optional cleanup.
    }
  },
})
```

### Plugin context

Current plugin domains are:

- `agent`;
- `aisdk`;
- `catalog`;
- `command`;
- `event`;
- `integration`;
- `plugin` Client API;
- `reference`;
- `session`;
- `skill`;
- `tool`.

Plugin options come from `{ package, options }` configuration entries.

### Ordered enablement and removal

Runtime JSON configuration can add, configure, or remove plugins:

```jsonc
{
  "plugins": [
    "company.project-policy",
    { "package": "@company/ycoding-plugin", "options": { "mode": "strict" } },
    "./plugins/local.ts",
    "-ycoding.unwanted",
  ],
}
```

A remove selector can be an exact ID, `*`, or a prefix ending in `.*`.

Explicit JSON plugin operations are applied after auto-discovered files, so configuration can disable an auto-discovered or built-in plugin.

## Hooks

Hooks are a plugin API, not a standalone repository file format.

The current runtime hook domains are:

- AI SDK hooks;
- Session hooks;
- Tool hooks.

A plugin registers hooks through its domain context. Hook registrations are scoped to the active plugin generation and are removed during plugin reload.

Do not create `.ycoding/hooks.json`, `.ycoding/hooks/`, or a top-level `hooks` config key; the current runtime does not discover them.

## Tools

YCoding does not auto-load `.ycoding/tool/*.ts` or `.ycoding/tools/*.ts`.

Implemented: local selective compaction is runtime-owned rather than a model tool. At configured `consider` pressure, the context hook durably admits and starts or joins one process-global background worker without waiting for settlement. It admits once more only if the same pressure cycle rises to `advised`, and rearms after returning to `normal`; failed admission remains retryable, while successful or deduplicated admission latches. `mandatory` never starts this soft path. Explicit `/compact` and the mandatory hard-limit gate remain synchronous settlement paths, and all three paths share one per-Session admission gate. Before creating helper state, the owner resolves its configured `efficiency.helper_models.compaction.main` or `.subagent` model. Each job reuses a deterministic taskless child Session with that model and the hidden built-in `compaction` agent, which remains `mode: primary`. The worker validates a bounded canonical TOON checkpoint containing objective, requirements, acceptance criteria, progress, pending work, decisions, blockers, skills, and a bounded fact capsule for every covered source item. Helper timeout or failure uses the local canonical fallback. Required semantic evidence that cannot fit fails closed; arbitrary covered bytes are not guaranteed to survive lossy compression. Activation creates a new immutable context revision without deleting canonical messages or transcript events.

Historical V1 summary events remain decode and migration input only. No active `conversation_summarize` source or tool remains; custom tools must not depend on destructive summary replacement.

Custom tools must be supplied through:

1. a YCoding plugin using the Tool domain;
2. an MCP server under `mcp.servers`;
3. a built-in runtime tool.

This distinction is intentional: plugin and MCP lifecycles provide validation, permissions, cancellation, and cleanup that arbitrary source-file loading would bypass.

## Themes

Terminal themes are JSON files under `themes`:

```text
<global YCoding config>/themes/company-dark.json
.ycoding/themes/company-dark.json
```

Discovery order is:

1. global theme directory;
2. broad ancestor `.ycoding/themes` directories;
3. nearer `.ycoding/themes` directories.

Files are direct `*.json` children. The theme ID is the filename without `.json`. Later files with the same ID replace earlier files.

Theme shape is owned by `packages/ui/src/theme/theme.schema.json`. YCoding does not publish that schema at a public URL, so use the repository copy.

Select a theme globally in `cli.json`:

```jsonc
{
  "theme": {
    "name": "company-dark",
    "mode": "dark",
  },
}
```

## Instructions and AGENTS.md

YCoding automatically loads ambient `AGENTS.md` files from:

- `<global YCoding config>/AGENTS.md`;
- the project root through the current working directory.

The current working directory can therefore add narrower instructions than an ancestor directory.

Each instruction source is rendered with its source path. `instruction_max_bytes` controls per-file truncation.

The Location-scoped instruction discovery reads the global file when assembling Session context before each model step. The initial value becomes durable instruction state; later file changes are observed at a subsequent step boundary and rendered as an instruction update rather than silently rewriting earlier history.

The JSON `instructions` array is currently accepted by Schema but is not read by runtime instruction discovery. Use `AGENTS.md`, skills, MCP instructions, or explicit session instruction injection.

## References

References are configured in JSON rather than separate files.

```jsonc
{
  "references": {
    "backend": "../backend",
    "platform": {
      "repository": "https://github.com/company/platform.git",
      "branch": "main",
      "description": "Shared platform code",
    },
  },
}
```

References become named external context sources. Local paths resolve relative to the containing config file; Git sources are cloned into YCoding-managed data storage.

## MCP resources and prompts

MCP servers are configured under `mcp.servers`, not as `.ycoding` source files.

An MCP server can contribute:

- tools;
- prompts, exposed through the command catalog;
- instructions;
- static resources;
- resource templates.

See [`configuration.md`](./configuration.md#mcp) for local and remote server shapes.

## Project artifacts

YCoding's project-artifact system manages agents, commands, skills, and plugin drafts with validation, preview, confirmation, deletion, restore, and rollback. Project artifacts are durable managed records; filesystem resources are their deployed or imported representation.

Use the TUI project-artifact manager for lifecycle operations when provenance and rollback matter. Direct file edits remain valid for repository-owned resources and are reloaded by the watcher.

## Reload behavior

Global and `.ycoding` directories are watched. Creating, modifying, renaming, or deleting agent, command, plugin, skill, config, or theme files triggers the relevant reload path.

Important limits:

- plugin auto-discovery is one directory level deep;
- theme discovery is one directory level deep;
- agents and commands are recursive;
- skills use root `*.md` or recursive `SKILL.md`;
- `.claude/skills` and `.agents/skills` are re-read on demand, not watched.

## Validation checklist

When adding a resource:

1. Put it in a supported directory and extension.
2. Use valid YAML frontmatter where required.
3. Keep the derived ID or command name unique.
4. Verify model selectors and agent IDs exist.
5. Apply explicit permissions for tools, external directories, and skills.
6. Restart only if the watcher reports a reload failure; normal edits are hot-reloaded.
7. Inspect logs with `--log-level all` and `YCODING_PRINT_LOGS=1` if the resource does not appear.

## Unsupported inherited patterns

The following inherited patterns are not current YCoding resource contracts:

- legacy upstream configuration directories and filenames listed in [`ycoding-migration.md`](./ycoding-migration.md);
- project `.ycoding/tui.json`;
- global `tui.json` or `kv.json`;
- `.ycoding/tool/**` arbitrary tool loading;
- `.ycoding/hooks/**` or top-level `hooks` configuration;
- V1 plugin exports;
- historical upstream schema or documentation URLs as YCoding authority.
