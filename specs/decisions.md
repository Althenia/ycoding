# Decisions

## Scope and defaults

Match-verification evidence separates the classifier's executable segment and resolved targets from the original resource text. Its instructions exclude comments, embedded statements, quoted/printed text, and names as grounds for dismissal. Unit tests verify this framing and evidence shape; they do not prove model resistance to adversarial instructions.

Standard guardrail match verification is an always-on runtime use of the configured helper. It asks `guardrail_match` with redacted, explicitly untrusted action evidence and the matched standard rule ID/reason. Only false at confidence ≥0.9 dismisses that rule; refusal, error, unavailability, lower confidence, or a 15-second timeout preserves review. Denies and custom rules never enter it; already YOLO-auto-approved ordinary reviews and `skipReview` skip it. Surviving hard reviews retain the separate delegated-approval path. Minimal dismissal provenance is durable; commands and resources are not persisted in it.

The Location-scoped decision service evaluates explicit agent tool calls and runtime requests for standard-match verification, user-enabled guardrail-decision, and sleeping-family answers. Agent calls retain effective permissions, inherited ceilings, and shared guidance. Runtime requests use self-contained redacted evidence and the same helper/authentication route. Review choices are `approve`, `reject`, and `escalate`; approve once or reject directly only when that choice has confidence ≥0.8. An explicit escalation, lower-confidence choice, refusal, error, or timeout hands the review to a human while awake and rejects while asleep. A durable escalation fact preserves the reported choice/confidence without restoring an interrupted review after restart. Denies never reach the helper. Sleeping option answers retain the 0.8 threshold with existing automatic fallback. Runtime approval/sleep calls have a 60-second deadline; match verification uses 15 seconds. Agent-invoked judgments retain their cancellation contract. Goals and YOLO 0–3 remain unchanged.

The helper returns typed judgments and self-reported, uncalibrated confidence, not calibrated probabilities. A judgment is never permission, approval, the user's answer, completion evidence, or authority to change the objective or explicit owner choices. Configuration and authentication follow [Decisions](../docs/configuration.md#decisions). The top-level `decisions` key is unsupported and produces a removed-key diagnostic; decision helper model settings remain supported.

## Decision-agent inputs

The tool accepts `{ "provider": "agent", "request": { "state": ..., "questions": [...] } }`. State is JSON. Questions are ordered, uniquely named, and bounded to 1–32 per call. Every question has a nonempty `name` of at most 64 characters and nonempty `instructions` of at most 8,192 characters:

- `predicate` asks for a Boolean;
- `choice` supplies 1–255 unique string or Boolean `value` options with optional nonempty descriptions;
- `score` supplies 2–10 levels with nonempty labels and optional nonempty descriptions; results use zero-based integer indexes.

String and Boolean choices retain distinct types. Inputs select neither credentials nor the helper model. Send self-contained authorized evidence and observable criteria. Use neutral wording, distinct options including a keep-current/other alternative, and distinguish adjacent score levels. Batch independent questions; separate dependent judgments. Use tests, grep, typechecks, and inventory for facts those checks can settle. Skip trivial choices, routine per-step classification, and repeated unchanged judgments.

```json
{
  "provider": "agent",
  "request": {
    "state": { "alternatives": "Two approaches have comparable cost; requirements are incomplete" },
    "questions": [
      {
        "type": "choice",
        "name": "route",
        "instructions": "Choose the better-supported approach",
        "choices": [
          { "value": "keep-current", "description": "Retain the current approach" },
          { "value": "change", "description": "Use the alternative" }
        ]
      },
      { "type": "predicate", "name": "ready", "instructions": "Does the evidence support starting now?" }
    ]
  }
}
```

The hidden primary `decision` agent has every tool denied and a static TOON-only prompt. Its reserved ID cannot be selected for fresh foreground Session creation, explicit switching, or commands. Session creation and switching reject it with HTTP 400 `InvalidRequestError` on `agent`; command rejection precedes template evaluation. Existing-ID adoption preserves the original Session.

Model resolution prefers `agents.decision.model`, then `efficiency.helper_models.decision`, then the owner Session/default model. A helper value of `session` retains owner-model resolution. Supported subscription routes use normal model credentials. The helper makes one streaming request with no tools and `generation.maxTokens: 2048`; the route maps that limit to its wire format. UTF-8 output is bounded to 1 MiB and must settle normally. Tool calls, partial settlement, and provider failures are rejected.

