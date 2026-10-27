# Repository resources

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

The hidden primary `prediction` agent is an internal next-message helper with no tools. Its system prompt and model can be configured through `agents.prediction`; it resolves the explicit agent model before `efficiency.helper_models.prediction` and the Session/default model. Prediction runs only when requested with `/suggest [hint]`, whose dialog selects project and global memory scopes; each selected scope requires the calling selected agent's effective `memory_read` to be `allow` or `ask`. Snippets are sent only to the helper, never injected into Session prompts. See [prediction configuration](./configuration.md#next-message-prediction).

The hidden primary `prompt` agent is an internal prompt-drafting helper with no tools. Its system prompt and model can be configured through `agents.prompt`; it resolves the explicit agent model before `efficiency.helper_models.prompt` and the Session/default model. Prompt generation runs only when requested with `/prompt <intent>`. The dialog selects a mode (`start`, `steer`, `queue`, or `goal`) and project and global memory scopes; each selected scope requires the calling selected agent's effective `memory_read` to be `allow` or `ask`. The helper returns one draft for the composer. Nothing is admitted or sent. Snippets are sent only to the helper, never injected into Session prompts.

Supported project resource domains are:

- runtime configuration;
- agents;
- commands;
- skills;
- runtime plugins and hooks;
- terminal themes.
- custom guardrail rule files.

Maintained built-in agent Markdown frontmatter is the source for each built-in's description, mode, color, and request temperature. Visible primary and subagent built-ins use role-specific temperatures from 0.4 to 0.6. Their shared prompt requires current todo state and tool calls constructed from supplied schemas or discovered signatures rather than capability prose. Invalid-input results identify fields to correct only after the preceding call is known not to have mutated state; denial and unavailability are distinct, and uncertain mutations are never automatically replayed. Effective permissions remain runtime defaults and policies, not agent-file frontmatter. Configured Markdown agents continue to use the normal configuration merge.

Active coordination roles add the `ycoding/coordination-voice` instruction source for master Sessions. It specifies the owner's first-person instruction channel, assignment-based agent and reasoning selection, and a receipt reason for every dispatch. Exact agent IDs and model variants must be available in the target Location. Decision claims require recorded instructions or current delegation. Originating Session identity is audit metadata, not a sender persona. Native control settlement remains separate from message text.

There is no generic `.ycoding/tool` loader. Custom tools must be provided by a plugin or MCP server.

## Built-in workspace memory

The built-in `memory` tool stores explicit folder-scoped knowledge outside repository resource discovery. Configure it through the runtime `memory` object; it does not scan `.ycoding` for concepts or automatically load knowledge as instructions. Its actions are `status`, `list`, `search`, `read`, `write`, and offline `graph` export. See [Workspace knowledge memory](./memory.md) for storage, format, permissions, and update semantics.

## Built-in Git worktrees

The built-in `worktree` tool accepts `{ action: "list" }` or `{ action: "create", name }`. Names must match `^[a-z0-9][a-z0-9-]{0,62}$`. Listing returns each repository worktree's path, branch when known, and whether it contains the current Location. Creation uses the project-copy service and creates `<data>/worktrees/<repo-key>/<name>` on branch `<name>`; it does not switch the current Session Location. `repo-key` is `repo_` plus SHA-256 of the canonical Git common directory. Permission action `worktree` defaults to allow (ask for the read-only BTW advisor), and creation also uses the Session `file_mutation` guardrail. The tool has no remove action; deletion remains a human action in Manage workspaces.

## Built-in task completion signal

The provider-visible `task_complete` tool records an explicit local completion signal after the agent verifies its work. It has no input, remote configuration, HTTP request, or external permission; its successful durable tool call can trigger the TUI completion alert after root settlement if no child task or root-owned background shell remains active. Do not call it for idle, partial results, or routine progress.

There is no supported project `.ycoding/tui.json`. Terminal preferences are global in `cli.json`.

## Discovery boundaries and priority

YCoding discovers:

- every ancestor `ycoding.json` and `ycoding.jsonc`;
- every ancestor `.ycoding` directory;
- every ancestor `.claude` and `.agents` directory for skill compatibility;
- the global YCoding config directory;
- global `~/.claude` and `~/.agents` skill directories when present, unless `capabilities.home_roots` is `false`.

