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

One step is one logical LLM request. Retryable pre-output failures reuse the same logical request ID; each transport start increments its physical-attempt count. A tool-result continuation is a new logical request. One pre-output provider context overflow may invoke the mandatory gate, rebase, and retry the same Step once; a second overflow or an overflow after durable assistant output completes the Step as an error.

Every started logical Step closes with exactly one durable terminal event. A provider stream that omits required step settlement fails a started assistant as `provider.invalid-output`; a non-LLM stream failure also closes a started assistant with its normalized Session error before the original cause propagates. A valid settled terminal response containing no non-whitespace assistant text and no local-tool continuation receives one bounded text-only recovery Step. Recovery disables tools, omits synthetic max-step text, disables stored Responses continuation, and fails rather than creating a third Step when it is silent, tool-only, malformed, or provider-failed.

Retryable pre-output transport, rate-limit, and provider-internal failures reuse one logical request and retry up to ten total physical attempts. Exponential delays start at two seconds and cap at 120 seconds; a provider `retry-after` is a minimum delay only when it is within that same ceiling. Authentication and existing ineligible failure classes do not retry. Status-less provider messages with a recognized code prefix, including OpenAI `server_error:`, retain their provider-internal classification and use this bounded schedule instead of immediately ending the Session response.

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
- selective-compaction selectors and manifest structure are trusted Core output. The optional helper emits only strict checkpoint TOON content; empty, malformed, oversized, timed-out, or provider-failed output uses a local canonical checkpoint;
- the manual compact endpoint and advisory `conversation_compact` calls durably admit background jobs through the latest complete-message boundary. Neither waits for manifest generation or activation.

Model-based titles and goals resolve the hidden agent's explicit model first, then the matching `efficiency.helper_models.title` or `.goal` selection. Selective-compaction manifest generation uses `efficiency.helper_models.compaction.main` for main chats and `.subagent` for child Sessions: an explicit configured value wins over an agent-pinned model, while a missing value or `session` retains agent-model then that Session's own-model precedence. Helper provider requests use the same content-free request ledger as normal Session steps.

Each job captures its requested boundary, base context revision, target input budget, configuration digest, trigger, and admission mode. One leased job runs per Session; the explicit restart-recovery action wakes pending work and work whose lease expired. A waiter also re-wakes nonterminal work before each one-second settlement poll, so a pending job or a running job whose foreign 30-second lease expires can be claimed without a separate recovery call. The worker resolves the Session's current Location only when execution starts.

Core captures the complete boundary and protected-state snapshot, retains at most `compaction.keep_recent_messages` for advisory or manual work, and constructs the manifest without model-authored selectors. Mandatory work protects no recent tail and may summarize through the full captured boundary. Checkpoint content is generated in bounded TOON batches; invalid helper output is replaced with a deterministic local canonical TOON document bounded by the configured byte budget. Core measures the shared synthetic checkpoint plus retained later entries against the selected pre-compaction model history, tightens growing helper output locally, and stores those model-view counters in the manifest. If the configured byte limit is smaller than the minimal canonical document, Core uses that minimal document. Validation still rejects stale revisions or boundaries, protected-tail overlap, changed live state, dependency breakage, and candidates that do not reduce measured input. A background job that races with protected live-state progress refreshes the complete candidate once inside the same lease; a second mismatch fails normally. Mandatory jobs do not use this refresh and remain bounded by the synchronous gate's admission limit. `context_limit_unresolved` means even trusted checkpointing cannot reduce selected model history; `invalid_manifest` is reserved for persisted or invariant corruption rather than ordinary helper output.

Before a model request, the context hook estimates current system instructions, tool definitions, and model-visible messages against the hard input cap `context - output - compaction.context_safety_margin_tokens`. Advisory thresholds default to 70% (`consider`) and 90% (`advised`), accept ordered percentages from 1 through 99, and can be disabled with `compaction.advisory: false`. An advisory is trailing volatile context: it is not a durable transcript message, receives no cache breakpoint, and does not change the stable system or tool prefix.

The built-in `conversation_compact` tool accepts no input fields. At `consider` or `advised` pressure it returns `{ "jobID": "cmp_...", "status": "scheduled" }` after durable admission; below those levels or when advisory compaction is disabled it returns `{ "status": "disabled" }`. Manual admission uses `POST /api/session/:sessionID/compact`, accepts an optional `cmp_` idempotency ID, and returns the same pending durable admission shape. Jobs publish version-2 admitted, started, ended, or failed lifecycle events keyed by `jobID`.

