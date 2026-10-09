import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useRemote } from "../context"
import { createRemoteQuery } from "../query"
import { usageRead } from "../queries"
import { LoadingPlaceholder } from "./loading"
import { dailySpend, donutGeometry, modelIdentity, money, providerDistribution, providerHeading, quotaWindow, relativeFreshness, spendMetrics, tokenCount, tooltipPosition, usageReportInputs, usageZoneKey, visibleProviders, type SpendDay, type UsageProvider, type UsageReport, type UsageReportInput, type UsageBreakdown, type UsageReportRow, type UsageWindow } from "./usage-model"
import "./usage.css"

const groups = ["model", "session", "project", "agent"] as const
type BreakdownInput = UsageReportInput & UsageBreakdown
const names = { model: "Model", session: "Session", project: "Project", agent: "Agent" }
const columns = [
  { key: "steps", label: "Steps" }, { key: "tokens", label: "Tokens" }, { key: "input", label: "Input" },
  { key: "output", label: "Output" }, { key: "reasoning", label: "Reasoning" }, { key: "cacheRead", label: "Cache read" }, { key: "cost", label: "Cost" },
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
  const [sort, setSort] = createSignal<UsageReportInput["sort"]>("cost")
  const [order, setOrder] = createSignal<UsageReportInput["order"]>("desc")
  const [offset, setOffset] = createSignal(0)
  const [tableOpen, setTableOpen] = createSignal(false)
  const [breakdownTableOpen, setBreakdownTableOpen] = createSignal(false)
  const [distributionMetric, setDistributionMetric] = createSignal<"spend" | "tokens">("spend")
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
  let deviceID = remote.state().activeDeviceID
  const connected = createMemo(() => remote.state().transport.kind === "open")
  const selectedZone = () => zoneMode() === "local" ? localZone : undefined
  const zoneLabel = () => zoneMode() === "local" ? `Local · ${localZone}` : "UTC"
  const reports = createMemo(() => usageReportInputs(openedAt, selectedZone(), { group: group(), offset: offset(), sort: sort(), order: order() }))
  const dailyInput = createMemo<UsageReportInput>(() => reports().daily)
  const monthlyInput = createMemo<UsageReportInput>(() => reports().monthly)
  const breakdownInput = createMemo<BreakdownInput>(() => reports().breakdown)
  const providersQuery = createRemoteQuery(remote.store.queryClient, () => remote.queries.usageProviders(remote.scope(), connected()))
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
  const arcs = createMemo(() => donutGeometry(distribution().segments, 72))
  const segmentIDs = createMemo(() => distribution().segments.map((segment) => segment.providerID))
  const providerCosts = createMemo(() => new Map(providerDistribution(monthlyData(), providerData() ?? [], "spend").segments.map((segment) => [segment.providerID, segment.value])))
  const activeSegment = () => arcs().find((segment) => segment.providerID === activeProvider())
  const placeDay = (x: number, y: number) => {
    if (!dayCard || !dayTooltip) return
    setDayPosition(tooltipPosition(dayCard.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, { x, y }, dayTooltip.getBoundingClientRect()))
  }
  const placeProvider = (x: number, y: number) => {
    if (!providerCard || !providerTooltip) return
    setProviderPosition(tooltipPosition(providerCard.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, { x, y }, providerTooltip.getBoundingClientRect()))
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
    onCleanup(() => clearInterval(clock))
  })

  return <div class="usage-page">
    <header class="usage-head"><div class="usage-head__title"><h1>Usage</h1><p>Quotas and spend from {machine() ?? "your machine"}</p></div>
      <div class="usage-head__actions"><Show when={latest() !== undefined}><span class="usage-head__freshness">Updated {relativeFreshness(latest()!, now())}</span></Show>
        <div class={`usage-zone usage-toggle${zoneMode() === "local" ? " usage-zone--local" : ""}`} role="group" aria-label="Usage time zone">
          <button type="button" aria-pressed={zoneMode() === "utc"} onClick={() => setZoneMode("utc")}>UTC</button>
          <button type="button" aria-pressed={zoneMode() === "local"} onClick={() => setZoneMode("local")}>Local</button>
        </div>
        <button class="usage-refresh" type="button" disabled={providerRead().status === "loading" || remote.state().transport.kind !== "open"} onClick={() => { const scope = remote.scope(); if (scope !== undefined) void remote.queries.refreshUsage(scope) }}>Refresh quotas</button>
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
        return <ProviderCard provider={() => providers().find((provider) => providerKey(provider) === key) ?? initial} now={now()} />
      }}</For></div>
    </section>

    <section class="usage-spend" aria-labelledby="usage-spend-title">
      <h2 class="visually-hidden" id="usage-spend-title">Spend overview</h2>
      <Show when={dailyData()}>
        <div class="usage-tiles"><For each={tileIDs}>{(id) => <article class="usage-tile">
          <h3>{tileLabels[id]}</h3><strong>{money(tileValue(id).cost)}</strong>
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
            <p class="usage-chart__today">Today: {money(days().at(-1)?.cost ?? 0)} · {count(days().at(-1)?.requests ?? 0)} requests</p>
            <svg viewBox="0 0 900 180" role="img" aria-label="Daily cost over the last 30 days, with exact values in the table" preserveAspectRatio="none">
              <line x1="0" y1="156" x2="900" y2="156" class="usage-chart__axis" />
              <For each={dayKeys()}>{(key, index) => {
                const entry = () => days().find((item) => item.key === key)!
                const height = () => entry().cost === 0 ? 2 : Math.max(4, entry().cost / Math.max(1, ...days().map((item) => item.cost)) * 138)
                return <rect x={index() * 30 + 7} y={156 - height()} width="16" height={height()} rx="2" class={index() === 29 ? "usage-chart__bar usage-chart__bar--today" : "usage-chart__bar"}
                  tabindex="0" role="img" data-cursor="action" aria-label={`${key}: estimated cost ${money(entry().cost)}, ${count(entry().requests)} requests, ${count(entry().tokens)} tokens`}
                  onPointerEnter={(event) => { if (event.pointerType !== "touch") { setActiveDay(entry()); queueMicrotask(() => placeDay(event.clientX, event.clientY)) } }}
                  onPointerMove={(event) => { if (event.pointerType !== "touch") placeDay(event.clientX, event.clientY) }} onPointerLeave={(event) => { if (event.pointerType !== "touch") setActiveDay(undefined) }}
                  onFocus={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setActiveDay(entry()); queueMicrotask(() => placeDay(rect.left + rect.width / 2, rect.top + rect.height / 2)) }}
                  onBlur={() => setActiveDay(undefined)} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setActiveDay(entry()); queueMicrotask(() => placeDay(event.clientX || rect.left + rect.width / 2, event.clientY || rect.top + rect.height / 2)) }} />
              }}</For>
            </svg>
            <Show when={activeDay()}>{(entry) => <div class="usage-chart__tooltip" ref={dayTooltip} style={{ left: `${dayPosition().left}px`, top: `${dayPosition().top}px` }} role="status"><strong>{entry().key}</strong><span>Estimated cost {money(entry().cost)}</span><span>{count(entry().requests)} requests · {count(entry().tokens)} tokens</span></div>}</Show>
            <div class="usage-chart__labels"><span>{days()[0]?.label}</span><span>{days()[14]?.label}</span><span>Today</span></div>
            <Show when={tableOpen()}><div id="usage-daily-table" class="usage-table-wrap"><table><caption>Daily usage, last 30 {zoneLabel()} days</caption><thead><tr><th scope="col">Day</th><th scope="col">Cost</th><th scope="col">Tokens</th><th scope="col">Requests</th></tr></thead><tbody><For each={[...days()].reverse()}>{(entry) => <tr><th scope="row">{entry.key}</th><td>{money(entry.cost)}</td><td>{count(entry.tokens)}</td><td>{count(entry.requests)}</td></tr>}</For></tbody></table></div></Show>
          </Show>
        </div>
        <div class="usage-distribution" ref={providerCard} aria-labelledby="usage-distribution-title">
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
          <Show when={monthlyData()}><Show when={distribution().total > 0} fallback={<p class="usage-distribution__empty">No {distributionMetric() === "spend" ? "priced" : "token"} usage this month.</p>}>
            <div class="usage-distribution__body">
              <div class="usage-distribution__chart">
              <svg class="usage-donut" viewBox="0 0 200 200" role="img" aria-label={`${distributionMetric() === "spend" ? "Estimated spend" : "Tokens"} by provider this ${zoneLabel()} month; exact values are available in the legend`}>
                <circle class="usage-donut__track" cx="100" cy="100" r="72" fill="none" stroke-width="26" />
                <For each={segmentIDs()}>{(id, index) => {
                  const initial = arcs().find((segment) => segment.providerID === id)!
                  const segment = () => arcs().find((item) => item.providerID === id) ?? initial
                  return <circle class="usage-donut__arc" cx="100" cy="100" r="72" fill="none" stroke-width="26"
                    style={{ stroke: distributionColors[index() % distributionColors.length], "--usage-dash": `${segment().length} ${segment().circumference - segment().length}`, "--usage-circumference": segment().circumference, "stroke-dashoffset": segment().offset }}
                    tabindex="0" role="img" data-cursor="action" aria-label={`${segment().label}: estimated cost ${money(providerCosts().get(id) ?? 0)}, ${Math.round(segment().share * 100)}% share${distributionMetric() === "tokens" ? `, ${count(segment().value)} tokens` : ""}`}
                    onPointerEnter={(event) => { if (event.pointerType !== "touch") { setActiveProvider(id); queueMicrotask(() => placeProvider(event.clientX, event.clientY)) } }}
                    onPointerMove={(event) => { if (event.pointerType !== "touch") placeProvider(event.clientX, event.clientY) }} onPointerLeave={(event) => { if (event.pointerType !== "touch") setActiveProvider(undefined) }}
                    onFocus={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setActiveProvider(id); queueMicrotask(() => placeProvider(rect.left + rect.width / 2, rect.top + rect.height / 2)) }}
                    onBlur={() => setActiveProvider(undefined)} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setActiveProvider(id); queueMicrotask(() => placeProvider(event.clientX || rect.left + rect.width / 2, event.clientY || rect.top + rect.height / 2)) }} />
                }}</For>
              </svg>
              <strong class="usage-donut__total">{distributionMetric() === "spend" ? money(distribution().total) : count(distribution().total)}</strong>
              <span class="usage-donut__caption">{distributionMetric() === "spend" ? "estimated USD" : "tokens"}</span>
              </div>
              <Show when={activeSegment()}>{(segment) => <div class="usage-distribution__tooltip" ref={providerTooltip} style={{ left: `${providerPosition().left}px`, top: `${providerPosition().top}px` }} role="status"><strong>{segment().label}</strong><span>Estimated cost {money(providerCosts().get(segment().providerID) ?? 0)} · {Math.round(segment().share * 100)}% share</span><Show when={distributionMetric() === "tokens"}><span>{count(segment().value)} tokens</span></Show></div>}</Show>
              <ul class="usage-distribution__legend" aria-label={distributionMetric() === "spend" ? "Providers by estimated spend in USD" : "Providers by tokens"}><For each={segmentIDs()}>{(id, index) => {
                const initial = distribution().segments.find((segment) => segment.providerID === id)!
                const segment = () => distribution().segments.find((item) => item.providerID === id) ?? initial
                return <li>
                <span class="usage-distribution__swatch" style={{ background: distributionColors[index() % distributionColors.length] }} aria-hidden="true" />
                <span class="usage-distribution__name">{segment().label}</span><span>{Math.round(segment().share * 100)}%</span><strong>{distributionMetric() === "spend" ? money(segment().value) : count(segment().value)}</strong>
              </li>
              }}</For></ul>
            </div>
          </Show></Show>
        </div>
      </div>
    </section>

    <section class="usage-breakdown-section" aria-labelledby="usage-breakdown-title">
      <div class="usage-breakdown__head"><h2 id="usage-breakdown-title">Breakdown</h2><Show when={displayed()?.rows.length}><span class="usage-breakdown__summary">Showing {(shownBreakdown()?.input.offset ?? 0) + 1}–{(shownBreakdown()?.input.offset ?? 0) + (displayed()?.rows.length ?? 0)} of {count(displayed()?.rowCount ?? 0)} {names[shownBreakdown()?.input.group ?? group()].toLowerCase()}s</span></Show>
      <div class="usage-tabs" role="tablist" aria-label="Breakdown group" onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return
        event.preventDefault()
        const index = event.key === "Home" ? 0 : event.key === "End" ? groups.length - 1 : (groups.indexOf(group()) + (event.key === "ArrowRight" ? 1 : -1) + groups.length) % groups.length
        selectGroup(groups[index]!)
        event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[index]?.focus()
      }}><For each={groups}>{(item) => <button id={`usage-tab-${item}`} role="tab" type="button" aria-selected={group() === item} aria-controls="usage-breakdown-panel" tabindex={group() === item ? 0 : -1} onClick={() => selectGroup(item)}>{names[item]}</button>}</For></div></div>
      <div id="usage-breakdown-panel" role="tabpanel" aria-labelledby={`usage-tab-${group()}`} class="usage-breakdown" aria-busy={updating() ? "true" : "false"}>
        <Show when={!displayed() && remote.state().transport.kind === "open" && (breakdown().status === "loading" || breakdown().status === "idle")}><LoadingPlaceholder kind="usage" label="Loading breakdown…" /></Show>
        <Show when={!displayed() && breakdown()?.status === "unsupported"}><p class="usage-message" role="status">{zoneMode() === "local" ? "Update YCoding on this machine to see Local usage. Switch to UTC to continue." : "Update YCoding on this machine to see usage."}</p></Show>
        <Show when={!displayed() && breakdown()?.status === "error"}><p class="usage-message" role="alert">{breakdown()?.message}</p></Show>
        <Show when={displayed()}><Show when={(displayed()?.rows.length ?? 0) > 0} fallback={<p class="usage-message">No requests in this period.</p>}>
          <div class="usage-breakdown__mobile" ref={mobileRows} style={{ "min-height": `${minimumRowsHeight()}px` }}><For each={displayed()?.rows}>{(row: UsageReportRow) => {
            const identity = () => shownBreakdown()?.input.group === "model" ? modelIdentity(row.key, providerRead().data ?? []) : undefined
            return <article class="usage-mobile-row"><div class="usage-mobile-row__top"><div><strong>{identity()?.model ?? row.label}</strong><Show when={identity()}><span class="usage-provider-chip">{identity()?.provider}</span></Show></div><b>{money(row.cost ?? 0)}</b></div>
              <p>{count(row.physical)} requests · {count(row.tokens.input)} in / {count(row.tokens.output)} out<Show when={row.tokens.cache.read > 0}> · {count(row.tokens.cache.read)} cache read</Show></p>
            </article>
          }}</For></div>
          <button class="usage-breakdown__table-toggle" type="button" aria-expanded={breakdownTableOpen()} aria-controls="usage-breakdown-table" onClick={() => setBreakdownTableOpen(!breakdownTableOpen())}>{breakdownTableOpen() ? "Hide table" : "View table"}</button>
          <div id="usage-breakdown-table" class="usage-table-wrap usage-breakdown__table" classList={{ "usage-breakdown__table--open": breakdownTableOpen() }}><table><caption>{names[shownBreakdown()?.input.group ?? group()]} by usage</caption><thead><tr><th scope="col"><button type="button" aria-label={`Sort by ${names[group()]}`} onClick={() => setSorting("key")}>{names[group()]} {sort() === "key" ? order() === "asc" ? "↑" : "↓" : "↕"}</button></th><For each={columns}>{(column) => <th scope="col"><button type="button" aria-label={`Sort by ${column.label}`} onClick={() => setSorting(column.key)}>{column.label} {sort() === column.key ? order() === "asc" ? "↑" : "↓" : "↕"}</button></th>}</For></tr></thead><tbody><For each={displayed()?.rows}>{(row: UsageReportRow) => {
            const identity = () => shownBreakdown()?.input.group === "model" ? modelIdentity(row.key, providerRead().data ?? []) : undefined
            return <tr><th scope="row"><span>{identity()?.model ?? row.label}</span><Show when={identity()}><span class="usage-provider-chip">{identity()?.provider}</span></Show></th><td>{count(row.logical)}</td><td>{count(tokenCount(row.tokens))}</td><td>{count(row.tokens.input)}</td><td>{count(row.tokens.output)}</td><td>{count(row.tokens.reasoning)}</td><td>{count(row.tokens.cache.read)}</td><td class="usage-table__cost">{money(row.cost ?? 0)}<Show when={row.costProvenance === "current_catalog"}><small>estimate</small></Show></td></tr>
          }}</For></tbody></table></div>
          <div class="usage-breakdown__feedback" aria-live="polite"><Show when={updating()}><span role="status">Loading {names[group()].toLowerCase()} report…</span></Show><Show when={breakdown()?.status === "error"}><span role="alert">{breakdown()?.message} <button type="button" onClick={() => retryReport(breakdownInput())}>Retry</button></span></Show></div>
          <div class="usage-pagination"><span>Showing {(shownBreakdown()?.input.offset ?? 0) + 1}–{(shownBreakdown()?.input.offset ?? 0) + (displayed()?.rows.length ?? 0)} of {count(displayed()?.rowCount ?? 0)}</span><div><button type="button" disabled={updating() || (shownBreakdown()?.input.offset ?? 0) === 0} onClick={previousPage}>Previous</button><button type="button" disabled={updating() || displayed()?.nextOffset === undefined} onClick={nextPage}>Next</button></div></div>
        </Show></Show>
      </div>
    </section>
    <footer class="usage-cost-note">Costs are estimates from recorded usage and model pricing, not provider bills.</footer>
  </div>
}

