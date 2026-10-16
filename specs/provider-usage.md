# Provider usage

Provider usage is a read-only Location-scoped service that normalizes quota, credit, and usage information from multiple provider-owned sources for Protocol clients and the dedicated TUI Provider Usage screen.

## Ownership

The local provider-request ledger's closed request-source set is `step`, `title`, `goal`, `compaction`, `decision`, and `prediction`. The on-demand hidden prediction helper records its physical request identity and normalized usage/cost through the existing ledger under `prediction`. These are ordinary accounted helper calls, separate from provider quota snapshots. Prediction uses conversation text, the optional request hint, and requested memory snippets; memory search itself makes no provider request. Partial usage before interruption remains accounted, unavailable prices follow the report's unpriced rules, and prediction output is excluded from durable transcript history. Quota snapshot sources below are a separate contract, not request-source labels.

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
| `response_stream` | `observed` | Recognized quota fields reported in a provider's streamed response body, such as an SSE event. |
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

When configured, YCoding invokes a Codex app-server process directly with an argv array, performs the documented `initialize`, `initialized`, and `account/rateLimits/read` sequence, then terminates the process. Its snapshot is a separate **Codex app-server** source with unknown account attribution, not a stored credential profile's quota.

A stored ChatGPT OAuth credential uses the provider-owned backend usage endpoint independently for that profile. Account routing uses the credential's account ID when present. Profile quota caches distinguish credential identity, account generation, and token generation; provider-local organization hints and response observations cannot cross account identities. A response observation without account provenance remains unbound rather than being assigned to a named profile.

ChatGPT usage resolves its credential through the same expiry-refresh boundary as model requests. Concurrent refreshes share work within the process; a newer, fresh stored OAuth generation for the same credential and account is adopted when another process has rotated the token. Rejected refreshes cannot delete or overwrite newer credentials, and replacement accounts are never adopted. ChatGPT usage failures retain the `provider_internal_api` and `best_effort` labels and do not fall through to organization API usage. A failed refresh preserves a cached quota as stale.

Primary, secondary, credit, reset-credit, and every additional named limit ID are preserved. Known Spark IDs render as Spark; unknown future IDs receive a sanitized display label instead of being discarded.

Codex window labels follow the reported duration rather than assuming `primary` always means five hours or `secondary` always means weekly. This preserves weekly-only Plus/Pro account responses and separately reported Spark weekly windows.

### GitHub Copilot

Copilot uses its existing OAuth credential with no configuration key. Account routing follows the reported `access_type_sku`.

Seats on token-based billing read the organization AI-credit billing summary and expose exactly one window: the monthly quota in AI-credit units, carrying used credits and the monthly reset parsed from the user-status quota reset date. GitHub reports no monthly AI-credit entitlement, so that window has no limit and therefore no progress bar; the limit is never inferred from spend, plan, or catalog prices. A remembered organization is re-discovered when it stops returning AI-credit data.

Other seats keep the legacy entitlement path, whose lanes report a percentage of a reported entitlement and remain raw counts rather than AI credits. Their display labels follow current provider terminology, while the payload keys stay as GitHub reports them.

## Cache and precedence

Successful API snapshots are cached by provider and credential identity. Concurrent refreshes for the same cache key are single-flight. A refresh failure returns a stale copy when one exists.

Observed response data is stored separately by provider and applies only to the provider's default profile. A newer observation takes precedence over that profile's older API snapshot. A forced API refresh does not erase a newer observation.

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

Durable provider-request usage is separate from provider quota and credit snapshots. Core derives one aggregate per Session and provider/model/variant from `session.provider.request.recorded` events, including logical requests, physical attempts, helper calls, continuation/fallback counts, raw token categories, and cost. Each raw provider-request record may carry `cacheReadReported`: `true` means the provider explicitly reported cache-read usage, including an explicit zero; `false` means it did not report cache-read usage; absence is historical unknown. Cache-adaptation folds measure only explicit `true` records and preserve missing or historical telemetry as unmeasured. An optional `timing` object contains always-on provider-reported `promptEvalDurationNs`, `generationDurationNs`, and `loadDurationNs`, plus `generatedTokens` and a reliable `observedGenerationDurationNs` when available. Runpod Ollama supplies provider durations when present; missing timings remain absent. The Session usage summary and diagnostics include only the most recent request's `latestTiming`, never a fabricated sum across requests. Timing fields are excluded from model input.

