---
type: Architecture
title: Provider Integration and Cache
description: Provider integration optimizes cost and cache reuse without changing
  semantic behavior, with stable prompt prefixes, cache controls, and normalized usage
  reporting.
tags:
- providers
- cache
- usage
- telemetry
sources:
- id: product-dir
  resource: repo:///docs/product-direction.md
- id: runtime-doc
  resource: repo:///docs/runtime.md
- id: arch-doc
  resource: repo:///docs/architecture.md
---

## Provider Request Lowering

`packages/ai` owns provider request lowering and response normalization across OpenAI, Anthropic, compatible-provider protocols, reasoning, tool calls, media, prompt-cache controls, and normalized usage telemetry. Core chooses policy and context; AI translates into provider wire formats.[^arch-doc]

## Prompt Caching

Separate provider prompt caching, TUI cache diagnostics, project-artifact reuse, and provider quota reporting. Missing provider cache telemetry means unreported, not zero. Cache optimization must not swallow provider errors, change tool semantics, or trade correctness for hit rate.[^runtime-doc]

## Usage Reporting

Provider-usage refresh is read-only and best effort. It must never block Session startup or model execution. Unknown quota values are absent and render as unreported; never coerce them to zero. Never expose provider credentials, credential IDs, account emails, arbitrary response headers, or raw usage payloads through Protocol, logs, events, or TUI state.[^runtime-doc]

## Model-Family Wire Fields

GPT-5.6+ uses explicit prompt-cache options and breakpoints; pre-5.6 requests use compatible retention fields. Anthropic cache-control placement is preserved across direct and compatible provider routes.[^runtime-doc]

## Related Concepts

- [Package Architecture](./architecture.md) — provider request lowering is owned by packages/ai
- [Session Execution and Autonomy](./session.md) — provider requests execute during session steps

[^arch-doc]: repo:///docs/architecture.md
[^runtime-doc]: repo:///docs/runtime.md
