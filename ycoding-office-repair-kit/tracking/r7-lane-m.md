# R7 Lane M — statistics/quota telemetry inventory (read-only)

Revision: `a4bb99e` (`main`). All claims cite live checkout paths.
Status: analytical note only. Nothing under `packages/` or `apps/` was modified.

## 1. Durable telemetry inventory

### 1.1 Normalized token record — `TokenUsage.Info`

`packages/schema/src/token-usage.ts:6`

| field | type | optional? | unit | semantics |
|---|---|---|---|---|
| `input` | Finite | required | tokens | non-cached input only (see 4.3) |
| `output` | Finite | required | tokens | visible output only |
| `reasoning` | Finite | required | tokens | reasoning tokens |
| `cache.read` | Finite | required | tokens | cache **read** input |
| `cache.write` | Finite | required | tokens | cache **write** input |

No subset marker exists in the schema. The subset relationships (`reasoning ⊆ output` under the provider normalization, `cache.read`/`cache.write` disjoint from `input`) are only expressed in Core's ingest mapping (`packages/core/src/session/usage.ts:9-18`), not in the contract. A consumer that adds `input + output + reasoning + cache.read + cache.write` over-counts; see §4.3.

### 1.2 `Money.USD`

`packages/schema/src/money.ts:6` — branded `Finite`, plus `USDPerMillionTokens` at `money.ts:13`. Currency is implicit USD; there is **no** multi-currency record and no credits field anywhere in Schema. Credits are converted to USD at the adapter edge (`packages/core/src/provider-usage/copilot.ts:6` `CREDIT_TO_USD = 0.01`).

### 1.3 Durable session events

`packages/schema/src/session-event.ts`:

| event | line | payload fields | granularity |
|---|---|---|---|
| `session.step.ended` | 378 | `cost: Money.USD` (385), `tokens: TokenUsage.Info` (386), `contextLimit?: NonNegativeInt`, `providerCache?: SessionCacheDiagnostics.ProviderCache`, `snapshot?`, `files?` | **per logical step, terminal** |
| `session.step.failed` | 395 | `cost?: Money.USD` (402), `tokens?: TokenUsage.Info` (403), `contextLimit?`, `providerCache?` | per logical step, terminal; cost/tokens **optional** |
| `session.usage.recorded` | 132 | `source: "title"\|"compaction"\|"goal"` (136), `cost: Money.USD` (138), `tokens: TokenUsage.Info` (139) | **per hidden-helper operation**, durable but excluded from public logs |
| `session.provider.request.recorded` | 144 | `ProviderRequest.Record` | **per physical provider request / logical attempt group** |
| `session.usage.updated` | 151 | `cost: Money.USD`, `tokens: TokenUsage.Info` | **cumulative session snapshot**, ephemeral (live only) |
| `session.diagnostics.updated` | 161 | `diagnostics: SessionCacheDiagnostics.Info` | cumulative session snapshot, ephemeral |
| `session.compaction.ended` (V1) | 650 | `tokens?: TokenUsage.Info` (659) | per compaction, tokens optional |

`session.usage.recorded` and `session.provider.request.recorded` are durable replay/backfill events deliberately **excluded from the public log** (`session-event.ts:831`, `session-event.ts:832-838`). The public durable union is `PublicDurable` (`session-event.ts:826`).

`session.step.ended`/`failed` are the only public durable per-step spend records. Note that a step-failed event's `cost`/`tokens` are optional, and the projector only folds them when **both** are present (`packages/core/src/session/projector.ts:1016-1018`).

### 1.4 `ProviderRequest.Record` / `ModelSpend` / `Summary`

`packages/schema/src/provider-request.ts:43`, `:67`, `:87`.

`Record` fields: `id` (`prq_`), `sessionID`, `inputID?`, `source: "step"|"title"|"goal"|"compaction"` (`:18`), `agent`, `model: Model.Ref`, `routeID`, `promptCacheKey`, `systemDigest`, `toolDigest`, `request: PositiveInt` (per-session ordinal), `attempts: PositiveInt` (physical attempts for that logical request), `invalidation` (`:21`, 12 literals), `continuation: "full"|"continued"|"fallback"` (`:37`), `cacheReadReported?` (boolean, absent for historical), `cost?: Money.USD` (**optional**; persisted provider-reported), `tokens: TokenUsage.Info`, `time`.

`ModelSpend` fields: `model`, `requests: NonNegativeInt`, `tokens`, `cost?: Money.USD`, `costProvenance?: "recorded"|"current_catalog"` (`:40`). A filter enforces cost and provenance appear together (`:74-80`).

`Summary` fields (`:87`): `logical`, `physical`, `helpers`, `continued`, `fallback`, `cost?: Money.USD`, `models?: ModelSpend[]` (absent when no requests recorded), `tokens`, `latestInvalidation?`, `latestNamespace?` (8-char).

