# Native decisions

## Scope and defaults

The Location-scoped decision service evaluates native OpenAI Decisions or TypeSafe Jev requests. The `decision` tool exposes this service directly; optional runtime policies consume one normalized choice internally for guardrails, initial routing, and goal continuation. All automatic policies are opt-in. Decisions are judgments, not human authorization, completion evidence, or a change to the user's objective.

Configuration and authentication follow [Native decisions](../docs/configuration.md#native-decisions). OpenAI's supported native model is `gpt-6-luna`. TypeSafe native calls require their model; automatic policies default to `jev-1.13.0`. Configured keys take precedence over selected active API-key credentials for the corresponding integration, then provider environment keys. OAuth/subscription identities do not imply a native API key. Credentials stay outside agent input and output.

## Native tool inputs

The disjoint input union is `{ provider, request }`. Each request is the selected provider's native body, not a translated common question format. Output is `{ provider, response }`, preserving validated native answers, probabilities, confidence where reported, OpenAI refusals, and reported usage.

OpenAI predicate input:

```json
{
  "provider": "openai",
  "request": {
    "model": "gpt-6-luna",
    "input": "The proposed operation reads a repository file without modifying it.",
    "questions": [{ "type": "predicate", "name": "read_only", "instructions": "Is the operation read-only?" }]
  }
}
```

TypeSafe `noul` input:

```json
{
  "provider": "typesafe",
  "request": {
    "model": "jev-1.13.0",
    "state": "The proposed operation reads a repository file without modifying it.",
    "questions": { "read_only": { "type": "noul", "instructions": "Is the operation read-only?" } }
  }
}
```

OpenAI accepts an ordered array of `predicate`, `choice`, or `score` questions with `input`; TypeSafe accepts named `noul`, `choice`, or `score` questions with `state`. Responses must match their request's questions and options. The automatic choice adapter uses the probability of the selected option; it does not substitute the separate confidence field. A refusal or unusable choice remains uncertain.

## Automatic policy boundaries

Routing configuration admits 1–254 uniquely named candidates and reserves `keep-current` for the baseline. Each offered candidate selects an agent, model, or both; entries selecting neither are filtered out.

- **Guardrails:** classify only deterministic allow, sending action, resources, and supplied metadata. A selected allow probability greater than or equal to `min_probability` preserves allow. Other choices, refusal, and decision errors require ordinary review. Deterministic deny/hard-review, disabled ordinary guardrails, `skipReview`, and existing YOLO review rules retain their gates; classification cannot grant human approval.
- **Routing:** evaluate only the first root Session model step when both agent and model are unset, no prior context/Step exists, and a nonempty pending user input is eligible. Offer finite configured routes with known selectable permission-allowed agents and available supported models/variants, plus the baseline `keep-current`. An eligible choice at the inclusive threshold selects its configured fields. Refusal, uncertainty, and baseline preserve defaults. Provider failure fails the operation. Transactional eligibility rechecks preserve concurrent explicit user selection.
- **Goal:** evaluate one continue/stop choice at an active goal's idle continuation boundary, excluding active child and shell work. Evidence contains objective, iteration, and bounded latest assistant text. A stop at the inclusive threshold durably records `stopped`, not `completed`. Otherwise the synthetic steer preserves the exact objective. Autonomy compare-and-set settlement rejects stale results. Decision failure halts continuation without admitting fallback input. Activation/resume and unconfigured continuation keep the existing goal helper.

## Safety, transport, and usage

The tool requires `decision` permission on the selected provider resource. Automatic policy configuration authorizes its specified evidence disclosure; it does not loosen tool permissions or Session safety rules. Provider bodies and judgment evidence must be appropriate for the selected external service. A configured base URL chooses the recipient of evidence and API-key authentication.

Core bounds serialized decision input to 1 MiB. The request timeout defaults to 10 seconds and cannot exceed 60 seconds. Each invocation performs one physical HTTP attempt with no automatic retry. Timeout, interruption, or abort cannot establish that the provider cancelled processing or billing. Invalid input, unavailable authentication, oversized input, timeout, and provider failure produce sanitized decision errors rather than raw credentials or provider payloads.

Provider requests use ledger source `decision`, separate from normal model Steps. Preserve provider-reported input/output usage and available OpenAI reasoning/cache telemetry. Missing cache reporting remains unknown; the native request shapes expose no invented prompt-cache controls. Unpriced decision usage has no priced ledger amount and must not be described as free or as a zero provider charge.

## Provider references

These references describe the external APIs; the supported local schemas and validation remain authoritative for YCoding:

- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
- [OpenAI create method](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- [TypeSafe API](https://docs.typesafe.ai/api)
- [TypeSafe models](https://docs.typesafe.ai/models)
