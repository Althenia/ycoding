import type { UsageReportOutput } from "@ycoding-ai/client"
import { RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { DialogHeader, DialogTitle, useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogSelect } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { UsageGroupDialog, UsageFilterDialog, usageGroupOptions } from "./usage-filters"
import { UsageSpeedDetails } from "./usage-cost"
import { costText, reportLabel, usd } from "../../util/usage-accounting"

export const PROVIDER_USAGE_VIEWS = [
  "overview",
  "usage",
  "models",
  "daily",
  "hourly",
  "monthly",
  "sessions",
  "projects",
  "stats",
  "agents",
  "prompts",
  "tasks",
  "incidents",
] as const

export type ProviderUsageView = (typeof PROVIDER_USAGE_VIEWS)[number]
export type ProviderUsageReportView = Exclude<ProviderUsageView, "overview" | "usage" | "incidents">
export type ProviderUsageReportInput = {
  group: UsageReportOutput["group"]
  from?: number
  to?: number
  offset?: number
  limit?: number
  sort?: "key" | "tokens" | "cost" | "steps" | "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite"
  order?: "asc" | "desc"
  providerID?: string
  profile?: string
  modelID?: string
  selectedEffort?: string
}

export type DateRange =
  | { type: "last7" | "last30" | "all" }
  | { type: "custom"; from: number; to: number; fromLabel: string; toLabel: string }
type ReportMetrics = UsageReportOutput["total"] | UsageReportOutput["rows"][number]
type Sort = NonNullable<ProviderUsageReportInput["sort"]>
type Order = NonNullable<ProviderUsageReportInput["order"]>
type StatsSummary = {
  favoriteModel?: string
  sessions: number
}
type ReportState = {
  queryKey: string
  report?: UsageReportOutput
  stats?: StatsSummary
  loading: boolean
  failed: boolean
  stale: boolean
}

export const PAGE_SIZE = 100
const REPORT_LEGEND = "Configured request-date analytics retention · STEPS model calls · OUTPUT visible text · REASON reasoning · CACHE prompt-cache tokens · ≥ lower bound where cache reads were unreported"
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const STATS_PAGE_SIZE = 200
const DAY = 24 * 60 * 60 * 1_000

export function providerUsageViewLabel(view: ProviderUsageView) {
  return view[0].toUpperCase() + view.slice(1)
}

function providerUsageReportGroup(view: ProviderUsageReportView): UsageReportOutput["group"] {
  if (view === "models") return "model"
  if (view === "daily" || view === "stats") return "day"
  if (view === "hourly") return "hour"
  if (view === "monthly") return "month"
  if (view === "sessions") return "session"
  if (view === "projects") return "project"
  if (view === "prompts") return "prompt"
  if (view === "tasks") return "task"
  return "agent"
}

export function ProviderUsageReports(props: {
  view: ProviderUsageReportView
  refresh: number
  now?: () => number
  load?: (input: ProviderUsageReportInput) => Promise<UsageReportOutput>
}) {
  const [range, setRange] = createSignal<DateRange>({ type: "all" })
  const [grouping, setGrouping] = createSignal<{ view: ProviderUsageReportView; group: UsageReportOutput["group"] }>()
  const [filters, setFilters] = createSignal<Pick<ProviderUsageReportInput, "providerID" | "profile" | "modelID" | "selectedEffort">>({})
  const [sorting, setSorting] = createSignal({ view: props.view, ...defaultSorting(props.view) })
  const [page, setPage] = createSignal({ view: props.view, offset: 0 })
  const [selected, setSelected] = createSignal<string>()
  const [rangeError, setRangeError] = createSignal<string>()
  const [state, setState] = createSignal<ReportState>({ queryKey: "", loading: false, failed: false, stale: false })
  let generation = 0

  const stats = createMemo(() => props.view === "stats")
  const tableView = createMemo(() => props.view === "stats" ? undefined : props.view)
  const group = createMemo(() => grouping()?.view === props.view ? grouping()!.group : providerUsageReportGroup(props.view))
  const offset = createMemo(() => page().view === props.view ? page().offset : 0)
  const setOffset = (value: number) => setPage({ view: props.view, offset: value })
  const currentSorting = createMemo(() => sorting().view === props.view ? sorting() : { view: props.view, ...defaultSorting(props.view) })
  const sort = () => currentSorting().sort
  const order = () => currentSorting().order
  const changeSort = (next: Sort) => {
    const toggled: Order = sort() === next ? (order() === "asc" ? "desc" : "asc") : next === "key" ? "asc" : "desc"
    setSorting({ view: props.view, sort: next, order: toggled })
    setOffset(0)
  }
  const changeRange = (next: DateRange) => {
    setRange(next)
    setRangeError(undefined)
    setOffset(0)
  }

  createEffect(() => {
    const loader = props.load
    void props.refresh
    const currentStats = stats()
    const currentGroup = group()
    const currentRange = range()
    const currentSort = currentStats ? "key" : sort()
    const currentOrder = currentStats ? "asc" : order()
    const currentOffset = currentStats ? 0 : offset()
    const bounds = currentStats ? statsDateBounds(props.now?.() ?? Date.now()) : dateBounds(currentRange, props.now?.() ?? Date.now())
    const query: ProviderUsageReportInput = {
      group: currentGroup,
      ...filters(),
      ...bounds,
      offset: currentOffset,
      limit: currentStats ? STATS_PAGE_SIZE : PAGE_SIZE,
      sort: currentSort,
      order: currentOrder,
    }
    const queryKey = JSON.stringify([props.view, query])
    const token = ++generation
    if (!loader) return

    const previous = untrack(state)
    const sameQuery = previous.queryKey === queryKey && previous.report !== undefined
    if (sameQuery) setState({ ...previous, loading: true, failed: false, stale: true })
    else {
      setState({ queryKey, loading: true, failed: false, stale: false })
      setSelected(undefined)
    }

    void loadReport(loader, query, currentStats).then(
      (result) => {
        if (token !== generation) return
        const current = untrack(selected)
        setState({ queryKey, report: result.report, stats: result.stats, loading: false, failed: false, stale: false })
        setSelected(result.report.rows.some((row) => row.key === current) ? current : result.report.rows[0]?.key)
      },
      () => {
        if (token !== generation) return
        const current = untrack(state)
        setState({ ...current, queryKey, loading: false, failed: true, stale: current.report !== undefined })
      },
    )
  })

  onCleanup(() => {
    generation += 1
  })

  return (
    <Show
      when={tableView()}
      fallback={
        <ProviderUsageStats
          state={state()}
          now={props.now?.() ?? Date.now()}
        />
      }
    >
      {(current) => (
        <ProviderUsageTable
          view={current()}
          state={state()}
          range={range()}
          rangeError={rangeError()}
          sort={sort()}
          order={order()}
          offset={offset()}
          selected={selected()}
          onSort={changeSort}
          onRange={changeRange}
          onRangeError={setRangeError}
          onOffset={setOffset}
          onSelect={setSelected}
          onGroup={(group) => { setGrouping({ view: props.view, group }); setOffset(0) }}
          onFilter={(key, value) => { setFilters((current) => ({ ...current, [key]: value, ...(key === "providerID" ? { profile: undefined } : {}) })); setOffset(0) }}
          filters={filters()}
          group={group()}
        />
      )}
    </Show>
  )
}

async function loadReport(
  loader: (input: ProviderUsageReportInput) => Promise<UsageReportOutput>,
  query: ProviderUsageReportInput,
  stats: boolean,
): Promise<{ report: UsageReportOutput; stats?: StatsSummary }> {
  if (!stats) return { report: await loader(query) }
  const [models, sessions, report] = await Promise.all([
    loader({ ...query, group: "model", offset: 0, limit: 1, sort: "tokens", order: "desc" }),
    loader({ ...query, group: "session", offset: 0, limit: 1 }),
    loadDays(loader, query),
  ])
  return { report, stats: { favoriteModel: models.rows[0]?.label, sessions: sessions.rowCount } }
}

async function loadDays(
  loader: (input: ProviderUsageReportInput) => Promise<UsageReportOutput>,
  query: ProviderUsageReportInput,
) {
  const first = await loader(query)
  if (first.nextOffset === undefined) return first
  const second = await loader({ ...query, offset: first.nextOffset })
  return { ...first, rows: [...first.rows, ...second.rows], nextOffset: undefined }
}

function defaultSorting(view: ProviderUsageReportView): { sort: Sort; order: Order } {
  if (view === "daily" || view === "hourly" || view === "monthly" || view === "stats") return { sort: "key", order: "asc" }
  return { sort: "tokens", order: "desc" }
}

function ProviderUsageTable(props: {
  view: Exclude<ProviderUsageReportView, "stats">
  state: ReportState
  range: DateRange
  rangeError?: string
  sort: Sort
  order: Order
  offset: number
  selected?: string
  onSort: (sort: Sort) => void
  onRange: (range: DateRange) => void
  onRangeError: (error: string | undefined) => void
  onOffset: (offset: number) => void
  onSelect: (key: string) => void
  group: UsageReportOutput["group"]
  filters: Pick<ProviderUsageReportInput, "providerID" | "profile" | "modelID" | "selectedEffort">
  onGroup: (group: UsageReportOutput["group"]) => void
  onFilter: (key: "providerID" | "profile" | "modelID" | "selectedEffort", value: string | undefined) => void
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  const narrow = createMemo(() => !reportGeometry(dimensions().width).fits)
  const rows = createMemo(() => props.state.report?.rows ?? [])
  const selected = createMemo(() => rows().find((row) => row.key === props.selected))
  let scroll: ScrollBoxRenderable | undefined

  const moveTo = (index: number) => {
    const row = rows()[Math.max(0, Math.min(rows().length - 1, index))]
    if (!row) return
    props.onSelect(row.key)
  }
  const move = (direction: -1 | 1) => {
    const index = rows().findIndex((row) => row.key === props.selected)
    moveTo((index < 0 ? 0 : index) + direction)
  }
  const movePage = (direction: -1 | 1) => {
    const index = rows().findIndex((row) => row.key === props.selected)
    moveTo((index < 0 ? 0 : index) + direction * Math.max(1, Math.floor((scroll?.viewport.height ?? 10) / (narrow() ? 2 : 1))))
  }
  const showDetails = () => {
    const row = selected()
    if (!row) return
    dialog.replace(() => <UsageDetails row={row} group={props.group} />)
  }
  const showRange = () => dialog.replace(() => (
    <UsageRangeDialog range={props.range} onSelect={props.onRange} onError={props.onRangeError} />
  ))

  createEffect(() => {
    const index = rows().findIndex((row) => row.key === props.selected)
    if (index < 0) return
    requestAnimationFrame(() => {
      if (!scroll || scroll.isDestroyed) return
      const top = index * (narrow() ? 2 : 1)
      const bottom = top + (narrow() ? 2 : 1)
      if (top < scroll.scrollTop) scroll.scrollTo(top)
      if (bottom > scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(bottom - scroll.viewport.height)
    })
  })

  Keymap.createLayer(() => ({
    mode: "base",
    commands: [
      { id: "provider-usage.group", title: "Choose usage grouping", group: "Usage", bind: "b", run: () => dialog.replace(() => <UsageGroupDialog current={usageGroupOptions.find((option) => option.value === props.group)?.value ?? "model"} onSelect={props.onGroup} />) },
      ...([{ key: "providerID", label: "Provider", bind: "p" }, { key: "profile", label: "Recorded profile", bind: "l" }, { key: "modelID", label: "Model ID", bind: "m" }, { key: "selectedEffort", label: "Selected effort", bind: "e" }] as const).map((field) => ({ id: `provider-usage.filter.${field.key}`, title: `Filter usage by ${field.label}`, group: "Usage", bind: field.bind,
        run: () => dialog.replace(() => <UsageFilterDialog label={field.label} value={props.filters[field.key]} onSelect={(value) => props.onFilter(field.key, value)} />) })),
      { id: "provider-usage.row.previous", title: "Previous usage row", group: "Usage", bind: "up", run: () => move(-1) },
      { id: "provider-usage.row.next", title: "Next usage row", group: "Usage", bind: "down", run: () => move(1) },
      { id: "provider-usage.row.home", title: "First usage row", group: "Usage", bind: "home", run: () => moveTo(0) },
      { id: "provider-usage.row.end", title: "Last usage row", group: "Usage", bind: "end", run: () => moveTo(rows().length - 1) },
      { id: "provider-usage.row.page-up", title: "Previous usage page", group: "Usage", bind: "pageup", run: () => movePage(-1) },
      { id: "provider-usage.row.page-down", title: "Next usage page", group: "Usage", bind: "pagedown", run: () => movePage(1) },
      { id: "provider-usage.row.details", title: "Usage details", group: "Usage", bind: "return", run: showDetails },
      { id: "provider-usage.sort.date", title: "Sort usage by date or name", group: "Usage", bind: "d", run: () => props.onSort("key") },
      { id: "provider-usage.sort.tokens", title: "Sort usage by tokens", group: "Usage", bind: "t", run: () => props.onSort("tokens") },
      { id: "provider-usage.sort.cost", title: "Sort usage by cost", group: "Usage", bind: "c", run: () => props.onSort("cost") },
      { id: "provider-usage.sort.steps", title: "Sort usage by steps", group: "Usage", bind: "s", run: () => props.onSort("steps") },
      { id: "provider-usage.sort.input", title: "Sort usage by input tokens", group: "Usage", bind: "i", run: () => props.onSort("input") },
      { id: "provider-usage.sort.output", title: "Sort usage by output tokens", group: "Usage", bind: "o", run: () => props.onSort("output") },
      { id: "provider-usage.sort.reasoning", title: "Sort usage by reasoning tokens", group: "Usage", bind: "g", run: () => props.onSort("reasoning") },
      { id: "provider-usage.sort.cache-read", title: "Sort usage by cache-read tokens", group: "Usage", bind: "a", run: () => props.onSort("cacheRead") },
      { id: "provider-usage.sort.cache-write", title: "Sort usage by cache-write tokens", group: "Usage", bind: "w", run: () => props.onSort("cacheWrite") },
      { id: "provider-usage.range", title: "Choose usage range", group: "Usage", bind: "f", run: showRange },
      { id: "provider-usage.page.previous", title: "Previous server page", group: "Usage", bind: "[", run: () => props.onOffset(Math.max(0, props.offset - PAGE_SIZE)) },
      { id: "provider-usage.page.next", title: "Next server page", group: "Usage", bind: "]", run: () => {
        const next = props.state.report?.nextOffset
        if (next !== undefined) props.onOffset(next)
      } },
    ],
  }))

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <Show when={props.rangeError}>
        {(error) => <text flexShrink={0} fg={theme.text.feedback.error.default}>{error()}</text>}
      </Show>
      <Show when={props.state.loading && props.state.report}>
        <text flexShrink={0} fg={theme.text.feedback.warning.default}>Refreshing · showing previous data</text>
      </Show>
      <Show when={props.state.failed}>
        <text flexShrink={0} fg={theme.text.feedback.error.default}>
          {props.state.stale ? "Refresh failed · showing stale data" : "Usage report could not be loaded."}
        </text>
      </Show>
      <Show when={!props.state.report && props.state.loading}>
        <text flexShrink={0} fg={theme.text.subdued}>Loading usage...</text>
      </Show>
      <Show when={props.state.report}>
        {(report) => (
          <>
            <text flexShrink={0} fg={theme.text.default} attributes={TextAttributes.BOLD}>
              {providerUsageViewLabel(props.view)} · All sessions · Group {props.group}{props.filters.selectedEffort ? ` · selected effort ${props.filters.selectedEffort}` : ""}
            </text>
            <Show when={!narrow()}><text flexShrink={0} fg={theme.text.subdued} wrapMode="word">b group · p provider · l profile · m model · e selected effort</text></Show>
            <Show when={props.group === "task"}><text flexShrink={0} fg={theme.text.subdued}>Inclusive task rows overlap; do not add them for a family total.</text></Show>
            <text flexShrink={0} fg={theme.border.default}>{"─".repeat(Math.max(1, Math.min(dimensions().width - 6, 96)))}</text>
            <Show when={!narrow()} fallback={<text flexShrink={0} fg={theme.text.subdued}>{compactHeader(props.view, props.sort, props.order)}</text>}>
              <ReportHeader view={props.view} width={dimensions().width} sort={props.sort} order={props.order} onSort={props.onSort} />
            </Show>
            <scrollbox
              ref={(value: ScrollBoxRenderable) => { scroll = value }}
              flexGrow={1}
              minHeight={1}
              scrollbarOptions={{ visible: false }}
            >
              <For each={report().rows}>
                {(row) => (
                  <box
                    width="100%"
                    flexShrink={0}
                    backgroundColor={row.key === props.selected ? theme.background.surface.offset : undefined}
                    onMouseUp={() => {
                      if (row.key === props.selected) showDetails()
                      else props.onSelect(row.key)
                    }}
                  >
                    <Show
                      when={!narrow()}
                      fallback={<CompactReportRow row={row} group={props.group} selected={() => row.key === props.selected} width={dimensions().width} />}
                    >
                      <WideReportRow row={row} group={props.group} selected={() => row.key === props.selected} width={dimensions().width} />
                    </Show>
                  </box>
                )}
              </For>
            </scrollbox>
            <box flexShrink={0} flexDirection="column">
              <text attributes={TextAttributes.BOLD}>{reportTotal(report().total)}</text>
              <text fg={theme.text.subdued}>
                {Locale.truncate(narrow() ? "b group · p provider · l profile · m model · e effort · retained analytics" : REPORT_LEGEND, Math.max(1, dimensions().width - 6))}
              </text>
              <text fg={theme.text.subdued}>
                Scope: All sessions · Range: {rangeLabel(props.range)} · Sort: {sortLabel(props.sort, props.order)} · {pageLabel(props.offset, report())}
              </text>
              <box flexDirection="row">
                <text fg={theme.text.subdued} onMouseUp={() => props.onSort("key")}>d date/name</text>
                <text fg={theme.text.subdued}> · </text>
                <text fg={theme.text.subdued} onMouseUp={() => props.onSort("tokens")}>t tokens</text>
                <text fg={theme.text.subdued}> · </text>
                <text fg={theme.text.subdued} onMouseUp={() => props.onSort("cost")}>c cost</text>
                <text fg={theme.text.subdued}> · </text>
                <text fg={theme.text.subdued} onMouseUp={showRange}>f range</text>
                <text fg={theme.text.subdued}> · Enter details</text>
                <box flexGrow={1} />
                <text fg={props.offset > 0 ? theme.text.default : theme.text.subdued} onMouseUp={() => props.onOffset(Math.max(0, props.offset - PAGE_SIZE))}>[ previous ]</text>
                <text> </text>
                <text
                  fg={report().nextOffset !== undefined ? theme.text.default : theme.text.subdued}
                  onMouseUp={() => {
                    if (report().nextOffset !== undefined) props.onOffset(report().nextOffset!)
                  }}
                >
                  [ next ]
                </text>
              </box>
            </box>
          </>
        )}
      </Show>
    </box>
  )
}

function UsageDetails(props: { row: UsageReportOutput["rows"][number]; group: UsageReportOutput["group"] }) {
  const dialog = useDialog()
  const { theme } = useTheme().contextual("elevated")
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined
  Keymap.createLayer(() => ({ mode: "modal", commands: [
    { id: "usage.details.page-up", title: "Scroll usage details up", bind: "pageup", run: () => scroll?.scrollBy(-Math.max(1, scroll.viewport.height)) },
    { id: "usage.details.page-down", title: "Scroll usage details down", bind: "pagedown", run: () => scroll?.scrollBy(Math.max(1, scroll.viewport.height)) },
  ] }))
  onMount(() => dialog.setSize("medium"))
  return (
    <box flexDirection="column" paddingBottom={1}>
      <DialogHeader title={<DialogTitle>Usage details</DialogTitle>} />
      <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} maxHeight={Math.max(3, dimensions().height - Math.floor(dimensions().height / 4) - 6)} scrollbarOptions={{ visible: false }}>
      <box flexDirection="column" paddingLeft={3} paddingRight={3} paddingTop={1}>
        <text fg={theme.text.feedback.info.default}>{reportLabel(props.row, props.group)}</text>
        <text>Steps (model calls) {formatNumber(props.row.logical)} · provider attempts {formatNumber(props.row.physical)}</text>
        <text>Helpers {formatNumber(props.row.helpers)} · continued {formatNumber(props.row.continued)} · fallback {formatNumber(props.row.fallback)}</text>
        <text>Input {formatNumber(props.row.tokens.input)} · Visible output {formatNumber(props.row.tokens.output)}</text>
        <text>Reasoning {formatNumber(props.row.tokens.reasoning)}</text>
        <text>Cache read {cacheRead(props.row, formatNumber)} · write {formatNumber(props.row.tokens.cache.write)}</text>
        <text>Total tokens {tokenTotalLabel(props.row, formatNumber)} · {props.group === "task" ? "Cost (inclusive)" : "Cost"} {costLabel(props.row)}</text>
        <text>First output p50 {latency(props.row.speed?.firstOutputP50Ms)} · p95 {latency(props.row.speed?.firstOutputP95Ms)}</text>
        <text>Total p50 {latency(props.row.speed?.totalP50Ms)} · p95 {latency(props.row.speed?.totalP95Ms)} · Output {throughput(props.row.speed?.outputTokensPerSecond)}</text>
        <UsageSpeedDetails speed={props.row.speed} />
        <text>{props.row.costCoverage ? `${props.row.costCoverage.pricedRequests} priced · ${props.row.costCoverage.unpricedRequests} unpriced` : "Cost coverage unreported"}</text>
        <Show when={props.row.model?.variant}><text>Selected effort {props.row.model?.variant}</text></Show>
        <Show when={props.row.dimensions && "profileState" in props.row.dimensions}><text>{props.row.dimensions && "profileState" in props.row.dimensions && props.row.dimensions.profileState === "provider-default" ? "Provider default at request time" : "Recorded profile"}</text></Show>
        <Show when={props.row.cacheReadReported !== true}>
          <text fg={theme.text.subdued}>≥ marks a lower bound: the provider did not report every cache read.</text>
        </Show>
      </box>
      </scrollbox>
      <text paddingLeft={3} fg={theme.text.subdued}>Page Up/Page Down scroll · Escape close</text>
    </box>
  )
}

export function UsageRangeDialog(props: {
  range: DateRange
  onSelect: (range: DateRange) => void
  onError: (error: string | undefined) => void
}) {
  const dialog = useDialog()
  const options = [
    { title: "All retained history", value: "all" as const },
    { title: "Last 7 days", value: "last7" as const },
    { title: "Last 30 days", value: "last30" as const },
    { title: "Custom UTC range", value: "custom" as const },
  ]
  return (
    <DialogSelect
      title="Usage range"
      options={options}
      current={props.range.type}
      renderFilter={false}
      onSelect={(option) => {
        if (option.value !== "custom") {
          props.onSelect({ type: option.value })
          dialog.clear()
          return
        }
        dialog.replace(() => (
          <DialogPrompt
            title="Date range (UTC)"
            placeholder="FROM..TO (YYYY-MM-DD..YYYY-MM-DD)"
            description={() => <text>From is inclusive; To is exclusive.</text>}
            onConfirm={(value) => {
              const [fromLabel, toLabel, ...extra] = value.split("..").map((part) => part.trim())
              const from = fromLabel ? parseUtcDate(fromLabel) : undefined
              const to = toLabel ? parseUtcDate(toLabel) : undefined
              if (!fromLabel || !toLabel || extra.length > 0 || from === undefined || to === undefined || from >= to) {
                props.onError("Enter valid From..To UTC dates (YYYY-MM-DD..YYYY-MM-DD).")
                dialog.clear()
                return
              }
              props.onSelect({ type: "custom", from, to, fromLabel, toLabel })
              dialog.clear()
            }}
          />
        ))
      }}
    />
  )
}

function ProviderUsageStats(props: {
  state: ReportState
  now: number
}) {
  const themeContext = useTheme()
  const theme = themeContext.theme
  const dimensions = useTerminalDimensions()
  const rows = createMemo(() => props.state.report?.rows ?? [])
  const byDay = createMemo(() => new Map(rows().map((row) => [row.key.slice(0, 10), row])))
  const today = createMemo(() => startOfUtcDay(props.now))
  const layout = createMemo(() => {
    const available = Math.max(8, dimensions().width - 10)
    const cell = available >= 52 * 3 ? 3 : 2
    return { cell, weeks: Math.max(1, Math.min(52, Math.floor(available / cell))) }
  })
  const graphStart = createMemo(() => today() - (new Date(today()).getUTCDay() + (layout().weeks - 1) * 7) * DAY)
  const maximum = createMemo(() => Math.max(1, ...rows().map(knownTokens)))
  const palette = createMemo(() =>
    themeContext.mode() === "light"
      ? [theme.hue.gray[200], theme.hue.green[300], theme.hue.green[500], theme.hue.green[700], theme.hue.green[900]]
      : [theme.hue.gray[800], theme.hue.green[800], theme.hue.green[600], theme.hue.green[400], theme.hue.green[200]],
  )
  const level = (row: UsageReportOutput["rows"][number] | undefined) => {
    if (!row || knownTokens(row) === 0) return 0
    const ratio = knownTokens(row) / maximum()
    return ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1
  }
  const cells = (weekday: number) =>
    Array.from({ length: layout().weeks }, (_, week) => {
      const time = graphStart() + (week * 7 + weekday) * DAY
      if (time > today()) return { text: " ".repeat(layout().cell), color: palette()[0] }
      return { text: "█".repeat(layout().cell), color: palette()[level(byDay().get(isoDay(time)))] }
    })
  const months = createMemo(() =>
    Array.from({ length: layout().weeks }, (_, week) => new Date(graphStart() + week * 7 * DAY)).reduce(
      (line, date, week) => {
        const position = week * layout().cell
        const starts = week === 0 ? date.getUTCDate() <= 7 : new Date(date.getTime() - 7 * DAY).getUTCMonth() !== date.getUTCMonth()
        if (!starts || position < line.length + (line.length === 0 ? 0 : 1)) return line
        return line.padEnd(position) + MONTHS[date.getUTCMonth()]
      },
      "",
    ),
  )
  const summary = createMemo(() => {
    const start = statsDateBounds(props.now).from
    const days = Math.floor((today() - start) / DAY) + 1
    const active = Array.from({ length: days }, (_, index) => knownTokens(byDay().get(isoDay(start + index * DAY))) > 0)
    const longest = active.reduce((result, value) => {
      const run = value ? result.run + 1 : 0
      return { run, best: Math.max(result.best, run) }
    }, { run: 0, best: 0 }).best
    const trailing = active.at(-1) ? active : active.slice(0, -1)
    const current = trailing.length - (trailing.findLastIndex((value) => !value) + 1)
    const busiest = rows().reduce<UsageReportOutput["rows"][number] | undefined>(
      (best, row) => (best === undefined || knownTokens(row) > knownTokens(best) ? row : best),
      undefined,
    )
    const first = rows().map((row) => row.key.slice(0, 10)).toSorted()[0]
    return { days, active: active.filter(Boolean).length, longest, current, busiest, first }
  })

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <text attributes={TextAttributes.BOLD} fg={theme.text.feedback.info.default}>
        Activity graph · last {layout().weeks} weeks
      </text>
      <Show when={props.state.loading && !props.state.report}>
        <text fg={theme.text.subdued}>Loading daily usage...</text>
      </Show>
      <Show when={props.state.failed}>
        <text fg={theme.text.feedback.error.default}>
          {props.state.stale ? "Refresh failed · showing stale data" : "Activity graph could not be loaded."}
        </text>
      </Show>
      <Show when={props.state.report}>
        {(report) => (
          <>
            <box flexDirection="column" paddingTop={1}>
              <text fg={theme.text.subdued}>{"    "}{months()}</text>
              <For each={WEEKDAYS}>
                {(label, weekday) => (
                  <text>
                    <span style={{ fg: theme.text.subdued }}>{label} </span>
                    <For each={cells(weekday())}>{(cell) => <span style={{ fg: cell.color }}>{cell.text}</span>}</For>
                  </text>
                )}
              </For>
              <text paddingTop={1}>
                <span style={{ fg: theme.text.subdued }}>Less </span>
                <For each={palette()}>{(color) => <span style={{ fg: color }}>{"█".repeat(layout().cell)} </span>}</For>
                <span style={{ fg: theme.text.subdued }}>More · shade = tokens per UTC day</span>
              </text>
            </box>
            <text paddingTop={1} attributes={TextAttributes.BOLD} fg={theme.text.feedback.info.default}>Stats</text>
            <box flexDirection="row" paddingTop={1}>
              <box flexDirection="column" width="50%">
                <StatLine label="Favorite model" value={props.state.stats?.favoriteModel ?? "No usage yet"} color={theme.text.feedback.success.default} />
                <StatLine label="Sessions" value={formatNumber(props.state.stats?.sessions ?? 0)} color={theme.text.feedback.info.default} />
                <StatLine label="Current streak" value={dayCount(summary().current)} color={theme.text.feedback.info.default} />
                <StatLine label="Active days" value={`${formatNumber(summary().active)}/${formatNumber(summary().days)}`} color={theme.text.feedback.info.default} />
              </box>
              <box flexDirection="column" width="50%">
                <StatLine label="Total tokens" value={tokenTotalLabel(report().total, compactNumber)} color={theme.text.feedback.info.default} />
                <StatLine label="Total cost" value={tableCost(report().total)} color={theme.text.feedback.warning.default} />
                <StatLine label="Longest streak" value={dayCount(summary().longest)} color={theme.text.feedback.info.default} />
                <StatLine
                  label="Busiest day"
                  value={summary().busiest ? `${summary().busiest!.key.slice(0, 10)} · ${tokenTotalLabel(summary().busiest!, compactNumber)} tokens` : "No usage yet"}
                  color={theme.text.feedback.info.default}
                />
              </box>
            </box>
            <box flexGrow={1} />
            <text fg={theme.text.subdued}>
              {summary().first
                ? "Retained history only; missing days do not prove inactivity."
                : "No usage recorded in the last 52 weeks."}
            </text>
          </>
        )}
      </Show>
    </box>
  )
}