Key optionality facts that make a value *unknown* rather than zero:
- `Summary.cost` is present **only when every record has a cost** (`packages/core/src/session/provider-request.ts:155-157`; also mirrored in `ModelSpend.cost` via the cost/provenance filter at `packages/schema/src/provider-request.ts:78`). Partial pricing therefore reports no total at all, not a partial sum.
- `Summary.models` is absent when the session has no provider-request rows (`:169-170`).
- `Record.cost` absent means "not persisted"; §4.5 covers the catalog-estimate fallback.

### 1.5 `Session.Info` cumulative session totals

`packages/schema/src/session.ts:47-48`: `cost: Money.USD` (required, DB default 0) and `tokens: TokenUsage.Info` (required, per-component DB default 0). Backed by `session` columns `cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write` (`packages/core/src/session/sql.ts:61-66`; read at `packages/core/src/session/info.ts:40-49`). These are **cumulative per-session counters**, and the DB defaults coerce "never recorded" to 0 — a zero here is not evidence of unknown, but it also cannot distinguish "free" from "unpriced". This is the value the Sim/desktop would receive in `Session.Info`.

### 1.6 `SessionCacheDiagnostics.Info`

`packages/schema/src/session-cache-diagnostics.ts:24`. Fields: `model`, `context{total, limit?, remaining?, percent?}`, `tokens{uncachedInput, output, reasoning, cacheRead, cacheWrite}` (all required ints), `cache{eligible, hitRatio?, mechanism, readReported, writeReported, minimumTokens?, belowMinimum?}`, `estimatedCost?: Money.USD`, `requests?: ProviderRequest.Summary`. This is a **projection over resident messages**, not a durable table (see §3).

### 1.7 Persisted SQL tables (internal Core read models)

- `session_provider_request` (`packages/core/src/session/sql.ts:92`): one row per logical request; `attempts`, `source`, `model`, `invalidation`, `continuation`, `cache_read_reported`, nullable `cost`, `tokens` JSON, `time_created`; unique on `(session_id, request)` (`:118`).
- `session_usage` (`sql.ts:123`): per `(session_id, model_key)` rollup with `logical`, `physical`, `helpers`, `continued`, `fallback`, nullable `cost`, and the five token columns.
- Migration `packages/core/src/database/migration/20260803011247_session-usage.ts` creates `session_usage` (line 9) and backfills.
- Retention: `SessionUsageCleanup` deletes `session_usage` and `session_provider_request` rows for sessions idle > 30 days (`packages/core/src/session/usage-cleanup.ts:10`, `:24-40`). **History older than 30 days is destroyed**, which bounds the date range any statistics page can honestly show.

### 1.8 Provider quota contract

`packages/schema/src/provider-usage.ts`: `Status` (`:9`, 5 literals `available|stale|unsupported|unauthorized|error`), `Source` (`:15`, `provider_api|local_client_rpc|response_headers|provider_internal_api|local_session`), `Stability` (`:21`, `stable|client_contract|observed|best_effort`), `Unit` (`:28`, `percent|usd|requests|tokens|count`).

`Window` (`:33`): `id`, `label`, `unit` required; `used?`, `limit?`, `remaining?`, `unlimited?`, `resetAt?`, `periodSeconds?` **all optional**. `Snapshot` (`:45`): `providerID`, `label`, `status`, `source`, `stability`, `updatedAt`, `windows[]` required, `message?`. `Observation` (`:56`): no `status`, used for live pushes.

There is **no** `period`/`lane` enum: windows are free-form `id`/`label` strings. There is no rate-limit-vs-quota type discriminator, and no local-budget type anywhere in Schema (grep for `budget` in `packages/schema/src` returns only a comment in `session.ts:72`).

## 2. Provider usage API and adapters

### 2.1 Routes

`packages/protocol/src/groups/provider-usage.ts`:

- `GET /api/provider/usage` — `providerUsage.list` (`:23`). Query: `LocationQuery` fields plus `refresh` as the exact strings `"true"`/`"false"` (`:13-16`). Success `Location.response(Schema.Array(ProviderUsage.Snapshot))`; error `ServiceUnavailableError`.
- `GET /api/provider/:providerID/usage` — `providerUsage.get` (`:38`). Same query; success `Location.response(ProviderUsage.Snapshot)`.

Both are under the `server.providerUsage` HTTP group (`:21`) and are read-only (`:32` OpenAPI title). Handler: `packages/server/src/handlers/provider-usage.ts:17-40`; it awaits `ProviderUsageV2.Service` and maps straight to `response(...)`. `packages/server/src/handlers/provider-usage.ts:10-15` shows `refresh === undefined ? undefined : { refresh }` so absence is preserved — no refresh by default.

