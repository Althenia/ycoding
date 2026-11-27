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

A tool-originated pending request retains its canonical `source: { messageID, callID }` when available. Request origin derives from that source and the native event identity, not prose. Authenticated native/browser replies and existing delegated native policy retain their authority checks. Native Dots decisions bind the exact source, candidate, revision, and live root-family access; prompt text cannot settle them.

Root guardrails YOLO allows the action before classification, without a verifier, grader, review prompt or reusable grant. It bypasses standard catastrophic/hard rules, custom denies/reviews, invalid configuration and prior rejections. Shell and subagent capacity reservations remain enforced. Permissions and answers retain their independent modes; Project coordinator execution restrictions remain outside this bypass.

For Manual and Auto, the decision order is:

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

Current runtime modes dispatch no standard-match verifier: Manual and Auto are model-free, while YOLO bypasses classification. `guardrails.decide_reviews` and `guardrails.decide_hard_reviews` do not convert that bypass into model authority. Historical verifier results remain readable as audit data.

Guardrails YOLO admits every action directly without standard-match verification. Historical dismissal and graded outcomes remain decodable; current YOLO admission neither depends on helper availability nor permits evaluator denial or escalation.

Historical dismissal records identify only the matched standard rule, source and confidence. They do not widen permissions, bypass capacity limits, approve another rule or create reusable approval.

The classifier retains `matchedSegment` and `resolvedTargets` separately. Comments are not shell operands. Printed strings and suggestive names alone do not prove executable behavior. Manual/Auto classification tests exercise these boundaries without relying on model behavior.

Historical public durable `session.guardrail.dismissed.1` carries `{ sessionID, reviewSessionID, ruleID, confidence }`; the root owns the aggregate and `reviewSessionID` identifies the acting Session. Commands/resources remain excluded. Status retains the newest 100 dismissals in oldest-first order. Historical dismissals and model approvals remain audit data, not actionable conversation prompts. Settled model rejections render chronologically only in the reviewed Session at or after its first resident message; live pending requests remain at the family tail.

Regression sources include `rust/crates/core/tests/guardrail_service_decisions.rs` for direct YOLO admission, no evaluator dispatch, independent categories, pending reconciliation, ownership, retained capacities and autonomy withdrawal. Manual/Auto and SQL classification cases remain in that source. `guardrail_provenance_projection.rs` retains historical outcome decoding and status projection; `guardrail_decision.rs` retains strict helper validation at its existing boundary. Schema event-manifest and transcript tests retain payload and replay contracts.

The current runtime evaluates guardrails immediately before supported side effects:

- model-facing shell and direct Session shell;
- edit, write, and patch commits;
- durable subagent creation;
- mutation-capable or process-like MCP execution.

A permission approval cannot bypass a guardrail decision. A guardrail approval cannot widen the agent's effective permission policy.

Recursive deletion denies filesystem root (`standard.catastrophic.rm-root`), the configured home or any exact `/Users/<name>` or `/home/<name>` directory (`standard.catastrophic.rm-user-home`), and system directories under `/System`, `/Library`, `/usr`, `/etc`, `/bin`, `/sbin`, `/opt`, `/Applications`, or `/var` (`standard.catastrophic.rm-system`). Formatting disks, raw block-device writes, and fork bombs remain catastrophic denies.

Standard rules have two review tiers. Hard reviews cover destructive actions: deleting the project root or an ancestor (`standard.review.project-deletion`), deleting a direct child of the configured home (`standard.review.home-child`), destructive Git (`standard.review.git-destructive`: `git reset --hard`, `git clean` with `f` in its first flag group, `git checkout -- .`, `git restore` with `--worktree`, and `git branch` with `D` in its first flag group), force push (`standard.review.force-push`), and destructive database statements (`standard.review.database-destructive`). The database rule matches `DROP DATABASE|SCHEMA|TABLE`, `TRUNCATE TABLE`, and `DELETE FROM` text anywhere in a shell command except where the text is proven inert: inside a read-only command or all-read-only pipeline (the same analysis that exempts read-only commands from outside-repository review), or inside a shell comment. Text in a pipe to any other command, a redirect, a heredoc or here-string, a command substitution, a wrapper, an interpreter, or a command that is not proven read-only stays matched. Ordinary review is the outside-repository sandbox (`standard.review.outside-repo`); nothing inside the repository triggers it. Package publication, production deployment, security-policy changes, and MCP execution have no standard guardrail rule; tool permissions still govern them. Multiple deletion targets inside the repository do not independently trigger a review.

