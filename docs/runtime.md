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

One step is one logical LLM request. Retryable pre-output failures reuse the same logical request ID; each transport start increments its physical-attempt count. A tool-result continuation is a new logical request. Context-overflow failures complete the affected step as an error; they never compact history or rebuild a request automatically.

Every started logical Step closes with exactly one durable terminal event. A provider stream that omits required step settlement fails a started assistant as `provider.invalid-output`; a non-LLM stream failure also closes a started assistant with its normalized Session error before the original cause propagates. A valid settled terminal response containing no non-whitespace assistant text and no local-tool continuation receives one bounded text-only recovery Step. Recovery disables tools, omits synthetic max-step text, disables stored Responses continuation, and fails rather than creating a third Step when it is silent, tool-only, malformed, or provider-failed.

Transport, rate-limit, and provider-internal failures retry only before observable assistant output. Status-less provider messages with a recognized code prefix, including OpenAI `server_error:`, retain their provider-internal classification and use the bounded exponential retry schedule instead of immediately ending the Session response.

The durable provider-request ledger stores identifiers, model and route identity, stable prompt/cache digests, attempt counts, normalized tokens, cost, continuation mode, and invalidation reason. It does not store prompt, message, tool-result, or response text.

Terminal-silence recovery is one additional logical `step` request and is recorded as a full request, not as a physical retry or continuation fallback. Its tool-prefix change may produce the existing cache-invalidation vocabulary.

Before each physical Session-step attempt, the runner derives the exact previously unread promoted user-message IDs that remain in the final model-visible request after history selection, compaction, continuation slicing, and `session:context` hook shaping. It invokes `llm.stream(request)` eagerly once, but records the public durable `session.input.consumed` fact only after the first provider stream event confirms dispatch and before projecting that event; a transport failure before any stream event creates no receipt. The projected user message stores only its first consumption time, so retries do not repeat the fact, and helper-model requests do not create user-message receipts.

The runtime reloads projected history before durable continuation. It does not delegate V2 orchestration to a legacy in-memory prompt loop.

### Helper model traffic

Session titles and goal text are local by default:

- local title generation selects one sanitized line from the first user prompt and makes no provider request;
- local goal synthesis collapses whitespace without changing the request's meaning and makes no provider request;
- model-generated title and goal behavior requires explicit `efficiency` modes;
- `title: "off"` keeps the initial generated Session title;
- conversation summarization is model-based and starts only from the always-registered `conversation_summarize` tool. The stable main-chat guidance treats a genuinely completed phase whose verbatim detail is no longer needed as proactive hygiene rather than a last resort: a durable TOON summary preserves the objective, decisions, constraints, completed and pending work, blockers, and exact identifiers. It still requires the agent to preserve recent and verbatim-needed material, choose a completed-phase boundary rather than summarize merely old history, and treat successful history deletion as irreversible.

Model-based titles and goals resolve the hidden agent's explicit model first, then the matching `efficiency.helper_models.title` or `.goal` selection. Explicit summary resolution uses `efficiency.helper_models.compaction.main` for main chats and `.subagent` for child Sessions: an explicit configured value wins over an agent-pinned model, while a missing value or `session` retains agent-model then that Session's own-model precedence. Helper provider requests use the same content-free request ledger as normal Session steps.

The explicit summarizer validates its requested boundary before provider work, keeps `keep_recent_messages` projected rows after that boundary, and batches oversized source ranges in memory. Each generated batch must declare summary schema `version: 1` and validate as a complete TOON `conversation_memory` document through its exact sequence; it preserves the objective, decisions, constraints, completed and pending work, blockers, and exact identifiers needed to continue without the covered rows. No history is deleted unless the final TOON checkpoint validates. The write phase uses `BEGIN IMMEDIATE`, rechecks the captured range fingerprint, then atomically replaces only covered message-producing events and projections. Protected lifecycle, instruction, task, provider-request, and permission history remains durable; sequence counters and surviving message sequence values are never reset or renumbered. After the tool succeeds, the TUI reloads the canonical projection and releases covered resident messages, so both the visible transcript and the next model request start from the latest summary plus retained recent messages.