Important shape facts:
- An **unsupported or unknown** provider against `get` returns HTTP success with `status: "unsupported"` and `windows: []` (`packages/core/src/provider-usage.ts:97-98`, `:101-102`) — not a 404.
- `list` enumerates only the **keys of the configured adapter map** (`provider-usage.ts:137-141`). Providers without an adapter entry never appear in the list at all.
- The Core `GetInput` accepts `credentialID` (`:36-39`), but **the HTTP query has no credential selector**, so over the wire the adapter always resolves the first credential for the integration (`:106-110`). Multi-credential per-provider selection is not reachable from Protocol today.
- Refresh failure does not fail the request: the cache replaces the last good snapshot with `status: "stale"` and a message (`packages/core/src/provider-usage/cache.ts:27-38`, `:62-66`). TTL default 60s; Anthropic is overridden to 5 minutes (`provider-usage.ts:200`).

### 2.2 Adapters actually wired

`packages/core/src/provider-usage.ts:189-201` — the adapter map is exactly five entries:

| providerID key | Core function | source it reads | status |
|---|---|---|---|
| `anthropic` | `claudeOAuth` (`:207`) | `GET https://api.anthropic.com/api/oauth/usage` (Claude Code OAuth only; `:224-226`), or pushed `response_headers` observations | implemented; **requires a `claude-code` OAuth credential** or returns `unsupported` (`:212-219`) |
| `openrouter` | `openRouter` (`:243`) | `GET https://openrouter.ai/api/v1/key`; adds `GET /api/v1/credits` only when credential metadata has `management`/`usageManagement` (`:251-258`) | implemented |
| `openai` | `openAI` (`:325`) | optional Codex app-server (`:327-338`, config `provider_usage.codex_app_server`), else ChatGPT OAuth `https://chatgpt.com/backend-api/wham/usage` (`:340-347`), else **admin-key** org usage + costs endpoints (`:352-372`) | implemented; API-key path returns `unauthorized` unless the credential carries `usageAdmin`/`usage_admin` (`packages/core/src/provider-usage/openai.ts:48-50`; `provider-usage.ts:354-365`) |
| `meta` | `meta` (`:376`) | `GET https://api.llama.com/v1/organization/usage/completions` and `/costs` with a key credential | implemented; key credential only |
| `github-copilot` | `githubCopilot` (`:260`) | `GET https://api.github.com/copilot_internal/user`, org `/user/orgs` + billing summary | implemented; OAuth only; **enterprise hosts return `unsupported`** (`:268-280`); best-effort per `docs/configuration.md:311-317` |

No adapter exists for any other provider (bedrock, google/gemini, azure, etc.). Anything else has no quota surface.

### 2.3 Window identities produced (per adapter)

- OpenRouter: `key` (usd), and conditional `daily`/`weekly`/`monthly` (usd) — `openrouter.ts:39-51`; `credits` (usd, `remaining = max(limit-used,0)`) only after the credits merge — `:55-79`.
- Claude: OAuth → `percent` windows `five-hour`, `seven-day`, `extra-usage`, plus `seven-day-<model>` scoped lanes when `limits` reports them (`claude.ts:82-129`). Header observations → `five-hour`/`seven-day`/`overage` with `source: response_headers`, `stability: observed` (`claude.ts:64-80`). Header push: `packages/core/src/plugin/provider/anthropic.ts:314-334`.
- Codex/OpenAI: primary/secondary rate windows and credit-reset windows named from upstream `limitId` (`codex.ts:72-79`, `:110-215`).
- OpenAI admin: `week-cost`, `month-cost` (usd), `week-requests`, `month-requests` (requests), `week-tokens`, `month-tokens` (tokens) — `openai.ts:37-44`. **No limits**, only `used`.
- Meta: `current-bill` (usd + `resetAt` = next UTC month start), `week/month-requests`, `week/month-tokens` — `meta.ts:42-55`. **No limits**.
- Copilot: `quota_snapshots` legacy windows (`percent`/counts) or `monthly-ai-credits` (`unit: "count"`, `used` only) — `copilot.ts:105-122`, `:150-166`.

Optional-field writers, verified by grep: `periodSeconds` is written **only** by Codex rate windows (`packages/core/src/provider-usage/codex.ts:153`, derived from minutes/seconds upstream); `unlimited: true` is written only by Codex reset-credit windows (`codex.ts:183`) and Copilot limited-user quotas (`copilot.ts:214`). For every other provider and window these two optionals are always absent. `percent`-unit windows never carry `limit` or `remaining`.

## 3. TUI parity baseline

The TUI is the only existing consumer. Its sources are exactly three routes plus two ephemeral events; it never opens the database.

### 3.1 Provider quota dialog

`packages/tui/src/routes/session/provider-usage.tsx`. It loads per-provider snapshots with `client.api.providerUsage.get({ providerID })` (`:130-132`) and again with `{ providerID, refresh: true }` when the dialog opens (`:184-186`). It filters out `status === "unsupported"` before display (`:45-48`, `visibleProviderSnapshots`). Providers are derived from the **session family's models** (`:31-41`), so a provider is shown only if some session in the family uses it and that providerID is in the adapter map.

