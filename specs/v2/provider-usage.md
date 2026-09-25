# Provider usage

Provider usage is a read-only Location-scoped service that normalizes quota, credit, and usage information from multiple provider-owned sources for Protocol clients and the dedicated TUI Provider Usage screen.

## Ownership

- Schema owns normalized snapshot, window, source, stability, and status shapes.
- Core owns catalog-based provider discovery, credential selection, provider adapters, caching, observation precedence, redaction, and source isolation.
- Protocol and Server expose normalized list/get operations through Location middleware.
- TUI owns screen navigation, progress-bar thresholds, reset formatting, and stale/source labels. It renders the connected-provider list independently of Session/model selection. The Session footer's usage action and `<leader>Shift+U` open the screen; `<leader>u` remains Undo. Escape returns with the Session draft intact.

## Snapshot contract

A snapshot includes:

- provider ID and safe display label, including a normalized provider-reported account type when available;
- the stored credential profile name, present only when the provider has more than one stored profile;
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

### GitHub Copilot

Copilot uses its existing OAuth credential with no configuration key. Account routing follows the reported `access_type_sku`.

Seats on token-based billing read the organization AI-credit billing summary and expose exactly one window: the monthly quota in AI-credit units, carrying used credits and the monthly reset parsed from the user-status quota reset date. GitHub reports no monthly AI-credit entitlement, so that window has no limit and therefore no progress bar; the limit is never inferred from spend, plan, or catalog prices. A remembered organization is re-discovered when it stops returning AI-credit data.

Other seats keep the legacy entitlement path, whose lanes report a percentage of a reported entitlement and remain raw counts rather than AI credits. Their display labels follow current provider terminology, while the payload keys stay as GitHub reports them.

## Cache and precedence

Successful API snapshots are cached by provider and credential identity. Concurrent refreshes for the same cache key are single-flight. A refresh failure returns a stale copy when one exists.

Observed response data is stored separately by provider and applies only to the provider's active profile. A newer observation takes precedence over that profile's older API snapshot. A forced API refresh does not erase a newer observation.

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

The list uses `Catalog.provider.available()` to enumerate each available configured provider, respecting disabled providers and provider policy. A provider with a quota adapter and several stored credential profiles returns one snapshot per profile; any other provider returns one snapshot, using its active profile when one exists. The list includes connected providers with no selected Session and providers without a quota adapter or usable credential; the latter return explicit `unsupported` snapshots. Independent refreshes run with concurrency bounded to four and preserve successful snapshots alongside per-provider failures. Results are ordered by provider ID, then profile name. `GET /api/provider/:providerID/usage` returns the active profile's snapshot.

## Durable provider-request usage

Durable provider-request usage is separate from provider quota and credit snapshots. Core derives one aggregate per Session and provider/model/variant from `session.provider.request.recorded` events, including logical requests, physical attempts, helper calls, continuation/fallback counts, raw token categories, and cost. Each raw provider-request record may carry `cacheReadReported`: `true` means the provider explicitly reported cache-read usage, including an explicit zero; `false` means it did not report cache-read usage; absence is historical unknown. Cache-adaptation folds measure only explicit `true` records and preserve missing or historical telemetry as unmeasured. An optional `timing` object contains provider-reported prompt evaluation, generation, and model-load durations in nanoseconds. Runpod Ollama supplies these fields when present; missing timings remain absent. The Session usage summary and diagnostics include only the most recent request's `latestTiming`, never a fabricated sum across requests. Timings are excluded from model input and grouped usage reports.

```text
GET /api/usage
GET /api/usage/report?group=model|hour|day|month|session|project|agent
GET /api/session/:sessionID/usage
GET /api/session/:sessionID/usage/report?group=model|hour|day|month|session|project|agent
```

The local-runtime operations aggregate retained projections across every stored Session exactly once, including independent roots, descendants, unrelated projects and Locations, and archived Sessions. They require the normal local Server authorization and are not part of the closed remote shared-Session transport. They accept no Session or Location selector. Sessions whose requests all have recorded costs do not initialize a Location or catalog. Missing historical costs resolve through the Session's own Location, first against that Location's provider catalog and then its current OpenRouter master catalog for the same model and variant. If neither available catalog prices a request, the affected costs are absent rather than zero. A filesystem `NotFound` during catalog acquisition preserves the original request rows, including their recorded costs, rather than failing the whole report; other acquisition failures propagate unchanged. Request and token totals remain factual even when cost totals cannot be reported.

The Session operations remain the scoped contract. They are Location-scoped and return usage even after transcript compaction or when latest-step diagnostics are unavailable. A root Session aggregates its complete child family, while a child Session remains scoped to its own records. The aggregate exposes only the bounded latest cache invalidation reason and namespace prefix; it never exposes prompt content, full cache keys, instruction digests, credentials, or raw provider payloads. A priced model row carries `costProvenance`: `recorded` for durable provider cost or `current_catalog` for a query-time estimate.

