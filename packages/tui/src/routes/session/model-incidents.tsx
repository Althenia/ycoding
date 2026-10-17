import type {
  IncidentReportInput,
  ModelIncidentGuidance,
  ModelIncidentItem,
  ModelIncidentKind,
  ModelIncidentRecent,
  ModelIncidentReport,
  ModelIncidentReportRow,
} from "@ycoding-ai/client"
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { formatRef } from "../../util/model"
import { PAGE_SIZE, UsageRangeDialog, dateBounds, rangeLabel, type DateRange } from "./provider-usage-reports"

type IncidentGroup = IncidentReportInput["group"]

export type ModelIncidentLoaders = {
  report: (input: { group: IncidentGroup; from?: number; to?: number; offset?: number; limit?: number }) => Promise<ModelIncidentReport>
  recent: (input: { provider: string; model: string; agent?: string; limit?: number }) => Promise<ModelIncidentRecent>
  guidance: (input: { provider: string; model: string }) => Promise<ModelIncidentGuidance>
  clear: (input: { provider: string; model: string }) => Promise<ModelIncidentGuidance>
}

type Row = ModelIncidentReportRow
type ReportState = { queryKey: string; report?: ModelIncidentReport; loading: boolean; failed: boolean; stale: boolean }
type Load<T> = { state: "loading" | "ready" | "failed"; value?: T }
type Detail = { recent: Load<ModelIncidentRecent["items"]>; guidance: Load<ModelIncidentGuidance> }

const RECENT_LIMIT = 20
const KIND_LABEL: Record<ModelIncidentKind, string> = {
  fallback: "fallback",
  "guardrail-escalated": "escalated",
  "guardrail-rejected": "rejected",
}
const emptyDetail: Detail = { recent: { state: "loading" }, guidance: { state: "loading" } }