With enabled machine-wide telemetry consent at record time, `ProviderRequest.Timing` additionally contains non-negative integer milliseconds: optional `firstOutputMs`, `totalMs`, and `retryWaitMs`. The logical request begins when the existing provider-request tracker admits it and includes its physical retries. `firstOutputMs` measures to the first non-empty provider text, reasoning, or tool-input delta, or complete tool call when no incremental tool input is supplied. `totalMs` measures to terminal provider settlement, excluding later local-tool work; a failed request without terminal output measures through completion of its existing recording path. `retryWaitMs` sums elapsed retry backoff waits in that logical request, and is zero when no backoff occurred. A request with no observable output omits `firstOutputMs`. Native structured decision calls have no text/reasoning/tool deltas and therefore omit first-output latency. Title, decision, and compaction requests use the same tracker without introducing additional recording paths. Disabled or undecided consent omits all three latency fields while preserving always-on tokens, cost, and generation timing. These values remain in local SQLite and do not configure or enable the separate OTLP exporter.

```text
GET /api/usage
GET /api/usage/report?group=model|hour|day|month|session|project|agent
GET /api/session/:sessionID/usage
GET /api/session/:sessionID/usage/report?group=model|hour|day|month|session|project|agent
```

The global runtime operations aggregate retained analytics facts exactly once, including requests from deleted Sessions, independent roots, descendants, unrelated projects and Locations, and archived Sessions. They require normal local Server authorization and accept no browser-chosen Location. Recorded costs do not require catalog initialization. Missing prices use the retained pricing reference's Location and model/profile identity; prices resolved from current catalogs remain estimates. Aggregates sum known prices and include cost plus provenance when any contributor is priced; cost remains absent when none is priced. Coverage reports unpriced requests rather than claiming they were free. A filesystem `NotFound` during catalog acquisition preserves retained requests and recorded costs; other acquisition failures propagate unchanged. Closed remote usage operations forward the same normalized values.

The Session operations are Location-scoped and read retained Session-owned records even after transcript compaction or when latest-step diagnostics are unavailable. A root aggregates its retained child-family records, while a child remains scoped to its own records. The aggregate exposes only the bounded latest cache invalidation reason and namespace prefix; it never exposes prompt content, full cache keys, instruction digests, credentials, or raw provider payloads. A priced model row carries `costProvenance`: `recorded` for durable provider cost or `current_catalog` for a query-time estimate.

Both report operations group their scope by model, hour, day, month, Session, project, or agent. Time groups use UTC unless optional `timeZone` names an IANA time zone of at most 128 characters; an unknown zone is an invalid request. With a zone, day and month keys are local dates (`YYYY-MM-DD`, `YYYY-MM`) and hour keys carry the local offset (`YYYY-MM-DDTHH:00:00+HH:MM`), so a repeated daylight-saving hour forms two groups; without one, hour keys are UTC (`YYYY-MM-DDTHH:00:00.000Z`). Optional `from` and `to` epoch-millisecond bounds are UTC instants in every zone, inclusive and exclusive respectively, and must satisfy `from < to`. Optional zero-based `offset` and `limit` page grouped rows; the default limit is 100 and the maximum is 200. Optional `sort` accepts `key`, `tokens`, `cost`, `steps`, `input`, `output`, `reasoning`, `cacheRead`, or `cacheWrite`, and optional `order` accepts `asc` or `desc`; they default to `key` and `asc`. Sorting applies to the complete filtered grouped row set before pagination. Numeric sorts use the ascending row key as a deterministic tie-breaker; absent cost is sorted as zero. `tokens` sorts by the non-overlapping durable total `input + output + reasoning + cache.read + cache.write`; reasoning is excluded from `output`, while cache reads and writes are excluded from `input`. `steps` sorts by logical calls. Time groups sort chronologically; local hour keys sort by the UTC instant they denote, so the earlier occurrence of a repeated hour comes first. Top-level totals and `rowCount` cover every filtered group independently of pagination. Each row and the total expose logical and physical requests, helper, continuation and fallback counts, raw token categories, optional cost with provenance, and whether every contributing request explicitly reported cache-read usage. Reports omit request IDs, routes, cache namespaces, instruction digests, raw provider payloads, and nested model arrays.

Backend/Location analytics use `usage_analytics_request`, one fact per provider request with request-time dimensions and no Session foreign key. Session deletion, retention, fork/revert, and idle cleanup do not delete analytics facts. A startup/hourly sweep reads global-only `analytics_retention.usage_days` (default 30), removing older request-date facts in bounded batches with yields and retaining the exact configured boundary. Scope, groups and measures never come from the Session table or transactional ledger; optional LEFT JOINs provide display labels only. Missing Session titles render `Session <id> · title unreported`. Location-scoped analytics keep requests at their request-time Location after a Session moves.

