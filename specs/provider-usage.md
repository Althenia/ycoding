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

A window may include a group name, used, limit, remaining, unlimited, reset time, and period length. Consecutive windows that share a group name render under one group heading; windows without a group render as ungrouped. Unknown values are omitted. Consumers must render an omitted value as unreported rather than as zero.

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

Durable provider-request usage is separate from provider quota and credit snapshots. Core derives one aggregate per Session and provider/model/variant from `session.provider.request.recorded` events, including logical requests, physical attempts, helper calls, continuation/fallback counts, raw token categories, and cost. Each raw provider-request record may carry `cacheReadReported`: `true` means the provider explicitly reported cache-read usage, including an explicit zero; `false` means it did not report cache-read usage; absence is historical unknown. Cache-adaptation folds measure only explicit `true` records and preserve missing or historical telemetry as unmeasured. An optional `timing` object contains always-on provider-reported `promptEvalDurationNs`, `generationDurationNs`, and `loadDurationNs`, plus `generatedTokens` and a reliable `observedGenerationDurationNs` when available. It may also carry `receivedOutput: { estimatedTokens, durationNs }`, both positive integers, for Session display only. Existing optional timing fields remain readable and their provider-report population is unchanged. Runpod Ollama supplies provider durations when present; missing timings remain absent. The Session usage summary and diagnostics include only the most recent request's `latestTiming`, never a fabricated sum across requests. Timing fields are excluded from model input.

With enabled machine-wide telemetry consent at record time, `ProviderRequest.Timing` additionally contains non-negative integer milliseconds: optional `firstOutputMs`, `totalMs`, and `retryWaitMs`. The logical request begins when the existing provider-request tracker admits it and includes its physical retries. `firstOutputMs` measures to the first non-empty provider text, reasoning, or tool-input delta, or complete tool call when no incremental tool input is supplied. `totalMs` measures to terminal provider settlement, excluding later local-tool work; a failed request without terminal output measures through completion of its existing recording path. `retryWaitMs` sums elapsed retry backoff waits in that logical request, and is zero when no backoff occurred. A request with no observable output omits `firstOutputMs`. Native structured decision calls have no text/reasoning/tool deltas and therefore omit first-output latency. Title, decision, and compaction requests use the same tracker without introducing additional recording paths. Disabled or undecided consent omits all three latency fields while preserving always-on tokens, cost, and generation timing. These values remain in local SQLite and do not configure or enable the separate OTLP exporter.

```text
GET /api/usage
GET /api/usage/report?group=model|hour|day|month|session|project|agent
POST /api/usage/dashboard
GET /api/session/:sessionID/usage
GET /api/session/:sessionID/usage/report?group=model|hour|day|month|session|project|agent
```

The global runtime operations aggregate retained analytics facts exactly once, including requests from deleted Sessions, independent roots, descendants, unrelated projects and Locations, and archived Sessions. They require normal local Server authorization and accept no browser-chosen Location. Recorded costs do not require catalog initialization. Missing prices use the retained pricing reference's Location and model/profile identity; prices resolved from current catalogs remain estimates. Aggregates sum known prices and include cost plus provenance when any contributor is priced; cost remains absent when none is priced. Coverage reports unpriced requests rather than claiming they were free. A filesystem `NotFound` during catalog acquisition preserves retained requests and recorded costs; other acquisition failures propagate unchanged. Closed remote usage operations forward the same normalized values.

`POST /api/usage/dashboard` is the composed global read for the Usage page. Its payload is `{ daily?, monthly?, breakdown?, refresh? }`: each present report input is validated like the report query (group, filters, `from < to`, limit 1–200, sort, order) plus an optional boolean `refresh`; an unknown IANA `timeZone` in any report is an invalid request naming that report's field. It returns `{ data }` where `data` is `{ status: "preparing" }`, `{ status: "error", message }`, or `{ status: "ready", asOf, revision, summary, quota }` plus exactly the requested `daily`, `monthly`, and `breakdown` reports; an unrequested slot is omitted and no slot has a default. `asOf` and `revision` cover accounting only. `quota` is `{ status: "preparing" }`, `{ status: "ready", providers, forecast }`, or `{ status: "error", message }` with a fixed sanitized sentence when the whole provider list failed (no snapshot can represent it): live provider quota (external, memory-only) is a separate overlay that can arrive after the accounting is ready, and the snapshots and forecast keep their own observation times. `preparing` and `error` are successful responses that carry no accounting data. `refresh` is a one-shot request to schedule a provider and forecast refresh and is not part of the view's identity. The operation does not mutate source records, and it does not fall back to the separate summary, report, provider, or forecast reads.