Before a model request, the context hook estimates the current system instructions, tool definitions, and model-visible messages against the selected model's safe input budget. It applies the configured `compaction.context_safety_margin_tokens` explicitly. Below 25% it appends nothing. At 25%, 50%, 75%, and 90% it appends one trailing volatile advisory that escalates from informational to a good opportunity, a recommendation to summarize soon, and strong advice. At 100% or higher, the safe input budget is exhausted: the configured safety margin is being consumed, the next provider request risks rejection, and the advisory states that a completed boundary needs summary to continue reliably. Every level remains advisory only; no automatic compaction or recovery exists. This context is not a durable transcript message, receives no cache breakpoint, and does not change the stable system or tool prefix.

### Shell resource control

Shell commands may inherit `shell_memory_limit_mb` or override it with the tool's `memory_limit_mb` input. Zero means unlimited. A finite limit supplies Go and Node runtime memory hints, then monitors aggregate resident memory for the POSIX command process group. If sampled usage exceeds the limit, the existing scoped process-group kill path terminates the command once and records the distinct `memory-limit` terminal status; timeout, normal exit, interruption, and memory enforcement still compete through one first-terminal-state-wins boundary.

The model-visible built-in guidance directs agents to use finite memory limits for high-memory builds, typechecks, test suites, bundlers, and large data processing rather than ordinary commands. The POSIX monitor is sampled resource control with a 250 ms overshoot window, not hard isolation. Windows rejects finite limits until the process launcher can assign a Job Object before execution.

Completed compaction messages implement optional backend metrics for the messages folded by that operation and the normalized provider-reported token usage that produced its summary. Token usage retains input, output, reasoning, cache-read, and cache-write components; clients format any aggregate. If the provider reports no usage, the token metric is absent rather than zero. Older completed-compaction events also project both metrics as absent.

### Stable tool prefix

The provider sees one fixed `execute` tool definition. Its description explains the restricted JavaScript language and the search-first workflow, but it does not embed the current MCP or plugin tool catalog. Connecting, disconnecting, or refreshing an MCP server therefore does not change the provider-visible `execute` schema or the prompt-cache tool digest.

The live catalog remains available inside CodeMode through `search(...)` and exact runtime tool paths. Direct non-CodeMode tool definition changes still rotate the prompt-cache namespace.

MCP server instruction blocks are sorted by server ID, normalized to LF line endings, stripped of trailing whitespace, and limited to 2,048 UTF-8 bytes per server with an explicit truncation marker. These instructions can still change when server guidance changes, but their ordering and size are deterministic and bounded.

### Provider prompt caching

The cache policy revision is part of the prompt-cache namespace. The current policy uses `provider-native/v6`, so requests created under older placement rules do not silently share the same namespace. Explicit summarizer helpers add an internal `summarizer` namespace scope while retaining their exact system and tool digest bytes, so their provider-cache key cannot share normal Session-step state; ordinary Session-step key bytes remain unchanged.

The namespace and durable diagnostics retain the selected catalog model identity. Provider cache capability and model-profile decisions use the executable API model ID, so an aliased catalog model receives the cache controls and limits of the provider model it invokes.

Anthropic-compatible requests start with a concrete five-minute policy. The process-local cache runtime tracks provider-reported read and write usage by stable namespace. Two reusable observations within five minutes promote later requests for an extended-TTL-capable model to one hour. Missing telemetry, stale observations, namespace rotation, and unsupported model profiles remain at five minutes. The state is bounded, non-durable, and never required to reconstruct a Session.

Direct OpenAI Responses requests on GPT-5.6 and later use a stable prompt-cache key. YCoding generates one combined system-text breakpoint and retains explicit breakpoints on every non-volatile user/assistant text boundary, preserving matching candidates across intervening tool calls and results. Responses uses `input_text` EasyInput blocks for a marked assistant message and otherwise preserves its `output_text` replay shape. Tools and tool results remain cacheable inside a later prefix but receive no generated explicit markers. `openai_mode: "auto"` sends request-wide `{ mode: "implicit", ttl: "30m" }`, so OpenAI retains its managed latest-message breakpoint and selects its current latest three explicit write candidates; `openai_mode: "explicit"` disables that managed breakpoint and lets OpenAI select its current latest four explicit write candidates. Earlier explicit markers remain provider read candidates. YCoding does not impose a client read-lookback or write-slot cap because current OpenAI references conflict on the exact read-window size. `30m` is a minimum reuse lifetime, not a hard expiry; OpenAI may retain state longer up to its separate 24-hour maximum. Older public OpenAI models remain implicit and use opt-in `24h` retention only on supported families. The ChatGPT Codex backend has its own `openai-codex-responses` capability identity and receives YCoding's stable `prompt_cache_key`, but not public-API `prompt_cache_options`, `prompt_cache_breakpoint`, or `prompt_cache_retention` fields; public documentation does not contract those fields for subscription access. Compatible gateways and unsupported families also omit GPT-5.6-only fields. Model-based title, goal, and compaction calls use the same policy and observation runtime as normal Session steps.