Formatting rules already implemented (`packages/tui/src/util/provider-usage.ts`), which are the parity contract:
- `formatWindowValue` (`:51-68`): `unlimited` → "Unlimited"; `percent` with no `used` → "Not reported"; `usd` uses used/limit/remaining combinations; otherwise numbers with unit; falls back to "Not reported".
- `freshnessLabel` (`:70-77`): `stale` → "stale"; any non-available → the raw status; `response_headers` → "live"; else "updated now" / "updated Nm".
- `usageSeverity` (`:29-33`): <70 normal, <90 warning, else error. `progressBar` at `:16`.
- Reset/bill-due formatting at `:35`, `:43`; `formatBillDue` special-cases Meta `current-bill` (`provider-usage.tsx:301-303`).

`quotaRatio` (`provider-usage.tsx:315-320`) returns `undefined` for unlimited, uses `used` directly for percent, else `used/limit*100` only when `limit > 0`. It never sums across windows or providers, and it special-cases the OpenRouter `key` limit as the denominator for daily/weekly/monthly (`:282-284`, `:296-298`). The dialog renders a **session-level** `ProviderRequest.Summary` table (`:241-274`) and per-model spend rows.

### 3.2 Session sidebar

`packages/tui/src/feature-plugins/sidebar/context.tsx`. Sources: `data.session.diagnostics` (route `session.diagnostics`) and `data.session.usage` (`:21-28`), plus optional `pressure`/`fallback`. It shows Provider, Model, Context (`total / limit` or "unreported" when `limit` absent, `:85-91`), Cache hit, per-model spend rows, and a Total. Critical existing rule: when `ProviderRequest.Summary.cost` is `undefined`, Total renders **"Not reported"** rather than a partial sum (`:77-79`, comment at `:75-76`, `:134`). Model rows render "Not reported" per unpriced model (`:95-98`).

### 3.3 Subagent footer

`packages/tui/src/routes/session/subagent-footer.tsx:98-151` reads `Session.Info.cost`/`tokens` for each family member and formats them per child. `spent` is suppressed when `cost <= 0` (`:111`, `:151`) — that is the only place the TUI conflates zero with absent, and it is a display-choice, not an aggregation.

### 3.4 Event-driven refresh

`packages/tui/src/context/data.tsx`: `session.usage.updated` updates `session.info.cost/tokens` and re-syncs the usage route only when already resident (`:961-970`); `session.diagnostics.updated` writes the diagnostics store directly (`:971-973`); `session.step.ended`/`failed` write per-message cost/tokens and invalidate diagnostics (`:1223-1259`). Routes are declared at `:1704-1728`.

**Parity consequence:** the TUI has no daily chart, no activity calendar, no top-models/providers/projects table, no date-range filter, and no export. All of those are *new* desktop surface even though their inputs exist.

## 4. Accounting rules in code

### 4.1 Physical attempts vs logical steps — implemented

`ProviderRequest.Record.attempts` is incremented by a transport-attempt observer that fires on `phase === "started"` for each physical HTTP/WS attempt (`packages/core/src/session/provider-request.ts:240-244`), and it ignores attempts after the logical request is `completed` (`:243` guard). The observer is registered process-wide through `ProviderRequestObserver.register` (`packages/core/src/session/provider-request.ts:247`; `packages/core/src/session/provider-request-observer.ts:8-19`) and wired at `packages/core/src/effect/app-node-platform.ts:24` (`LLMClient.configured({ observeAttempt: ProviderRequestObserver.observe })`). The attempt `phase` values come from `packages/ai/src/route/transport/attempt.ts:12` (`started|succeeded|failed`) and even an interrupted stream reports `succeeded` (`attempt.ts:88-101`).

`Summary.logical = records.length` and `physical = Σ record.attempts` (`packages/core/src/session/provider-request.ts:160-161`). `helpers = Σ (source === "step" ? 0 : 1)` (`:162`). This is the correct separation the requirement asks for.

### 4.2 Retries, cancellations, failures

- A retried logical step increments `requestTrackerState.attempts` per attempt (`packages/core/src/session/runner/llm.ts:409`) and the transport observer counts each physical attempt. Retry scheduling publishes `session.retry.scheduled` with `attempt`, `at`, `error` (`packages/schema/src/session-event.ts:605`; `packages/core/src/session/runner/retry.ts:85-96`). Max 10 attempts (`retry.ts:30`), backoff ceiling 120s (`retry.ts:29`).
- On exhausted retry, `completeRetryFallback` calls `requestTracker.complete(...)` with explicitly **zero** cost/tokens (`packages/core/src/session/runner/llm.ts:869-875`). So a failed-and-retried request records a `ProviderRequest.Record` row whose tokens are zero and whose `cost` is `Money.USD.zero`. Combined with `Summary.cost` requiring **every** record to have a cost (`packages/core/src/session/provider-request.ts:155-157`), a failed request contributes a `$0` cost row rather than marking the total unknown. **This is a place a total can silently under-report** — a real billed failure is summed as zero.
- Cancellation/interruption: usage that settled before the interrupt is recorded because the provider-stream section runs under `Effect.uninterruptibleMask` (`llm.ts:609`) and `publishStepEnd` runs inside it; if no settlement exists, `completeProviderRequest(undefined, "provider-not-reported")` records zero tokens (`llm.ts:800-802`, `:508-517`). An interrupt before any settlement therefore records a zero-token, zero-cost provider-request row — again counted as a priced `$0` record rather than unknown.
- `session.step.failed` carries optional cost/tokens (`session-event.ts:402-403`), and the projector folds them only when both exist (`packages/core/src/session/projector.ts:1016-1018`).

