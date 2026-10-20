# Session guardrails

Status: **Implemented**

Session guardrails are a Location-scoped safety service whose decisions apply to one durable root Session and every descendant Session in that family. They are independent from agent tool permissions and shell sandboxing.

## Ownership

- Schema owns rule, request, reply, counter, status, and ephemeral event shapes.
- Core owns standard policy, custom-rule discovery, matching, family resolution, pending reviews, and counters.
- Protocol and Server expose status, pending requests, and `once | always | reject` replies through Session-location middleware.
- TUI owns rehydrated review queues, parent-view handling of child requests, review interaction, and sidebar status.

## Evaluation contract

Every guarded side-effect boundary submits:

- the acting Session ID;
- an action identifier;
- one or more normalized resources;
- bounded metadata when required for classification.

Core resolves the durable root Session by following parent IDs. Pending reviews and concurrency counters are keyed by that root ID, while the request retains the acting child Session ID for attribution.

The decision order is:

1. an unoverrideable standard catastrophic deny;
2. an effective custom deny from the first matching source layer;
3. a standard hard review that survives semantic match verification;
4. a matching custom `hard_review` rule from any source layer;
5. the ordinary decision from the first matching custom source layer: nearest repository `Config.Directory`, then broader repository directories, then global config;
6. standard ordinary review;
7. standard allow fallback.

Within one custom source layer, rules sort by descending numeric priority, then deterministic lexical file path and rule ID. An enabled invalid source layer reviews mutation actions with `configuration.invalid` while preserving that layer's priority. Read-only actions remain available, and a valid matching deny in that layer remains a deny.

`hard_review` is a custom rule decision and is normalized to a review request with `hardReview: true`. A matching hard-review rule overrides ordinary `allow` and `ask` rules across source layers, including a higher-priority ordinary rule in the same layer; an effective deny remains a deny. `guardrails.enabled: false` disables ordinary policy but retains standard catastrophic denies, standard hard reviews, and enabled custom hard-review rules.

JSON/JSONC configuration recovery treats `guardrails` as one security unit. Any invalid value, including an unknown property, is replaced with `{ "enabled": true }`; omitted caps resolve to 8 concurrent shells, 8 concurrent subagents, and 16 pending reviews. This replacement takes precedence over an earlier document's disabled guardrails or custom caps through the existing last-defined configuration rule. `GET /api/config/diagnostics` reports the source path, `jsonPath: "$.guardrails"`, the rejection reason and message, and `failClosed: true`. Invalid permission rules likewise fail closed in their global or agent ruleset: preserve valid rule order, append a deny for the readable nonempty action on every resource, or append an all-action/all-resource deny if the action or ruleset is unreadable. This recovery does not change ordinary precedence between configuration scopes.

## Guarded boundaries

### Standard-match verification