Activation stores a content-addressed manifest, appends one immutable context revision, replaces only the active exclusion projection, rebases opaque provider state, and invalidates stored Responses continuation. A non-empty valid summary counts as retained model context and may cover the manifest's full boundary when no protected recent tail overlaps it. Model-history reads prepend one stable, non-persisted synthetic `<conversation-checkpoint>` derived from the active manifest digest and activation time, then retain only later selected entries. Canonical messages and durable message-producing events remain unchanged, and Protocol and TUI transcript reads retain the complete canonical projection.

The Step runner enforces the absolute safe input cap `context - maximum output - compaction.context_safety_margin_tokens` before an ordinary provider request. At or above the cap, it joins a compatible pending or running job with an equal-or-stricter target without charging that work to the gate's admission budget; an incompatible running job only serializes admission. Every terminal job triggers a rebuilt estimate: `ended` uses `fullRebase: true`, while `failed` uses `fullRebase: false`. If the estimate remains at or above the cap, the gate may own at most two mandatory admissions, the initial job plus one replacement, before one final non-full reload and deterministic `context.limit` failure.

The admission-and-wait workflow has one 61-second foreground deadline. Timeout interrupts only the local wait, unregisters its waiter, and releases the admission gate; it never cancels or fails shared compaction work, which remains independently executable in the background. The runner then reloads with `fullRebase: false` and proceeds only when the rebuilt estimate is strictly below the cap. Stable prefixes or protected live state can still make reduction impossible; in that irreducible case the Step fails promptly with `context.limit`, the coordinator settles, and a later prompt or resume may retry. The runner never sends an ordinary provider request at or above the cap. `compaction.advisory: false` disables only advisory tool admission, not this gate.

Historical destructive summary replacement is decode-only and migration-only: valid V1 replacement events may establish a revision-zero baseline and historical markers may render. New compaction never creates replacement events or deletes canonical history; no active `conversation_summarize` source or tool remains.

### Shell resource control

Shell commands may inherit `shell_memory_limit_mb` or override it with the tool's `memory_limit_mb` input. Zero means unlimited. A finite limit supplies Go and Node runtime memory hints, then monitors aggregate resident memory for the POSIX command process group. If sampled usage exceeds the limit, the existing scoped process-group kill path terminates the command once and records the distinct `memory-limit` terminal status; timeout, normal exit, interruption, and memory enforcement still compete through one first-terminal-state-wins boundary.

The model-visible built-in guidance directs agents to use finite memory limits for high-memory builds, typechecks, test suites, bundlers, and large data processing rather than ordinary commands. The POSIX monitor is sampled resource control with a 250 ms overshoot window, not hard isolation. Windows rejects finite limits until the process launcher can assign a Job Object before execution.

Current version-2 completed compaction messages carry the activated revision and boundary plus excluded-message, excluded-part, input-token, and retained-token metrics. Historical version-1 completed rows may carry optional folded-message and normalized provider-token metrics; absent historical values remain absent rather than becoming zero.

### Stable tool prefix

The provider sees one fixed `execute` tool definition. Its description explains the restricted JavaScript language and the search-first workflow, but it does not embed the current MCP or plugin tool catalog. Connecting, disconnecting, or refreshing an MCP server therefore does not change the provider-visible `execute` schema or the prompt-cache tool digest.

The live catalog remains available inside CodeMode through `search(...)` and exact runtime tool paths. Direct non-CodeMode tool definition changes still rotate the prompt-cache namespace.

MCP server instruction blocks are sorted by server ID, normalized to LF line endings, stripped of trailing whitespace, and limited to 2,048 UTF-8 bytes per server with an explicit truncation marker. These instructions can still change when server guidance changes, but their ordering and size are deterministic and bounded.

### Provider prompt caching

The cache policy revision is part of the prompt-cache namespace. The current policy uses `provider-native/v7`, so requests created under older placement rules do not silently share the same namespace. Compaction helper requests add an internal `compaction` namespace scope while retaining their exact system and tool digest bytes, so their provider-cache key cannot share normal Session-step state; ordinary Session-step key bytes remain unchanged.

The namespace and durable diagnostics retain the selected catalog model identity. Provider cache capability and model-profile decisions use the executable API model ID, so an aliased catalog model receives the cache controls and limits of the provider model it invokes.

Anthropic-compatible requests start with a concrete five-minute policy. The process-local cache runtime tracks provider-reported read and write usage by stable namespace. Two reusable observations within five minutes promote later requests for an extended-TTL-capable model to one hour. Missing telemetry, stale observations, namespace rotation, and unsupported model profiles remain at five minutes. The state is bounded, non-durable, and never required to reconstruct a Session.

