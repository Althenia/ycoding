# Native decisions

## Scope and defaults

The Location-scoped decision service evaluates native OpenAI Decisions or TypeSafe Jev requests and hidden decision-agent judgments. The `decision` tool exposes this service directly; opt-in runtime policies consume judgments for guardrails, initial routing, goal continuation, question suggestions, and task advisory. Native policies use probability; agent policies use separately configured model-estimated confidence. Decisions are judgments, not human authorization, completion evidence, or a change to the user's objective.

Configuration and authentication follow [Native decisions](../docs/configuration.md#native-decisions). OpenAI's supported native model is `gpt-6-luna`. TypeSafe native calls require their model; automatic policies default to `jev-1.13.0`. Configured keys take precedence over selected active API-key credentials for the corresponding integration, then provider environment keys. OAuth/subscription identities do not imply a native API key. Credentials stay outside agent input and output.

## Native tool inputs

The disjoint input union is `{ provider, request }`, with output `{ provider, response }`. OpenAI/TypeSafe requests use their native bodies, not a translated common question format. Their responses preserve validated native answers, probabilities, confidence where reported, OpenAI refusals, and reported usage. Provider `agent` uses the separate model-estimate contract described below.

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

OpenAI accepts an ordered array of `predicate`, `choice`, or `score` questions with `input`; TypeSafe accepts named `noul`, `choice`, or `score` questions with `state`. Both require at least one question; an empty question set is rejected before transport. Responses must match their request's questions and options. The automatic choice adapter uses the probability of the selected option; it does not substitute the separate confidence field. A refusal or unusable choice remains uncertain.

## Automatic policy boundaries

Native policies require `min_probability`; agent policies require `min_confidence`. Both accept finite values in `[0, 1]` and compare inclusively. Wrong or mixed metric fields are rejected. Agent confidence is self-reported and uncalibrated, not a native probability. The confidence threshold supplies no independent calibration or correctness guarantee.

Every policy assesses a normalized choice the same way. A native policy scores the selected option's provider probability (metric `probability`); an agent policy scores the helper's confidence (metric `confidence`); the other metric is ignored. A refusal or missing choice is `refused`. A missing, non-finite, or out-of-range score is `uncertain` without a score; scores are never clamped. A valid score below the threshold is `uncertain` with its score, and a valid score at or above it is `confident` with the choice and score. Displayed scores use two decimals as `native probability 0.91` or `model confidence 0.82, uncalibrated`.

Routing configuration admits 1–254 uniquely named candidates and reserves `keep-current` for the baseline. Each offered candidate selects an agent, model, or both; entries selecting neither are filtered out.

- **Guardrails:** classify only deterministic allow, sending action, resources, and supplied metadata. Selected allow at or above the provider-specific threshold preserves allow. Other choices, refusal, and decision errors require ordinary review. Deterministic deny/hard-review, disabled ordinary guardrails, `skipReview`, and existing YOLO review rules retain their gates; classification cannot grant human approval.
- **Routing:** evaluate only the first root Session model step when both agent and model are unset, no prior context/Step exists, and a nonempty pending user input is eligible. Offer finite configured routes with known selectable permission-allowed agents and available supported enabled models, plus the baseline `keep-current`. Explicit profiles use their own enabled inventory and advertised variants, independently from the global active profile. Validate the model/profile/variant both before inference and in the transactional eligibility recheck. An eligible choice at the inclusive threshold selects its configured fields. Refusal, uncertainty, and baseline preserve defaults. Provider failure fails the operation. Transactional eligibility rechecks preserve concurrent explicit user selection.
- **Goal:** evaluate one continue/stop choice at an active goal's idle continuation boundary, excluding active child and shell work. Evidence contains objective, iteration, and bounded latest assistant text. A stop at the inclusive threshold durably records `stopped`, not `completed`. Otherwise the synthetic steer preserves the exact objective. Autonomy compare-and-set settlement rejects stale results. Decision failure halts continuation without admitting fallback input. Activation/resume and unconfigured continuation keep the existing goal helper.
- **Questions:** before creating its form, the `question` tool checks the calling agent's effective `decision` permission for the configured provider; a deny, including an inherited ceiling, skips evaluation. Eligible prompts are single-select with at least two unique option labels and no explicit `(Recommended)` label. Send only the prompt's `header` and `question` as state and its option labels and descriptions as choices. Run at most four evaluations concurrently; native policies have one overall configured timeout, and agent policies have no local deadline. A confident choice becomes the string field's `default`, appends `(Suggested by the decision helper: <score>)` to that option's description, and is returned as `suggestions: [{ index, label, metric, value }]` beside the unchanged label-array `answers`; the model-visible result lists suggestions separately as judgments, not answers. Normal mode awaits human choice, including an override. Form auto-answering (YOLO 1–3 or active goal) uses the default before the first option. Refusal, uncertainty, and decision errors produce no suggestion; expiration of the native overall budget interrupts unfinished evaluations and opens the original form without suggestions. Caller interruption and defects propagate. Permission and guardrail requests keep their native paths.

## Task advisory

`decisions.advisory` is an opt-in harness policy with the provider-specific threshold, 1–254 model candidates and 1–254 directions. Both sets require unique nonempty IDs and descriptions and reserve `keep-current`. Every candidate requires a canonical configured model selection, including an optional explicit profile and exact variant; directions contain only ID and description. No provider, model, credential, billing route or policy is enabled automatically.

At a safe runner boundary after each newly promoted nonempty user input, the harness performs one evaluation containing three choice questions named `model`, `direction` and `tool`. Steered and queued user inputs participate only when actually promoted. Synthetic runtime inputs, continuation Steps, recovery Steps and forced resumes do not trigger another evaluation. The `decision` provider's effective deny, including inherited ceilings, skips evaluation. Policy configuration authorizes the bounded disclosure, not permission expansion.

Evidence contains at most 16,384 characters of the current request, 4,096 characters of the active objective and 4,096 characters of the latest assistant text outcome. Model evidence contains configured candidate IDs, descriptions, canonical references, live capabilities, limits and advertised variant IDs. Only supported enabled models on available providers are offered; explicit profile lookup uses that profile's inventory and variant list, independently from which profile is globally active. Provider settings, headers, body overlays, credential IDs, credentials and account metadata are excluded. Descriptions are bounded to 8,192 characters, and the decision service's 1 MiB serialized input ceiling still applies.

Tool evidence comes from the current permission-filtered canonical registry inventory, respecting the selected agent's Step limit. It excludes `decision`, sorts by tool name, and offers at most 254 tool names with their registered descriptions. Model-request hooks can further narrow or reshape the final advertised tools; advice requires verifying the final available tool and its schema before use. Reading advisory inventory invokes no model-request hooks or image analysis; ordinary request preparation occurs once. Each question includes `keep-current` as a no-recommendation option. Model recommendations use exact configured references and seek the lowest sufficient capability without inventing capability tiers or prices.

Only offered choices meeting the provider's inclusive threshold become recommendations. Agent confidence remains uncalibrated; native choices use their selected probability, not a confidence field. Refusal, baseline, missing or invalid scores, low scores and unknown choices do not produce actionable recommendations. Results append one chronological existing synthetic message labelled `Decision advisory`, with `metadata.decisionInputID` identifying the admitted user input. This records a fact that advice was produced, not a user instruction, authorization, tool execution, objective change or completion proof. The runner includes it in model-visible history without changing its system or tool prefix. A recorded advisory for the same input ID suppresses another evaluation; there is no independent durable status table.

Advisory never publishes model/agent selection events, calls recommended tools or feeds itself back into the inbox. Existing initial routing remains separate and root-initial only. Explicit owner selections remain unchanged; a model recommendation can inform later task planning or delegation only within existing authority and execution validation. Typed decision errors append only a sanitized reason and no fabricated recommendation, then allow main execution to proceed. Interruption and defects propagate without a fallback observation or automatic retry. After interrupted promotion, ordinary durable execution rules apply; advisory does not introduce post-crash provider-work replay.

The generic `decision` API also supports these three uses directly by batching finite choice questions with self-contained evidence. Stable built-in guidance requires deterministic checks for known facts, reuses judgments until evidence or a task boundary changes, and forbids per-Step classification or reevaluation solely because an advisory appeared. It preserves owner choices, live availability checks, permission and guardrail authority, and uncertainty handling.

## Task scoping and dispatch

`decisions.scoping` enables the Core `scope` tool with the same provider-specific threshold contract as task advisory. `auto_dispatch` defaults to `false`; `max_tasks` defaults to `8` and accepts positive integers at most `10`. The primary model authors a candidate partition; the decision service judges finite supplied choices, not free-text tasks.

Input contains 1–`max_tasks` tasks and optional evidence of at most 16,384 characters. Every task has a unique nonempty `id` of at most 32 characters matching `^[a-z0-9][a-z0-9-]*$`, a nonempty `title` of at most 200 characters, a nonempty `ownership` array of repository-relative paths or globs of at most 1,024 characters each, a Boolean `read_only`, a nonempty `acceptance` observable check of at most 2,048 characters, and `depends_on` task IDs defaulting to an empty array. Task IDs are short kebab-case labels; the judge asks up to three questions per task. Unknown input fields, duplicate IDs, unknown dependencies, cycles and bound violations fail with `tool.execution` before evaluation. A `decision` permission deny on the configured provider, including an inherited ceiling, fails with `permission.rejected`.

Deterministic ownership checks compare each pair of writing tasks using exact string equality and simple glob-prefix overlap, including `a/**` against `a/b.ts`. Overlaps return `conflicts: [{ a, b, path }]` without failing the tool; every affected writing task is non-dispatchable. Read-only tasks do not create write conflicts. This is a bounded string/prefix check, not dependency discovery or a claim that arbitrary glob languages have been resolved.

One evaluation receives the supplied evidence or latest promoted user text (at most 16,384 characters), the active goal objective (at most 4,096 characters), the proposed tasks, conflicts, safe live model metadata from `advisory.candidates`, and configured child-capacity and nesting limits. Scoping has no model candidate list of its own. Only available supported enabled model/profile/variant references are offered, under the same checks as task advisory. State excludes provider settings and credentials. All questions are `choice`:

- `granularity`: `too-coarse`, `right-sized`, `too-fine`, or `keep-current`;
- `ready:<id>`: `yes`, `no`, or `keep-current`, judging whether supplied inputs and prerequisites are available now;
- `delegate:<id>`: `self`, `child`, `ask-user`, or `keep-current`;
- `tier:<id>`: `keep-current` or an offered advisory candidate ID, only when eligible candidates exist.

The task bound ensures at most `1 + 3 × 10 = 31` questions with candidates and `1 + 2 × 10 = 21` without them. Questions are never dropped. The 32-character ID bound keeps every prefixed question name within the agent provider's 64-character limit. Every answer uses the shared policy assessment; native answers use the selected probability, and agent answers use uncalibrated model confidence. Unknown choices, refusal and uncertainty are not actionable.

Output is a schema-validated `plan` containing the granularity judgment, per-task IDs, titles, readiness and delegation judgments, optional exact model references, `dispatchable` and reasons, the conflicts, and optional `dispatched: [{ taskID, sessionID }]`. A task is dispatchable only when delegation confidently selects `child`, readiness confidently selects `yes`, write ownership has no conflict, acceptance is present (including read-only work), every dependency was dispatched earlier in this call or confidently marked ready, nesting permits a child, and remaining family child capacity permits it. Tasks are considered in dependency order; capacity overflow and nesting-limit tasks remain non-dispatchable with reasons.

Automatic dispatch requires both `auto_dispatch: true` and current YOLO level at least 1 or an active goal, rechecked before each launch. Normal mode never dispatches. The runtime reuses the `subagent` launch path, preserving preflight model/agent validation, effective permissions, permission ceilings, nesting, family guardrail reservations and durable background execution. Each task has a distinct launch identity within the scope call. A chosen advisory candidate's configured `agent` is used when present; otherwise the configured `default_agent` must be subagent-eligible and permission-allowed. An absent or ineligible default makes the task non-dispatchable with `no-eligible-agent`; the runtime does not silently substitute another agent. A guardrail review leaves the task undispatched with `review-required`; judgments never answer a review or supply approval. Launch rejection leaves a reason and no fabricated child ID. The deterministic child prompt includes title, exclusive-write boundary, read-only status, acceptance, dependency summary, bounded evidence, and instructions not to spawn subagents and to report evidence.

The tool returns the plan to the primary model and appends one existing synthetic message described as `Scoping advisory`, with `metadata: { decisionInputID: <latest promoted user input ID>, scoping: true }`. Its first line starts with `Decision advisory:`; confident recommendation lines start with `Recommended `, and the plan records any actual dispatched child identities. A Scoping advisory is a judgment record, not a user instruction, authorization, execution evidence or completion proof; actual child launch and settlement remain established by orchestration records. Provider-request ledger source is `decision`.

The harness only adds `Scoping available: propose a task partition with the scope tool before delegating.` to ordinary configured task advice. It does not author partitions, discover dependencies, dispatch in normal mode, or re-scope per Step. Explicit model and agent selections and the user's objective remain unchanged. The primary model may dispatch a judged plan with the existing `subagent` tool under its existing authority.

## Safety, transport, and usage

The tool requires `decision` permission on resource `openai`, `typesafe`, or `agent`. Automatic policy configuration authorizes its specified evidence disclosure; it does not loosen tool permissions or Session safety rules. Provider bodies and judgment evidence must be appropriate for the selected external service/model route. An OpenAI/TypeSafe configured base URL chooses the recipient of evidence and API-key authentication. Agent requests use the selected normal model route and its authentication, privacy, quota, and billing contracts.

Core bounds serialized decision input to 1 MiB. Native requests use a configured timeout, defaulting to 10 seconds and capped at 60 seconds. Hidden decision-agent calls have no YCoding wall-clock deadline, including explicit tool calls and automatic consumers; they remain explicitly cancellable and may fail or time out at the upstream provider, transport or network. Native invocation performs one physical HTTP attempt; the agent performs one model call. Neither uses automatic retry or fabricated fallback answers. Timeout, interruption, or abort cannot establish that the provider cancelled processing or billing. Invalid input, unavailable authentication, oversized input, native timeout, and provider failure produce sanitized decision errors rather than raw credentials or provider payloads. Native adapter request rejections, including provider HTTP request-validation failures, use reason `invalid-request`; responses that fail validation use `invalid-output`; provider authentication rejections use `unavailable`; other transport and provider failures use `provider-failed`. The tool and automatic policies see only the reason.

Provider requests use ledger source `decision`, separate from normal model Steps. Preserve provider-reported token, reasoning, and cache telemetry when available; missing cache reporting remains unknown. Native requests expose no invented prompt-cache controls and remain unpriced. Agent helper requests use known normal-model catalog pricing when available; unpriced usage has no priced ledger amount. Cached token counts and a zero aggregate cannot establish free billing. Subscription-route catalog costs are estimates, not subscription invoices. Local Session history and tool results remain durable; there is no free-use or zero-retention guarantee.

## Decision-agent inputs

Provider `agent` accepts JSON `state` and 1–32 ordered questions. Each question has a unique nonempty `name` of at most 64 characters and nonempty `instructions` of at most 8,192 characters. `predicate` asks for a Boolean; `choice` supplies 1–255 unique string or Boolean `value` options with optional descriptions; `score` supplies 2–10 levels with labels and optional descriptions. String and Boolean choices retain distinct types. The request does not select credentials or a model directly.

```json
{
  "provider": "agent",
  "request": {
    "state": { "operation": "Read a repository file without modifying it" },
    "questions": [{ "type": "predicate", "name": "read_only", "instructions": "Is the operation read-only?" }]
  }
}
```

The hidden primary `decision` agent has all tools denied and uses a static TOON-only judgment prompt. Its ID is reserved for internal evaluation; fresh Session creation and explicit agent switching reject it with HTTP 400 `InvalidRequestError` on field `agent`, and commands reject it before template evaluation. Existing-ID Session adoption retains the original Session unchanged. Model resolution prefers `agents.decision.model`, then `efficiency.helper_models.decision`, then the owner Session/default model. A helper value of `session` retains owner-model resolution. Supported subscription routes work through normal credentials without requiring a separate native API key. The helper makes one streaming model call with no tools and `generation.maxTokens: 2048`; the selected route maps that limit to its provider's wire format. Text output is bounded to 1 MiB of UTF-8 and must finish normally; tool calls and partial or failed settlement are rejected.

The model must return exactly one TOON root `decisions`, version `1`, with one answer per requested name and uniform columns `name,type,answer,choice,score,confidence`. This illustrative predicate result is an estimate, not evidence that the operation was executed or verified:

```toon
decisions:
  version: 1
  answers[1]{name,type,answer,choice,score,confidence}:
    read_only,predicate,true,null,null,0.95
```

The judgment prompt asks the model to weigh plausible alternatives before answering and to set confidence by how likely the answer is correct given only the supplied evidence, from 0 for no support to 1 for certainty, lowering it for missing or conflicting evidence or close alternatives. This elicitation follows verbalized-confidence findings for instruction-tuned models; it does not make confidence a calibrated probability.

Unused answer fields must be `null`. Choices must match a supplied value with its original type; scores must be integer zero-based level indexes; confidence must be finite in `[0, 1]`. Refusal requires all answer fields `null` and confidence `0`. Unknown fields, duplicate/missing names, wrong types, out-of-range scores, malformed TOON, and JSON substitution fail validation. There is no JSON fallback, automatic retry, or fabricated default judgment. Validated answers are returned in request order.

Structured responses include the selected model reference, `semantics: "model-estimate"`, version and answers, and canonical token usage when reported. Helper ledger records use agent `decision` and keep the caller's admitted input ID when one is supplied, as initial routing does. Automatic choices omit empty option descriptions from the helper request. The tool exposes the complete `{ provider, response }` agent result as TOON while native output remains JSON; the `decisions` example above is the model's required judgment document, not the tool-result envelope. Agent policies use the selected answer's confidence only; they preserve existing deny, human-only review, permission, explicit-selection, stale-autonomy, and active-work fences. Uncertainty follows ordinary review, routing baseline, unchanged-objective continuation, or an unchanged question; provider failure preserves existing failure boundaries rather than inventing input.

## Provider references

These references describe the external APIs and the confidence-elicitation basis; the supported local schemas and validation remain authoritative for YCoding:

- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
- [OpenAI create method](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- [TypeSafe API](https://docs.typesafe.ai/api)
- [TypeSafe models](https://docs.typesafe.ai/models)
- [Just Ask for Calibration (Tian et al., EMNLP 2023)](https://aclanthology.org/2023.emnlp-main.330/), the basis for the decision-agent confidence elicitation