### 4.3 Token component subsets — implemented upstream, not guarded downstream

The provider normalization contract is in `packages/ai/src/schema/events.ts:10-68`: `Usage.inputTokens` is **inclusive** of cache reads/writes, `outputTokens` is **inclusive** of reasoning; `nonCachedInputTokens + cacheReadInputTokens + cacheWriteInputTokens = inputTokens` and `reasoningTokens ≤ outputTokens`. `visibleOutputTokens = max(0, outputTokens - reasoningTokens)` (`events.ts:67-69`).

Core's ingest maps `TokenUsage.Info` to the **non-overlapping** half only (`packages/core/src/session/usage.ts:9-18`): `input = nonCachedInputTokens`, `output = visibleOutputTokens`, `reasoning = reasoningTokens`, `cache.read/write`. So in `TokenUsage.Info`:
- `reasoning` **is a subset of the provider's outputTokens**, but in this record `output` already excludes it. Adding `output + reasoning` is the correct visible+reasoning total; adding `reasoning` to an inclusive-output total would double count.
- `cache.read`/`cache.write` are disjoint from `input` (they are the cached portion), so `input + cache.read + cache.write` reconstructs inclusive prompt tokens.
- A naive "sum every field" over-counts by `reasoning` against an inclusive output, and by cache against a naive inclusive input — neither `TokenUsage.Info` nor `Summary` carries a flag distinguishing inclusive vs exclusive, so any new read model must encode the equation. `SessionUsage.estimatedCost` uses the correct combination (`usage.input * input + (usage.output + usage.reasoning) * output + cache.read + cache.write`, `packages/core/src/session/usage.ts:26-35`).

### 4.4 Hidden helpers — counted, but inconsistently published

- Title helper publishes `session.usage.recorded` with `source: "title"` on interrupt or completion and records a provider request with `source: "title"` (`packages/core/src/session/title.ts:120`, `:138-142`, `:152`).
- Goal helper: same shape with `source: "goal"` (`packages/core/src/session/goal.ts:115`, `:133-137`, `:147`).
- Compaction helper: records a provider request with `source: "compaction"` (`packages/core/src/session/compaction.ts:144`) and folds its usage into the tracker (`:158-190`), **but it never publishes `session.usage.recorded`**. Grep across `packages/core/src` finds `SessionEvent.UsageRecorded` published only in `title.ts:138` and `goal.ts:133`. Its tokens therefore reach `session_provider_request`/`session_usage` and `Summary.helpers`, but they are **not** added to `Session.Info.cost`/`tokens` (the cumulative session columns) on a non-failing path. `session_usage.helpers` counts it, so the two surfaces disagree by design.

### 4.5 Parent/child rollup — single rollup, at the root

`V2Session.usage` walks the family: `family(session)` returns `[session]` when `session.parentID` is set, otherwise it breadth-first collects all descendants via `result.list({ parentID: current.id })` (`packages/core/src/session.ts:473-481`). It then `summarize`s the concatenation (`session.ts:631-641`). So:
- A root session's `session.usage` **includes every descendant child exactly once**, breadth-first, with no per-level re-addition. No double count inside the family.
- A child session's `session.usage` is scoped to itself (`family` returns `[session]`), and the handler description states this (`packages/protocol/src/groups/session.ts:690`).
- The TUI mirrors this: `ProviderUsageDialogContent` sums `familySpend` from the root summary and renders per-child rows read from each child's own `Session.Info` (`packages/tui/src/routes/session/provider-usage.tsx:250-265`). A desktop UI that both renders the family total and sums visible children rows **would** double count; the existing code avoids it by only iterating `sessionFamily` when `usage.models` is absent (`provider-usage.tsx:267-271`).

### 4.6 Revert does not reverse usage — verified gap

`session.revert.committed` deletes messages and pending rows (`packages/core/src/session/projector.ts:1164-1190`) but does **not** call `applyUsage(..., -1)`. The `SessionTable.cost`/`tokens_*` counters and the `session_provider_request`/`session_usage` rows retain spend from reverted turns. A statistics page sourced from those columns will show spend for work the user undid.

### 4.7 Retention destroys history

`SessionUsageCleanup` runs hourly and deletes `session_usage` + `session_provider_request` rows for sessions whose `time_updated` is older than 30 days (`packages/core/src/session/usage-cleanup.ts:10`, `:24-40`). `session_provider_request` rows are the only source of per-day/provider/model detail; after 30 days only the cumulative `session` columns survive. Any daily chart must not claim coverage beyond that.

