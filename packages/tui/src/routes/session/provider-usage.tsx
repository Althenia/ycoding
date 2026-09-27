import type {
  ProviderRequestReport,
  ProviderRequestSummary,
  ProviderUsageListOutput,
} from "@ycoding-ai/client"
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { useClient } from "../../context/client"
import { Keymap } from "../../context/keymap"
import { useRoute, useRouteData } from "../../context/route"
import {
  formatBillDue,
  formatReset,
  formatWindowValue,
  freshnessLabel,
  progressBar,
  usageSeverity,
} from "../../util/provider-usage"
import { useTheme } from "../../context/theme"
import { BrandMark } from "../../component/logo"
import { Locale } from "../../util/locale"
import {
  PROVIDER_USAGE_VIEWS,
  ProviderUsageReports,
  providerUsageViewLabel,
  type ProviderUsageReportInput,
  type ProviderUsageView,
} from "./provider-usage-reports"

export type ProviderUsageSnapshot = ProviderUsageListOutput["data"][number]
const NAV_CELL_WIDTH = 12

export function visibleProviderSnapshots(snapshots: readonly ProviderUsageSnapshot[]) {
  return [...snapshots.filter((snapshot) => snapshot.status !== "unsupported").reduce((result, snapshot) => {
    const key = JSON.stringify([snapshot.providerID, snapshot.profile])
    const current = result.get(key)
    if (!current || snapshot.updatedAt >= current.updatedAt) result.set(key, snapshot)
    return result
  }, new Map<string, ProviderUsageSnapshot>()).values()]
    .toSorted((left, right) =>
      left.label.localeCompare(right.label) ||
      left.providerID.localeCompare(right.providerID) ||
      (left.profile ?? "").localeCompare(right.profile ?? ""))
}

export function createProviderUsageGenerationGuard() {
  let generation = 0
  return {
    next() {
      generation += 1
      return generation
    },
    current(token: number) {
      return token === generation
    },
    invalidate() {
      generation += 1
    },
  }
}

export function ProviderUsageScreen() {
  const route = useRouteData("provider-usage")
  const router = useRoute()
  const client = useClient()
  const guard = createProviderUsageGenerationGuard()
  const backendUsageGuard = createProviderUsageGenerationGuard()
  const [snapshots, setSnapshots] = createSignal<ProviderUsageSnapshot[]>([])
  const [refreshing, setRefreshing] = createSignal(true)
  const [failed, setFailed] = createSignal(false)
  const [backendUsage, setBackendUsage] = createSignal<ProviderRequestSummary>()
  const [backendUsageRefreshing, setBackendUsageRefreshing] = createSignal(true)
  const [backendUsageFailed, setBackendUsageFailed] = createSignal(false)
  const refresh = () => {
    const backendToken = backendUsageGuard.next()
    setBackendUsageRefreshing(true)
    setBackendUsageFailed(false)
    void client.api.usage
      .get()
      .then((summary) => {
        if (backendUsageGuard.current(backendToken)) setBackendUsage(summary)
      })
      .catch(() => {
        if (backendUsageGuard.current(backendToken)) setBackendUsageFailed(true)
      })
      .finally(() => {
        if (backendUsageGuard.current(backendToken)) setBackendUsageRefreshing(false)
      })
    const token = guard.next()
    setRefreshing(true)
    setFailed(false)
    void client.api.providerUsage
      .list({ refresh: true })
      .then((result) => {
        if (!guard.current(token)) return
        setSnapshots(visibleProviderSnapshots(result.data))
      })
      .catch(() => {
        if (guard.current(token)) setFailed(true)
      })
      .finally(() => {
        if (guard.current(token)) setRefreshing(false)
      })
  }
  onMount(refresh)
  onCleanup(() => {
    guard.invalidate()
    backendUsageGuard.invalidate()
  })

  const back = () => router.navigate(route.sessionID ? { type: "session", sessionID: route.sessionID } : { type: "home" })
  return (
    <ProviderUsageScreenContent
      snapshots={snapshots}
      backendUsage={backendUsage}
      backendUsageRefreshing={backendUsageRefreshing}
      backendUsageFailed={backendUsageFailed}
      refreshing={refreshing}
      failed={failed}
      onBack={back}
      onRefresh={refresh}
      loadReport={(input) => client.api.usage.report(input)}
    />
  )
}

