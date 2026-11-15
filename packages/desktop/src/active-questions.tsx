import { createEffect, createSignal, For, Show } from "solid-js"
import type { QuestionRequest } from "./contract"
import { Icon } from "../../../apps/web/src/ui/icon"
import { restoresFocus, type FocusAt } from "./form-rules"
import { questionAnswerError } from "./question-rules"

export function ActiveQuestionCard(props: { request: QuestionRequest; locked: boolean; notice?: string; onAnswer: (answers: readonly (readonly string[])[]) => void; onReject: () => void }) {
  const [selected, setSelected] = createSignal<Record<number, readonly string[]>>({})
  const [custom, setCustom] = createSignal<Record<number, string>>({})
  const [problem, setProblem] = createSignal<string>()
  let card: HTMLElement | undefined
  let heading: HTMLHeadingElement | undefined
  let wasLocked = props.locked
  createEffect(() => {
    const locked = props.locked
    const active = document.activeElement
    const at: FocusAt = !active || active === document.body ? "body" : active === card ? "card" : card?.contains(active) ? "control" : "elsewhere"
    if (restoresFocus(wasLocked, locked, at)) heading?.focus({ preventScroll: true })
    wasLocked = locked
  })
  const answer = () => {
    if (props.locked) return
    const answers = props.request.questions.map((_, index) => [...selected()[index] ?? [], ...(custom()[index]?.trim() ? [custom()[index]!.trim()] : [])])
    const invalid = questionAnswerError(props.request.questions, answers)
    setProblem(invalid)
    if (!invalid) props.onAnswer(answers)
  }
  return <article class="request rl-decision-card" ref={card} aria-labelledby={`question-${props.request.id}`}>
    <div class="request__head"><span class="request__head-icon"><Icon name="chat" class="rl-ico" /></span><h2 id={`question-${props.request.id}`} tabindex="-1" ref={heading}>Questions</h2></div>
    <p class="desktop__muted">This Session asks for your answer. Nothing is sent until you choose Send answer.</p>
    <form onSubmit={(event) => { event.preventDefault(); answer() }}>
      <For each={props.request.questions}>{(question, index) => <fieldset class="request__field" disabled={props.locked}>
        <legend>{question.header}</legend><p>{question.question}</p>
        <For each={question.options}>{(option) => <label class="request__choice"><input type={question.multiple ? "checkbox" : "radio"} name={`${props.request.id}-${index()}`} checked={selected()[index()]?.includes(option.label) ?? false} onChange={(event) => {
          const checked = event.currentTarget.checked
          setSelected((previous) => ({ ...previous, [index()]: question.multiple ? checked ? [...previous[index()] ?? [], option.label] : (previous[index()] ?? []).filter((value) => value !== option.label) : [option.label] }))
          if (!question.multiple) setCustom((previous) => ({ ...previous, [index()]: "" }))
        }} /><span><strong>{option.label}</strong> — {option.description}</span></label>}</For>
        <Show when={question.custom !== false}><label class="desktop__field">Custom answer<input type="text" value={custom()[index()] ?? ""} onInput={(event) => {
          const value = event.currentTarget.value
          setCustom((previous) => ({ ...previous, [index()]: value }))
          if (!question.multiple && value.trim()) setSelected((previous) => ({ ...previous, [index()]: [] }))
        }} /></label></Show>
      </fieldset>}</For>
      <Show when={problem() ?? props.notice}>{(message) => <p role="alert" class="desktop__error">{message()}</p>}</Show>
      <div class="desktop__actions"><button type="submit" class="rl-btn" data-tone="go" disabled={props.locked}>Send answer</button><button type="button" class="rl-btn" disabled={props.locked} onClick={props.onReject}>Reject question</button></div>
    </form>
  </article>
}