### 4.8 Confirmed subset traps and silent drops

- **`helpers ⊆ logical`.** `Summary.logical = records.length` (all sources) and `Summary.helpers` counts the non-`step` subset (`packages/core/src/session/provider-request.ts:160`, `:162`). Presenting them as additive double counts every helper.
- **`Summary.tokens` ⊃ `Session.Info.tokens`.** Both include title/goal; only `Summary` includes compaction (4.4). Adding them double counts title/goal; subtracting them silently drops compaction.
- **Failed intermediate attempts' usage is dropped.** A retried step reuses one tracker (`llm.ts:333`, `:409`), and `completeProviderRequest` records only the final settlement's tokens (`llm.ts:508-538`). The failed attempts' billed tokens are never recorded; `attempts` counts them but no tokens do.
- **Retry-exhausted and pre-settlement interrupts record `Money.USD.zero`** (`llm.ts:869-875`, `:508-517`), which makes `Summary.cost` look complete while under-reporting real spend.
- **Reverted spend is never reversed** (4.6).
- **`Session.Info.cost` defaults to 0** at the DB column (`packages/core/src/session/sql.ts:61`), so "free" and "unpriced" are indistinguishable in that field.

## 5. Feasibility verdict table

Legend: **TODAY** = computable from an existing route/schema read; **NEW** = needs a new read model/route; **IMPOSSIBLE** = not reachable without broader credentials or data that is not recorded.

