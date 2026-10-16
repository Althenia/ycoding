import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useRemote } from "../context"
import { createRemoteQuery } from "../query"
import { usageRead } from "../queries"
import { Icon } from "../../ui/icon"
import { LoadingPlaceholder } from "./loading"
import type { RemoteUsageForecast } from "@ycoding-ai/remote"
import { UsageFilterControls, UsageGroupControl } from "./usage-filters"
import { usageGroups, type UsageFiltersPresentation } from "./usage-filter-model"
import { ModelIncidents } from "./model-incidents"
import { QuotaForecastBlock, UsageStatisticsDetails } from "./usage-cost"
import { compactUsageTotal, dailySpend, donutGeometry, matchingQuotaForecast, reportIdentity, reportLabel, reportCost, reportCostText, money, providerDistribution, providerHeading, quotaWindow, relativeFreshness, spendMetrics, spendCostText, tokenCount, tooltipPosition, usageReportInputs, unsupportedReportMessage, usageZoneKey, visibleProviders, type SpendDay, type UsageProvider, type UsageReport, type UsageReportInput, type UsageBreakdown, type UsageReportRow, type UsageWindow } from "./usage-model"
import "./usage.css"

const groups = usageGroups.map((group) => group.value)
type BreakdownInput = UsageReportInput & UsageBreakdown
const names = { model: "Model", session: "Session", project: "Project", agent: "Agent", provider: "Provider", "provider-profile-model": "Provider / profile / model", "provider-model": "Provider / model", "model-id": "Model ID", profile: "Profile", prompt: "Prompt", task: "Task" }
const columns = [
  { key: "steps", label: "Steps" }, { key: "tokens", label: "Tokens" }, { key: "input", label: "Input" },
  { key: "output", label: "Output" }, { key: "reasoning", label: "Reasoning" }, { key: "cacheRead", label: "Cache read" }, { key: "cacheWrite", label: "Cache write" }, { key: "cost", label: "Cost" },
] as const
const count = (value: number) => new Intl.NumberFormat().format(value)
const distributionColors = ["var(--yc-green-strong)", "var(--yc-yellow-strong)", "var(--yc-text-muted)", "var(--yc-green)", "var(--yc-border-strong)"]
const tileIDs = ["today", "yesterday", "last30"] as const
const tileLabels = { today: "Today", yesterday: "Yesterday", last30: "Last 30 days" }
const providerKey = (provider: UsageProvider) => `${provider.providerID}\u0000${provider.profile ?? ""}`

