import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { useRemote } from "../context"
import { createRemoteQuery } from "../query"
import { usageRead } from "../queries"
import { Icon } from "../../ui/icon"
import { LoadingPlaceholder } from "./loading"
import type { RemoteUsageForecast } from "@ycoding-ai/remote"
import { UsageFilterControls, UsageFilterSummary, UsageGroupControl } from "./usage-filters"
import { defaultUsageFilters, defaultUsageGroup, usageGroups, type UsageFiltersPresentation, type UsageGroupPresentation } from "./usage-filter-model"
import { createUsagePhone } from "./usage-phone"
import { ModelIncidents } from "./model-incidents"
import { ProviderLogo } from "./provider-logo"
import { QuotaForecastStatus, UsageDetails, UsageStatisticsDetails } from "./usage-cost"
import { GenerationOverview, ModelSpeedComparison, UsageTrends } from "./usage-speed"
import { UsageHeading, usageSectionNumbers } from "./usage-sections"
import { dailyScopeLabel, dashboardBusy, speedCells } from "./usage-speed-model"
import { consumptionNeedsProfile, consumptionRow, forecastDetails, joinParts, providerProvenanceLines } from "./usage-accounting"
import { compactUsageTotal, dailySpend, donutGeometry, matchingQuotaForecast, reportIdentity, reportLabel, reportCost, reportCostText, money, providerDistribution, providerHeading, quotaGroupHeading, quotaWindow, relativeFreshness, spendMetrics, spendCostText, tokenCount, tooltipPosition, usageReportInputs, usageZoneKey, visibleProviders, type SpendDay, usageDashboardView, usageQuotaView, type UsageDashboardInput, type UsageDashboardReady, type UsageDashboardSlots, type UsageProvider, type UsageReportInput, type UsageBreakdown, type UsageReportRow, type UsageWindow } from "./usage-model"
import "./usage.css"

const groups = usageGroups.map((group) => group.value)
type BreakdownInput = UsageReportInput & UsageBreakdown
const names = { model: "Model", session: "Session", project: "Project", agent: "Agent", provider: "Provider", "provider-profile-model": "Provider / profile / model", "provider-model": "Provider / model", "model-id": "Model ID", profile: "Profile", prompt: "Prompt", task: "Task" }
const columns = [
  { key: "steps", label: "Requests" }, { key: "tokens", label: "Tokens" }, { key: "input", label: "Input" },
  { key: "output", label: "Output" }, { key: "reasoning", label: "Reasoning" }, { key: "cacheRead", label: "Cache read" }, { key: "cacheWrite", label: "Cache write" }, { key: "cost", label: "Cost" },
] as const
const count = (value: number) => new Intl.NumberFormat().format(value)
const distributionColors = ["var(--yc-green-strong)", "var(--yc-yellow-strong)", "var(--yc-text-muted)", "var(--yc-green)", "var(--yc-border-strong)"]
const tileIDs = ["today", "yesterday", "last30"] as const
const tileLabels = { today: "Today", yesterday: "Yesterday", last30: "Last 30 days" }
const providerKey = (provider: UsageProvider) => `${provider.providerID}\u0000${provider.profile ?? ""}`