| # | Requirement element (`docs/STATISTICS_AND_QUOTAS.md`) | Verdict | Evidence / blocker |
|---|---|---|---|
| 1 | Date range filter | **NEW** | No route filters sessions/requests by time. `SessionsQueryFields` has only workspace/limit/order/search/parentID (`protocol/src/groups/session.ts:55-66`). Sorting uses `time_updated` (`core/src/session.ts:751`), not an activity span. |
| 2 | Timezone selector + local calendar grouping | **TODAY** | Display-side; storage is epoch mills. `resetAt` and `time` are UTC epoch. |
| 3 | Project / folder / all-projects filter | **TODAY** | `project`, `directory`, `subpath` on `SessionsQuery` (`session.ts:236-241`); `project.list` (`protocol/src/groups/project.ts:9`). |
| 4 | Provider filter | **TODAY (partial)** | `Session.Info.model.providerID` (`schema/src/session.ts:44`). Per-request provider only exists inside `Summary.models[]` (`provider-request.ts:67`), so filtering is session-granular. |
| 5 | Model filter | **TODAY (partial)** | Same: `Session.Info.model` is the *last selected* model, not per-request history. |
| 6 | Reset filters | **TODAY** | UI-local; no data dependency. |
| 7 | Last updated | **TODAY** | `ProviderUsage.Snapshot.updatedAt` (`provider-usage.ts:50`); TUI's `freshnessLabel` is reusable logic (`tui/src/util/provider-usage.ts:77`). |
| 8 | Export (CSV/JSON, privacy preview) | **TODAY (bounded by 9–17)** | Client-side serialization of whatever the page loaded; no new route required. Formula-leading CSV escaping is UI work. |
| 9 | Overview card: observed requests (physical attempts) | **NEW** | `Summary.physical` exists per session (`provider-request.ts:89`); no cross-session aggregate route. |
| 10 | Overview card: logical steps | **NEW** | `Summary.logical` per session only; same blocker. Note `helpers ⊆ logical`. |
| 11 | Overview card: input/output/cache token components | **TODAY (per session) / NEW (aggregate)** | `ProviderRequest.Summary.tokens` (`provider-request.ts:99`). `Session.Info.tokens` is cumulative but excludes compaction and defaults 0. |
| 12 | Known spend vs estimated spend, separately | **PARTIAL** | Per-model provenance exists (`ModelSpend.costProvenance`, `provider-request.ts:75`), but the summary total is a single `cost?` with no provenance field and is absent unless **all** records are priced (`packages/core/src/session/provider-request.ts:155-157`). Separating them across a range needs a new read model. |
| 13 | Errors / cancellations card | **TODAY (per session) / NEW (aggregate)** | `session.execution.failed` / `.interrupted` / `session.step.failed` are durable public events (`session-event.ts:253`, `:259`, `:395`) readable via `GET /api/experimental/session/:id/log` (`protocol/src/groups/session.ts:948`). No aggregate. |
| 14 | Active sessions card | **TODAY** | `GET /api/session/active` (`protocol/src/groups/session.ts:302`). |
| 15 | Daily activity / spend chart + table equivalent | **NEW** | Per-request timestamps exist in `session_provider_request.time_created` (`core/src/session/sql.ts:115`) but **no route exposes per-record time** — `session.usage` returns only `Summary`. Retention is 30 days (4.7). |
| 16 | Activity calendar / heatmap | **NEW** | Same absence of a date-bucketed read model; `Session.Info.time.updated` is last-touch only, not a per-day activity series. |
| 17 | Top models / providers / projects table | **NEW** | `Summary.models[]` is per session and has no `sessionID`/`projectID` (`provider-request.ts:67-85`). `Project.Info` has no cost/tokens (`schema/src/project.ts:47-57`). |
| 18 | Sortable drilldown to source sessions | **NEW** | Aggregates would need contributing `Session.ID`s; `Summary` carries none. `session.list` does return `Session.Info` including `id`/`parentID` (`protocol/src/groups/session.ts:263-266`), so a session-granular drilldown is possible once #9–#17 exist. |
| 19 | Empty / partial / loading / stale / error states | **TODAY** | Status vocabularies exist (`ProviderUsage.Status`, `provider-usage.ts:9`); a missing total is already representable (cost absent). |
| 20 | Quota cards: each window independent | **TODAY** | `GET /api/provider/usage`, `GET /api/provider/:providerID/usage` (`protocol/src/groups/provider-usage.ts:23`, `:38`). |
| 21 | Unit / used / limit / remaining | **TODAY** | `Window.unit` required; `used`/`limit`/`remaining` optional (`provider-usage.ts:36-40`). |
| 22 | Reset time with timezone | **TODAY (partial)** | `Window.resetAt` epoch ms (`provider-usage.ts:40`) — but note Meta's is a *bill due* date, not a quota reset; write only by Codex/Claude/OpenRouter/Meta/Copilot. |
| 23 | Source / stability labels | **TODAY** | `Snapshot.source`, `Snapshot.stability` (`provider-usage.ts:15`, `:21`, `:48-49`). |
| 24 | Freshness + refresh action | **TODAY** | `updatedAt` + `?refresh=true` (`protocol/src/groups/provider-usage.ts:16`). 60s TTL, 5min for Anthropic (`core/src/provider-usage.ts:112`, `:189`). |
| 25 | Distinguish unavailable / unsupported / unauthorized / stale / temporary error | **PARTIAL** | `status` covers unavailable (`error`), `unsupported`, `unauthorized`, `stale` (`provider-usage.ts:9`; `core/src/provider-usage.ts:127-133`). **No transient-vs-permanent distinction**: every non-401/403/404 failure becomes `error` with a fixed message (`core/src/provider-usage.ts:129-133`). |
| 26 | No invented percentage when denominator missing; `unlimited` needs evidence | **TODAY** | TUI already implements exactly this (`tui/src/util/provider-usage.ts:53-73`; `provider-usage.tsx:277-283`). `unlimited` is only written where upstream reports it (Codex `codex.ts:183`, Copilot `copilot.ts:214`). |
| 27 | Never sum percentages across windows/providers | **TODAY** | No code sums them; UI rule and a test-visible constraint. |
| 28 | Local model context length is not a provider quota | **TODAY** | Separate field: `SessionCacheDiagnostics.context.limit` (`session-cache-diagnostics.ts:28`) vs `Window` (`provider-usage.ts:33`). |
| 29 | Persisted advisory budgets (currency/unit, period, scope, threshold, warning/dismiss state) | **NEW** | **Nothing exists.** Grep for `budget` finds only a comment (`schema/src/session.ts:72`) and no config module (`core/src/config/` has none). No table, no route, no event. |
| 30 | Provider-reported quota vs rate limit vs local budget labels | **TODAY (partial)** | Quota is `ProviderUsage.Snapshot`. Rate-limit *observations* exist only as Claude `response_headers` windows (`claude.ts:64-80`) and `SessionError`/`session.retry.scheduled` 429 evidence (`retry.ts:41-44`). There is no `rate_limit` kind discriminator; a label would be inferred from `source`/`stability`. Local budget needs #29. |

Counts across the 30 elements above:

- **Computable today** (14): rows 2, 3, 6, 7, 8, 14, 19, 20, 21, 23, 24, 26, 27, 28.
- **Today only in partial form** (6): rows 4, 5, 12, 22, 25, 30.
- **Needs new work** (10): rows 1, 9, 10, 11, 13, 15, 16, 17, 18, 29.
- **Impossible** (0).

14 + 6 + 10 = 30. Rows 4/5/12/22/25/30 are usable now for a per-session view but cannot answer a date-ranged multi-session question without the additions in §6.

## 6. Recommended minimal additions

Only these are genuinely unshowable today. All are additive; none requires a credential scope increase.

### 6.1 One aggregate read model (required for rows 1, 9, 10, 11, 13, 15, 16, 17, 18)

Add `packages/schema/src/statistics.ts` — `Statistics.Query` and `Statistics.Summary` — and one Protocol route in a new `server.statistics` group:

```
GET /api/statistics/summary
  query: from, to, timezone, project?, directory?, workspace?, provider?, model?, parentID?
  success: { data: Statistics.Summary }
```

Proposed field names (snake-free, camelCase per Schema guide):

