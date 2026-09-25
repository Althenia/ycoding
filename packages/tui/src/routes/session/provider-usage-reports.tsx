import type { ProviderRequestReport } from "@ycoding-ai/client"
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { DialogHeader, DialogTitle, useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogSelect } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"

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
] as const

export type ProviderUsageView = (typeof PROVIDER_USAGE_VIEWS)[number]
export type ProviderUsageReportView = Exclude<ProviderUsageView, "overview" | "usage">
export type ProviderUsageReportInput = {
  group: ProviderRequestReport["group"]
  from?: number
  to?: number
  offset?: number
  limit?: number
  sort?: "key" | "tokens" | "cost"
  order?: "asc" | "desc"
}

type DateRange =
  | { type: "last7" | "last30" | "all" }
  | { type: "custom"; from: number; to: number; fromLabel: string; toLabel: string }
type Sort = NonNullable<ProviderUsageReportInput["sort"]>
type Order = NonNullable<ProviderUsageReportInput["order"]>
type ReportState = {
  queryKey: string
  report?: ProviderRequestReport
  loading: boolean
  failed: boolean
  stale: boolean
}

const PAGE_SIZE = 100
const STATS_PAGE_SIZE = 200
const DAY = 24 * 60 * 60 * 1_000

export function providerUsageViewLabel(view: ProviderUsageView) {
  return view[0].toUpperCase() + view.slice(1)
}

export function providerUsageReportGroup(view: ProviderUsageReportView): ProviderRequestReport["group"] {
  if (view === "models") return "model"
  if (view === "daily" || view === "stats") return "day"
  if (view === "hourly") return "hour"
  if (view === "monthly") return "month"
  if (view === "sessions") return "session"
  if (view === "projects") return "project"
  return "agent"
}

export function ProviderUsageReports(props: {
  view: ProviderUsageReportView
  refresh: number
  now?: () => number
  load?: (input: ProviderUsageReportInput) => Promise<ProviderRequestReport>
}) {
  const [range, setRange] = createSignal<DateRange>({ type: "all" })
  const [sort, setSort] = createSignal<Sort>("key")
  const [order, setOrder] = createSignal<Order>("asc")
  const [page, setPage] = createSignal({ view: props.view, offset: 0 })
  const [selected, setSelected] = createSignal<string>()
  const [rangeError, setRangeError] = createSignal<string>()
  const [state, setState] = createSignal<ReportState>({ queryKey: "", loading: false, failed: false, stale: false })
  let generation = 0

  const stats = createMemo(() => props.view === "stats")
  const tableView = createMemo(() => props.view === "stats" ? undefined : props.view)
  const group = createMemo(() => providerUsageReportGroup(props.view))
  const offset = createMemo(() => page().view === props.view ? page().offset : 0)
  const setOffset = (value: number) => setPage({ view: props.view, offset: value })
  const changeSort = (next: Sort) => {
    setOrder((current) => sort() === next ? (current === "asc" ? "desc" : "asc") : next === "key" ? "asc" : "desc")
    setSort(next)
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
      (report) => {
        if (token !== generation) return
        const current = untrack(selected)
        setState({ queryKey, report, loading: false, failed: false, stale: false })
        setSelected(report.rows.some((row) => row.key === current) ? current : report.rows[0]?.key)
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
        />
      )}
    </Show>
  )
}

