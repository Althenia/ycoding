# Guardrails, subagent permissions, and provider usage

Status: **Implemented**

This document describes the operator-facing configuration and terminal behavior for Session guardrails, subagent shell permissions, and provider quota reporting.

## Agent and subagent permissions

Agent permissions remain an ordered rule list. A later matching rule overrides an earlier matching rule.

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

## Session guardrails

Permissions decide whether an agent may attempt an action. Guardrails apply independently to the complete root Session family, including direct shell mode, the parent Session, and all descendant subagents.

Guardrail reviews are not auto-approved by `yolo`, `goal`, or the TUI permission auto-approve mode. The terminal shows a distinct **Session guardrail review** with only:

- `Approve once`
- `Reject`

Standard guardrail reviews do not expose a persistent approval option.

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

Setting `guardrails.enabled` to `false` disables the guardrail layer. Agent permissions and shell sandbox configuration still apply.

### Standard policy

The code-owned standard profile:

- hard-denies recognized catastrophic host-destruction commands before process creation;
- requires a human review for recognized destructive Git operations, bulk deletion, publishing and deployment, destructive database operations, access-control changes, likely secret transmission, and other high-impact mutation patterns;
- fails closed with a review for mutation actions when an enabled custom guardrail file is malformed;
- evaluates shell, direct Session shell, edit, write, patch, subagent launch, mutation-capable MCP tools, and project-artifact mutation at their side-effect boundary.

The matcher is conservative rather than a complete shell-language interpreter. Approval does not make a denied agent permission valid, and a permission approval does not bypass a guardrail review.

### Custom guardrails

Custom files are loaded lexicographically from:

```text
~/.config/ycoding/guardrails/*.md
```

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
| `priority` | no | Integer, default `0`. |

Precedence is: standard catastrophic denies, custom denies, standard mandatory reviews, custom reviews, custom allows, then the standard allow fallback. Within a class, higher priority wins, followed by lexical file path and rule order.

The Session sidebar displays the active profile, custom-rule count, approvals, blocked actions, family counters, and invalid-file count. It does not display raw rule files or command history.

## Provider usage

The provider-usage service is read-only and best effort. A refresh failure never blocks Session startup or model execution. The TUI keeps a previous valid snapshot as `stale` when a later refresh fails.

The `Provider Usage` command appears in the Session command palette only when at least one currently running root or subagent Session uses a provider with a supported usage path. Opening it renders one section per unique active provider; parallel Sessions using the same provider share one section and do not combine percentages.

```text
Provider Usage
Claude  live
5-hour  ███████░░░ 68% used
         resets in 2h 17m
Codex
Usage unavailable
```

Percentage windows show ten-cell progress bars, reset times, freshness, and source stability. Percentages below 70% use normal styling, 70–89% use warning styling, and 90% or above use error styling. Unsupported providers are omitted. Unauthorized and failed provider inquiries render `Usage unavailable`.

Unknown values render as `Not reported`; they are never rendered as zero.

### Sources

| Provider | Source | Stability |
| --- | --- | --- |
| OpenRouter | Current-key API; optional account credits for a management credential | stable provider API |
| OpenAI API | Organization usage and cost endpoints for an explicitly marked admin credential | stable provider API |
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

Provider usage:

```text
GET /api/provider/usage
GET /api/provider/:providerID/usage
```

Provider usage endpoints accept `refresh=true`. They return normalized snapshots; provider authentication or refresh failures are represented by each snapshot's status rather than failing coding Sessions.