## Results and abstention

The helper returns exactly one TOON document with root `decisions`, version `1`, and one answer for each requested name. Uniform columns are `name,type,answer,choice,score,confidence`. Validated answers retain request order. Only the matching answer field is populated; other fields are `null`. Confidence is finite in `[0, 1]`. Choices must match supplied values with their original type; scores must index supplied levels. Unknown fields, duplicate/missing names, wrong types, out-of-range scores, malformed TOON, and JSON substitution fail validation. No JSON fallback or fabricated default answer exists.

Every question type can abstain with the same existing refusal representation: `type: refusal`, `answer: null`, `choice: null`, `score: null`, and `confidence: 0`. The prompt explicitly requires abstention for insufficient evidence and forbids forcing a value or substituting a low-confidence pick. Refusal is distinct from any real option, including keep-current. Calling agents treat it as uncertainty and gather missing evidence, decide from evidence, or ask the user.

```toon
decisions:
  version: 1
  answers[2]{name,type,answer,choice,score,confidence}:
    route,refusal,null,null,null,0
    ready,refusal,null,null,null,0
```

The tool returns the complete `{ provider, response }` envelope as TOON. Structured responses include the selected model reference, `semantics: "model-estimate"`, version, ordered answers, and canonical token usage when reported. For refusal results, a separate model-visible text part states that refusal is uncertainty and directs the caller to missing evidence or the user; it does not alter the structured result. For example, an abstaining choice appears in the envelope as:

```json
{
  "provider": "agent",
  "response": {
    "model": { "providerID": "fixture", "id": "judge" },
    "semantics": "model-estimate",
    "version": 1,
    "answers": [{ "name": "route", "type": "refusal", "answer": null, "choice": null, "score": null, "confidence": 0 }]
  }
}
```

The helper weighs plausible alternatives and estimates how well evidence supports its answer. Self-reporting supplies no calibration guarantee. Set the action threshold by the cost of being wrong. Refusal, errors, low or close confidence, and disagreement with evidence mean uncertainty. Reuse settled judgments until evidence changes; preserve owner choices and guardrails.

## Corrective errors

Invalid calls produce model-visible tool errors with JSON field paths, expected shapes or allowed values, and a minimal valid request. Values and unrecognized key names are redacted, never echoed as evidence. Empty `questions` reports: `questions: expected at least one question; received []. Add one bounded question, or skip the decision tool if no judgment is needed.` An invalid question type identifies `questions[0].type` and the allowed `predicate`, `choice`, and `score` types.

`unavailable` identifies helper model settings and the authenticated route to check. `invalid-output` identifies invalid TOON or schema-mismatched answers and directs the caller to evidence or uncertainty handling. `input-too-large` asks for reduced bounded evidence. Provider/transport failure reports unsettled evaluation rather than a successful judgment. Errors never expose credentials, raw helper output, or provider payloads. Refusal is a valid result, not malformed output.

## Safety, transport, and usage

Permission action `decision` uses resource `agent`. Explicit denials block the call and inherited ceilings also remove it from model-visible tools. Judgment evidence must be authorized for the selected helper model's authentication, privacy, quota, and billing route. Credentials stay outside tool arguments and results.

Serialized input is bounded to 1 MiB. Calls have no YCoding wall-clock deadline but remain explicitly cancellable; providers, transport, or networks can impose timeouts. Each call uses one model request without automatic retry or fabricated answers. Interruption does not establish upstream cancellation or billing cancellation.

Provider-request ledger source is `decision`, separate from normal model Steps. Records keep agent `decision` and the caller's input ID when supplied. Preserve reported token, reasoning, and cache usage; missing cache reporting remains unknown. Known normal-model catalog prices can price requests; unpriced usage has no priced ledger amount. Cached tokens or zero aggregates do not establish free billing, and subscription catalog costs are estimates, not invoices. Local history and tool results remain durable; no zero-retention guarantee applies. Historical synthetic judgments and optional guardrail risk fields remain replayable; TUI transcript rows keep historical advisory messages hidden by their `decisionInputID` metadata.