Direct OpenAI Responses requests on GPT-5.6 and later use a stable prompt-cache key and exact `input_text` breakpoints. YCoding keeps one combined system-text breakpoint plus the newest eligible non-volatile user and local tool-result text boundaries within OpenAI's latest-50 read-candidate window. Assistant replay always uses `output_text` and never receives a breakpoint. A marked local tool result uses an `input_text` block inside `function_call_output.output`; structured media remains in its existing provider-native blocks. Tool definitions, tool calls, provider-executed tool results, and volatile messages receive no generated marker. `openai_mode: "auto"` sends request-wide `{ mode: "implicit", ttl: "30m" }`, reserves one read candidate for OpenAI's managed implicit breakpoint, and emits at most 49 explicit candidates. `openai_mode: "explicit"` disables that managed breakpoint and emits at most 50 explicit candidates. OpenAI can write the latest three explicit candidates plus the managed breakpoint in implicit mode, or the latest four explicit candidates in explicit mode. `30m` is a minimum reuse lifetime, not a hard expiry; OpenAI may retain state longer up to its separate 24-hour maximum. Older public OpenAI models remain implicit and use opt-in `24h` retention only on supported families. The ChatGPT Codex backend has its own `openai-codex-responses` capability identity and remains key-only because inline breakpoint support is not uniform across its models. YCoding sends none of `prompt_cache_breakpoint`, `prompt_cache_options`, or `prompt_cache_retention` on that route. Codex sends `session-id` equal to the stable key and sends `thread-id` plus `x-client-request-id` equal to the per-YCoding-Session provider identity. Compatible gateways and unsupported families also omit GPT-5.6-only fields. Model-based title, goal, and compaction calls use the same policy and observation runtime as normal Session steps.

OpenAI Responses assistant `phase` metadata is preserved through durable message projection and replayed as `commentary` or `final_answer` on later requests. This applies to direct OpenAI and the ChatGPT Codex Responses route when the backend reports a phase.

Direct GPT-5.6 Responses requests enable server-side context management with a `200000`-token compaction threshold. When OpenAI returns an encrypted compaction item on a stateless request, YCoding retains the opaque state for the same model, includes it in the next input, and omits the earlier input items from that request. Stored-response continuation remains separate and still requires explicit provider storage.

OpenAI-hosted web search URL citations enter the normal assistant text lifecycle as a `Source: <title>` line followed by the URL. The same text is returned by the native AI call, stored in durable Session history, and rendered by the TUI transcript.

### Prompt delivery

- **Steer** inputs promote at the next safe step boundary and require the active drain to continue.
- **Queue** inputs remain pending until the session would otherwise become idle.
- Promoting new user input resets the selected agent's step allowance.
- Durable pending user and synthetic inputs are projected back into the resident transcript after message eviction or child-chat navigation. Reopening a child therefore preserves an admitted steer without promoting it early.
- Outbound user bubbles render lifecycle receipts from durable state only: a clock while the admitted input remains pending, one subdued check after promotion, and two info-colored checks after a physical model request consumed that exact message. Assistant, synthetic, and system rows do not render these receipts. Historical promoted messages without a consumption event remain in the sent state; assistant activity is not treated as proof of consumption.
- Outbound user bubbles render a width-derived bounded preview of oversized prompt text. The canonical message retains the full prompt for message actions, including copy, editor, fork, and revert; the transcript never mounts the omitted text.

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

A tool-only turn with no assistant text spends an iteration but does not increment the no-progress counter. The TUI refreshes autonomy when session execution reaches a terminal event so displayed progress is not one iteration stale. Its top-right session status combines active YOLO or goal mode with the operational state; while retrying, it shows a failure marker, completed failure count, next retry number, and seconds until that retry. While main-session working is active, its decorative dot trail advances every 160 ms and uses the same semantic color as the adjacent status label.

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

### Built-in agents

Every Location activates the maintained built-in catalog. The default selectable primary agent is `god`; omitting a configured primary selection resolves `god`. The selectable primary built-ins are `TLDR`, `architech`, `god`, and `yangi`. The maintained task subagents are `occam`, `omoikane`, `wittgenstein`, and `zeus`.

`god`, `architech`, `TLDR`, and `yangi` use the historical `build`-equivalent permission defaults. `occam`, `omoikane`, `wittgenstein`, and `zeus` use the historical `general`-subagent-equivalent permission defaults. All eight execution agents explicitly allow `shell:*`; these profiles do not change the read-only `btw` advisor or the hidden `compaction`, `title`, `goal`, and `summary` utility agents.

