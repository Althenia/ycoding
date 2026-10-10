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
3. an unoverrideable standard hard review;
4. a matching custom `hard_review` rule from any source layer;
5. the ordinary decision from the first matching custom source layer: nearest repository `Config.Directory`, then broader repository directories, then global config;
6. standard ordinary review;
7. standard allow fallback.

Within one custom source layer, rules sort by descending numeric priority, then deterministic lexical file path and rule ID. An enabled invalid source layer reviews mutation actions with `configuration.invalid` while preserving that layer's priority. Read-only actions remain available, and a valid matching deny in that layer remains a deny.

`hard_review` is a custom rule decision and is normalized to a review request with `hardReview: true`. A matching hard-review rule overrides ordinary `allow` and `ask` rules across source layers, including a higher-priority ordinary rule in the same layer; an effective deny remains a deny. `guardrails.enabled: false` disables ordinary policy but retains standard catastrophic denies, standard hard reviews, and enabled custom hard-review rules.

## Guarded boundaries

The current runtime evaluates guardrails immediately before supported side effects:

- model-facing shell and direct Session shell;
- edit, write, and patch commits;
- durable subagent creation;
- mutation-capable or process-like MCP execution;
- project-artifact mutation.

A permission approval cannot bypass a guardrail decision. A guardrail approval cannot widen the agent's effective permission policy.

Recursive deletion denies filesystem root (`standard.catastrophic.rm-root`), the configured home or any exact `/Users/<name>` or `/home/<name>` directory (`standard.catastrophic.rm-user-home`), and system directories under `/System`, `/Library`, `/usr`, `/etc`, `/bin`, `/sbin`, `/opt`, `/Applications`, or `/var` (`standard.catastrophic.rm-system`). Formatting disks, raw block-device writes, and fork bombs remain catastrophic denies.

Deleting the project root or an ancestor requires hard review (`standard.review.project-deletion`). Deleting a direct child of the configured home requires ordinary review (`standard.review.home-child`). Multiple ordinary deletion targets do not independently trigger a review. Git-destructive, force-push, publish, production, database-destructive, security-mutation, and MCP-execute rules require ordinary review.

Temporary roots are excluded before every standard deletion classification: `/tmp`, `/private/tmp`, `/var/tmp`, `/private/var/tmp`, `/var/folders`, and the Location process's `TMPDIR` when present, including their descendants. The exclusion takes precedence even when a temporary target contains the project or is a home child. A mixed command evaluates only its non-temporary deletion targets. Custom policy and permission decisions retain their authority.

### Broad-deletion recognition boundary

The standard matcher recognizes direct POSIX `rm` invocations by executable basename, including `/bin/rm`, supported `sudo | command | env | nohup` wrappers, combined or separate short recursive flags, `--recursive`, quoted operands, simple `; | && ||` or newline-separated commands, and a preceding direct `cd`. It expands exact `~`, `$HOME`, `${HOME}`, `$PWD`, `${PWD}`, `$TMPDIR`, and `${TMPDIR}` path forms against the Location's home, workdir, project directory, and process temporary directory. Targets resolve lexically before temporary exclusions and deletion classification. Supported compound commands retain every reachable working directory; `cd ... &&` establishes relocation only on success. Multiple ordinary operands are allowed by the standard deletion rules.

This is a bounded recognizer, not a complete shell parser or executable sandbox. It does not promise detection of arbitrary aliases, substitutions, generated commands, `sh -c` payloads, `eval`, `find -exec`, `xargs`, or other obfuscation and indirection. Shell sandbox availability and enforcement remain a separate boundary.

### Risk classification

Deterministically recognized read-only shell commands skip classification and remain allow after deterministic rules; the recognizer is conservative, so unrecognized commands still classify.

Only deterministic `allow` results enter an explicitly configured `decisions.guardrails` classifier. One score question uses these zero-based levels:

| Level | Label | Meaning |
| --- | --- | --- |
| 0 | none | No state change or trivially reversible |
| 1 | minor | Local reversible change |
| 2 | recoverable | Data loss recoverable from VCS/backup/cache |
| 3 | irreversible | Irreversible data loss or external side effect |
| 4 | destructive | Destroys system, accounts, or shared infrastructure |