Session/tree reads use only Session-owned request/usage/file-change/context-exclusion records. These follow Session deletion and idle cleanup under global-only `session_retention.records_days` (default 7), skipping locally executing Sessions and retaining the exact configured boundary. Resuming after cleanup cannot replay provider reasoning/tool state or reconstruct expired captured-change/context-exclusion records from analytics. Choose the source once by scope and share bounded report logic without mixing stores. The additive migration backfills analytics from existing ledger rows with the Session's current historical Location and adds causal anchor columns without backfilling attribution. Global and Session totals describe their own retained scopes, not a complete bill or interchangeable histories. Machine-local latency has separate global-only `analytics_retention.latency_days` (default 30); all three keys are positive integers read at sweep time, ignored in project configuration.

Summary totals and per-model spend rows expose optional `cacheReadReported`, true only when every contributing request explicitly reported cache-read telemetry. False or absent does not establish a reported zero; displays keep it unreported while retaining the raw aggregate counters.

Each grouped row optionally exposes `speed: { firstOutputP50Ms?, firstOutputP95Ms?, totalP50Ms?, totalP95Ms?, outputTokensPerSecond?, generationP50TokensPerSecond?, generationP90TokensPerSecond?, generationSamples, providerTimedSamples, observedSamples, samples }`. Percentiles use exact nearest rank (`ceil(p * count)`, one-based) over the population containing that field; missing latency does not enter it. `samples` counts records containing `firstOutputMs`, including reported zero. Weighted `outputTokensPerSecond` divides summed provider-counted `generatedTokens` by summed valid generation duration in seconds. Tokens/durations must be positive safe integers with a positive finite rate. Provider `generationDurationNs` takes precedence; otherwise `observedGenerationDurationNs` must span at least one second. Historical sub-second observed windows are excluded. No valid population means no rate. These always-on fields do not require telemetry consent. A row without latency or a valid generation population omits `speed`; throughput-only and total-only rows have `samples: 0`. Missing values remain absent, not zero. Totals retain aggregate usage without row-level speed.

## Accounting dimensions and completeness

Reports also support `provider`, `provider-profile-model`, `provider-model`, `model-id`, `profile`, `prompt`, and `task`. Existing `group=model` keys and semantics remain unchanged. New groups expose typed dimensions, not a representative model reference for mixed populations. Profile dimensions are provider-qualified; an absent recorded profile means **provider default at request time**, not the current default account. Variants aggregate by default in the new provider/profile/model dimensions; the variant filter and detail are labeled **selected effort**, not wire-effective effort. A cache namespace is never a model, profile, account, or effort identifier.

Generation statistics use only provider-counted tokens with a valid matching duration. `generationSamples` counts that population; `providerTimedSamples` and `observedSamples` explain its duration coverage. `generationP50TokensPerSecond` and `generationP90TokensPerSecond` are exact nearest-rank percentiles of individual request rates, distinct from duration-weighted `outputTokensPerSecond`. Existing `speed.samples` continues to count first-output latency samples. Received-output estimates (`estimatedTokens` and `estimatedGenerationDurationNs`, displayed with `≈`) enter neither accounting, consumption, cost, quota burn, nor measured percentiles.

Prompt/task cost completeness is `{ total?, known?, pricedRequests, unpricedRequests, provenance? }`. `total` exists only for complete pricing; `known` is the priced subtotal. An explicit measured zero remains zero. Missing prices render **Known $X + unreported** or **unreported**, never a complete zero. Existing report `cost` remains the known-price sum and carries coverage. Current-catalog pricing remains an estimate, not a provider bill. Historical attribution and retained-history gaps independently qualify a result even when every surviving request has a price.

## Prompt and recursive task ownership

A prompt unit begins at one actual user message and ends at the next actual user message in that Session; synthetic and compaction messages do not split it. A child dispatch captures trusted `{ sessionID, inputID }` ownership. Already-dispatched child work continues to accrue to its causing prompt after a newer parent prompt arrives. A later send or answer owns the future child work it causes; already-started requests retain their original anchor. A task lifetime includes both dispatches. Title, goal, decision, compaction, prediction, and prompt-generation helpers count toward their causing prompt and remain separately identifiable in its breakdown. Unsettled contributors label costs **so far**.

Attribution reads retained provider-request rows and preserved input/task facts, never prunable request events. Historical links are reconstructed only when evidence proves them; remaining requests stay explicitly unattributed or partial, with no timestamp guessing, backfill, or historical rewrite. A missing message anchor does not require a foreign key or move its cost onto a newer prompt. Transcript blocks are anchored only to their own resident user units, independent of captured edits.

