# Provider efficiency and prompt caching design

Status: approved through user auto-approval

## Goal

Reduce YCoding provider usage and cost without lowering answer correctness, hiding real usage, weakening durable Session behavior, or requiring one provider.

The program addresses the full request path rather than treating prompt-cache markers as the only optimization:

1. measure logical and physical provider-request amplification;
2. remove nonessential helper calls from the default path;
3. keep the provider-visible prefix stable;
4. use provider-native cache controls safely;
5. reuse OpenAI Responses state within a turn when the configured data-retention policy already permits it;
6. distinguish raw token volume from estimated billed cost.

## Evidence from the current repository

YCoding already has a strong cache foundation:

- `packages/ai/src/cache-policy.ts` applies deterministic Anthropic and Bedrock breakpoints for tools, system instructions, and recent messages;
- `packages/ai/src/cache-profile.ts` knows family-specific cache minimums and one-hour TTL support;
- `packages/core/src/session/runner/cache.ts` creates a cross-Session stable prompt-cache namespace from the effective model, permissions, system instructions, and tool schemas;
- tool definitions are sorted before request construction;
- provider cache reads and writes are normalized into Session usage and diagnostics.

The current efficiency gaps are outside or above that marker layer:

- every tool continuation reconstructs the full logical request;
- OpenAI protocol code supports explicit breakpoints and cache options, but Core supplies only `promptCacheKey`;
- first-prompt title generation is an additional provider call and resolves the main Session model unless overridden;
- goal synthesis is another provider call and also resolves the main Session model unless overridden;
- compaction uses a separate provider call;
- the CodeMode `execute` description embeds a changing partial MCP/tool catalog, so MCP connection changes can alter the tool prefix and cache namespace;
- diagnostics show raw cache tokens but do not explain request count, helper traffic, prefix invalidation, or estimated billed cost.

## Reference patterns

The design adapts patterns rather than copying implementations:

- OpenAI Codex keeps a per-turn model client session, reuses a Responses WebSocket connection, maintains sticky per-turn state, and supports `previous_response_id` reuse when the request remains compatible: <https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs>.
- OpenAI documents `prompt_cache_key`, extended cache retention, and Responses application-state retention. Enabling stored Responses state is a data-retention decision, not a transparent optimization: <https://platform.openai.com/docs/models/default-usage-policies-by-endpoint>.
- Anthropic requires exact prefix stability and documents cache invalidation when tools or system content change. Claude Code release notes repeatedly identify dynamic tool descriptions, deferred tools, subagent prompts, and nonessential title traffic as cache-cost sources: <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>.
- The user-supplied reconstructed Claude Code repository remains comparison material only: <https://github.com/tanbiralam/claude-code>.

## Approaches considered

### A. Cache-control patch only

Enable OpenAI explicit fields and adjust Anthropic TTLs.

Advantages:

- small diff;
- low implementation risk.

Rejected because it cannot explain or reduce extra title, goal, compaction, retry, and subagent requests. It also leaves dynamic tool-prefix invalidation and misleading raw-token totals unchanged.

### B. Provider-native efficiency program — selected

Add observability first, then improve helper routing, prefix stability, provider cache policy, guarded continuation, and cost presentation.

Advantages:

- identifies the actual cause of usage before and after each change;
- preserves the current durable runtime;
- keeps provider-specific behavior behind explicit capability boundaries;
- supports safe staged rollout and fallback.

### C. Stateful provider-client rewrite

Replace the stateless AI route layer with long-lived provider sessions for every provider.

Rejected for this program because it couples unrelated providers, expands failure recovery and persistence scope, and delays the immediate high-confidence savings.

## Architecture

The work is divided into six independently releasable layers.

### 1. Provider-request ledger

Add a durable, content-free request record for every logical model invocation. It records metadata and digests, never prompt text, tool output, credentials, or provider response bodies.

Each record contains:

- Session ID and source: `step`, `title`, `goal`, `compaction`, or future named helper;
- parent user-admission ID or durable execution identity when available;
- selected provider, model, variant, route, and agent;
- logical request number and physical transport-attempt count;
- system digest, tool digest, prompt-cache namespace, and prefix token estimate;
- cache policy, TTL bucket, cache mechanism, and continuation mode;
- uncached input, cache read, cache write, output, reasoning, and normalized cost;
- an invalidation classification: first request, stable hit, prefix changed, below provider minimum, provider did not report, cache disabled, or retry/fallback.

Physical attempt count is emitted by the AI transport and folded into the logical invocation record. Provider retries must not disappear behind one logical `LLM.stream` call.