async function loadReport(
  loader: (input: ProviderUsageReportInput) => Promise<ProviderRequestReport>,
  query: ProviderUsageReportInput,
  stats: boolean,
) {
  const first = await loader(query)
  if (!stats || first.nextOffset === undefined) return first
  const second = await loader({ ...query, offset: first.nextOffset })
  return { ...first, rows: [...first.rows, ...second.rows], nextOffset: undefined }
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
}) {
  const { themeV2 } = useTheme()
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
    dialog.replace(() => <UsageDetails row={row} />)
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
        {(error) => <text flexShrink={0} fg={themeV2.text.feedback.error.default}>{error()}</text>}
      </Show>
      <Show when={props.state.loading && props.state.report}>
        <text flexShrink={0} fg={themeV2.text.feedback.warning.default}>Refreshing · showing previous data</text>
      </Show>
      <Show when={props.state.failed}>
        <text flexShrink={0} fg={themeV2.text.feedback.error.default}>
          {props.state.stale ? "Refresh failed · showing stale data" : "Usage report could not be loaded."}
        </text>
      </Show>
      <Show when={!props.state.report && props.state.loading}>
        <text flexShrink={0} fg={themeV2.text.subdued}>Loading usage...</text>
      </Show>
      <Show when={props.state.report}>
        {(report) => (
          <>
            <text flexShrink={0} fg={themeV2.text.default} attributes={TextAttributes.BOLD}>
              {providerUsageViewLabel(props.view)} · All sessions
            </text>
            <text flexShrink={0} fg={themeV2.border.default}>{"─".repeat(Math.max(1, Math.min(dimensions().width - 6, 96)))}</text>
            <text flexShrink={0} fg={themeV2.text.subdued}>
              {narrow() ? compactHeader(props.view) : wideHeader(props.view, dimensions().width)}
            </text>
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
                    backgroundColor={row.key === props.selected ? themeV2.background.surface.offset : undefined}
                    onMouseUp={() => {
                      if (row.key === props.selected) showDetails()
                      else props.onSelect(row.key)
                    }}
                  >
                    <Show
                      when={!narrow()}
                      fallback={<CompactReportRow row={row} selected={() => row.key === props.selected} width={dimensions().width} />}
                    >
                      <WideReportRow row={row} selected={() => row.key === props.selected} width={dimensions().width} />
                    </Show>
                  </box>
                )}
              </For>
            </scrollbox>
            <box flexShrink={0} flexDirection="column">
              <text attributes={TextAttributes.BOLD}>{reportTotal(report().total)}</text>
              <text fg={themeV2.text.subdued}>
                Scope: All sessions · Range: {rangeLabel(props.range)} · Sort: {sortLabel(props.sort, props.order)} · {pageLabel(props.offset, report())}
              </text>
              <box flexDirection="row">
                <text fg={themeV2.text.subdued} onMouseUp={() => props.onSort("key")}>d date/name</text>
                <text fg={themeV2.text.subdued}> · </text>
                <text fg={themeV2.text.subdued} onMouseUp={() => props.onSort("tokens")}>t tokens</text>
                <text fg={themeV2.text.subdued}> · </text>
                <text fg={themeV2.text.subdued} onMouseUp={() => props.onSort("cost")}>c cost</text>
                <text fg={themeV2.text.subdued}> · </text>
                <text fg={themeV2.text.subdued} onMouseUp={showRange}>f range</text>
                <text fg={themeV2.text.subdued}> · Enter details</text>
                <box flexGrow={1} />
                <text fg={props.offset > 0 ? themeV2.text.default : themeV2.text.subdued} onMouseUp={() => props.onOffset(Math.max(0, props.offset - PAGE_SIZE))}>[ previous ]</text>
                <text> </text>
                <text
                  fg={report().nextOffset !== undefined ? themeV2.text.default : themeV2.text.subdued}
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

function UsageDetails(props: { row: ProviderRequestReport["rows"][number] }) {
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  onMount(() => dialog.setSize("medium"))
  return (
    <box flexDirection="column" paddingBottom={1}>
      <DialogHeader title={<DialogTitle>Usage details</DialogTitle>} />
      <box flexDirection="column" paddingLeft={3} paddingRight={3} paddingTop={1}>
        <text fg={themeV2.text.feedback.info.default}>{props.row.label}</text>
        <text>Logical steps {formatNumber(props.row.logical)} · physical {formatNumber(props.row.physical)}</text>
        <text>Helpers {formatNumber(props.row.helpers)} · continued {formatNumber(props.row.continued)} · fallback {formatNumber(props.row.fallback)}</text>
        <text>Input {formatNumber(props.row.tokens.input)} · Visible output {formatNumber(props.row.tokens.output)}</text>
        <text>Reasoning {formatNumber(props.row.tokens.reasoning)}</text>
        <text>Cache read {cacheRead(props.row)} · write {formatNumber(props.row.tokens.cache.write)}</text>
        <text>Total tokens {tokenTotalLabel(props.row)} · Cost {costLabel(props.row)}</text>
      </box>
    </box>
  )
}

function UsageRangeDialog(props: {
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
  const { themeV2 } = useTheme()
  const rows = createMemo(() => props.state.report?.rows ?? [])
  const retained = createMemo(() => new Map(rows().map((row) => [row.key.slice(0, 10), row])))
  const dates = createMemo(() => {
    const today = startOfUtcDay(props.now)
    const start = today - (new Date(today).getUTCDay() + 51 * 7) * DAY
    return Array.from({ length: 52 * 7 }, (_, index) => new Date(start + index * DAY).toISOString().slice(0, 10))
  })
  const maximum = createMemo(() => Math.max(1, ...rows().map((row) => row.logical)))
  const range = createMemo(() => {
    const keys = rows().map((row) => row.key.slice(0, 10)).toSorted()
    if (keys.length === 0) return "No retained daily rows"
    return `Retained range ${keys[0]} → ${keys.at(-1)}`
  })
  const retainedDays = createMemo(() => rows().map((row) => row.key.slice(0, 10)).toSorted().slice(-7).join(" · "))
  const cells = (weekday: number) => dates().filter((_, index) => index % 7 === weekday).map((date) => {
    if (Date.parse(`${date}T00:00:00.000Z`) > startOfUtcDay(props.now)) return " "
    const row = retained().get(date)
    if (!row) return "·"
    const ratio = row.logical / maximum()
    return ratio >= 0.75 ? "█" : ratio >= 0.5 ? "▓" : ratio >= 0.25 ? "▒" : "░"
  }).join("")

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <text attributes={TextAttributes.BOLD}>Activity graph</text>
      <Show when={props.state.loading && !props.state.report}>
        <text fg={themeV2.text.subdued}>Loading retained daily usage...</text>
      </Show>
      <Show when={props.state.failed}>
        <text fg={themeV2.text.feedback.error.default}>
          {props.state.stale ? "Refresh failed · showing stale retained data" : "Activity graph could not be loaded."}
        </text>
      </Show>
      <Show when={props.state.report}>
        {(report) => (
          <>
            <box flexDirection="column" paddingTop={1}>
              <For each={["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]}>
                {(label, weekday) => <text fg={themeV2.text.subdued}>{label} {cells(weekday())}</text>}
              </For>
            </box>
            <text paddingTop={1}>{range()}</text>
            <Show when={retainedDays()}>{(days) => <text fg={themeV2.text.subdued}>Recent retained days · {days()}</text>}</Show>
            <text fg={themeV2.text.subdued}>Retained-history coverage only · coverage before the first retained row is Unreported.</text>
            <text fg={themeV2.text.subdued}>Legend · unknown · ░ low · ▒ medium · ▓ high · █ peak</text>
            <box flexGrow={1} />
            <text attributes={TextAttributes.BOLD}>{reportTotal(report().total)}</text>
            <text fg={themeV2.text.subdued}>Scope: All sessions · 52-week retained overview · {formatNumber(report().rowCount)} daily groups</text>
          </>
        )}
      </Show>
    </box>
  )
}

function compactHeader(view: ProviderUsageReportView) {
  return `${nameHeading(view)} · STEPS / TOTAL TOKENS / COST`
}

function CompactReportRow(props: {
  row: ProviderRequestReport["rows"][number]
  selected: () => boolean
  width: number
}) {
  const { themeV2 } = useTheme()
  return (
    <box flexDirection="column" width="100%">
      <text fg={props.selected() ? themeV2.text.feedback.info.default : themeV2.text.default} attributes={props.selected() ? TextAttributes.BOLD : undefined}>
        {props.selected() ? ">" : " "} {Locale.truncate(props.row.label, Math.max(1, props.width - 8))}
      </text>
      <text>
        {"  "}<span>{formatNumber(props.row.logical)} steps</span>
        <span style={{ fg: themeV2.text.subdued }}> · </span>
        <span style={{ fg: themeV2.text.feedback.info.default }}>{tokenTotalLabel(props.row)} tokens</span>
        <span style={{ fg: themeV2.text.subdued }}> · </span>
        <span style={{ fg: themeV2.text.feedback.success.default }}>{tableCost(props.row)}</span>
      </text>
    </box>
  )
}

function reportGeometry(width: number) {
  const available = Math.max(1, width - 6)
  const steps = 7
  const total = 13
  const input = 11
  const output = 14
  const reasoning = 10
  const cache = 17
  const cost = 16
  const reserved = steps + total + input + output + reasoning + cache + cost + 7
  return { name: Math.max(22, available - reserved), steps, total, input, output, reasoning, cache, cost, fits: available >= 22 + reserved }
}

function wideHeader(view: ProviderUsageReportView, width: number) {
  const geometry = reportGeometry(width)
  return `${nameHeading(view).padEnd(geometry.name)} ${"STEPS".padStart(geometry.steps)} ${"TOTAL TOKENS".padStart(geometry.total)} ${"INPUT".padStart(geometry.input)} ${"VISIBLE OUTPUT".padStart(geometry.output)} ${"REASON".padStart(geometry.reasoning)} ${"CACHE R/W".padStart(geometry.cache)} ${"COST".padStart(geometry.cost)}`
}

function WideReportRow(props: {
  row: ProviderRequestReport["rows"][number]
  selected: () => boolean
  width: number
}) {
  const { themeV2 } = useTheme()
  const geometry = reportGeometry(props.width)
  return (
    <text attributes={props.selected() ? TextAttributes.BOLD : undefined}>
      <span style={{ fg: props.selected() ? themeV2.text.feedback.info.default : themeV2.text.default }}>{`${props.selected() ? ">" : " "} ${Locale.truncate(props.row.label, geometry.name - 2)}`.padEnd(geometry.name)}</span>{" "}
      <span>{formatNumber(props.row.logical).padStart(geometry.steps)}</span>{" "}
      <span style={{ fg: themeV2.text.label }}>{tokenTotalLabel(props.row).padStart(geometry.total)}</span>{" "}
      <span style={{ fg: themeV2.text.feedback.success.default }}>{formatNumber(props.row.tokens.input).padStart(geometry.input)}</span>{" "}
      <span style={{ fg: themeV2.text.feedback.warning.subdued }}>{formatNumber(props.row.tokens.output).padStart(geometry.output)}</span>{" "}
      <span style={{ fg: themeV2.text.label }}>{formatNumber(props.row.tokens.reasoning).padStart(geometry.reasoning)}</span>{" "}
      <span style={{ fg: themeV2.text.feedback.info.default }}>{`${cacheRead(props.row)}/${formatNumber(props.row.tokens.cache.write)}`.padStart(geometry.cache)}</span>{" "}
      <span style={{ fg: themeV2.text.feedback.success.subdued }}>{tableCost(props.row).padStart(geometry.cost)}</span>
    </text>
  )
}

function nameHeading(view: ProviderUsageReportView) {
  return view === "daily" || view === "hourly" || view === "monthly" ? "DATE" : "NAME"
}

function dateBounds(range: DateRange, now: number) {
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

function rangeLabel(range: DateRange) {
  if (range.type === "custom") return `${range.fromLabel} → ${range.toLabel}`
  if (range.type === "last7") return "Last 7 days"
  if (range.type === "last30") return "Last 30 days"
  return "All retained history"
}

function sortLabel(sort: Sort, order: Order) {
  return `${sort === "key" ? "date/name" : sort} ${order === "asc" ? "ascending" : "descending"}`
}

function cacheRead(value: ProviderRequestReport["total"] | ProviderRequestReport["rows"][number]) {
  return value.cacheReadReported === true ? formatNumber(value.tokens.cache.read) : "-"
}

function tokenTotal(value: ProviderRequestReport["total"] | ProviderRequestReport["rows"][number]) {
  if (value.cacheReadReported !== true) return undefined
  return value.tokens.input + value.tokens.output + value.tokens.reasoning + value.tokens.cache.read + value.tokens.cache.write
}

function tokenTotalLabel(value: ProviderRequestReport["total"] | ProviderRequestReport["rows"][number]) {
  const total = tokenTotal(value)
  return total === undefined ? "-" : formatNumber(total)
}

function tableCost(value: ProviderRequestReport["total"] | ProviderRequestReport["rows"][number]) {
  if (value.cost === undefined) return "-"
  return value.costProvenance === "current_catalog" ? `$${value.cost.toFixed(2)} est.` : `$${value.cost.toFixed(2)}`
}

function costLabel(value: ProviderRequestReport["total"] | ProviderRequestReport["rows"][number]) {
  if (value.cost === undefined) return "-"
  if (value.costProvenance === "current_catalog") return `$${value.cost.toFixed(2)} estimated`
  if (value.costProvenance === "recorded") return `$${value.cost.toFixed(2)} recorded`
  return `$${value.cost.toFixed(2)} (source unreported)`
}

function reportTotal(value: ProviderRequestReport["total"]) {
  return `Total · ${formatNumber(value.logical)} logical steps · ${tokenTotalLabel(value)} tokens · ${costLabel(value)}`
}

function pageLabel(offset: number, report: ProviderRequestReport) {
  if (report.rows.length === 0) return `Rows 0 of ${formatNumber(report.rowCount)}`
  return `Rows ${formatNumber(offset + 1)}–${formatNumber(offset + report.rows.length)} of ${formatNumber(report.rowCount)}`
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US")
}
