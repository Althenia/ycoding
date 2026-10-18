# Decisions

## 2026-10-16: Graded runtime review delegation

Accepted. Runtime automatic answers require the Session's own durable `/auto-answer` toggle on (default off, Session-local, no family propagation); model guardrail verification and grading require `guardrails.decide_reviews: true` (default false). Both are prerequisites independent of YOLO, goals, and sleep. Disabled requests ask humans awake or defer asleep with reason `disabled`, without helper calls or model-escalation provenance. Awake effective YOLO 2 ordinary-review approval remains separate. With model reviews enabled, `guardrails.decide_hard_reviews` defaults to true and can separately disable hard-review grading. Denies, caps, permissions, and `skipReview` retain their gates. Advisory `decision` calls do not depend on these runtime switches.

Grade `approve_all`, `approve`, `reject`, and `escalate`; offer `approve_all` only when the review offers Always, so never for hard reviews. Choose the highest-confidence qualifying choice: `approve_all` ≥0.9 yields `always`, `approve` ≥0.8 (≥0.95 hard) yields `once`, and `reject` ≥0.8 yields `reject`. Escalate if escalation has the highest confidence (including a tie), no choice qualifies, approval and rejection both qualify, or evaluation refuses, fails, returns invalid output, or exceeds 60 seconds. Awake escalation becomes a human request with provenance; asleep escalation raises `Guardrail.DeferredError` and records a review-box item.

Retain optional selected choice/confidence and optional `grades: [{ choice, confidence, evidence }]` on guardrail outcomes, escalation facts, pending escalation, Status, and review items. Grade evidence is redacted and bounded to 500 characters; grades are absent on refusal, error, and timeout. `sleep: {}` is an optional family presence marker; waking clears it without restoring another setting. Stored removed toggle fields decode as ignored data.

## Scope and defaults

Match-verification evidence separates the classifier's executable segment and resolved targets from the original resource text. Its instructions exclude comments, embedded statements, quoted/printed text, and names as grounds for dismissal. Unit tests verify this framing and evidence shape; they do not prove model resistance to adversarial instructions.

Standard guardrail match verification is a runtime use of the configured helper that requires `guardrails.decide_reviews: true`. It asks `guardrail_match` with redacted, explicitly untrusted action evidence and the matched standard rule ID/reason. Only false at confidence ≥0.9 dismisses that rule; refusal, error, unavailability, lower confidence, or a 15-second timeout preserves review. Denies and custom rules never enter it; already YOLO-auto-approved ordinary reviews and `skipReview` skip it. Surviving hard reviews retain the separate delegated-approval path, additionally gated by `guardrails.decide_hard_reviews`. Minimal dismissal provenance is durable; commands and resources are not persisted in it.

The Location-scoped decision service evaluates explicit agent tool calls and enabled runtime requests for standard-match verification, graded guardrail reviews, and sleeping-family answers. Agent calls retain effective permissions, inherited ceilings, and shared guidance. Runtime requests use self-contained redacted evidence and the same helper/authentication route. Enabled sleeping option answers retain the 0.8 threshold; an unsettled answer defers to the review box with its reason and any reported choice/confidence, without an automatic fallback. Runtime approval/sleep calls have a 60-second deadline; match verification uses 15 seconds. Agent-invoked judgments retain their cancellation contract. Answer eligibility requires the Session's own `/auto-answer` toggle; YOLO levels and goals grant no answer authority.

The helper returns typed judgments and self-reported, uncalibrated confidence, not calibrated probabilities. A judgment is never permission, approval, the user's answer, completion evidence, or authority to change the objective or explicit owner choices. Configuration and authentication follow [Decisions](../docs/configuration.md#decisions). The top-level `decisions` key is unsupported and produces a removed-key diagnostic; decision helper model settings remain supported.

## Decision-agent inputs

The tool accepts `{ "provider": "agent", "request": { "state": ..., "questions": [...] } }`. State is JSON. Questions are ordered, uniquely named, and bounded to 1–32 per call. Every question has a nonempty `name` of at most 64 characters and nonempty `instructions` of at most 8,192 characters:

- `predicate` asks for a Boolean;
- `choice` supplies 1–255 unique string or Boolean `value` options with optional nonempty descriptions and optional Boolean `grade` (default false);
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

The hidden primary `decision` agent has every tool denied and a JSON-only judgment prompt. Its reserved ID cannot be selected for fresh foreground Session creation, explicit switching, or commands. Session creation and switching reject it with HTTP 400 `InvalidRequestError` on `agent`; command rejection precedes template evaluation. Existing-ID adoption preserves the original Session.

