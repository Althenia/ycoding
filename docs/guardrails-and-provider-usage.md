# Guardrails, subagent permissions, and provider usage

Status: **Implemented**

This document describes the operator-facing configuration and terminal behavior for Session guardrails, subagent shell permissions, and provider quota reporting.

## Agent and subagent permissions

Agent permissions remain an ordered rule list. A later matching rule overrides an earlier matching rule.

The named built-in execution agents (`TLDR`, `architech`, `god`, `yangi`, `occam`, `omoikane`, `wittgenstein`, and `zeus`) explicitly allow `shell` for `*`. This applies to both primary and subagent modes; a later configured rule or inherited parent deny still takes precedence. The read-only `BTW` advisor continues to require approval for shell commands.

Agent definition files are discovered from the global or project YCoding config directories:

- `~/.config/ycoding/agent/**/*.md`
- `~/.config/ycoding/agents/**/*.md`
- `.ycoding/agent/**/*.md`
- `.ycoding/agents/**/*.md`

The repository instruction file `AGENTS.md` is not an agent definition.

Example subagent:

```yaml
---
name: Build helper
description: Runs focused build and test commands
mode: subagent
permissions:
  - action: shell
    resource: "git status*"
    effect: allow
  - action: shell
    resource: "bun test*"
    effect: allow
  - action: shell
    resource: "*"
    effect: ask
---
Run focused implementation and verification tasks.
```

The same fields can be configured in `ycoding.json` or `ycoding.jsonc`:

```jsonc
{
  "agents": {
    "build-helper": {
      "mode": "subagent",
      "permissions": [
        { "action": "shell", "resource": "git status*", "effect": "allow" },
        { "action": "shell", "resource": "bun test*", "effect": "allow" },
        { "action": "shell", "resource": "*", "effect": "ask" }
      ]
    }
  }
}
```

Managed project-artifact agents preserve their stored permission rules. An empty managed-agent permission list resolves to these safe defaults:

| Action | Default |
| --- | --- |
| `read`, `glob`, `grep` | allow |
| `webfetch`, `websearch` | allow |
| `edit`, `write`, `patch`, `shell` | ask |
| `question` | allow |
| `subagent` | deny |
| all other actions | deny |

A child Session also inherits deny rules from its parent permission ceiling. Child configuration cannot widen a parent denial.

Child model requests materialize the same Location-registered tool catalog as primary requests, filtered by the child's ordered permissions and inherited ceiling. Subagents always receive final deny rules for `subagent` and `subagent_control`, so permissive child rules can enable shell and other registered tools without enabling nested orchestration.

## Session guardrails

Permissions decide whether an agent may attempt an action. Guardrails apply independently to the complete root Session family, including direct shell mode, the parent Session, and all descendant subagents.

Guardrail reviews are not auto-approved by `yolo`, `goal`, or the TUI permission auto-approve mode. The terminal shows a distinct **Session guardrail review** with:

- `Allow once`
- `Allow for this session`
- `Deny`

The durable `always` reply, rendered as `Allow for this session`, is not a durable permission grant. It reuses approval only in the current Location-service/process lifetime for the exact root Session family, action, ordered matched rule IDs, ordered resources, and request metadata. Each action is freshly evaluated first; a deny, a changed match, or a non-review result cannot reuse it. `once` is never reusable, and descendants share the root-family key.

### Runtime configuration

```jsonc
{
  "guardrails": {
    "enabled": true,
    "max_concurrent_shells": 8,
    "max_concurrent_subagents": 8,
    "max_pending_reviews": 16
  }
}
```

Defaults are 8 running shells, 8 running subagents, and 16 pending reviews per root Session family. Reservations release after success, failure, cancellation, or interruption.

`guardrails.enabled` configures guardrail-service enablement. Agent permissions and shell sandbox configuration remain independent, and no configuration or approval reply overrides a standard catastrophic deny.

### Standard policy

The code-owned standard profile:

- hard-denies recognized catastrophic host-destruction commands before process creation;
- requires a human review for recognized destructive Git operations, bulk deletion, publishing and deployment, destructive database operations, access-control changes, likely secret transmission, and other high-impact mutation patterns;
- fails closed with a review for mutation actions when an enabled custom guardrail file is malformed;
- evaluates shell, direct Session shell, edit, write, patch, subagent launch, mutation-capable MCP tools, and project-artifact mutation at their side-effect boundary.

The matcher is conservative rather than a complete shell-language interpreter. Approval does not make a denied agent permission valid, and a permission approval does not bypass a guardrail review.

Catastrophic standard denies are unoverrideable. For every other action, the first matching custom source layer decides before standard review or allow behavior. A source layer with enabled invalid configuration reviews mutation actions and retains its place in that ordering.

### Custom guardrails

Custom files are direct Markdown children, not a recursive tree:

```text
<global YCoding config>/guardrails/*.md
<repository Config.Directory>/guardrails/*.md
```

Every discovered repository `Config.Directory` contributes a source layer. The nearest repository directory is evaluated first, then broader repository directories, then the global config directory. The first source layer that matches decides; standard mandatory review and standard allow behavior apply only when no custom layer decides. Within one source layer, rules sort by descending numeric `priority`, then deterministic lexical file path and rule ID.

Each enabled file defines one rule in YAML frontmatter. The Markdown body is operator-facing explanation and is not injected into the model prompt.

