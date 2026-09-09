---
type: Interface
title: Provider Usage Snapshots
description: Provider usage is a read-only best-effort Location-scoped service that
  normalizes quota and usage snapshots for protocol clients and the terminal usage
  dialog.
tags:
- provider-usage
- quota
- snapshots
- diagnostics
sources:
- id: guardrail-ops
  resource: repo:///docs/guardrails-and-provider-usage.md
- id: spec-v2
  resource: repo:///specs/v2/provider-usage.md
- id: runtime-doc
  resource: repo:///docs/runtime.md
---

## Snapshot Contract

A snapshot carries provider ID and safe display label, availability status, source and stability classification, update time, named windows, and an optional safe diagnostic message.[^spec-v2]

Status values are available, stale, unsupported, unauthorized, and error; a refresh failure never blocks Session startup or model execution, and a later failure retains the previous valid snapshot as stale.[^guardrail-ops]

Unknown values are omitted from snapshots and render as Not reported in the terminal, never as zero.[^spec-v2]

## Sources and Stability

Supported source and stability pairs include stable provider APIs, official local client contracts, observed response headers, best-effort provider-internal APIs, and source-dependent local Session evidence.[^spec-v2]

Provider results cache by provider and credential identity; credentials, account emails, key fragments, OAuth tokens, and raw provider response bodies are not returned through Protocol or rendered in the usage dialog.[^guardrail-ops]

## Terminal Presentation

The Provider Usage command appears when a provider selected by the current root family has visible quota data or when local request diagnostics exist; parallel Sessions using the same provider share one section.[^guardrail-ops]

Percentage windows use stable ten-character ASCII bars with warning styling at 70 to 89 percent and error styling at or above 90 percent; unsupported providers are omitted.[^guardrail-ops]

## Related Concepts

- [Provider Integration and Cache](./provider-integration.md)
- [Session Execution and Autonomy](./session.md)
- [Package Architecture](./architecture.md)

[^spec-v2]: repo:///specs/v2/provider-usage.md
[^guardrail-ops]: repo:///docs/guardrails-and-provider-usage.md