`btw` remains a visible read-only advisor. The hidden `compaction`, `title`, `goal`, and `summary` agents remain internal helpers. `build`, `plan`, `explore`, and `general` are not built-ins, and the disabled source definitions `analyze` and `brainstorm` are not registered.

Current behavior:

- The `subagent` tool always launches work in the background.
- The tool returns the child Session ID immediately.
- The child runs a configured non-primary agent with fresh context.
- The parent receives lifecycle state and completion or failure notification.
- Once a parent has no local runnable work, it completes its own response and is free even while child Sessions continue in the background.
- Completion notifications are delivered automatically; parent guidance prohibits polling and sleep or no-op waiting, and directs the model to continue useful work or finish its response until notification arrives.
- Parent TeamView context is injected as a volatile message after durable history so changing child state does not destabilize the provider-cache prefix.
- TeamView is model-facing coordination data, not user-facing narration. Parent transcripts do not render child launch, running, or completion activity; the sidebar and session picker expose that state. The parent keeps launch, running, completed, failed, and total bookkeeping silent unless the user explicitly asks for subagent status.
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

The TUI keeps each resident Session's complete canonical projection. Selective compaction changes only model-history selection; it does not replace, delete, or release canonical transcript rows.

The SQLite `session_file_change` ledger is a rebuildable projection. Its dedicated housekeeping service runs at startup and hourly, deleting ledger rows only when `session.time_updated < now - 30 days`, except for executor-active Sessions. Durable events and message/transcript projections are never deleted; replaying retained `session.file-change.recorded` facts rebuilds a removed ledger row deterministically.

### Resident transcript

Implemented: opening or refreshing a Session fetches its complete current projected transcript in one canonical ascending-order request. The TUI retains that complete transcript while the Session is resident, then releases it on navigation or explicit session eviction. Local selective-compaction activation does not clear, refetch, or filter those rows; lifecycle rows are reconciled separately by `jobID`. Resident memory therefore remains proportional to the canonical projected transcript. Historical V1 summary messages still decode and render, and migration can derive an initial context baseline from valid historical replacement state, but new selective compaction does not create destructive summary replacement.

### Rendering guarantees

Transcript rows are reduced from resident messages. A row whose backing message or assistant part has been evicted is not mounted, so it consumes no blank terminal block during navigation, resume, or reconnect.

Restored instruction and other notice text renders as Markdown. Active guardrail rows follow the projected transcript, including completed compaction markers, so current activity stays at the transcript tail. Child activity renders in the sidebar and session picker instead of the parent transcript. Todos render exclusively in the sidebar.

The final change summary aggregates only parseable diffs captured by completed `edit` and `patch` tool parts from the parent and completed direct-child transcripts. Completed diffs with the same resolved path aggregate into one collapsed expandable row, preserving first-seen order and summed additions and deletions. It does not represent shell or `write`-tool mutations or every final workspace change.

Timeline selection is preserved by option value rather than list index because new messages can reorder the list.

## Provider caching and diagnostics

Caching is split into distinct concerns:

- stable model-visible prompt prefixes;
- provider-native prompt caching;
- normalized cache-usage telemetry;
- TUI diagnostics;
- project artifact reuse, which is not a provider prompt cache.

### OpenAI

For GPT-5.6 and later, direct public OpenAI Responses lowering supports `prompt_cache_options` and explicit `prompt_cache_breakpoint` fields on system, user, and local tool-result input blocks; assistant replay always remains unmarked `output_text`. Auto mode combines explicit stable-prefix markers with OpenAI's implicit latest-message marker; explicit mode disables the managed marker. Pre-5.6 public models use the compatible retention field. The ChatGPT Codex backend remains key-only and receives none of the public cache-control fields because its current models do not accept explicit breakpoints uniformly; its cache and thread affinity headers still use the stable prompt-cache key and per-YCoding-Session provider identity respectively. Direct OpenAI is Responses-only; OpenAI-compatible Chat remains available only for configured third-party deployments. Model family and route capability are gated independently because sending the wrong cache field can be rejected by the provider.

Direct OpenAI Responses lowers user image attachments and local tool-result images into `input_image` content. The optional `providerOptions.openai.imageDetail` selects `auto`, `low`, `high`, or `original`; omission leaves the provider default `auto`. `original` is rejected before the request for unsupported models, including GPT-5.4 mini and nano. Remote image URL and `file_id` references are not implemented.

