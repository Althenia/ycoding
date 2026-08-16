# Implemented runtime behavior

Status: **Implemented**

This document records behavior that is present in the current repository. Exact types and endpoint names remain owned by Schema and Protocol.

## Sessions

### Durable admission

A prompt is durably admitted before execution is scheduled. The durable pending row represents unconsumed work only. Promotion into the visible transcript and removal from pending state occur at a safe execution boundary.

Reusing a Session ID adopts the existing session. Reusing a prompt message ID is accepted only for an exact retry with matching session, content, and delivery mode; conflicting reuse fails.

### Execution ownership

`SessionExecution` is process-global and keyed by Session ID. It uses a process-local coordinator to:

- serialize drains for the same session;
- join explicit same-session resumes;
- coalesce advisory wakes;
- allow different sessions to execute concurrently.

A drain discovers the session's Location when execution starts. There is no clustered execution ownership yet. Public event replay ownership is separate from local execution ownership.

### Steps and provider attempts

One step is one logical LLM call. A normal step has one physical provider attempt. Context-overflow recovery may compact and rebuild the step for one additional attempt.

The runtime reloads projected history before durable continuation. It does not delegate V2 orchestration to a legacy in-memory prompt loop.

### Prompt delivery

- **Steer** inputs promote at the next safe step boundary and require the active drain to continue.
- **Queue** inputs remain pending until the session would otherwise become idle.
- Promoting new user input resets the selected agent's step allowance.

## Autonomy

Session autonomy is durable and supports:

| Mode     | Behavior                                                    |
| -------- | ----------------------------------------------------------- |
| `normal` | Standard interactive execution.                             |
| `yolo`   | Autonomous execution under the effective permission policy. |
| `goal`   | Repeated continuation toward a durable goal.                |

Goal state stores the goal text, status, iteration, no-progress count, maximum no-progress count, and last progress digest.

Terminal goal states are:

- `completed` — the model emitted the recognized goal-completion marker and the turn settled;
- `stopped` — the user or runtime left goal mode;
- `exhausted` — repeated identical progress reached the configured no-progress bound.

A tool-only turn with no assistant text spends an iteration but does not increment the no-progress counter. The TUI refreshes autonomy when session execution reaches a terminal event so displayed progress is not one iteration stale.

## Session guardrails

Guardrails are a root-Session-family safety boundary independent of agent permissions and autonomy mode.

Current behavior:

- recognized catastrophic shell commands are denied before process creation;
- recognized high-impact shell and mutation actions create a distinct human review;
- guardrail reviews remain reviews in `normal`, `yolo`, and `goal` modes and are not affected by TUI permission auto-approve;
- direct Session shell, tool shell, edit, write, patch, subagent launch, mutation-capable MCP tools, and project-artifact mutation use the same service boundary;
- running shell, running subagent, and pending review caps are shared by the root Session family and release on settlement or interruption;
- custom rules load from the global YCoding config `guardrails` directory;
- malformed enabled custom files produce a visible invalid-file count and fail closed with review for mutation actions;
- pending reviews rehydrate through the canonical Session guardrail API and live events, including reviews initiated by child Sessions.

The TUI labels this blocker **Session guardrail review** and offers only one-time approval or rejection. Permission approval does not bypass guardrails, and guardrail approval does not widen an agent permission denial.

Operator configuration is documented in [`guardrails-and-provider-usage.md`](./guardrails-and-provider-usage.md).

## Subagents

Subagents are durable child sessions.

Current behavior:

- The `subagent` tool always launches work in the background.
- The tool returns the child Session ID immediately.
- The child runs a configured non-primary agent with fresh context.
- The parent receives lifecycle state and completion or failure notification.
- Parent TeamView context is injected as a volatile message after durable history so changing child state does not destabilize the provider-cache prefix.
- TeamView is model-facing coordination data, not user-facing narration. The parent keeps launch, running, completed, failed, and total bookkeeping silent unless the user explicitly asks for subagent status.
- A child failure may still be reported when it blocks the requested outcome, but not as routine orchestration bookkeeping.
- Running children receive a status, blocker, and ETA request every ten minutes.
- The effective permission policy limits which subagents are available.
- Configured and managed subagents can use shell according to ordered agent permission rules; empty managed-agent rules resolve to safe defaults with shell requiring approval.
- Nested subagents are bounded by `experimental.subagent_depth`; the default depth is one.
- Session restart and TUI rehydration use durable orchestration state rather than requiring the user to open every child chat.

Subagents do not synchronously return their final result to the initiating tool call. Parent notification and child-session inspection are the completion paths.

## Skills

Skills can activate through an explicit reference or the `skill` tool.

Session skill status derives from the durable transcript and instruction state:

- an activated skill is `active`;
- an agent switch marks prior active skills inactive with `agent_switched`;
- completed compaction marks prior active skills inactive with `compacted`;
- conflicts are computed between active skills and against declared instruction keys;
- already-active tool loads are not duplicated as new active entries.

The TUI provides a session-skills dialog, expandable skill content, conflict details, and transcript rows for loaded skills. A completed skill's `Loaded` badge uses the skill accent color; inactive or unavailable state remains visually subdued.

## Instructions

Instruction state is Session-owned.

