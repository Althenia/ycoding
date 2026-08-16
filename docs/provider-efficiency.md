# Provider efficiency

This document describes the implemented YCoding provider-efficiency behavior: request amplification, prompt caching, OpenAI Responses continuation, diagnostics, privacy boundaries, and reproducible verification.

## Goals

YCoding reduces provider usage without changing the logical agent result by:

- avoiding model calls for work that can be performed locally;
- keeping provider-visible tools and system prefixes stable;
- applying provider-native prompt-cache controls only where the route and model support them;
- reusing compatible OpenAI Responses state only inside one active execution;
- measuring logical requests separately from physical transport attempts;
- reporting raw provider tokens and estimated cost without treating missing pricing as zero.

These mechanisms are optimizations. Session correctness and durable recovery do not depend on process-local cache or continuation state.

## Defaults

The default efficiency policy is:

```jsonc
{
  "efficiency": {
    "title": "local",
    "goal_synthesis": "local",
    "prompt_cache": {
      "anthropic_ttl": "adaptive",
      "openai_mode": "auto",
      "openai_extended_retention": false,
    },
    "openai_responses_continuation": "auto",
  },
}
```

| Setting | Default | Effect |
| --- | --- | --- |
| `title` | `local` | Generates deterministic Session titles without a provider request. |
| `goal_synthesis` | `local` | Normalizes the requested goal without a provider request. |
| `helper_models.title`, `.goal`, `.compaction` | `session` | Selects each helper independently; a hidden agent's explicit model still takes precedence. |
| `prompt_cache.anthropic_ttl` | `adaptive` | Starts at five minutes and promotes a stable namespace to one hour after two reusable provider reports within five minutes. |
| `prompt_cache.openai_mode` | `auto` | Combines explicit stable-prefix breakpoints with OpenAI's managed latest-message breakpoint on supported direct GPT-5.6-and-later routes. |
| `prompt_cache.openai_extended_retention` | `false` | Does not request pre-GPT-5.6 `24h` retention unless explicitly enabled. |
| `openai_responses_continuation` | `auto` | Reuses compatible stored Responses state only when storage is already enabled by provider/model configuration. |

Set `title` or `goal_synthesis` to `model` when model-generated behavior is required. Compaction remains model-based.

Compaction sizes its summary input against the selected compaction model rather than the Session model. Any source history beyond that input budget remains in the checkpoint's recent-context suffix, preserving it for the next Session step while keeping the helper request below its declared limit.

## Stable provider prefix

The prompt-cache namespace is derived from the model-visible prefix and sharing boundaries, including:

- project and Location identity;
- provider, catalog model, and variant;
- cache-policy revision;
- effective permission rules;
- final hooked system content;
- final provider-visible tool definitions.

The namespace does not include the Session ID or ordinary message history. Equivalent Sessions can therefore share a provider prefix while retaining separate provider-session identities. Compaction helpers add an internal `compaction` scope, so they cannot share an ordinary Session-step cache key and cannot influence its adaptive TTL observations; ordinary-step namespace bytes remain stable.

CodeMode keeps its single provider-visible `execute` definition fixed. MCP tools and resources remain dynamically discoverable at runtime, but an MCP catalog change does not rewrite the `execute` schema or description and therefore does not invalidate the stable tool prefix.

## Provider capability matrix

| Provider route | Placement and identity | Retention behavior | Usage diagnostics |
| --- | --- | --- | --- |
| Anthropic Messages | Inline cache controls on tools, system, and two rolling message anchors. | Adaptive five-minute or one-hour TTL when the model has a published extended-TTL profile. | Provider cache reads and writes are preserved separately. |
| Google Vertex Anthropic | Same Anthropic-compatible placement and TTL policy. | Same capability-gated TTL behavior. | Provider-reported categories are normalized. |
| Amazon Bedrock Converse | Native `cachePoint` placement on the same stable and rolling boundaries. | One-hour markers only when selected by a supported policy. | Cache reads and writes remain distinct. |
| OpenRouter | Stable `prompt_cache_key` and provider-session identity; provider-native automatic placement is used instead of incomplete inline placement. | Provider-controlled, with requested policy hints where supported. | Reported cache categories and request cost are normalized. |
| Direct OpenAI Responses before GPT-5.6 | Implicit prefix caching with a stable prompt-cache key. | Optional `24h` retention only for the implemented allowlisted model families. | Cached input and cache-write tokens are normalized when reported. |
| Direct OpenAI Responses GPT-5.6+ | Stable `prompt_cache_key`, one combined system-text marker, and selected user/assistant text markers inside the raw message window. A marked assistant message uses `input_text` EasyInput blocks and otherwise retains `output_text`. Tools and tool results can remain in the cached prefix but receive no generated marker. `auto` retains OpenAI's managed latest-message breakpoint; OpenAI selects its latest three explicit writes. `explicit` disables that managed breakpoint; OpenAI selects its latest four explicit writes. Earlier selected markers remain provider read candidates. | `prompt_cache_options.ttl: "30m"`, the provider's only supported minimum lifetime, is sent in `auto` and `explicit` modes; it is not a hard expiry and OpenAI has a separate 24-hour maximum. | Cached input and billable cache-write tokens are normalized separately when reported. |
| ChatGPT Codex Responses backend | Stable `prompt_cache_key` with backend-managed implicit placement. Public-API cache options and breakpoints are omitted. | Backend-controlled; public `prompt_cache_retention` and `prompt_cache_options` are unsupported. | Reported cached input and cache-write tokens are normalized separately. |
| OpenAI-compatible gateways | Stable provider identity where supported; unsupported direct-OpenAI fields are omitted. | No direct OpenAI retention field is assumed. | Provider-reported usage is normalized without inventing unsupported capabilities. |
| Gemini and Vertex Gemini | Provider implicit prefix caching; no inline cache markers are injected. | Provider-controlled. | Cached-content tokens are normalized when reported. |

