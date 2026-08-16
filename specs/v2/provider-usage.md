# Provider usage

Status: **Implemented**

Provider usage is a read-only Location-scoped service that normalizes quota, credit, and usage information from multiple provider-owned sources for Protocol clients and the TUI Provider Usage command.

## Ownership

- Schema owns normalized snapshot, window, source, stability, and status shapes.
- Core owns credential selection, provider adapters, caching, observation precedence, redaction, and source isolation.
- Protocol and Server expose normalized list/get operations through Location middleware.
- TUI owns active-running-provider selection, command visibility, dialog ordering, progress-bar thresholds, reset formatting, and stale/source labels.

## Snapshot contract

A snapshot includes:

- provider ID and safe display label, including a normalized provider-reported account type when available;
- availability status;
- source and stability classification;
- update time;
- zero or more named windows;
- an optional safe diagnostic message.

A window may include used, limit, remaining, unlimited, reset time, and period length. Unknown values are omitted. Consumers must render an omitted value as unreported rather than as zero.

## Status values

- `available`: a current provider snapshot exists;
- `stale`: refresh failed and an older valid snapshot is retained;
- `unsupported`: the provider or configured credential has no supported usage path;
- `unauthorized`: the usage source rejected the credential;
- `error`: refresh failed and no previous valid snapshot exists.

Provider usage errors never block Session startup or model execution.

## Source and stability

| Source | Stability | Meaning |
| --- | --- | --- |
| `provider_api` | `stable` | Documented provider HTTP API. |
| `local_client_rpc` | `client_contract` | Documented local client/app-server contract. |
| `response_headers` | `observed` | Recognized fields observed on normal provider responses. |
| `provider_internal_api` | `best_effort` | Provider-owned but undocumented account endpoint. |
| `local_session` | source-dependent | Locally accumulated Session evidence. |

Only recognized quota fields are observed. Arbitrary response headers and response bodies are not stored as usage state.

## Provider sources

### OpenRouter

The adapter uses the documented current-key endpoint. A credential explicitly marked for management usage may also read account credits. Key usage, configured limit, remaining allowance, and reported daily, weekly, and monthly values are normalized.

### OpenAI API

Organization usage and cost endpoints are activated only for an API key explicitly marked as an admin usage credential. Ordinary inference keys are not silently treated as organization-admin credentials.

### Claude subscription

Claude Code OAuth accounts use two sources:

1. recognized unified quota response headers from normal Claude requests;
2. the provider-owned OAuth usage snapshot endpoint for cold start, weekly model lanes, and extra-usage values.

Live response observations replace overlapping older OAuth windows. The OAuth usage request retries once after a forced credential refresh on HTTP 401.

### Codex and Spark

When configured, YCoding invokes a Codex app-server process directly with an argv array, performs the documented `initialize`, `initialized`, and `account/rateLimits/read` sequence, then terminates the process. This path has precedence when it succeeds.

Without a usable app-server snapshot, a ChatGPT OAuth credential may use the provider-owned backend usage endpoint as a best-effort fallback. Account routing uses the credential's account ID when present.

Primary, secondary, credit, reset-credit, and every additional named limit ID are preserved. Known Spark IDs render as Spark; unknown future IDs receive a sanitized display label instead of being discarded.

Codex window labels follow the reported duration rather than assuming `primary` always means five hours or `secondary` always means weekly. This preserves weekly-only Plus/Pro account responses and separately reported Spark weekly windows.

## Cache and precedence

Successful API snapshots are cached by provider and credential identity. Concurrent refreshes for the same cache key are single-flight. A refresh failure returns a stale copy when one exists.

Observed response data is stored separately by provider. A newer observation takes precedence over an older API snapshot. A forced API refresh does not erase a newer observation.

No cache key contains a credential secret.

## Optional Codex app-server configuration

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

The command is executed without a shell. Timeout configuration is bounded from 100 milliseconds through 30 seconds. Response buffering is capped at 1 MiB, and the process is closed after success or failure.

## API

```text
GET /api/provider/usage
GET /api/provider/:providerID/usage
```

Both operations accept the Location query. `refresh=true` requests a source refresh. The response contains normalized snapshots only and never exposes credential IDs, access tokens, API keys, refresh tokens, account emails, or raw provider payloads.

## TUI presentation

- The `Provider Usage` command is hidden until a currently running Session in the current root/subagent family has a non-unsupported usage snapshot.
- Provider IDs are deduplicated across parallel running Sessions; account-level percentages are never added or averaged.
- Unsupported providers are omitted. Unauthorized and error snapshots render `Usage unavailable`.
- Spark and other named lanes render as separate windows within their provider section.
- Percent windows use ten stable ASCII characters (`#` used and `-` unused).
- Values below 70% use normal styling, 70–89% warning styling, and 90% or higher error styling.
- Near resets use relative duration; later resets use a concrete local timestamp.
- Unknown values render as `Not reported`.
- Claude Pro/Max and ChatGPT Plus/Pro labels are shown only when reported by the credential or provider account contract; missing tiers are not inferred from quota windows.
- Claude session, all-model, model-specific, and extra-usage windows and Codex weekly, Spark, and additional named windows render only when present in the normalized snapshot.