Agent judgments return an integer level and uncalibrated model confidence. Native score distributions select the unique highest-probability integer level and its native probability; ties are uncertain. Confidence must meet `min_confidence`, or native probability must meet `min_probability`, inclusively. `allow_below` is an integer from 0 through 4, default 2. A confident level below both `allow_below` and 3 preserves allow. Confident levels 3–4 always escalate to ordinary ask with `semantic.review.risk`; all other levels, uncertainty, refusals, and decision errors also ask unless the low-risk allow condition holds. Classification never denies, creates hard review, downgrades deterministic asks or denies, or grants human authorization.

Evidence contains only sanitized `{ action, resources, metadata }`. Temporary path resources and recognized temporary deletion operands are excluded; a deletion operand is excluded only when temporary in every reachable working directory. With no remaining resources, no classifier request is sent. Disabled ordinary guardrails and `skipReview` skip classification.

Usable judgments add optional `risk: { level, label, score, metric }` to the review request and `guardrail.asked` event. `metric` is `confidence` or `probability`. The reason surfaces `Risk: irreversible (3) · model confidence 0.84, uncalibrated` or `Risk: irreversible (3) · native probability 0.91`. Missing or unusable judgments omit `risk`. Ordinary review keeps exact Always reuse and effective YOLO 1-3 auto-approval; hard reviews remain human-only.

## Human review

A review request blocks the guarded operation until the user replies:

- `once` permits that operation attempt;
- `always` permits the attempt and records a transient reusable approval;
- `reject` fails the blocked operation.

A request with `hardReview: true` advertises only `once` and `reject`. It cannot use a transient `always` approval, and a direct `always` reply fails the waiting operation rather than approving it. Hard reviews are never auto-approved by YOLO 0-3, active goals, agent automation, permission auto-answering, or any reusable approval. Ordinary reviews auto-approve at effective YOLO 1-3.

An `always` approval is keyed by root Session family, action, ordered matched rule IDs, ordered resources, and request metadata. It is held only by the Location service in process memory, is cleared at service shutdown, is not durable or global, and is shared by descendants of the same root. Core always performs a fresh evaluation before consulting the key: a deny, changed match, or non-review result cannot reuse an approval. `once` is not reusable. Ordinary review auto-approval requires effective `yolo 1-3`; active `goal` or permission auto-approval alone cannot grant it.

Parent Session views may answer reviews created by descendants in the same root family. An unrelated Session receives a not-found response.
The first valid reply atomically claims the pending request. A concurrent or later reply receives a not-found response and cannot change the winning decision or create a reusable approval.

## Counters

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

Guardrail asked, replied, and decided events are ephemeral. Durable Session history remains the authority for Session ownership; guardrail review state is process-local and rehydrated from the canonical request API after reconnect or restart.

The Reply body is the public union `once | always | reject`. `Guardrail.RuleDecision` additionally accepts `hard_review`, and pending requests may carry optional `hardReview: true` and `Guardrail.Risk`. No additional guardrail route is required.

## Notification contract

After a 500 ms pending-review checkpoint, an unresolved guardrail review emits **Guardrail approval needed** for root-family ownership and title. The root system notification is blurred-only and uses the `permission` sound. Resolution before the checkpoint suppresses the episode.

## Security invariants

- Catastrophic direct shell forms are denied before process creation.
- Catastrophic standard denies cannot be overridden by custom policy or any approval reply.
- Recursive deletion of the current project or an ancestor requires human-only hard review after temporary exclusions; filesystem root, user-home, and system-directory deletion remains denied.
- Semantic risk classification can only preserve deterministic allow or escalate it to ordinary ask; deterministic denies and hard reviews never consult the classifier.
- Hard reviews cannot be bypassed by disabled ordinary guardrails, custom allow rules, reusable approvals, agent or goal automation, or YOLO 3.
- Raw custom file content and command history are not rendered in the sidebar.
- Invalid enabled policy never silently disables the standard profile.
- `always` approvals are exact-match, root-family, Location-service/process-memory state and are checked only after fresh evaluation still asks.
- Descendants cannot escape root-family policy or counters.
