import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { useRemote } from "../context"
import { dailySpend, money, quotaWindow, reportKey, spendMetrics, tokenCount, type UsageProvider, type UsageReportInput, type UsageReportRow, type UsageWindow } from "./usage-model"
import "./usage.css"

const groups = ["model", "session", "project", "agent"] as const
const names = { model: "Models", session: "Sessions", project: "Projects", agent: "Agents" }
const day = 86_400_000
const columns = [
  { key: "cost", label: "Cost" }, { key: "steps", label: "Steps" }, { key: "tokens", label: "Tokens" },
  { key: "input", label: "Input" }, { key: "output", label: "Output" }, { key: "reasoning", label: "Reasoning" },
] as const
const count = (value: number) => new Intl.NumberFormat().format(value)

export function UsagePage() {
  const remote = useRemote()
  const [now, setNow] = createSignal(Date.now())
  const [group, setGroup] = createSignal<(typeof groups)[number]>("model")
  const [sort, setSort] = createSignal<UsageReportInput["sort"]>("cost")
  const [order, setOrder] = createSignal<UsageReportInput["order"]>("desc")
  const [offset, setOffset] = createSignal(0)
  const [tableOpen, setTableOpen] = createSignal(false)
  const connected = createMemo(() => remote.state().transport.kind === "open")
  const today = Math.floor(Date.now() / day) * day
  const range = { from: today - 29 * day, to: today + day }
  const dailyInput: UsageReportInput = { group: "day", ...range, limit: 30, sort: "key", order: "asc" }
  const breakdownInput = createMemo<UsageReportInput>(() => ({ group: group(), ...range, offset: offset(), limit: 25, sort: sort(), order: order() }))
  const daily = () => remote.state().usage.reports[reportKey(dailyInput)]
  const breakdown = () => remote.state().usage.reports[reportKey(breakdownInput())]
  const days = createMemo(() => dailySpend(daily()?.data, now()))
  const tiles = createMemo(() => [
    { title: "Today", value: spendMetrics(days().slice(-1)) },
    { title: "Yesterday", value: spendMetrics(days().slice(-2, -1)) },
    { title: "Last 30 days", value: spendMetrics(days()) },
  ])
  const selectGroup = (next: (typeof groups)[number]) => {
    setGroup(next)
    setOffset(0)
    setSort("cost")
    setOrder("desc")
    void remote.store.loadUsageReport({ group: next, ...range, offset: 0, limit: 25, sort: "cost", order: "desc" })
  }
  const setSorting = (next: NonNullable<UsageReportInput["sort"]>) => {
    const direction = sort() === next && order() === "desc" ? "asc" : "desc"
    setSort(next)
    setOrder(direction)
    setOffset(0)
    void remote.store.loadUsageReport({ group: group(), ...range, offset: 0, limit: 25, sort: next, order: direction })
  }
  const nextPage = () => {
    const next = breakdown()?.data?.nextOffset
    if (next === undefined) return
    setOffset(next)
    void remote.store.loadUsageReport({ ...breakdownInput(), offset: next })
  }
  const previousPage = () => {
    const next = Math.max(0, offset() - 25)
    setOffset(next)
    void remote.store.loadUsageReport({ ...breakdownInput(), offset: next })
  }
  createEffect(() => {
    if (!connected() || remote.state().usage.providers.status !== "idle") return
    untrack(() => { void Promise.all([remote.store.loadUsage(), remote.store.loadUsageReport(dailyInput), remote.store.loadUsageReport(breakdownInput())]) })
  })
  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 60_000)
    onCleanup(() => clearInterval(clock))
  })

  return <div class="usage-page">
    <header class="usage-head">
      <div><p class="usage-eyebrow">Your workspace · Usage</p><h1>Usage</h1><p>Provider allowances and model spend from your connected machine.</p></div>
      <button class="usage-refresh" type="button" disabled={remote.state().usage.providers.status === "loading" || remote.state().transport.kind !== "open"} onClick={() => void remote.store.loadUsage({ refresh: true })}>Refresh quotas</button>
    </header>

    <section class="usage-section" aria-labelledby="usage-allowances">
      <div class="usage-section__head"><div><p class="usage-eyebrow">01 · Live allowances</p><h2 id="usage-allowances">Provider quotas</h2></div><p>Read-only · Updated on request</p></div>
      <Show when={remote.state().usage.providers.status === "unsupported"}><p class="usage-message" role="status">Update YCoding on this machine to see usage.</p></Show>
      <Show when={remote.state().usage.providers.status === "error"}><p class="usage-message" role="alert">{remote.state().usage.providers.message ?? "Usage could not be loaded."}</p></Show>
      <Show when={remote.state().transport.kind !== "open" && remote.state().usage.providers.status === "idle"}><p class="usage-message" role="status">Connect to a machine to see usage.</p></Show>
      <Show when={remote.state().usage.providers.status === "loading" && !remote.state().usage.providers.data}><p class="usage-message" role="status">Loading provider quotas…</p></Show>
      <Show when={remote.state().usage.providers.status === "ready" && remote.state().usage.providers.data?.length === 0}><p class="usage-message">No provider quotas were reported by this machine.</p></Show>
      <div class="usage-providers"><For each={remote.state().usage.providers.data}>{(provider) => <ProviderCard provider={provider} now={now()} />}</For></div>
    </section>

    <section class="usage-section" aria-labelledby="usage-spend">
      <div class="usage-section__head"><div><p class="usage-eyebrow">02 · Spend overview</p><h2 id="usage-spend">The big picture</h2></div><Show when={remote.state().usage.summary.data}><p>{count(remote.state().usage.summary.data!.physical)} requests all time</p></Show></div>
      <p class="usage-cost-note">Costs are estimates from recorded usage and model pricing, not provider bills.</p>
      <Show when={daily()?.status === "unsupported"}><p class="usage-message" role="status">Update YCoding on this machine to see usage.</p></Show>
      <Show when={daily()?.status === "error"}><p class="usage-message" role="alert">{daily()?.message}</p></Show>
      <Show when={remote.state().transport.kind === "open" && (daily()?.status === "loading" || daily() === undefined)}><p class="usage-message" role="status">Loading spend…</p></Show>
      <Show when={daily()?.status === "ready"}>
        <div class="usage-tiles"><For each={tiles()}>{(tile) => <article class="usage-tile">
          <h3>{tile.title}</h3><strong>{money(tile.value.cost)}</strong><Show when={tile.value.provenance}><span class="usage-tile__source">{tile.value.provenance}</span></Show>
          <div class="usage-tile__meta"><span>{count(tile.value.tokens)} tokens</span><span>{count(tile.value.requests)} requests</span></div>
        </article>}</For></div>
        <div class="usage-chart">
          <div class="usage-chart__head"><div><h3>Daily spend</h3><p>Last 30 UTC days · USD</p></div><button type="button" aria-expanded={tableOpen()} aria-controls="usage-daily-table" onClick={() => setTableOpen(!tableOpen())}>{tableOpen() ? "Hide table" : "View table"}</button></div>
          <svg viewBox="0 0 900 180" role="img" aria-label="Daily cost over the last 30 days, with exact values in the table" preserveAspectRatio="none">
            <line x1="0" y1="156" x2="900" y2="156" class="usage-chart__axis" />
            <For each={days()}>{(entry, index) => {
              const height = () => entry.cost === 0 ? 2 : Math.max(4, entry.cost / Math.max(1, ...days().map((item) => item.cost)) * 138)
              return <rect x={index() * 30 + 7} y={156 - height()} width="16" height={height()} rx="2" class={index() === 29 ? "usage-chart__bar usage-chart__bar--today" : "usage-chart__bar"}><title>{entry.key}: {money(entry.cost)}</title></rect>
            }}</For>
          </svg>
          <div class="usage-chart__labels"><span>{days()[0]?.label}</span><span>{days()[14]?.label}</span><span>Today</span></div>
          <Show when={tableOpen()}><div id="usage-daily-table" class="usage-table-wrap"><table><caption>Daily usage, last 30 UTC days</caption><thead><tr><th scope="col">Day</th><th scope="col">Cost</th><th scope="col">Tokens</th><th scope="col">Requests</th></tr></thead><tbody><For each={[...days()].reverse()}>{(entry) => <tr><th scope="row">{entry.key}</th><td>{money(entry.cost)}</td><td>{count(entry.tokens)}</td><td>{count(entry.requests)}</td></tr>}</For></tbody></table></div></Show>
        </div>
      </Show>
    </section>

    <section class="usage-section" aria-labelledby="usage-breakdown">
      <div class="usage-section__head"><div><p class="usage-eyebrow">03 · Explore the detail</p><h2 id="usage-breakdown">Breakdown</h2></div><p>Last 30 UTC days</p></div>
      <div class="usage-tabs" role="tablist" aria-label="Breakdown group" onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return
        event.preventDefault()
        const index = event.key === "Home" ? 0 : event.key === "End" ? groups.length - 1 : (groups.indexOf(group()) + (event.key === "ArrowRight" ? 1 : -1) + groups.length) % groups.length
        selectGroup(groups[index]!)
        event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[index]?.focus()
      }}><For each={groups}>{(item) => <button id={`usage-tab-${item}`} role="tab" type="button" aria-selected={group() === item} aria-controls="usage-breakdown-panel" tabindex={group() === item ? 0 : -1} onClick={() => selectGroup(item)}>{names[item]}</button>}</For></div>
      <div id="usage-breakdown-panel" role="tabpanel" aria-labelledby={`usage-tab-${group()}`} class="usage-breakdown">
        <Show when={remote.state().transport.kind === "open" && (breakdown()?.status === "loading" || breakdown() === undefined)}><p class="usage-message" role="status">Loading breakdown…</p></Show>
        <Show when={breakdown()?.status === "unsupported"}><p class="usage-message" role="status">Update YCoding on this machine to see usage.</p></Show>
        <Show when={breakdown()?.status === "error"}><p class="usage-message" role="alert">{breakdown()?.message}</p></Show>
        <Show when={breakdown()?.status === "ready"}><Show when={(breakdown()?.data?.rows.length ?? 0) > 0} fallback={<p class="usage-message">No requests in this period.</p>}>
          <div class="usage-table-wrap"><table><caption>{names[group()]} by usage</caption><thead><tr><th scope="col"><button type="button" aria-label={`Sort by ${names[group()]}`} onClick={() => setSorting("key")}>{names[group()]} {sort() === "key" ? order() === "asc" ? "↑" : "↓" : ""}</button></th><For each={columns}>{(column) => <th scope="col"><button type="button" aria-label={`Sort by ${column.label}`} onClick={() => setSorting(column.key)}>{column.label} {sort() === column.key ? order() === "asc" ? "↑" : "↓" : ""}</button></th>}</For></tr></thead><tbody><For each={breakdown()?.data?.rows}>{(row: UsageReportRow) => <tr><th scope="row">{row.label}</th><td>{money(row.cost ?? 0)}<Show when={row.costProvenance === "current_catalog"}><small>estimate</small></Show></td><td>{count(row.logical)}</td><td>{count(tokenCount(row.tokens))}</td><td>{count(row.tokens.input)}</td><td>{count(row.tokens.output)}</td><td>{count(row.tokens.reasoning)}</td></tr>}</For></tbody></table></div>
          <div class="usage-pagination"><span>{offset() + 1}–{offset() + (breakdown()?.data?.rows.length ?? 0)} of {count(breakdown()?.data?.rowCount ?? 0)}</span><div><button type="button" disabled={offset() === 0} onClick={previousPage}>Previous</button><button type="button" disabled={breakdown()?.data?.nextOffset === undefined} onClick={nextPage}>Next</button></div></div>
        </Show></Show>
      </div>
    </section>
  </div>
}