function StatLine(props: { label: string; value: string; color: RGBA }) {
  const { theme } = useTheme()
  return (
    <text>
      <span style={{ fg: theme.text.subdued }}>{props.label}: </span>
      <span style={{ fg: props.color }}>{props.value}</span>
    </text>
  )
}

function dayCount(value: number) {
  return `${formatNumber(value)} ${value === 1 ? "day" : "days"}`
}

function isoDay(time: number) {
  return new Date(time).toISOString().slice(0, 10)
}

function compactHeader(view: ProviderUsageReportView, sort: Sort, order: Order) {
  const heading = sort === "key" ? nameHeading(view) : sort === "tokens" ? "TOTAL" : sort === "cacheRead" ? "CACHE READ" : sort === "cacheWrite" ? "CACHE WRITE" : sort.toUpperCase()
  return `${nameHeading(view)} · STEPS / TOTAL TOKENS / COST · ${heading} ${sortIndicator(sort, order)}`
}

function CompactReportRow(props: {
  row: UsageReportOutput["rows"][number]
  group: UsageReportOutput["group"]
  selected: () => boolean
  width: number
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" width="100%">
      <text fg={props.selected() ? theme.text.feedback.info.default : theme.text.default} attributes={props.selected() ? TextAttributes.BOLD : undefined}>
        {props.selected() ? ">" : " "} {Locale.truncate(reportLabel(props.row, props.group), Math.max(1, props.width - 8))}
      </text>
      <text>
        {"  "}<span>{formatNumber(props.row.logical)} steps</span>
        <span style={{ fg: theme.text.subdued }}> · </span>
        <span style={{ fg: theme.text.feedback.info.default }}>{tokenTotalLabel(props.row, compactNumber)} tokens</span>
        <span style={{ fg: theme.text.subdued }}> · </span>
        <span style={{ fg: theme.text.feedback.success.default }}>{tableCost(props.row)}</span>
      </text>
    </box>
  )
}

