import { Show, createSignal, type JSX } from "solid-js"
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

export function SubagentBar(props: {
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
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
  const details = () => [
    props.modelLabel,
    props.economics?.tokens === undefined ? undefined : `${props.economics.tokens.toLocaleString("en-US")} tokens`,
    props.economics?.cacheHitRatio === undefined ? undefined : formatCacheHit(props.economics.cacheHitRatio),
    props.economics?.cost === undefined ? undefined : money.format(props.economics.cost),
  ].filter((item): item is string => item !== undefined)
  const context = () => props.economics?.contextTotal === undefined ? undefined
    : `Context ${props.economics.contextTotal.toLocaleString("en-US")} / ${props.economics.contextLimit === undefined ? "unreported" : props.economics.contextLimit.toLocaleString("en-US")}`
  const cacheCounts = () => props.economics?.cacheHitRatio === undefined && props.economics?.cacheRead === undefined && props.economics?.cacheWrite === undefined
    ? undefined
    : `${props.economics.cacheRead === undefined ? "read unreported" : `${props.economics.cacheRead.toLocaleString("en-US")} read`} · ${props.economics.cacheWrite === undefined ? "write unreported" : `${props.economics.cacheWrite.toLocaleString("en-US")} write`}`
  return <aside class="subagent-bar" aria-label="Subagent context">
    <div class="subagent-bar__summary">
      <div><strong>{props.agent ?? "Subagent"}</strong><span class="subagent-bar__status">{props.status ?? "Status unreported"}</span></div>
      <p>{props.description ?? "Description unavailable"}</p>
      <Show when={details().length > 0}><p class="subagent-bar__economics">{details().join(" · ")}</p></Show>
      <Show when={context()}>{(value) => <p class="subagent-bar__economics">{value()}</p>}</Show>
      <Show when={cacheCounts()}>{(value) => <p class="subagent-bar__economics">{value()}</p>}</Show>
      <p class="subagent-bar__rollup">Rolls up to {props.parentTitle}</p>
    </div>
    <Show when={props.question !== undefined && props.onAnswer !== undefined ? props.question.id : undefined} keyed><TeamAnswerForm question={props.question!} onAnswer={props.onAnswer!} /></Show>
    <nav class="subagent-bar__navigation" aria-label="Subagent navigation">
      <button type="button" aria-label="Main session" onClick={props.onMain}>↑ {props.parentTitle}</button>
      <button type="button" aria-label="Previous subagent" disabled={props.previousID === undefined} onClick={props.onPrevious}>← Previous</button>
      <button type="button" aria-label="Next subagent" disabled={props.nextID === undefined} onClick={props.onNext}>Next →</button>
    </nav>
  </aside>
}