export function ProviderUsageScreenContent(props: {
  snapshots: Accessor<readonly ProviderUsageSnapshot[]>
  backendUsage?: Accessor<ProviderRequestSummary | undefined>
  backendUsageRefreshing?: Accessor<boolean>
  backendUsageFailed?: Accessor<boolean>
  now?: Accessor<number>
  refreshing?: Accessor<boolean>
  failed?: Accessor<boolean>
  onBack?: () => void
  onRefresh?: () => void
  initialTab?: ProviderUsageView
  loadReport?: (input: ProviderUsageReportInput) => Promise<ProviderRequestReport>
}) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  const backShortcut = Keymap.useShortcut("provider-usage.back")
  const refreshShortcut = Keymap.useShortcut("provider-usage.refresh")
  const aggregateUsage = createMemo(() => {
    const summary = props.backendUsage?.()
    if (!summary) return undefined
    return [summaryPresentation(summary), ...(summary.models ?? []).map(spendPresentation)]
  })
  const [view, setView] = createSignal<ProviderUsageView>(props.initialTab ?? "overview")
  const [overviewSorting, setOverviewSorting] = createSignal<{ sort: OverviewSort; order: "asc" | "desc" }>({ sort: "cost", order: "desc" })
  const changeOverviewSort = (sort: OverviewSort) =>
    setOverviewSorting((current) => ({ sort, order: current.sort === sort ? (current.order === "asc" ? "desc" : "asc") : sort === "key" ? "asc" : "desc" }))
  const [reportRefresh, setReportRefresh] = createSignal(0)
  const reportView = createMemo(() => {
    const current = view()
    if (current === "overview" || current === "usage") return undefined
    return current
  })
  const visibleViews = createMemo(() => usageNavigationWindow(view(), dimensions().width))
  let simpleScroll: ScrollBoxRenderable | undefined
  const back = () => props.onBack?.()
  const refresh = () => {
    props.onRefresh?.()
    setReportRefresh((value) => value + 1)
  }
  const selectView = (next: ProviderUsageView) => {
    setView(next)
    requestAnimationFrame(() => simpleScroll?.scrollTo(0))
  }
  const moveView = (direction: -1 | 1) => {
    setView((current) => {
      const index = PROVIDER_USAGE_VIEWS.indexOf(current)
      return PROVIDER_USAGE_VIEWS[(index + direction + PROVIDER_USAGE_VIEWS.length) % PROVIDER_USAGE_VIEWS.length]
    })
    requestAnimationFrame(() => simpleScroll?.scrollTo(0))
  }
  const scrollSimple = (action: "up" | "down" | "home" | "end" | "pageup" | "pagedown") => {
    if (reportView() || !simpleScroll || simpleScroll.isDestroyed) return
    if (action === "home") return simpleScroll.scrollTo(0)
    if (action === "end") return simpleScroll.scrollTo(simpleScroll.scrollHeight)
    const distance = action === "pageup" || action === "pagedown" ? simpleScroll.viewport.height : 1
    simpleScroll.scrollBy(action === "up" || action === "pageup" ? -distance : distance)
  }
  Keymap.createLayer(() => ({
    mode: "base",
    commands: [
      { id: "provider-usage.back", title: "Back", group: "Provider usage", bind: "escape", run: back },
      { id: "provider-usage.refresh", title: "Refresh provider usage", group: "Provider usage", bind: "r", run: refresh },
      { id: "provider-usage.view.previous", title: "Previous usage view", group: "Provider usage", bind: "left", run: () => moveView(-1) },
      { id: "provider-usage.view.next", title: "Next usage view", group: "Provider usage", bind: "right", run: () => moveView(1) },
      { id: "provider-usage.view.previous-tab", title: "Previous usage view", group: "Provider usage", bind: "shift+tab", run: () => moveView(-1) },
      { id: "provider-usage.view.next-tab", title: "Next usage view", group: "Provider usage", bind: "tab", run: () => moveView(1) },
      { id: "provider-usage.scroll.previous", title: "Scroll usage up", group: "Provider usage", bind: reportView() ? false : "up", run: () => scrollSimple("up") },
      { id: "provider-usage.scroll.next", title: "Scroll usage down", group: "Provider usage", bind: reportView() ? false : "down", run: () => scrollSimple("down") },
      { id: "provider-usage.scroll.home", title: "First usage item", group: "Provider usage", bind: reportView() ? false : "home", run: () => scrollSimple("home") },
      { id: "provider-usage.scroll.end", title: "Last usage item", group: "Provider usage", bind: reportView() ? false : "end", run: () => scrollSimple("end") },
      { id: "provider-usage.scroll.page-up", title: "Scroll usage one page up", group: "Provider usage", bind: reportView() ? false : "pageup", run: () => scrollSimple("pageup") },
      { id: "provider-usage.scroll.page-down", title: "Scroll usage one page down", group: "Provider usage", bind: reportView() ? false : "pagedown", run: () => scrollSimple("pagedown") },
      { id: "provider-usage.overview.sort.key", title: "Sort overview models by name", group: "Usage", bind: view() === "overview" ? "d" : false, run: () => { changeOverviewSort("key") } },
      { id: "provider-usage.overview.sort.steps", title: "Sort overview models by steps", group: "Usage", bind: view() === "overview" ? "s" : false, run: () => { changeOverviewSort("steps") } },
      { id: "provider-usage.overview.sort.input", title: "Sort overview models by input tokens", group: "Usage", bind: view() === "overview" ? "i" : false, run: () => { changeOverviewSort("input") } },
      { id: "provider-usage.overview.sort.output", title: "Sort overview models by output tokens", group: "Usage", bind: view() === "overview" ? "o" : false, run: () => { changeOverviewSort("output") } },
      { id: "provider-usage.overview.sort.reasoning", title: "Sort overview models by reasoning tokens", group: "Usage", bind: view() === "overview" ? "g" : false, run: () => { changeOverviewSort("reasoning") } },
      { id: "provider-usage.overview.sort.cache-read", title: "Sort overview models by cache-read tokens", group: "Usage", bind: view() === "overview" ? "a" : false, run: () => { changeOverviewSort("cacheRead") } },
      { id: "provider-usage.overview.sort.cache-write", title: "Sort overview models by cache-write tokens", group: "Usage", bind: view() === "overview" ? "w" : false, run: () => { changeOverviewSort("cacheWrite") } },
      { id: "provider-usage.overview.sort.tokens", title: "Sort overview models by total tokens", group: "Usage", bind: view() === "overview" ? "t" : false, run: () => { changeOverviewSort("tokens") } },
      { id: "provider-usage.overview.sort.cost", title: "Sort overview models by cost", group: "Usage", bind: view() === "overview" ? "c" : false, run: () => { changeOverviewSort("cost") } },
    ],
    bindings: ["provider-usage.back", "provider-usage.refresh"],
  }))
  return (
    <box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={themeV2.background.default}>
      <box height={3} flexShrink={0} alignItems="center" flexDirection="row" paddingLeft={3} paddingRight={3} backgroundColor={themeV2.background.chrome}>
        <BrandMark width={2} height={1} />
        <text> Usage</text>
        <box flexGrow={1} />
        <box flexDirection="row" gap={2}>
          <text fg={themeV2.text.feedback.info.default} onMouseUp={refresh}>
            {refreshShortcut() ? `${refreshShortcut()} ` : ""}refresh
          </text>
          <text fg={themeV2.text.feedback.info.default} onMouseUp={back}>
            {backShortcut() ? `${backShortcut()} ` : ""}back
          </text>
        </box>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="column" paddingLeft={3} paddingRight={3}>
      <box flexShrink={0} height={3} flexDirection="row" alignItems="center">
        <For each={visibleViews()}>{(item, index) => (
          <>
            <Show when={index() > 0}><text flexShrink={0} fg={themeV2.border.default}>│</text></Show>
            <box width={NAV_CELL_WIDTH} height={1} flexShrink={0} alignItems="center" onMouseUp={() => selectView(item)}>
              <text
                fg={view() === item ? themeV2.text.feedback.info.default : themeV2.text.subdued}
                attributes={view() === item ? TextAttributes.BOLD : undefined}
              >
                {providerUsageViewLabel(item)}
              </text>
            </box>
          </>
        )}</For>
      </box>
      <Show when={!reportView()}>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => { simpleScroll = value }}
        flexGrow={1}
        minHeight={0}
        horizontalScrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: themeV2.background.default,
            foregroundColor: themeV2.scrollbar.default,
          },
        }}
        paddingBottom={1}
      >
        <Show when={view() === "overview" && props.backendUsageRefreshing?.() && props.backendUsage?.()}>
          <text fg={themeV2.text.feedback.warning.default}>Refreshing YCoding backend usage · showing previous data</text>
        </Show>
        <Show when={view() === "overview" && props.backendUsageFailed?.() && props.backendUsage?.()}>
          <text fg={themeV2.text.feedback.error.default}>YCoding backend usage refresh failed · showing stale data</text>
        </Show>
        <Show when={view() === "usage" && props.failed?.()}>
          <text fg={themeV2.text.feedback.warning.default}>Some provider usage could not be refreshed.</text>
        </Show>
        <Show when={view() === "overview" && aggregateUsage()}>
          {(items) => <OverviewTable items={items()} width={dimensions().width} sorting={overviewSorting} onSort={changeOverviewSort} />}
        </Show>
        <Show when={view() === "usage"}><For each={visibleProviderSnapshots(props.snapshots())}>
          {(snapshot) => <QuotaSection snapshot={snapshot} now={props.now?.() ?? Date.now()} />}
        </For></Show>
        <Show when={view() === "usage" && visibleProviderSnapshots(props.snapshots()).length === 0}>
          <text fg={themeV2.text.subdued}>{props.refreshing?.() ? "Loading provider quotas..." : props.failed?.() ? "Provider quotas could not be loaded." : "No provider quotas are reported."}</text>
        </Show>
        <Show
          when={view() === "overview" && !aggregateUsage()}
        >
          <text fg={themeV2.text.subdued}>
            {props.backendUsageFailed?.()
              ? "YCoding backend usage could not be loaded."
              : props.backendUsageRefreshing?.()
                ? "Loading YCoding backend usage..."
                : "No retained usage is reported across the YCoding backend."}
          </text>
        </Show>
      </scrollbox>
      </Show>
      <Show when={reportView()}>{(current) => (
        <ProviderUsageReports
          view={current()}
          refresh={reportRefresh()}
          now={props.now}
          load={props.loadReport}
        />
      )}</Show>
      </box>
      <box height={3} flexShrink={0} alignItems="center" flexDirection="row" paddingLeft={3} paddingRight={3} backgroundColor={themeV2.background.chrome}>
        <text fg={themeV2.text.subdued}>
          {reportView() ? "Local report cost · not a provider bill" : view() === "overview" ? "YCoding backend · All sessions · lifetime retained usage" : "Provider-reported quota windows"}
        </text>
        <box flexGrow={1} />
        <text fg={themeV2.text.subdued}>←→/Tab views · ↑↓ {reportView() ? "select" : "scroll"} · {refreshShortcut() ? `${refreshShortcut()} refresh` : "refresh"} · {backShortcut() ? `${backShortcut()} back` : "back"}</text>
      </box>
    </box>
  )
}