function ProviderCard(props: { readonly provider: UsageProvider; readonly now: number }) {
  const label = (value: string) => value.replaceAll("_", " ")
  return <article class="usage-provider">
    <header class="usage-provider__head"><div><span class="usage-provider__mark" aria-hidden="true">{props.provider.label.slice(0, 1).toUpperCase()}</span><div><h3>{props.provider.label}</h3><Show when={props.provider.profile}><p>{props.provider.profile}</p></Show></div></div><span class={`usage-status usage-status--${props.provider.status}`}>{label(props.provider.status)}</span></header>
    <Show when={props.provider.windows.length > 0} fallback={<p class="usage-provider__empty">{props.provider.message ?? "This provider has not reported any quota metrics."}</p>}>
      <div class="usage-provider__windows"><For each={props.provider.windows}>{(window: UsageWindow) => <QuotaRow window={window} now={props.now} />}</For></div>
    </Show>
    <footer><span>Updated <time datetime={new Date(props.provider.updatedAt).toISOString()}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(props.provider.updatedAt)}</time></span><span>{label(props.provider.source)} · {label(props.provider.stability)}</span></footer>
  </article>
}

function QuotaRow(props: { readonly window: UsageWindow; readonly now: number }) {
  const quota = () => quotaWindow(props.window, props.now)
  return <div class="usage-window"><div class="usage-window__top"><strong>{props.window.label}</strong><Show when={quota().used}><span>{quota().used}<Show when={quota().limit}> / {quota().limit}</Show></span></Show></div>
    <Show when={quota().fill !== undefined}><div class="usage-meter" role="progressbar" aria-label={`${props.window.label} used`} aria-valuenow={quota().fill} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${quota().fill}%` }} /></div></Show>
    <div class="usage-window__details"><Show when={quota().remaining}><span>{quota().remaining} {props.window.unit === "usd" ? "remaining" : "left"}</span></Show><Show when={props.window.unlimited}><span>Unlimited</span></Show><Show when={quota().pace}><span class={quota().pace === "Ahead of pace" ? "usage-pace--ahead" : ""}>{quota().pace}</span></Show><Show when={quota().reset}><span>{quota().reset}</span></Show></div>
  </div>
}