export function ModelIncidents(props: { refresh: number; now?: () => number; load?: ModelIncidentLoaders }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  const [group, setGroup] = createSignal<IncidentGroup>("model")
  const [range, setRange] = createSignal<DateRange>({ type: "all" })
  const [offset, setOffset] = createSignal(0)
  const [rangeError, setRangeError] = createSignal<string>()
  const [reload, setReload] = createSignal(0)
  const [state, setState] = createSignal<ReportState>({ queryKey: "", loading: false, failed: false, stale: false })
  const [selected, setSelected] = createSignal<string>()
  const [detail, setDetail] = createSignal<Detail>(emptyDetail)
  const [confirming, setConfirming] = createSignal(false)
  const [clearing, setClearing] = createSignal(false)
  const [clearFailed, setClearFailed] = createSignal(false)
  let reportGeneration = 0
  let detailGeneration = 0
  let clearGeneration = 0
  let tableScroll: ScrollBoxRenderable | undefined
  let detailScroll: ScrollBoxRenderable | undefined

  const geometry = createMemo(() => incidentGeometry(dimensions().width))
  const rows = createMemo(() => state().report?.rows ?? [])
  const selectedRow = createMemo(() => rows().find((row) => rowKey(row) === selected()))
  const tableHeight = createMemo(() => Math.min(rows().length * (geometry().fits ? 1 : 2), Math.max(3, Math.floor((dimensions().height - 22) / 2))))

  createEffect(() => {
    const loader = props.load
    void props.refresh
    void reload()
    const query = { group: group(), ...dateBounds(range(), props.now?.() ?? Date.now()), offset: offset(), limit: PAGE_SIZE }
    const queryKey = JSON.stringify(query)
    const token = ++reportGeneration
    if (!loader) return
    const previous = untrack(state)
    if (previous.queryKey === queryKey && previous.report !== undefined) setState({ ...previous, loading: true, failed: false, stale: true })
    else {
      setState({ queryKey, loading: true, failed: false, stale: false })
      setSelected(undefined)
    }
    void loader.report(query).then(
      (report) => {
        if (token !== reportGeneration) return
        const current = untrack(selected)
        setState({ queryKey, report, loading: false, failed: false, stale: false })
        setSelected(report.rows.some((row) => rowKey(row) === current) ? current : report.rows[0] ? rowKey(report.rows[0]) : undefined)
      },
      () => {
        if (token !== reportGeneration) return
        const current = untrack(state)
        setState({ ...current, queryKey, loading: false, failed: true, stale: current.report !== undefined })
      },
    )
  })

  createEffect(() => {
    const loader = props.load
    void props.refresh
    void reload()
    const key = selected()
    const row = untrack(selectedRow)
    const token = ++detailGeneration
    clearGeneration += 1
    setConfirming(false)
    setClearing(false)
    setClearFailed(false)
    if (!loader || !key || !row) return setDetail(emptyDetail)
    setDetail(emptyDetail)
    const settle = (update: (current: Detail) => Detail) => {
      if (token === detailGeneration) setDetail(update)
    }
    const model = { provider: String(row.providerID), model: String(row.modelID) }
    void loader.recent({ ...model, ...(untrack(group) === "agent" && row.agent ? { agent: String(row.agent) } : {}), limit: RECENT_LIMIT }).then(
      (value) => settle((current) => ({ ...current, recent: { state: "ready", value: value.items } })),
      () => settle((current) => ({ ...current, recent: { state: "failed" } })),
    )
    void loader.guidance(model).then(
      (value) => settle((current) => ({ ...current, guidance: { state: "ready", value } })),
      () => settle((current) => ({ ...current, guidance: { state: "failed" } })),
    )
  })

  createEffect(on([group, range, offset], () => {
    setConfirming(false)
    setClearFailed(false)
  }, { defer: true }))

  onCleanup(() => {
    reportGeneration += 1
    detailGeneration += 1
    clearGeneration += 1
  })

  const moveTo = (index: number) => {
    const row = rows()[Math.max(0, Math.min(rows().length - 1, index))]
    if (row) setSelected(rowKey(row))
  }
  const move = (direction: -1 | 1) => moveTo((rows().findIndex((row) => rowKey(row) === selected()) < 0 ? 0 : rows().findIndex((row) => rowKey(row) === selected())) + direction)
  const changeOffset = (value: number) => setOffset(Math.max(0, value))
  const nextOffset = () => {
    const report = state().report
    return report !== undefined && offset() + PAGE_SIZE < report.groups ? offset() + PAGE_SIZE : undefined
  }
  const requestClear = () => {
    const loader = props.load
    const row = selectedRow()
    const guidance = detail().guidance
    if (!loader || !row || clearing() || guidance.state !== "ready" || !guidance.value?.text) return
    if (!confirming()) {
      setClearFailed(false)
      setConfirming(true)
      return
    }
    setConfirming(false)
    setClearing(true)
    const token = ++clearGeneration
    const key = selected()
    void loader.clear({ provider: String(row.providerID), model: String(row.modelID) }).then(
      (value) => {
        if (token !== clearGeneration || selected() !== key) return
        setClearing(false)
        setDetail((current) => ({ ...current, guidance: { state: "ready", value } }))
      },
      () => {
        if (token !== clearGeneration) return
        setClearing(false)
        setClearFailed(true)
      },
    )
  }

  createEffect(() => {
    const index = rows().findIndex((row) => rowKey(row) === selected())
    if (index < 0) return
    requestAnimationFrame(() => {
      if (!tableScroll || tableScroll.isDestroyed) return
      const span = geometry().fits ? 1 : 2
      const top = index * span
      if (top < tableScroll.scrollTop) tableScroll.scrollTo(top)
      if (top + span > tableScroll.scrollTop + tableScroll.viewport.height) tableScroll.scrollTo(top + span - tableScroll.viewport.height)
    })
  })

  Keymap.createLayer(() => ({
    mode: "base",
    commands: [
      { id: "provider-usage.incident.group", title: "Choose incident grouping", group: "Usage", bind: "b", run: () => dialog.replace(() => <IncidentGroupDialog current={group()} onSelect={(next) => { setGroup(next); setOffset(0) }} />) },
      { id: "provider-usage.incident.range", title: "Choose incident range", group: "Usage", bind: "f", run: () => dialog.replace(() => <UsageRangeDialog range={range()} onSelect={(next) => { setRange(next); setRangeError(undefined); setOffset(0) }} onError={setRangeError} />) },
      { id: "provider-usage.incident.row.previous", title: "Previous incident row", group: "Usage", bind: "up", run: () => move(-1) },
      { id: "provider-usage.incident.row.next", title: "Next incident row", group: "Usage", bind: "down", run: () => move(1) },
      { id: "provider-usage.incident.row.home", title: "First incident row", group: "Usage", bind: "home", run: () => moveTo(0) },
      { id: "provider-usage.incident.row.end", title: "Last incident row", group: "Usage", bind: "end", run: () => moveTo(rows().length - 1) },
      { id: "provider-usage.incident.detail.page-up", title: "Scroll incident details up", group: "Usage", bind: "pageup", run: () => detailScroll?.scrollBy(-Math.max(1, detailScroll.viewport.height)) },
      { id: "provider-usage.incident.detail.page-down", title: "Scroll incident details down", group: "Usage", bind: "pagedown", run: () => detailScroll?.scrollBy(Math.max(1, detailScroll.viewport.height)) },
      { id: "provider-usage.incident.page.previous", title: "Previous incident page", group: "Usage", bind: "[", run: () => changeOffset(offset() - PAGE_SIZE) },
      { id: "provider-usage.incident.page.next", title: "Next incident page", group: "Usage", bind: "]", run: () => { const next = nextOffset(); if (next !== undefined) changeOffset(next) } },
      { id: "provider-usage.incident.refresh", title: "Refresh incidents", group: "Usage", bind: "ctrl+r", run: () => setReload((value) => value + 1) },
      { id: "provider-usage.incident.guidance.clear", title: "Clear model guidance", group: "Usage", bind: "ctrl+d", run: requestClear },
    ],
  }))

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <Show when={rangeError()}>{(error) => <text flexShrink={0} fg={theme.text.feedback.error.default}>{error()}</text>}</Show>
      <Show when={state().loading && state().report}><text flexShrink={0} fg={theme.text.feedback.warning.default}>Refreshing · showing previous data</text></Show>
      <Show when={state().failed}>
        <text flexShrink={0} fg={theme.text.feedback.error.default}>
          {state().stale ? "Refresh failed · showing stale data · ctrl+r retry" : "Incident report could not be loaded. ctrl+r retry"}
        </text>
      </Show>
      <Show when={!state().report && state().loading}><text flexShrink={0} fg={theme.text.subdued}>Loading incidents...</text></Show>
      <Show when={state().report}>
        {(report) => (
          <>
            <text flexShrink={0} fg={theme.text.default} attributes={TextAttributes.BOLD}>Incidents · All sessions · Group {group()}</text>
            <text flexShrink={0} fg={theme.text.subdued} wrapMode="word">
              b group · f range · ctrl+r refresh · ctrl+d clear guidance · [ ] page
            </text>
            <text flexShrink={0} fg={theme.border.default}>{"─".repeat(Math.max(1, Math.min(dimensions().width - 6, 96)))}</text>
            <Show when={report().rows.length > 0} fallback={<text flexShrink={0} fg={theme.text.subdued}>No incidents recorded in this range.</text>}>
              <Show when={geometry().fits}><IncidentHeader geometry={geometry()} group={group()} /></Show>
              <scrollbox ref={(value: ScrollBoxRenderable) => { tableScroll = value }} flexShrink={0} height={tableHeight()} scrollbarOptions={{ visible: false }}>
                <For each={report().rows}>
                  {(row) => (
                    <box width="100%" flexShrink={0} backgroundColor={rowKey(row) === selected() ? theme.background.surface.offset : undefined} onMouseUp={() => setSelected(rowKey(row))}>
                      <Show when={geometry().fits} fallback={<CompactIncidentRow row={row} group={group()} selected={rowKey(row) === selected()} width={dimensions().width} />}>
                        <WideIncidentRow row={row} group={group()} selected={rowKey(row) === selected()} geometry={geometry()} />
                      </Show>
                    </box>
                  )}
                </For>
              </scrollbox>
              <text flexShrink={0} fg={theme.border.default}>{"─".repeat(Math.max(1, Math.min(dimensions().width - 6, 96)))}</text>
              <scrollbox ref={(value: ScrollBoxRenderable) => { detailScroll = value }} flexGrow={1} minHeight={4} scrollbarOptions={{ visible: false }}>
                <IncidentDetail row={selectedRow()} group={group()} detail={detail()} width={dimensions().width} confirming={confirming()} clearing={clearing()} clearFailed={clearFailed()} />
              </scrollbox>
            </Show>
            <box flexShrink={0} flexDirection="column">
              <text fg={theme.text.subdued}>{Locale.truncate("Counts are exact retained incidents · LAST and recent times are UTC · FALLBACKS model fallbacks · ESCALATED/REJECTED guardrail reviews", Math.max(1, dimensions().width - 6))}</text>
              <text fg={theme.text.subdued}>Scope: All sessions · Range: {rangeLabel(range())} · {pageLabel(offset(), report())}</text>
              <box flexDirection="row">
                <text fg={theme.text.subdued}>b group · f range · ctrl+r refresh</text>
                <box flexGrow={1} />
                <text fg={offset() > 0 ? theme.text.default : theme.text.subdued} onMouseUp={() => changeOffset(offset() - PAGE_SIZE)}>[ previous ]</text>
                <text> </text>
                <text fg={nextOffset() !== undefined ? theme.text.default : theme.text.subdued} onMouseUp={() => { const next = nextOffset(); if (next !== undefined) changeOffset(next) }}>[ next ]</text>
              </box>
            </box>
          </>
        )}
      </Show>
    </box>
  )
}