The model cache-profile table also records the minimum prefix size for known Anthropic, OpenAI, and Gemini families. A prefix below that minimum is reported as `below-minimum`; it is not treated as a transport or cache-policy failure.

GPT-5.6 and later do not use the earlier 128-token partial-prefix behavior. YCoding generates one combined system-text marker plus selected user/assistant text markers in the raw policy window, keeps pre-GPT-5.6 `prompt_cache_retention` fields off those requests, and leaves live write-slot and read-lookback enforcement to OpenAI. Responses serializes a marked assistant message through `input_text` EasyInput blocks and otherwise preserves `output_text`. Tools and tool results remain part of the cacheable prefix but receive no generated marker. In implicit mode OpenAI manages one latest-message breakpoint and chooses its latest three explicit write candidates; in explicit mode it chooses its latest four. Earlier explicit markers remain read candidates, so YCoding does not hard-code a disputed 50- or 80-marker lookback. OpenAI currently bills GPT-5.6+ cache writes at 1.25 times uncached input and reports them as `cache_write_tokens`; YCoding preserves and reports `cached_tokens` and `cache_write_tokens` independently without inferring missing values. Exact prefix identity, at least 1,024 rendered tokens, and stable keys remain provider prerequisites; OpenAI documents approximately 15 RPM per key as its routing threshold.

Direct GPT-5.6 Responses requests send `context_management: [{ type: "compaction", compact_threshold: 200000 }]`. Stateless follow-ups replay the returned opaque encrypted compaction item for the same model and omit input before that boundary, preserving reasoning state without enabling provider storage. The native `web_search` tool is provider-executed and its returned call item is replayed on stateless follow-ups. This is OpenAI-hosted search, not Core's provider-independent local Exa/Parallel `websearch` tool.

## Adaptive Anthropic TTL

`adaptive` state is process-local and bounded to 1024 namespaces.

A namespace starts with a five-minute TTL. It is promoted for later requests only after two eligible observations for the same namespace within five minutes where the provider reports reusable cache reads or writes. Promotion is not inferred from missing telemetry or zero-valued unreported categories.

The following conditions retain or return to the five-minute bucket:

- a different prompt-cache namespace;
- observations more than five minutes apart;
- no reusable read or write report;
- an unknown model profile;
- process restart or bounded-state eviction.

Explicit `5m` and `1h` settings bypass adaptive promotion, while unsupported models remain on the safe five-minute behavior.

## OpenAI Responses continuation

Stored continuation is restricted to one active Session execution generation.

A later step sends `previous_response_id` and only the new message suffix when all fingerprint fields still match:

- Session ID and active execution generation;
- direct OpenAI Responses route;
- selected provider/model/variant;
- prompt-cache namespace;
- system digest;
- tool digest;
- generation and semantic OpenAI options;
- tool choice, response format, cache policy, and safe HTTP options;
- effective `store: true`.

Current system instructions and tools are still sent on a continued request. YCoding never enables provider storage to obtain continuation.

Continuation state is cleared on:

- execution success, failure, or interruption;
- Session deletion;
- manual or automatic compaction;
- model, route, namespace, system, tool, option, or execution mismatch;
- a step without a clean response ID;
- provider-state rejection.

When a continued request receives an invalid-request error before observable assistant output, YCoding clears the response ID and retries the same logical request once with full canonical history. The request ledger records one logical request, two physical attempts, and `fallback`. A second failure follows the normal provider error path and is not retried as continuation again.

## Request diagnostics

The Provider Usage command contains two separate sections:

- external quota or credit windows reported by the active providers;
- local `YCoding requests` telemetry for the current Session.

The local section reports:

| Field | Meaning |
| --- | --- |
| Logical requests | Distinct model/helper requests owned by YCoding. |
| Transport attempts | Physical HTTP or WebSocket attempts, including retry and continuation fallback attempts. |
| Helpers | Title, goal, and compaction requests. |
| Continued | Logical requests completed through stored OpenAI Responses state. |
| Fallbacks | Continued requests that retried once with full history. |
| Raw input | Non-cached input tokens reported by providers. |
| Raw cache read | Provider-reported cached input tokens. |
| Raw cache write | Provider-reported cache creation/write tokens. |
| Raw output | Visible output tokens after separating reasoning. |
| Raw reasoning | Provider-reported reasoning tokens. |
| Estimated cost | Sum calculated from catalog pricing. It is unavailable when any recorded request lacks applicable pricing. |
| Last invalidation | Why the latest request did not retain or reuse the preceding prefix/state. |
| Namespace | First eight characters of the latest prompt-cache namespace. |

