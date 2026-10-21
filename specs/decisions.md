# Decisions

## Baseline model assessment, graded delegation, and YOLO evaluators

### Shared task context

The decision model and every runtime-purpose evaluator use `SessionDecisionContext.read` in addition to their request evidence. The snapshot is bounded to sixteen recent messages, thirty-two tool parts per message, eight targeted input messages plus eight recorded human inputs, eight pending steers plus eight recorded human steers, eight recent durable reviews, sixty-four Session ceiling rules, sixty-four remembered project grants, and two managed-task ancestors. It includes the current goal, retained summary, tool lifecycle and bounded error observations, review identities and available fingerprints, and explicit coverage limitations. Structured summaries retain objective, decisions, requirements, constraints, blockers and bounded progress separately; coverage reports truncation. A pending queue is future work, not current authority. Request-specific policy applicability and action targets remain the caller's responsibility; the context reader performs no authorization.

Recorded input origin distinguishes human, delegated-task, plugin, review-decision, and unreported-input context. Assistant text, tool results, summaries, delegated claims, and automatic decisions do not establish human approval. Unknown provenance stays unknown. Newer applicable human corrections supersede older intent; an ordinary reversible default is not an invented factual value or a grant of consequential authority.

The snapshot participates in the helper's cache key and is read again before a result settles. `SessionDecisionContext.authorityDigest` fences goals, authority-bearing inputs, summary and grants without treating unrelated sibling-tool progress, unrelated review deferrals, or review-delivery receipts as revocation. Each gate separately fences matching review history through its request applicability. Caller permission, ceiling, and guardrail checks still apply. Explicit `decision` requests receive the same context but remain advisory judgments with no approval authority.

Gate evidence supplies matching rule origins and request fingerprints. Guardrails receive classifier segment/targets/directories, operation, matching prior human outcomes, and permission assessment for the same canonical tool call. This evidence does not skip a gate. Baseline and YOLO results are revalidated against current applicability and policy before application. A new deny blocks; changed rule identity or hard-review status invalidates an older approval; `configuration.invalid` is not model-approvable. Automatic outcomes keep model provenance and never become human replies. Ordinary awake reply holds are bounded process-local request history; durable review-box outcomes and configured rules retain their separate lifetimes.

`guardrails.decide_reviews` is on when omitted; only an explicit `false` disables it. No additional configuration key gates this behavior. While on, it provides baseline autonomous assessment of permission asks and ordinary and hard guardrail reviews — including standard-match verification — even when every Session flag and `yolo` are off. Hard assessment also respects `guardrails.decide_hard_reviews` (default true; explicit `false` sends hard reviews directly to the human path). Session flags remain independent and off by default, and deterministic layers still settle first where enabled: `autoPermission` approves ask permissions by rule across the managed-task chain; the root family's awake `autoGuardrail` approves ordinary standard reviews, never hard or custom-rule reviews; the Session's own `autoAnswer` (Session-local, no family propagation) supplies only valid explicit default or rule-based answers. Boolean `yolo` separately enables hidden evaluators — `yolo-permission`, `yolo-guardrail`, `yolo-answer`, all tools denied, same Decision API and authentication route — for requests left unresolved; toggling `yolo` rewrites no flag and no flag gates the evaluators. With `decide_reviews` explicitly off, requests with no other enabled path ask humans awake or defer asleep with reason `disabled`, without helper calls or model-escalation provenance. Explicit denies, caps, permission ceilings, and `skipReview` settle before any helper call. Advisory `decision` calls do not depend on these runtime switches.

Every baseline or evaluator assessment ends in exactly one strict typed outcome — `allow`, `deny`, or `escalate` — with a bounded reason and evidence. Assess the actual operation, its targets and data, its side effects, and the bounded authorization already granted; an outside-repository path alone never by itself requires a human, and a covered, safe, or non-matching action is allowed. Grade exactly `allow`, `deny`, and `escalate` for guardrail reviews. Choose the highest-confidence qualifying choice: `allow` ≥0.8 approves the current attempt only (reply `once`, ordinary reviews only; never a persistent Always grant) and `deny` ≥0.8 rejects. Human Always remains an ordinary-review feature. Stored `approve_all`, `approve`, and `reject` choices on earlier events remain replayable as recorded; new assessments never produce them. Explicit denies and real hard policy are never model-waived: a standard hard match the evidence shows is a false positive may be reclassified and then follows the ordinary path, while a real hard review can only be model-denied or escalated — approval requires a human. Escalate if escalation has the highest confidence (including a tie), no choice qualifies, allow and deny both qualify, or evaluation is unsupported on the strict route, refuses, fails, returns invalid output, is ambiguous, or exceeds 60 seconds. Every escalation and failure carries a visible bounded reason and the next action: awake escalation becomes a human request with provenance; asleep escalation raises `Guardrail.DeferredError` and records a review-box item. No outcome is a generic stuck state.