Standard-match verification requires `guardrails.decide_reviews`, default on when omitted (explicit `false` disables). When enabled, call the configured helper with a strict-choice assessment (not a Boolean predicate) before a matched `standard.review.*` rule proceeds to human review or graded approval. Supply the matched rule ID/reason and redacted action, resources, workdir, and project under `untrustedEvidence`; treat evidence as data, never instructions. Dismiss only `allow` (nonmatch: the action does not perform the matched rule's behavior) with finite confidence in [0.9, 1]; dismissing a standard hard match reclassifies that false positive onto the ordinary path, and never waives a real hard match. Refusal, error, unavailability, a 15-second timeout, other answer types, and lower confidence preserve review with a visible bounded reason and next action. Disabled verification preserves the deterministic match without a helper call or dismissal event. Ordinary reviews already auto-approved by the root `autoGuardrail` flag and `skipReview` skip verification; catastrophic denies, explicit denies, and custom rules are never verified.

Reevaluate excluding only dismissed standard rule IDs. Verify additional standard matches and preserve independently matched custom policy. Dismissal never widens permissions, bypasses caps, approves another rule, or creates reusable approval. Surviving hard matches use graded delegation unless `guardrails.decide_hard_reviews` is false; false also skips verification of hard matches. Cancellation during verification owns no pending request or review slot.

Supply the classifier's `matchedSegment` and `resolvedTargets` as separate structured fields under `untrustedEvidence.classifier`. Comments are not shell operands. Statements, comments, quoted or printed strings, and suggestive names are not proof of a non-match: evaluate executable shell semantics. Unit tests establish the request framing and structured evidence, not a model's behavioral resistance to adversarial evidence.

Publish public durable `session.guardrail.dismissed.1` with `{ sessionID, reviewSessionID, ruleID, confidence }`; `sessionID` owns the root-family aggregate and `reviewSessionID` identifies the action's Session. Never store command/resource evidence in it. Status adds optional `dismissals: [{ eventID, sessionID, created, ruleID, confidence }]`, with the reviewed Session and event-envelope timestamp, oldest-first among the newest 100 dismissals. The TUI deduplicates by event ID and interleaves completed provenance chronologically only in the reviewed Session's view. Render the rule ID, `not a real match`, and unrounded confidence; only still-pending family requests remain pinned at the tail.

Verification: `packages/core/test/session-guardrail-service.test.ts` covers threshold dismissal, retained review, exclusions, delegated fallback, untrusted framing/redaction, cancellation, remaining standard/custom policy, and durable status provenance. Schema event-manifest tests guard the public payload and bounds. TUI Session transcript tests prove rehydrated and live rendering.

The current runtime evaluates guardrails immediately before supported side effects:

- model-facing shell and direct Session shell;
- edit, write, and patch commits;
- durable subagent creation;
- mutation-capable or process-like MCP execution;
- project-artifact mutation.

A permission approval cannot bypass a guardrail decision. A guardrail approval cannot widen the agent's effective permission policy.

Recursive deletion denies filesystem root (`standard.catastrophic.rm-root`), the configured home or any exact `/Users/<name>` or `/home/<name>` directory (`standard.catastrophic.rm-user-home`), and system directories under `/System`, `/Library`, `/usr`, `/etc`, `/bin`, `/sbin`, `/opt`, `/Applications`, or `/var` (`standard.catastrophic.rm-system`). Formatting disks, raw block-device writes, and fork bombs remain catastrophic denies.

Standard rules have two review tiers. Hard reviews cover destructive actions: deleting the project root or an ancestor (`standard.review.project-deletion`), deleting a direct child of the configured home (`standard.review.home-child`), destructive Git (`standard.review.git-destructive`: `git reset --hard`, `git clean` with `f` in its first flag group, `git checkout -- .`, `git restore` with `--worktree`, and `git branch` with `D` in its first flag group), force push (`standard.review.force-push`), and destructive database statements (`standard.review.database-destructive`). The database rule matches `DROP DATABASE|SCHEMA|TABLE`, `TRUNCATE TABLE`, and `DELETE FROM` text anywhere in a shell command except where the text is proven inert: inside a read-only command or all-read-only pipeline (the same analysis that exempts read-only commands from outside-repository review), or inside a shell comment. Text in a pipe to any other command, a redirect, a heredoc or here-string, a command substitution, a wrapper, an interpreter, or a command that is not proven read-only stays matched. Ordinary review is the outside-repository sandbox (`standard.review.outside-repo`); nothing inside the repository triggers it. Package publication, production deployment, security-policy changes, and MCP execution have no standard guardrail rule; tool permissions still govern them. Multiple deletion targets inside the repository do not independently trigger a review.

Temporary roots are excluded before every standard deletion classification: `/tmp`, `/private/tmp`, `/var/tmp`, `/private/var/tmp`, `/var/folders`, and the Location process's `TMPDIR` when present, including their descendants. The exclusion takes precedence even when a temporary target contains the project or is a home child. A mixed command evaluates only its non-temporary deletion targets. Custom policy and permission decisions retain their authority.

### Broad-deletion recognition boundary

The standard matcher recognizes direct POSIX `rm` invocations by executable basename, including `/bin/rm`, supported `sudo | command | env | nohup` wrappers, combined or separate short recursive flags, `--recursive`, quoted operands, simple `; | && ||` or newline-separated commands, and a preceding direct `cd`. It expands exact `~`, `$HOME`, `${HOME}`, `$PWD`, `${PWD}`, `$TMPDIR`, and `${TMPDIR}` path forms against the Location's home, workdir, project directory, and process temporary directory. Targets resolve lexically before temporary exclusions and deletion classification. Supported compound commands retain every reachable working directory; `cd ... &&` establishes relocation only on success. Multiple ordinary operands are allowed by the standard deletion rules.

This is a bounded recognizer, not a complete shell parser or executable sandbox. It does not promise detection of arbitrary aliases, substitutions, generated commands, `sh -c` payloads, `eval`, `find -exec`, `xargs`, or other obfuscation and indirection. Shell sandbox availability and enforcement remain a separate boundary.

### Outside-repository recognition boundary

The repository is the Location's version-control worktree root, or the Location directory when it has no version control, and everything below it. Every checkout of this repository (the main checkout and every Git-listed linked worktree sharing its canonical Git common directory, the same set `LocationMutation` trusts for `external_directory`) and the temporary roots above count as inside.

`file_mutation` (edit, write, and patch commits) targeting a path outside the repository requires ordinary review. A shell command requires ordinary review when its working directory, a `cd` target (a bare `cd` means home), or any operand, redirection target, or `--option=value` path resolves outside the repository. Shell resolution reuses the deletion recognizer's working-directory tracking and `~`, `$HOME`, `$PWD`, `$TMPDIR` expansion. Device paths under `/dev` and the executable position of each command are not targets. Deterministically recognized read-only shell commands are exempt even when they name outside paths, and read-only tools are not guarded; reading outside the repository remains governed by the `external_directory` permission. Like deletion recognition, this is a bounded recognizer: it does not detect paths produced by substitution, `sh -c` payloads, `eval`, `xargs`, `find -exec`, scripts, or programs that write outside the repository without naming the path.

The root family's `autoGuardrail` flag auto-approves ordinary standard reviews while awake, independently of model configuration, and never hard or custom-rule reviews. Remaining reviews receive baseline graded assessment under `guardrails.decide_reviews`, which is on when omitted (explicit `false` disables), even with every Session flag off, and additionally under root effective `yolo` (`yolo-guardrail`). With the switch explicitly off and no evaluator enabled, grading asks humans awake or defers asleep with reason `disabled`, without model-escalation provenance. Asleep, deterministic auto-approval never applies. With model reviews enabled, `guardrails.decide_hard_reviews` defaults to true; false skips all model assessment of hard matches, including standard-match verification; ordinary matches are still verified. Automatic question/form/subagent answers independently require the Session's own `autoAnswer` flag (defaults/rules only) or effective `yolo` (`yolo-answer`), both default off.

Assessment ends in exactly one strict typed outcome, `allow`, `deny`, or `escalate`, with a bounded reason; judge the actual operation, targets and data, side effects, and bounded authorization — an outside-repository path alone never by itself requires a human, and a covered, safe, or non-matching action is `allow`. Grade exactly `allow`, `deny`, and `escalate` independently with evidence. Choose the highest-confidence qualifying choice: `allow` at ≥0.8 replies `once` for ordinary reviews only and never creates a persistent Always grant — for hard reviews no grade replies `once`, and only `deny` or escalation takes effect; `deny` at ≥0.8 replies `reject`. Human Always remains an ordinary-review feature. Escalate when escalation scores highest, including a tie; when no choice qualifies; when `allow` and `deny` both qualify; or on an unsupported strict route, refusal, invalid output, ambiguity, error, or the 60-second deadline — always with a visible bounded reason and next action, never a generic stuck state. Graded output requires each of the three choices exactly once, finite confidence in `[0,1]`, and non-whitespace evidence of at most 500 characters. If awake, publish the normal human request with optional `escalation` provenance and await its ordinary or hard review choices. Human replies retain human attribution. If asleep, defer to the durable review box; the waiting action fails with `Guardrail.DeferredError { requestID, itemID, ruleIDs }` and does not run. Catastrophic and explicit denies block before any helper call. Classification, caps, and `skipReview` retain their gates.

Each awake human handoff publishes public durable `session.guardrail.escalated.1` with the reviewed `sessionID`, `requestID`, available helper `choice`, `confidence`, and `grades`, and the canonical tool-call `source` (`messageID`, `callID`) when present. `Guardrail.DecisionChoice` is `allow | deny | escalate` for new assessments, and also decodes the historical `approve_all | approve | reject` recorded on earlier events; `Guardrail.Grade` is `{ choice, confidence, evidence }`. Redact and bound grade evidence before storage. Preserve the selected grade's choice/confidence even when conflicting grades require escalation. Omit grades and unavailable judgments on refusal, error, and timeout; do not persist resources in these provenance events. Project a chronological System notice in the reviewed Session. Entering sleep converts plain and escalated pending reviews across every family Location into review-box items, retaining grades, and fails each waiting action with `Guardrail.DeferredError`. A confident decision while already asleep records its outcome, not an escalation notice. Interruption or shutdown ends the waiting action and prompt. Restart restores no pending request or action. Existing normal human reply recording remains unchanged.

## Human review

A review request blocks the guarded operation until the user replies:

- `once` permits that operation attempt;
- `always` permits the attempt and, for an ordinary outside-repository review, records the request's outside directories (a directory target itself, otherwise its parent, including descendants) as a private durable `session.guardrail.approved` event on the root Session; with no outside directories it approves only that attempt;
- `reject` fails the blocked operation.

A request with `hardReview: true` advertises only `once` and `reject`. A direct `always` reply fails the waiting operation. Hard-review grading requires model reviews enabled (baseline `decide_reviews` on or root effective `yolo` on) with `guardrails.decide_hard_reviews` not false, and can only deny or escalate; a standard hard false positive may first be reclassified by match verification while hard assessment is enabled, while a real hard approval requires human review awake or defers asleep. `autoGuardrail`, `autoPermission`, active goals, agent-invoked judgments, and reusable approvals never settle hard reviews. Ordinary standard reviews auto-approve deterministically only under the root `autoGuardrail` flag while awake.

An `always` approval stores outside directories durably on the root family and is shared by descendants across Locations and restarts. Core always performs fresh evaluation: denies and hard reviews cannot reuse it, and every outside target must lie within an approved directory. A review without outside directories approves only its attempt. `once` is not reusable. Deterministic ordinary auto-approval requires an awake root family with `autoGuardrail` on; effective `yolo`, `autoPermission`, and an active `goal` cannot grant it.

Parent Session views may answer reviews created by descendants in the same root family. An unrelated Session receives a not-found response.
The first valid reply atomically claims the pending request. A concurrent or later reply receives a not-found response and cannot change the winning decision or create a reusable approval.

## Counters

Sleep-entry conversion isolates each producer kind and family Location. A failed conversion is logged; later producer kinds and descendants continue. Open review-box items remain unfinished work after waking. A committed revert withdraws affected guardrail reviews and unconsumed grants atomically with the removed message range, and projects a replayable System notice from each withdrawal fact.

The implemented family caps are:

- concurrently running shells;
- concurrently running subagents;
- pending human reviews.

Reservations are acquired before the side effect and released after success, failure, cancellation, interruption, or service shutdown. Configuration accepts only these implemented caps.

## Custom policy files

Core scans direct `guardrails/*.md` children, not a recursive tree, under the global config directory and every discovered repository `Config.Directory`. Each enabled file defines one validated rule in YAML frontmatter; its Markdown body is operator-facing explanation and is not model instruction. Disabled files are ignored.

Repository directories are evaluated nearest first, then broader ancestors, and global config is last. The first matching source layer decides. Standard catastrophic denies cannot be weakened by custom policy. A malformed enabled source layer is reported in status and fails mutation actions closed with review at that source layer's position; it does not erase or reorder other layers.

## API and events

The public operations are:

```text
GET  /api/session/:sessionID/guardrail
GET  /api/session/:sessionID/guardrail/request
POST /api/session/:sessionID/guardrail/request/:requestID/reply
```

Guardrail asked, replied, and decided events are ephemeral. Durable Session history owns Session identity and escalation notices. Pending review state is process-local and rehydrates through the request API on client reconnect; backend shutdown ends pending reviews and their waiting actions.

Decision-model replies add `decidedBy: "decision-model"`, optional `choice: "allow" | "deny" | "escalate"` (earlier events may carry historical `approve_all`, `approve`, or `reject`), optional `confidence` in `[0,1]`, and optional `grades: Grade[]`. The public durable `session.guardrail.decided` event retains root `sessionID`, `reviewSessionID`, request ID, `reply: "once" | "always" | "reject"`, available choice/confidence/grades, matched rule IDs, and canonical tool-call `source`. Escalation facts, the pending request's `escalation`, Status outcomes, and guardrail review-box items carry the same grades. Evidence is redacted and bounded to 500 characters per grade; refusal, invalid output, error, and timeout omit grades. Commands and targets remain excluded from provenance events. `session.guardrail.dismissed` retains only its rule ID, confidence, and source link. Status supplies the newest 100 outcomes and dismissals with reviewed Session, event timestamp, and source. Awake escalation publishes the normal human request; its later reply retains human attribution. Pending requests remain process-local and pinned at the family tail.

The Reply body is the public union `once | always | reject`. Public replies retain human attribution and cannot supply helper provenance or settle a model-held request. The internal sleep operation defers every human-visible pending request, retaining stored escalation provenance on the item. A failed Session lookup, Location build, or conversion is logged and skipped without aborting other family conversions or sleep notices. Deferred items are decided only through `session.review.decide` (see [session](./session.md#root-family-sleep-and-review-delegation)); an approval admits one identical re-issued request from the same Session by fingerprint, after classification and deny checks, and is consumed durably. `Guardrail.RuleDecision` additionally accepts `hard_review`, and pending requests may carry optional `hardReview: true` and `Guardrail.Risk`. No additional guardrail route is required.

Single-use review grants bind the action, ordered resources, working directory, matched rule IDs, hard-review classification, and canonical request metadata. Operation digests cover the executed payload and target, including subagent launch settings, control action and child, read ranges, question and decision bodies, todo contents, goal status, and skill source or resource identity. MCP digests include the raw server and tool names and forwarded argument values. Object-key order does not change a digest. Changing an operation, mutation content, or argument value cannot consume the original grant. New message and call IDs do not change operation identity. Browser permission identity uses a verified semantic target rather than observation fences; current fences remain mandatory at dispatch. Review events retain fingerprints and redacted payloads, not raw mutation bodies or MCP argument values.

## Notification contract

After a 500 ms pending-review checkpoint, an unresolved guardrail review emits **Guardrail approval needed** for root-family ownership and title. The root system notification is blurred-only and uses the `permission` sound. Resolution before the checkpoint suppresses the episode.

## Security invariants

- Catastrophic direct shell forms are denied before process creation.
- Catastrophic standard denies cannot be overridden by custom policy or any approval reply.
- Recursive deletion of the current project or an ancestor requires hard review after temporary exclusions; graded delegation may only deny or escalate it when model reviews are enabled and `guardrails.decide_hard_reviews` is not false, after any false-positive reclassification; approval of a real match requires a human. Filesystem root, user-home, and system-directory deletion remains denied.
- Decision delegation settles reviews only; it never changes deterministic classification, permissions, or denies.
- Hard reviews cannot be bypassed or model-approved by disabled ordinary guardrails, custom allow rules, reusable approvals, agent or goal automation, `autoGuardrail`, or the YOLO evaluator.
- Raw custom file content and command history are not rendered in the sidebar.
- Invalid enabled policy never silently disables the standard profile.
- `always` approvals are durable, root-family directory approvals that survive restarts and apply in every process sharing the database; they are checked only after fresh evaluation still asks, pass only when every outside target lies under an approved directory, and never settle a hard review.
- Descendants cannot escape root-family policy or counters.