Model resolution prefers `agents.decision.model`, then `efficiency.helper_models.decision`, then the owner Session/default model. A helper value of `session` retains owner-model resolution. Supported subscription routes use normal model credentials. Admitted protocols are OpenAI Responses over HTTP or WebSocket, OpenAI Chat, and Anthropic Messages; other protocols return `unsupported-output` before dispatch. Each request carries `responseFormat: { type: "json", schema }`, no tools, and an initial output limit of 4,096 tokens. Provider lowering uses strict `text.format`, strict `response_format`, or Anthropic `output_config.format`, preserving other protocol options. The local validator remains authoritative for bounds and cross-answer semantics not enforced by the provider's schema subset. Protocol support does not establish support by every compatible provider or model.

## Results and abstention

For `grade: true`, a choice answer is `{ name, type: "choice", answer: null, choice: null, score: null, confidence: 0, grades: [{ choice, confidence, evidence }] }`. Grade every listed typed choice exactly once with finite confidence in `[0,1]` and non-whitespace evidence of at most 500 characters. Missing, duplicate, extra, or out-of-range grades, a single pick, and nonzero answer-level confidence are invalid. Graded mode makes no single pick. Single-pick mode omits `grades`; supplying them is invalid. Refusals keep the uniform refusal shape without `grades`.

The helper returns exactly one JSON document with root `decisions`, version `1`, and one answer for each requested name. Every answer contains `name`, `type`, `answer`, `choice`, `score`, and `confidence`. Validated answers retain request order. Only the matching answer field is populated; other fields are `null`. Confidence is finite in `[0, 1]`. Choices must match supplied values with their original type; scores must index supplied levels. Unknown fields, duplicate/missing names, wrong types, out-of-range scores, prose, fenced output, and non-JSON output fail validation. No fabricated default answer exists.

Every question type can abstain with the same existing refusal representation: `type: refusal`, `answer: null`, `choice: null`, `score: null`, and `confidence: 0`. The prompt explicitly requires abstention for insufficient evidence and forbids forcing a value or substituting a low-confidence pick. Refusal is distinct from any real option, including keep-current. Calling agents treat it as uncertainty and gather missing evidence, decide from evidence, or ask the user.

```json
{
  "decisions": {
    "version": 1,
    "answers": [
      { "name": "route", "type": "refusal", "answer": null, "choice": null, "score": null, "confidence": 0 },
      { "name": "ready", "type": "refusal", "answer": null, "choice": null, "score": null, "confidence": 0 }
    ]
  }
}
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

Failure reasons are `unavailable`, `invalid-request`, `provider-failed`, `timeout`, `input-too-large`, `invalid-output`, `refused`, `truncated-output`, and `unsupported-output`. They identify the failed boundary without credentials, raw helper output, or provider payloads. Refusal can also be a valid answer in a completed document. Guardrail handoff reasons additionally distinguish `escalated`, `conflicting_grades`, and `low_confidence`; choice, confidence, and grades appear only when the helper supplied validated values. Durable events, pending requests, deferred review items, TUI, and web preserve these distinctions.

## Safety, transport, and usage

Permission action `decision` uses resource `agent`. Explicit denials block the call and inherited ceilings also remove it from model-visible tools. Judgment evidence must be authorized for the selected helper model's authentication, privacy, quota, and billing route. Credentials stay outside tool arguments and results.

Serialized input and collected UTF-8 output are each bounded to 1 MiB. An evaluation has a 60-second total deadline and at most two provider attempts, each limited to 25 seconds. Invalid or truncated output and eligible transient transport/provider failures permit one retry. Truncation raises the output limit to at most 8,192 tokens within the model's declared output cap. Refusal, authentication failure, unsupported output, and interruption do not retry. Runtime standard-match verification retains its tighter 15-second outer deadline. Interruption does not establish upstream cancellation or billing cancellation.

Provider-request ledger source is `decision`, separate from normal model Steps. Every dispatched attempt settles its own record, including timeout and interruption. Records keep agent `decision` and the caller's input ID when supplied. Results aggregate reported token, reasoning, and cache usage across attempts; missing cache reporting remains unknown. Known normal-model catalog prices can price requests; unpriced usage has no priced ledger amount. Cached tokens or zero aggregates do not establish free billing, and subscription catalog costs are estimates, not invoices. Local history and tool results remain durable; no zero-retention guarantee applies. Historical synthetic judgments and optional guardrail risk fields remain replayable; TUI transcript rows keep historical advisory messages hidden by their `decisionInputID` metadata.