Retain optional selected choice/confidence and optional `grades: [{ choice, confidence, evidence }]` on guardrail outcomes, escalation facts, pending escalation, Status, and review items. Grade evidence is redacted and bounded to 500 characters; grades are absent on refusal, error, and timeout. `sleep: {}` is an optional family presence marker; waking clears it without restoring another setting. Stored removed toggle fields decode as ignored data.

Each helper evaluation appends one durable `session.decision.audited` event with `purpose` (`permission`, `guardrail`, `answer`, or `advisory`), optional `authority` (`baseline` or `yolo`), `agent`, optional `model`, `outcome` (`succeeded`, `failed`, or `cancelled`), optional failure `reason`, `fingerprint`, optional `invocationKey`, `attempts`, and at most 32 bounded `answers` entries (`name`, `type`, `confidence`, and the typed `answer`, `choice`, `score`, or text `length`). Text answers record only their length; prompts, evidence, and answer text are not stored. Each permission-ask assessment appends `session.permission.assessed` with `requestID`, `outcome` (`allow`, `deny`, or `escalate`), `via` (`auto-permission`, `baseline`, or `yolo`), optional `reply`, the escalation fields, and optional tool-call `source`. Guardrail decided and escalated events, Status decisions, and replies carry optional `authority` (`baseline` or `yolo`); an absent value marks a historical, human, or fixed-rule outcome and is never inferred. Canonical escalation text prefixes the recorded authority.

The implemented generative adapter admits native `openai-responses`, `openai-responses-websocket`, `openai-chat`, `anthropic-messages`, and ChatGPT Codex HTTP `openai-codex-responses`. Codex WebSocket and unverified compatibility/AI SDK bridge routes fail closed with `unsupported-output` before dispatch. Typed decision semantics do not require JSON generation in principle; this runtime installs no native-classification, logprob-readout, or parsed-answer adapter. Provider protocol support is not evidence of endpoint/model acceptance, calibrated probability, or authorization.

## Scope and defaults

Audit answer names, string choices, and invocation keys use `sha256:` followed by the first 16 hexadecimal digest characters. Boolean choices retain their typed value. Audit records contain no raw caller-controlled identifiers.

Match-verification evidence separates the classifier's executable segment and resolved targets from the original resource text. Its instructions exclude comments, embedded statements, quoted/printed text, and names as grounds for dismissal. Unit tests verify this framing and evidence shape; they do not prove model resistance to adversarial instructions.

Standard guardrail match verification is a runtime use of the configured helper under `guardrails.decide_reviews` (on unless explicitly `false`). It asks a strict-choice question, not a Boolean predicate, with redacted, explicitly untrusted action evidence and the matched standard rule ID/reason. Only `allow` at confidence ≥0.9, scoped to "the action does not perform the matched rule's behavior", dismisses that rule; for a standard hard match that dismissal is the false-positive reclassification, after which the action follows the ordinary path. Refusal, error, unavailability, lower confidence, or a 15-second timeout preserves review with its visible reason. Denies and custom rules never enter it; ordinary reviews already auto-approved by `autoGuardrail` and `skipReview` skip it. Surviving hard reviews retain the separate graded path, additionally gated by `guardrails.decide_hard_reviews`, which can only deny or escalate; explicit false also skips verification of hard matches. Minimal dismissal provenance is durable; commands and resources are not persisted in it.

