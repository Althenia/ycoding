import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "../../ui/icon"
import { catalogKey, type CatalogTarget, type CatalogView, type FileOption } from "../catalog"
import { useRemote } from "../context"
import { defaultComposerModel, readPreferredModel, writePreferredModel } from "../preferences"
import type { ModelRefView } from "../projection"
import { applyMention, optionsForTrigger, pairedFastModel, reconcileMentions, submission, triggerAt, type MentionPart } from "./composer-logic"
import { ComposerPicker } from "./composer-picker"
import { attachmentLimit, encodeAttachment, type ComposerAttachment } from "./composer-attachment"
import { ModelControl } from "./model-control"
import { ComposerStatus } from "./status-bar"
import "./composer.css"

export type ComposerSubmission = ReturnType<typeof submission>

export function MiniComposer(props: {
  readonly target?: CatalogTarget
  readonly text: string
  readonly onText: (text: string) => void
  readonly disabled?: boolean
  readonly running?: boolean
  readonly allowEmpty?: boolean
  readonly onSubmit: (value: ComposerSubmission) => void | boolean | Promise<void | boolean>
  readonly onInterrupt?: () => void
  readonly showStatus?: boolean
  readonly mobileMount?: HTMLElement
}): JSX.Element {
  const remote = useRemote()
  const [agent, setAgent] = createSignal<string>()
  const [model, setModel] = createSignal<ModelRefView>()
  const [delivery, setDelivery] = createSignal<"steer" | "queue">("steer")
  const [attachments, setAttachments] = createSignal<readonly ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = createSignal<string>()
  const [reading, setReading] = createSignal(0)
  const [sending, setSending] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [parts, setParts] = createSignal<readonly MentionPart[]>([])
  const [cursor, setCursor] = createSignal(0)
  const [fileResult, setFileResult] = createSignal<readonly FileOption[]>([])
  const [fileError, setFileError] = createSignal<string>()
  const [active, setActive] = createSignal(0)
  const [closed, setClosed] = createSignal(false)
  const [mobileOpen, setMobileOpen] = createSignal(false)
  let input: HTMLTextAreaElement | undefined
  let fileInput: HTMLInputElement | undefined
  let mobileTrigger: HTMLButtonElement | undefined
  let mobileSheet: HTMLElement | undefined
  let request = 0
  let attachmentGeneration = 0
  const closeMobile = () => { setMobileOpen(false); queueMicrotask(() => mobileTrigger?.focus()) }

  const targetKey = createMemo(() => props.target ? catalogKey(props.target) : undefined)
  const catalog = (): CatalogView | undefined => targetKey() ? remote.state().catalogs[targetKey()!] : undefined
  const current = () => "sessionID" in (props.target ?? {}) ? remote.state().selectedSessionInfo : undefined
  const selectedAgent = () => agent() ?? current()?.agent
  const selectedModel = () => model() ?? current()?.model ?? defaultComposerModel(catalog(), readPreferredModel())
  const primaryAgents = () => (catalog()?.agents ?? []).filter((item) => item.mode !== "subagent" && !item.hidden)
  const agentPending = () => !!current() && selectedAgent() !== current()?.agent
  const modelPending = () => !!current() && !!selectedModel() && (selectedModel()?.providerID !== current()?.model?.providerID || selectedModel()?.id !== current()?.model?.id || selectedModel()?.variant !== current()?.model?.variant)
  const mobileLabel = () => `${primaryAgents().find((item) => item.id === selectedAgent())?.name ?? selectedAgent() ?? "Default agent"} · ${pairedFastModel(catalog()?.models ?? [], selectedModel())?.base.name ?? catalog()?.models.find((item) => item.providerID === selectedModel()?.providerID && item.id === selectedModel()?.id)?.name ?? selectedModel()?.id ?? "Model"}${selectedModel()?.variant ? ` · ${selectedModel()?.variant}` : ""}`
  const trigger = createMemo(() => closed() ? undefined : triggerAt(props.text, cursor()))
  const options = () => trigger() ? optionsForTrigger(trigger()!.trigger, trigger()!.query, catalog(), fileResult()) : []
  createEffect(() => {
    const key = targetKey()
    attachmentGeneration++
    if (key) untrack(() => void remote.store.loadCatalog(props.target!))
    setParts([])
    setAgent(undefined)
    setModel(undefined)
    setFileResult([])
    setAttachments([])
    setAttachmentError(undefined)
    setMobileOpen(false)
    onCleanup(() => { attachmentGeneration++ })
  })
  onMount(() => {
    if (!props.mobileMount) return
    const media = window.matchMedia("(max-width: 479px)")
    const close = () => setMobileOpen(false)
    media.addEventListener("change", close)
    onCleanup(() => media.removeEventListener("change", close))
  })
  createEffect(() => {
    if (mobileOpen()) queueMicrotask(() => mobileSheet?.querySelector<HTMLButtonElement>('.mini-picker__trigger')?.focus())
  })
  createEffect(() => {
    const match = trigger()
    const key = targetKey()
    const id = ++request
    setActive(0)
    setFileResult([])
    setFileError(undefined)
    if (!key || match?.trigger !== "@" || !match.query.trim()) return
    const timer = setTimeout(() => {
      void remote.store.findFiles(props.target!, match.query, 50).then((result) => {
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
  const addFiles = async (files: readonly File[]) => {
    if (props.disabled || sending() || !files.length) return
    const error = attachmentLimit([...attachments(), ...files])
    if (error) { setAttachmentError(error); return }
    const generation = attachmentGeneration
    setReading((count) => count + 1)
    try {
      const encoded = await Promise.all(files.map(encodeAttachment))
      if (generation !== attachmentGeneration) return
      const combined = [...attachments(), ...encoded]
      const invalid = attachmentLimit(combined)
      if (invalid) { setAttachmentError(invalid); return }
      setAttachments(combined)
      setAttachmentError(undefined)
    } catch (cause) {
      if (generation === attachmentGeneration) setAttachmentError(cause instanceof Error ? cause.message : "Could not read the attachment.")
    } finally {
      setReading((count) => Math.max(0, count - 1))
    }
  }
  const send = async () => {
    if (props.disabled || reading() || sending() || (!props.allowEmpty && !props.text.trim() && !attachments().length)) return
    const chosenAgent = selectedAgent()
    const chosenModel = selectedModel()
    const pendingAgent = current()?.agent === chosenAgent ? undefined : chosenAgent
    const pendingModel = current()?.model?.id === chosenModel?.id && current()?.model?.providerID === chosenModel?.providerID && current()?.model?.variant === chosenModel?.variant ? undefined : chosenModel
    const requested = submission(props.text, parts(), catalog(), delivery(), pendingAgent, pendingModel)
    const files = [...(requested.input.files ?? []), ...attachments().map((item) => ({ uri: item.uri, name: item.name }))]
    if (files.length > 64) { setAttachmentError("A message can contain at most 64 files. Remove an attachment before sending."); return }
    const generation = attachmentGeneration
    setSending(true)
    try {
      const accepted = requested.kind === "command"
        ? await props.onSubmit({ kind: "command", input: { ...requested.input, ...(files.length ? { files } : {}) } })
        : await props.onSubmit({ kind: "prompt", input: { ...requested.input, ...(files.length ? { files } : {}) } })
      if (accepted === false || generation !== attachmentGeneration) return
      setParts([])
      setAttachments([])
      setAttachmentError(undefined)
      setClosed(true)
    } catch (cause) {
      if (generation === attachmentGeneration) setAttachmentError(cause instanceof Error ? cause.message : "The attachment could not be sent.")
    } finally { setSending(false) }
  }
  const keyDown: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if (options().length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault()
      setActive((active() + (event.key === "ArrowDown" ? 1 : -1) + options().length) % options().length)
      queueMicrotask(() => document.getElementById(`composer-option-${active()}`)?.scrollIntoView({ block: "nearest" }))
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
      void send()
    }
  }
  return <>
    <Show when={props.mobileMount}><Portal mount={props.mobileMount}>
      <button ref={mobileTrigger} type="button" class="composer__mobile-trigger" classList={{ "composer__mobile-trigger--pending": agentPending() || modelPending() }} aria-label={`Agent and model: ${mobileLabel()}`} aria-description={agentPending() || modelPending() ? "applies with your next send" : undefined} aria-haspopup="dialog" aria-expanded={mobileOpen()} disabled={props.disabled || catalog()?.status !== "ready"} onClick={() => setMobileOpen(true)}><span title={mobileLabel()}>{mobileLabel()}</span><Icon name="chevron-down" /></button>
      <Show when={mobileOpen()}><Portal>
        <div class="mini-picker__scrim composer__selection-scrim" onClick={closeMobile} />
        <section ref={mobileSheet} class="composer__selection-sheet" role="dialog" aria-modal="true" aria-label="Choose agent and model" tabindex="-1" onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); closeMobile() }
          if (event.key !== "Tab") return
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus() }
          if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus() }
        }}>
          <div class="mini-picker__heading"><strong>Agent and model</strong><button type="button" aria-label="Close agent and model picker" onClick={closeMobile}><Icon name="close" /></button></div>
          <div class="composer__selection-options"><ComposerPicker label="Agent" icon="user" placeholder="Default agent" value={selectedAgent()} pending={agentPending()} options={primaryAgents().map((item) => ({ value: item.id, label: item.name, detail: item.description }))} disabled={props.disabled || catalog()?.status !== "ready"} onChange={setAgent} /><ModelControl models={catalog()?.models ?? []} selected={selectedModel()} pending={modelPending()} disabled={props.disabled || catalog()?.status !== "ready"} onChange={(chosen) => { setModel(chosen); writePreferredModel(undefined, chosen) }} /></div>
        </section>
      </Portal></Show>
    </Portal></Show>
    <div class="composer">
    <div class="composer__row" classList={{ "composer__row--dragging": dragging() }} onDragOver={(event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); setDragging(true) } }} onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false) }} onDrop={(event) => { setDragging(false); if (!event.dataTransfer?.files.length) return; event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)) }}>
      <div class="mini-composer__input-wrap">
        <textarea ref={input} class="composer__input" rows={1} aria-label="Message your agent" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={options().length > 0} aria-controls="composer-autocomplete" aria-activedescendant={options().length ? `composer-option-${active()}` : undefined}
          placeholder="Ask anything…" disabled={props.disabled || sending()} value={props.text}
          onInput={(event) => edit(event.currentTarget.value, event.currentTarget.selectionStart)}
          onPaste={(event) => { const files = Array.from(event.clipboardData?.files ?? []); if (!files.length) return; event.preventDefault(); void addFiles(files) }}
          onClick={(event) => { setCursor(event.currentTarget.selectionStart); setClosed(false) }}
          onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) setCursor(event.currentTarget.selectionStart) }} onKeyDown={keyDown} />
        <Show when={options().length || fileError()}><div class="mini-composer__autocomplete" id="composer-autocomplete" role="listbox" aria-label="Suggestions" style={{ "--composer-name-width": `${Math.min(20, Math.max(9, ...options().map((item) => item.label.length)))}ch` }}>
          <For each={options()}>{(option, index) => <button id={`composer-option-${index()}`} type="button" role="option" aria-selected={index() === active()} classList={{ "mini-composer__option--active": index() === active() }} onPointerDown={(event) => event.preventDefault()} onClick={() => select(index())}>
            <span>{option.label}</span><small title={option.description}>{option.description}</small>
          </button>}</For>
          <Show when={fileError()}><p role="status">{fileError()}</p></Show>
        </div></Show>
      </div>
      <Show when={attachments().length}><div class="composer__attachments" aria-label="Attachments"><For each={attachments()}>{(item) => <div class="composer__attachment"><Show when={item.mime.startsWith("image/")}><img src={item.uri} alt="" /></Show><span class="composer__attachment-name" title={item.name}>{item.name}</span><span class="composer__attachment-size">{item.size < 1024 ? `${item.size} B` : `${(item.size / 1024).toFixed(1)} KiB`}</span><button type="button" aria-label={`Remove ${item.name}`} onClick={() => { setAttachments((items) => items.filter((entry) => entry.id !== item.id)); setAttachmentError(undefined) }}><Icon name="close" /></button></div>}</For></div></Show>
      <Show when={attachmentError()}><p class="composer__attachment-error" role="alert">{attachmentError()}</p></Show>
      <Show when={remote.state().upload && attachments().length}><div class="composer__upload" role="status"><span>Uploading {remote.state().upload?.name} · {remote.state().upload?.percent}%</span><progress value={remote.state().upload?.percent ?? 0} max="100" /><button type="button" onClick={() => remote.store.cancelUpload()}>Cancel upload</button></div></Show>
      <Show when={!attachmentError() && attachments().length && remote.state().uploadError}><p class="composer__attachment-error" role="alert">{remote.state().uploadError}</p></Show>
      <div class="composer__controls">
        <ComposerPicker label="Agent" icon="user" placeholder="Default agent" value={selectedAgent()} pending={agentPending()} options={primaryAgents().map((item) => ({ value: item.id, label: item.name, detail: item.description }))} disabled={props.disabled || catalog()?.status !== "ready"} onChange={setAgent} />
        <ModelControl models={catalog()?.models ?? []} selected={selectedModel()} pending={modelPending()} disabled={props.disabled || catalog()?.status !== "ready"} onChange={(chosen) => { setModel(chosen); writePreferredModel(undefined, chosen) }} />
        <Show when={props.showStatus}><ComposerStatus /></Show>
        <span class="composer__spacer" />
        <div class="composer__actions"><input ref={fileInput} class="composer__file-input" type="file" multiple aria-label="Choose files" onChange={(event) => { void addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = "" }} /><button type="button" class="composer__attach" aria-label="Attach files" title="Attach files" disabled={props.disabled || sending() || reading() > 0} onClick={() => fileInput?.click()}><Icon name="plus" /></button><Show when={!props.allowEmpty}><button type="button" class="composer__delivery-toggle" aria-label={delivery() === "steer" ? "Steer mode; switch to Queue" : "Queue mode; switch to Steer"} title={delivery() === "steer" ? "Steer: switch to Queue" : "Queue: switch to Steer"} aria-pressed={delivery() === "queue"} onClick={() => setDelivery(delivery() === "steer" ? "queue" : "steer")}><Icon name={delivery()} /></button></Show>
          <Show when={props.running && props.onInterrupt}><button type="button" class="mini-composer__interrupt" aria-label="Interrupt the running step" onClick={props.onInterrupt}><Icon name="stop" /></button></Show>
          <button type="button" class="mini-composer__send" aria-label={props.allowEmpty ? "Create session" : "Send prompt"} disabled={props.disabled || sending() || reading() > 0 || (!props.allowEmpty && !props.text.trim() && !attachments().length)} onClick={() => void send()}><Icon name="send" /></button></div>
      </div>
    </div>
    </div>
  </>
}