function reportGeometry(width: number) {
  const available = Math.max(1, width - 6)
  const columns = { steps: 7, input: 8, output: 8, reasoning: 8, read: 11, write: 11, total: 9, cost: 14, speed: 11 }
  const primary = Object.entries(columns).reduce((total, [key, value]) => total + (key === "speed" ? 0 : value), 0) + 8
  const timing = available >= 60 + primary + 5 * (columns.speed + 1)
  const reserved = primary + (timing ? 5 * (columns.speed + 1) : 0)
  return { ...columns, timing, name: Math.max(22, available - reserved), fits: available >= 60 + primary }
}

function ReportHeader(props: {
  view: ProviderUsageReportView
  width: number
  sort: Sort
  order: Order
  onSort: (sort: Sort) => void
}) {
  const geometry = reportGeometry(props.width)
  const columns = [
    { key: "key" as const, label: nameHeading(props.view), width: geometry.name },
    { key: "steps" as const, label: "STEPS", width: geometry.steps },
    { key: "input" as const, label: "INPUT", width: geometry.input },
    { key: "output" as const, label: "OUTPUT", width: geometry.output },
    { key: "reasoning" as const, label: "REASON", width: geometry.reasoning },
    { key: "cacheRead" as const, label: "CACHE READ", width: geometry.read },
    { key: "cacheWrite" as const, label: "CACHE WRITE", width: geometry.write },
    { key: "tokens" as const, label: "TOTAL", width: geometry.total },
    { key: "cost" as const, label: "COST", width: geometry.cost },
    ...(geometry.timing ? [
    { key: undefined, label: "FIRST P50", width: geometry.speed },
    { key: undefined, label: "FIRST P95", width: geometry.speed },
    { key: undefined, label: "TOTAL P50", width: geometry.speed },
    { key: undefined, label: "TOTAL P95", width: geometry.speed },
    { key: undefined, label: "TOK/S", width: geometry.speed },
    ] : []),
  ]
  return (
    <box flexShrink={0} flexDirection="row">
      <For each={columns}>{(column, index) => (
        <text
          width={column.width + (index() > 0 ? 1 : 0)}
          onMouseUp={() => column.key && props.onSort(column.key)}
        >
          {index() > 0 ? "\u00a0" : ""}{column.key ? headerLabel(column.label, column.key, column.width, props.sort, props.order) : column.label.padStart(column.width)}
        </text>
      )}</For>
    </box>
  )
}