function usageNavigationWindow(active: ProviderUsageView, width: number) {
  const count = Math.max(1, Math.floor((width - 6 + 1) / (NAV_CELL_WIDTH + 1)))
  const index = PROVIDER_USAGE_VIEWS.indexOf(active)
  const start = Math.min(index, Math.max(0, PROVIDER_USAGE_VIEWS.length - count))
  return PROVIDER_USAGE_VIEWS.slice(start, start + count)
}

function OverviewTable(props: {
  items: readonly OverviewItem[]
  width: number
  sorting: () => { sort: OverviewSort; order: "asc" | "desc" }
  onSort: (sort: OverviewSort) => void
}) {
  const { themeV2 } = useTheme()
  const geometry = () => overviewGeometry(props.width)
  const narrow = () => !geometry().fits
  const orderedItems = createMemo(() => {
    const current = props.sorting()
    const metric = (item: OverviewItem) => current.sort === "key" ? item.model : item.values[current.sort]
    return [props.items[0], ...props.items.slice(1).toSorted((left, right) => {
      const a = metric(left)
      const b = metric(right)
      const comparison = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))
      return (current.order === "asc" ? comparison : -comparison) || left.model.localeCompare(right.model)
    })].filter((item): item is OverviewItem => item !== undefined)
  })
  return <box flexDirection="column" paddingTop={1}>
    <text fg={themeV2.text.subdued}>LIFETIME MODEL BREAKDOWN · YCODING BACKEND</text>
    <text fg={themeV2.border.default}>{"─".repeat(Math.max(1, Math.min(props.width - 6, 96)))}</text>
    <Show when={!narrow()}><OverviewHeader geometry={geometry()} sorting={props.sorting} onSort={props.onSort} /></Show>
    <For each={orderedItems()}>{(item, index) => {
      const identity = index() === 0 ? "Total" : item.model
      if (narrow()) return <box flexDirection="column" paddingTop={1}><text fg={index() === 0 ? themeV2.text.feedback.info.default : themeV2.text.default}>{identity} · {item.input} in · {item.output} out · {item.spent}</text><text fg={themeV2.text.subdued}>  steps {item.steps ?? "-"} · reasoning {item.reasoning ?? "-"} · cache {item.cacheRead}/{item.cacheWrite}</text></box>
      return <OverviewRow item={item} identity={identity} geometry={geometry()} total={index() === 0} />
    }}</For>
  </box>
}