Both report operations group their scope by model, UTC hour, UTC day, UTC month, Session, project, or agent. Optional `from` and `to` epoch-millisecond bounds are inclusive and exclusive respectively and must satisfy `from < to`. Optional zero-based `offset` and `limit` page grouped rows; the default limit is 100 and the maximum is 200. Optional `sort` accepts `key`, `tokens`, or `cost`, and optional `order` accepts `asc` or `desc`; they default to `key` and `asc`. Sorting applies to the complete filtered grouped row set before pagination. Equal token and cost values use the ascending row key as a deterministic tie-breaker, and rows without cost remain last in either cost order. Token sorting uses the non-overlapping durable total `input + output + reasoning + cache.read + cache.write`; reasoning is excluded from `output`, while cache reads and writes are excluded from `input`. Time groups sort chronologically through their UTC key. Top-level totals and `rowCount` cover every filtered group independently of pagination. Each row and the total expose logical and physical requests, helper, continuation and fallback counts, raw token categories, optional cost with provenance, and whether every contributing request explicitly reported cache-read usage. Reports omit request IDs, routes, cache namespaces, instruction digests, raw provider payloads, and nested model arrays.

Raw request projections and aggregates are retained for current, recently updated, and locally active Sessions. A startup and hourly cleanup removes only those derived projections when a Session has been inactive for more than 30 days. Durable events and transcript rows are never pruned by usage cleanup. Global summary and report totals cover the retained projections available at query time; they do not claim complete historical or billing coverage after cleanup.

Summary totals and per-model spend rows expose optional `cacheReadReported`, true only when every contributing request explicitly reported cache-read telemetry. False or absent does not establish a reported zero; displays keep it unreported while retaining the raw aggregate counters.

## TUI presentation

- Ten direct views expose Overview, Usage, Models, Daily, Hourly, Monthly, Sessions, Projects, Stats, and Agents. Statistics use the backend-wide summary and report operations across all retained Sessions; the originating Session is only the return-navigation target. Report views support preset or custom UTC date ranges, recorded activity counters, whole-dataset sorting, and 100-row paging with full-scope totals. View, range, and sort changes reset paging. Selection follows row identity across refresh; stale responses cannot replace a newer query or an unmounted screen. Report cost details distinguish recorded values from current-catalog estimates. Missing cache-read reporting remains unreported. See [runtime report controls](../../docs/runtime.md#telemetry) for keyboard and display behavior.
- Stats displays a 52-week Sunday-aligned UTC calendar using retained daily reports. Future cells are blank. Missing retained days do not prove inactivity, and coverage remains explicitly unknown after retention cleanup.
- The Session footer's usage action and `<leader>Shift+U` open the dedicated Usage screen; `<leader>u` remains Undo. Usage is not a command-palette item. Escape or back returns without submitting or discarding the Session draft.
- Navigation labels occupy equally sized, padded, clickable cells separated by vertical rules. Narrow terminals retain the active view in a bounded navigation window. Overview and quota content show a theme-colored vertical scrollbar only when needed; no horizontal scrollbar occupies the space above the footer.
- Snapshots are deduplicated by provider ID and profile, retaining the newest snapshot by update time; each profile renders as its own section named `label · profile`, and account-level percentages are never added or averaged.
- `unsupported` snapshots, including providers without a usable credential, are hidden. Unauthorized and error snapshots retain their status and safe message. Providers with no reported windows remain visible without fabricated values. A failed refresh retains a previous snapshot as stale and shows a partial-refresh warning.
- Spark and other named lanes render as separate windows within their provider section.
- A window renders a ten-cell progress bar (`█` used and `░` unused) only when a ratio is derivable: a `percent` window reporting `used`, or any window reporting both `used` and a positive `limit`. Windows with no denominator, and `unlimited` windows, render their value as text, subject to the explicit OpenRouter rule below.
- OpenRouter `daily`, `weekly`, and `monthly` windows report spend without a limit of their own and borrow the same snapshot's `key` USD limit as their denominator. The borrow is scoped to OpenRouter windows within one snapshot and never crosses providers or snapshots. When the key reports no limit, those windows stay text.
- Bar values below 70% use normal styling, 70–89% warning styling, and 90% or higher error styling.
- Each window renders its own reset beside its value, so Codex 5-hour, weekly, and Spark lanes, and Claude session and weekly lanes, each show a distinct reset. There is no aggregated reset row. Near resets use relative duration, later resets use a concrete local timestamp, and a window with no reported reset shows none.
- Unknown quota window values render as `Not reported`. Unreported steps, reasoning, cache reads, token totals, and report costs render as `-`.
- Overview leads with a `Total` row built from the backend summary's own top-level token and cost totals, so it covers every model regardless of the per-model breakdown beneath it. It is not re-summed from the model rows.
- Overview and report tables share header/row column geometry, right-aligned numeric values, and distinct metric colors. Wide layouts allocate remaining width to full model identities before truncating; narrow layouts separate identities and metric details. Selected report rows use the full-width offset surface.
- Overview spend amounts render without a provenance label; `costProvenance` remains available to API consumers and does not claim historical billing.
- Claude Pro/Max and ChatGPT Plus/Pro labels are shown only when reported by the credential or provider account contract; missing tiers are not inferred from quota windows.
- Claude session, all-model, model-specific, and extra-usage windows and Codex weekly, Spark, and additional named windows render only when present in the normalized snapshot.
