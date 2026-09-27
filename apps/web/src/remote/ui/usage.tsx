import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { useRemote } from "../context"
import { dailySpend, donutGeometry, modelIdentity, money, providerDistribution, providerHeading, quotaWindow, relativeFreshness, reportKey, spendMetrics, tokenCount, visibleProviders, type SpendDay, type UsageProvider, type UsageReport, type UsageReportInput, type UsageReportRow, type UsageWindow } from "./usage-model"
import "./usage.css"

const groups = ["model", "session", "project", "agent"] as const
type BreakdownInput = UsageReportInput & { readonly group: (typeof groups)[number] }
const names = { model: "Model", session: "Session", project: "Project", agent: "Agent" }
const day = 86_400_000
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
  const [now, setNow] = createSignal(Date.now())
  const [group, setGroup] = createSignal<(typeof groups)[number]>("model")
  const [sort, setSort] = createSignal<UsageReportInput["sort"]>("cost")
  const [order, setOrder] = createSignal<UsageReportInput["order"]>("desc")
  const [offset, setOffset] = createSignal(0)
  const [tableOpen, setTableOpen] = createSignal(false)
  const [distributionTableOpen, setDistributionTableOpen] = createSignal(false)
  const [breakdownTableOpen, setBreakdownTableOpen] = createSignal(false)
  const [distributionMetric, setDistributionMetric] = createSignal<"spend" | "tokens">("spend")
  const [shownBreakdown, setShownBreakdown] = createSignal<{ readonly deviceID: string; readonly report: UsageReport; readonly input: BreakdownInput }>()
  const [minimumRowsHeight, setMinimumRowsHeight] = createSignal(0)
  const [activeDay, setActiveDay] = createSignal<SpendDay>()
  const [activeProvider, setActiveProvider] = createSignal<string>()
  const [retained, setRetained] = createSignal<{ readonly deviceID?: string; readonly providers?: readonly UsageProvider[]; readonly daily?: UsageReport; readonly monthly?: UsageReport }>({})
  let mobileRows: HTMLDivElement | undefined
  let deviceID = remote.state().activeDeviceID
  const connected = createMemo(() => remote.state().transport.kind === "open")
  const today = Math.floor(Date.now() / day) * day
  const range = { from: today - 29 * day, to: today + day }
  const dailyInput: UsageReportInput = { group: "day", ...range, limit: 30, sort: "key", order: "asc" }
  const month = new Date()
  const monthlyInput: UsageReportInput = { group: "model", from: Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1), to: Date.now(), limit: 200, sort: "cost", order: "desc" }
  const breakdownInput = createMemo<BreakdownInput>(() => ({ group: group(), ...range, offset: offset(), limit: 25, sort: sort(), order: order() }))
  const daily = () => remote.state().usage.reports[reportKey(dailyInput)]
  const monthly = () => remote.state().usage.reports[reportKey(monthlyInput)]
  const breakdown = () => remote.state().usage.reports[reportKey(breakdownInput())]
  const retainedForDevice = () => retained().deviceID === remote.state().activeDeviceID ? retained() : undefined
  const providerData = () => remote.state().usage.providers.data ?? retainedForDevice()?.providers
  const dailyData = () => daily()?.data ?? retainedForDevice()?.daily
  const monthlyData = () => monthly()?.data ?? retainedForDevice()?.monthly
  const displayed = () => shownBreakdown()?.deviceID === remote.state().activeDeviceID ? shownBreakdown()?.report : undefined
  const updating = () => shownBreakdown() !== undefined && (breakdown() === undefined || breakdown()?.status === "loading")
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
  const days = createMemo(() => dailySpend(dailyData(), now()))
  const dayKeys = createMemo(() => days().map((entry) => entry.key))
  const tileValue = (id: (typeof tileIDs)[number]) => spendMetrics(id === "today" ? days().slice(-1) : id === "yesterday" ? days().slice(-2, -1) : days())
  const sparkline = createMemo(() => {
    const costs = days().map((entry) => entry.cost)
    const highest = Math.max(1, ...costs)
    return costs.map((cost, index) => `${(index / 29 * 96).toFixed(1)},${(28 - cost / highest * 24).toFixed(1)}`).join(" ")
  })
  const selectGroup = (next: (typeof groups)[number]) => {
    holdRows()
    setGroup(next)
    setOffset(0)
    setSort("cost")
    setOrder("desc")
    void remote.store.loadUsageReport({ group: next, ...range, offset: 0, limit: 25, sort: "cost", order: "desc" })
  }
  const setSorting = (next: NonNullable<UsageReportInput["sort"]>) => {
    holdRows()
    const direction = sort() === next && order() === "desc" ? "asc" : "desc"
    setSort(next)
    setOrder(direction)
    setOffset(0)
    void remote.store.loadUsageReport({ group: group(), ...range, offset: 0, limit: 25, sort: next, order: direction })
  }
  const nextPage = () => {
    const next = displayed()?.nextOffset
    if (next === undefined || updating()) return
    holdRows()
    setOffset(next)
    void remote.store.loadUsageReport({ ...breakdownInput(), offset: next })
  }
  const previousPage = () => {
    if (updating()) return
    holdRows()
    const next = Math.max(0, (shownBreakdown()?.input.offset ?? 0) - 25)
    setOffset(next)
    void remote.store.loadUsageReport({ ...breakdownInput(), offset: next })
  }
  createEffect(() => {
    if (!connected() || remote.state().usage.providers.status !== "idle") return
    untrack(() => { void Promise.all([remote.store.loadUsage(), remote.store.loadUsageReport(dailyInput), remote.store.loadUsageReport(breakdownInput()), remote.store.loadUsageReport(monthlyInput)]) })
  })
  createEffect(() => {
    const current = remote.state().activeDeviceID
    if (current !== deviceID || current === undefined || remote.state().connection.kind === "signed-out") {
      deviceID = current
      setRetained({})
      setShownBreakdown(undefined)
      setMinimumRowsHeight(0)
      return
    }
    const providers = remote.state().usage.providers.data
    const dayReport = daily()?.data
    const monthReport = monthly()?.data
    if (providers || dayReport || monthReport) setRetained((previous) => {
      if (previous.deviceID === current && (providers ?? previous.providers) === previous.providers && (dayReport ?? previous.daily) === previous.daily && (monthReport ?? previous.monthly) === previous.monthly) return previous
      return { deviceID: current, providers: providers ?? previous.providers, daily: dayReport ?? previous.daily, monthly: monthReport ?? previous.monthly }
    })
    const result = breakdown()
    if (result?.status === "ready" && result.data && (shownBreakdown()?.report !== result.data || shownBreakdown()?.input !== breakdownInput()))
      setShownBreakdown({ deviceID: current, report: result.data, input: breakdownInput() })
  })
  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 60_000)
    onCleanup(() => clearInterval(clock))
  })

  return <div class="usage-page">
    <header class="usage-head"><div class="usage-head__title"><h1>Usage</h1><p>Quotas and spend from {machine() ?? "your machine"}</p></div>
      <div class="usage-head__actions"><Show when={latest() !== undefined}><span class="usage-head__freshness">Updated {relativeFreshness(latest()!, now())}</span></Show>
        <button class="usage-refresh" type="button" disabled={remote.state().usage.providers.status === "loading" || remote.state().transport.kind !== "open"} onClick={() => void remote.store.loadUsage({ refresh: true })}>Refresh quotas</button>
      </div>
    </header>

    <section class="usage-quotas" aria-labelledby="usage-allowances">
      <h2 class="visually-hidden" id="usage-allowances">Provider quotas</h2>
      <Show when={!providerData() && remote.state().usage.providers.status === "unsupported"}><p class="usage-message" role="status">Update YCoding on this machine to see usage.</p></Show>
      <Show when={!providerData() && remote.state().usage.providers.status === "error"}><p class="usage-message" role="alert">{remote.state().usage.providers.message ?? "Usage could not be loaded."}</p></Show>
      <Show when={!providerData() && remote.state().transport.kind !== "open" && remote.state().usage.providers.status === "idle"}><p class="usage-message" role="status">Connect to a machine to see usage.</p></Show>
      <Show when={!providerData() && remote.state().usage.providers.status === "loading"}><p class="usage-message" role="status">Loading provider quotas…</p></Show>
      <Show when={providerData() && remote.state().usage.providers.status === "ready" && providers().length === 0}><p class="usage-message">No connected provider reports quotas.</p></Show>
      <div class="usage-providers"><For each={providerKeys()}>{(key, index) => {
        const initial = providers().find((provider) => providerKey(provider) === key)!
        return <ProviderCard provider={() => providers().find((provider) => providerKey(provider) === key) ?? initial} now={now()} index={index()} />
      }}</For></div>
    </section>

    <section class="usage-spend" aria-labelledby="usage-spend-title">
      <h2 class="visually-hidden" id="usage-spend-title">Spend overview</h2>
      <Show when={dailyData()}>
        <div class="usage-tiles"><For each={tileIDs}>{(id, index) => <article class="usage-tile" style={{ "--usage-index": index() }}>
          <h3>{tileLabels[id]}</h3><strong>{money(tileValue(id).cost)}</strong>
          <p class="usage-tile__meta"><span>{count(tileValue(id).requests)} requests</span><span>{count(tileValue(id).tokens)} tokens</span></p>
          <Show when={id === "last30"}><svg viewBox="0 0 100 32" aria-label="Spend trend over the last 30 days" role="img" preserveAspectRatio="none"><polyline points={sparkline()} /></svg></Show>
        </article>}</For></div>
      </Show>
      <div class="usage-visuals">
        <div class="usage-chart">
          <div class="usage-chart__head"><div><h3>Daily spend (last 30 UTC days)</h3><p>UTC day boundary · Today highlighted</p></div><button type="button" aria-expanded={tableOpen()} aria-controls="usage-daily-table" onClick={() => setTableOpen(!tableOpen())}>{tableOpen() ? "Hide table" : "View table"}</button></div>
          <Show when={dailyData()} fallback={<p class="usage-message" role="status">{daily()?.status === "unsupported" ? "Update YCoding on this machine to see usage." : daily()?.status === "error" ? daily()?.message : "Loading daily spend…"}</p>}>
            <p class="usage-chart__today">Today: {money(days().at(-1)?.cost ?? 0)} · {count(days().at(-1)?.requests ?? 0)} requests</p>
            <svg viewBox="0 0 900 180" role="img" aria-label="Daily cost over the last 30 days, with exact values in the table" preserveAspectRatio="none">
              <line x1="0" y1="156" x2="900" y2="156" class="usage-chart__axis" />
              <For each={dayKeys()}>{(key, index) => {
                const entry = () => days().find((item) => item.key === key)!
                const height = () => entry().cost === 0 ? 2 : Math.max(4, entry().cost / Math.max(1, ...days().map((item) => item.cost)) * 138)
                return <rect x={index() * 30 + 7} y={156 - height()} width="16" height={height()} rx="2" class={index() === 29 ? "usage-chart__bar usage-chart__bar--today" : "usage-chart__bar"}
                  tabindex="0" role="img" aria-label={`${key}: estimated cost ${money(entry().cost)}, ${count(entry().requests)} requests, ${count(entry().tokens)} tokens`}
                  onPointerEnter={(event) => { if (event.pointerType !== "touch") setActiveDay(entry()) }} onPointerLeave={(event) => { if (event.pointerType !== "touch") setActiveDay(undefined) }}
                  onFocus={() => setActiveDay(entry())} onBlur={() => setActiveDay(undefined)} onClick={() => setActiveDay(entry())} />
              }}</For>
            </svg>
            <Show when={activeDay()}>{(entry) => <div class="usage-chart__tooltip" role="status"><strong>{entry().key}</strong><span>Estimated cost {money(entry().cost)}</span><span>{count(entry().requests)} requests · {count(entry().tokens)} tokens</span></div>}</Show>
            <div class="usage-chart__labels"><span>{days()[0]?.label}</span><span>{days()[14]?.label}</span><span>Today</span></div>
            <Show when={tableOpen()}><div id="usage-daily-table" class="usage-table-wrap"><table><caption>Daily usage, last 30 UTC days</caption><thead><tr><th scope="col">Day</th><th scope="col">Cost</th><th scope="col">Tokens</th><th scope="col">Requests</th></tr></thead><tbody><For each={[...days()].reverse()}>{(entry) => <tr><th scope="row">{entry.key}</th><td>{money(entry.cost)}</td><td>{count(entry.tokens)}</td><td>{count(entry.requests)}</td></tr>}</For></tbody></table></div></Show>
          </Show>
        </div>
        <div class="usage-distribution" aria-labelledby="usage-distribution-title">
          <div class="usage-distribution__head"><div><h3 id="usage-distribution-title">Provider distribution (current UTC month)</h3><p>Current UTC month</p></div>
            <div class="usage-distribution__controls"><div class={`usage-toggle${distributionMetric() === "tokens" ? " usage-toggle--tokens" : ""}`} role="group" aria-label="Distribution metric">
              <button type="button" aria-pressed={distributionMetric() === "spend"} onClick={() => setDistributionMetric("spend")}>Spend</button>
              <button type="button" aria-pressed={distributionMetric() === "tokens"} onClick={() => setDistributionMetric("tokens")}>Tokens</button>
            </div><button class="usage-distribution__table-toggle" type="button" aria-expanded={distributionTableOpen()} aria-controls="usage-distribution-table" onClick={() => setDistributionTableOpen(!distributionTableOpen())}>{distributionTableOpen() ? "Hide table" : "View table"}</button></div>
          </div>
          <Show when={!monthlyData() && (monthly()?.status === "loading" || monthly() === undefined)}><p class="usage-distribution__empty" role="status">Loading monthly usage…</p></Show>
          <Show when={!monthlyData() && monthly()?.status === "unsupported"}><p class="usage-distribution__empty">Update YCoding on this machine to see monthly usage.</p></Show>
          <Show when={!monthlyData() && monthly()?.status === "error"}><p class="usage-distribution__empty" role="alert">{monthly()?.message}</p></Show>
          <Show when={monthlyData()}><Show when={distribution().total > 0} fallback={<p class="usage-distribution__empty">No {distributionMetric() === "spend" ? "priced" : "token"} usage this month.</p>}>
            <div class="usage-distribution__body">
              <svg class="usage-donut" viewBox="0 0 200 200" role="img" aria-label={`${distributionMetric() === "spend" ? "Estimated spend" : "Tokens"} by provider this UTC month; exact values are available in the table`}>
                <circle class="usage-donut__track" cx="100" cy="100" r="72" fill="none" stroke-width="26" />
                <For each={segmentIDs()}>{(id, index) => {
                  const initial = arcs().find((segment) => segment.providerID === id)!
                  const segment = () => arcs().find((item) => item.providerID === id) ?? initial
                  return <circle class="usage-donut__arc" cx="100" cy="100" r="72" fill="none" stroke-width="26"
                    style={{ stroke: distributionColors[index() % distributionColors.length], "--usage-dash": `${segment().length} ${segment().circumference - segment().length}`, "--usage-circumference": segment().circumference, "stroke-dashoffset": segment().offset }}
                    tabindex="0" role="img" aria-label={`${segment().label}: estimated cost ${money(providerCosts().get(id) ?? 0)}, ${Math.round(segment().share * 100)}% share${distributionMetric() === "tokens" ? `, ${count(segment().value)} tokens` : ""}`}
                    onPointerEnter={(event) => { if (event.pointerType !== "touch") setActiveProvider(id) }} onPointerLeave={(event) => { if (event.pointerType !== "touch") setActiveProvider(undefined) }}
                    onFocus={() => setActiveProvider(id)} onBlur={() => setActiveProvider(undefined)} onClick={() => setActiveProvider(id)} />
                }}</For>
                <text x="100" y="96" class="usage-donut__total">{distributionMetric() === "spend" ? money(distribution().total) : count(distribution().total)}</text>
                <text x="100" y="120" class="usage-donut__caption">{distributionMetric() === "spend" ? "estimated USD" : "tokens"}</text>
              </svg>
              <Show when={activeSegment()}>{(segment) => <div class="usage-distribution__tooltip" role="status"><strong>{segment().label}</strong><span>Estimated cost {money(providerCosts().get(segment().providerID) ?? 0)} · {Math.round(segment().share * 100)}% share</span><Show when={distributionMetric() === "tokens"}><span>{count(segment().value)} tokens</span></Show></div>}</Show>
              <ul class="usage-distribution__legend"><For each={segmentIDs()}>{(id, index) => {
                const initial = distribution().segments.find((segment) => segment.providerID === id)!
                const segment = () => distribution().segments.find((item) => item.providerID === id) ?? initial
                return <li>
                <span class="usage-distribution__swatch" style={{ background: distributionColors[index() % distributionColors.length] }} aria-hidden="true" />
                <span class="usage-distribution__name">{segment().label}</span><span>{Math.round(segment().share * 100)}%</span><strong>{distributionMetric() === "spend" ? money(segment().value) : count(segment().value)}</strong>
              </li>
              }}</For></ul>
            </div>
            <Show when={distributionTableOpen()}><div id="usage-distribution-table" class="usage-table-wrap"><table><caption>Monthly {distributionMetric() === "spend" ? "estimated spend" : "tokens"} by provider</caption><thead><tr><th scope="col">Provider</th><th scope="col">{distributionMetric() === "spend" ? "Estimated spend" : "Tokens"}</th><th scope="col">Share</th></tr></thead><tbody><For each={distribution().segments}>{(segment) => <tr><th scope="row">{segment.label}</th><td>{distributionMetric() === "spend" ? money(segment.value) : count(segment.value)}</td><td>{Math.round(segment.share * 100)}%</td></tr>}</For></tbody></table></div></Show>
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
        <Show when={!displayed() && remote.state().transport.kind === "open" && (breakdown()?.status === "loading" || breakdown() === undefined)}><p class="usage-message" role="status">Loading breakdown…</p></Show>
        <Show when={!displayed() && breakdown()?.status === "unsupported"}><p class="usage-message" role="status">Update YCoding on this machine to see usage.</p></Show>
        <Show when={!displayed() && breakdown()?.status === "error"}><p class="usage-message" role="alert">{breakdown()?.message}</p></Show>
        <Show when={displayed()}><Show when={(displayed()?.rows.length ?? 0) > 0} fallback={<p class="usage-message">No requests in this period.</p>}>
          <div class="usage-breakdown__mobile" ref={mobileRows} style={{ "min-height": `${minimumRowsHeight()}px` }}><For each={displayed()?.rows}>{(row: UsageReportRow) => {
            const identity = () => shownBreakdown()?.input.group === "model" ? modelIdentity(row.key, remote.state().usage.providers.data ?? []) : undefined
            return <article class="usage-mobile-row"><div class="usage-mobile-row__top"><div><strong>{identity()?.model ?? row.label}</strong><Show when={identity()}><span class="usage-provider-chip">{identity()?.provider}</span></Show></div><b>{money(row.cost ?? 0)}</b></div>
              <p>{count(row.physical)} requests · {count(row.tokens.input)} in / {count(row.tokens.output)} out<Show when={row.tokens.cache.read > 0}> · {count(row.tokens.cache.read)} cache read</Show></p>
            </article>
          }}</For></div>
          <button class="usage-breakdown__table-toggle" type="button" aria-expanded={breakdownTableOpen()} aria-controls="usage-breakdown-table" onClick={() => setBreakdownTableOpen(!breakdownTableOpen())}>{breakdownTableOpen() ? "Hide table" : "View table"}</button>
          <div id="usage-breakdown-table" class="usage-table-wrap usage-breakdown__table" classList={{ "usage-breakdown__table--open": breakdownTableOpen() }}><table><caption>{names[shownBreakdown()?.input.group ?? group()]} by usage</caption><thead><tr><th scope="col"><button type="button" aria-label={`Sort by ${names[group()]}`} onClick={() => setSorting("key")}>{names[group()]} {sort() === "key" ? order() === "asc" ? "↑" : "↓" : "↕"}</button></th><For each={columns}>{(column) => <th scope="col"><button type="button" aria-label={`Sort by ${column.label}`} onClick={() => setSorting(column.key)}>{column.label} {sort() === column.key ? order() === "asc" ? "↑" : "↓" : "↕"}</button></th>}</For></tr></thead><tbody><For each={displayed()?.rows}>{(row: UsageReportRow) => {
            const identity = () => shownBreakdown()?.input.group === "model" ? modelIdentity(row.key, remote.state().usage.providers.data ?? []) : undefined
            return <tr><th scope="row"><span>{identity()?.model ?? row.label}</span><Show when={identity()}><span class="usage-provider-chip">{identity()?.provider}</span></Show></th><td>{count(row.logical)}</td><td>{count(tokenCount(row.tokens))}</td><td>{count(row.tokens.input)}</td><td>{count(row.tokens.output)}</td><td>{count(row.tokens.reasoning)}</td><td>{count(row.tokens.cache.read)}</td><td class="usage-table__cost">{money(row.cost ?? 0)}<Show when={row.costProvenance === "current_catalog"}><small>estimate</small></Show></td></tr>
          }}</For></tbody></table></div>
          <div class="usage-breakdown__feedback" aria-live="polite"><Show when={updating()}><span role="status">Loading {names[group()].toLowerCase()} report…</span></Show><Show when={breakdown()?.status === "error"}><span role="alert">{breakdown()?.message} <button type="button" onClick={() => void remote.store.loadUsageReport(breakdownInput())}>Retry</button></span></Show></div>
          <div class="usage-pagination"><span>Showing {(shownBreakdown()?.input.offset ?? 0) + 1}–{(shownBreakdown()?.input.offset ?? 0) + (displayed()?.rows.length ?? 0)} of {count(displayed()?.rowCount ?? 0)}</span><div><button type="button" disabled={updating() || (shownBreakdown()?.input.offset ?? 0) === 0} onClick={previousPage}>Previous</button><button type="button" disabled={updating() || displayed()?.nextOffset === undefined} onClick={nextPage}>Next</button></div></div>
        </Show></Show>
      </div>
    </section>
    <footer class="usage-cost-note">Costs are estimates from recorded usage and model pricing, not provider bills.</footer>
  </div>
}

function ProviderCard(props: { readonly provider: () => UsageProvider; readonly now: number; readonly index: number }) {
  const label = (value: string) => value.replaceAll("_", " ")
  const heading = () => providerHeading(props.provider())
  const updated = () => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(props.provider().updatedAt)
  const provenance = () => `Updated ${updated()} — source: ${label(props.provider().source).replace("api", "API")}, stability: ${label(props.provider().stability)}`
  return <article class="usage-provider" style={{ "--usage-index": props.index }}>
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