type OverviewSort = "key" | "steps" | "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite" | "tokens" | "cost"

function OverviewHeader(props: {
  geometry: OverviewGeometry
  sorting: () => { sort: OverviewSort; order: "asc" | "desc" }
  onSort: (sort: OverviewSort) => void
}) {
  const columns = [
    { key: "key" as const, label: "MODEL", width: props.geometry.name + 1 },
    { key: "steps" as const, label: "STEPS", width: props.geometry.steps },
    { key: "input" as const, label: "INPUT", width: props.geometry.input },
    { key: "output" as const, label: "VISIBLE OUTPUT", width: props.geometry.output },
    { key: "reasoning" as const, label: "REASONING", width: props.geometry.reasoning },
    { key: "cacheRead" as const, label: "CACHE R/W", width: props.geometry.cache },
    { key: "cost" as const, label: "COST", width: props.geometry.cost },
  ]
  const { themeV2 } = useTheme()
  return <box flexDirection="row">
    <For each={columns}>{(column, index) => {
      const selected = createMemo(() => props.sorting().sort === column.key)
      const label = column.key === "key" ? column.label.padEnd(column.width - 1) : column.label.padStart(column.width - 1)
      return <text width={column.width + (index() > 0 ? 1 : 0)} fg={themeV2.text.subdued} onMouseUp={() => props.onSort(column.key)}>
        {index() > 0 ? "\u00a0" : ""}{label}
        <Show when={selected()}><span>{props.sorting().order === "asc" ? "▲" : "▼"}</span></Show>
        <Show when={!selected()}><span>{"\u00a0"}</span></Show>
      </text>
    }}</For>
  </box>
}