Temporary roots are `/tmp`, `/private/tmp`, `/var/tmp`, `/private/var/tmp`, `/var/folders`, `/private/var/folders`, and the Location process's `TMPDIR` when present, including their descendants. Containment resolves the target and each root through symlinks, using the nearest existing ancestor for a new path; prefix lookalikes, `..` escapes, and symlinks resolving outside every root are not temporary. A temporary deletion target is never a system-directory deletion, while project, ancestor, home, and home-child deletion rules still apply to it. Temporary targets are exempt from outside-repository review only. Custom policy and permission decisions retain their authority.

### Broad-deletion recognition boundary

The standard matcher recognizes direct POSIX `rm` invocations by executable basename, including `/bin/rm`, supported `sudo | command | env | nohup` wrappers, combined or separate short recursive flags, `--recursive`, quoted operands, simple `; | && ||` or newline-separated commands, and a preceding direct `cd`. It expands exact `~`, `$HOME`, `${HOME}`, `$PWD`, `${PWD}`, `$TMPDIR`, and `${TMPDIR}` path forms against the Location's home, workdir, project directory, and process temporary directory. Targets resolve lexically; a target inside a temporary root resolves through symlinks before deletion classification. Supported compound commands retain every reachable working directory; `cd ... &&` establishes relocation only on success. Multiple ordinary operands are allowed by the standard deletion rules.

This is a bounded recognizer, not a complete shell parser or executable sandbox. It does not promise detection of arbitrary aliases, substitutions, generated commands, `sh -c` payloads, `eval`, `find -exec`, `xargs`, or other obfuscation and indirection. Shell sandbox availability and enforcement remain a separate boundary.

### Outside-repository recognition boundary

The repository is the Location's version-control worktree root, or the Location directory when it has no version control, and everything below it. Every checkout of this repository (the main checkout and every Git-listed linked worktree sharing its canonical Git common directory, the same set `LocationMutation` trusts for `external_directory`) and the temporary roots above count as inside.

`file_mutation` (edit, write, and patch commits) targeting a path outside the repository requires ordinary review. A shell command requires ordinary review when its working directory, a `cd` target (a bare `cd` means home), or any operand, redirection target, or `--option=value` path resolves outside the repository. Shell resolution reuses the deletion recognizer's working-directory tracking and `~`, `$HOME`, `$PWD`, `$TMPDIR` expansion. Device paths under `/dev` and the executable position of each command are not targets. Deterministically recognized read-only shell commands are exempt even when they name outside paths, and read-only tools are not guarded; reading outside the repository remains governed by the `external_directory` permission. Like deletion recognition, this is a bounded recognizer: it does not detect paths produced by substitution, `sh -c` payloads, `eval`, `xargs`, `find -exec`, scripts, or programs that write outside the repository without naming the path.

Each category is independent: `manual` waits for a typed decision without a helper call; `auto` applies deterministic rules only; `yolo` removes every blocker in that category. Permissions YOLO immediately allows ask, explicit-decision, deny and ceiling requests with `via: yolo` and `reply: once`, while preserving Project coordinator separation. Guardrails YOLO reserves the action and emits an allow decision immediately, including hard, catastrophic, destructive, custom deny/review, invalid configuration, disabled guardrail configuration and prior rejections; no evaluator or human review can stop it. Answers YOLO settles option, multi-select, free-text, open, explicit-decision, Form and child questions with valid evaluator output or a deterministic valid fallback. Physical external OAuth redirects remain external when no synthetic answer is valid. Auto remains deterministic and model-free: permissions approve asking requests without overriding explicit denies, ceilings or explicit-decision requirements; guardrails approve ordinary standard reviews only while defer is off, never hard or custom-rule reviews; answers use a valid explicit default or exactly one Recommended option. Manual requests wait for a typed decision or, while defer is active, move to the review box. Goals add no permission or guardrail authority.

The root family's guardrails mode is Manual by default, Auto or YOLO; descendants read the root choice. Manual waits for typed review, or defers with reason `disabled` when Defer is on. Auto admits ordinary standard reviews only with Defer off and never hard/custom reviews; it has no model fallback. YOLO allows every guardrail classification without a helper or human decision, including hard/custom reviews and denies. New client YOLO enablement requires explicit risk acceptance; the server setter adds no approval field. Answers follow their independent category ([Session autonomy](./session.md#root-family-defer-and-category-authority)).

An unresolved Manual/Auto review creates a native typed request. With Defer on, it enters the durable review box and the waiting action fails with `Guardrail.DeferredError { requestID, itemID, ruleIDs }` without running. Typed replies retain their native provenance. YOLO admission creates no review, model grade, dismissal or persistent Always grant. Historical graded results remain strict typed `allow`, `deny` or `escalate` records with finite confidence and bounded redacted evidence; unavailable results fabricate no verdict.