The backend prepares dashboard accounting before any client asks. The global view producer starts with the server, registers the standard recipes (the summary and the 30-day daily, month-to-date model, and 30-day model breakdown reports in UTC and the server time zone, including the next hour's windows), builds them in the background, and keeps every registered view current from the append and removal journal. A dashboard read is a lookup of published views: it never builds, scans source records, or resolves catalog prices, and a view that is not yet published answers `preparing`. Builds take their consistent snapshot on a dedicated read-only connection owned by the producer, so a published view answers while another view is building. Each view records, per pricing reference it used, a fingerprint of the catalog rates it was priced with. After a restart the producer resolves each referenced rate once, verifies those fingerprints, keeps every view whose rates are unchanged without rebuilding it, and rebuilds only views that used a changed rate; until a view is verified in the current process it answers `preparing`. A `catalog.updated` event for one Location discards only that Location's rates and re-verifies only views priced from it; an event without a Location re-verifies every priced view. A Location that no longer exists or cannot boot leaves its requests unpriced, with no estimated cost, and is retried every minute; once its rates resolve, the views priced from it rebuild. Pricing resolution builds only each Location's catalog slice, holds at most four Location contexts at a time, and releases each after its references are resolved. A `catalog.updated` event from a Location that is no longer loaded, such as its own teardown, changes nothing and never loads it again; the quota overlay builds only the provider-usage services of the request's Location. `revision` combines the definition version, the applied journal head, and the summary's pricing fingerprint, so it is stable across restarts and changes whenever accounting inputs change. Accounting never waits for a Location: the read answers from the global prepared views and takes quota from the request's Location only when the dashboard already holds that Location's services; otherwise quota is `preparing` and the Location is acquired in the background, once per Location, and released five to ten minutes after its last dashboard read. A Location that cannot be acquired reports quota `error` and is retried after 30 seconds. The quota overlay is fetched only after a dashboard read for that Location; it is `preparing` until the first attempt completes, `ready` once the provider list is available (a provider that failed carries its own error snapshot, and a failed forecast is returned without local rates or quotas), and `error` with the fixed message "Provider quotas are unavailable" when the whole provider list failed, retried every 30 seconds. Quota never changes `status` or `revision`.

The Session operations are Location-scoped and read retained Session-owned records even after transcript compaction or when latest-step diagnostics are unavailable. A root aggregates its retained child-family records, while a child remains scoped to its own records. The aggregate exposes only the bounded latest cache invalidation reason and namespace prefix; it never exposes prompt content, full cache keys, instruction digests, credentials, or raw provider payloads. A priced model row carries `costProvenance`: `recorded` for durable provider cost or `current_catalog` for a query-time estimate.

Both report operations group their scope by model, hour, day, month, Session, project, or agent. Time groups use UTC unless optional `timeZone` names an IANA time zone of at most 128 characters; an unknown zone is an invalid request. With a zone, day and month keys are local dates (`YYYY-MM-DD`, `YYYY-MM`) and hour keys carry the local offset (`YYYY-MM-DDTHH:00:00+HH:MM`), so a repeated daylight-saving hour forms two groups; without one, hour keys are UTC (`YYYY-MM-DDTHH:00:00.000Z`). Optional `from` and `to` epoch-millisecond bounds are UTC instants in every zone, inclusive and exclusive respectively, and must satisfy `from < to`. Optional zero-based `offset` and `limit` page grouped rows; the default limit is 100 and the maximum is 200. Optional `sort` accepts `key`, `tokens`, `cost`, `steps`, `input`, `output`, `reasoning`, `cacheRead`, or `cacheWrite`, and optional `order` accepts `asc` or `desc`; they default to `key` and `asc`. Sorting applies to the complete filtered grouped row set before pagination. Numeric sorts use the ascending row key as a deterministic tie-breaker; absent cost is sorted as zero. `tokens` sorts by the non-overlapping durable total `input + output + reasoning + cache.read + cache.write`; reasoning is excluded from `output`, while cache reads and writes are excluded from `input`. `steps` sorts by logical calls. Time groups sort chronologically; local hour keys sort by the UTC instant they denote, so the earlier occurrence of a repeated hour comes first. Top-level totals and `rowCount` cover every filtered group independently of pagination. Each row and the total expose logical and physical requests, helper, continuation and fallback counts, raw token categories, optional cost with provenance, and whether every contributing request explicitly reported cache-read usage. Reports omit request IDs, routes, cache namespaces, instruction digests, raw provider payloads, and nested model arrays.

Backend/Location analytics use `usage_analytics_request`, one fact per provider request with request-time dimensions and no Session foreign key. Session deletion, retention, fork/revert, and idle cleanup do not delete analytics facts. A startup/hourly sweep reads global-only `analytics_retention.usage_days` (default 30), removing older request-date facts in bounded batches with yields and retaining the exact configured boundary. Scope, groups and measures never come from the Session table or transactional ledger; optional LEFT JOINs provide display labels only. Missing Session titles render `Session <id> · title unreported`. Location-scoped analytics keep requests at their request-time Location after a Session moves.

Prepared usage data is derived from, and rebuildable from, the source records; it never replaces them. Core owns `usage_analytics_cell` for backend and Location scope and `session_usage_cell` for Session and family scope, each sparse at minute, quarter-hour, and 1 ms grains. Cells carry additive token, cost, and count measures; exact per-value timing and generation-rate distributions, preserving exact nearest-rank percentiles; and unpriced token aggregates grouped by each request's original pricing context, preserving exact current-catalog tier pricing. A read merges coarser interior cells with finer exact boundary cells, so arbitrary millisecond `from`/`to` edges, forecast windows, local-spend reads, and local-rate reads equal a source scan. Each cell store updates in the ledger projection's transaction only after the source insert succeeds, so a duplicate event never counts twice. Analytics retention removes only matching analytics cells with their facts, independent of Session deletion; Session retention, cleanup, and cascade remove only matching Session cells and apply the same idle-cutoff and pruning-cutoff semantics. A one-time startup migration builds the cells from retained source rows, clearing derived rows in chunks of at most 10,000 and rebuilding in bounded, yielding keyset slices, committed with its durable migration marker; reads use prepared data exclusively once startup is ready. Normal reads never detect or fill missing cells and never scan source request rows; only append, the startup backfill, an idempotent rebuild from retained source records, and retention maintenance do. Public operations and results are unchanged.

Session/tree reads use only Session-owned request/usage/file-change/context-exclusion records. These follow Session deletion and idle cleanup under global-only `session_retention.records_days` (default 7), skipping locally executing Sessions and retaining the exact configured boundary. Resuming after cleanup cannot replay provider reasoning/tool state or reconstruct expired captured-change/context-exclusion records from analytics. Choose the source once by scope and share bounded report logic without mixing stores. The additive migration backfills analytics from existing ledger rows with the Session's current historical Location and adds causal anchor columns without backfilling attribution. Global and Session totals describe their own retained scopes, not a complete bill or interchangeable histories. Machine-local latency has separate global-only `analytics_retention.latency_days` (default 30); all three keys are positive integers read at sweep time, ignored in project configuration.

Summary totals and per-model spend rows expose optional `cacheReadReported`, true only when every contributing request explicitly reported cache-read telemetry. False or absent does not establish a reported zero; displays keep it unreported while retaining the raw aggregate counters.

Each grouped row optionally exposes `speed: { firstOutputP50Ms?, firstOutputP95Ms?, totalP50Ms?, totalP95Ms?, outputTokensPerSecond?, generationP50TokensPerSecond?, generationP90TokensPerSecond?, generationSamples, providerTimedSamples, observedSamples, samples }`. Percentiles use exact nearest rank (`ceil(p * count)`, one-based) over the population containing that field; missing latency does not enter it. `samples` counts records containing `firstOutputMs`, including reported zero. Weighted `outputTokensPerSecond` divides summed provider-counted `generatedTokens` by summed valid generation duration in seconds. Tokens/durations must be positive safe integers with a positive finite rate. Provider `generationDurationNs` takes precedence; otherwise `observedGenerationDurationNs` must span at least one second. Historical sub-second observed windows are excluded. No valid population means no rate. These always-on fields do not require telemetry consent. A row without latency or a valid generation population omits `speed`; throughput-only and total-only rows have `samples: 0`. Missing values remain absent, not zero. Totals retain aggregate usage without row-level speed.

## Generation measurement

Core measures every physical provider attempt with one generation meter on the monotonic clock. Session diagnostics, the live Usage activity overlay, and settled Session speed history read the meter's values; clients never recompute speed from raw deltas.

- **Phases.** `preparing` from attempt start until the transport reports the request started, then `waiting` until output arrives. `reasoning` follows a non-empty reasoning delta, `streaming` a non-empty text or tool-argument delta, and `tool` an emitted tool call while it is awaited or executed. Settlement moves the attempt to `completed`, `failed`, or `cancelled`. A terminal phase is final: later events and repeated settlements are ignored, and output after the provider's step finish is not counted.
- **Received output.** Text, reasoning, and tool-argument deltas, plus a complete tool call's serialized input when its arguments were not streamed, accumulate as one character count. The token estimate applies the shared four-characters-per-token rule to that cumulative count, so chunk boundaries never change it. Input and cached tokens never enter output speed.
- **`firstOutputMs`.** Attempt start to the first non-empty text, reasoning, or tool-argument delta.
- **`sample`.** A rolling window over arrival endpoints kept at least 250 ms apart. It retains one endpoint at or before five seconds before the newest arrival as its baseline, excludes the baseline's cumulative tokens, and requires at least one second between baseline and newest arrival. A stall lowers the rate rather than discarding it.
- **`final`.** The whole-attempt rate from the first arrival (its tokens excluded) to the last arrival, present in a terminal phase when that interval spans at least one second. The settled record's `timing.receivedOutput` stores the same interval, so Session `latest` aggregates the same measurement.
- **Ordering.** A timestamp earlier than the newest observed one is treated as the newest, so intervals are never negative or inflated.
- **Attempts and outcomes.** Each retry, overflow recovery, continuation fallback, and model fallback starts a new meter with a higher attempt number; a logical request keeps one record carrying its final attempt's `outcome`. Every new record, including helper requests, sets `outcome` explicitly; only historical records omit it, meaning completed. Interruption records `cancelled`. A stream failure or provider error records `failed`, and so does a decision attempt stopped by its own timeout. Step, goal, decision, prediction, and prompt requests also record `failed` when the stream ends without a terminal finish. Otherwise the outcome is `completed`, even when the caller later rejects the provider's answer. An unsettled attempt never receives fabricated tokens.
- **Reconciliation.** At settlement, `generatedTokens` is the provider's visible output plus its separately reported reasoning, each counted once, timed from first output to the provider's step finish. Without provider counts the record carries `estimatedTokens`. Received-output estimates remain display-only.
- **Publication.** `session.diagnostics.updated` carries `generationSpeed.live` immediately on every phase change, at most every 250 ms for further output, once when the stream ends, and once at settlement with the terminal phase. Session snapshots overlay the active meter's current state; after settlement they carry no `live` and show settled `latest`.
- **Live activity.** A process-memory registry holds attempts from `preparing` through `tool` and removes each at settlement or when its attempt scope closes; an interrupted scope settles the attempt as `cancelled`. Aggregate `outputTokensPerSecond` is all estimated output received across attempts in the trailing five seconds divided by five seconds, at 250 ms resolution: wall-clock throughput, not a mean of attempt rates. Output from attempts that settled inside the window still counts. `streaming` counts active attempts with output in that window. `models` groups by exact model reference, ordered by active attempts and then throughput, at most 50. `history` holds at most 120 points for wall-clock-aligned five-second buckets, each with the bucket's peak active attempts and throughput; idle buckets carry the current active count. A rate is absent only when nothing was active and nothing was received.

Provider usage arrives once per response, never per token, so live rates are always received-output estimates. Provider means a value the provider reports; local means Core's monotonic measurement; estimated means the received-output estimate.

| Route family | Usage delivery | Input | Output | Reasoning | Cache read | Cache write | First output | Generation duration |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI-compatible Chat (`stream_options.include_usage`) | One final chunk with empty `choices`; an interrupted stream can lose it | Provider | Provider, including reasoning | Provider when `completion_tokens_details.reasoning_tokens` is present | Provider (`cached_tokens` or `prompt_cache_hit_tokens`) | Provider only when `cache_write_tokens` is reported | Local | Local |
| OpenAI Responses | Terminal response object | Provider | Provider, including reasoning | Provider (`output_tokens_details.reasoning_tokens`) | Provider (`input_tokens_details.cached_tokens`) | Provider when `cache_write_tokens` is reported | Local | Local |
| Anthropic Messages | `message_start`, then cumulative `message_delta` totals | Provider | Provider, including thinking | Not reported separately | Provider | Provider | Local | Local |
| Gemini | `usageMetadata` on stream chunks; the latest wins | Provider | Provider (`candidatesTokenCount` plus `thoughtsTokenCount`) | Provider (`thoughtsTokenCount`) | Provider (`cachedContentTokenCount`) | Not reported | Local | Local |
| Bedrock Converse | `metadata` event | Provider | Provider | Not reported separately | Provider | Provider | Local | Local; `metrics.latencyMs` is not used |
| Runpod Ollama | Whole response in one job output with `done` totals | Provider (`prompt_eval_count`) | Provider (`eval_count`) | Not reported separately | Provider (`prompt_eval_cached_count`) | Not reported | Local; one chunk yields no live rate | Provider (`eval_duration`, with `prompt_eval_duration` and `load_duration`) |
| Other OpenAI-compatible servers | Final usage chunk only when the server honors `include_usage` | Provider when sent | Provider when sent | Provider when sent | Provider when sent | Provider when sent | Local | Local; vendor timing fields are not mapped |

Missing provider values stay absent. Without provider output counts, records carry estimated tokens and duration; reports never mix them into provider-counted throughput.

## Accounting dimensions and completeness

Reports also support `provider`, `provider-profile-model`, `provider-model`, `model-id`, `profile`, `prompt`, and `task`. Existing `group=model` keys and semantics remain unchanged. New groups expose typed dimensions, not a representative model reference for mixed populations. Profile dimensions are provider-qualified; an absent recorded profile means **provider default at request time**, not the current default account. Variants aggregate by default in the new provider/profile/model dimensions; the variant filter and detail are labeled **selected effort**, not wire-effective effort. A cache namespace is never a model, profile, account, or effort identifier.

Generation statistics use only provider-counted tokens with a valid matching duration. `generationSamples` counts that population; `providerTimedSamples` and `observedSamples` explain its duration coverage. `generationP50TokensPerSecond` and `generationP90TokensPerSecond` are exact nearest-rank percentiles of individual request rates, distinct from duration-weighted `outputTokensPerSecond`. Existing `speed.samples` continues to count first-output latency samples. Received-output estimates (`receivedOutput`, displayed with `≈`) enter neither accounting, consumption, cost, quota burn, nor measured percentiles.

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

### Whole-window pace

Each supported fixed-reset window can carry a separate optional `pace` object with `verdict`, `projectedUsedAtReset`, and optional `exhaustionAt`. The recent-delta forecast remains display-only and does not trigger alerts.

For reported use `u`, positive limit `l`, duration `d`, and reset `r`, elapsed time is `now - (r - d)` and projected use is `u / elapsed * d`. A projection at or below 90% of the limit is `ahead`; above 90% through 100% is `cutting-it-close`; above 100%, or use at the limit, is `will-run-out`. There is no verdict for zero or unreported use, missing bounds, rolling or balance semantics, elapsed time below `max(60 seconds, 1% of duration)`, or a reset at or before now. Only `will-run-out` may report a future exhaustion time, and only before reset. The TUI and web label these states Ahead, Cutting it close, and Will run out without replacing the recent-delta forecast.

Percent units have a denominator of 100 for pace calculations; this does not populate an unreported `limit` field. Claude's five-hour and seven-day bucket contracts define their durations, including scoped weekly lanes. Other windows require their own defined or reported duration; a label alone does not establish reset semantics.

### Pace milestones

Quota observations from response headers, response streams, and explicit Usage refreshes evaluate three milestones: `cutting-it-close`, `will-run-out`, and `almost-out` (less than 10% remaining). Every milestone requires a reported future reset; balances without reset times remain visible without alerts. Providers whose quota appears only on refresh can alert only after refresh; no background provider polling is scheduled.

Process-local state is isolated by account, provider, and window. The first real observation records a silent baseline, including an already-exhausting window. Repeated observations do not repeat delivered milestones. A worsening jump directly to Will run out skips Cutting it close. Recovery re-arms the recovered local milestone. A skipped or failed delivery leaves its edge pending. Reset changes of at most one second retain the same window; a greater change re-arms milestones. Restart establishes a new silent baseline.

Terminal delivery uses a warning toast and the TUI attention channel. The ephemeral `provider.quota.pace` event carries `providerID`, `windowID`, `milestone`, required `resetAt`, `title`, and `body`, without a Location or Session ID. Its process-global evaluator is shared across Locations, with a bounded nonblocking observation queue. Saturation can drop an observation; a later observation reevaluates the window. No quota history is persisted.

Relay delivery uses the Quota pace category with independent In app and System preferences, enabled by default. Cross-machine collapse keys are provider ID, window ID, milestone, and reset rounded to its nearest minute; matching reset minutes can also collapse distinct provider accounts. The closed agent frame is `quota`; its `quota.result` reply is `settled` or `pending`. Browsers receive a live `notice.quota` or a quota item in `notice.present`, never a stored Session notice. The relay derives the owner and device from the verified connection. Each browser's live notice and System attempt is claimed independently in owner-wide durable storage before dispatch. Unexpired claims are retained; exhausted key-storage capacity or push budget leaves delivery pending. Claim storage permits 512 active keys per owner and 64 recipient claims per key; excess recipients are not guaranteed delivery. A rejected or uncertain push attempt is not resent. Push payloads contain only category, authenticated device ID, provider ID, window ID, milestone, and reset time; clients supply generic short copy. They carry no account identity, credential reference, profile, email, or raw response. Activating one opens Usage on its originating online machine. The Worker and its push-preference migration must be ready before connectors that send quota frames are released.

## Bounded accounting reads

Every report, prompt/task lookup, pricing correction, local-rate read, and quota-local-spend read uses one consistent snapshot on `database.reader ?? database.db`. File-backed databases use the reader. Reads merge prepared cells; global reads use `usage_analytics_cell` and scoped reads enumerate selected Sessions in `session_usage_cell`. Prepared-cell, sample, and pricing-context traversals read at most 10,000 stored rows per statement, including ties and low-selectivity filters; pricing correction pages cover at most 200 pricing contexts; response page size alone does not bound work. Source-request slices of at most 10,000 requests per statement, including timestamp ties, bound only append, backfill, and retention maintenance. Reads yield between statements, tree pages, pricing chunks, and percentile seeks. Exact percentiles use stored per-value distributions and bounded index traversal, not whole-population ranking. Shared-reader transaction ownership is serialized and temporary state is cleaned on success, failure, and cancellation. No full-history request arrays or quota-history table are introduced; quota snapshots and forecast history stay account-bound process memory. Existing retained-history cleanup bounds coverage; a surviving subtotal is not a complete historical bill.

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