type OverviewGeometry = ReturnType<typeof overviewGeometry>

function overviewGeometry(width: number) {
  const available = Math.max(1, width - 7)
  const steps = 7
  const input = 11
  const output = 14
  const reasoning = 10
  const cache = 17
  const cost = 16
  const reserved = steps + input + output + reasoning + cache + cost + 6
  return { name: Math.max(20, available - reserved), steps, input, output, reasoning, cache, cost, fits: available >= 20 + reserved }
}

function OverviewRow(props: {
  item: OverviewItem
  identity: string
  geometry: OverviewGeometry
  total: boolean
}) {
  const { themeV2 } = useTheme()
  return (
    <box width="100%" flexShrink={0}>
      <text>
        <span style={{ fg: props.total ? themeV2.text.feedback.info.default : themeV2.text.default }}>{Locale.truncate(props.identity, props.geometry.name).padEnd(props.geometry.name)}</span>{" "}
        <span>{(props.item.steps ?? "-").padStart(props.geometry.steps)}</span>{" "}
        <span style={{ fg: themeV2.text.feedback.success.default }}>{props.item.input.padStart(props.geometry.input)}</span>{" "}
        <span style={{ fg: themeV2.text.feedback.warning.subdued }}>{props.item.output.padStart(props.geometry.output)}</span>{" "}
        <span style={{ fg: themeV2.text.label }}>{(props.item.reasoning ?? "-").padStart(props.geometry.reasoning)}</span>{" "}
        <span style={{ fg: themeV2.text.feedback.info.default }}>{`${props.item.cacheRead}/${props.item.cacheWrite}`.padStart(props.geometry.cache)}</span>{" "}
        <span style={{ fg: themeV2.text.feedback.success.subdued }}>{props.item.spent.padStart(props.geometry.cost)}</span>
      </text>
    </box>
  )
}

