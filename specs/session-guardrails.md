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

Guardrails YOLO admits every action directly without standard-match verification. Historical dismissal and graded outcomes remain decodable; current YOLO admission neither depends on helper availability nor permits evaluator denial or escalation.

Reevaluate excluding only dismissed standard rule IDs. Verify additional standard matches and preserve independently matched custom policy. Dismissal never widens permissions, bypasses caps, approves another rule, or creates reusable approval. Surviving hard matches use graded delegation unless `guardrails.decide_hard_reviews` is false; false also skips verification of hard matches. Cancellation during verification owns no pending request or review slot.

Supply the classifier's `matchedSegment` and `resolvedTargets` as separate structured fields under `untrustedEvidence.classifier`. Comments are not shell operands. Statements, comments, quoted or printed strings, and suggestive names are not proof of a non-match: evaluate executable shell semantics. Unit tests establish the request framing and structured evidence, not a model's behavioral resistance to adversarial evidence.

Publish public durable `session.guardrail.dismissed.1` with `{ sessionID, reviewSessionID, ruleID, confidence }`; `sessionID` owns the root-family aggregate and `reviewSessionID` identifies the action's Session. Never store command/resource evidence in it. Status adds optional `dismissals: [{ eventID, sessionID, created, ruleID, confidence }]`, with the reviewed Session and event-envelope timestamp, oldest-first among the newest 100 dismissals. Dismissals and decision-model approvals are status audit data and never render in the TUI or web conversation; settled decision-model rejections render chronologically only in the reviewed Session's view at or after its first resident chat message, and only still-pending family requests remain pinned at the tail.

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

Temporary roots are `/tmp`, `/private/tmp`, `/var/tmp`, `/private/var/tmp`, `/var/folders`, `/private/var/folders`, and the Location process's `TMPDIR` when present, including their descendants. Containment resolves the target and each root through symlinks, using the nearest existing ancestor for a new path; prefix lookalikes, `..` escapes, and symlinks resolving outside every root are not temporary. A temporary deletion target is never a system-directory deletion, while project, ancestor, home, and home-child deletion rules still apply to it. Temporary targets are exempt from outside-repository review only. Custom policy and permission decisions retain their authority.

### Broad-deletion recognition boundary

The standard matcher recognizes direct POSIX `rm` invocations by executable basename, including `/bin/rm`, supported `sudo | command | env | nohup` wrappers, combined or separate short recursive flags, `--recursive`, quoted operands, simple `; | && ||` or newline-separated commands, and a preceding direct `cd`. It expands exact `~`, `$HOME`, `${HOME}`, `$PWD`, `${PWD}`, `$TMPDIR`, and `${TMPDIR}` path forms against the Location's home, workdir, project directory, and process temporary directory. Targets resolve lexically; a target inside a temporary root resolves through symlinks before deletion classification. Supported compound commands retain every reachable working directory; `cd ... &&` establishes relocation only on success. Multiple ordinary operands are allowed by the standard deletion rules.

This is a bounded recognizer, not a complete shell parser or executable sandbox. It does not promise detection of arbitrary aliases, substitutions, generated commands, `sh -c` payloads, `eval`, `find -exec`, `xargs`, or other obfuscation and indirection. Shell sandbox availability and enforcement remain a separate boundary.

### Outside-repository recognition boundary

The repository is the Location's version-control worktree root, or the Location directory when it has no version control, and everything below it. Every checkout of this repository (the main checkout and every Git-listed linked worktree sharing its canonical Git common directory, the same set `LocationMutation` trusts for `external_directory`) and the temporary roots above count as inside.

`file_mutation` (edit, write, and patch commits) targeting a path outside the repository requires ordinary review. A shell command requires ordinary review when its working directory, a `cd` target (a bare `cd` means home), or any operand, redirection target, or `--option=value` path resolves outside the repository. Shell resolution reuses the deletion recognizer's working-directory tracking and `~`, `$HOME`, `$PWD`, `$TMPDIR` expansion. Device paths under `/dev` and the executable position of each command are not targets. Deterministically recognized read-only shell commands are exempt even when they name outside paths, and read-only tools are not guarded; reading outside the repository remains governed by the `external_directory` permission. Like deletion recognition, this is a bounded recognizer: it does not detect paths produced by substitution, `sh -c` payloads, `eval`, `xargs`, `find -exec`, scripts, or programs that write outside the repository without naming the path.

Each category is independent: `manual` waits for a typed decision without a helper call; `auto` applies deterministic rules only; `yolo` removes every blocker in that category. Permissions YOLO immediately allows ask, explicit-decision, deny and ceiling requests with `via: yolo` and `reply: once`, while preserving Project coordinator separation. Guardrails YOLO reserves the action and emits an allow decision immediately, including hard, catastrophic, destructive, custom deny/review, invalid configuration, disabled guardrail configuration and prior rejections; no evaluator or human review can stop it. Answers YOLO settles option, multi-select, free-text, open, explicit-decision, Form and child questions with valid evaluator output or a deterministic valid fallback. Physical external OAuth redirects remain external when no synthetic answer is valid. Auto remains deterministic and model-free: permissions approve asking requests without overriding explicit denies, ceilings or explicit-decision requirements; guardrails approve ordinary standard reviews only while defer is off, never hard or custom-rule reviews; answers use a valid explicit default or exactly one Recommended option. Manual requests wait for a typed decision or, while defer is active, move to the review box. Goals add no permission or guardrail authority.