function IncidentGroupDialog(props: { current: IncidentGroup; onSelect: (group: IncidentGroup) => void }) {
  const dialog = useDialog()
  return (
    <DialogSelect
      title="Incident grouping"
      current={props.current}
      options={[{ value: "model" as const, title: "Model" }, { value: "agent" as const, title: "Agent" }]}
      onSelect={(option) => { props.onSelect(option.value); dialog.clear() }}
    />
  )
}

function IncidentDetail(props: { row?: Row; group: IncidentGroup; detail: Detail; width: number; confirming: boolean; clearing: boolean; clearFailed: boolean }) {
  const { theme } = useTheme()
  const guidance = () => props.detail.guidance.value
  return (
    <Show when={props.row}>
      {(row) => (
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.text.feedback.info.default} attributes={TextAttributes.BOLD}>{rowLabel(row(), props.group)}</text>
          <text fg={theme.text.label}>Guidance</text>
          <Show when={props.detail.guidance.state === "loading"}><text fg={theme.text.subdued}>Loading guidance...</text></Show>
          <Show when={props.detail.guidance.state === "failed"}><text fg={theme.text.feedback.error.default}>Guidance could not be loaded · ctrl+r retry</text></Show>
          <Show when={props.detail.guidance.state === "ready"}>
            <Show when={guidance()?.text} fallback={<text fg={theme.text.subdued}>No guidance for this model</text>}>{(text) => <text wrapMode="word">{text()}</text>}</Show>
            <Show when={guidance()?.clearedAt}>{(clearedAt) => <text fg={theme.text.subdued}>Cleared {utc(clearedAt())} UTC</text>}</Show>
            <Show when={guidance()?.enabled === false}>
              <text fg={theme.text.feedback.warning.default} wrapMode="word">Guidance disabled · this Location's capabilities turn model guidance off</text>
            </Show>
          </Show>
          <Show when={props.confirming}>
            <text fg={theme.text.feedback.warning.default} wrapMode="word">Press ctrl+d again to clear guidance for {String(row().providerID)}/{String(row().modelID)}</text>
          </Show>
          <Show when={props.clearing}><text fg={theme.text.feedback.warning.default}>Clearing guidance...</text></Show>
          <Show when={props.clearFailed}><text fg={theme.text.feedback.error.default}>Guidance could not be cleared · press ctrl+d twice to retry</text></Show>
          <text fg={theme.text.label} paddingTop={1}>Recent incidents{props.detail.recent.value ? ` · ${props.detail.recent.value.length}` : ""}</text>
          <Show when={props.detail.recent.state === "loading"}><text fg={theme.text.subdued}>Loading recent incidents...</text></Show>
          <Show when={props.detail.recent.state === "failed"}><text fg={theme.text.feedback.error.default}>Recent incidents could not be loaded · ctrl+r retry</text></Show>
          <Show when={props.detail.recent.state === "ready" && props.detail.recent.value?.length === 0}><text fg={theme.text.subdued}>No recent incidents.</text></Show>
          <For each={props.detail.recent.value}>
            {(item) => <text fg={theme.text.default}>{Locale.truncate(incidentLine(item), Math.max(1, props.width - 6))}</text>}
          </For>
        </box>
      )}
    </Show>
  )
}

