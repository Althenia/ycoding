# Model incidents

Explains retained model incidents, deterministic per-model guidance, and their API, remote, and UI boundaries. Behavior narrative lives in [runtime](../docs/runtime.md#model-incidents); exact shapes live in `packages/schema/src/model-incident.ts` and `packages/protocol/src/groups/incident.ts`.

## Facts

- A fact is one of `fallback`, `guardrail-escalated`, or `guardrail-rejected` (rejected by `decision-model` or `client`). It is attributed to a provider, model, optional variant and profile, and agent; a fallback also names its target model.
- Facts hold identifiers, a bounded category, and sanitized rule IDs only. They never hold commands, targets, paths, arguments, messages, grades, evidence, or credentials.
- Facts are backend-wide, survive Session deletion, and are bounded by global `analytics_retention.incident_days` (default 30).

## Reads

- `incident.report` and `incident.recent` are backend-global: no Location, no Session. Report counts are exact for the requested `[from, to)` range; `groups` is the group count before paging.
- Guidance is derived from guardrail facts of the last 30 days newer than the model's clear watermark. A rule yields a fixed note at two or more distinct review requests; output is at most five notes and 1,024 bytes, identical for identical facts.
- Guidance is instruction text only. It never changes routing, fallbacks, permissions, or guardrail outcomes, and nothing is learned.

## Clear

- Clear stores a per-model watermark. Records, counts, reports, and retention are unchanged; the watermark never moves backward.
- `Guidance.enabled` reports whether the requesting Location's `capabilities.builtin_instructions` allows `model-guidance`.

## Operations

| Surface | Operations |
| --- | --- |
| Local HTTP | `incident.report`, `incident.recent`, `incident.guidance.get`, `incident.guidance.clear`; Location middleware and `location` query only on the guidance pair |
| Remote | `incident.report`, `incident.recent` (reject a Session); `incident.guidance` (read), `incident.guidance.clear` (mutation); optional Session whose verified Location the backend resolves, never browser input; managed subagent Sessions cannot clear |

## Verification

Schema and Protocol tests cover identifiers, closed literals, optional omission, query bounds, route methods, middleware placement, and unique operation IDs. Core tests cover recording, privacy, reports, retention, guidance text, and clear. Server, remote, TUI, and web tests cover the routes, operation validation, and rendered views.