OpenAI Responses assistant `phase` metadata is preserved through durable message projection and replayed as `commentary` or `final_answer` on later requests. This applies to direct OpenAI and the ChatGPT Codex Responses route when the backend reports a phase.

Direct GPT-5.6 Responses requests enable server-side context management with a `200000`-token compaction threshold. When OpenAI returns an encrypted compaction item on a stateless request, YCoding retains the opaque state for the same model, includes it in the next input, and omits the earlier input items from that request. Stored-response continuation remains separate and still requires explicit provider storage.

OpenAI-hosted web search URL citations enter the normal assistant text lifecycle as a `Source: <title>` line followed by the URL. The same text is returned by the native AI call, stored in durable Session history, and rendered by the TUI transcript.

### Prompt delivery

- **Steer** inputs promote at the next safe step boundary and require the active drain to continue.
- **Queue** inputs remain pending until the session would otherwise become idle.
- Promoting new user input resets the selected agent's step allowance.
- Durable pending user and synthetic inputs are projected back into the resident transcript after message eviction or child-chat navigation. Reopening a child therefore preserves an admitted steer without promoting it early.
- Outbound user bubbles render lifecycle receipts from durable state only: a clock while the admitted input remains pending, one subdued check after promotion, and two info-colored checks after a physical model request consumed that exact message. Assistant, synthetic, and system rows do not render these receipts. Historical promoted messages without a consumption event remain in the sent state; assistant activity is not treated as proof of consumption.

### Tool activity lifecycle

The TUI derives tool activity state and duration from each durable tool's `time.created`, `time.ran`, and `time.completed` fields. Streaming input renders as pending, active execution renders as running with a live elapsed duration, and terminal success, failure, or cancellation freezes the completed duration. Execute child calls, exploration groups, shell and direct CLI rows, and generic tools use the same status grammar; parsed command-result failures override a transport-level completed state. Expanding request or response details never removes the lifecycle status from the primary row.

### Restart safety

Managed-server shutdown marks only process-local active Sessions as suspended before the owned drains stop. Managed-server startup never replays suspended provider work or resumes a Session automatically. Post-crash continuation recovery requires an explicit durable design before it may retry a provider request; retained suspension markers therefore do not themselves admit or execute work.

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

An active goal does not advance or complete while a direct durable child task is `starting`, `running`, `waiting`, or `cancelling`. Terminal child states (`cancelled`, `completed`, `failed`, and `lost`) do not block the next parent wake, including the existing durable child-notification wake path.

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
- Completion notifications are delivered automatically; parent guidance prohibits polling and sleep or no-op waiting, and directs the model to continue useful work or finish its response until notification arrives.
- Parent TeamView context is injected as a volatile message after durable history so changing child state does not destabilize the provider-cache prefix.
- TeamView is model-facing coordination data, not user-facing narration. The parent keeps launch, running, completed, failed, and total bookkeeping silent unless the user explicitly asks for subagent status.
- A child failure may still be reported when it blocks the requested outcome, but not as routine orchestration bookkeeping.
- Running children receive a status, blocker, and ETA request every ten minutes.
- A child question reported through orchestration receives the safe default answer immediately when its managed Session family is in `yolo` or active `goal` mode. The task remains running, and no parent-question notification or sound is emitted.
- The effective permission policy limits which subagents are available.
- Configured and managed subagents materialize the Location's registered tool catalog through their ordered permission rules and inherited parent ceiling. Empty managed-agent rules resolve to safe defaults with shell requiring approval; final `subagent` and `subagent_control` denies prevent nested orchestration.
- Nested subagents are bounded by `experimental.subagent_depth`; the default depth is one.
- Session restart and TUI rehydration use durable orchestration state rather than requiring the user to open every child chat.

