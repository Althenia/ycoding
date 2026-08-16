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

One step is one logical LLM request. Retryable pre-output failures reuse the same logical request ID; each transport start increments its physical-attempt count. A tool-result continuation is a new logical request. Context-overflow recovery completes the old request as a fallback, compacts the context, and rebuilds a new logical request.

The durable provider-request ledger stores identifiers, model and route identity, stable prompt/cache digests, attempt counts, normalized tokens, cost, continuation mode, and invalidation reason. It does not store prompt, message, tool-result, or response text.

The runtime reloads projected history before durable continuation. It does not delegate V2 orchestration to a legacy in-memory prompt loop.

### Helper model traffic

Session titles and goal text are local by default:

- local title generation selects one sanitized line from the first user prompt and makes no provider request;
- local goal synthesis collapses whitespace without changing the request's meaning and makes no provider request;
- model-generated title and goal behavior requires explicit `efficiency` modes;
- `title: "off"` keeps the initial generated Session title;
- compaction remains model-based.

Model-based helpers resolve the hidden agent's explicit model first, then `efficiency.helper_model`, then the current Session model. Helper provider requests use the same content-free request ledger as normal Session steps.

### Stable tool prefix

The provider sees one fixed `execute` tool definition. Its description explains the restricted JavaScript language and the search-first workflow, but it does not embed the current MCP or plugin tool catalog. Connecting, disconnecting, or refreshing an MCP server therefore does not change the provider-visible `execute` schema or the prompt-cache tool digest.

The live catalog remains available inside CodeMode through `search(...)` and exact runtime tool paths. Direct non-CodeMode tool definition changes still rotate the prompt-cache namespace.

MCP server instruction blocks are sorted by server ID, normalized to LF line endings, stripped of trailing whitespace, and limited to 2,048 UTF-8 bytes per server with an explicit truncation marker. These instructions can still change when server guidance changes, but their ordering and size are deterministic and bounded.

### Provider prompt caching

The cache policy revision is part of the prompt-cache namespace. The current policy uses `provider-native/v4`, so requests created under older placement rules do not silently share the same namespace.

Anthropic-compatible requests start with a concrete five-minute policy. The process-local cache runtime tracks provider-reported read and write usage by stable namespace. Two reusable observations within five minutes promote later requests for an extended-TTL-capable model to one hour. Missing telemetry, stale observations, namespace rotation, and unsupported model profiles remain at five minutes. The state is bounded, non-durable, and never required to reconstruct a Session.

Public OpenAI Chat and Responses requests on GPT-5.6 and later use a stable prompt-cache key, explicit breakpoints after stable tools, system, and latest-user prefixes, and request-wide `{ mode: "implicit", ttl: "30m" }` by default under `openai_mode: "auto"`. Reserving one of the four write slots preserves OpenAI's managed latest-message breakpoint so growing tool-result tails remain eligible for rolling reuse. `openai_mode: "explicit"` disables the managed breakpoint and can use four YCoding-managed markers. Older public OpenAI models remain implicit and use opt-in `24h` retention only on supported families. The ChatGPT Codex backend has its own `openai-codex-responses` capability identity and receives the supported stable `prompt_cache_key`, but not public-API `prompt_cache_options`, `prompt_cache_breakpoint`, or `prompt_cache_retention` fields. Compatible gateways and unsupported families also omit GPT-5.6-only fields. Model-based title, goal, and compaction calls use the same policy and observation runtime as normal Session steps.

### Prompt delivery

- **Steer** inputs promote at the next safe step boundary and require the active drain to continue.
- **Queue** inputs remain pending until the session would otherwise become idle.
- Promoting new user input resets the selected agent's step allowance.
- Durable pending user and synthetic inputs are projected back into the hot transcript after message eviction or child-chat navigation. Reopening a child therefore preserves an admitted steer without promoting it early.

## Autonomy

Session autonomy is durable and supports:

| Mode     | Behavior                                                    |
| -------- | ----------------------------------------------------------- |
| `normal` | Standard interactive execution.                             |
| `yolo`   | Autonomous execution under the effective permission policy. |
| `goal`   | Repeated continuation toward a durable goal.                |

`yolo` and active `goal` mode also govern managed descendants. A child Session automatically accepts an effective `ask` permission decision, selects the first ordinary question option, and answers a deterministic form while any managed ancestor is autonomous. Explicit permission denies remain denies. Auto-handled requests do not enter the pending request collections, so the TUI does not emit their approval or question notification sound.

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
- standard catastrophic denies are unoverrideable; otherwise the first matching custom source layer decides before standard review or allow behavior;
- guardrail reviews remain reviews in `normal`, `yolo`, and `goal` modes and are not affected by TUI permission auto-approve;
- direct Session shell, tool shell, edit, write, patch, subagent launch, mutation-capable MCP tools, and project-artifact mutation use the same service boundary;
- running shell, running subagent, and pending review caps are shared by the root Session family and release on settlement or interruption;
- custom files are direct `guardrails/*.md` children of the global config directory and every discovered repository `Config.Directory`; nearer repository directories precede broader repositories, which precede the global directory;
- within one custom source layer, matching rules sort by descending numeric priority and then deterministic lexical file-path/rule-ID order; enabled invalid configuration fails mutation actions closed with review while retaining its source-layer position;
- replies are `once`, `always`, or `reject`; `always` is process-memory reuse for the root Session family and exact action, ordered rule IDs, ordered resources, and request metadata only after a fresh evaluation still asks;
- pending reviews rehydrate through the canonical Session guardrail API and live events, including reviews initiated by child Sessions.