function headerLabel(label: string, key: Sort, width: number, sort: Sort, order: Order) {
  const indicator = sort === key ? ` ${sortIndicator(sort, order)}` : ""
  const value = `${label}${indicator}`
  return key === "key" ? value.padEnd(width) : value.padStart(width)
}

function sortIndicator(sort: Sort, order: Order) {
  return order === "asc" ? "▲" : "▼"
}

function WideReportRow(props: {
  row: UsageReportOutput["rows"][number]
  group: UsageReportOutput["group"]
  selected: () => boolean
  width: number
}) {
  const { theme } = useTheme()
  const geometry = reportGeometry(props.width)
  return (
    <text attributes={props.selected() ? TextAttributes.BOLD : undefined}>
      <span style={{ fg: props.selected() ? theme.text.feedback.info.default : theme.text.default }}>{`${props.selected() ? ">" : " "} ${Locale.truncate(reportLabel(props.row, props.group), geometry.name - 2)}`.padEnd(geometry.name)}</span>{" "}
      <span>{compactNumber(props.row.logical).padStart(geometry.steps)}</span>{" "}
      <span style={{ fg: theme.text.feedback.success.default }}>{compactNumber(props.row.tokens.input).padStart(geometry.input)}</span>{" "}
      <span style={{ fg: theme.text.feedback.warning.subdued }}>{compactNumber(props.row.tokens.output).padStart(geometry.output)}</span>{" "}
      <span style={{ fg: theme.text.label }}>{compactNumber(props.row.tokens.reasoning).padStart(geometry.reasoning)}</span>{" "}
      <span style={{ fg: theme.text.feedback.info.default }}>{cacheRead(props.row, compactNumber).padStart(geometry.read)}</span>{" "}
      <span style={{ fg: theme.text.feedback.info.subdued }}>{compactNumber(props.row.tokens.cache.write).padStart(geometry.write)}</span>{" "}
      <span style={{ fg: theme.text.default }}>{tokenTotalLabel(props.row, compactNumber).padStart(geometry.total)}</span>{" "}
      <span style={{ fg: theme.text.feedback.success.subdued }}>{tableCost(props.row).padStart(geometry.cost)}</span>
      <Show when={geometry.timing}>{" "}
      <span style={{ fg: theme.text.subdued }}>{latency(props.row.speed?.firstOutputP50Ms).padStart(geometry.speed)}</span>{" "}
      <span style={{ fg: theme.text.subdued }}>{latency(props.row.speed?.firstOutputP95Ms).padStart(geometry.speed)}</span>{" "}
      <span style={{ fg: theme.text.subdued }}>{latency(props.row.speed?.totalP50Ms).padStart(geometry.speed)}</span>{" "}
      <span style={{ fg: theme.text.subdued }}>{latency(props.row.speed?.totalP95Ms).padStart(geometry.speed)}</span>{" "}
      <span style={{ fg: theme.text.subdued }}>{(props.row.speed?.outputTokensPerSecond === undefined ? "unreported" : props.row.speed.outputTokensPerSecond.toFixed(1)).padStart(geometry.speed)}</span>
      </Show>
    </text>
  )
}

