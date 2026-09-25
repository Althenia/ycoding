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

A snapshot carries provider ID and safe display label, availability status, source and stability classification, update time, named windows, and an optional safe diagnostic message; it also carries the stored credential profile name only when the provider has more than one stored profile.[^spec-v2]

Status values are available, stale, unsupported, unauthorized, and error; a refresh failure never blocks Session startup or model execution, and a later failure retains the previous valid snapshot as stale.[^guardrail-ops]

Unknown values are omitted from snapshots and render as Not reported in the terminal, never as zero.[^spec-v2]

## Listing and Profiles

The list returns one snapshot per stored credential profile for a provider with a quota adapter and several profiles, and one snapshot for any other provider; providers without a quota adapter or usable credential return explicit unsupported snapshots, and results are ordered by provider ID, then profile name.[^spec-v2]

Observed response data applies only to the provider's active profile, and a newer observation takes precedence over that profile's older API snapshot.[^spec-v2]

## Sources and Stability

Supported source and stability pairs include stable provider APIs, official local client contracts, observed response headers, best-effort provider-internal APIs, and source-dependent local Session evidence.[^spec-v2]

Provider results cache by provider and credential identity; credentials, account emails, key fragments, OAuth tokens, and raw provider response bodies are not returned through Protocol or rendered in the usage dialog.[^guardrail-ops]

## Terminal Presentation

The Usage view renders one section per available configured provider in the current Location, or one section per stored profile named by that profile for a multi-profile provider; account-level percentages are never combined.[^guardrail-ops]

Percentage windows use stable ten-character ASCII bars with warning styling at 70 to 89 percent and error styling at or above 90 percent; providers without a supported quota path or usable credential are hidden, while unauthorized and failed providers remain visible.[^guardrail-ops]

Unreported steps, reasoning, cache reads, token totals, and report costs render as `-`.[^spec-v2]

## Related Concepts

- [Provider Integration and Cache](./provider-integration.md)
- [Session Execution and Autonomy](./session.md)
- [Package Architecture](./architecture.md)

[^spec-v2]: repo:///specs/v2/provider-usage.md
[^guardrail-ops]: repo:///docs/guardrails-and-provider-usage.md