The public managed-subagent list returns one page of at most 10 direct durable task records plus exact family-wide `total`, `active`, `running`, and `waiting` counts. `active` includes `waiting`, `starting`, `running`, and `cancelling`. Rows sort by `waiting`, `starting`, `running`, `cancelling`, then the terminal group, with each group ordered by durable update time descending and Session ID ascending; opaque previous and next cursors preserve that order in either direction.

The TUI keeps one such page resident per parent and replaces it rather than appending when the user moves older or newer. The rail and composer use the exact summary independently from the resident row count. Sibling navigation loads adjacent pages only when crossing a page boundary or locating a child absent from the current page; paging never deletes or truncates durable child Session, task, message, ownership, permission, nesting, or background-execution state.

Subagents do not synchronously return their final result to the initiating tool call. Parent notification and child-session inspection are the completion paths.

## Skills

Skills can activate through an explicit reference or the `skill` tool.

Session skill status derives from the durable transcript and instruction state:

- an activated skill is `active`;
- an agent switch marks prior active skills inactive with `agent_switched`;
- completed compaction marks prior active skills inactive with `compacted`;
- resolving an active skill-to-skill conflict marks only the chosen loser inactive with `conflict_resolved`;
- conflicts are computed between active skills and against declared instruction keys;
- already-active tool loads are not duplicated as new active entries.

Implemented: `SessionV2.resolveSkillConflict({ sessionID, winner, loser })` verifies the current derived conflict and records `session.skill.deactivated.1`. Its projection annotates the losing skill's existing activation message, so status remains derived from durable messages and current instruction keys. A missing or inactive pair, or a pair without a current skill conflict, fails without changing Session history. Resolution does not resume model execution or change the remaining skill's instruction snapshot.

Implemented: clients invoke the durable operation with `POST /api/session/:sessionID/skill/resolve` and JSON payload `{ winner, loser }`. Success returns no content. A missing active conflict returns the stable public `SkillConflictNotFoundError` response without exposing the internal Core error or either skill identifier.

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

The TUI keeps transcript memory bounded by retaining only the current projection. Explicit summarization changes that projection by replacing covered message history with its validated summary.

### Resident transcript

Implemented: opening or refreshing a Session fetches its complete current projected transcript in one canonical ascending-order request. The TUI retains that complete transcript while the Session is resident, then releases it on navigation or explicit session eviction. A successful `conversation_summarize` call immediately reloads that projection and drops the covered rows from resident memory. A long Session that has never been summarized therefore consumes TUI memory proportional to all current projected messages; a summarized Session retains only the latest summary and surviving recent messages.

### Rendering guarantees

Transcript rows are reduced from resident messages. A row whose backing message or assistant part has been evicted is not mounted, so it consumes no blank terminal block during navigation, resume, or reconnect.

Timeline selection is preserved by option value rather than list index because new messages can reorder the list.

## Provider caching and diagnostics

Caching is split into distinct concerns:

- stable model-visible prompt prefixes;
- provider-native prompt caching;
- normalized cache-usage telemetry;
- TUI diagnostics;
- project artifact reuse, which is not a provider prompt cache.

### OpenAI

For GPT-5.6 and later, direct public OpenAI Responses lowering supports `prompt_cache_options` and explicit `prompt_cache_breakpoint` fields. Auto mode combines explicit stable-prefix markers with OpenAI's implicit latest-message marker; explicit mode disables the managed marker. Pre-5.6 public models use the compatible retention field. The ChatGPT Codex backend uses key-only implicit caching because it rejects `prompt_cache_options`. Direct OpenAI is Responses-only; OpenAI-compatible Chat remains available only for configured third-party deployments. Model family and route capability are both gated because sending the wrong cache fields can be rejected by the provider.

### OpenAI Responses continuation

Same-turn OpenAI Responses continuation is process-local and opt-in through effective provider storage. The runtime never turns on `store` to obtain continuation.