function nameHeading(view: ProviderUsageReportView) {
  return view === "daily" || view === "hourly" || view === "monthly" ? "DATE" : "NAME"
}

export function dateBounds(range: DateRange, now: number) {
  if (range.type === "all") return {}
  if (range.type === "custom") return { from: range.from, to: range.to }
  const tomorrow = startOfUtcDay(now) + DAY
  return { from: tomorrow - (range.type === "last7" ? 7 : 30) * DAY, to: tomorrow }
}

function statsDateBounds(now: number) {
  const today = startOfUtcDay(now)
  return { from: today - (new Date(today).getUTCDay() + 51 * 7) * DAY, to: today + DAY }
}

function startOfUtcDay(now: number) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function parseUtcDate(value: string) {
  const label = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return undefined
  const result = Date.parse(`${label}T00:00:00.000Z`)
  if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== label) return undefined
  return result
}

export function rangeLabel(range: DateRange) {
  if (range.type === "custom") return `${range.fromLabel} → ${range.toLabel}`
  if (range.type === "last7") return "Last 7 days"
  if (range.type === "last30") return "Last 30 days"
  return "All retained history"
}

function sortLabel(sort: Sort, order: Order) {
  const label = sort === "key" ? "date/name" : sort === "tokens" ? "total tokens" : sort === "cacheRead" ? "cache read" : sort === "cacheWrite" ? "cache write" : sort
  return `${label} ${order === "asc" ? "ascending" : "descending"}`
}