Session record sweeps delete indexed keyset batches of at most 100 rows per transaction, rechecking the idle cutoff and local execution protection for every batch and yielding between batches and Sessions. Usage deletion atomically advances the Session's permanent `usage_pruned_through` cutoff. Prompts admitted and tasks created at or before any contributing Session's cutoff retain partial history and a known subtotal; increasing the configured retention period preserves that gap. Units beginning after all applicable cutoffs can report complete history. The analytics sweep runs at startup and every following hour.

Recursive task totals include the task Session and its descendants. Inclusive task rows can overlap; adding them does not yield a family total. Grand totals deduplicate physical request identity. Transcript, Usage, and Team use the same scoped accounting reads; context and cache diagnostics remain latest-step observations rather than recursive spend.

## Consumption and quota forecasts

Local consumption is recorded tokens per wall-clock interval, separate from measured generation speed and account quota burn. Local rates use five-minute bins, 5- and 60-minute rates, and a recent-delta EMA with a 15-minute half-life over a one-hour observation horizon. Optional USD/hour is qualified by pricing coverage. Estimates never use received-output token estimates.

Quota forecasts are per provider/account/window in the provider's native units, with source, stability, update time, method, evidence, and an unavailable reason. Recent comparable quota deltas use the same one-hour horizon and 15-minute-half-life EMA. Three distinct observations spanning at least ten minutes with material consumption are required; refresh count is not observation count. Fresh comparable evidence may be `medium`; supported whole-window means or coarse evidence remain `low`; cold, stale, expired, unbound, or incompatible evidence is `insufficient`. Flat usage says **No increase observed**, not unlimited. Only a reported unlimited window is unlimited.

History is bounded and process-local; a restart explicitly warms up. Reset, account generation, unit, limit, or counter corrections break a series. Predictions stop at the next reported reset. A finite balance without a reset can have an exhaustion ETA but no reset projection; rolling replenishment requires supported adapter semantics. Missing limits, periods, reset times, rates, and projections stay absent. Subscription percentages are never converted to tokens. Forecast reads are read-only and best effort; failures cannot block execution. Private account keys, credential IDs, emails, and raw provider payloads never cross the public boundary.

## Bounded accounting reads

Every report, prompt/task lookup, pricing correction, local-rate read, and quota-local-spend read uses one consistent snapshot on `database.reader ?? database.db`. File-backed databases use the reader. Global scans use indexed `(time_created, id)` cursors; scoped scans enumerate selected Sessions and use `(session_id, request)`. Each statement covers at most 10,000 source requests, including timestamp ties and low-selectivity filters; a response limit alone is insufficient. Reads yield between statements, tree pages, pricing chunks, and percentile seeks. Exact percentiles use indexed temporary samples and bounded traversal, not whole-population ranking. Shared-reader transaction ownership is serialized and temporary state is cleaned on success, failure, and cancellation. No full-history request arrays, permanent cost/token rollups, or quota-history table are introduced. Existing retained-history cleanup bounds coverage; a surviving subtotal is not a complete historical bill.

## TUI presentation

- Direct views expose Overview, Usage, Models, Daily, Hourly, Monthly, Sessions, Projects, Stats, Agents, Prompts, and Tasks. Provider/profile/model grouping and selected-effort controls refine reports. Statistics use backend-wide retained usage; the originating Session is only the return-navigation target. Report views support preset or custom UTC ranges, whole-dataset sorting, and 100-row paging with full-scope totals. View, range, filter, and sort changes reset paging. Selection follows row identity across refresh; stale responses cannot replace a newer query or unmounted screen. Details show measured speed populations, token categories and cost coverage. Missing cache-read reporting remains unreported. See [runtime report controls](../docs/runtime.md#telemetry).
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
- Unknown quota window values render as `Not reported`. Unreported steps, reasoning, cache reads, and token totals remain unreported. Report costs are estimates, not provider bills; partial prices show a known subtotal plus unreported coverage, never a complete zero.
- Overview leads with a `Total` row built from the backend summary's own top-level token and cost totals, so it covers every model regardless of the per-model breakdown beneath it. It is not re-summed from the model rows.
- Overview and report tables share header/row column geometry, right-aligned numeric values, and distinct metric colors. Wide layouts allocate remaining width to full model identities before truncating; narrow layouts separate identities and metric details. Selected report rows use the full-width offset surface.
- Overview spend amounts render without a provenance label; `costProvenance` remains available to API consumers and does not claim historical billing.
- Claude Pro/Max and ChatGPT Plus/Pro labels are shown only when reported by the credential or provider account contract; missing tiers are not inferred from quota windows.
- Claude session, all-model, model-specific, and extra-usage windows and Codex weekly, Spark, and additional named windows render only when present in the normalized snapshot.