- Built-ins live in `packages/core/src/instructions`.
- Discovery observes ambient global and upward-project instruction sources.
- Guidance and persisted instruction entries are composed explicitly by the session runner.
- `session.instructions.updated` stores changed source keys and content hashes.
- Instruction blob content is stored once; instruction state is a rebuildable fold cache.
- Initial complete instruction loading blocks on unavailable required sources; later unavailable sources retain their previous value.
- Completed compaction advances the instruction epoch.
- Session movement and committed revert clear the instruction epoch.

There is no global instruction registry that owns Session history.

## Project artifacts

Project artifacts replace the removed self-improvement subsystem.

### Kinds

- `skill`
- `command`
- `agent`
- `plugin`

Agent artifacts currently define subagents. Command artifacts are non-subtask commands. Plugin artifacts store validated drafts rather than arbitrary executable mutation.

### Scopes

- **Project** — bound to one project scope.
- **Global** — shared through the global artifact scope.

Project artifacts can shadow global artifacts through the explicit lifecycle rather than file-order accidents.

### Lifecycle

Artifact stages are:

- `trial`
- `active`
- `degraded`
- `disabled`
- `quarantine`

Versions preserve content digests, provenance, parent versions, state transitions, and fallback identity. Manual destructive or cross-scope operations use preview/confirmation tokens. Trash, restore, revert, promotion, disable, shadow, and fork operations are explicit store operations.

Automatic creation is governed by per-kind and accounting caps. Plugin automatic creation is currently disabled by a zero automatic cap.

### Integration

Adapters expose active artifacts to the existing agent, command, skill, and plugin discovery paths. The TUI exposes a project-artifact dialog and project-artifact tools use the validated store instead of writing directly to source directories.

## Transcript history

The TUI keeps transcript memory bounded without changing durable history.

### Resident windows

- The hot window retains the latest **50 completed messages** plus every active or incomplete boundary.
- One expanded archive page retains up to **1000 older messages**.
- Older pages are represented by lightweight placeholders containing cursor and page metadata, not transcript payloads.
- Only one archive page is resident at a time.

### Expand and collapse

Expanding an archive placeholder:

1. refreshes stale history metadata when required;
2. requests the canonical page with a limit of 1000;
3. removes duplicate messages already resident in the hot window;
4. retains the page and marks its placeholder `expanded`;
5. adds a following placeholder when another cursor exists.

Collapsing history releases the resident archive payload and returns all placeholders to `collapsed` while preserving cursor, count, oldest ID, and newest ID metadata. Re-expanding the same placeholder reloads the same canonical page.

### Rendering guarantees

Transcript rows are reduced from resident messages and placeholders. A row whose backing message or assistant part has been evicted is not mounted, so it consumes no blank terminal block during archive collapse, page replacement, navigation, resume, or reconnect.

Timeline selection is preserved by option value rather than list index because history expansion and new messages can reorder the list.

## Provider caching and diagnostics

Caching is split into distinct concerns:

- stable model-visible prompt prefixes;
- provider-native prompt caching;
- normalized cache-usage telemetry;
- TUI diagnostics;
- project artifact reuse, which is not a provider prompt cache.

### OpenAI

For GPT-5.6 and later, OpenAI Chat and Responses lowering supports explicit `prompt_cache_options` and `prompt_cache_breakpoint` fields. Pre-5.6 models use the compatible retention field. The two model families are gated because sending the wrong cache fields can be rejected by the provider.

### Anthropic and compatible routes

Anthropic cache-control placement is normalized across direct and compatible provider routes. Volatile TeamView state is appended after stable history and does not receive a cache breakpoint.

### Telemetry

The runtime preserves provider-reported cache reads, writes, creation detail, mechanisms, and model/context identity where available. Missing provider telemetry is reported as unreported rather than silently treated as zero.

The TUI exposes last-step context, provider-cache diagnostics, current model context, and total session cost.

## Provider quota and credit diagnostics

Provider usage is a read-only Location service separate from Session-local token and cost telemetry.

- OpenRouter uses documented current-key data and optional management-credit data.
- OpenAI organization usage uses documented usage and cost endpoints when an explicitly marked admin credential is available.
- Claude subscription state combines live unified response headers with a cached OAuth usage snapshot for cold start and model-specific buckets.
- Codex and Spark preserve global and named limit lanes from a configured app-server client contract, with a ChatGPT OAuth backend fallback.
- snapshots are cached by provider and credential identity; concurrent refreshes are deduplicated;
- a failed refresh retains the last valid snapshot as `stale`;
- provider failures never block Session execution;
- unknown amounts remain absent and render as `Not reported`, not zero;
- Protocol and TUI state contain normalized values only, not credential values or provider response bodies.

The Session sidebar shows the active provider first, separates Spark and other named lanes, displays freshness and stability, and uses ten-cell progress bars for reported percentages.

## Terminal release behavior

The TUI is the only release surface and currently includes:

- session transcript and timeline;
- normal, yolo, and goal mode controls;
- subagent tabs, status, notifications, and navigation;
- session skills and project artifacts;
- distinct guardrail, permission, and form prompts;
- MCP and provider connection flows;
- prompt file, agent, command, skill, and reference autocomplete;
- cache, context, memory, cost, provider quota, and guardrail diagnostics;
- theme and keymap customization;
- bounded archived transcript expansion.

TUI-visible state must rehydrate from durable or canonical API state after process restart. A feature that appears only after visiting a child session or reopening a dialog is a defect unless the interaction itself is the explicit trigger.

## Known boundaries

- Session execution placement is process-local; clustering is not implemented.
- One archive page is resident at a time by design.
- V1 compatibility is intentionally absent.
