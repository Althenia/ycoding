import { For, Show, createSignal, createUniqueId, type JSX } from "solid-js"
import { recallDetails, recallSummary, type RecallEntry, type RecallItemDetail, type RecallTarget } from "../../../../../packages/client/src/cue-recall"
import { lifecycleDetails, lifecycleSummary, type LifecycleEntry } from "../../../../../packages/client/src/lifecycle"
import { Collapsible } from "../../ui/collapsible"
import { Icon } from "../../ui/icon"

function Rows(props: { readonly rows: readonly { readonly label: string; readonly value: string }[] }): JSX.Element {
  return <dl class="transcript-recall__rows"><For each={props.rows}>{(row) => <><dt>{row.label}</dt><dd>{row.value}</dd></>}</For></dl>
}

function Item(props: { readonly item: RecallItemDetail; readonly onInspect?: (target: RecallTarget) => void }): JSX.Element {
  return <section class="transcript-recall__item" aria-label={props.item.title}>
    <h4>{props.item.title}</h4>
    <Show when={props.onInspect}>{(inspect) => <button type="button" class="button button--ghost button--small" onClick={() => inspect()(props.item.target)}>Inspect</button>}</Show>
    <Rows rows={props.item.rows} />
  </section>
}

export function RecallBody(props: { readonly entry: RecallEntry; readonly onInspect?: (target: RecallTarget) => void }): JSX.Element {
  const [diagnostics, setDiagnostics] = createSignal(false)
  const diagnosticsID = createUniqueId()
  const details = () => recallDetails(props.entry)
  return <div class="transcript-recall__body">
    <Rows rows={details().header} />
    <For each={details().items}>{(item) => <Item item={item} onInspect={props.onInspect} />}</For>
    <Show when={details().withheld.length > 0}>
      <button type="button" class="transcript-recall__diagnostics" aria-expanded={diagnostics()} aria-controls={diagnosticsID} onClick={() => setDiagnostics(!diagnostics())}>
        {details().withheld.length} not injected · {details().counts.candidates} candidates · {details().counts.selected} selected · {details().counts.injected} injected
      </button>
      <Collapsible open={diagnostics()} id={diagnosticsID}><For each={details().withheld}>{(item) => <Item item={item} />}</For></Collapsible>
    </Show>
  </div>
}

export function RecallEntryView(props: { readonly entry: RecallEntry; readonly onInspect?: (target: RecallTarget) => void }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const id = createUniqueId()
  const summary = () => recallSummary(props.entry)
  return <div class="transcript-notice transcript-recall" data-open={open() ? "" : undefined} data-outcome={props.entry.outcome}>
    <button type="button" class="transcript-notice__toggle" aria-label={summary().label} aria-expanded={open()} aria-controls={id} onClick={() => setOpen(!open())}>
      <span class="transcript-notice__mark" aria-hidden="true"><Icon name={props.entry.outcome === "restored" ? "undo" : "reset"} size={16} /></span>
      <strong>{summary().title}</strong>
      <span class="transcript-notice__status">{summary().meta}</span>
      <Icon name="chevron-right" size={16} />
    </button>
    <Collapsible open={open()} id={id}><RecallBody entry={props.entry} onInspect={props.onInspect} /></Collapsible>
  </div>
}

export function LifecycleBody(props: { readonly entry: LifecycleEntry }): JSX.Element {
  return <div class="transcript-recall__body"><Rows rows={lifecycleDetails(props.entry)} /></div>
}

export function LifecycleEntryView(props: { readonly entry: LifecycleEntry }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const id = createUniqueId()
  const summary = () => lifecycleSummary(props.entry)
  return <div class="transcript-notice transcript-recall" data-open={open() ? "" : undefined} data-decision={props.entry.kind === "step" ? props.entry.decision : props.entry.event}>
    <button type="button" class="transcript-notice__toggle" aria-label={summary().label} aria-expanded={open()} aria-controls={id} onClick={() => setOpen(!open())}>
      <span class="transcript-notice__mark" aria-hidden="true"><Icon name="reset" size={16} /></span>
      <strong>{summary().title}</strong>
      <span class="transcript-notice__status">{summary().meta}</span>
      <Icon name="chevron-right" size={16} />
    </button>
    <Collapsible open={open()} id={id}><LifecycleBody entry={props.entry} /></Collapsible>
  </div>
}