Under guardrails YOLO, reserve the action counter exactly once, emit `Guardrail.Event.Decided` with `decision: "allow"` and continue without a pending request. This precedes hard/custom/deny/invalid-configuration and prior-rejection blockers. Changing an effective category to YOLO immediately reconciles its pending requests once across affected family and managed-task descendants. Permission and guardrail waits are allowed once and stale category review items are withdrawn with reason `autonomy`, without replaying actions. Question, Form and child-question waits receive valid automatic answers; deferred answer delivery retains synthetic YOLO provenance rather than fabricating human input.

Explicit escalation publishes durable `session.guardrail.escalated.1` with the reviewed Session, request, canonical tool-call source and any existing bounded assessment fields. Historical choices, confidence and grades remain decodable; current guardrails YOLO performs no assessment or escalation. Never persist commands or targets in provenance events. Entering defer converts pending reviews across family Locations into review-box items and fails their waiting actions with `Guardrail.DeferredError`. Interruption or shutdown ends the waiting action and prompt; restart never replays it.

## Human review

A review request blocks the guarded operation until the user replies:

- `once` permits that operation attempt;
- `always` permits the attempt and, for an ordinary outside-repository review, records the request's outside directories (a directory target itself, otherwise its parent, including descendants) as a private durable `session.guardrail.approved` event on the root Session; with no outside directories it approves only that attempt;
- `reject` fails the blocked operation.

Outside guardrails YOLO, `hardReview: true` exposes only `once` and `reject`; `always` fails. Guardrails YOLO admits the same action immediately without a human request, including disabled-guardrail hard fallbacks.

An `always` approval stores outside directories durably on the root family and is shared by descendants across Locations and restarts. Outside guardrails YOLO, Core performs fresh evaluation: denies and hard reviews cannot reuse it, and every outside target must lie within an approved directory. A review without outside directories approves only its attempt. `once` is not reusable. Deterministic ordinary auto-approval requires an awake root family with guardrails `auto`; permissions modes and an active `goal` cannot grant it; guardrails YOLO instead admits actions directly.

Parent Session views may answer reviews created by descendants in the same root family. An unrelated Session receives a not-found response.
The first valid reply atomically claims the pending request. A concurrent or later reply receives a not-found response and cannot change the winning decision or create a reusable approval.

## Counters

Defer-entry conversion isolates each producer kind and family Location. A failed conversion is logged; later producer kinds and descendants continue. Open review-box items remain unfinished work after waking. A committed revert withdraws affected guardrail reviews and unconsumed grants atomically with the removed message range, and projects a replayable System notice from each withdrawal fact.

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

Historical decision-model replies retain their recorded choice, confidence and bounded grades. Durable `session.guardrail.decided` events identify the root and reviewed Sessions, request, reply, matched rule IDs and canonical tool-call source. Pending YOLO settlement records `authority: "yolo"` and a one-time reply without a helper judgment or human attribution. Preserve historical dismissal events, and exclude command text and targets from provenance. Status supplies the newest 100 outcomes and dismissals with their reviewed Session, timestamp and source. Pending requests remain process-local and pinned at the family tail.

The Reply body is the public union `once | always | reject`. Public replies retain human attribution and cannot supply helper provenance or settle a model-held request. The internal defer operation defers every human-visible pending request, retaining stored escalation provenance on the item. A failed Session lookup, Location build, or conversion is logged and skipped without aborting other family conversions or defer notices. Deferred items are decided only through `session.review.decide` (see [session](./session.md#root-family-defer-and-review-delegation)); an approval admits one identical re-issued request from the same Session by fingerprint, after classification and deny checks, and is consumed durably. `Guardrail.RuleDecision` additionally accepts `hard_review`, and pending requests may carry optional `hardReview: true` and `Guardrail.Risk`. No additional guardrail route is required.

Single-use review grants bind the action, ordered resources, working directory, matched rule IDs, hard-review classification, and canonical request metadata. Operation digests cover the executed payload and target, including subagent launch settings, control action and child, read ranges, question and decision bodies, todo contents, goal status, and skill source or resource identity. MCP digests include the raw server and tool names and forwarded argument values. Object-key order does not change a digest. Changing an operation, mutation content, or argument value cannot consume the original grant. New message and call IDs do not change operation identity. Browser permission identity uses a verified semantic target rather than observation fences; current fences remain mandatory at dispatch. Review events retain fingerprints and redacted payloads, not raw mutation bodies or MCP argument values.

## Notification contract

After a 500 ms pending-review checkpoint, an unresolved guardrail review emits **Guardrail approval needed** for root-family ownership and title. The root system notification is blurred-only and uses the `permission` sound. Resolution before the checkpoint suppresses the episode.

## Security invariants

- Catastrophic direct shell forms are denied before process creation.
- Catastrophic standard denies cannot be overridden by custom policy or any approval reply.
- Recursive deletion of the current project or an ancestor requires hard review after temporary exclusions; graded delegation may only deny or escalate it when model reviews are enabled and `guardrails.decide_hard_reviews` is not false, after any false-positive reclassification; approval of a real match requires a human. Filesystem root, user-home, and system-directory deletion remains denied.
- Decision delegation settles reviews only; it never changes deterministic classification, permissions, or denies.
- Guardrails YOLO allows hard, catastrophic, destructive and custom-rule actions without a helper or human review. Outside YOLO, hard reviews retain typed approval requirements.
- Raw custom file content and command history are not rendered in the sidebar.
- Invalid enabled policy never silently disables the standard profile.
- `always` approvals are durable, root-family directory approvals that survive restarts and apply in every process sharing the database; they are checked only after fresh evaluation still asks, pass only when every outside target lies under an approved directory, and never settle a hard review.
- Descendants cannot escape root-family policy or counters.
