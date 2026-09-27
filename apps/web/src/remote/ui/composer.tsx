import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { catalogKey, type CatalogTarget, type CatalogView, type FileOption } from "../catalog"
import { useRemote } from "../context"
import { defaultComposerModel, readPreferredModel, writePreferredModel } from "../preferences"
import type { ModelRefView } from "../projection"
import { applyMention, identityLabel, optionsForTrigger, reconcileMentions, submission, triggerAt, type MentionPart } from "./composer-logic"
import { ComposerPicker } from "./composer-picker"
import "./composer.css"

export type ComposerSubmission = ReturnType<typeof submission>

export function MiniComposer(props: {
  readonly target?: CatalogTarget
  readonly text: string
  readonly onText: (text: string) => void
  readonly disabled?: boolean
  readonly running?: boolean
  readonly allowEmpty?: boolean
  readonly onSubmit: (value: ComposerSubmission) => void
  readonly onInterrupt?: () => void
}): JSX.Element {
  const remote = useRemote()
  const [agent, setAgent] = createSignal<string>()
  const [model, setModel] = createSignal<ModelRefView>()
  const [delivery, setDelivery] = createSignal<"steer" | "queue">("steer")
  const [parts, setParts] = createSignal<readonly MentionPart[]>([])
  const [cursor, setCursor] = createSignal(0)
  const [fileResult, setFileResult] = createSignal<readonly FileOption[]>([])
  const [fileError, setFileError] = createSignal<string>()
  const [active, setActive] = createSignal(0)
  const [closed, setClosed] = createSignal(false)
  const [compact, setCompact] = createSignal(false)
  let input: HTMLTextAreaElement | undefined
  let request = 0

  const targetKey = () => props.target ? catalogKey(props.target) : undefined
  const catalog = (): CatalogView | undefined => targetKey() ? remote.state().catalogs[targetKey()!] : undefined
  const current = () => "sessionID" in (props.target ?? {}) ? remote.state().selectedSessionInfo : undefined
  const selectedAgent = () => agent() ?? current()?.agent
  const selectedModel = () => model() ?? current()?.model ?? defaultComposerModel(catalog(), readPreferredModel())
  const primaryAgents = () => (catalog()?.agents ?? []).filter((item) => item.mode !== "subagent" && !item.hidden)
  const trigger = () => closed() ? undefined : triggerAt(props.text, cursor())
  const options = () => trigger() ? optionsForTrigger(trigger()!.trigger, trigger()!.query, catalog(), fileResult()) : []
  const label = () => identityLabel(catalog()?.agents.find((item) => item.id === current()?.agent)?.name ?? current()?.agent, catalog()?.agents.find((item) => item.id === selectedAgent())?.name ?? selectedAgent() ?? "Default agent", current()?.model, selectedModel(), catalog()?.models ?? [])
  const modelOptions = () => (catalog()?.models ?? []).flatMap((option) => (compact() && option.variants.length ? [option.defaultVariant ?? "", ...option.variants.filter((variant) => variant !== option.defaultVariant)] : [""]).map((variant) => ({
    value: `${option.providerID}/${option.id}${compact() ? `#${variant}` : ""}`,
    label: `${option.name}${compact() && variant ? ` · ${variant}` : ""}`,
    detail: option.id,
    group: option.providerName ?? option.providerID,
    model: { providerID: option.providerID, id: option.id, ...(variant || (!compact() && option.defaultVariant) ? { variant: variant || option.defaultVariant } : {}) },
  })))
  const modelOption = () => catalog()?.models.find((option) => option.providerID === selectedModel()?.providerID && option.id === selectedModel()?.id)

  onMount(() => {
    const media = window.matchMedia("(max-width: 767px)")
    setCompact(media.matches)
    const resize = () => setCompact(media.matches)
    media.addEventListener("change", resize)
    onCleanup(() => media.removeEventListener("change", resize))
  })

  createEffect(() => {
    const target = props.target
    if (target) void remote.store.loadCatalog(target)
    setParts([])
    setAgent(undefined)
    setModel(undefined)
    setFileResult([])
  })
  createEffect(() => {
    const match = trigger()
    const target = props.target
    const id = ++request
    setActive(0)
    setFileResult([])
    setFileError(undefined)
    if (!target || match?.trigger !== "@" || !match.query.trim()) return
    const timer = setTimeout(() => {
      void remote.store.findFiles(target, match.query, 8).then((result) => {
        if (id !== request) return
        if (result.status === "ok") setFileResult(result.files)
        else setFileError(result.message)
      }, () => {
        if (id === request) setFileError("File search failed")
      })
    }, 220)
    onCleanup(() => clearTimeout(timer))
  })
  const edit = (text: string, position: number) => {
    setParts(reconcileMentions(props.text, text, parts()))
    props.onText(text)
    setCursor(position)
    setClosed(false)
  }
  const select = (index: number) => {
    const option = options()[index]
    const match = trigger()
    if (!option || !match) return
    const result = applyMention(props.text, match.start, cursor(), option, parts())
    props.onText(result.text)
    setParts(result.parts)
    setClosed(true)
    setCursor(result.cursor)
    queueMicrotask(() => { input?.focus(); input?.setSelectionRange(result.cursor, result.cursor) })
  }
  const send = () => {
    if (props.disabled || (!props.allowEmpty && !props.text.trim())) return
    const chosenAgent = selectedAgent()
    const chosenModel = selectedModel()
    const pendingAgent = current()?.agent === chosenAgent ? undefined : chosenAgent
    const pendingModel = current()?.model?.id === chosenModel?.id && current()?.model?.providerID === chosenModel?.providerID && current()?.model?.variant === chosenModel?.variant ? undefined : chosenModel
    props.onSubmit(submission(props.text, parts(), catalog(), delivery(), pendingAgent, pendingModel))
    setParts([])
    setClosed(true)
  }
  const keyDown: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if (options().length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault()
      setActive((active() + (event.key === "ArrowDown" ? 1 : -1) + options().length) % options().length)
      return
    }
    if (options().length && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault()
      select(active())
      return
    }
    if (event.key === "Escape" && options().length) {
      event.preventDefault()
      setClosed(true)
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }
  return <div class="composer">
    <div class="composer__row">
      <div class="mini-composer__input-wrap">
        <textarea ref={input} class="composer__input" rows={1} aria-label="Message your agent" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={options().length > 0} aria-controls="composer-autocomplete" aria-activedescendant={options().length ? `composer-option-${active()}` : undefined}
          placeholder="Ask anything, / for commands, @ for context…" disabled={props.disabled} value={props.text}
          onInput={(event) => edit(event.currentTarget.value, event.currentTarget.selectionStart)}
          onClick={(event) => { setCursor(event.currentTarget.selectionStart); setClosed(false) }}
          onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) setCursor(event.currentTarget.selectionStart) }} onKeyDown={keyDown} />
        <Show when={options().length || fileError()}><div class="mini-composer__autocomplete" id="composer-autocomplete" role="listbox" aria-label="Suggestions">
          <For each={options()}>{(option, index) => <button id={`composer-option-${index()}`} type="button" role="option" aria-selected={index() === active()} classList={{ "mini-composer__option--active": index() === active() }} onPointerDown={(event) => event.preventDefault()} onClick={() => select(index())}>
            <span>{option.label}</span><small>{option.description}</small>
          </button>}</For>
          <Show when={fileError()}><p role="status">{fileError()}</p></Show>
        </div></Show>
      </div>
      <div class="mini-composer__identity" aria-live="polite">{label()}</div>
      <div class="composer__controls">
        <ComposerPicker label="Agent" placeholder="Default agent" value={selectedAgent()} options={primaryAgents().map((item) => ({ value: item.id, label: item.name, detail: item.description }))} disabled={props.disabled || catalog()?.status !== "ready"} onChange={setAgent} />
        <ComposerPicker label="Model" placeholder="Model" searchable value={selectedModel() ? `${selectedModel()!.providerID}/${selectedModel()!.id}${compact() ? `#${selectedModel()!.variant ?? ""}` : ""}` : undefined} options={modelOptions()} disabled={props.disabled || catalog()?.status !== "ready"} onChange={(value) => {
          const option = modelOptions().find((item) => item.value === value)
          if (!option) return
          setModel(option.model)
          writePreferredModel(undefined, option.model)
        }} />
        <Show when={!compact() && modelOption()?.variants.length}><ComposerPicker label="Variant" placeholder="Default" value={selectedModel()?.variant ?? ""} options={[{ value: "", label: "Default" }, ...(modelOption()?.variants ?? []).map((variant) => ({ value: variant, label: variant }))]} disabled={props.disabled} onChange={(variant) => {
          const selected = selectedModel()
          if (!selected) return
          const chosen = { providerID: selected.providerID, id: selected.id, ...(variant ? { variant } : {}) }
          setModel(chosen)
          writePreferredModel(undefined, chosen)
        }} /></Show>
        <Show when={!props.allowEmpty}><div class="composer__delivery" role="group" aria-label="Delivery">
          <button type="button" class="composer__delivery-option" aria-pressed={delivery() === "steer"} classList={{ "composer__delivery-option--active": delivery() === "steer" }} onClick={() => setDelivery("steer")}>Steer</button>
          <button type="button" class="composer__delivery-option" aria-pressed={delivery() === "queue"} classList={{ "composer__delivery-option--active": delivery() === "queue" }} onClick={() => setDelivery("queue")}>Queue</button>
        </div></Show>
        <Show when={props.running && props.onInterrupt}><button type="button" class="mini-composer__interrupt" aria-label="Interrupt the running step" onClick={props.onInterrupt}><Icon name="stop" /></button></Show>
        <button type="button" class="mini-composer__send" aria-label={props.allowEmpty ? "Create session" : "Send prompt"} disabled={props.disabled || (!props.allowEmpty && !props.text.trim())} onClick={send}><Icon name="send" /></button>
      </div>
    </div>
  </div>
}

