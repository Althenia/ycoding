import { For, Show, createMemo, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"
import type { FormAnswerView, ReviewItemView, ReviewReason } from "../projection"
import type { ReviewDecision } from "../store"
import { FormRequest } from "./form-request"
import { TeamAnswerForm } from "./subagent-bar"
import { DecisionProvenance } from "./decision-grades"

export function ReviewBox(props: { readonly onOpenSession: (sessionID: string) => void }): JSX.Element {
  const remote = useRemote()
  const items = () => {
    const view = remote.state().view
    return view !== undefined && view.id === remote.state().activeSessionID ? view.review?.items ?? [] : []
  }
  const ids = createMemo(() => items().map((item) => item.itemID))
  const failed = () => remote.state().view?.review?.status === "error"
  return <Show when={ids().length > 0 || failed()}>
    <section class="requests review-box" aria-labelledby="review-box-title">
      <h2 id="review-box-title" class="review-box__title">Review<Show when={ids().length > 0}> · {ids().length} waiting</Show></h2>
      <Show when={failed()}><p class="request__note" role="alert">Review items could not be loaded. <button type="button" class="button button--secondary button--small" onClick={() => void remote.store.reloadReview()}>Retry</button></p></Show>
      <For each={ids()}>{(id) => <Show when={items().find((item) => item.itemID === id)}>{(item) => <ReviewItemCard item={item} onOpenSession={props.onOpenSession} />}</Show>}</For>
    </section>
  </Show>
}

function ReviewItemCard(props: { readonly item: () => ReviewItemView; readonly onOpenSession: (sessionID: string) => void }): JSX.Element {
  const remote = useRemote()
  const mutation = () => remote.state().mutations.find((entry) => entry.id === `review_${props.item().itemID}`)
  const busy = () => mutation()?.state === "sending" || remote.state().connection.kind !== "connected"
  const decide = (decision: ReviewDecision) => { if (!busy()) void remote.store.decideReview(props.item().itemID, decision) }
  const hard = () => { const item = props.item(); return item.kind === "guardrail" && item.hardReview }
  const guardrail = () => { const item = props.item(); return item.kind === "guardrail" ? item : undefined }
  const permission = () => { const item = props.item(); return item.kind === "permission" ? item : undefined }
  const question = () => { const item = props.item(); return item.kind === "question" ? item : undefined }
  const subagent = () => { const item = props.item(); return item.kind === "subagent_question" ? item : undefined }
  const recovery = () => { const item = props.item(); return item.kind === "recovery" ? item : undefined }
  return <article class={`request request--review${hard() ? " request--hard" : ""}`} data-review-item={props.item().itemID} aria-busy={mutation()?.state === "sending" ? "true" : undefined}>
    <header class="request__header">
      <Icon name={props.item().kind === "guardrail" ? "alert" : props.item().kind === "permission" ? "shield" : props.item().kind === "recovery" ? "refresh" : "chat"} size={16} />
      <span>{kindLabel[props.item().kind]}</span>
      <Show when={hard()}><span class="request__badge">Hard review</span></Show>
    </header>
    <p class="request__note">From <button type="button" class="button button--ghost button--small" onClick={() => props.onOpenSession(props.item().sessionID)}>{attribution(props.item())}</button></p>
    <p class="request__note">{reasonLabel[props.item().reason]}<Show when={props.item().kind !== "guardrail" && props.item().choice !== undefined}> · model choice {props.item().choice}</Show><Show when={props.item().kind !== "guardrail" && props.item().confidence !== undefined}> · confidence {String(props.item().confidence)}</Show></p>
    <Show when={question()}>{(item) => <FormRequest form={() => item().form} review={{
      get busy() { return busy() },
      submit: (value) => decide({ kind: "question", answers: item().answers === "form" ? value : questionAnswers(item().form.fields.length, value) }),
      dismiss: () => decide({ kind: "question", dismissed: true }),
    }} />}</Show>
    <Show when={subagent()}>{(item) => <TeamAnswerForm question={{ id: item().itemID, text: item().text }} review={{
      get busy() { return busy() },
      submit: (text) => decide({ kind: "subagent_question", text }),
      dismiss: () => decide({ kind: "subagent_question", dismissed: true }),
    }} />}</Show>
    <Show when={guardrail()}>{(item) => <>
      <DecisionProvenance provenance={item()} />
      <p class="request__body"><strong>{item().action}</strong><span> — {item().detail}</span></p>
      <Show when={item().ruleIDs.length}><p class="request__note">Rules: <For each={item().ruleIDs}>{(rule) => <code>{rule}</code>}</For></p></Show>
      <Show when={item().resources.length}><p class="request__body">Targets / command: <For each={item().resources}>{(resource) => <code>{resource}</code>}</For></p></Show>
      <Show when={item().directories.length}><p class="request__note">Outside directories: <For each={item().directories}>{(directory) => <code>{directory}</code>}</For></p></Show>
      <div class="request__actions">
        <button type="button" class="button button--primary button--small" disabled={busy()} onClick={() => decide({ kind: "guardrail", reply: "once" })}>Approve once</button>
        <Show when={!item().hardReview && item().directories.length > 0}><button type="button" class="button button--secondary button--small" disabled={busy()} onClick={() => decide({ kind: "guardrail", reply: "always" })}>Always</button></Show>
        <button type="button" class="button button--danger button--small" disabled={busy()} onClick={() => decide({ kind: "guardrail", reply: "reject" })}>Reject</button>
      </div>
    </>}</Show>
    <Show when={permission()}>{(item) => <>
      <p class="request__body"><strong>{item().action}</strong><Show when={item().resources.length}><span> on {item().resources.join(", ")}</span></Show></p>
      <div class="request__actions">
        <button type="button" class="button button--primary button--small" disabled={busy()} onClick={() => decide({ kind: "permission", reply: "once" })}>Approve once</button>
        <button type="button" class="button button--secondary button--small" disabled={busy()} onClick={() => decide({ kind: "permission", reply: "always" })}>Always</button>
        <button type="button" class="button button--danger button--small" disabled={busy()} onClick={() => decide({ kind: "permission", reply: "reject" })}>Reject</button>
      </div>
    </>}</Show>
    <Show when={recovery()}>{(item) => <>
      <p class="request__body">This subagent was working when the service restarted. These tool calls may or may not have finished, so their results are unknown:</p>
      <For each={item().tools}>{(tool) => <p class="request__body" data-recovery-tool><code>{tool.name}</code><span> · call </span><code>{tool.callID}</code><span> · message </span><code>{tool.messageID}</code></p>}</For>
      <p class="request__note">The subagent waits for your choice. Continue resumes it; Stop leaves it stopped, and you can still Continue it later from Team.</p>
      <div class="request__actions">
        <button type="button" class="button button--primary button--small" disabled={busy()} onClick={() => decide({ kind: "recovery", choice: "continue" })}>Continue</button>
        <button type="button" class="button button--secondary button--small" disabled={busy()} onClick={() => decide({ kind: "recovery", choice: "stop" })}>Stop</button>
      </div>
    </>}</Show>
    <Show when={mutation()}>{(entry) => <p class="request__note" role={entry().state === "sending" ? "status" : "alert"}>{entry().state === "sending" ? "Sending your decision…" : entry().detail}</p>}</Show>
  </article>
}

const kindLabel: Readonly<Record<ReviewItemView["kind"], string>> = {
  question: "Question",
  subagent_question: "Subagent question",
  guardrail: "Guardrail review",
  permission: "Permission request",
  recovery: "Restart recovery",
}

const reasonLabel: Readonly<Record<ReviewReason, string>> = {
  disabled: "Automatic decisions are disabled",
  free_text: "Needs a written answer",
  refused: "The decision model declined to decide",
  low_confidence: "The decision model was not confident",
  escalated: "The decision model handed this to you",
  error: "The decision model failed",
  timeout: "The decision model timed out",
  sleep_entry: "Pending when the family went to sleep",
  restart: "The service restarted while this subagent was working",
}

function attribution(item: ReviewItemView) {
  return item.child === undefined ? item.sessionTitle : `child · ${item.child.agent} · ${item.child.description}`
}

export function questionAnswers(count: number, answer: FormAnswerView): readonly (readonly string[])[] {
  return Array.from({ length: count }, (_, index) => {
    const value = answer[`q${index}`]
    if (Array.isArray(value)) return value
    return typeof value === "string" && value !== "" ? [value] : []
  })
}