A stored response can be reused only when the Session execution, route, model, prompt-cache namespace, system digest, tool digest, and semantic request-options digest all match. The next request sends `previous_response_id` plus only the message suffix after the represented response boundary; current system instructions and tools are always sent again.

Continuation state is cleared when the execution ends, is interrupted, compacts, is deleted, or changes fingerprint. Response IDs are not written to Session history, request diagnostics, or the durable provider-request ledger. If a continued request fails before observable output with an invalid-request error, the runtime clears the response state and retries the same logical request once with full history. A second failure follows the normal provider-error path.

### Anthropic and compatible routes

Anthropic cache-control placement is normalized across direct and compatible provider routes. Volatile TeamView state and context-pressure advisories are appended after stable history and do not receive cache breakpoints.

### Telemetry

The runtime preserves provider-reported cache reads, writes, creation detail, mechanisms, and model/context identity where available. Missing provider telemetry is reported as unreported rather than silently treated as zero.

The TUI exposes last-step context, provider-cache diagnostics, current model context, and total session cost. Context and provider-cache fields describe the latest assistant step after the latest completed compaction, while request-summary totals cover the Session's lifetime durable provider-request ledger. Cost is calculated from the selected catalog model's input, output, cache-read, cache-write, and eligible context-tier prices. ChatGPT/Codex and Claude Code subscription routes retain those catalog prices, so their nonzero total is an API-equivalent usage estimate rather than a claim about the subscription invoice. Parent and child Sessions can reuse a prefix only when every model-visible namespace input matches; changing provider, model, variant, policy, permission ceiling, system, or tool definitions creates a distinct key.

Session diagnostics also expose a bounded request summary: logical requests, transport attempts, helper calls, continued requests, fallbacks, raw token categories, estimated cost, and the latest cache invalidation reason. The reader recognizes historical records without an explicit variant as the default variant. For a new request, `compaction-reset` takes precedence over `model-switched`, which takes precedence over `model-variant-switched`; unchanged model identity then reports system, tool, or generic prefix changes. Only the first eight characters of the latest prompt-cache namespace are exposed; prompt content, full cache keys, system digests, tool digests, and internal provider-request events remain private. When any request lacks catalog pricing, estimated request cost is absent and the TUI renders `Estimated cost unavailable` instead of `$0.00`.

### Model-switch context admission

Before changing a Session model, the runtime resolves the target model in the Session Location catalog and estimates the persisted rolling summary plus active recent history against its safe input budget. The budget reserves the target maximum output and the effective `compaction.context_safety_margin_tokens`; an absent margin is explicitly zero. A fitting switch appends the normal durable model-selection event. An over-budget switch returns structured `ModelSwitchBlockedError` data and leaves the selected model, summary, transcript, and compaction state unchanged. It never triggers summarization; an optional `maximumSafeSummaryBoundary` is advisory and exists only when configured `keep_recent_messages` leaves a fitting recent tail. Selection waits for an active drain to settle, so the started provider request retains its original model and the new model applies to the following request boundary.

## Provider quota and credit diagnostics

Provider usage is a read-only Location service separate from Session-local token and cost telemetry.

- OpenRouter uses documented current-key data and optional management-credit data.
- OpenAI organization usage uses documented usage and cost endpoints when an explicitly marked admin credential is available.
- Claude subscription state combines live unified response headers with a cached OAuth usage snapshot for cold start, session, all-model, model-specific, and extra-usage buckets. Reported Pro/Max type is included in the safe label.
- Codex and Spark preserve weekly and every additional named limit lane from a configured app-server client contract, with a ChatGPT OAuth backend fallback. Reported Plus/Pro type is included in the safe label.
- **Implemented:** GitHub Copilot reporting uses its existing OAuth credential without a configuration key. A read-only, best-effort refresh reads paid quota snapshots or free and limited quota windows; token-based-billing seats instead read organization AI-credit billing summaries. GitHub AI credits use the fixed rate of `$0.01` USD each. A remembered organization is re-discovered if it no longer returns AI-credit data.
- snapshots are cached by provider and credential identity; concurrent refreshes are deduplicated;
- a failed refresh retains the last valid snapshot as `stale`;
- provider failures never block Session execution;
- unknown amounts remain absent and render as `Not reported`, not zero;
- Protocol and TUI state contain normalized values only, not credential values or provider response bodies.

