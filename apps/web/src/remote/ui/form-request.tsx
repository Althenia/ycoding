import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"
import type { FormAnswerView, FormFieldView, FormView } from "../projection"
import { formInputState, safeFormLink, type FormDraft } from "../view-model"
import type { Form } from "../../../../../packages/schema/src/form"
import { readFormAssessment, readFormReplySource } from "../projection"

export type FormReview = { readonly busy: boolean; readonly submit: (answer: FormAnswerView) => void; readonly dismiss: () => void }

export function FormRequest(props: { readonly form: () => FormView; readonly activeSessionID?: string; readonly review?: FormReview }): JSX.Element {
  const remote = useRemote()
  const [draft, setDraft] = createSignal<FormDraft>({})
  const inputs = createMemo(() => formInputState(props.form(), draft()))
  const disabled = () => props.review !== undefined
    ? props.review.busy || remote.state().connection.kind !== "connected"
    : props.activeSessionID !== props.form().sessionID
    || remote.state().connection.kind !== "connected"
    || remote.state().mutations.some(mutation => mutation.kind === "form"
      && mutation.sessionID === props.form().sessionID
      && mutation.input?.formID === props.form().id && mutation.state !== "failed")

  return (
    <form noValidate onSubmit={(event) => {
      event.preventDefault()
      if (disabled() || !inputs().valid) return
      if (props.review) props.review.submit(inputs().answer)
      else void remote.store.replyForm(props.form().id, inputs().answer)
    }}>
      <header class="request__header">
        <Icon name="chat" size={16} />
        <span>{props.form().metadata?.kind === "question" ? "Question" : props.form().title}</span>
      </header>
      <FormAssessment value={props.form().assessment} multipleKeys={props.form().fields.filter(field => field.type === "multiselect").map(field => field.key)} />
      <For each={inputs().fields.map(field => field.key)}>{key => {
        const field = () => inputs().fields.find(field => field.key === key)!
        const required = () => {
          const value = field()
          return value.type !== "external" && value.required
        }
        return (
        <fieldset class="question" disabled={disabled()}>
          <legend>{field().title ?? key}{required() ? " (required)" : ""}</legend>
          <Show when={field().description}><p>{field().description}</p></Show>
          <FormFieldInput field={field()} name={`${props.form().id}-${key}`}
            assessment={() => props.form().assessment?.fields.find((item) => item.key === key)}
            value={() => inputs().answer[key]}
            update={value => setDraft(current => ({...current, [key]: value}))} />
        </fieldset>
      )}}</For>
      <Show when={!inputs().valid}><p class="request__note">Complete the required fields and check the input constraints before sending.</p></Show>
      <div class="request__actions">
        <button type="submit" class="button button--primary button--small" disabled={disabled() || !inputs().valid}>{props.review ? "Submit" : "Send answer"}</button>
        <button type="button" class="button button--secondary button--small" disabled={disabled()}
          onClick={() => { if (disabled()) return; if (props.review) props.review.dismiss(); else void remote.store.cancelForm(props.form().id) }}>{props.review ? "Dismiss" : "Cancel"}</button>
      </div>
    </form>
  )
}