[Capability toggles](./configuration.md#capability-toggles) narrow what discovery exposes: `capabilities.home_roots: false` omits `~/.claude` and `~/.agents` (including when the project lies below the home directory), and `capabilities.skills`, `tools`, `mcp`, `plugins`, `project_artifacts`, and `instructions` filter the discovered resources by ID, name, or path.

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
| Themes               | `<global config>/themes/*.json`; `.ycoding/themes/*.json`                                                                                                     | Direct children only. ID is filename without `.json`.                                                                                        | Theme JSON shape is owned by the `ThemeFile` schema in `packages/tui/src/theme/schema.ts`.                                                                                                           | Global, broad ancestor, then nearer project files load in order; later equal IDs replace earlier files.                                                                                  |
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

The maintained primary catalog includes `GSD`, `architech`, `god`, and `yangi`; `god` is the default. Primaries answer read-only requests and orchestrate implementation through their own bounded subagents. `GSD` (Get shit done) emphasizes the critical path and early independent lanes; each primary retains its specialist decision and reporting style. Changed-work reports state the outcome and exact checks and leave the captured-path inventory to the native change summaries. See [Built-in agents](./runtime.md#built-in-agents) for roles and permission boundaries. Configure `{"default_agent": "GSD"}` in JSON to select it by default.

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

`capabilities.skills` filters skills by ID after discovery from every source above, managed project-artifact skills, MCP-served skills, and the built-in `ycoding` and `report` skills; a filtered skill is absent from the catalog and cannot be loaded by explicit ID. `capabilities.skills.enabled: false` also hides the `skill` tool.

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

Invoke a registered local skill with `$skill-id` at the start of a prompt or after whitespace, followed by whitespace, supported punctuation, or the end of the prompt. The runtime records the request and loads its instructions before model execution on every prompt-entry surface; this explicit invocation is independent of `ycoding/autoinvoke`. Existing active skills are not loaded twice. Unknown dollar tokens remain text. If an explicitly recorded skill becomes unavailable or permission-denied before execution, the input stays pending and the runtime reports the failure rather than asking the model to decide whether to load it.

### Loading and reload

Directory skill files are read whenever the skill list is requested. This avoids stale skill content in ecosystem roots that are not watched.

HTTP(S) sources are pulled and their resolved directories are memoized for the current Location lifetime.

Skill availability is filtered through the selected agent's `skill` permission rules.

## Plugins

The [meeting runtime](./meeting-intelligence.md) has separate runtime and TUI entrypoints. Native `/meeting` commands register through the TUI keymap and `/meeting start` prints the authenticated live page address for page-owned capture; the read-only `meeting_history` tool uses the runtime tool transform.

Trusted Effect/Promise plugins have `context.mcp.servers()`, `tools()`, `readResource({server, uri})`, and `callTool({server, name, args?})`. These reuse the current Location's MCP services and errors, not a separate registry, authentication flow or annotation-based authorization.

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

`capabilities.plugins` applies after these operations to external plugins only (configured packages and files and auto-discovered files): `enabled: false` loads none, and `allow`/`deny` match the exported plugin ID, so an excluded plugin is imported to read its ID but never activates. Built-in `ycoding.*` plugins are unaffected.

Terminal-side plugins use global `cli.json`, separately from runtime plugin discovery. TUI startup first applies built-in enable/disable selectors in configuration order, then exposes the Home and Session shell before loading optional plugins. Disabled built-in UI is not mounted during startup. Optional directives retain their configuration order, including enable and remove operations on optional plugins; loading and failure states are available in Status.

## Hooks

Hooks are a plugin API, not a standalone repository file format.

The current runtime hook domains are:

- AI SDK hooks;
- Session hooks;
- Tool hooks.

A plugin registers hooks through its domain context. Hook registrations are scoped to the active plugin generation and are removed during plugin reload.

Session context hooks receive the selected catalog model plus the resolved executable `routeID`. The route identity can differ for the same catalog reference after credential-aware provider resolution, so route-specific context behavior must use `routeID` rather than infer transport capability from the model reference. A Session context hook that fails emits a Session-scoped warning and adds a model-visible notice that its changes may be incomplete; the remaining context hooks still run, and the request proceeds.

Do not create `.ycoding/hooks.json`, `.ycoding/hooks/`, or a top-level `hooks` config key; the current runtime does not discover them.

## Tools

Use `/sleep` to enable durable family sleep and its keep-awake hold, `/wake` to clear sleep, and `/keep-awake` to toggle the backend's manual keep-awake preference. These TUI controls are built-ins, not discovered command templates. Autonomy is likewise a built-in: `/autonomous` opens one dialog with Permissions, Guardrails, and Answers rows, each `Manual` (default), `YOLO`, or `Auto`. Guardrail YOLO model evaluation follows runtime thresholds, `guardrails.decide_reviews` for standard-match verification (on when omitted; explicit `false` disables), and `guardrails.decide_hard_reviews`. Auto answers use only a valid explicit default or exactly one `Recommended` option in the Session itself; evaluator answers require effective answers `yolo`. See [configuration](./configuration.md) for thresholds, scopes, and machine warnings.

The built-in `decision` tool accepts `{ provider: "agent", request }`. Requests contain JSON `state` and ordered named questions and expose validated model-estimate results as TOON. Permission action `decision` uses resource `agent`; an explicit denial blocks the call. Credentials stay outside agent arguments and results. Send only evidence authorized for disclosure to the helper model route. The hidden primary `decision` agent and the hidden `yolo-permission`, `yolo-guardrail`, and `yolo-answer` evaluators have all tools denied, are reserved for internal evaluation rather than foreground Session or command selection, and use `agents.decision.model`, then `efficiency.helper_models.decision`, then the owner Session/default model, over the same authentication route. Its confidence is self-reported and uncalibrated. See [agent input and TOON](../specs/decisions.md#decision-agent-inputs) and [configuration](./configuration.md#decisions).

Agent judgments require explicit `decision` calls. Questions are typed `predicate`, `choice`, `score`, or `text` (bounded by optional `maxLength`, default 8192); existing answer fields are unchanged, with text answers adding their bounded `text` value. Choice questions accept `grade: true` to return every listed choice exactly once with confidence and bounded evidence, without a single pick; default false preserves single-pick mode. The runtime also uses the helper for standard-match verification and graded reviews only while guardrails are effective `yolo` (verification also needs `guardrails.decide_reviews`, on when omitted), and for the permission and answer evaluators only while that category is effective `yolo`, under their separate thresholds and strict allow/deny/escalate fail-closed rules with a visible reason and next action; no runtime switch affects the explicit tool. Main, child, and side-chat Sessions share the tool and its `core/decision-use` guidance; effective permission denies and inherited ceilings remain enforced. Predicates, choices, scores, and text questions can abstain with `type: refusal`, null answer values, confidence `0`, and no grades. Refusal means insufficient evidence or inability to judge, not a selected option or approval; gather missing evidence or ask the user.

Native Dots task admission and typed decisions use private server-process Channels, not agent tools or Code Mode. Trusted global enablement and an explicit pinned OpenAI OAuth profile gate the Host; persisted root-family access defaults off, native-created roots are enabled atomically, and children inherit. Clients administer only `session.dots.access.get/set`, with an exact revision required for root writes. Candidate, source, revision, ownership, archive, deny, ceiling, and connection-lifetime checks remain enforced. Historical events and external attribution remain readable; uncertain work is never replayed automatically. See [Native Dots access](./runtime.md#native-dots-access).

YCoding does not auto-load `.ycoding/tool/*.ts` or `.ycoding/tools/*.ts`.

`capabilities.tools` allows or denies tools by registered name, including MCP tools named `<server>_<tool>`, through the same catalog filter that permission rules use; see [capability toggles](./configuration.md#capability-toggles) for the built-in tool names.

Local selective compaction is runtime-owned rather than a model tool. At configured `consider` pressure, the context hook durably admits and starts or joins one process-global background worker without waiting for settlement. It admits once more only if the same pressure cycle rises to `advised`, and rearms after returning to `normal`; failed admission remains retryable, while successful or deduplicated admission latches. `mandatory` never starts this soft path. Explicit `/compact` and the mandatory hard-limit gate remain synchronous settlement paths, and all three paths share one per-Session admission gate. Local compaction resolves the configured `efficiency.helper_models.compaction.main` or `.subagent` model and reuses a deterministic taskless child Session with that model and the hidden built-in `compaction` agent, which remains `mode: primary`. The worker validates a bounded canonical TOON checkpoint containing objective, requirements, acceptance criteria, progress, pending work, decisions, blockers, skills, and a bounded fact capsule for every covered source item. Helper timeout or failure uses the local canonical fallback. Required semantic evidence that cannot fit fails closed; arbitrary covered bytes are not guaranteed to survive lossy compression. Codex remote compaction uses the owner model without a helper and falls back to local compaction if the remote request fails. Activation creates a new immutable context revision without deleting canonical messages or transcript events.

Custom tools must not depend on destructive summary replacement.

Custom tools must be supplied through:

1. a YCoding plugin using the Tool domain;
2. an MCP server under `mcp.servers`;
3. a built-in runtime tool.

This distinction is intentional: plugin and MCP lifecycles provide validation, permissions, cancellation, and cleanup that arbitrary source-file loading would bypass.

The built-in `browser` tool is registered through the same Location-scoped internal plugin lifecycle. Omitted mode operates eligible tabs in the paired Chrome profile, including the active tab; explicit `mode: "owned"` operates Session-created Chrome tabs, and explicit `mode: "isolated"` operates an already-started Session-owned isolated browser. No mode starts pairing or falls back to another. The tool never exposes pairing to the model and applies per-site browser permissions to profile reads and hard human review to profile mutations at execution. See [`browser-extension.md`](./browser-extension.md) and the [isolated-browser contract](../specs/isolated-browser.md).

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

Theme shape is owned by the TUI Effect schema `ThemeFile` in `packages/tui/src/theme/schema.ts`. A theme file requires `version: 2` and at least one of `light` or `dark`; `$schema` and `standalone` are optional.

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

After a successful `read` inside the Location, `AGENTS.md` files between the read target and the Location root (exclusive) are injected once per Session as durable synthetic instructions. `capabilities.instructions.global: false` skips the global file; `capabilities.instructions.project: false` skips both project discovery and this nested injection; `capabilities.instructions.exclude` skips matching absolute paths in both.

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

Servers declaring the Resources capability and `io.modelcontextprotocol/skills` can also contribute MCP-served skills. Discovery exposes metadata only: the host-assigned server label, a `SKILL.md` URI, frontmatter, and a declared resource manifest. Listing and selecting metadata never read skill-file bytes. The pair of server label and URI gives the model-facing skill identity; the server's self-reported name does not replace the configured label.

Loading an MCP-served skill is lazy and requires the `skill` tool permission. For a fixed manifest, YCoding first binds approval to a digest-derived identity of the server, skill URI, and complete resource manifest, then fetches `SKILL.md`. It verifies the retrieved file's manifest membership, size, digest, and parsed frontmatter before content reaches the model. Dynamic manifests are listed but cannot load. Supporting resources are read only by a later `skill` call for an already active skill, from the manifest retained by its durable activation; unlisted, changed, malformed, or escaping resource references fail without exposing bytes or downloading files to disk.

See [`configuration.md`](./configuration.md#mcp) for local and remote server shapes.

## Project artifacts

YCoding's project-artifact system manages agents, commands, skills, and plugin drafts with validation, preview, confirmation, deletion, restore, and rollback. Project artifacts are durable managed records; filesystem resources are their deployed or imported representation.

Use the TUI project-artifact manager for lifecycle operations when provenance and rollback matter. Direct file edits remain valid for repository-owned resources and are reloaded by the watcher.

`capabilities.project_artifacts: false` applies no managed project artifacts to the Location and hides the `project_artifact` tool and its guidance.

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

- configuration namespaces belonging to other products;
- project `.ycoding/tui.json`;
- global `tui.json` or `kv.json`;
- `.ycoding/tool/**` arbitrary tool loading;
- `.ycoding/hooks/**` or top-level `hooks` configuration;
- legacy plugin export shapes;
- other products' schema or documentation URLs as YCoding authority.