Under guardrails YOLO, reserve the action counter exactly once, emit `Guardrail.Event.Decided` with `decision: "allow"` and continue without a pending request. This precedes hard/custom/deny/invalid-configuration and prior-rejection blockers. Changing an effective category to YOLO immediately reconciles its pending requests once across affected family and managed-task descendants. Permission and guardrail waits are allowed once and stale category review items are withdrawn with reason `autonomy`, without replaying actions. Question, Form and child-question waits receive valid automatic answers; deferred answer delivery retains synthetic YOLO provenance rather than fabricating human input.

Explicit escalation publishes durable `session.guardrail.escalated.1` with the reviewed Session, request, canonical tool-call source and any existing bounded assessment fields. Historical choices, confidence and grades remain decodable; current guardrails YOLO performs no assessment or escalation. Never persist commands or targets in provenance events. Entering defer converts pending reviews across family Locations into review-box items and fails their waiting actions with `Guardrail.DeferredError`. Interruption or shutdown ends the waiting action and prompt; restart never replays it.

Historical `session.guardrail.escalated.1` retains reviewed Session/request IDs, available choice/confidence/grades and canonical tool source without raw resources. `Guardrail.DecisionChoice` also decodes historical `approve_all | approve | reject`; `Guardrail.Grade` retains `{ choice, confidence, evidence }`. Defer entry converts unresolved pending reviews across family Locations without losing existing provenance. Interruption or shutdown ends live prompts and actions; restart restores history but no pending action. Mode-change reconciliation admits a matching pending YOLO request once under its owning Session; an unrelated Session cannot settle it. Superseded durable guardrail items receive an `autonomy` withdrawal without replay or grant creation.

## Human review

A review request blocks the guarded operation until the user replies:

- `once` permits that operation attempt;
- `always` permits the attempt and, for an ordinary outside-repository review, records the request's outside directories (a directory target itself, otherwise its parent, including descendants) as a private durable `session.guardrail.approved` event on the root Session; with no outside directories it approves only that attempt;
- `reject` fails the blocked operation.

A Manual/Auto request with `hardReview: true` offers only `once` and `reject`; `always` fails its waiting operation. Auto, active goals, advisory judgments and reusable approvals do not settle hard reviews. Guardrails YOLO bypasses the review entirely rather than manufacturing a model or human approval. Ordinary standard reviews auto-approve under root Auto only with Defer off.

An `always` approval stores outside directories durably on the root family and is shared by descendants across Locations and restarts. Outside guardrails YOLO, Core performs fresh evaluation: denies and hard reviews cannot reuse it, and every outside target must lie within an approved directory. A review without outside directories approves only its attempt. `once` is not reusable. Deterministic ordinary auto-approval requires an awake root family with guardrails `auto`; permissions modes and an active `goal` cannot grant it; guardrails YOLO instead admits actions directly.

Parent Session views may answer reviews created by descendants in the same root family. An unrelated Session receives a not-found response.
The first valid reply atomically claims the pending request. A concurrent or later reply receives a not-found response and cannot change the winning decision or create a reusable approval.

## Counters