function FormFieldInput(props: {
  readonly field: FormFieldView
  readonly name: string
  readonly value: () => FormDraft[string]
  readonly update: (value: FormDraft[string]) => void
  readonly assessment: () => Form.FieldAssessment | undefined
}): JSX.Element {
  const field = props.field
  const text = () => typeof props.value() === "string" || typeof props.value() === "number" ? String(props.value()) : ""
  if (field.type === "external") return <>
    <Show when={safeFormLink(field.url)} fallback={<p class="request__note">This step has no safe HTTP(S) link.</p>}>
      {href => <a class="button button--secondary button--small" href={href()} target="_blank" rel="noopener noreferrer">Open external step</a>}
    </Show>
    <label class="question__option"><input type="checkbox" checked={props.value() === true}
      onChange={event => props.update(event.currentTarget.checked)} /><span>I have completed this step</span></label>
  </>
  if (field.type === "boolean") return <For each={[true, false]}>{value => (
    <label class="question__option"><input type="radio" name={props.name} checked={props.value() === value}
      onChange={() => props.update(value)} /><span>{value ? "Yes" : "No"}</span></label>
  )}</For>
  if (field.type === "number" || field.type === "integer") return <label class="question__custom">
    <span>{field.title ?? field.key}</span>
    <input type="number" value={text()} min={field.minimum} max={field.maximum} step={field.type === "integer" ? 1 : "any"}
      required={field.required} onInput={event => props.update(event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber)} />
  </label>
  if (field.type === "multiselect") {
    const values = (): readonly string[] => {
      const value = props.value()
      return Array.isArray(value) ? value : []
    }
    const declared = (value: string) => field.options.some(option => option.value === value)
    return <>
      <For each={field.options}>{option => <label class="question__option">
        <input type="checkbox" checked={values().includes(option.value)} onChange={event => props.update(event.currentTarget.checked
          ? [...values(), option.value] : values().filter(value => value !== option.value))} />
        <span><strong>{option.label}</strong><Show when={option.description}> — {option.description}</Show>
          <OptionGrade grade={() => props.assessment()?.grades?.find((grade) => grade.choice === option.value)} />
        </span>
      </label>}</For>
      <Show when={field.custom}><label class="question__custom">
        <span>Additional answers (one per line)</span>
        <textarea value={values().filter(value => !declared(value)).join("\n")}
          onInput={event => props.update([...values().filter(declared), ...event.currentTarget.value.split("\n").filter(value => value.length > 0)])} />
      </label></Show>
      <Show when={field.minItems !== undefined || field.maxItems !== undefined}>
        <p class="request__note">Selections: {field.minItems ?? 0} minimum{field.maxItems === undefined ? "" : `, ${field.maxItems} maximum`}</p>
      </Show>
    </>
  }
  const selectedOption = () => field.options?.some(option => option.value === props.value()) === true
  return <>
    <For each={field.options ?? []}>{option => <label class="question__option">
      <input type="radio" name={props.name} checked={props.value() === option.value} onChange={() => props.update(option.value)} />
      <span><strong>{option.label}</strong><Show when={option.description}> — {option.description}</Show>
        <OptionGrade grade={() => props.assessment()?.grades?.find((grade) => grade.choice === option.value)} />
      </span>
    </label>}</For>
    <Show when={field.options === undefined || field.custom}><label class="question__custom">
      <span>{field.options === undefined ? field.title ?? field.key : "Custom answer"}</span>
      <input type={field.format === "email" ? "email" : field.format === "date" ? "date" : "text"}
        value={selectedOption() ? "" : text()} placeholder={field.placeholder}
        minLength={field.minLength} maxLength={field.maxLength} pattern={field.pattern}
        required={field.required && !selectedOption()}
        onInput={event => props.update(event.currentTarget.value || undefined)} />
    </label></Show>
  </>
}

function OptionGrade(props: { readonly grade: () => Form.OptionGrade | undefined }): JSX.Element {
  return <Show when={props.grade()}>{(grade) => <span class="request__note question__grade">confidence {grade().confidence} · {grade().evidence}</span>}</Show>
}

export function FormAssessment(props: { readonly value: unknown; readonly fieldKey?: string; readonly settled?: "automatic" | "client"; readonly source?: unknown; readonly grades?: boolean; readonly multiple?: boolean; readonly multipleKeys?: readonly string[] }): JSX.Element {
  const assessment = createMemo(() => readFormAssessment(props.value))
  const source = createMemo(() => readFormReplySource(props.source))
  const settlement = () => {
    if (!props.settled) return "awaiting an authorized client decision"
    const reply = source()
    if (reply?.kind === "dots-delegation" || reply?.kind === "dots-client") return `answered by external client via Dots delegation ${reply.delegationID} · anchor ${reply.anchorSessionID}`
    if (reply) return `answered by coordinator ${reply.coordinatorSessionID}${reply.via === "yolo" ? " via Answers YOLO" : reply.via === "auto-answer" ? " via Answers Auto" : ""}`
    if (props.source !== undefined) return "answer source unreported"
    return props.settled === "automatic" ? "automatically answered" : "answered by client"
  }
  return <Show when={assessment()} fallback={<Show when={props.settled || props.source !== undefined}><p class="request__note question__assessment" role="status">{settlement()}</p></Show>}>{(value) => <div class="request__note question__assessment" role="status">
    <p>Answers {value().mode === "yolo" ? "YOLO" : value().mode === "auto" ? "Auto" : "Manual"} · source {value().sourceSessionID}</p>
    <For each={value().fields.filter((field) => props.fieldKey === undefined || field.key === props.fieldKey)}>{(field) => <div>
      <p>{field.status === "pending" ? "Assessing options" : field.status === "assessed" ? "Assessed" : field.status === "unavailable" ? "Assessment unavailable" : "Not assessed"} · {settlement()}</p>
      <p>{field.reason}</p>
      <Show when={field.recommendation?.length}><p>Recommended{props.multiple || props.multipleKeys?.includes(field.key) || (field.recommendation?.length ?? 0) > 1 ? " compatible set" : ""}: {field.recommendation?.join(", ")}</p></Show>
      <Show when={props.grades}><For each={field.grades}>{(grade) => <p>{grade.choice} · confidence {grade.confidence} · {grade.evidence}</p>}</For></Show>
    </div>}</For>
  </div>}</Show>
}