### OpenAI Responses continuation

Stored OpenAI Responses continuation is durable Session state and is enabled only when `efficiency.openai_responses_state` is `stored`, the continuation policy is not `off`, and the effective request has `store: true`.

A stored response can be reused only when the context revision, continuation generation, connection identity, route, model, variant, prompt-cache namespace, system digest, tool digest, volatile-context digest, semantic request-options digest, and represented message boundary all match. The next request sends `previous_response_id` plus only the message suffix after that boundary; current system instructions and tools are always sent again. Credential or connection changes alter the connection identity and prevent reuse.

GitHub Copilot Responses through the AI SDK route is explicitly stateless (`store: false`). Every follow-up sends full selected history instead of `previous_response_id` continuation or provider-stored item references. Retained encrypted reasoning items and local tool outputs are replayed directly, and the route still receives the stable `prompt_cache_key`; Copilot-specific options override generic Responses options when both are present. Copilot reasoning-summary fragments close before the next fragment starts, while the final closure retains encrypted reasoning metadata for replay.

GitHub Copilot catalog models using the Anthropic Messages AI SDK package also resolve through the configured AI SDK loader, preserving Copilot authentication and transport rather than attempting direct Anthropic API authentication. Direct Anthropic models retain their native Messages route.

Continuation state is invalidated by context-revision activation and explicit clear paths; any fingerprint mismatch also makes a stored row ineligible. Response IDs are not written to Session history, request diagnostics, or the durable provider-request ledger. If a continued request fails before observable output with an invalid-request error, the runtime clears the response state and retries the same logical request once with full history. A second failure follows the normal provider-error path.

### Anthropic and compatible routes

Anthropic cache-control placement is normalized across direct and compatible provider routes. Volatile TeamView state and context-pressure advisories are appended after stable history and do not receive cache breakpoints.

### Telemetry

The runtime preserves provider-reported cache reads, writes, creation detail, mechanisms, and model/context identity where available. Missing provider telemetry is reported as unreported rather than silently treated as zero.

The TUI exposes last-step context, provider-cache diagnostics, current model context, and total session cost. Context and provider-cache fields describe the latest assistant step after the latest completed compaction, while request-summary totals cover the Session's lifetime durable provider-request ledger. Cost is calculated from the selected catalog model's input, output, cache-read, cache-write, and eligible context-tier prices. ChatGPT/Codex and Claude Code subscription routes retain those catalog prices, so their nonzero total is an API-equivalent usage estimate rather than a claim about the subscription invoice. Parent and child Sessions can reuse a prefix only when every model-visible namespace input matches; changing provider, model, variant, policy, permission ceiling, system, or tool definitions creates a distinct key.

Session diagnostics also expose a bounded request summary: logical requests, transport attempts, helper calls, continued requests, fallbacks, raw token categories, estimated cost, and the latest cache invalidation reason. The reader recognizes historical records without an explicit variant as the default variant. For a new request, `compaction-reset` takes precedence over `model-switched`, which takes precedence over `model-variant-switched`; unchanged model identity then reports system, tool, or generic prefix changes. Only the first eight characters of the latest prompt-cache namespace are exposed; prompt content, full cache keys, system digests, tool digests, and internal provider-request events remain private. When any request lacks both provider and OpenRouter master catalog pricing, estimated request cost is absent and the TUI renders `Estimated cost unavailable` instead of `$0.00`.

Provider-request rows and per-session, per-model usage aggregates are durable projections of `session.provider.request.recorded` events. `GET /api/session/:sessionID/usage` returns their aggregate after transcript compaction or when cache diagnostics are unavailable. A root Session folds its complete child family by provider, model, and variant; a child Session remains scoped to its own requests. For historical rows without durable cost, the read model uses the current Location catalog and then the current OpenRouter master catalog for the same model and variant; the TUI presents the resulting amount without a separate provenance label. Historical rows backfill when the aggregate table is introduced. Pricing absent from both catalogs keeps the affected model group and whole-session estimated cost unreported; it never becomes zero.

The runtime removes only raw provider-request and usage-aggregate projections for Sessions whose `time_updated` is older than 30 days and which are not active in the local `SessionExecution` process. Cleanup runs at service startup and hourly. It never removes EventV2 records or transcript rows, and pending or suspended status does not change retention.

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

| Default key | Command             | Action                         |
| ----------- | ------------------- | ------------------------------ |
| escape      | `shell-output.back` | Navigate back to session       |
| ctrl+d      | `shell-output.kill` | Kill the running shell command |

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