export function Composer(props: { readonly sessionID?: string; readonly running: boolean; readonly canSend: boolean }): JSX.Element {
  const remote = useRemote()
  const [mobileMount, setMobileMount] = createSignal<HTMLDivElement>()
  const text = () => props.sessionID ? remote.state().drafts[props.sessionID] ?? "" : ""
  return <div class="mini-composer__mount">
    <div ref={setMobileMount} class="composer__mobile-identity" />
    <For each={remote.state().mutations.filter((mutation) => mutation.sessionID === props.sessionID && mutation.state !== "sending")}>{(mutation) => <div class={`mutation mutation--${mutation.state}`} role="status">
      <span class="mutation__label">{mutation.label}</span><span class="mutation__detail">{mutation.detail ?? (mutation.state === "failed" ? "Failed" : "Outcome unknown")}</span>
      <Show when={mutation.kind === "prompt" || mutation.kind === "command"}><button class="button button--secondary button--small" onClick={() => void remote.store.retryMutation(mutation.id)}>Send again</button></Show>
      <button class="button button--ghost button--small" onClick={() => remote.store.dismissMutation(mutation.id)}>Dismiss</button>
    </div>}</For>
    <MiniComposer mobileMount={mobileMount()} target={props.sessionID ? { sessionID: props.sessionID } : undefined} text={text()} onText={(value) => { if (props.sessionID) remote.store.setDraft(props.sessionID, value) }} disabled={!props.canSend || !props.sessionID} running={props.running} showStatus onInterrupt={() => void remote.store.interrupt()} onSubmit={async (value) => {
      if (!props.sessionID) return false
      const result = value.kind === "command" ? await remote.store.runCommand(value.input) : await remote.store.sendPrompt(value.input)
      if (result !== false) remote.store.setDraft(props.sessionID, "")
      return result
    }} />
  </div>
}