function QuotaSection(props: { snapshot: ProviderUsageSnapshot; now: number }) {
  const { themeV2 } = useTheme()
  return (
    <box flexDirection="column" paddingBottom={1}>
      <text fg={themeV2.text.feedback.info.default}>
        {props.snapshot.label}{props.snapshot.profile ? ` · ${props.snapshot.profile}` : ""} ·{" "}
        {props.snapshot.status === "available" || props.snapshot.status === "stale"
          ? freshnessLabel(props.snapshot, props.now)
          : props.snapshot.status}{" "}
        · {props.snapshot.source} · {props.snapshot.stability}
      </text>
      <For each={props.snapshot.windows}>
        {(window) => {
          const keyLimit =
            props.snapshot.providerID === "openrouter"
              ? props.snapshot.windows.find((candidate) => candidate.id === "key" && candidate.unit === "usd")?.limit
              : undefined
          const presented =
            window.limit === undefined &&
            props.snapshot.providerID === "openrouter" &&
            ["daily", "weekly", "monthly"].includes(window.id)
              ? { ...window, limit: keyLimit }
              : window
          const ratio = quotaRatio(presented)
          const deadline =
            props.snapshot.providerID === "meta" && window.id === "current-bill"
              ? formatBillDue(window.resetAt, props.now)
              : formatReset(window.resetAt, props.now)
          const color =
            usageSeverity(ratio) === "error"
              ? themeV2.text.feedback.error.default
              : usageSeverity(ratio) === "warning"
                ? themeV2.text.feedback.warning.default
                : themeV2.text.feedback.success.default
          return (
            <box flexDirection="column" paddingBottom={1}>
              <text>
                {" "}
                {window.label} <span style={{ fg: color }}>{ratio === undefined ? "" : `${progressBar(ratio)} `}</span>
                {formatWindowValue(presented)}
                {deadline ? ` · ${deadline}` : ""}
              </text>
            </box>
          )
        }}
      </For>
      <Show when={props.snapshot.message}>
        {(message) => <text fg={themeV2.text.subdued}> {message()}</text>}
      </Show>
      <Show when={!props.snapshot.message && props.snapshot.windows.length === 0}>
        <text fg={themeV2.text.subdued}> Quota information is not reported.</text>
      </Show>
    </box>
  )
}

function quotaRatio(window: ProviderUsageSnapshot["windows"][number]) {
  if (window.unlimited) return undefined
  if (window.unit === "percent") return window.used
  if (window.used === undefined || window.limit === undefined || window.limit <= 0) return undefined
  return (window.used / window.limit) * 100
}

type OverviewItem = {
  model: string
  steps: string
  input: string
  output: string
  reasoning: string
  cacheRead: string
  cacheWrite: string
  spent: string
  values: { steps: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; tokens: number; cost: number }
}

function summaryPresentation(summary: ProviderRequestSummary): OverviewItem {
  return {
    model: "Total",
    steps: summary.logical.toLocaleString("en-US"),
    input: summary.tokens.input.toLocaleString("en-US"),
    output: summary.tokens.output.toLocaleString("en-US"),
    reasoning: summary.tokens.reasoning.toLocaleString("en-US"),
    cacheRead: summary.cacheReadReported ? summary.tokens.cache.read.toLocaleString("en-US") : "-",
    cacheWrite: summary.tokens.cache.write.toLocaleString("en-US"),
    spent: money(summary.cost ?? 0),
    values: { steps: summary.logical, input: summary.tokens.input, output: summary.tokens.output, reasoning: summary.tokens.reasoning, cacheRead: summary.tokens.cache.read, cacheWrite: summary.tokens.cache.write, tokens: summary.tokens.input + summary.tokens.output + summary.tokens.reasoning + summary.tokens.cache.read + summary.tokens.cache.write, cost: summary.cost ?? 0 },
  }
}

function money(value: number | undefined) {
  return `$${(value ?? 0).toFixed(2)}`
}

function spendPresentation(
  spend: NonNullable<ProviderRequestSummary["models"]>[number],
): OverviewItem {
  return {
    model: `${spend.model.providerID}/${spend.model.id}${spend.model.variant ? `#${spend.model.variant}` : ""}`,
    steps: spend.requests.toLocaleString("en-US"),
    input: spend.tokens.input.toLocaleString("en-US"),
    output: spend.tokens.output.toLocaleString("en-US"),
    reasoning: spend.tokens.reasoning.toLocaleString("en-US"),
    cacheRead: spend.cacheReadReported ? spend.tokens.cache.read.toLocaleString("en-US") : "-",
    cacheWrite: spend.tokens.cache.write.toLocaleString("en-US"),
    spent: money(spend.cost),
    values: { steps: spend.requests, input: spend.tokens.input, output: spend.tokens.output, reasoning: spend.tokens.reasoning, cacheRead: spend.tokens.cache.read, cacheWrite: spend.tokens.cache.write, tokens: spend.tokens.input + spend.tokens.output + spend.tokens.reasoning + spend.tokens.cache.read + spend.tokens.cache.write, cost: spend.cost ?? 0 },
  }
}