export function Composer(props: { readonly sessionID?: string; readonly running: boolean; readonly canSend: boolean }): JSX.Element {
  const remote = useRemote()
  const text = () => props.sessionID ? remote.state().drafts[props.sessionID] ?? "" : ""
  return <div class="mini-composer__mount">
    <For each={remote.state().mutations.filter((mutation) => mutation.sessionID === props.sessionID)}>{(mutation) => <div class={`mutation mutation--${mutation.state}`} role="status">
      <span class="mutation__label">{mutation.label}</span><span class="mutation__detail">{mutation.detail ?? "Sending…"}</span>
      <Show when={mutation.kind === "prompt" && mutation.state !== "sending"}><button class="button button--secondary button--small" onClick={() => void remote.store.retryMutation(mutation.id)}>Send again</button></Show>
      <Show when={mutation.state !== "sending"}><button class="button button--ghost button--small" onClick={() => remote.store.dismissMutation(mutation.id)}>Dismiss</button></Show>
    </div>}</For>
    <MiniComposer target={props.sessionID ? { sessionID: props.sessionID } : undefined} text={text()} onText={(value) => { if (props.sessionID) remote.store.setDraft(props.sessionID, value) }} disabled={!props.canSend || !props.sessionID} running={props.running} onInterrupt={() => void remote.store.interrupt()} onSubmit={(value) => {
      if (!props.sessionID) return
      remote.store.setDraft(props.sessionID, "")
      if (value.kind === "command") void remote.store.runCommand(value.input)
      else void remote.store.sendPrompt(value.input)
    }} />
  </div>
}