`once` is not reusable. A deny or a changed evaluation cannot reuse an `always` approval. The approval set is Location-service/process-memory only, is cleared with the service, and is never durable or global. Descendants share the root-family key.

After a pending-review checkpoint of 500 ms, the TUI emits a root-owned notification titled with the root-family Session ownership and the message **Guardrail approval needed**. The root system notification is blurred-only, uses the `permission` sound, and is suppressed when the review resolves before the checkpoint. Permission approval does not bypass guardrails, and guardrail approval does not widen an agent permission denial.

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
- A child question reported through orchestration receives the safe default answer immediately when its managed Session family is in `yolo` or active `goal` mode. The task remains running, and no parent-question notification or sound is emitted.
- The effective permission policy limits which subagents are available.
- Configured and managed subagents materialize the Location's registered tool catalog through their ordered permission rules and inherited parent ceiling. Empty managed-agent rules resolve to safe defaults with shell requiring approval; final `subagent` and `subagent_control` denies prevent nested orchestration.
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

For GPT-5.6 and later, public OpenAI Chat and Responses lowering supports `prompt_cache_options` and explicit `prompt_cache_breakpoint` fields. Auto mode combines explicit stable-prefix markers with OpenAI's implicit latest-message marker; explicit mode disables the managed marker. Pre-5.6 public models use the compatible retention field. The ChatGPT Codex backend uses key-only implicit caching because it rejects `prompt_cache_options`. Model family and route capability are both gated because sending the wrong cache fields can be rejected by the provider.

### OpenAI Responses continuation

Same-turn OpenAI Responses continuation is process-local and opt-in through effective provider storage. The runtime never turns on `store` to obtain continuation.

A stored response can be reused only when the Session execution, route, model, prompt-cache namespace, system digest, tool digest, and semantic request-options digest all match. The next request sends `previous_response_id` plus only the message suffix after the represented response boundary; current system instructions and tools are always sent again.

Continuation state is cleared when the execution ends, is interrupted, compacts, is deleted, or changes fingerprint. Response IDs are not written to Session history, request diagnostics, or the durable provider-request ledger. If a continued request fails before observable output with an invalid-request error, the runtime clears the response state and retries the same logical request once with full history. A second failure follows the normal provider-error path.

### Anthropic and compatible routes

Anthropic cache-control placement is normalized across direct and compatible provider routes. Volatile TeamView state is appended after stable history and does not receive a cache breakpoint.

### Telemetry

The runtime preserves provider-reported cache reads, writes, creation detail, mechanisms, and model/context identity where available. Missing provider telemetry is reported as unreported rather than silently treated as zero.

The TUI exposes last-step context, provider-cache diagnostics, current model context, and total session cost. Cost is calculated from the selected catalog model's input, output, cache-read, cache-write, and eligible context-tier prices. ChatGPT/Codex and Claude Code subscription routes retain those catalog prices, so their nonzero total is an API-equivalent usage estimate rather than a claim about the subscription invoice.

Session diagnostics also expose a bounded request summary: logical requests, transport attempts, helper calls, continued requests, fallbacks, raw token categories, estimated cost, and the latest cache invalidation reason. Only the first eight characters of the latest prompt-cache namespace are exposed; prompt content, full cache keys, system digests, tool digests, and internal provider-request events remain private. When any request lacks catalog pricing, estimated request cost is absent and the TUI renders `Estimated cost unavailable` instead of `$0.00`.

## Provider quota and credit diagnostics

Provider usage is a read-only Location service separate from Session-local token and cost telemetry.

- OpenRouter uses documented current-key data and optional management-credit data.
- OpenAI organization usage uses documented usage and cost endpoints when an explicitly marked admin credential is available.
- Claude subscription state combines live unified response headers with a cached OAuth usage snapshot for cold start, session, all-model, model-specific, and extra-usage buckets. Reported Pro/Max type is included in the safe label.
- Codex and Spark preserve weekly and every additional named limit lane from a configured app-server client contract, with a ChatGPT OAuth backend fallback. Reported Plus/Pro type is included in the safe label.
- snapshots are cached by provider and credential identity; concurrent refreshes are deduplicated;
- a failed refresh retains the last valid snapshot as `stale`;
- provider failures never block Session execution;
- unknown amounts remain absent and render as `Not reported`, not zero;
- Protocol and TUI state contain normalized values only, not credential values or provider response bodies.

The Session command palette exposes a **Provider Usage** dialog. It keeps external quota windows separate from the local **YCoding requests** section, shows active provider windows with freshness and stability, separates Spark and other named lanes, and uses stable ten-character ASCII progress bars for reported percentages. Missing windows and account tiers remain unreported rather than becoming zero or being inferred. The command remains available when local request diagnostics exist even if no external quota provider is currently running.

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