function cacheRead(value: ReportMetrics, format: (value: number) => string) {
  if (value.cacheReadReported === true) return format(value.tokens.cache.read)
  return value.tokens.cache.read > 0 ? `≥${format(value.tokens.cache.read)}` : "Unknown"
}

function knownTokens(value: ReportMetrics | undefined) {
  if (!value) return 0
  return value.tokens.input + value.tokens.output + value.tokens.reasoning + value.tokens.cache.read + value.tokens.cache.write
}

function tokenTotalLabel(value: ReportMetrics, format: (value: number) => string) {
  if (value.cacheReadReported === true) return format(knownTokens(value))
  return knownTokens(value) > 0 ? `≥${format(knownTokens(value))}` : "Unknown"
}

function tableCost(value: ReportMetrics) {
  if (value.cost === undefined) return "unreported"
  const price =
    Math.abs(value.cost) >= 100_000
      ? `${value.cost < 0 ? "-" : ""}$${compactNumber(Math.abs(value.cost))}`
      : usd(value.cost, false)
  return value.costCoverage?.unpricedRequests ? `${price} + ?` : value.costCoverage === undefined ? `Known ${price}` : price
}

function latency(value: number | undefined) {
  return value === undefined ? "unreported" : `${formatNumber(value)}ms`
}