The ledger is projected into Session diagnostics and the existing provider-usage command. It is not model-visible.

### 2. Helper traffic policy

Add a top-level `efficiency` configuration object.

```jsonc
{
  "efficiency": {
    "title": "local",
    "goal_synthesis": "local",
    "helper_model": "provider/model#variant",
    "prompt_cache": {
      "anthropic_ttl": "adaptive",
      "openai_mode": "auto",
      "openai_extended_retention": false,
    },
    "openai_responses_continuation": "auto",
  },
}
```

Defaults:

- `title: "local"` — derive a bounded title deterministically from the first user message. `"model"` preserves the current model-generated behavior; `"off"` preserves the initial generated Session title.
- `goal_synthesis: "local"` — use the normalized user request as the durable goal. `"model"` preserves the current synthesis call.
- `helper_model` is optional. When present, title-model mode, goal-model mode, and compaction use that selection unless the corresponding hidden agent has an explicit model override. Without it, model-based helpers retain the current model-resolution fallback.
- Compaction remains model-based because local truncation is not an adequate semantic replacement. Helper-model routing and bounded reasoning/output settings reduce its cost without changing the durable compaction contract.

Precedence for helper model selection:

1. explicit hidden-agent model (`title`, `goal`, or `compaction`);
2. `efficiency.helper_model`;
3. current Session model.

The local title and goal paths perform no provider call and emit no fake usage record.

### 3. Stable provider-visible prefix

The provider-visible `execute` tool definition becomes independent of the live MCP and CodeMode catalog.

- Its name, input schema, output schema, and description are constant.
- The description explains the fixed discovery protocol: run `return search({ query })`, then call an exact returned path in a later execution.
- The changing catalog remains inside the confined CodeMode runtime and search index; it is not serialized into the tool definition.
- Direct non-CodeMode tools remain sorted and schema-described as today.
- MCP-provided ambient instructions are normalized, deterministically ordered, and bounded per server. They remain part of the effective system digest because they may change model behavior.
- Dynamic state such as TeamView remains volatile and cannot enter the prompt-cache namespace.

A connected, failed, or newly discovered MCP server may change available runtime search results without changing the `execute` provider prefix.

### 4. Adaptive provider cache policy

#### Anthropic and compatible routes

Replace unconditional one-hour static-prefix placement with an adaptive state machine keyed by the prompt-cache namespace:

- first eligible request: five-minute static and tail breakpoints;
- after two observed eligible uses of the same namespace within five minutes: promote tools and system to one hour;
- reset to five minutes when the namespace changes or the provider reports no reusable prefix;
- process restart resets the optimization state safely to five minutes;
- explicit user configuration `"5m"` or `"1h"` overrides adaptive behavior.

The state is an optimization cache, not durable Session state. A lost state entry affects cost only.

#### OpenAI routes

`openai_mode: "auto"` means:

- GPT-5.6 and later Responses/Chat routes receive explicit stable-prefix breakpoints and `promptCacheOptions: { mode: "explicit" }`;
- older supported routes retain implicit prefix caching;
- unsupported or compatible-provider routes receive only fields their route capability declares;
- `openai_extended_retention: true` adds 24-hour retention only when the route supports it and the user accepts the associated application-state implications.

`"implicit"` and `"explicit"` are explicit user overrides. An unsupported explicit request falls back to implicit with a diagnostic; it does not fail the user turn.

### 5. Guarded OpenAI Responses continuation

Add same-turn continuation for OpenAI Responses routes behind `openai_responses_continuation`:

- `"off"`: always send the full logical request;
- `"auto"` default: use continuation only when the selected route declares support and the effective provider options already permit stored response state;
- `"on"`: require compatible stored continuation and fail configuration validation when the route cannot provide it.

YCoding does not silently set `store: true`. Responses storage and data retention remain an explicit provider/model configuration decision.

Continuation state is process-local and scoped to one active user turn:

- response ID;
- route, model, variant, prompt-cache namespace, system digest, tool digest, and relevant request-option digest;
- the last durable message boundary represented by that response.

The next tool-continuation request may send only newly admitted tool results and other delta input when all compatibility digests match. The canonical Session history remains durable and complete.

Fallback rules:

- transport disconnect, missing response ID, provider rejection, model change, tool/system digest change, compaction, or process restart clears continuation state;
- YCoding retries once with the canonical full request;
- fallback is recorded in the request ledger;
- continuation never becomes required for correctness or restart recovery.

