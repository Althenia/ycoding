import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { PromptCostBlock, QuotaForecastBlock, TaskCostDetails, UsageStatisticsDetails } from "../src/remote/ui/usage-cost"
import { UsageFilterControls, UsageGroupControl } from "../src/remote/ui/usage-filters"
import type { UsageFiltersPresentation, UsageGroupPresentation } from "../src/remote/ui/usage-filter-model"
import "../src/styles/tokens.css"
import "../src/styles/base.css"

const root = document.getElementById("app")
if (!root) throw new Error("Missing accounting fixture root")
const cost = { known: 2, pricedRequests: 2, unpricedRequests: 1 }
const [filters, setFilters] = createSignal<UsageFiltersPresentation>({ provider: "", profile: "", model: "", effort: "", range: "last30" })
const [group, setGroup] = createSignal<UsageGroupPresentation>("model")
render(() => <main class="container">
  <h1>Retained usage</h1>
  <UsageGroupControl value={group()} onChange={setGroup} />
  <UsageFilterControls value={filters()} providers={[{ id: "openai", label: "OpenAI" }]} onChange={setFilters} />
  <p role="status">Selected range: {filters().range}</p>
  <PromptCostBlock unit={{ inputID: "msg_original", settled: false, complete: false, cost,
    main: { total: 0, known: 0, pricedRequests: 1, unpricedRequests: 0 }, children: cost,
    helpers: [{ label: "Decision", cost: { pricedRequests: 0, unpricedRequests: 1 } }], reason: "Historical attribution is partial" }} />
  <UsageStatisticsDetails tokens={{ input: 1000, output: 200, reasoning: 300, cache: { read: 400, write: 50 } }} cost={cost}
    speed={{ generationSamples: 4, generationP50TokensPerSecond: 20, generationP90TokensPerSecond: 50, providerTimedSamples: 1, observedSamples: 3, outputTokensPerSecond: 32, samples: 2 }} />
  <h2>Session allowance</h2>
  <QuotaForecastBlock now={600_000} forecast={{ state: "estimated", unit: "percent", evidence: "medium", method: "quota-delta-ema", updatedAt: 600_000, observedFrom: 0, observedTo: 600_000, ratePerHour: 10, projectedUsedAtReset: 60 }} />
  <h2>Weekly allowance</h2>
  <QuotaForecastBlock now={600_000} forecast={{ state: "insufficient", unit: "percent", evidence: "insufficient", updatedAt: 600_000, reason: "Warming up after restart" }} />
  <TaskCostDetails unit={{ settled: false, complete: false, cost, main: cost, children: cost, helpers: [] }} />
</main>, root)
