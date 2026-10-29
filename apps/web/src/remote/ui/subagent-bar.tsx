import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js"
import { Icon, type IconName } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import type { TeamActionOutcome, TeamSubagent } from "./team-model"
import { accountingUnsupportedText, formatCacheHit } from "./team-model"
import "./subagent-bar.css"
import type { RemoteUsageTaskCost } from "@ycoding-ai/remote"
import { accountingPresentation, inclusiveCostText } from "./usage-accounting"
import { TaskCostDetails } from "./usage-cost"
import { tokenCount } from "./usage-model"

export type SubagentEconomicsView = {
  readonly accounting?: RemoteUsageTaskCost
  readonly accountingUnavailable?: boolean
  readonly accountingUnsupported?: boolean
  readonly tokens?: number
  readonly contextTotal?: number
  readonly contextLimit?: number
  readonly cacheHitRatio?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly cost?: number
  readonly speed?: { readonly label: string; readonly description: string }
}

export function TeamAnswerForm(props: {
  readonly question: { readonly id: string; readonly text: string }
  readonly onAnswer?: (questionID: string, text: string) => Promise<TeamActionOutcome>
  readonly review?: { readonly busy: boolean; readonly submit: (text: string) => void; readonly dismiss: () => void }
}): JSX.Element {
  const [text, setText] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const disabled = () => busy() || props.review?.busy === true
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (disabled() || !text().trim()) return
    if (props.review) { props.review.submit(text().trim()); return }
    if (!props.onAnswer) return
    setBusy(true)
    setError(undefined)
    void props.onAnswer(props.question.id, text().trim()).then((result) => {
      if (result.status === "ok") setText("")
      else setError(result.message)
    }, (cause: unknown) => setError(cause instanceof Error ? cause.message : "The answer could not be sent.")).finally(() => setBusy(false))
  }
  return <form class="team-answer" onSubmit={submit}>
    <label><span>{props.question.text}</span><textarea aria-label="Answer subagent question" value={text()} onInput={(event) => setText(event.currentTarget.value)} disabled={disabled()} rows={2} /></label>
    <Show when={props.review} fallback={<button type="submit" class="button button--primary button--small" disabled={disabled() || !text().trim()}>{busy() ? "Answering…" : "Answer"}</button>}>
      <div class="request__actions"><button type="submit" class="button button--primary button--small" disabled={disabled() || !text().trim()}>Submit</button><button type="button" class="button button--secondary button--small" disabled={disabled()} onClick={() => { if (!disabled()) props.review?.dismiss() }}>Dismiss</button></div>
    </Show>
    <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
  </form>
}

const statusIcon: Readonly<Partial<Record<TeamSubagent["state"], IconName>>> = { completed: "check", failed: "alert", lost: "alert", cancelled: "minus" }
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
    { key: "speed", label: "Speed", value: economics?.speed?.label },
    { key: "tokens", label: "Tokens (inclusive)", value: economics?.accounting === undefined ? undefined : count(tokenCount(economics.accounting.total.tokens)) },
    { key: "cache", label: "Cache", value: cache },
    { key: "cost", label: "Cost (inclusive)", value: economics?.accounting === undefined ? undefined : inclusiveCostText(economics.accounting, economics.accountingUnavailable) },
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
        <Show when={props.economics?.speed}>{(speed) => <span class="subagent-bar__speed" title={speed().description}>{speed().label}</span>}</Show>
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
          <Show when={props.economics?.accounting === undefined && props.economics?.accountingUnsupported === true}><p class="subagent-bar__rollup" role="status">{accountingUnsupportedText}: this machine cannot report task tokens and cost.</p></Show>
          <Show when={props.economics?.accounting}>{(task) => <TaskCostDetails unit={accountingPresentation(task(), props.economics?.accountingUnavailable)} />}</Show>
        </div>
      </Modal>
    </Show>
  </aside>
}