WebSocket connection reuse is scoped to the same provider turn session and uses bounded first-event and idle timeouts. Repeated WebSocket failure disables it for the current turn and falls back to HTTPS/SSE.

### 6. Cost and diagnostics presentation

The existing provider-usage command and Session cache diagnostics show separate values:

- logical model calls;
- physical transport attempts;
- main-step, title, goal, compaction, and subagent calls;
- raw input, cache-read, cache-write, output, and reasoning tokens;
- cache hit ratio over cache-eligible input;
- provider-reported or estimated cost using catalog pricing;
- cache-write amortization status;
- current prompt-cache namespace prefix and invalidation reason;
- full-request versus continuation request counts.

Raw tokens are never labeled as billed-equivalent tokens. Estimated cost is omitted when pricing or provider reporting is unavailable.

## Data flow

```text
user admission
  -> helper policy (local title/goal or explicit model helper)
  -> Session context and deterministic tool materialization
  -> stable-prefix digest + provider options
  -> logical request ledger start
  -> optional same-turn continuation decision
  -> AI route cache policy
  -> physical transport attempts and fallback
  -> normalized provider usage
  -> durable request ledger completion
  -> Session diagnostics and provider-usage projection
```

## Error handling

- Observability failures never fail a model request; they are logged and omitted from diagnostics.
- Local title and goal generation are deterministic and cannot call the provider.
- Unsupported cache fields are removed before serialization and recorded as fallback diagnostics.
- Adaptive TTL state corruption or eviction falls back to five minutes.
- Continuation failure retries once with full canonical history, then follows the existing provider error path.
- A retry that may have reached the provider is counted as a physical attempt so usage is not understated.
- Unknown pricing yields token accounting without an invented monetary estimate.

## Compatibility

- Existing configurations remain valid; `efficiency` is optional.
- Explicit models on hidden agents keep precedence.
- Durable Session, message, compaction, orchestration, and TUI contracts remain authoritative.
- Provider-specific fields stay inside provider route options and do not leak into generic public Session schemas.
- The prompt-cache namespace revision changes when stable-prefix serialization changes, preventing false reuse across incompatible versions.

## Rollout and commit phases

1. Request ledger and cost projection.
2. Local title/goal defaults and helper-model routing.
3. Stable CodeMode/MCP prefix.
4. Adaptive Anthropic and explicit OpenAI cache policy.
5. Guarded OpenAI Responses same-turn continuation and transport reuse.
6. Final TUI diagnostics, documentation, recorded-provider verification, and performance report.

Each phase has targeted red-green tests, full affected-package tests, typecheck, brand/workspace checks, TUI build, and runtime smoke verification. Each phase is committed separately.

## Tests

### Request count and helpers

- one normal first prompt produces one main provider invocation by default;
- local title and local goal paths produce no provider invocation;
- model helper modes use the configured helper selection and record their source;
- compaction records one helper invocation with its selected model;
- provider retry count is distinct from logical invocation count.

### Prefix stability

- identical effective context produces byte-identical system and tool digests;
- MCP catalog connection and ordering changes do not alter the `execute` tool definition or prompt-cache namespace;
- permission, system instruction, model, or direct-tool schema changes do alter the namespace;
- volatile TeamView changes do not alter it.

### Provider cache policy

- Anthropic adaptive state begins at five minutes, promotes only after demonstrated reuse, and resets on namespace change;
- explicit five-minute and one-hour overrides are exact;
- GPT-5.6+ receives explicit breakpoints and options; older models do not receive unsupported fields;
- route capability fallback is diagnostic and non-fatal;
- recorded identical second calls demonstrate provider cache reads where credentials permit.

### Continuation

- a compatible second step sends only delta input plus `previous_response_id`;
- model, tool, system, namespace, compaction, and turn changes force full requests;
- provider rejection clears continuation and retries once with full input;
- process restart requires no continuation recovery;
- stored-response continuation never activates when effective storage is disabled.

### Accounting and UI

- token categories preserve normalized invariants;
- request sources and physical attempts sum correctly;
- estimated cost uses model cache-read/cache-write pricing and is omitted when unavailable;
- raw and estimated values are labeled distinctly;
- the provider-usage command exposes request amplification and invalidation reasons without prompt content.

## Non-goals

- Building a semantic response cache that returns prior model answers.
- Sharing provider conversation state between unrelated Sessions.
- Enabling provider-side storage without explicit effective configuration.
- Treating prompt caching as durable memory.
- Reducing context by dropping required instructions or tool results.
- Choosing an unknown cheaper model automatically without configuration or catalog evidence.
- Copying private or reconstructed upstream implementation wholesale.
