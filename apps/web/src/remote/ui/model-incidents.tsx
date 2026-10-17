import { batch, createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Modal } from "../../ui/modal"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"
import { createRemoteQuery } from "../query"
import { usageRead, type UsageRead } from "../queries"
import { LoadingPlaceholder } from "./loading"
import {
  decidedByLabel, guidanceIndicator, incidentCount, incidentGuidanceInput, incidentKindLabel, incidentModelLabel, incidentPageSize, incidentPageSummary, incidentRecentInput,
  incidentReportInput, incidentRowKey, incidentTime, incidentTotal, type IncidentGroup, type IncidentGuidance, type IncidentRange, type IncidentReport, type IncidentReportInput, type IncidentRow,
} from "./model-incident-model"
import { customUsageRange } from "./usage-filter-model"
import "./model-incidents.css"

const ranges = [{ value: "last7", label: "7 days" }, { value: "last30", label: "30 days" }, { value: "all", label: "All retained" }, { value: "custom", label: "Custom UTC" }] as const
const groups = [{ value: "model", label: "Model" }, { value: "agent", label: "Agent" }] as const
const unsupportedMessage = "Update YCoding on this machine to see model incidents."

export function ModelIncidents() {
  const remote = useRemote()
  const [group, setGroup] = createSignal<IncidentGroup>("model")
  const [range, setRange] = createSignal<IncidentRange>("all")
  const [anchor, setAnchor] = createSignal(Date.now())
  const [custom, setCustom] = createSignal<{ readonly from: number; readonly to: number }>()
  const [customOpen, setCustomOpen] = createSignal(false)
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  const [rangeError, setRangeError] = createSignal(false)
  const [offset, setOffset] = createSignal(0)
  const [selected, setSelected] = createSignal<{ readonly key: string; readonly row: IncidentRow }>()
  const [shown, setShown] = createSignal<{ readonly report: IncidentReport; readonly input: IncidentReportInput }>()
  const [confirming, setConfirming] = createSignal<{ readonly trigger: HTMLElement }>()
  const [clearing, setClearing] = createSignal(false)
  const [clearError, setClearError] = createSignal<string>()
  const [status, setStatus] = createSignal<{ readonly key: string; readonly text: string }>()
  const [cleared, setCleared] = createSignal<{ readonly key: string; readonly value: IncidentGuidance; readonly base: IncidentGuidance | undefined }>()
  const connected = createMemo(() => remote.state().transport.kind === "open")

  const reportInput = createMemo(() => incidentReportInput(group(), range(), anchor(), offset(), custom()))
  const reportQuery = createRemoteQuery(remote.store.queryClient, () => remote.queries.incidentReport(remote.scope(), connected(), reportInput()))
  const report = () => usageRead(reportQuery())
  const detailRow = () => selected()?.row
  const recentQuery = createRemoteQuery(remote.store.queryClient, () => remote.queries.incidentRecent(remote.scope(), connected() && selected() !== undefined,
    detailRow() ? incidentRecentInput(detailRow()!) : { provider: "", model: "" }))
  const guidanceQuery = createRemoteQuery(remote.store.queryClient, () => remote.queries.incidentGuidance(remote.scope(), connected() && selected() !== undefined,
    detailRow() ? incidentGuidanceInput(detailRow()!) : { provider: "", model: "" }))
  const recent = () => usageRead(recentQuery())
  const guidanceRead = () => usageRead(guidanceQuery())
  const modelKey = () => detailRow() ? incidentModelLabel(detailRow()!) : ""
  const guidance = () => {
    const override = cleared()
    return override?.key === modelKey() && (guidanceRead().data === override.base || guidanceRead().data === undefined) ? override.value : guidanceRead().data
  }
  const retryReport = () => {
    const scope = remote.scope()
    if (scope !== undefined) void remote.queries.retryIncidentReport(scope, reportInput())
  }
  const retryRecent = () => {
    const scope = remote.scope()
    const row = detailRow()
    if (scope !== undefined && row !== undefined) void remote.queries.retryIncidentRecent(scope, incidentRecentInput(row))
  }
  const retryGuidance = () => {
    const scope = remote.scope()
    const row = detailRow()
    if (scope !== undefined && row !== undefined) void remote.queries.retryIncidentGuidance(scope, incidentGuidanceInput(row))
  }
  const updating = () => shown() !== undefined && shown()!.input !== reportInput() && (report().status === "loading" || report().status === "idle")

  createEffect(() => {
    const result = report()
    if (result.status === "ready" && result.data) setShown({ report: result.data, input: reportInput() })
  })
  createEffect(() => {
    remote.scope()
    batch(() => { setShown(undefined); setSelected(undefined); setOffset(0) })
  })

  const reset = (next: () => void) => batch(() => { next(); setOffset(0); setSelected(undefined); setStatus(undefined) })
  const chooseRange = (next: IncidentRange) => {
    if (next === "custom") return setCustomOpen(!customOpen())
    setCustomOpen(false)
    reset(() => { setRange(next); setAnchor(Date.now()) })
  }
  const applyCustom = (event: SubmitEvent) => {
    event.preventDefault()
    const bounds = customUsageRange(from(), to())
    setRangeError(bounds === undefined)
    if (bounds) reset(() => { setCustom(bounds); setRange("custom") })
  }
  const move = (next: number) => batch(() => { setOffset(next); setSelected(undefined) })
  const toggleDetails = (row: IncidentRow) => {
    const key = incidentRowKey(row)
    setStatus(undefined)
    setSelected(selected()?.key === key ? undefined : { key, row })
  }
  const clear = (close: () => void) => {
    const scope = remote.scope()
    const target = selected()
    if (!scope || !target || clearing()) return
    const key = incidentModelLabel(target.row)
    setClearing(true)
    setClearError(undefined)
    void remote.queries.clearIncidentGuidance(scope, incidentGuidanceInput(target.row)).then((value) => {
      batch(() => {
        setCleared({ key, value, base: guidanceRead().data })
        setStatus({ key, text: `Guidance cleared for ${key}.` })
      })
      close()
    }, (error: unknown) => setClearError(error instanceof Error ? error.message : "Guidance could not be cleared.")).finally(() => setClearing(false))
  }

  return <section class="incidents" aria-labelledby="incidents-title">
    <div class="incidents__head"><h2 id="incidents-title"><Icon name="shield" />Model incidents</h2>
      <p>Fallbacks and guardrail escalations or rejections retained by this backend. Guidance belongs to a model and applies across agents and Sessions.</p></div>
    <div class="incidents__controls">
      <div class={`usage-toggle${group() === "agent" ? " usage-toggle--tokens" : ""}`} role="group" aria-label="Incident grouping">
        <For each={groups}>{(item) => <button type="button" aria-pressed={group() === item.value} onClick={() => reset(() => setGroup(item.value))}><Icon name={item.value === "model" ? "cpu" : "team"} />{item.label}</button>}</For>
      </div>
      <div class="incidents__range" role="group" aria-label="Incident range">
        <For each={ranges}>{(item) => <button type="button" aria-pressed={range() === item.value} aria-expanded={item.value === "custom" ? customOpen() : undefined} onClick={() => chooseRange(item.value)}><Icon name="sessions" />{item.label}</button>}</For>
      </div>
    </div>
    <Show when={customOpen()}><form class="incidents__range-form" onSubmit={applyCustom}>
      <label class="field"><span class="field__label">From UTC (inclusive)</span><input class="input" aria-label="Incident from UTC" placeholder="YYYY-MM-DD" value={from()} onInput={(event) => setFrom(event.currentTarget.value)} /></label>
      <label class="field"><span class="field__label">To UTC (exclusive)</span><input class="input" aria-label="Incident to UTC" placeholder="YYYY-MM-DD" value={to()} onInput={(event) => setTo(event.currentTarget.value)} /></label>
      <button type="submit" class="button button--secondary"><Icon name="check" />Apply range</button>
      <Show when={rangeError()}><p role="alert">Enter valid UTC dates with From before To.</p></Show>
    </form></Show>

    <div class="incidents__panel" aria-busy={updating() ? "true" : "false"}>
      <Show when={!shown() && !connected() && report().status === "idle"}><p class="usage-message" role="status">Connect to a machine to see model incidents.</p></Show>
      <Show when={!shown() && connected() && (report().status === "loading" || report().status === "idle")}><LoadingPlaceholder kind="usage" label="Loading model incidents…" /></Show>
      <Show when={!shown() && report().status === "unsupported"}><p class="usage-message" role="status">{unsupportedMessage}</p></Show>
      <Show when={!shown() && report().status === "error"}><p class="usage-message" role="alert">{report().message} <button type="button" onClick={retryReport}>Retry</button></p></Show>
      <Show when={shown()}>{(page) => <>
        <Show when={report().status === "error"}><p class="incidents__feedback" role="alert">{report().message} <button type="button" onClick={retryReport}>Retry</button></p></Show>
        <Show when={page().report.rows.length > 0} fallback={<p class="usage-message" role="status">No model incidents in this period.</p>}>
          <div class="incidents__table-wrap usage-table-wrap"><table class="incidents__table"><caption>{page().input.group === "agent" ? "Incidents by model and agent" : "Incidents by model"}</caption>
            <thead><tr><th scope="col">Model</th><Show when={page().input.group === "agent"}><th scope="col">Agent</th></Show><th scope="col">Fallbacks</th><th scope="col">Escalated</th><th scope="col">Rejected</th><th scope="col">Total</th><th scope="col">Last incident</th><th scope="col"><span class="visually-hidden">Details</span></th></tr></thead>
            <tbody><For each={page().report.rows}>{(row) => {
              const key = incidentRowKey(row)
              const name = `${incidentModelLabel(row)}${row.agent === undefined ? "" : ` · ${row.agent}`}`
              return <tr data-incident-row classList={{ "is-selected": selected()?.key === key }}>
                <th scope="row" data-label="Model">{incidentModelLabel(row)}</th>
                <Show when={page().input.group === "agent"}><td data-label="Agent"><span class="usage-provider-chip">{row.agent}</span></td></Show>
                <td data-label="Fallbacks">{incidentCount(row.fallbacks)}</td><td data-label="Escalated">{incidentCount(row.escalated)}</td><td data-label="Rejected">{incidentCount(row.rejected)}</td>
                <td data-label="Total">{incidentCount(incidentTotal(row))}</td>
                <td data-label="Last incident"><time datetime={new Date(row.last).toISOString()}>{incidentTime(row.last)}</time></td>
                <td><button type="button" class="incidents__details" data-incident-details aria-expanded={selected()?.key === key} aria-controls="incident-detail" aria-label={`Details for ${name}`} onClick={() => toggleDetails(row)}><Icon name="chevron-right" />Details</button></td>
              </tr>
            }}</For></tbody></table></div>
          <div class="incidents__pagination"><span class="incidents__summary">{incidentPageSummary(page().input.offset ?? 0, page().report.rows.length, page().report.groups)}</span>
            <div><button type="button" disabled={updating() || (page().input.offset ?? 0) === 0} onClick={() => move(Math.max(0, (page().input.offset ?? 0) - incidentPageSize))}><Icon name="arrow-left" />Previous</button>
              <button type="button" disabled={updating() || (page().input.offset ?? 0) + page().report.rows.length >= page().report.groups} onClick={() => move((page().input.offset ?? 0) + incidentPageSize)}>Next<Icon name="arrow-right" /></button></div></div>
        </Show>
      </>}</Show>
    </div>

    <Show when={status()?.key === modelKey() ? status() : undefined}>{(done) => <p class="incidents__status" role="status">{done().text}</p>}</Show>
    <Show when={selected()}>{(target) => {
      const label = () => `${incidentModelLabel(target().row)}${target().row.agent === undefined ? "" : ` · ${target().row.agent}`}`
      const indicator = () => guidance() ? guidanceIndicator(guidance()!) : undefined
      return <section id="incident-detail" class="incidents__detail" aria-label={`Incident details for ${label()}`}>
        <h3>{label()}</h3>
        <div><h4><Icon name="bell" />Recent incidents</h4>
          <Show when={recent().status === "loading" && !recent().data}><LoadingPlaceholder kind="usage" label="Loading recent incidents…" /></Show>
          <Show when={recent().status === "unsupported"}><p class="usage-message" role="status">{unsupportedMessage}</p></Show>
          <Show when={recent().status === "error"}><p class="incidents__error" role="alert">{recent().message} <button type="button" onClick={retryRecent}>Retry</button></p></Show>
          <Show when={recent().data}>{(data) => <Show when={data().items.length > 0} fallback={<p class="usage-message" role="status">No recent incidents.</p>}>
            <ol class="incidents__recent" aria-label="Recent incidents"><For each={data().items}>{(item) => <li>
              <div class="incidents__item-head"><strong class="incidents__kind">{incidentKindLabel[item.kind]}</strong><time datetime={new Date(item.time).toISOString()}>{incidentTime(item.time)}</time><span class="usage-provider-chip">{item.category}</span></div>
              <Show when={item.ruleIDs.length > 0}><span class="incidents__rules"><For each={item.ruleIDs}>{(rule) => <span class="usage-provider-chip">{rule}</span>}</For></span></Show>
              <span class="incidents__item-meta">Agent {item.agent}{item.variant ? ` · variant ${item.variant}` : ""}{item.profile ? ` · profile ${item.profile}` : ""}{item.target ? ` · fallback target ${item.target.providerID}/${item.target.id}` : ""}{item.decidedBy ? ` · decided by ${decidedByLabel[item.decidedBy]}` : ""}</span>
            </li>}</For></ol>
          </Show>}</Show>
        </div>
        <div class="incidents__guidance"><div class="incidents__guidance-head"><h4><Icon name="shield" />Model guidance</h4>
          <Show when={indicator()}>{(state) => <span class="incidents__indicator" data-enabled={String(state().enabled)}>{state().label}</span>}</Show></div>
          <Show when={guidanceRead().status === "loading" && !guidance()}><LoadingPlaceholder kind="usage" label="Loading guidance…" /></Show>
          <Show when={guidanceRead().status === "unsupported"}><p class="usage-message" role="status">{unsupportedMessage}</p></Show>
          <Show when={guidanceRead().status === "error" && !guidance()}><p class="incidents__error" role="alert">{guidanceRead().message} <button type="button" onClick={retryGuidance}>Retry</button></p></Show>
          <Show when={indicator()}>{(state) => <>
            <Show when={state().preview} fallback={<p class="incidents__hint">No guidance text.</p>}>{(text) => <pre class="incidents__preview">{text()}</pre>}</Show>
            <Show when={state().cleared}>{(text) => <p class="incidents__hint">{text()}</p>}</Show>
            <p class="incidents__hint">Reflects the backend default setting.</p>
            <button type="button" class="button button--secondary incidents__clear" data-incident-clear disabled={state().preview === undefined || clearing()}
              onClick={(event) => { setClearError(undefined); setConfirming({ trigger: event.currentTarget }) }}><Icon name="reset" />Clear guidance</button>
          </>}</Show>
        </div>
      </section>
    }}</Show>
    <Show when={confirming()} keyed>{(target) => {
      let close: (() => void) | undefined
      return <Modal class="overlay--confirm" label="Clear model guidance" returnFocus={target.trigger} onClose={() => setConfirming(undefined)} requestClose={(handoff) => { close = handoff }}>
        <p>Clear the guidance for {modelKey()}? This clears it for every agent and Session on this backend. Incident counts are kept.</p>
        <Show when={clearError()}><p role="alert" class="incidents__error">{clearError()}</p></Show>
        <div class="device-cleanup-actions">
          <button type="button" class="button button--secondary" onClick={() => close?.()}>Cancel</button>
          <button type="button" class="button button--danger" disabled={clearing()} onClick={() => clear(() => close?.())}>{clearing() ? "Clearing…" : "Clear guidance"}</button>
        </div>
      </Modal>
    }}</Show>
  </section>
}