function incidentGeometry(width: number) {
  const available = Math.max(1, width - 6)
  const columns = { fallbacks: 10, escalated: 10, rejected: 10, last: 16 }
  const reserved = columns.fallbacks + columns.escalated + columns.rejected + columns.last + 4
  return { ...columns, name: Math.max(22, available - reserved), fits: available >= 22 + reserved }
}

function IncidentHeader(props: { geometry: ReturnType<typeof incidentGeometry>; group: IncidentGroup }) {
  const { theme } = useTheme()
  return (
    <text flexShrink={0} fg={theme.text.subdued}>
      {(props.group === "agent" ? "MODEL · AGENT" : "MODEL").padEnd(props.geometry.name)} {"FALLBACKS".padStart(props.geometry.fallbacks)} {"ESCALATED".padStart(props.geometry.escalated)} {"REJECTED".padStart(props.geometry.rejected)} {"LAST".padStart(props.geometry.last)}
    </text>
  )
}

function WideIncidentRow(props: { row: Row; group: IncidentGroup; selected: boolean; geometry: ReturnType<typeof incidentGeometry> }) {
  const { theme } = useTheme()
  return (
    <text attributes={props.selected ? TextAttributes.BOLD : undefined}>
      <span style={{ fg: props.selected ? theme.text.feedback.info.default : theme.text.default }}>{`${props.selected ? ">" : " "} ${Locale.truncate(rowLabel(props.row, props.group), props.geometry.name - 2)}`.padEnd(props.geometry.name)}</span>{" "}
      <span style={{ fg: theme.text.feedback.warning.subdued }}>{count(props.row.fallbacks).padStart(props.geometry.fallbacks)}</span>{" "}
      <span style={{ fg: theme.text.feedback.info.default }}>{count(props.row.escalated).padStart(props.geometry.escalated)}</span>{" "}
      <span style={{ fg: theme.text.feedback.error.default }}>{count(props.row.rejected).padStart(props.geometry.rejected)}</span>{" "}
      <span style={{ fg: theme.text.subdued }}>{utc(props.row.last).padStart(props.geometry.last)}</span>
    </text>
  )
}