function throughput(value: number | undefined) {
  return value === undefined ? "unreported" : `${value.toFixed(1)} tok/s`
}

function costLabel(value: ReportMetrics) {
  if (value.costCoverage === undefined) return value.cost === undefined ? "unreported" : `Known ${usd(value.cost, false)} · coverage unreported`
  return costText({ ...value.costCoverage, known: value.cost, provenance: value.costProvenance,
    ...(value.costCoverage.unpricedRequests === 0 && value.cost !== undefined ? { total: value.cost } : {}) })
}

function reportTotal(value: UsageReportOutput["total"]) {
  return `Total · ${formatNumber(value.logical)} steps · ${tokenTotalLabel(value, formatNumber)} tokens · ${costLabel(value)}`
}

function pageLabel(offset: number, report: UsageReportOutput) {
  if (report.rows.length === 0) return `Rows 0 of ${formatNumber(report.rowCount)}`
  return `Rows ${formatNumber(offset + 1)}–${formatNumber(offset + report.rows.length)} of ${formatNumber(report.rowCount)}`
}

function compactNumber(value: number) {
  if (value < 100_000) return formatNumber(value)
  if (value >= 999_950_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 999_950) return `${(value / 1_000_000).toFixed(1)}M`
  return `${(value / 1_000).toFixed(1)}K`
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US")
}