The Location-scoped decision service evaluates explicit agent tool calls and enabled runtime requests for standard-match verification, graded guardrail reviews, permission asks, and question/Form answers. Agent calls retain effective permissions, inherited ceilings, and shared guidance. Runtime requests use self-contained redacted evidence and the same helper/authentication route. Evaluator option answers retain the 0.8 threshold, preserve question and choice IDs with `false` distinct from absent, and generate required free text only after typed bounded validation; an unsettled answer defers to the review box asleep with its reason and any reported choice/confidence, without an automatic fallback, and waits for the human awake. Runtime approval/sleep calls have a 60-second deadline; match verification uses 15 seconds. Agent-invoked judgments retain their cancellation contract. Permission-ask assessment runs under baseline `decide_reviews` or the `yolo-permission` evaluator; deterministic permission approval requires `autoPermission`. Answer eligibility requires the Session's own `autoAnswer` flag for deterministic defaults/rules or effective `yolo` for evaluator answers; baseline assessment never answers questions or Forms, and goals grant no answer authority.

The helper returns typed judgments and self-reported, uncalibrated confidence, not calibrated probabilities. A judgment is never permission, approval, the user's answer, completion evidence, or authority to change the objective or explicit owner choices. Configuration and authentication follow [Decisions](../docs/configuration.md#decisions). The top-level `decisions` key is unsupported and produces a removed-key diagnostic; decision helper model settings remain supported.

## Decision-agent inputs

Runtime single-choice and graded-choice helpers MUST redact known credentials from choice values before dispatch, validate responses against those redacted choices, and map validated results back to their original local values. A redaction collision MUST settle as an invalid request without a helper call. Automatic Question, Form, and managed-child answers MUST fence the asking Session's autonomy revision and the ordered managed-ancestor revision chain before settlement. Any change on that chain, including revocation followed by restoration, MUST invalidate the result; unrelated sibling changes MUST NOT invalidate it.

The tool accepts `{ "provider": "agent", "request": { "state": ..., "questions": [...] } }`. State is JSON. Questions are ordered, uniquely named, and bounded to 1–32 per call. Every question has a nonempty `name` of at most 64 characters and nonempty `instructions` of at most 8,192 characters:

- `predicate` asks for a Boolean;
- `choice` supplies 1–255 unique string or Boolean `value` options with optional nonempty descriptions and optional Boolean `grade` (default false);
- `score` supplies 2–10 levels with nonempty labels and optional nonempty descriptions; results use zero-based integer indexes;
- `text` asks for bounded free text with optional `maxLength`, an integer from 1 to 8,192 (default 8,192). This addition changes no existing question or answer field.

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

The hidden primary `decision` agent and the hidden `yolo-permission`, `yolo-guardrail`, and `yolo-answer` evaluators have every tool denied and JSON-only judgment prompts. Their reserved IDs cannot be selected for fresh foreground Session creation, explicit switching, or commands. Session creation and switching reject it with HTTP 400 `InvalidRequestError` on `agent`; command rejection precedes template evaluation. Existing-ID adoption preserves the original Session.

Baseline and advisory model resolution prefers `agents.decision.model`, then `efficiency.helper_models.decision`, then the owner Session/default. YOLO selection and technical recovery use the matching `agents.yolo-permission.model`, `agents.yolo-guardrail.model`, or `agents.yolo-answer.model` first, then the ordinary decision pin, explicit configured decision helper, and owner Session/default. Exact duplicate references are removed without merging profiles or variants. Unavailable explicit profiles are not substituted. The chain enumerates no other accounts or catalog models and does not consume Session-Step `model_fallbacks`. Explicit helper pins remain stable across main-model switches. Supported subscription routes use the selected model's normal credentials.

Each generative request carries `responseFormat: { type: "json", schema }`, no execution tools, and an initial output limit of 4,096 tokens. Provider lowering uses strict `text.format`, strict `response_format`, or Anthropic `output_config.format`, preserving other protocol options. The local validator remains authoritative for bounds and cross-answer semantics not enforced by a provider's schema subset. A schema-shaped result proves neither factual correctness nor permission.

## Results and abstention

For `grade: true`, a choice answer is `{ name, type: "choice", answer: null, choice: null, score: null, confidence: 0, grades: [{ choice, confidence, evidence }] }`. Grade every listed typed choice exactly once with finite confidence in `[0,1]` and non-whitespace evidence of at most 500 characters. Missing, duplicate, extra, or out-of-range grades, a single pick, and nonzero answer-level confidence are invalid. Graded mode makes no single pick. Single-pick mode omits `grades`; supplying them is invalid. Refusals keep the uniform refusal shape without `grades`.