export function UsagePage() {
  const remote = useRemote()
  const usagePhone = createUsagePhone()
  const openedAt = Date.now()
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [now, setNow] = createSignal(Date.now())
  const [zoneMode, setZoneMode] = createSignal<"utc" | "local">(localStorage.getItem(usageZoneKey) === "local" ? "local" : "utc")
  const [group, setGroup] = createSignal<(typeof groups)[number]>(defaultUsageGroup)
  const [filters, setFilters] = createSignal<UsageFiltersPresentation>(defaultUsageFilters)
  const [sort, setSort] = createSignal<UsageReportInput["sort"]>("cost")
  const [order, setOrder] = createSignal<UsageReportInput["order"]>("desc")
  const [offset, setOffset] = createSignal(0)
  const [manualRefresh, setManualRefresh] = createSignal(false)
  const [tableOpen, setTableOpen] = createSignal(false)
  const [breakdownTableOpen, setBreakdownTableOpen] = createSignal(false)
  const [distributionMetric, setDistributionMetric] = createSignal<"spend" | "tokens">("spend")
  const [compactTotal, setCompactTotal] = createSignal(true)
  const [held, setHeld] = createSignal<{ readonly scope: string; readonly zone: string | undefined; readonly recipe: string; readonly input: BreakdownInput; readonly accounting: UsageDashboardSlots; readonly envelope?: UsageDashboardReady }>()
  const [minimumRowsHeight, setMinimumRowsHeight] = createSignal(0)
  const [activeDay, setActiveDay] = createSignal<SpendDay>()
  const [activeProvider, setActiveProvider] = createSignal<string>()
  const [dayPosition, setDayPosition] = createSignal({ left: 0, top: 0 })
  const [providerPosition, setProviderPosition] = createSignal({ left: 0, top: 0 })
  let mobileRows: HTMLDivElement | undefined
  let dayCard: HTMLDivElement | undefined
  let dayTooltip: HTMLDivElement | undefined
  let providerCard: HTMLDivElement | undefined
  let providerTooltip: HTMLDivElement | undefined
  let distributionChart: HTMLDivElement | undefined
  let distributionProbe: HTMLSpanElement | undefined
  let distributionCaption: HTMLSpanElement | undefined
  let distributionResizeObserver: ResizeObserver | undefined
  let deviceID = remote.state().activeDeviceID
  const connected = createMemo(() => remote.state().transport.kind === "open")
  const selectedZone = () => zoneMode() === "local" ? localZone : undefined
  const zoneLabel = () => zoneMode() === "local" ? `Local · ${localZone}` : "UTC"
  const reports = createMemo(() => usageReportInputs(openedAt, selectedZone(), { group: group(), offset: offset(), sort: sort(), order: order(), providerID: filters().provider, profile: filters().profile, modelID: filters().model, selectedEffort: filters().effort, range: filters().range, from: filters().from, to: filters().to }))
  const dashboardInput = createMemo<UsageDashboardInput>(() => reports())
  const breakdownInput = createMemo<BreakdownInput>(() => reports().breakdown)
  const dashboardQuery = createRemoteQuery(remote.store.queryClient, () => remote.queries.usageDashboard(remote.scope(), connected(), dashboardInput()))
  const scopeKey = () => `${remote.state().activeDeviceID}:${remote.state().generation}`
  const recipeKey = createMemo(() => JSON.stringify(dashboardInput()))
  const heldValue = () => {
    const value = held()
    return value !== undefined && value.scope === scopeKey() && value.zone === selectedZone() ? value : undefined
  }
  const view = createMemo(() => {
    const value = heldValue()
    return usageDashboardView(usageRead(dashboardQuery()), value === undefined ? undefined : { sameRecipe: value.recipe === recipeKey(), accounting: value.accounting, ...(value.envelope === undefined ? {} : { envelope: value.envelope }) })
  })
  const info = () => {
    const current = view()
    return current.kind === "ready" ? current.info : undefined
  }
  const slots = () => {
    const current = view()
    return current.kind === "ready" ? current.info : current.kind === "loading" || current.kind === "error" ? current.retained : undefined
  }
  const stale = () => {
    const current = view()
    return current.kind === "ready" ? current.stale : current.kind === "loading" || current.kind === "error"
  }
  const busy = () => dashboardBusy(view(), manualRefresh())
  const waiting = () => view().kind === "loading" || view().kind === "preparing"
  const numbers = createMemo(() => usageSectionNumbers(info() ? [] : ["generation", "trends", "speed"]))
  const retry = () => {
    const scope = remote.scope()
    if (scope === undefined) return
    setManualRefresh(true)
    void remote.queries.refreshUsageDashboard(scope, dashboardInput())
  }
  const quota = createMemo(() => usageQuotaView(info()))
  const quotaPreparing = () => quota().kind === "preparing"
  const quotaError = () => {
    const current = quota()
    return current.kind === "error" ? current.message : undefined
  }
  const forecastData = () => {
    const current = quota()
    return current.kind === "ready" ? current.forecast : undefined
  }
  const quotaForecastState = () => {
    const current = view().kind
    return current === "ready" ? quotaPreparing() ? "loading" : quotaError() !== undefined || forecastData()?.quotas === undefined ? "error" : "ready" : current
  }
  const providerData = () => {
    const current = quota()
    return current.kind === "ready" ? current.providers : undefined
  }
  const dailyData = () => slots()?.daily
  const dailyScope = () => dailyScopeLabel(filters().provider, filters().model, filterProviders().find((provider) => provider.id === filters().provider)?.label)
  const monthlyData = () => slots()?.monthly
  const shownInput = (): BreakdownInput => (stale() ? heldValue()?.input ?? breakdownInput() : breakdownInput())
  const displayed = () => slots()?.breakdown
  const updating = () => displayed() !== undefined && busy()
  createEffect(() => {
    const current = view()
    const result = usageRead(dashboardQuery())
    const previous = untrack(held)
    if (current.kind === "ready" && !current.refreshing && result.status === "ready" && result.data?.status === "ready") {
      const scope = scopeKey()
      const zone = selectedZone()
      const recipe = recipeKey()
      if (previous !== undefined && previous.envelope === current.info && previous.scope === scope && previous.zone === zone && previous.recipe === recipe) return
      setHeld({ scope, zone, recipe, input: breakdownInput(), envelope: current.info, accounting: { daily: current.info.daily, monthly: current.info.monthly, breakdown: current.info.breakdown } })
      return
    }
    if (current.kind === "error") {
      if (previous === undefined) return
      if (previous.recipe === recipeKey()) setHeld(undefined)
      else if (previous.envelope !== undefined) setHeld({ scope: previous.scope, zone: previous.zone, recipe: previous.recipe, input: previous.input, accounting: previous.accounting })
      return
    }
    if (current.kind === "preparing" || current.kind === "unsupported") setHeld(undefined)
  })
  const holdRows = () => setMinimumRowsHeight(Math.max(minimumRowsHeight(), mobileRows?.offsetHeight ?? 0))
  const providers = createMemo(() => visibleProviders(providerData() ?? []))
  const providerKeys = createMemo(() => providers().map(providerKey))
  const latest = createMemo(() => providers().length ? Math.max(...providers().map((provider) => provider.updatedAt)) : undefined)
  const machine = () => {
    const connection = remote.state().connection
    return connection.kind === "connected" || connection.kind === "offline" ? connection.deviceName : undefined
  }
  const distribution = createMemo(() => providerDistribution(monthlyData(), providerData() ?? [], distributionMetric()))
  const totalLabel = () => distributionMetric() === "spend" ? `Exact known USD subtotal: ${money(distribution().total)}` : `Exact token total: ${count(distribution().total)}`
  const shownTotal = () => compactTotal() ? compactUsageTotal(distribution().total, distributionMetric()) : distributionMetric() === "spend" ? money(distribution().total) : count(distribution().total)
  const arcs = createMemo(() => donutGeometry(distribution().segments, 72))
  const segmentIDs = createMemo(() => distribution().segments.map((segment) => segment.providerID))
  const activeSegment = () => arcs().find((segment) => segment.providerID === activeProvider())
  const placeDay = (x: number, y: number) => {
    if (!dayCard || !dayTooltip) return
    setDayPosition(tooltipPosition(dayCard.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, { x, y }, dayTooltip.getBoundingClientRect()))
  }
  const placeProvider = (x: number, y: number) => {
    if (!providerCard || !providerTooltip) return
    setProviderPosition(tooltipPosition(providerCard.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, { x, y }, providerTooltip.getBoundingClientRect()))
  }
  const measureDistributionTotal = () => {
    if (!distributionChart || !distributionProbe || !distributionCaption) return
    const chart = distributionChart.getBoundingClientRect()
    const radius = Math.min(chart.width, chart.height) * 59 / 200
    const centerX = chart.left + chart.width / 2
    const centerY = chart.top + chart.height / 2
    const insideHole = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return [[rect.left, rect.top], [rect.right, rect.top], [rect.left, rect.bottom], [rect.right, rect.bottom]]
        .every(([x, y]) => Math.hypot(x! - centerX, y! - centerY) <= radius)
    }
    setCompactTotal(!insideHole(distributionProbe) || !insideHole(distributionCaption))
  }
  const days = createMemo(() => dailySpend(dailyData(), now(), selectedZone()))
  const dayKeys = createMemo(() => days().map((entry) => entry.key))
  const tileValue = (id: (typeof tileIDs)[number]) => spendMetrics(id === "today" ? days().slice(-1) : id === "yesterday" ? days().slice(-2, -1) : days())
  const sparkline = createMemo(() => {
    const costs = days().map((entry) => entry.cost)
    const highest = Math.max(1, ...costs)
    return costs.map((cost, index) => `${(index / 29 * 96).toFixed(1)},${(28 - cost / highest * 24).toFixed(1)}`).join(" ")
  })
  const selectGroup = (next: (typeof groups)[number]) => {
    holdRows()
    batch(() => {
      setGroup(next)
      setOffset(0)
      setSort("cost")
      setOrder("desc")
    })
  }
  const applyFilters = (nextGroup: UsageGroupPresentation, nextFilters: UsageFiltersPresentation) => {
    holdRows()
    batch(() => {
      if (nextGroup !== group()) {
        setGroup(nextGroup)
        setSort("cost")
        setOrder("desc")
      }
      setFilters(nextFilters)
      setOffset(0)
    })
  }
  const filterProviders = createMemo(() => [...new Map((providerData() ?? []).map((provider) => [provider.providerID, { id: provider.providerID, label: providerHeading(provider).name }])).values()])
  const setSorting = (next: NonNullable<UsageReportInput["sort"]>) => {
    holdRows()
    const direction = sort() === next && order() === "desc" ? "asc" : "desc"
    batch(() => {
      setSort(next)
      setOrder(direction)
      setOffset(0)
    })
  }
  const nextPage = () => {
    const next = displayed()?.nextOffset
    if (next === undefined || updating()) return
    holdRows()
    setOffset(next)
  }
  const previousPage = () => {
    if (updating()) return
    holdRows()
    const next = Math.max(0, (shownInput().offset ?? 0) - 25)
    setOffset(next)
  }
  createEffect(() => {
    if (usageRead(dashboardQuery()).status !== "loading") setManualRefresh(false)
  })
  createEffect(() => localStorage.setItem(usageZoneKey, zoneMode()))
  createEffect(() => {
    distribution().total
    distributionMetric()
    setCompactTotal(true)
    if (distributionChart) distributionResizeObserver?.observe(distributionChart)
    queueMicrotask(measureDistributionTotal)
  })
  createEffect(() => {
    const current = remote.state().activeDeviceID
    if (current !== deviceID || current === undefined || remote.state().connection.kind === "signed-out") {
      deviceID = current
      setMinimumRowsHeight(0)
    }
  })
  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 60_000)
    distributionResizeObserver = new ResizeObserver(measureDistributionTotal)
    if (distributionChart) distributionResizeObserver.observe(distributionChart)
    document.fonts.addEventListener("loadingdone", measureDistributionTotal)
    void document.fonts.ready.then(measureDistributionTotal)
    onCleanup(() => {
      clearInterval(clock)
      distributionResizeObserver?.disconnect()
      distributionResizeObserver = undefined
      document.fonts.removeEventListener("loadingdone", measureDistributionTotal)
    })
  })

  return <div class="usage-page" ref={usagePhone.ref}>
    <header class="usage-head"><div class="usage-head__title"><h1><Icon name="usage" />Usage</h1><p>Quotas and spend from {machine() ?? "your machine"}</p></div>
      <div class="usage-head__actions"><Show when={latest() !== undefined}><span class="usage-head__freshness">Updated {relativeFreshness(latest()!, now())}</span></Show>
        <div class={`usage-zone usage-toggle${zoneMode() === "local" ? " usage-zone--local" : ""}`} role="group" aria-label="Usage time zone">
          <button type="button" aria-pressed={zoneMode() === "utc"} onClick={() => setZoneMode("utc")}>UTC</button>
          <button type="button" aria-pressed={zoneMode() === "local"} onClick={() => setZoneMode("local")}>Local</button>
        </div>
        <button class="usage-refresh" type="button" aria-label="Refresh quotas" title="Refresh quotas" aria-busy={busy() || quotaPreparing() ? "true" : "false"} disabled={busy() || quotaPreparing() || remote.state().transport.kind !== "open"} onClick={retry}><Icon name="refresh" /></button>
      </div>
    </header>
    <Show when={view().kind === "error" && displayed() === undefined}>{(() => { const current = view(); return <p class="usage-message" role="alert">{current.kind === "error" ? current.message : ""} <button type="button" onClick={retry}>Retry</button></p> })()}</Show>
    <Show when={view().kind === "preparing"}><p class="usage-message" role="status">Preparing usage…</p></Show>

    <section class="usage-spend" aria-labelledby="usage-spend-title">
      <div class="usage-section-head"><UsageHeading level={2} id="usage-spend-title" ordinal={numbers().spend}><Icon name="usage" />Estimated spend overview</UsageHeading></div>
      <Show when={dailyScope()}>{(scope) => <p class="usage-spend__scope">Spend, daily charts and trends filtered to {scope()}</p>}</Show>
      <Show when={dailyData()}>
        <div class="usage-tiles"><For each={tileIDs}>{(id) => <article class="usage-tile">
          <h3>{tileLabels[id]}</h3><strong>{spendCostText(tileValue(id))}</strong>
          <p class="usage-tile__meta"><span>{count(tileValue(id).requests)} requests</span><span>{count(tileValue(id).tokens)} tokens</span></p>
          <Show when={id === "last30"}><svg viewBox="0 0 100 32" aria-label="Spend trend over the last 30 days" role="img" preserveAspectRatio="none"><polyline points={sparkline()} /></svg></Show>
        </article>}</For></div>
      </Show>
    </section>

    <Show when={info()}>{(ready) => <GenerationOverview live={ready().live} monthly={monthlyData()} ordinal={numbers().generation} />}</Show>

    <section class="usage-quotas" aria-labelledby="usage-allowances">
      <div class="usage-section-head"><UsageHeading level={2} id="usage-allowances" ordinal={numbers().quotas}><Icon name="usage" />Provider quotas</UsageHeading><p>Account-reported limits · separate from this backend's consumption</p></div>
      <Show when={!providerData() && view().kind === "unsupported"}><p class="usage-message" role="status">Update YCoding on this machine to see usage.</p></Show>
      <Show when={!providerData() && remote.state().transport.kind !== "open" && view().kind === "idle"}><p class="usage-message" role="status">Connect to a machine to see usage.</p></Show>
      <Show when={!providerData() && (waiting() || quotaPreparing())}><LoadingPlaceholder kind="usage" label={view().kind === "preparing" || quotaPreparing() ? "Preparing provider quotas…" : "Loading provider quotas…"} /></Show>
      <Show when={quotaError()}>{(message) => <p class="usage-message" role="alert">{message()}</p>}</Show>
      <Show when={providerData() && view().kind === "ready" && providers().length === 0}><p class="usage-message">No connected provider reports quotas.</p></Show>
      <div class="usage-providers"><For each={providerKeys()}>{(key) => {
        const initial = providers().find((provider) => providerKey(provider) === key)!
        return <ProviderCard provider={() => providers().find((provider) => providerKey(provider) === key) ?? initial} now={now()} forecasts={forecastData()?.quotas} forecastAsOf={forecastData()?.asOf} forecastState={quotaForecastState()} />
      }}</For></div>
    </section>

    <section class="usage-visuals" aria-label="Usage charts">
        <div class="usage-chart" ref={dayCard}>
          <div class="usage-chart__head"><div><UsageHeading level={3} ordinal={numbers().charts}><Icon name="usage" />Daily spend (last 30 {zoneLabel()} days)</UsageHeading><p>{zoneLabel()} day boundary · Today highlighted<Show when={dailyScope()}> · {dailyScope()}</Show></p></div><button type="button" aria-expanded={tableOpen()} aria-controls="usage-daily-table" onClick={() => setTableOpen(!tableOpen())}><Icon name="sessions" />{tableOpen() ? "Hide table" : "View table"}</button></div>
          <Show when={dailyData()} fallback={<Show when={view().kind === "unsupported"} fallback={<Show when={connected() && waiting()}><LoadingPlaceholder kind="chart" label={view().kind === "preparing" ? "Preparing daily spend…" : "Loading daily spend…"} /></Show>}>
            <p class="usage-message" role="status">Update YCoding on this machine to see usage.</p>
          </Show>}>
            <p class="usage-chart__today">Today: {joinParts([spendCostText(tileValue("today")), `${count(days().at(-1)?.requests ?? 0)} requests`])}</p>
            <svg viewBox="0 0 900 180" role="img" aria-label="Daily cost over the last 30 days, with exact values in the table" preserveAspectRatio="none">
              <line x1="0" y1="156" x2="900" y2="156" class="usage-chart__axis" />
              <For each={dayKeys()}>{(key, index) => {
                const entry = () => days().find((item) => item.key === key)!
                const height = () => entry().cost === 0 ? 2 : Math.max(4, entry().cost / Math.max(1, ...days().map((item) => item.cost)) * 138)
                return <rect x={index() * 30 + 7} y={156 - height()} width="16" height={height()} rx="2" class={index() === 29 ? "usage-chart__bar usage-chart__bar--today" : "usage-chart__bar"}
                  tabindex="0" role="img" data-cursor="action" aria-label={joinParts([`${key}:`, joinParts([spendCostText(entry()) === "" ? undefined : `estimated cost ${spendCostText(entry())}`, `${count(entry().requests)} requests`, `${count(entry().tokens)} tokens`], ", ")], " ")}
                  onPointerEnter={(event) => { if (event.pointerType !== "touch") { setActiveDay(entry()); queueMicrotask(() => placeDay(event.clientX, event.clientY)) } }}
                  onPointerMove={(event) => { if (event.pointerType !== "touch") placeDay(event.clientX, event.clientY) }} onPointerLeave={(event) => { if (event.pointerType !== "touch") setActiveDay(undefined) }}
                  onFocus={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setActiveDay(entry()); queueMicrotask(() => placeDay(rect.left + rect.width / 2, rect.top + rect.height / 2)) }}
                  onBlur={() => setActiveDay(undefined)} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setActiveDay(entry()); queueMicrotask(() => placeDay(event.clientX || rect.left + rect.width / 2, event.clientY || rect.top + rect.height / 2)) }} />
              }}</For>
            </svg>
            <Show when={activeDay()}>{(entry) => <div class="usage-chart__tooltip" ref={dayTooltip} style={{ left: `${dayPosition().left}px`, top: `${dayPosition().top}px` }} role="status"><strong>{entry().key}</strong><Show when={spendCostText(entry()) !== ""}><span>Estimated cost {spendCostText(entry())}</span></Show><span>{count(entry().requests)} requests · {count(entry().tokens)} tokens</span></div>}</Show>
            <div class="usage-chart__labels"><span>{days()[0]?.label}</span><span>{days()[14]?.label}</span><span>Today</span></div>
            <Show when={tableOpen()}><div id="usage-daily-table" class="usage-table-wrap"><table><caption>Daily usage, last 30 {zoneLabel()} days</caption><thead><tr><th scope="col">Day</th><th scope="col">Cost</th><th scope="col">Tokens</th><th scope="col">Requests</th></tr></thead><tbody><For each={[...days()].reverse()}>{(entry) => <tr><th scope="row">{entry.key}</th><td>{spendCostText(entry)}</td><td>{count(entry.tokens)}</td><td>{count(entry.requests)}</td></tr>}</For></tbody></table></div></Show>
          </Show>
        </div>
        <div class="usage-distribution" ref={providerCard} aria-labelledby="usage-distribution-title">
          <div class="usage-distribution__head"><div><h3 id="usage-distribution-title"><Icon name="package" />Provider distribution (current {zoneLabel()} month)</h3><p>Current {zoneLabel()} month</p></div>
            <div class="usage-distribution__controls"><div class={`usage-toggle${distributionMetric() === "tokens" ? " usage-toggle--tokens" : ""}`} role="group" aria-label="Distribution metric">
              <button type="button" aria-pressed={distributionMetric() === "spend"} onClick={() => setDistributionMetric("spend")}><Icon name="usage" />Spend</button>
              <button type="button" aria-pressed={distributionMetric() === "tokens"} onClick={() => setDistributionMetric("tokens")}><Icon name="hash" />Tokens</button>
            </div></div>
          </div>
          <Show when={monthlyData() && reportCostText(monthlyData()!.total) !== ""}><p class="usage-distribution__pricing">Pricing: {reportCostText(monthlyData()!.total)}</p></Show>
          <Show when={!monthlyData() && connected() && waiting()}><LoadingPlaceholder kind="chart" label={view().kind === "preparing" ? "Preparing monthly usage…" : "Loading monthly usage…"} /></Show>
          <Show when={!monthlyData() && view().kind === "unsupported"}><p class="usage-distribution__empty">Update YCoding on this machine to see monthly usage.</p></Show>
          <Show when={monthlyData()}><Show when={distribution().total > 0} fallback={<p class="usage-distribution__empty">{distributionMetric() === "spend" ? reportCostText(monthlyData()!.total) === "" ? "No positive spend this month." : `Cost ${reportCostText(monthlyData()!.total)} · no positive spend this month.` : "No recorded tokens this month."}</p>}>
            <div class="usage-distribution__body">
              <div class="usage-distribution__chart" ref={distributionChart}>
              <svg class="usage-donut" viewBox="0 0 200 200" role="img" aria-label={`${distributionMetric() === "spend" ? "Estimated spend" : "Tokens"} by provider this ${zoneLabel()} month; exact values are available in the legend`}>
                <circle class="usage-donut__track" cx="100" cy="100" r="72" fill="none" stroke-width="26" />
                <For each={segmentIDs()}>{(id, index) => {
                  const initial = arcs().find((segment) => segment.providerID === id)!
                  const segment = () => arcs().find((item) => item.providerID === id) ?? initial
                  return <circle class="usage-donut__arc" cx="100" cy="100" r="72" fill="none" stroke-width="26"
                    style={{ stroke: distributionColors[index() % distributionColors.length], "--usage-dash": `${segment().length} ${segment().circumference - segment().length}`, "--usage-circumference": segment().circumference, "stroke-dashoffset": segment().offset }}
                    tabindex="0" role="img" data-cursor="action" aria-label={`${segment().label}: ${joinParts([segment().costLabel === "" ? undefined : `cost ${segment().costLabel}`, `${Math.round(segment().share * 100)}% share`, distributionMetric() === "tokens" ? `${count(segment().value)} tokens` : undefined], ", ")}`}
                    onPointerEnter={(event) => { if (event.pointerType !== "touch") { setActiveProvider(id); queueMicrotask(() => placeProvider(event.clientX, event.clientY)) } }}
                    onPointerMove={(event) => { if (event.pointerType !== "touch") placeProvider(event.clientX, event.clientY) }} onPointerLeave={(event) => { if (event.pointerType !== "touch") setActiveProvider(undefined) }}
                    onFocus={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setActiveProvider(id); queueMicrotask(() => placeProvider(rect.left + rect.width / 2, rect.top + rect.height / 2)) }}
                    onBlur={() => setActiveProvider(undefined)} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setActiveProvider(id); queueMicrotask(() => placeProvider(event.clientX || rect.left + rect.width / 2, event.clientY || rect.top + rect.height / 2)) }} />
                }}</For>
              </svg>
              <div class="usage-donut__center">
                <strong class="usage-donut__total" role="img" tabindex="0" aria-label={totalLabel()} title={totalLabel()}>{shownTotal()}</strong>
                <span class="usage-donut__caption" ref={distributionCaption}>{distributionMetric() === "spend" ? "known USD" : "tokens"}</span>
              </div>
              <span class="usage-donut__probe" ref={distributionProbe} aria-hidden="true">{distributionMetric() === "spend" ? money(distribution().total) : count(distribution().total)}</span>
              </div>
              <Show when={activeSegment()}>{(segment) => <div class="usage-distribution__tooltip" ref={providerTooltip} style={{ left: `${providerPosition().left}px`, top: `${providerPosition().top}px` }} role="status"><strong>{segment().label}</strong><span>{joinParts([segment().costLabel === "" ? undefined : `Cost ${segment().costLabel}`, `${Math.round(segment().share * 100)}% share`])}</span><Show when={distributionMetric() === "tokens"}><span>{count(segment().value)} tokens</span></Show></div>}</Show>
              <ul class="usage-distribution__legend" aria-label={distributionMetric() === "spend" ? "Providers by estimated spend in USD" : "Providers by tokens"}><For each={segmentIDs()}>{(id, index) => {
                const initial = distribution().segments.find((segment) => segment.providerID === id)!
                const segment = () => distribution().segments.find((item) => item.providerID === id) ?? initial
                return <li>
                <span class="usage-distribution__swatch" style={{ background: distributionColors[index() % distributionColors.length] }} aria-hidden="true" />
                <span class="usage-distribution__name"><ProviderLogo providerID={segment().providerID} />{segment().label}</span><span>{Math.round(segment().share * 100)}%</span><strong>{distributionMetric() === "spend" ? segment().costLabel : count(segment().value)}</strong>
              </li>
              }}</For></ul>
            </div>
          </Show></Show>
        </div>
    </section>

    <Show when={info()}><UsageTrends daily={dailyData()} now={now()} timeZone={selectedZone()} zoneLabel={zoneLabel()} scope={dailyScope()} ordinal={numbers().trends} /><ModelSpeedComparison monthly={monthlyData()} providers={providerData() ?? []} ordinal={numbers().speed} /></Show>

    <section class="usage-breakdown-section usage-consumption" aria-label="Recorded token consumption"><div class="usage-section-head"><UsageHeading level={2} ordinal={numbers().consumption}><Icon name="zap" />Recorded consumption · Backend</UsageHeading></div>
      <Show when={forecastData()} fallback={<>
        <Show when={waiting() || quotaPreparing() || view().kind === "idle" && connected()}><LoadingPlaceholder kind="usage" label={view().kind === "preparing" || quotaPreparing() ? "Preparing recorded consumption…" : "Loading recorded consumption…"} /></Show>
        <Show when={quotaError()}>{(message) => <p class="usage-message" role="alert">{message()}</p>}</Show>
        <Show when={view().kind === "idle" && !connected()}><p class="usage-message" role="status">Connect to a machine to see recorded consumption.</p></Show>
        <Show when={view().kind === "unsupported"}><p class="usage-message" role="status">Update YCoding on this machine to see recorded consumption.</p></Show>
      </>}>
      <Show when={forecastData()?.localRates?.length}><ul class="usage-consumption__list"><For each={forecastData()?.localRates}>{(rate) => {
        const row = consumptionRow(rate)
        return <li class="usage-consumption__row" data-needs-profile={consumptionNeedsProfile(forecastData()?.localRates ?? [], rate) ? "" : undefined}><span class="usage-consumption__identity"><ProviderLogo providerID={rate.providerID} /><span class="usage-consumption__name"><span>{row.parts.provider}</span><Show when={row.parts.model}><span> · {row.parts.model}</span></Show><span class="usage-consumption__profile"> · {row.parts.profile}</span></span></span><span class="usage-consumption__rates"><span class="usage-consumption__tokens">{row.tokens}</span><span class="usage-consumption__cost">{row.cost}</span></span>
          <UsageDetails label={row.identity} groups={[{ lines: row.details }]} /></li>
      }}</For></ul></Show>
      <Show when={forecastData()?.localRates?.length === 0}><p class="usage-message">No recorded consumption in the observation window.</p></Show>
      </Show>
    </section>

    <section class="usage-breakdown-section" aria-labelledby="usage-breakdown-title">
      <div class="usage-breakdown__head"><UsageHeading level={2} id="usage-breakdown-title" ordinal={numbers().breakdown}><Icon name="sessions" />Breakdown</UsageHeading><Show when={displayed()?.rows.length}><span class="usage-breakdown__summary">Showing {(shownInput().offset ?? 0) + 1}–{(shownInput().offset ?? 0) + (displayed()?.rows.length ?? 0)} of {count(displayed()?.rowCount ?? 0)} {names[shownInput().group].toLowerCase()}s</span></Show>
      <Show when={!usagePhone.phone()}><UsageGroupControl value={group()} onChange={selectGroup} /></Show></div>
      <Show when={usagePhone.phone()} fallback={<UsageFilterControls value={filters()} providers={filterProviders()} onChange={(value) => { holdRows(); batch(() => { setFilters(value); setOffset(0) }) }} />}>
        <UsageFilterSummary group={group()} filters={filters()} providers={filterProviders()} onApply={applyFilters} />
      </Show>
      <Show when={group() === "task"}><p class="usage-message">Inclusive task rows overlap; do not add them for a family total.</p></Show>
      <div id="usage-breakdown-panel" role="region" aria-label={`${names[group()]} usage breakdown`} class="usage-breakdown" aria-busy={updating() ? "true" : "false"}>
        <Show when={!displayed() && remote.state().transport.kind === "open" && waiting()}><LoadingPlaceholder kind="usage" label={view().kind === "preparing" ? "Preparing breakdown…" : "Loading breakdown…"} /></Show>
        <Show when={!displayed() && view().kind === "unsupported"}><p class="usage-message" role="status">Update YCoding on this machine to see usage.</p></Show>
        <Show when={displayed()}><Show when={(displayed()?.rows.length ?? 0) > 0} fallback={<p class="usage-message">No requests in this period.</p>}>
          <div class="usage-breakdown__mobile" ref={mobileRows} style={{ "min-height": `${minimumRowsHeight()}px` }}><For each={displayed()?.rows}>{(row: UsageReportRow) => {
            const identity = () => shownInput().group === "model" || row.dimensions ? reportIdentity(row, providerData() ?? []) : undefined
            return <article class="usage-mobile-row"><div class="usage-mobile-row__top"><div><strong>{identity()?.model ?? reportLabel(row, shownInput().group)}</strong><Show when={identity()}><span class="usage-provider-chip">{identity()?.provider}</span></Show></div><b>{reportCostText(row)}</b></div>
              <p>{count(row.physical)} requests · {count(row.tokens.input)} in / {count(row.tokens.output)} out<Show when={row.tokens.cache.read > 0}> · {count(row.tokens.cache.read)} cache read</Show></p>
              <Show when={speedCells(row.speed).average !== "" || speedCells(row.speed).ttft !== ""}><p class="usage-mobile-row__speed">{joinParts([speedCells(row.speed).average === "" ? undefined : `${speedCells(row.speed).average} avg`, speedCells(row.speed).ttft === "" ? undefined : `P95 TTFT ${speedCells(row.speed).ttft}`])}</p></Show>
              <UsageStatisticsDetails tokens={row.tokens} speed={row.speed} cost={reportCost(row)} />
            </article>
          }}</For></div>
          <button class="usage-breakdown__table-toggle" type="button" aria-expanded={breakdownTableOpen()} aria-controls="usage-breakdown-table" onClick={() => setBreakdownTableOpen(!breakdownTableOpen())}><Icon name="sessions" />{breakdownTableOpen() ? "Hide table" : "View table"}</button>
          <div id="usage-breakdown-table" class="usage-table-wrap usage-breakdown__table" classList={{ "usage-breakdown__table--open": breakdownTableOpen() }}><table><caption>{names[shownInput().group]} by usage</caption><thead><tr><th scope="col"><button type="button" aria-label={`Sort by ${names[group()]}`} onClick={() => setSorting("key")}>{names[group()]} {sort() === "key" ? order() === "asc" ? "↑" : "↓" : "↕"}</button></th><For each={columns}>{(column) => <th scope="col"><button type="button" aria-label={`Sort by ${column.label}`} onClick={() => setSorting(column.key)}>{column.label} {sort() === column.key ? order() === "asc" ? "↑" : "↓" : "↕"}</button></th>}</For><th scope="col" title="Mean of per-request output rates">Avg tok/s</th><th scope="col" title="Output tokens over generation time, all requests">Agg tok/s</th><th scope="col" title="95th percentile of time to first output">P95 TTFT</th></tr></thead><tbody><For each={displayed()?.rows}>{(row: UsageReportRow) => {
            const identity = () => shownInput().group === "model" || row.dimensions ? reportIdentity(row, providerData() ?? []) : undefined
            return <tr><th scope="row"><span>{identity()?.model ?? reportLabel(row, shownInput().group)}</span><Show when={identity()}><span class="usage-provider-chip">{identity()?.provider}</span></Show><Show when={row.dimensions?.group === "provider"}><button type="button" class="usage-drill" aria-label={`Show ${identity()?.provider} models`} onClick={() => applyFilters("provider-model", { ...filters(), provider: row.dimensions?.group === "provider" ? row.dimensions.providerID : "" })}>Models</button></Show><UsageStatisticsDetails tokens={row.tokens} speed={row.speed} cost={reportCost(row)} /></th><td>{count(row.physical)}</td><td>{count(tokenCount(row.tokens))}</td><td>{count(row.tokens.input)}</td><td>{count(row.tokens.output)}</td><td>{count(row.tokens.reasoning)}</td><td>{count(row.tokens.cache.read)}</td><td>{count(row.tokens.cache.write)}</td><td class="usage-table__cost">{reportCostText(row)}<Show when={row.costProvenance === "current_catalog"}><small>estimate</small></Show></td><td>{speedCells(row.speed).average}</td><td>{speedCells(row.speed).aggregate}</td><td>{speedCells(row.speed).ttft}</td></tr>
          }}</For></tbody></table></div>
          <div class="usage-breakdown__feedback" aria-live="polite"><Show when={updating()}><span role="status">{view().kind === "preparing" ? "Preparing" : "Loading"} {names[group()].toLowerCase()} report…</span></Show><Show when={view().kind === "error"}>{(() => { const current = view(); return <span role="alert">{current.kind === "error" ? current.message : ""} <button type="button" onClick={retry}>Retry</button></span> })()}</Show></div>
          <div class="usage-pagination"><span>Showing {(shownInput().offset ?? 0) + 1}–{(shownInput().offset ?? 0) + (displayed()?.rows.length ?? 0)} of {count(displayed()?.rowCount ?? 0)}</span><div><button type="button" aria-label="Previous breakdown page" title="Previous page" disabled={updating() || (shownInput().offset ?? 0) === 0} onClick={previousPage}><Icon name="arrow-left" /><span class="usage-action-label">Previous</span></button><button type="button" aria-label="Next breakdown page" title="Next page" disabled={updating() || displayed()?.nextOffset === undefined} onClick={nextPage}><span class="usage-action-label">Next</span><Icon name="arrow-right" /></button></div></div>
          <Show when={reportCostText(displayed()!.total) !== ""}><p class="usage-scope-total">Full scope: {reportCostText(displayed()!.total)}</p></Show>
        </Show></Show>
      </div>
    </section>
    <ModelIncidents phone={usagePhone.phone()} ordinal={numbers().incidents} />
    <footer class="usage-cost-note">Costs are estimates from recorded usage and model pricing, not provider bills. Analytics use configurable request-date retention (default 30 days), independently of Session deletion. Session-owned prompt and task views can have a shorter retained history.</footer>
  </div>
}

