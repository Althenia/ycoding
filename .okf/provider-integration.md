---
type: Architecture
title: Provider Integration and Cache
description: Provider integration optimizes cost and cache reuse without changing
  semantic behavior, with stable prompt prefixes, cache controls, normalized usage
  reporting, and session diagnostics.
tags:
- providers
- cache
- usage
- telemetry
- efficiency
sources:
- id: product-dir
  resource: repo:///docs/product-direction.md
- id: runtime-doc
  resource: repo:///docs/runtime.md
- id: arch-doc
  resource: repo:///docs/architecture.md
- id: efficiency-doc
  resource: repo:///docs/provider-efficiency.md
- id: config-doc
  resource: repo:///docs/configuration.md
---

## Provider Request Lowering

`packages/ai` owns provider request lowering and response normalization across OpenAI, Anthropic, compatible-provider protocols, reasoning, tool calls, media, prompt-cache controls, and normalized usage telemetry. Core chooses policy and context; AI translates into provider wire formats.[^arch-doc]

## Prompt Caching

Separate provider prompt caching, TUI cache diagnostics, project-artifact reuse, and provider quota reporting. Missing provider cache telemetry means unreported, not zero. Cache optimization must not swallow provider errors, change tool semantics, or trade correctness for hit rate.[^runtime-doc]

### Adaptive Anthropic TTL

The `adaptive` policy starts every namespace at five minutes. After two provider-reported reusable cache reads or writes for the same stable namespace within five minutes, later requests use the one-hour bucket. Missing cache telemetry, a namespace change, a stale observation, or a model without published extended-TTL support keeps the five-minute bucket. This process-local optimization is bounded to 1024 namespaces and is not required for correctness.[^efficiency-doc]

### OpenAI Prompt Cache

Direct OpenAI Chat and Responses requests on GPT-5.6 and later use explicit breakpoints by default under `openai_mode: "auto"`. Older direct OpenAI models remain implicit. OpenAI-compatible gateways and unsupported model families fall back to implicit mode. Extended retention is opt-in via `openai_extended_retention`.[^config-doc]

### Cache Policy and Namespace

The cache policy revision is part of the prompt-cache namespace. The process-local cache runtime tracks provider-reported read and write usage by stable namespace and is never required to reconstruct a Session.[^efficiency-doc]

## OpenAI Responses Continuation

Same-turn OpenAI Responses continuation is process-local and opt-in. The runtime never enables provider-side storage to obtain continuation. A stored response is reused only when Session execution, route, model, prompt-cache namespace, system digest, tool digest, and semantic request-options digest all match. Continuation state is cleared on execution end, interruption, compaction, deletion, or fingerprint mismatch.[^runtime-doc]

## Usage Reporting

Provider-usage refresh is read-only and best effort. It must never block Session startup or model execution. Unknown quota values are absent and render as unreported; never coerce them to zero. Never expose provider credentials, credential IDs, account emails, arbitrary response headers, or raw usage payloads through Protocol, logs, events, or TUI state.[^runtime-doc]

### Session Diagnostics

Session diagnostics expose a bounded request summary: logical requests, transport attempts, helper calls, continued requests, fallbacks, raw token categories, estimated cost, and the latest cache invalidation reason. Only the first eight characters of the latest prompt-cache namespace are exposed; prompt content, full cache keys, system digests, tool digests, and internal provider-request events remain private. When any request lacks catalog pricing, estimated request cost is absent and the TUI renders `Estimated cost unavailable` instead of `$0.00`.[^runtime-doc]

## Model-Family Wire Fields

GPT-5.6+ uses explicit prompt-cache options and breakpoints; pre-5.6 requests use compatible retention fields. Anthropic cache-control placement is preserved across direct and compatible provider routes.[^runtime-doc]

## Related Concepts

- [Package Architecture](./architecture.md) — provider request lowering is owned by packages/ai
- [Session Execution and Autonomy](./session.md) — provider requests execute during session steps

[^arch-doc]: repo:///docs/architecture.md
[^runtime-doc]: repo:///docs/runtime.md
[^efficiency-doc]: repo:///docs/provider-efficiency.md
[^config-doc]: repo:///docs/configuration.md
