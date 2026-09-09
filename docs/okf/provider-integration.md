---
type: Architecture
title: Provider Integration and Cache
description: Provider integration optimizes cost and cache reuse without changing
  semantic behavior, using stable prefixes, provider-native cache controls, normalized
  usage, and bounded diagnostics.
tags:
- providers
- cache
- usage
- telemetry
- efficiency
sources:
- id: runtime-doc
  resource: repo:///docs/runtime.md
- id: arch-doc
  resource: repo:///docs/architecture.md
- id: efficiency-doc
  resource: repo:///docs/provider-efficiency.md
- id: config-doc
  resource: repo:///docs/configuration.md
- id: product-dir
  resource: repo:///docs/product-direction.md
---

## Provider Request Lowering

packages/ai owns provider request lowering and response normalization across OpenAI, Anthropic, compatible-provider protocols, reasoning, tool calls, media, prompt-cache controls, and normalized usage telemetry; Core chooses policy and context while AI translates into provider wire formats.[^arch-doc]

Session titles and goal text are local by default and make no provider request; model-generated title and goal behavior requires explicit efficiency modes, while selective-compaction checkpoint generation remains model-assisted.[^runtime-doc]

## Stable Prefix and Namespace

The prompt-cache namespace derives from the model-visible prefix and sharing boundaries including project and Location identity, provider and catalog model and variant, cache-policy revision, effective permissions, hooked system content, and provider-visible tool definitions; it excludes Session ID, context revision, and ordinary history.[^efficiency-doc]

CodeMode keeps one fixed provider-visible execute definition; MCP catalog changes do not rewrite that schema and therefore do not invalidate the stable tool prefix.[^efficiency-doc]

## Anthropic and OpenAI Caching

Anthropic-compatible requests use adaptive five-minute or one-hour TTL after two reusable provider reports within five minutes for the same stable namespace; missing telemetry neither creates nor erases an unexpired promotion, and recreated runtimes restore recent evidence from the durable provider-request ledger.[^efficiency-doc]

Direct OpenAI GPT-5.6-and-later Responses requests combine explicit stable-prefix breakpoints with the managed implicit breakpoint under openai_mode auto; ChatGPT Codex models are key-only and emit no prompt-cache breakpoint, options, or retention fields.[^config-doc]

Cache optimization must not swallow provider errors, change tool semantics, or trade correctness for hit rate; missing provider cache telemetry means unreported, not zero.[^runtime-doc]

## Continuation, Diagnostics, and Privacy

Compatible stored OpenAI Responses continuation is durable and fingerprinted, while stateless mode replays durable opaque provider state instead of response-ID continuation.[^efficiency-doc]

Session diagnostics expose bounded request summaries including logical requests, transport attempts, helper calls, normalized tokens, estimated cost, and the latest cache-invalidation reason; only the first eight characters of the prompt-cache namespace are exposed.[^runtime-doc]

Provider-usage refresh is read-only and best effort and never blocks Session startup or model execution; unknown quota values render as unreported and never expose credentials, account emails, headers, or raw payloads.[^runtime-doc]

## Related Concepts

- [Package Architecture](./architecture.md)
- [Session Execution and Autonomy](./session.md)
- [Configuration Surfaces](./configuration.md)
- [Provider Usage Snapshots](./provider-usage.md)

[^arch-doc]: repo:///docs/architecture.md
[^runtime-doc]: repo:///docs/runtime.md
[^efficiency-doc]: repo:///docs/provider-efficiency.md
[^config-doc]: repo:///docs/configuration.md