The Session command palette exposes a **Provider Usage** dialog when a provider selected by any Session in the current root family has visible quota data, including idle family members, or when local request diagnostics exist. It keeps external quota windows separate from the local **YCoding requests** section, shows provider windows with freshness and stability, separates Spark and other named lanes, and uses stable ten-character ASCII progress bars for reported percentages. Each provider quota section has a provider header followed by one indented row per quota window; it adds an indented `Reset` row only for the nearest known upcoming reset, formatted as `in 12m`, `in 5h`, or `in 2d 3h`.

For GitHub Copilot models with a non-tiered registry cost, each local token bucket—raw input, raw output, cache read, and cache write—adds an AI-credit column calculated from that model's registry rate and the fixed `$0.01`-per-credit conversion. Other providers retain a single token column. No context-length price multiplier is applied: the presentation selects no context-tiered rate. Missing windows, resets, account tiers, and prices remain unreported rather than becoming zero or being inferred.

## Shell output

A dedicated shell-output route provides full-width shell inspection separate from the session transcript.

### Entry

The shell tab in the composer lists running shells grouped by owning session (Main chat, Subagent, or Unknown session). Each entry shows the command, working directory, PID, elapsed time, and status. Selecting a shell entry and pressing return navigates to that shell's dedicated output view.

### Dedicated output view

The `shell-output` route renders a full-width view with:

- **Header** — command, owner label, PID, and status, color-coded by status.
- **Stream** — a scrollable output area that loads the shell's captured output incrementally. Output is fetched from the server with a cursor-based paginator and accumulated in the view. Running shells poll for new output every second.
- **Metadata** — Owner, Status, Started, and Capture.
- **Footer** — shell ID, PID, owner, and action labels with bound shortcuts.

### Actions

- **Back** — the configurable `shell-output.back` binding returns to the parent session transcript. Its default is escape.
- **Kill** — the configurable `shell-output.kill` binding sends a server-side shell removal request for a running shell. Its default is ctrl+d, and the footer shows the kill binding only while the shell is running.

### Keybindings

| Default key | Command             | Action                           |
| ----------- | ------------------- | -------------------------------- |
| escape      | `shell-output.back` | Navigate back to session         |
| ctrl+d      | `shell-output.kill` | Kill the running shell command   |

## Subagent sibling navigation and economics

The TUI provides sibling-subagent navigation within a parent Session's child family.

### Sibling switcher

A `SubagentSiblingSwitcher` renders at the top of a child session's content area when its parent has child tasks. It uses the parent's current bounded task page and renders:

- a clickable compact agent chip for each visible task on that page;
- the current child first when it is resident;
- a warning-colored `?` prefix when a task is waiting with a question;
- fixed parent, previous-page, and next-page navigation hints plus an overflow count when all chips do not fit.

The parent Session is an ↑-prefixed clickable item in the same strip. The active child uses info-colored text, and a blocked task uses warning-colored text. Arrow navigation lazily replaces the resident page when it crosses a page boundary and wraps only after reaching the corresponding family edge.

### Child-session economics and durable state

The session route does not mount `SubagentFooter`. For an unblocked child Session, it mounts `SubagentEconomicsSurface` below the composer. The economics surface renders the available detailed strip: context, reported or unreported cache telemetry, cost, and parent rollup.

### Economics computation

`subagentEconomics` computes a summary string and a detailed strip from Session info and cache diagnostics. The mounted `SubagentEconomicsSurface` uses the detailed strip, which includes context, reported or unreported cache telemetry, cost, and parent rollup. Tokens are formatted with `Intl.NumberFormat` and cost with `Intl.NumberFormat` currency formatting. Diagnostics are derived from the same `SessionCacheDiagnostics` type used by the main Session.

### Blocked subagent answer presentation

A subagent is considered blocked when its orchestration task state is `waiting` and a `question` is present. The TUI surfaces blocked state in:

