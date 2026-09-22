import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"
import type { FormFieldView, FormView } from "../projection"
import { formInputState, safeFormLink, type FormDraft } from "../view-model"

export function FormRequest(props: { readonly form: () => FormView; readonly activeSessionID?: string }): JSX.Element {
  const remote = useRemote()
  const [draft, setDraft] = createSignal<FormDraft>({})
  const inputs = createMemo(() => formInputState(props.form(), draft()))
  const disabled = () => props.activeSessionID !== props.form().sessionID
    || remote.state().connection.kind !== "connected"
    || remote.state().mutations.some(mutation => mutation.kind === "form"
      && mutation.sessionID === props.form().sessionID
      && mutation.input?.formID === props.form().id && mutation.state !== "failed")

  return (
    <form noValidate onSubmit={(event) => {
      event.preventDefault()
      if (!disabled() && inputs().valid) void remote.store.replyForm(props.form().id, inputs().answer)
    }}>
      <header class="request__header">
        <Icon name="chat" size={16} />
        <span>{props.form().metadata?.kind === "question" ? "Question" : props.form().title}</span>
      </header>
      <For each={inputs().fields}>{field => (
        <fieldset class="question" disabled={disabled()}>
          <legend>{field.title ?? field.key}{field.type !== "external" && field.required ? " (required)" : ""}</legend>
          <Show when={field.description}><p>{field.description}</p></Show>
          <FormFieldInput field={field} name={`${props.form().id}-${field.key}`}
            value={() => inputs().answer[field.key]}
            update={value => setDraft(current => ({...current, [field.key]: value}))} />
        </fieldset>
      )}</For>
      <Show when={!inputs().valid}><p class="request__note">Complete the required fields and check the input constraints before sending.</p></Show>
      <div class="request__actions">
        <button type="submit" class="button button--primary button--small" disabled={disabled() || !inputs().valid}>Send answer</button>
        <button type="button" class="button button--secondary button--small" disabled={disabled()}
          onClick={() => { if (!disabled()) void remote.store.cancelForm(props.form().id) }}>Cancel</button>
      </div>
    </form>
  )
}

function FormFieldInput(props: {
  readonly field: FormFieldView
  readonly name: string
  readonly value: () => FormDraft[string]
  readonly update: (value: FormDraft[string]) => void
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
        <span><strong>{option.label}</strong><Show when={option.description}> — {option.description}</Show></span>
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
      <span><strong>{option.label}</strong><Show when={option.description}> — {option.description}</Show></span>
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