Unknown pricing renders `Estimated cost unavailable`. A real zero-priced catalog model renders `$0.0000`.

OpenAI ChatGPT/Codex and Anthropic Claude Code connections retain the selected model's catalog prices instead of replacing them with zero. Their Session cost is an API-equivalent list-price estimate for comparing model usage; it is not the subscription invoice or remaining plan allowance. Provider quota reporting remains a separate read-only surface. Codex cache usage parsing is field-based: `cached_tokens` and `cache_write_tokens` remain separate categories regardless of model-family detection. The committed models.dev snapshot supplies release-time OpenAI and Anthropic master data, runtime refreshes may update it, and explicit context tiers take precedence over the legacy `context_over_200k` field so GPT-5.6 long-context pricing starts at its documented 272K boundary.

### Invalidation labels

| Value | Interpretation |
| --- | --- |
| `first-request` | No preceding request exists for comparison. |
| `compaction-reset` | The preceding provider request was a compaction helper, so normal-step cache reuse restarts. |
| `model-switched` | The provider or catalog model changed since the preceding request. |
| `model-variant-switched` | The normalized model variant changed since the preceding request. |
| `stable-hit` | The provider reported cached input reuse. |
| `prefix-changed` | More than one stable-prefix component changed. |
| `system-prefix-changed` | Only the model-visible system prefix changed. |
| `tool-prefix-changed` | Only provider-visible tool definitions changed. |
| `below-minimum` | The cacheable prefix is shorter than the model's published minimum. |
| `provider-not-reported` | The route can cache, but the provider did not report read or write categories. |
| `cache-disabled` | The selected route or policy has no active cache mechanism. |
| `retry-fallback` | A physical retry or stored-continuation fallback occurred. |

Historical provider-request records without a variant decode as the `default` variant. Provider-reported reuse, disabled, below-minimum, and unreported-cache conditions take precedence over inferred reset reasons. Otherwise, `compaction-reset` precedes `model-switched`, which precedes `model-variant-switched`.

## Privacy and persistence

The following are durable because they are required for bounded diagnostics:

- request source and selected model identity;
- logical request ordinal and physical attempt count;
- normalized raw token categories;
- optional estimated cost;
- continuation/full/fallback classification;
- cache invalidation reason.

The following remain internal and are not exposed by the public Session log or diagnostics endpoint:

- prompt content;
- complete prompt-cache keys;
- system and tool digests;
- OpenAI response IDs;
- provider response bodies;
- credentials and authentication material.

The public diagnostics response exposes only an eight-character namespace prefix. OpenAI response IDs and adaptive TTL state are process-local and are never persisted.

## Reproducible measurement

Run the deterministic runtime benchmark against a freshly built TUI artifact:

```bash
bun run build:tui
bun run smoke:runtime
```

The benchmark uses local fake providers and a local stdio MCP server. It performs:

1. two ordinary requests with a provider-reported cache write followed by a cache read;
2. one Session containing two real `read` tool continuations, producing three logical and three physical provider requests;
3. another Session with the same provider-visible prefix;
4. an MCP CodeMode catalog replacement and reconnection;
5. a third equivalent Session whose namespace must remain unchanged;
6. a native OpenAI Responses tool turn with `store: true`;
7. one rejected `previous_response_id` attempt and one full-history fallback under the same logical request.

The current fixture pins these accounting results:

```text
Tool loop:       logical 3, physical 3, input 1500, cache read 1900, cache write 100, output 15, reasoning 15, cost $0.001875
OpenAI fallback: logical 2, physical 3, fallback 1, input 1200, cache read 900, cache write 100, output 10, reasoning 10, cost $0.001455
```

The smoke command fails if the namespace changes after the MCP catalog reload, if continued input resends represented history, if the fallback omits canonical history, or if request/token/cost accounting changes.

For provider-backed measurements, compare runs only when provider, model, variant, system, permissions, tools, prompt sequence, and timing window are identical. Record raw read/write/input categories separately; do not infer a cache miss from telemetry the provider did not report.

## Source ownership

- Cache placement and model profiles: `packages/ai/src/cache-policy.ts`, `packages/ai/src/cache-profile.ts`.
- Provider lowering: `packages/ai/src/protocols`.
- Namespace, adaptive TTL, continuation, and request ledger: `packages/core/src/session`.
- Public diagnostics contracts: `packages/schema/src/session-cache-diagnostics.ts` and `packages/protocol/src/groups/session.ts`.
- Provider Usage presentation: `packages/tui/src/routes/session/provider-usage.tsx`.
- Deterministic benchmark: `packages/cli/script/runtime-smoke.ts`.