function CompactIncidentRow(props: { row: Row; group: IncidentGroup; selected: boolean; width: number }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" width="100%">
      <text fg={props.selected ? theme.text.feedback.info.default : theme.text.default} attributes={props.selected ? TextAttributes.BOLD : undefined}>
        {props.selected ? ">" : " "} {Locale.truncate(rowLabel(props.row, props.group), Math.max(1, props.width - 8))}
      </text>
      <text fg={theme.text.subdued}>{"  "}{count(props.row.fallbacks)} fallbacks · {count(props.row.escalated)} escalated · {count(props.row.rejected)} rejected · last {utc(props.row.last)}</text>
    </box>
  )
}

function rowKey(row: Row) {
  return `${row.providerID}\u0000${row.modelID}\u0000${row.agent ?? ""}`
}

function rowLabel(row: Row, group: IncidentGroup) {
  return `${row.providerID}/${row.modelID}${group === "agent" && row.agent ? ` · ${row.agent}` : ""}`
}

function incidentLine(item: ModelIncidentItem) {
  return [
    utc(item.time),
    KIND_LABEL[item.kind],
    item.category,
    ...(item.ruleIDs.length > 0 ? [item.ruleIDs.join(", ")] : []),
    ...(item.target ? [`→ ${formatRef(item.target)}`] : []),
  ].join(" · ")
}

function utc(value: number) {
  return new Date(value).toISOString().slice(0, 16).replace("T", " ")
}

function count(value: number) {
  return value.toLocaleString("en-US")
}

function pageLabel(offset: number, report: ModelIncidentReport) {
  if (report.rows.length === 0) return `Rows 0 of ${count(report.groups)}`
  return `Rows ${count(offset + 1)}–${count(offset + report.rows.length)} of ${count(report.groups)}`
}
