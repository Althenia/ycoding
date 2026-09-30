import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js"
import { Icon, type IconName } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import type { TeamActionOutcome, TeamSubagent } from "./team-model"
import { formatCacheHit } from "./team-model"
import "./subagent-bar.css"

export type SubagentEconomicsView = {
  readonly tokens?: number
  readonly contextTotal?: number
  readonly contextLimit?: number
  readonly cacheHitRatio?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly cost?: number
}

export function TeamAnswerForm(props: {
  readonly question: { readonly id: string; readonly text: string }
  readonly onAnswer: (questionID: string, text: string) => Promise<TeamActionOutcome>
}): JSX.Element {
  const [text, setText] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (busy() || !text().trim()) return
    setBusy(true)
    setError(undefined)
    void props.onAnswer(props.question.id, text().trim()).then((result) => {
      if (result.status === "ok") setText("")
      else setError(result.message)
    }, (cause: unknown) => setError(cause instanceof Error ? cause.message : "The answer could not be sent.")).finally(() => setBusy(false))
  }
  return <form class="team-answer" onSubmit={submit}>
    <label><span>{props.question.text}</span><textarea aria-label="Answer subagent question" value={text()} onInput={(event) => setText(event.currentTarget.value)} disabled={busy()} rows={2} /></label>
    <button type="submit" class="button button--primary button--small" disabled={busy() || !text().trim()}>{busy() ? "Answering…" : "Answer"}</button>
    <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
  </form>
}

const statusIcon: Readonly<Partial<Record<TeamSubagent["state"], IconName>>> = { completed: "check", failed: "alert", lost: "alert", cancelled: "minus" }
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function subagentMetrics(modelLabel: string | undefined, economics: SubagentEconomicsView | undefined) {
  const count = (value: number) => value.toLocaleString("en-US")
  const cache = economics?.cacheHitRatio === undefined && economics?.cacheRead === undefined && economics?.cacheWrite === undefined ? undefined
    : [
      economics?.cacheHitRatio === undefined ? undefined : formatCacheHit(economics.cacheHitRatio),
      economics?.cacheRead === undefined ? "read unreported" : `${count(economics.cacheRead)} read`,
      economics?.cacheWrite === undefined ? "write unreported" : `${count(economics.cacheWrite)} write`,
    ].filter((part) => part !== undefined).join(" · ")
  return [
    { key: "model", label: "Model", value: modelLabel },
    { key: "tokens", label: "Tokens", value: economics?.tokens === undefined ? undefined : count(economics.tokens) },
    { key: "cache", label: "Cache", value: cache },
    { key: "cost", label: "Cost", value: economics?.cost === undefined ? undefined : money.format(economics.cost) },
    { key: "context", label: "Context", value: economics?.contextTotal === undefined ? undefined : `${count(economics.contextTotal)} / ${economics.contextLimit === undefined ? "unreported" : count(economics.contextLimit)}` },
  ].flatMap((metric) => metric.value === undefined ? [] : [{ key: metric.key, label: metric.label, value: metric.value }])
}

export function SubagentBar(props: {
  readonly sessionID: string
  readonly parentTitle: string
  readonly agent?: string
  readonly description?: string
  readonly status?: TeamSubagent["state"]
  readonly modelLabel?: string
  readonly economics?: SubagentEconomicsView
  readonly previousID?: string
  readonly nextID?: string
  readonly question?: { readonly id: string; readonly text: string }
  readonly onMain: () => void
  readonly onPrevious: () => void
  readonly onNext: () => void
  readonly onAnswer?: (questionID: string, text: string) => Promise<TeamActionOutcome>
}): JSX.Element {
  const [detailsOpen, setDetailsOpen] = createSignal(false)
  let detailsTrigger: HTMLButtonElement | undefined
  createEffect(on(() => props.sessionID, () => setDetailsOpen(false)))
  const metrics = () => subagentMetrics(props.modelLabel, props.economics)
  return <aside class="subagent-bar" aria-label="Subagent context">
    <div class="subagent-bar__header">
      <div class="subagent-bar__identity">
        <strong class="subagent-bar__agent" title={props.agent ?? "Subagent"}>{props.agent ?? "Subagent"}</strong>
        <span class={`subagent-bar__status subagent-bar__status--${props.status ?? "unreported"}`}>
          <span class="subagent-bar__mark" aria-hidden="true"><Show when={props.status !== undefined ? statusIcon[props.status] : undefined} fallback={<span class="status-dot" />}>{(name) => <Icon name={name()} size={12} />}</Show></span>
          {props.status ?? "Status unreported"}
        </span>
      </div>
      <nav class="subagent-bar__navigation" aria-label="Subagent navigation">
        <button type="button" class="subagent-bar__main" aria-label="Main session" title={props.parentTitle} onClick={props.onMain}><Icon name="arrow-up" size={16} /></button>
        <button type="button" aria-label="Previous subagent" title="Previous subagent" disabled={props.previousID === undefined} onClick={props.onPrevious}><Icon name="arrow-left" size={16} /></button>
        <button type="button" aria-label="Next subagent" title="Next subagent" disabled={props.nextID === undefined} onClick={props.onNext}><Icon name="arrow-right" size={16} /></button>
        <button ref={detailsTrigger} type="button" aria-label="Subagent details" title="Subagent details" aria-haspopup="dialog" onClick={() => setDetailsOpen(true)}><Icon name="file" size={16} /></button>
      </nav>
    </div>
    <Show when={props.question !== undefined && props.onAnswer !== undefined ? props.question.id : undefined} keyed><TeamAnswerForm question={props.question!} onAnswer={props.onAnswer!} /></Show>
    <Show when={detailsOpen()}>
      <Modal label="Subagent details" returnFocus={detailsTrigger!} onClose={() => setDetailsOpen(false)}>
        <div class="subagent-bar__details">
          <p class="subagent-bar__description">{props.description ?? "Description unavailable"}</p>
          <Show when={metrics().length > 0}>
            <dl class="subagent-bar__metrics">
              <For each={metrics()}>{(metric) => <div class="subagent-bar__metric" data-metric={metric.key}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>}</For>
            </dl>
          </Show>
          <p class="subagent-bar__rollup">Rolls up to {props.parentTitle}</p>
        </div>
      </Modal>
    </Show>
  </aside>
}