```yaml
---
id: protect-production
enabled: true
decision: ask
actions:
  - shell
resources:
  - "kubectl * -n production*"
  - "terraform apply*"
reason: Production infrastructure modification
priority: 100
---
Confirm the target account, cluster, namespace, and proposed change before approving.
```

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable rule identifier. |
| `enabled` | no | Defaults to `true`. A disabled file is ignored. |
| `decision` | yes | `allow`, `ask`, or `deny`. |
| `actions` | yes | Non-empty action pattern list. |
| `resources` | yes | Non-empty resource pattern list. |
| `reason` | yes | Operator-facing reason. |
| `priority` | no | Integer, default `0`; higher values sort first within the same source layer. |

An enabled invalid file is reported in guardrail status. It fails mutation actions closed with a review while preserving the source layer's priority; read-only actions remain available, and a valid matching deny in that layer remains a deny. A valid custom deny cannot weaken a catastrophic standard deny, and neither `once` nor `always` can bypass a deny.

The Session sidebar displays the active profile, custom-rule count, approvals, blocked actions, family counters, and invalid-file count. It does not display raw rule files or command history.

### Guardrail approval notification

The TUI waits 500 ms after a pending guardrail checkpoint. If the review is still pending, it emits **Guardrail approval needed** for the root-family Session ownership/title. The system notification is root-owned and blurred-only, and the `permission` sound plays with normal attention policy. A review resolved before the checkpoint produces no notification episode.

## Provider usage

The provider-usage service is read-only and best effort. A refresh failure never blocks Session startup or model execution. The TUI keeps a previous valid snapshot as `stale` when a later refresh fails.

The `Provider Usage` command appears in the Session command palette when a provider selected by any Session in the current root family has visible quota data, including idle family members, or when local request diagnostics exist. Opening it renders one section per unique selected provider with visible quota data; parallel Sessions using the same provider share one section and do not combine percentages.

```text
Provider Usage
Claude Max  live
Session       #######--- 68% used
All models    ##-------- 24% used
Extra usage   $38.00 left
Codex Pro  app-server
Weekly        ###------- 31% used
Spark weekly  #--------- 7% used
```

Percentage windows show stable ten-character ASCII progress bars, reset times, freshness, and source stability. Claude Pro/Max and ChatGPT Plus/Pro are included in the safe provider label only when the account source reports the tier; YCoding does not infer a tier from missing quota categories. Claude session, all-model, model-specific, and extra-usage windows and Codex weekly, Spark, credit, and additional named windows render only when reported. Percentages below 70% use normal styling, 70–89% use warning styling, and 90% or above use error styling. Unsupported providers are omitted. Unauthorized and failed provider inquiries render `Usage unavailable`.

Unknown values render as `Not reported`; they are never rendered as zero.

For Meta Model API credentials, YCoding sums the USD cost buckets reported for the adapter's current UTC calendar-month query into one **Current bill** row. When current-period cost data is present, the row labels the next UTC month boundary as **Bill due**, following Meta's documented automatic charge on the first of each month. Missing cost data or an unverified billing period leaves the amount or date unreported; YCoding does not estimate either from local Session tokens.

### Sources

| Provider | Source | Stability |
| --- | --- | --- |
| OpenRouter | Current-key API; optional account credits for a management credential | stable provider API |
| OpenAI API | Organization usage and cost endpoints for an explicitly marked admin credential | stable provider API |
| Meta Model API | Organization usage and USD cost buckets for the current-bill and weekly/monthly request and token views | stable provider API |
| Claude subscription | Unified response headers from normal Claude Code requests | observed live state |
| Claude subscription | OAuth usage snapshot for cold start and model-specific buckets | best-effort provider-internal API |
| Codex / Spark | Configured Codex app-server `account/rateLimits/read` | official local client contract |
| Codex / Spark | ChatGPT OAuth backend usage fallback | best-effort provider-internal API |

Provider results are cached by provider and credential identity. Credentials, account email addresses, key fragments, OAuth tokens, and provider response bodies are not returned through Protocol or rendered in the Provider Usage dialog.

### Codex app-server configuration

The local Codex app-server path is optional and takes precedence over the native ChatGPT OAuth fallback when it succeeds.

```jsonc
{
  "provider_usage": {
    "codex_app_server": {
      "command": "/usr/local/bin/codex",
      "args": ["app-server", "--stdio"],
      "cwd": "/workspace",
      "timeout_ms": 5000
    }
  }
}
```

YCoding executes the command directly with the configured argument array; it does not invoke a shell. Request timeouts are bounded between 100 milliseconds and 30 seconds, response buffering is capped at 1 MiB, and the child process is terminated after the snapshot attempt.

The client performs the app-server sequence `initialize`, `initialized`, then `account/rateLimits/read`. Additional returned limit IDs are preserved. Spark and future named lanes render separately instead of being collapsed into the general Codex row.

## Public API

Session guardrails:

```text
GET  /api/session/:sessionID/guardrail
GET  /api/session/:sessionID/guardrail/request
POST /api/session/:sessionID/guardrail/request/:requestID/reply
```

The reply body uses the public union `once | always | reject`. The three routes are unchanged; only the Reply union and its transient `always` semantics are extended.

Provider usage:

```text
GET /api/provider/usage
GET /api/provider/:providerID/usage
```

Provider usage endpoints accept `refresh=true`. They return normalized snapshots; provider authentication or refresh failures are represented by each snapshot's status rather than failing coding Sessions.