function ProviderCard(props: { readonly provider: () => UsageProvider; readonly now: number; readonly forecasts?: RemoteUsageForecast["quotas"]; readonly forecastAsOf?: number; readonly forecastState: string }) {
  const label = (value: string) => value.replaceAll("_", " ")
  const heading = () => providerHeading(props.provider())
  const forecastFor = (window: UsageWindow) => matchingQuotaForecast(props.provider(), window, props.forecasts)
  const detailGroups = () => [
    { lines: providerProvenanceLines(props.provider()) },
    ...props.provider().windows.flatMap((window) => {
      const forecast = forecastFor(window)
      return forecast === undefined ? [] : [{ title: window.label, lines: forecastDetails(forecast, props.now, props.forecastAsOf) }]
    }),
  ]
  return <article class="usage-provider" data-provider-id={props.provider().providerID}>
    <header class="usage-provider__head"><div class="usage-provider__identity"><h3><ProviderLogo providerID={props.provider().providerID} />{heading().name}</h3><span class={`usage-status usage-status--${props.provider().status}`} title={label(props.provider().status)} aria-label={`${label(props.provider().status)} quota status`} /><Show when={heading().plan}><span class="usage-provider__plan">{heading().plan}</span></Show><Show when={props.provider().status !== "available"}><span class="usage-provider__state">{label(props.provider().status)}</span></Show></div>
      <span class="usage-provider__freshness">{props.provider().status === "error" ? "Checked" : "Synced"} <time datetime={new Date(props.provider().updatedAt).toISOString()}>{relativeFreshness(props.provider().updatedAt, props.now)}</time></span></header>
    <Show when={props.provider().windows.length > 0} fallback={<p class="usage-provider__empty">{props.provider().message ?? "This provider has not reported any quota metrics."}</p>}>
      <div class="usage-provider__windows"><For each={props.provider().windows.map((window) => window.id)}>{(id, index) => {
        const initial = props.provider().windows.find((window) => window.id === id)!
        const window = () => props.provider().windows.find((item) => item.id === id) ?? initial
        return <>
          <Show when={quotaGroupHeading(props.provider().windows, index())}>{(group) => <h4 class="usage-window-group">{group()}</h4>}</Show>
          <QuotaRow window={window} now={props.now} forecast={forecastFor(window())} forecastAsOf={props.forecastAsOf} forecastState={props.forecastState} />
        </>
      }}</For></div>
    </Show>
    <UsageDetails label={heading().name} groups={detailGroups()} />
  </article>
}