export function UsagePage() {
  const remote = useRemote()
  const openedAt = Date.now()
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [now, setNow] = createSignal(Date.now())
  const [zoneMode, setZoneMode] = createSignal<"utc" | "local">(localStorage.getItem(usageZoneKey) === "local" ? "local" : "utc")
  const [group, setGroup] = createSignal<(typeof groups)[number]>("model")
  const [filters, setFilters] = createSignal<UsageFiltersPresentation>({ provider: "", profile: "", model: "", effort: "", range: "last30" })
  const [sort, setSort] = createSignal<UsageReportInput["sort"]>("cost")
  const [order, setOrder] = createSignal<UsageReportInput["order"]>("desc")
  const [offset, setOffset] = createSignal(0)
  const [tableOpen, setTableOpen] = createSignal(false)
  const [breakdownTableOpen, setBreakdownTableOpen] = createSignal(false)
  const [distributionMetric, setDistributionMetric] = createSignal<"spend" | "tokens">("spend")
  const [compactTotal, setCompactTotal] = createSignal(true)
  const [shownBreakdown, setShownBreakdown] = createSignal<{ readonly deviceID: string; readonly report: UsageReport; readonly input: BreakdownInput }>()
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
  const dailyInput = createMemo<UsageReportInput>(() => reports().daily)
  const monthlyInput = createMemo<UsageReportInput>(() => reports().monthly)
  const breakdownInput = createMemo<BreakdownInput>(() => reports().breakdown)
  const providersQuery = createRemoteQuery(remote.store.queryClient, () => remote.queries.usageProviders(remote.scope(), connected()))
  const forecastQuery = createRemoteQuery(remote.store.queryClient, () => remote.queries.usageForecast(remote.scope(), connected()))
  const forecast = () => usageRead(forecastQuery())
  const forecastData = () => forecast().status === "error" ? undefined : forecast().data
  const quotaForecastState = () => forecast().status === "ready" && forecastData()?.quotas === undefined ? "error" : forecast().status
  createRemoteQuery(remote.store.queryClient, () => remote.queries.usageSummary(remote.scope(), connected()))
  const dailyQuery = createRemoteQuery(remote.store.queryClient, () => remote.queries.usageReport(remote.scope(), connected(), dailyInput()))
  const monthlyQuery = createRemoteQuery(remote.store.queryClient, () => remote.queries.usageReport(remote.scope(), connected(), monthlyInput()))
  const breakdownQuery = createRemoteQuery(remote.store.queryClient, () => remote.queries.usageReport(remote.scope(), connected(), breakdownInput()))
  const providerRead = () => usageRead(providersQuery())
  const daily = () => usageRead(dailyQuery())
  const monthly = () => usageRead(monthlyQuery())
  const breakdown = () => usageRead(breakdownQuery())
  const retryReport = (input: UsageReportInput) => {
    const scope = remote.scope()
    if (scope !== undefined) void remote.queries.retryUsageReport(scope, input)
  }
  const providerData = () => providerRead().data
  const dailyData = () => daily().data
  const monthlyData = () => monthly().data
  const displayed = () => breakdown().status !== "unsupported" && shownBreakdown()?.deviceID === remote.state().activeDeviceID && shownBreakdown()?.input.timeZone === selectedZone() ? shownBreakdown()?.report : undefined
  const updating = () => shownBreakdown() !== undefined && (breakdown().status === "idle" || breakdown().status === "loading")
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
    const next = Math.max(0, (shownBreakdown()?.input.offset ?? 0) - 25)
    setOffset(next)
  }
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
      setShownBreakdown(undefined)
      setMinimumRowsHeight(0)
      return
    }
    const result = breakdown()
    if (result.status === "ready" && result.data && (shownBreakdown()?.report !== result.data || shownBreakdown()?.input !== breakdownInput()))
      setShownBreakdown({ deviceID: current, report: result.data, input: breakdownInput() })
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

  return <div class="usage-page">
    <header class="usage-head"><div class="usage-head__title"><h1>Usage</h1><p>Quotas and spend from {machine() ?? "your machine"}</p></div>
      <div class="usage-head__actions"><Show when={latest() !== undefined}><span class="usage-head__freshness">Updated {relativeFreshness(latest()!, now())}</span></Show>
        <div class={`usage-zone usage-toggle${zoneMode() === "local" ? " usage-zone--local" : ""}`} role="group" aria-label="Usage time zone">
          <button type="button" aria-pressed={zoneMode() === "utc"} onClick={() => setZoneMode("utc")}>UTC</button>
          <button type="button" aria-pressed={zoneMode() === "local"} onClick={() => setZoneMode("local")}>Local</button>
        </div>
        <button class="usage-refresh" type="button" aria-label="Refresh quotas" title="Refresh quotas" aria-busy={providerRead().status === "loading" ? "true" : "false"} disabled={providerRead().status === "loading" || remote.state().transport.kind !== "open"} onClick={() => { const scope = remote.scope(); if (scope !== undefined) void remote.queries.refreshUsage(scope) }}><Icon name="refresh" /></button>
      </div>
    </header>

    <section class="usage-quotas" aria-labelledby="usage-allowances">
      <h2 class="visually-hidden" id="usage-allowances">Provider quotas</h2>
      <Show when={!providerData() && providerRead().status === "unsupported"}><p class="usage-message" role="status">Update YCoding on this machine to see usage.</p></Show>
      <Show when={!providerData() && providerRead().status === "error"}><p class="usage-message" role="alert">{providerRead().message ?? "Usage could not be loaded."}</p></Show>
      <Show when={providerData() && providerRead().status === "error"}><p class="usage-message" role="alert">{providerRead().message ?? "Usage could not be loaded."}</p></Show>
      <Show when={!providerData() && remote.state().transport.kind !== "open" && providerRead().status === "idle"}><p class="usage-message" role="status">Connect to a machine to see usage.</p></Show>
      <Show when={!providerData() && providerRead().status === "loading"}><LoadingPlaceholder kind="usage" label="Loading provider quotas…" /></Show>
      <Show when={providerData() && providerRead().status === "ready" && providers().length === 0}><p class="usage-message">No connected provider reports quotas.</p></Show>
      <div class="usage-providers"><For each={providerKeys()}>{(key) => {
        const initial = providers().find((provider) => providerKey(provider) === key)!
        return <ProviderCard provider={() => providers().find((provider) => providerKey(provider) === key) ?? initial} now={now()} forecasts={forecastData()?.quotas} forecastAsOf={forecastData()?.asOf} forecastState={quotaForecastState()} />
      }}</For></div>
    </section>

    <Show when={forecastData()}><section class="usage-breakdown-section" aria-label="Recorded token consumption"><h2>Recorded consumption · Backend</h2>
      <For each={forecastData()?.localRates}>{(rate) => <p class="usage-message">{rate.providerID}{rate.profile ? ` · profile ${rate.profile}` : " · provider default at request time"}{rate.modelID ? ` · ${rate.modelID}` : ""}: {count(rate.tokensPerMinute)} tokens/min · 5m {rate.tokensPerMinute5 === undefined ? "unreported" : count(rate.tokensPerMinute5)} · 60m {rate.tokensPerMinute60 === undefined ? "unreported" : count(rate.tokensPerMinute60)}<Show when={rate.estimatedUSDPerHour !== undefined}> · {money(rate.estimatedUSDPerHour!)} estimated/hour</Show> · {rate.coverage.pricedRequests} priced / {rate.coverage.unpricedRequests} unpriced · observed {new Date(rate.observedFrom).toISOString()} – {new Date(rate.observedTo).toISOString()}</p>}</For>
      <Show when={forecastData()?.localRates === undefined}><p class="usage-message">Recorded consumption unreported · lookup unavailable.</p></Show>
      <Show when={forecastData()?.localRates?.length === 0}><p class="usage-message">No recorded consumption in the observation window.</p></Show>
    </section></Show>

    <section class="usage-spend" aria-labelledby="usage-spend-title">
      <h2 class="visually-hidden" id="usage-spend-title">Spend overview</h2>
      <Show when={dailyData()}>
        <div class="usage-tiles"><For each={tileIDs}>{(id) => <article class="usage-tile">
          <h3>{tileLabels[id]}</h3><strong>{spendCostText(tileValue(id))}</strong>
          <p class="usage-tile__meta"><span>{count(tileValue(id).requests)} requests</span><span>{count(tileValue(id).tokens)} tokens</span></p>
          <Show when={id === "last30"}><svg viewBox="0 0 100 32" aria-label="Spend trend over the last 30 days" role="img" preserveAspectRatio="none"><polyline points={sparkline()} /></svg></Show>
        </article>}</For></div>
      </Show>
      <div class="usage-visuals">
        <div class="usage-chart" ref={dayCard}>
          <div class="usage-chart__head"><div><h3>Daily spend (last 30 {zoneLabel()} days)</h3><p>{zoneLabel()} day boundary · Today highlighted</p></div><button type="button" aria-expanded={tableOpen()} aria-controls="usage-daily-table" onClick={() => setTableOpen(!tableOpen())}>{tableOpen() ? "Hide table" : "View table"}</button></div>
          <Show when={dailyData() && daily()?.status === "error"}><p class="usage-message" role="alert">{daily()?.message ?? "Daily usage could not be loaded."} <button type="button" onClick={() => retryReport(dailyInput())}>Retry</button></p></Show>
          <Show when={dailyData()} fallback={<Show when={daily()?.status === "unsupported" || daily()?.status === "error"} fallback={<Show when={connected()}><LoadingPlaceholder kind="chart" label="Loading daily spend…" /></Show>}>
            <p class="usage-message" role={daily()?.status === "error" ? "alert" : "status"}>{daily()?.status === "unsupported" ? zoneMode() === "local" ? "Update YCoding on this machine to see Local usage. Switch to UTC to continue." : "Update YCoding on this machine to see usage." : daily()?.message}<Show when={daily()?.status === "error"}> <button type="button" onClick={() => retryReport(dailyInput())}>Retry</button></Show></p>
          </Show>}>
            <p class="usage-chart__today">Today: {spendCostText(tileValue("today"))} · {count(days().at(-1)?.requests ?? 0)} requests</p>
            <svg viewBox="0 0 900 180" role="img" aria-label="Daily cost over the last 30 days, with exact values in the table" preserveAspectRatio="none">
              <line x1="0" y1="156" x2="900" y2="156" class="usage-chart__axis" />
              <For each={dayKeys()}>{(key, index) => {
                const entry = () => days().find((item) => item.key === key)!
                const height = () => entry().cost === 0 ? 2 : Math.max(4, entry().cost / Math.max(1, ...days().map((item) => item.cost)) * 138)
                return <rect x={index() * 30 + 7} y={156 - height()} width="16" height={height()} rx="2" class={index() === 29 ? "usage-chart__bar usage-chart__bar--today" : "usage-chart__bar"}
                  tabindex="0" role="img" data-cursor="action" aria-label={`${key}: estimated cost ${spendCostText(entry())}, ${count(entry().requests)} requests, ${count(entry().tokens)} tokens`}
                  onPointerEnter={(event) => { if (event.pointerType !== "touch") { setActiveDay(entry()); queueMicrotask(() => placeDay(event.clientX, event.clientY)) } }}
                  onPointerMove={(event) => { if (event.pointerType !== "touch") placeDay(event.clientX, event.clientY) }} onPointerLeave={(event) => { if (event.pointerType !== "touch") setActiveDay(undefined) }}
                  onFocus={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setActiveDay(entry()); queueMicrotask(() => placeDay(rect.left + rect.width / 2, rect.top + rect.height / 2)) }}
                  onBlur={() => setActiveDay(undefined)} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setActiveDay(entry()); queueMicrotask(() => placeDay(event.clientX || rect.left + rect.width / 2, event.clientY || rect.top + rect.height / 2)) }} />
              }}</For>
            </svg>
            <Show when={activeDay()}>{(entry) => <div class="usage-chart__tooltip" ref={dayTooltip} style={{ left: `${dayPosition().left}px`, top: `${dayPosition().top}px` }} role="status"><strong>{entry().key}</strong><span>Estimated cost {spendCostText(entry())}</span><span>{count(entry().requests)} requests · {count(entry().tokens)} tokens</span></div>}</Show>
            <div class="usage-chart__labels"><span>{days()[0]?.label}</span><span>{days()[14]?.label}</span><span>Today</span></div>
            <Show when={tableOpen()}><div id="usage-daily-table" class="usage-table-wrap"><table><caption>Daily usage, last 30 {zoneLabel()} days</caption><thead><tr><th scope="col">Day</th><th scope="col">Cost</th><th scope="col">Tokens</th><th scope="col">Requests</th></tr></thead><tbody><For each={[...days()].reverse()}>{(entry) => <tr><th scope="row">{entry.key}</th><td>{spendCostText(entry)}</td><td>{count(entry.tokens)}</td><td>{count(entry.requests)}</td></tr>}</For></tbody></table></div></Show>
          </Show>
        </div>
        <div class="usage-distribution" ref={providerCard} aria-labelledby="usage-distribution-title">
          <Show when={monthlyData()}>{(value) => <p class="usage-message">Pricing: {reportCostText(value().total)}</p>}</Show>
          <div class="usage-distribution__head"><div><h3 id="usage-distribution-title">Provider distribution (current {zoneLabel()} month)</h3><p>Current {zoneLabel()} month</p></div>
            <div class="usage-distribution__controls"><div class={`usage-toggle${distributionMetric() === "tokens" ? " usage-toggle--tokens" : ""}`} role="group" aria-label="Distribution metric">
              <button type="button" aria-pressed={distributionMetric() === "spend"} onClick={() => setDistributionMetric("spend")}>Spend</button>
              <button type="button" aria-pressed={distributionMetric() === "tokens"} onClick={() => setDistributionMetric("tokens")}>Tokens</button>
            </div></div>
          </div>
          <Show when={monthlyData() && monthly()?.status === "error"}><p class="usage-message" role="alert">{monthly()?.message ?? "Monthly usage could not be loaded."} <button type="button" onClick={() => retryReport(monthlyInput())}>Retry</button></p></Show>
          <Show when={!monthlyData() && connected() && (monthly()?.status === "loading" || monthly() === undefined)}><LoadingPlaceholder kind="chart" label="Loading monthly usage…" /></Show>
          <Show when={!monthlyData() && monthly()?.status === "unsupported"}><p class="usage-distribution__empty">{zoneMode() === "local" ? "Update YCoding on this machine to see Local usage. Switch to UTC to continue." : "Update YCoding on this machine to see monthly usage."}</p></Show>
          <Show when={!monthlyData() && monthly()?.status === "error"}><p class="usage-distribution__empty" role="alert">{monthly()?.message} <button type="button" onClick={() => retryReport(monthlyInput())}>Retry</button></p></Show>
          <Show when={monthlyData()}><Show when={distribution().total > 0} fallback={<p class="usage-distribution__empty">{distributionMetric() === "spend" ? `Cost ${reportCostText(monthlyData()!.total)} · no positive known spend this month.` : "No recorded tokens this month."}</p>}>
            <div class="usage-distribution__body">
              <div class="usage-distribution__chart" ref={distributionChart}>
              <svg class="usage-donut" viewBox="0 0 200 200" role="img" aria-label={`${distributionMetric() === "spend" ? "Estimated spend" : "Tokens"} by provider this ${zoneLabel()} month; exact values are available in the legend`}>
                <circle class="usage-donut__track" cx="100" cy="100" r="72" fill="none" stroke-width="26" />
                <For each={segmentIDs()}>{(id, index) => {
                  const initial = arcs().find((segment) => segment.providerID === id)!
                  const segment = () => arcs().find((item) => item.providerID === id) ?? initial
                  return <circle class="usage-donut__arc" cx="100" cy="100" r="72" fill="none" stroke-width="26"
                    style={{ stroke: distributionColors[index() % distributionColors.length], "--usage-dash": `${segment().length} ${segment().circumference - segment().length}`, "--usage-circumference": segment().circumference, "stroke-dashoffset": segment().offset }}
                    tabindex="0" role="img" data-cursor="action" aria-label={`${segment().label}: cost ${segment().costLabel ?? "unreported"}, ${Math.round(segment().share * 100)}% share${distributionMetric() === "tokens" ? `, ${count(segment().value)} tokens` : ""}`}
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
              <Show when={activeSegment()}>{(segment) => <div class="usage-distribution__tooltip" ref={providerTooltip} style={{ left: `${providerPosition().left}px`, top: `${providerPosition().top}px` }} role="status"><strong>{segment().label}</strong><span>Cost {segment().costLabel ?? "unreported"} · {Math.round(segment().share * 100)}% share</span><Show when={distributionMetric() === "tokens"}><span>{count(segment().value)} tokens</span></Show></div>}</Show>
              <ul class="usage-distribution__legend" aria-label={distributionMetric() === "spend" ? "Providers by estimated spend in USD" : "Providers by tokens"}><For each={segmentIDs()}>{(id, index) => {
                const initial = distribution().segments.find((segment) => segment.providerID === id)!
                const segment = () => distribution().segments.find((item) => item.providerID === id) ?? initial
                return <li>
                <span class="usage-distribution__swatch" style={{ background: distributionColors[index() % distributionColors.length] }} aria-hidden="true" />
                <span class="usage-distribution__name">{segment().label}</span><span>{Math.round(segment().share * 100)}%</span><strong>{distributionMetric() === "spend" ? segment().costLabel ?? "unreported" : count(segment().value)}</strong>
              </li>
              }}</For></ul>
            </div>
          </Show></Show>
        </div>
      </div>
    </section>

    <section class="usage-breakdown-section" aria-labelledby="usage-breakdown-title">
      <div class="usage-breakdown__head"><h2 id="usage-breakdown-title">Breakdown</h2><Show when={displayed()?.rows.length}><span class="usage-breakdown__summary">Showing {(shownBreakdown()?.input.offset ?? 0) + 1}–{(shownBreakdown()?.input.offset ?? 0) + (displayed()?.rows.length ?? 0)} of {count(displayed()?.rowCount ?? 0)} {names[shownBreakdown()?.input.group ?? group()].toLowerCase()}s</span></Show>
      <UsageGroupControl value={group()} onChange={selectGroup} /></div>
      <UsageFilterControls value={filters()} providers={[...new Map((providerRead().data ?? []).map((provider) => [provider.providerID, { id: provider.providerID, label: providerHeading(provider).name }])).values()]} onChange={(value) => { holdRows(); batch(() => { setFilters(value); setOffset(0) }) }} />
      <Show when={group() === "task"}><p class="usage-message">Inclusive task rows overlap; do not add them for a family total.</p></Show>
      <div id="usage-breakdown-panel" role="region" aria-label={`${names[group()]} usage breakdown`} class="usage-breakdown" aria-busy={updating() ? "true" : "false"}>
        <Show when={!displayed() && remote.state().transport.kind === "open" && (breakdown().status === "loading" || breakdown().status === "idle")}><LoadingPlaceholder kind="usage" label="Loading breakdown…" /></Show>
        <Show when={!displayed() && breakdown()?.status === "unsupported"}><p class="usage-message" role="status">{unsupportedReportMessage(breakdownInput())}</p></Show>
        <Show when={!displayed() && breakdown()?.status === "error"}><p class="usage-message" role="alert">{breakdown()?.message}</p></Show>
        <Show when={displayed()}><Show when={(displayed()?.rows.length ?? 0) > 0} fallback={<p class="usage-message">No requests in this period.</p>}>
          <div class="usage-breakdown__mobile" ref={mobileRows} style={{ "min-height": `${minimumRowsHeight()}px` }}><For each={displayed()?.rows}>{(row: UsageReportRow) => {
            const identity = () => shownBreakdown()?.input.group === "model" || row.dimensions ? reportIdentity(row, providerRead().data ?? []) : undefined
            return <article class="usage-mobile-row"><div class="usage-mobile-row__top"><div><strong>{identity()?.model ?? reportLabel(row, shownBreakdown()?.input.group ?? group())}</strong><Show when={identity()}><span class="usage-provider-chip">{identity()?.provider}</span></Show></div><b>{reportCostText(row)}</b></div>
              <p>{count(row.physical)} requests · {count(row.tokens.input)} in / {count(row.tokens.output)} out<Show when={row.tokens.cache.read > 0}> · {count(row.tokens.cache.read)} cache read</Show></p>
              <UsageStatisticsDetails tokens={row.tokens} speed={row.speed} cost={reportCost(row)} />
            </article>
          }}</For></div>
          <button class="usage-breakdown__table-toggle" type="button" aria-expanded={breakdownTableOpen()} aria-controls="usage-breakdown-table" onClick={() => setBreakdownTableOpen(!breakdownTableOpen())}>{breakdownTableOpen() ? "Hide table" : "View table"}</button>
          <div id="usage-breakdown-table" class="usage-table-wrap usage-breakdown__table" classList={{ "usage-breakdown__table--open": breakdownTableOpen() }}><table><caption>{names[shownBreakdown()?.input.group ?? group()]} by usage</caption><thead><tr><th scope="col"><button type="button" aria-label={`Sort by ${names[group()]}`} onClick={() => setSorting("key")}>{names[group()]} {sort() === "key" ? order() === "asc" ? "↑" : "↓" : "↕"}</button></th><For each={columns}>{(column) => <th scope="col"><button type="button" aria-label={`Sort by ${column.label}`} onClick={() => setSorting(column.key)}>{column.label} {sort() === column.key ? order() === "asc" ? "↑" : "↓" : "↕"}</button></th>}</For></tr></thead><tbody><For each={displayed()?.rows}>{(row: UsageReportRow) => {
            const identity = () => shownBreakdown()?.input.group === "model" || row.dimensions ? reportIdentity(row, providerRead().data ?? []) : undefined
            return <tr><th scope="row"><span>{identity()?.model ?? reportLabel(row, shownBreakdown()?.input.group ?? group())}</span><Show when={identity()}><span class="usage-provider-chip">{identity()?.provider}</span></Show><UsageStatisticsDetails tokens={row.tokens} speed={row.speed} cost={reportCost(row)} /></th><td>{count(row.logical)}</td><td>{count(tokenCount(row.tokens))}</td><td>{count(row.tokens.input)}</td><td>{count(row.tokens.output)}</td><td>{count(row.tokens.reasoning)}</td><td>{count(row.tokens.cache.read)}</td><td>{count(row.tokens.cache.write)}</td><td class="usage-table__cost">{reportCostText(row)}<Show when={row.costProvenance === "current_catalog"}><small>estimate</small></Show></td></tr>
          }}</For></tbody></table></div>
          <div class="usage-breakdown__feedback" aria-live="polite"><Show when={updating()}><span role="status">Loading {names[group()].toLowerCase()} report…</span></Show><Show when={breakdown()?.status === "error"}><span role="alert">{breakdown()?.message} <button type="button" onClick={() => retryReport(breakdownInput())}>Retry</button></span></Show></div>
          <div class="usage-pagination"><span>Showing {(shownBreakdown()?.input.offset ?? 0) + 1}–{(shownBreakdown()?.input.offset ?? 0) + (displayed()?.rows.length ?? 0)} of {count(displayed()?.rowCount ?? 0)}</span><div><button type="button" disabled={updating() || (shownBreakdown()?.input.offset ?? 0) === 0} onClick={previousPage}>Previous</button><button type="button" disabled={updating() || displayed()?.nextOffset === undefined} onClick={nextPage}>Next</button></div></div>
          <p class="usage-message">Full scope: {displayed() ? reportCostText(displayed()!.total) : "unreported"}</p>
        </Show></Show>
      </div>
    </section>
    <ModelIncidents />
    <footer class="usage-cost-note">Costs are estimates from recorded usage and model pricing, not provider bills. Analytics use configurable request-date retention (default 30 days), independently of Session deletion. Session-owned prompt and task views can have a shorter retained history.</footer>
  </div>
}

function ProviderCard(props: { readonly provider: () => UsageProvider; readonly now: number; readonly forecasts?: RemoteUsageForecast["quotas"]; readonly forecastAsOf?: number; readonly forecastState: string }) {
  const label = (value: string) => value.replaceAll("_", " ")
  const heading = () => providerHeading(props.provider())
  const updated = () => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(props.provider().updatedAt)
  const provenance = () => `Updated ${updated()} — source: ${label(props.provider().source).replace("api", "API")}, stability: ${label(props.provider().stability)}`
  return <article class="usage-provider">
    <header class="usage-provider__head"><div class="usage-provider__identity"><span class={`usage-status usage-status--${props.provider().status}`} title={label(props.provider().status)} aria-label={`${label(props.provider().status)} quota status`} /><h3>{heading().name}</h3><Show when={heading().plan}><span class="usage-provider__plan">{heading().plan}</span></Show><Show when={props.provider().status !== "available"}><span class="usage-provider__state">{label(props.provider().status)}</span></Show></div>
      <span class="usage-provider__freshness">{props.provider().status === "error" ? "Checked" : "Synced"} <time datetime={new Date(props.provider().updatedAt).toISOString()} title={provenance()} aria-label={provenance()}>{relativeFreshness(props.provider().updatedAt, props.now)}</time></span></header>
    <Show when={props.provider().windows.length > 0} fallback={<p class="usage-provider__empty">{props.provider().message ?? "This provider has not reported any quota metrics."}</p>}>
      <div class="usage-provider__windows"><For each={props.provider().windows.map((window) => window.id)}>{(id) => {
        const initial = props.provider().windows.find((window) => window.id === id)!
        return <QuotaRow window={() => props.provider().windows.find((window) => window.id === id) ?? initial} now={props.now} forecast={matchingQuotaForecast(props.provider(), props.provider().windows.find((window) => window.id === id) ?? initial, props.forecasts)} forecastAsOf={props.forecastAsOf} forecastState={props.forecastState} />
      }}</For></div>
    </Show>
  </article>
}

function QuotaRow(props: { readonly window: () => UsageWindow; readonly now: number; readonly forecast?: NonNullable<RemoteUsageForecast["quotas"]>[number]; readonly forecastAsOf?: number; readonly forecastState: string }) {
  const quota = () => quotaWindow(props.window(), props.now)
  return <div class="usage-window"><div class="usage-window__top"><span><strong>{props.window().label}</strong><Show when={quota().used}> <b>{quota().used} used</b></Show><Show when={quota().limit}> of {quota().limit}</Show><Show when={quota().remaining && !quota().used}> <b>{quota().remaining} remaining</b></Show></span>
      <Show when={quota().pace}><span class={`usage-pace usage-pace--${quota().pace === "Ahead of pace" ? "ahead" : quota().pace === "Below pace" ? "below" : "on"}`}>{quota().pace?.toLowerCase()}</span></Show>
    </div>
    <Show when={quota().fill !== undefined}><div class="usage-meter" role="progressbar" aria-label={`${props.window().label} used`} aria-valuenow={quota().fill} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${quota().fill}%` }} /></div></Show>
    <div class="usage-window__details"><Show when={quota().reset}><span>{quota().reset}</span></Show><Show when={quota().remaining && quota().used}><span>{quota().remaining} {props.window().unit === "usd" ? "remaining" : "left"}</span></Show><Show when={props.window().unlimited}><span>Unlimited</span></Show></div>
    <Show when={props.forecast} fallback={<p class="usage-window__details">Forecast {props.forecastState === "loading" || props.forecastState === "idle" ? "loading" : "unavailable"}{props.forecastState === "unsupported" ? " · Update YCoding on this machine" : props.forecastState === "error" ? " · lookup failed; refresh quotas to retry" : props.forecastState === "ready" ? " · No matching quota observation" : ""}</p>}>{(value) => <QuotaForecastBlock forecast={value()} now={props.now} asOf={props.forecastAsOf} />}</Show>
  </div>
}