function ProviderCard(props: { readonly provider: () => UsageProvider; readonly now: number }) {
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
        return <QuotaRow window={() => props.provider().windows.find((window) => window.id === id) ?? initial} now={props.now} />
      }}</For></div>
    </Show>
  </article>
}

function QuotaRow(props: { readonly window: () => UsageWindow; readonly now: number }) {
  const quota = () => quotaWindow(props.window(), props.now)
  return <div class="usage-window"><div class="usage-window__top"><span><strong>{props.window().label}</strong><Show when={quota().used}> <b>{quota().used} used</b></Show><Show when={quota().limit}> of {quota().limit}</Show><Show when={quota().remaining && !quota().used}> <b>{quota().remaining} remaining</b></Show></span>
      <Show when={quota().pace}><span class={`usage-pace usage-pace--${quota().pace === "Ahead of pace" ? "ahead" : quota().pace === "Below pace" ? "below" : "on"}`}>{quota().pace?.toLowerCase()}</span></Show>
    </div>
    <Show when={quota().fill !== undefined}><div class="usage-meter" role="progressbar" aria-label={`${props.window().label} used`} aria-valuenow={quota().fill} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${quota().fill}%` }} /></div></Show>
    <div class="usage-window__details"><Show when={quota().reset}><span>{quota().reset}</span></Show><Show when={quota().remaining && quota().used}><span>{quota().remaining} {props.window().unit === "usd" ? "remaining" : "left"}</span></Show><Show when={props.window().unlimited}><span>Unlimited</span></Show></div>
  </div>
}