- **Sibling switcher** — warning-colored text and a `?` prefix on the agent chip.
- **Child Session** — `SubagentBlockedSurface` appears above the transcript, and `SubagentAnswerComposer` replaces the normal composer only while the child is waiting with a question. The ordinary economics surface is withheld while blocked.
- **Sidebar rail** — an `awaitingInput` glyph, warning-colored value text showing the question text, and the `attention` prop on the rail section header.
- **Composer subagent tab** — an `awaitingInput` glyph rendered in warning color, the question text shown as detail.

## Rail priority and expanded-state behavior

The rail sidebar uses a priority system to keep the number of simultaneously expanded sections bounded.

### Section keys

The rail supports these section keys: `session`, `context`, `todo`, `goal`, `autonomy`, `subagents`, `shells`, `skills`, `mcp`, `plugins`, `guardrails`, `lsp`.

### Default expanded sections

The initial expansion order is `session`, `context`, optional `goal`, optional `autonomy`, then `todo`; the rail retains the four most recently listed entries. Thus `todo` is always initially expanded, and `session` is omitted when both optional sections are present. Sections that carry a summary on their header row (`subagents`, `shells`, `skills`, `mcp`, `plugins`, `guardrails`, `lsp`) are collapsed by default to conserve vertical space.

### Expansion cap

Expansion is capped at `MAX_EXPANDED = 4` sections. When the cap is reached, expanding a new section collapses the least recently expanded section. This prevents the rail from becoming a scroll wall where every section is half visible.

### Attention-driven expansion

The `RailSection` component accepts an `attention` boolean prop. An attention transition opens the section. When the attention clears, the implementation collapses that section; it does not preserve a manual expansion made while attention was active.

Attention-triggered expansion respects the cap: if the cap is already reached, the least recently expanded default section is collapsed to make room.

### Attention triggers

The `subagents` section enters attention mode when any subagent has a pending question. The `shells` section enters attention mode when orphaned shells (shells whose owning session is no longer known) are present. The `autonomy` section enters attention mode when YOLO mode is active.

### Shells section

The sidebar shells section (`SHELLS`) summarizes running shells grouped by owner (Main chat, Subagent, Unknown session). The summary shows counts of running, terminal, and orphaned shells. Orphaned shells trigger the attention state. Each group row shows the owner label and count.

### Subagents section

The sidebar subagents section (`SUBAGENTS`) renders the current managed-task page in API order: `waiting`, `starting`, `running`, `cancelling`, then the terminal group, with durable update time descending and Session ID ascending inside each group. Each row shows the task description with a glyph, the elapsed time or question text, and a warning color when awaiting input. Its exact family summary is `running/total running`, with an additional waiting count when nonzero; older and newer controls replace the resident page. An attention state highlights when any subagent is waiting for input.

### Goal section

The goal section (`GOAL`) appears when goal state exists. It shows the goal text and status; the header summary is the goal status, not a no-progress count.

### Autonomy section

The autonomy section (`AUTONOMY`) shows the current mode label as summary, with attention when YOLO mode is active. Expanded content shows the approval mode (auto for YOLO, manual for normal).

### Rail placement

Rail placement follows terminal width:

- Below 100 columns: hidden.
- 100–119 columns: overlay (floating over the main pane).
- 120 columns and above: docked (fixed sidebar).

Rail width grows linearly from 32 columns at a 120-column terminal to the 50-column design width at 160 columns, then remains capped at 50.

## Terminal release behavior

The TUI is the only release surface and currently includes:

- session transcript and timeline;
- normal, yolo, and goal mode controls;
- subagent tabs, status, notifications, navigation, and sibling switcher;
- child-session sibling switcher, economics surface, and blocked-answer composer;
- session skills and project artifacts;
- distinct guardrail, permission, and form prompts;
- MCP and provider connection flows;
- prompt file, agent, command, skill, and reference autocomplete;
- cache, context, memory, cost, provider quota, and guardrail diagnostics;
- theme and keymap customization;
- complete resident transcript loading;
- dedicated shell output view with kill/back actions;
- rail sidebar with priority-based expanded-state management.

TUI-visible state must rehydrate from durable or canonical API state after process restart. A feature that appears only after visiting a child session or reopening a dialog is a defect unless the interaction itself is the explicit trigger.

## Known boundaries

- Session execution placement is process-local; clustering is not implemented.
- Resident transcript memory is proportional to the complete projected transcript for each open Session.
- V1 compatibility is intentionally absent.