- `coverage: { from, to, timezone, sessions: NonNegativeInt, logical: NonNegativeInt, physical: NonNegativeInt, pricedPhysical: NonNegativeInt, unpricedPhysical: NonNegativeInt }` — the completeness counters the requirement asks for; `unpricedPhysical` makes failure/drop visible instead of `$0`.
- `totals: { logical, physical, helpers, continued, fallback, failed, interrupted }` — `helpers` documented as a subset of `logical`.
- `tokens: TokenUsage.Info`, plus `tokensReported: { reasoning: Boolean, cacheRead: Boolean, cacheWrite: Boolean }` so a UI knows which components are true zeros.
- `cost: { known?: Money.USD, estimated?: Money.USD, unpricedAttempts: NonNegativeInt }` — **separate** known vs estimated; `known`/`estimated` individually optional so absent means unknown.
- `byDay: Array<{ date: Schema.String /* UTC yyyy-mm-dd */, logical, physical, tokens, known?: Money.USD, estimated?: Money.USD }>`
- `byModel: Array<ModelSpend & { sessionIDs?: Array<Session.ID> }>` (reuse `ProviderRequest.ModelSpend`)
- `byProvider: Array<{ providerID: Provider.ID, requests, attempts, tokens, cost?: Money.USD }>`
- `byProject: Array<{ projectID: Project.ID, requests, attempts, tokens, cost?: Money.USD }>`

Core sources it from `session_provider_request` + `session_usage` + `session`, grouped with UTC day bucketing. Because retention is 30 days (4.7), `coverage` must also expose `retainedFrom` so a chart cannot imply full history.

**Protocol change ⇒ client/OpenAPI regeneration is mandatory** via `bun run --cwd packages/client generate` (which runs `packages/client/script/build.ts`); `check:generated` enforces a clean diff.

### 6.2 Advisory budget storage (required for row 29)

Only if approved: a `Budget` Schema struct (`scope: "provider"|"project"|"session"`, `scopeID`, `unit: ProviderUsage.Unit`, `limit: NonNegativeFinite`, `periodSeconds`, `warnAt: number`, dismiss state) persisted in a small table plus a `GET/PUT /api/budget` route, surfaced read-only in Godot. The requirement explicitly scopes this milestone to advisory-only; no admission control, no `Session` policy field.

### 6.3 Correctness fixes that should precede the page (not features)

These are in-scope defects for an honest statistics page and belong as small Schema/Core changes:

1. **Do not persist `Money.USD.zero` for unpriced failures** (`packages/core/src/session/runner/llm.ts:869-875`, `:508-517`). Leave `cost` absent so `Summary.cost` becomes unknown rather than under-reported, or add an explicit `unpriced` reason.
2. **Include compaction helper usage in `Session.Info`** or document the exclusion beside `helpers` (`packages/core/src/session/compaction.ts:144` vs `title.ts:138`). Today the two spend surfaces disagree.
3. **Reverse or annotate reverted usage** (`packages/core/src/session/projector.ts:1164-1190`).
4. **Record failed intermediate attempt tokens** on retry, or expose `attempts` with explicit unpriced counts so the UI cannot claim those attempts were free.

## 7. Unknowns

- **Godot-side surface**: no statistics/usage/quota route, view, or API call exists under `apps/office/**` (grep for `statistic|usage|quota|provider/usage` under `apps/office/**/*.gd` returns no source hits). Whether the desktop has any partially built page is **unverified** beyond that absence.
- **Live provider behaviour**: which accounts actually return windows is **unverified**; I did not run any refresh. The adapter map (`packages/core/src/provider-usage.ts:182-188`) and per-adapter credential gates are the only evidence. Copilot org-billing discovery order and Meta/OpenAI admin-credential outcomes are code-read, not observed.
- **`ProviderUsage` cache identity across credentials**: `make` keys the cache by `${providerID}:${credentialID}` (`packages/core/src/provider-usage.ts:111`), but the HTTP route cannot select a credential (2.1), so only the first credential for an integration is ever exercised over the wire. Multi-credential quota display over Protocol is therefore **unimplemented**, not merely unverified.
- **`periodSeconds` coverage**: only Codex writes it; whether OpenRouter/Claude/Meta can supply it was not investigated beyond the adapters.
- **`local_session` source**: declared in `ProviderUsage.Source` (`packages/schema/src/provider-usage.ts:19`) but no writer found in `packages/core/src` (grep count 0). Dead vocabulary or external producer — **unverified**.
- **Exact TUI test parity**: `packages/tui/test/cli/tui/provider-usage-command.test.tsx` and `provider-usage-layout.test.tsx` exist; I did not run them (read-only lane, no test execution requested).
- **30-day retention interplay with `Session.Info`**: cumulative session columns are never pruned (`usage-cleanup.ts` deletes only `session_usage` and `session_provider_request`), so a long-lived session can report totals whose per-day provenance is gone. Behaviour for a session idle >30 days that then resumes is **not traced**.