The helper returns exactly one JSON document with root `decisions`, version `1`, and one answer for each requested name. Every answer contains `name`, `type`, `answer`, `choice`, `score`, and `confidence`; a `text` answer additionally carries its bounded `text` string (at most the question's `maxLength`), and every existing field keeps its meaning. Validated answers retain request order. Only the matching answer field is populated; other fields are `null`. Confidence is finite in `[0, 1]`. Choices must match supplied values with their original type; scores must index supplied levels. Unknown fields, duplicate/missing names, wrong types, out-of-range scores, prose, fenced output, and non-JSON output fail validation. No fabricated default answer exists.

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

Invalid calls produce model-visible tool errors with JSON field paths, expected shapes or allowed values, and a minimal valid request. Values and unrecognized key names are redacted, never echoed as evidence. Empty `questions` reports: `questions: expected at least one question; received []. Add one bounded question, or skip the decision tool if no judgment is needed.` An invalid question type identifies `questions[0].type` and the allowed `predicate`, `choice`, `score`, and `text` types.

Failure reasons are `unavailable`, `invalid-request`, `provider-failed`, `timeout`, `input-too-large`, `invalid-output`, `refused`, `truncated-output`, and `unsupported-output`. They identify the failed boundary without credentials, raw helper output, or provider payloads. Refusal can also be a valid answer in a completed document. Guardrail handoff reasons additionally distinguish `escalated`, `conflicting_grades`, and `low_confidence`; choice, confidence, and grades appear only when the helper supplied validated values. Durable events, pending requests, deferred review items, TUI, and web preserve these distinctions.

## Safety, transport, and usage

Permission action `decision` uses resource `agent`. Explicit denials block the call and inherited ceilings also remove it from model-visible tools. Judgment evidence must be authorized for the selected helper model's authentication, privacy, quota, and billing route. Credentials stay outside tool arguments and results.

Deduplication identity includes configured references, exact variants and profiles, actual routes, and account digests. Computing or rechecking that identity MUST NOT refresh credentials. Cache a success only if its identity remains unchanged. One evaluation deadline covers key preflight, model resolution, attempts, joined waits, and the identity recheck.

Serialized input and collected UTF-8 output are each bounded to 1 MiB. Baseline and advisory evaluations permit at most two provider attempts on one selected route. YOLO evaluations permit at most three provider attempts across their configured chain, at most two per candidate. Both share a 60-second total deadline and a 25-second per-attempt limit; standard-match verification retains its 15-second outer deadline. Unavailable and unsupported candidates are skipped without provider dispatch. Invalid or truncated output, timeouts, and retryable transient failures permit bounded recovery; an invalid-output retry adds a fixed schema reminder without echoing the earlier output. Truncation raises the output limit to at most 8,192 tokens within the model's declared output cap. Refusal, authentication failure, invalid input, non-retryable provider failure, and interruption do not trigger route hopping. Exhaustion returns a typed failure; no fabricated structured success or free-text fallback exists. Interruption does not establish upstream cancellation or billing cancellation.

YOLO-authorized permission and guardrail outcomes MUST match the inherited autonomy revision and digest captured before assessment when applied. Revocation followed by restoration MUST invalidate them. Standard-match verification requires baseline assessment; disabled verification preserves deterministic matches even with YOLO enabled. Permission settlement MUST re-evaluate current deny rules and ceilings. Baseline judgments remain independent of YOLO state; genuine hard reviews still require human approval. Technical recovery grants no authority. Handoffs identify a model escalation only when the recorded choice is `escalate`; withheld verdicts and policy-required handoffs require human review without inventing a model choice.

Provider-request ledger source is `decision`, separate from normal model Steps. Every dispatched attempt settles its own record, including timeout and interruption. Records keep the selected hidden agent and the caller's input ID when supplied. Results aggregate reported token, reasoning, and cache usage across attempts; missing cache reporting remains unknown. Known normal-model catalog prices can price requests; unpriced usage has no priced ledger amount. Cached tokens or zero aggregates do not establish free billing, and subscription catalog costs are estimates, not invoices. Local history and tool results remain durable; no zero-retention guarantee applies. Historical synthetic judgments and optional guardrail risk fields remain replayable; TUI transcript rows keep historical advisory messages hidden by their `decisionInputID` metadata.