function QuotaRow(props: { readonly window: () => UsageWindow; readonly now: number; readonly forecast?: NonNullable<RemoteUsageForecast["quotas"]>[number]; readonly forecastAsOf?: number; readonly forecastState: string }) {
  const quota = () => quotaWindow(props.window(), props.now)
  const exhausted = () => quota().exhausted || props.forecast?.state === "exhausted"
  return <div class="usage-window" classList={{ "usage-window--exhausted": exhausted() }}><div class="usage-window__top"><span><strong>{props.window().label}</strong><Show when={quota().used}> <b>{quota().used} used</b></Show><Show when={quota().limit}> of {quota().limit}</Show><Show when={quota().remaining && !quota().used}> <b>{quota().remaining} remaining</b></Show></span>
      <Show when={exhausted()} fallback={<Show when={quota().pace}><span class={`usage-pace usage-pace--${quota().pace === "Ahead of pace" ? "ahead" : quota().pace === "Below pace" ? "below" : "on"}`}>{quota().pace?.toLowerCase()}</span></Show>}><span class="usage-pace usage-pace--exhausted">exhausted</span></Show>
    </div>
    <Show when={quota().fill !== undefined}><div class="usage-meter" role="progressbar" aria-label={`${props.window().label} used`} aria-valuenow={quota().fill} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${quota().fill}%` }} /></div></Show>
    <div class="usage-window__details"><Show when={quota().reset}><span>{quota().reset}</span></Show><Show when={quota().remaining && quota().used}><span>{quota().remaining} {props.window().unit === "usd" ? "remaining" : "left"}</span></Show><Show when={props.window().unlimited}><span>Unlimited</span></Show></div>
    <Show when={props.forecast} fallback={<p class="usage-window__details">Forecast {props.forecastState === "loading" || props.forecastState === "idle" ? "loading" : "unavailable"}{props.forecastState === "unsupported" ? " · Update YCoding on this machine" : props.forecastState === "error" ? " · lookup failed; refresh quotas to retry" : props.forecastState === "ready" ? " · No matching quota observation" : ""}</p>}>{(value) => <QuotaForecastStatus forecast={value()} asOf={props.forecastAsOf ?? props.now} />}</Show>
  </div>
}
