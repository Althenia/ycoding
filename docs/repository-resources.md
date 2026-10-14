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
- explicit trusted process extensions in runtime configuration;
- terminal themes.
- custom guardrail rule files.

Maintained built-in agent Markdown frontmatter is the source for each built-in's description, mode, color, and request temperature. Visible primary and subagent built-ins use role-specific temperatures from 0.4 to 0.6. Their shared prompt requires current todo state and tool calls constructed from supplied schemas or discovered signatures rather than capability prose. Invalid-input results identify fields to correct only after the preceding call is known not to have mutated state; denial and unavailability are distinct, and uncertain mutations are never automatically replayed. Effective permissions remain runtime defaults and policies, not agent-file frontmatter. Configured Markdown agents continue to use the normal configuration merge.

There is no generic `.ycoding/tool` loader. Custom tools must be provided by a trusted process extension or MCP server. Runtime JS/TS files under `.ycoding/plugin` or `.ycoding/plugins` are not a beta discovery surface; terminal presentation plugins belong in global `cli.json`.

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
- global `~/.claude` and `~/.agents` skill directories when present.

Runtime config document order is documented in [`configuration.md`](./configuration.md#runtime-configuration-discovery-and-precedence).

Resource-specific rules:

| Resource   | Discovery                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Agents     | Recursive `agent/**/*.md` and `agents/**/*.md` inside YCoding config directories.                                             |
| Commands   | Recursive `command/**/*.md` and `commands/**/*.md` inside YCoding config directories.                                         |
| Skills     | Root `*.md` and recursive `**/SKILL.md` under each skill source.                                                              |
| Extensions | Explicit ordered `extensions` entries in runtime JSON/JSONC; no executable-file auto-discovery.                               |
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
| Extensions           | Ordered runtime `extensions` configuration                                                                                                                    | Explicit executable and identity; no filename scan.                                                                                          | Identity, absolute executable, optional args, and explicit host grants.                                                                                                                              | Duplicate identities replace in place. Unsupported executable plugin/npm declarations fail the document closed. See [process extensions](#plugins).                                      |
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

The maintained primary catalog includes `GSD`, `architech`, `god`, and `yangi`; `god` is the default. `GSD` (Get shit done) handles read-only and implementation requests and delivers the complete authorized outcome efficiently. Each selectable built-in primary agent reports **Completed**, **Residual risks**, **Recommended**, and **Next Action**; it includes **Blockers** only when blocked. See [Built-in agents](./runtime.md#built-in-agents) for roles and permission boundaries. Configure `{"default_agent": "GSD"}` in JSON to select it by default.

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

Commands use Rust Core's command-template evaluator (`rust/crates/core/src/resources/command`), including argument text and shell interpolation. Treat shell interpolation as real shell execution under the selected permission policy.

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

Invoke a registered local skill with `$skill-id` at the start of a prompt or after whitespace, followed by whitespace, supported punctuation, or the end of the prompt. The runtime records the request and loads its instructions before model execution on every prompt-entry surface; this explicit invocation is independent of `ycoding/autoinvoke`. Existing active skills are not loaded twice. Unknown dollar tokens remain text. If an explicitly recorded skill becomes unavailable or permission-denied before execution, the input stays pending and the runtime reports the failure rather than asking the model to decide whether to load it.

### Loading and reload

Directory skill files are read whenever the skill list is requested. This avoids stale skill content in ecosystem roots that are not watched.

HTTP(S) sources are pulled and their resolved directories are memoized for the current Location lifetime.

Skill availability is filtered through the selected agent's `skill` permission rules.

## Plugins

The beta has two extension boundaries: trusted backend process extensions and terminal presentation plugins. Runtime executable `plugins`, `plugin`, `npm`, and singular `provider` declarations reject the affected configuration document with a diagnostic; there is no mapping to process extensions. Native provider package identities select compiled routes, not executable npm modules.

### Trusted process extensions

Configure `extensions` in `ycoding.json` or `ycoding.jsonc`:

```jsonc
{
  "extensions": [
    {
      "identity": "company-review",
      "executable": "/opt/company/bin/review-extension",
      "args": [],
      "grants": [
        {
          "family": "tools",
          "namespace": "company",
          "tools": ["review"],
          "action": "company_review",
          "resources": ["**"],
        },
      ],
    },
  ],
}
```

The executable must be an allowed native process, not a JS/TS file or Node/Bun/npm/npx launcher. Declarations validate before launch. Duplicate identities replace definitions in place, preserving registration order. The host supplies the Location and grants; the child cannot select them. Grants bound host capability calls, not the process's ambient filesystem or network authority: these are trusted processes, not sandboxes.

Location composition launches configured processes before a Session exists. Explicit `extension.launch` or grant-action `deny` and `ask` rules block launch; no matching rule allows configuration-trusted launch. Calls independently enforce the calling Session's permissions and inherited ceilings. Extensions negotiate the private v5 stdio descriptor, register one validated generation, and use typed tool, hook/transform, resource, event, MCP, Session, provider-attempt, and OAuth capabilities only within host grants. There is no generic application API or credential/database forwarding.

Replacement and shutdown stop intake, cancel/drain owned calls, revoke registrations, and join child cleanup. A lost transmitted call has an explicit unknown outcome; the supervisor does not restart or replay it. See the [process-extension contract](../specs/process-extension-v5.md) for supported families, schemas, limits, and deadlines.

The opt-in Rust Meeting service is composed by the backend, not loaded through this process-extension channel. Its TUI entrypoint is presentation-only. `/meeting start` exposes the consent-led live page, and the backend registers `meeting_history` and a restricted analysis agent for Meeting-enabled Locations. See [Meeting capture](./configuration.md#meeting-capture).

### Ordered enablement and removal

Terminal-side plugins use global `cli.json`:

```jsonc
{
  "plugins": [
    "company.project-policy",
    { "package": "@company/ycoding-plugin", "options": { "mode": "strict" } },
    "./presentation/local.ts",
    "-ycoding.unwanted",
  ],
}
```

A remove selector can be an exact ID, `*`, or a prefix ending in `.*`.

Selectors support exact IDs, `*`, and prefixes ending in `.*`. TUI startup first applies built-in enable/disable selectors in configuration order, then exposes the Home and Session shell before loading optional plugins. Disabled built-in UI is not mounted during startup. Optional directives retain their configuration order, including enable and remove operations on optional plugins; loading and failure states are available in Status. Registry packages resolve through the backend's local-only `frontendPackage.resolve`; they require npm on its PATH and execute as trusted presentation code, with installation scripts disabled and package/entrypoint integrity checked.

## Hooks

Backend hooks use the process-extension channel's typed, host-granted transform stages. Tool before/after hooks and Session context preparation remain scoped to their captured generation; output is revalidated before consumption. A failed tool cannot become successful through an after hook. A context-hook failure emits a Session-scoped warning and adds a model-visible notice that its changes may be incomplete; other hooks and request preparation continue. See the [process-extension contract](../specs/process-extension-v5.md).

Do not create `.ycoding/hooks.json`, `.ycoding/hooks/`, or a top-level `hooks` config key; the current runtime does not discover them.

## Tools

The built-in `decision` tool accepts `{ provider: "agent", request }`. Requests contain JSON `state` and ordered named questions and expose validated model-estimate results as TOON. Permission action `decision` uses resource `agent`; an explicit denial blocks the call. Credentials stay outside agent arguments and results. Send only evidence authorized for disclosure to the helper model route. The hidden primary `decision` agent has no tools, is reserved for internal evaluation rather than foreground Session or command selection, and uses `agents.decision.model`, then `efficiency.helper_models.decision`, then the owner Session/default model. Its confidence is self-reported and uncalibrated. See [agent input and TOON](../specs/decisions.md#decision-agent-inputs) and [configuration](./configuration.md#decisions).

Only explicit agent calls invoke decision judgments. Main, child, and side-chat Sessions share the tool and its `core/decision-use` guidance; effective permission denies and inherited ceilings remain enforced. Predicates, choices, and scores can abstain with `type: refusal`, null answer values, and confidence `0`. Refusal means insufficient evidence or inability to judge, not a selected option or approval; gather missing evidence or ask the user.

YCoding does not auto-load `.ycoding/tool/*.ts` or `.ycoding/tools/*.ts`.

Local selective compaction is runtime-owned rather than a model tool. At configured `consider` pressure, the context hook durably admits and starts or joins one process-global background worker without waiting for settlement. It admits once more only if the same pressure cycle rises to `advised`, and rearms after returning to `normal`; failed admission remains retryable, while successful or deduplicated admission latches. `mandatory` never starts this soft path. Explicit `/compact` and the mandatory hard-limit gate remain synchronous settlement paths, and all three paths share one per-Session admission gate. Local compaction resolves the configured `efficiency.helper_models.compaction.main` or `.subagent` model and reuses a deterministic taskless child Session with that model and the hidden built-in `compaction` agent, which remains `mode: primary`. The worker validates a bounded canonical TOON checkpoint containing objective, requirements, acceptance criteria, progress, pending work, decisions, blockers, skills, and a bounded fact capsule for every covered source item. Helper timeout or failure uses the local canonical fallback. Required semantic evidence that cannot fit fails closed; arbitrary covered bytes are not guaranteed to survive lossy compression. Codex remote compaction uses the owner model without a helper and falls back to local compaction if the remote request fails. Activation creates a new immutable context revision without deleting canonical messages or transcript events.

Custom tools must not depend on destructive summary replacement.

Custom tools must be supplied through:

1. a trusted process extension with explicit tool grants;
2. an MCP server under `mcp.servers`;
3. a built-in runtime tool.

Process-extension and MCP lifecycles provide validation, permissions, cancellation, and cleanup; arbitrary source-file loading is unsupported.

The built-in `browser` tool is registered by Rust production's Location tool composition. Omitted mode operates eligible tabs in the paired Chrome profile, including the active tab; explicit `mode: "owned"` operates Session-created Chrome tabs, and explicit `mode: "isolated"` operates an already-started Session-owned isolated browser. No mode starts pairing or falls back to another. The tool never exposes pairing to the model. Site/tool permissions and custom denials remain enforced; browser and computer operations skip guardrail reviews. See [`browser-extension.md`](./browser-extension.md) and the [isolated-browser contract](../specs/isolated-browser.md).

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

## Reload behavior

Global and `.ycoding` directories are watched. Agent, command, skill, and runtime-config changes rebuild the affected Location generation, including its configured process extensions and MCP tool catalog. Theme discovery and `cli.json` presentation settings remain TUI-owned.

Important limits:

- process extensions require explicit configuration;
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