Defer-entry conversion isolates each producer kind and Location; one failed conversion does not skip later kinds or descendants. Open reviews remain unfinished with Defer on or off. A committed revert atomically withdraws affected reviews/grants with its removed message range. A category change to YOLO withdraws superseded reviews with reason `autonomy` under inherited-autonomy and review-state commit fences. Every withdrawal retains a replayable System notice.

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
POST /api/session/:sessionID/guardrail/request/:requestID/cancel
POST /api/session/:sessionID/guardrail/request/:requestID/retry
```

`session.guardrail.request.cancel` returns 204 and `session.guardrail.request.retry` returns `{ data: Guardrail.Request }`; both return `GuardrailRequestNotFoundError` (404) when the request is not pending for that root family.

Every pending request this runtime creates carries `created`, the epoch milliseconds of its first ask; `created` is optional on the wire, and a request without it has no reported age. Clients treat a pending request as stale once its age reaches `Guardrail.staleAfterMs` (900 000 ms). A pending hard review expires `guardrails.hard_review_expiry_minutes` after its first ask (default 1440). Cancelling a pending request through `cancel`, or its expiry, closes it fail-closed under the root-family lock: the request leaves the pending list, `guardrail.cancelled` carries `reason: "cancelled"` or `"expired"`, a durable `session.guardrail.decided` records `reply: "reject"` with the same `reason`, the reviewed rule IDs and tool-call source, and the waiting action fails with "Guardrail review was cancelled. This action did not run." or "Guardrail review expired after N minutes without a decision. This action did not run." The pending-review reservation is released. A closed request records no model incident and no explicit rejection, so issuing the same action later opens a new review instead of being refused. Retry re-presents the same pending review. It re-publishes guardrail.asked for the unchanged request (same id, same created) and returns it. It never approves, rejects or settles the review and never runs its command. The review stays pending until a reply, cancel or expiry. Cancel and retry return not found for an unknown, settled, deferred, or other-family request. A `guardrail.cancelled` event without `reason` means the waiting tool call ended. Nothing auto-approves a closed or re-presented review, and guardrails YOLO behavior is unchanged.

Every settlement that removes a pending request publishes `guardrail.replied`, `guardrail.deferred`, or `guardrail.cancelled`, so a client that drops a pending request on those three events never keeps a settled request as waiting.

Guardrail asked, replied, and decided events are ephemeral. Durable Session history owns Session identity and escalation notices. Pending review state is process-local and rehydrates through the request API on client reconnect; backend shutdown ends pending reviews and their waiting actions.

Historical decision-model replies retain their recorded choice, confidence and bounded grades. Durable `session.guardrail.decided` events identify the root and reviewed Sessions, request, reply, matched rule IDs and canonical tool-call source. Pending YOLO settlement records `authority: "yolo"` and a one-time reply without a helper judgment or human attribution. Preserve historical dismissal events, and exclude command text and targets from provenance. Status supplies the newest 100 outcomes and dismissals with their reviewed Session, timestamp and source; a cancelled or expired outcome also carries its `reason`. Pending requests remain process-local and pinned at the family tail.

The Reply body is the public union `once | always | reject`. Public replies retain human attribution and cannot supply helper provenance or settle a model-held request. The internal defer operation defers every human-visible pending request, retaining stored escalation provenance on the item. A failed Session lookup, Location build, or conversion is logged and skipped without aborting other family conversions or defer notices. Deferred items are decided only through `session.review.decide` (see [session](./session.md#root-family-defer-and-review-delegation)); an approval admits one identical re-issued request from the same Session by fingerprint, after classification and deny checks, and is consumed durably. `Guardrail.RuleDecision` additionally accepts `hard_review`, and pending requests may carry optional `hardReview: true` and `Guardrail.Risk`.

Single-use review grants bind the action, ordered resources, working directory, matched rule IDs, hard-review classification, and canonical request metadata. Operation digests cover the executed payload and target, including subagent launch settings, control action and child, read ranges, question and decision bodies, todo contents, goal status, and skill source or resource identity. MCP digests include the raw server and tool names and forwarded argument values. Object-key order does not change a digest. Changing an operation, mutation content, or argument value cannot consume the original grant. New message and call IDs do not change operation identity. Browser permission identity uses a verified semantic target rather than observation fences; current fences remain mandatory at dispatch. Review events retain fingerprints and redacted payloads, not raw mutation bodies or MCP argument values.

## Notification contract

After a 500 ms pending-review checkpoint, an unresolved guardrail review emits **Guardrail approval needed** for root-family ownership and title. The root system notification is blurred-only and uses the `permission` sound. Resolution before the checkpoint suppresses the episode.

## Security invariants

Classification and review invariants below apply to Manual and Auto. Guardrails YOLO explicitly bypasses them while retaining capacity and ownership boundaries; enabling that category requires client risk acceptance.

- Catastrophic direct shell forms are denied before process creation.
- Catastrophic standard denies cannot be overridden by custom policy or any approval reply.
- Recursive deletion of the current project or an ancestor requires hard review after temporary exclusions; approval of a real match requires a human. Filesystem root, user-home, and system-directory deletion remains denied. Manual and Auto dispatch no grader. Historical graded delegation could deny or escalate a hard review, not approve it; those recorded outcomes remain replayable without creating a current grading path.
- Typed review decisions settle reviews only; they never change deterministic classification, permissions, or denies.
- Hard reviews cannot be bypassed by disabled ordinary guardrails, custom allows, reusable approvals, agent/goal automation or Auto. YOLO bypasses them directly, not through an evaluator.
- Raw custom file content and command history are not rendered in the sidebar.
- Invalid enabled policy never silently disables the standard profile.
- `always` approvals are durable, root-family directory approvals that survive restarts and apply in every process sharing the database; they are checked only after fresh evaluation still asks, pass only when every outside target lies under an approved directory, and never settle a hard review.
- Descendants cannot escape root-family policy or counters.
