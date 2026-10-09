import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { createDebouncer, createThrottler } from "@tanstack/solid-pacer"
import { Icon } from "../../ui/icon"
import { catalogKey, type CatalogTarget, type CatalogView, type FileOption } from "../catalog"
import { useRemote } from "../context"
import { defaultComposerModel, readPreferredModel, readRecentModels, rememberRecentModel, writePreferredModel } from "../preferences"
import { contextWindowDisplay, generationSpeedDisplay } from "../projection"
import type { ModelRefView } from "../projection"
import { applyMention, autocompleteBound, modelSelection, modelSelectionKey, needsCatalogRead, optionsForTrigger, pairedFastModel, reconcileMentions, sameModel, submission, suggestionTrigger, tokenKey, triggerAt, type MentionPart } from "./composer-logic"
import { ComposerPicker } from "./composer-picker"
import { containTab, createSheetFrame } from "./composer-sheet"
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
  const [modelsByTarget, setModelsByTarget] = createSignal<Record<string, ModelRefView>>({})
  const [forcedModelSwitches, setForcedModelSwitches] = createSignal<Record<string, { readonly revision: number }>>({})
  const [recentModels, setRecentModels] = createSignal(readRecentModels())
  const rememberedVariants = new Map<string, string>()
  const [delivery, setDelivery] = createSignal<"steer" | "queue">("steer")
  const [attachments, setAttachments] = createSignal<readonly ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = createSignal<string>()
  const [reading, setReading] = createSignal(0)
  const [dragging, setDragging] = createSignal(false)
  const [parts, setParts] = createSignal<readonly MentionPart[]>([])
  const [cursor, setCursor] = createSignal(0)
  const [fileResult, setFileResult] = createSignal<readonly FileOption[]>([])
  const [fileError, setFileError] = createSignal<string>()
  const [active, setActive] = createSignal(0)
  const [dismissed, setDismissed] = createSignal<string>()
  const [bound, setBound] = createSignal<number>()
  const [mobileOpen, setMobileOpen] = createSignal(false)
  const [contextOpen, setContextOpen] = createSignal(false)
  const [contextPinned, setContextPinned] = createSignal(false)
  const [contextLeaving, setContextLeaving] = createSignal(false)
  let input: HTMLTextAreaElement | undefined
  let inputWrap: HTMLDivElement | undefined
  let autocomplete: HTMLDivElement | undefined
  let fileInput: HTMLInputElement | undefined
  let mobileTrigger: HTMLButtonElement | undefined
  let mobileSheet: HTMLElement | undefined
  let contextTrigger: HTMLButtonElement | undefined
  const contextClose = createDebouncer(() => { if (!contextPinned()) closeContext() }, { wait: 100 })
  let request = 0
  let attachmentGeneration = 0
  const closeMobile = () => { setMobileOpen(false); queueMicrotask(() => mobileTrigger?.focus()) }
  const mobileSheetStyle = createSheetFrame(mobileOpen)

  const targetKey = createMemo(() => props.target ? catalogKey(props.target) : undefined)
  const modelKey = createMemo(() => modelSelectionKey(props.target, remote.state().activeDeviceID, remote.state().generation))
  const model = () => modelKey() ? modelsByTarget()[modelKey()!] : undefined
  const setModel = (selected: ModelRefView | undefined) => {
    const key = modelKey()
    if (key && selected === undefined) setForcedModelSwitches((forced) => { const copy = { ...forced }; delete copy[key]; return copy })
    if (key) setModelsByTarget((current) => {
      if (selected === undefined) {
        const next = { ...current }
        delete next[key]
        return next
      }
      return { ...current, [key]: selected }
    })
  }
  const catalog = (): CatalogView | undefined => targetKey() ? remote.state().catalogs[targetKey()!] : undefined
  const current = () => props.target && "sessionID" in props.target && remote.state().selectedSessionInfo?.id === props.target.sessionID ? remote.state().selectedSessionInfo : undefined
  const sessionTarget = () => props.target !== undefined && "sessionID" in props.target
  const upload = () => props.target && "sessionID" in props.target && remote.state().upload?.sessionID === props.target.sessionID ? remote.state().upload : undefined
  const currentModel = () => {
    if (!current()) return undefined
    if (current()?.model) return current()?.model
    return catalog()?.defaultModel
  }
  let observedModelScope = JSON.stringify([remote.state().activeDeviceID, remote.state().generation])
  createEffect(() => {
    const scope = JSON.stringify([remote.state().activeDeviceID, remote.state().generation])
    if (scope === observedModelScope) return
    observedModelScope = scope
    setModelsByTarget({})
    setForcedModelSwitches({})
  })
  createEffect(() => {
    const key = modelKey()
    const sessionID = props.target && "sessionID" in props.target ? props.target.sessionID : undefined
    const forced = key === undefined ? undefined : forcedModelSwitches()[key]
    const confirmed = sessionID === undefined ? undefined : remote.state().confirmedModelSwitches?.[sessionID]
    if (key !== undefined && forced !== undefined && confirmed !== undefined && confirmed.revision > forced.revision && sameModel(confirmed.model, model()))
      setForcedModelSwitches((values) => { const next = { ...values }; delete next[key]; return next })
  })
  const selectedAgent = () => agent() ?? current()?.agent
  const requestedModel = () => model() ?? (sessionTarget() ? currentModel() : defaultComposerModel(catalog(), readPreferredModel()))
  const modelChoice = createMemo<ReturnType<typeof modelSelection>>(() => {
    if (sessionTarget() && !current()) return { model: model(), blocked: true, warning: "The Session model has not been read yet." }
    if (sessionTarget() && requestedModel() === undefined) return { blocked: true, warning: "The machine's default model is unreported. Choose a model before sending." }
    return catalog()?.status === "ready" ? modelSelection(catalog()!.models, requestedModel()) : { model: requestedModel() }
  })
  const selectedModel = () => modelChoice().model
  const variantKey = (chosen: { readonly providerID: string; readonly id: string }, profile?: string) => JSON.stringify([chosen.providerID, chosen.id, profile])
  const rememberedVariant = (chosen: { readonly providerID: string; readonly id: string }, profile?: string) => rememberedVariants.get(variantKey(chosen, profile))
  const chooseModel = (chosen: ModelRefView) => {
    if (chosen.variant !== undefined) rememberedVariants.set(variantKey(chosen, chosen.profile), chosen.variant)
    if (chosen.variant === undefined) rememberedVariants.delete(variantKey(chosen, chosen.profile))
    const key = modelKey()
    if (key) setForcedModelSwitches((values) => {
      if (!sessionTarget() || current() === undefined || chosen.profile === undefined || !sameModel(chosen, currentModel())) {
        const next = { ...values }
        delete next[key]
        return next
      }
      const sessionID = current()!.id
      return { ...values, [key]: { revision: remote.state().confirmedModelSwitches?.[sessionID]?.revision ?? 0 } }
    })
    setModel(chosen)
    writePreferredModel(undefined, chosen)
    setRecentModels(rememberRecentModel(undefined, chosen))
  }
  const activeView = () => {
    const sessionID = props.target && "sessionID" in props.target ? props.target.sessionID : undefined
    const view = remote.state().view
    return sessionID && remote.state().activeSessionID === sessionID && view?.id === sessionID ? view : undefined
  }
  const speed = () => generationSpeedDisplay(activeView(), diagnosticsModel())
  const contextWindow = () => contextWindowDisplay(activeView(), diagnosticsModel())
  const primaryAgents = () => (catalog()?.agents ?? []).filter((item) => item.mode !== "subagent" && !item.hidden)
  const agentPending = () => !!current() && selectedAgent() !== current()?.agent
  const modelPending = () => !modelChoice().blocked && current() !== undefined && selectedModel() !== undefined && model() !== undefined &&
    (forcedModelSwitches()[modelKey() ?? ""] !== undefined || !sameModel(selectedModel(), currentModel()))
  const diagnosticsModel = () => modelPending() ? selectedModel() : current()?.model ?? selectedModel()
  const mobileLabel = () => `${primaryAgents().find((item) => item.id === selectedAgent())?.name ?? selectedAgent() ?? "Default agent"} · ${pairedFastModel(catalog()?.models ?? [], selectedModel())?.base.name ?? catalog()?.models.find((item) => item.providerID === selectedModel()?.providerID && item.id === selectedModel()?.id)?.name ?? selectedModel()?.id ?? "Model"}${selectedModel()?.variant ? ` · ${selectedModel()?.variant}` : ""}${selectedModel()?.profile ? ` · profile ${selectedModel()?.profile}` : ""}`
  const contextLabel = () => {
    const value = contextWindow()
    return value ? `${value.usedPercent}% used · ${value.leftPercent}% left` : ""
  }
  const contextAccessible = () => {
    const value = contextWindow()
    return value ? `Context window: ${contextLabel()}, ${value.tokens}` : ""
  }
  const ring = () => <svg class="composer__context-ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="composer__context-ring-track" cx="12" cy="12" r="9" pathLength="100" fill="none" stroke-width="3" /><circle class="composer__context-ring-progress" cx="12" cy="12" r="9" pathLength="100" fill="none" stroke-width="3" stroke-dasharray={`${Math.min(100, (contextWindow()?.fraction ?? 0) * 100)} 100`} /></svg>
  const closeContext = () => {
    contextClose.cancel()
    setContextPinned(false)
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setContextLeaving(false); setContextOpen(false) }
    else if (contextOpen()) setContextLeaving(true)
  }
  const showContext = () => { contextClose.cancel(); setContextLeaving(false); setContextOpen(true) }
  const finishContext = (event: AnimationEvent) => {
    if (event.target !== event.currentTarget || event.animationName !== "composer-context-out" || !contextLeaving()) return
    setContextOpen(false)
    setContextLeaving(false)
  }
  const queueContextClose = () => contextClose.maybeExecute()
  const trigger = createMemo(() => suggestionTrigger(props.text, cursor(), dismissed()))
  const options = () => trigger() ? optionsForTrigger(trigger()!.trigger, trigger()!.query, catalog(), fileResult(), !!props.target && "sessionID" in props.target) : []
  const suggesting = () => options().length > 0 || fileError() !== undefined
  const dismissSuggestions = (returnFocus = true) => {
    const match = trigger()
    if (!match) return
    setDismissed(tokenKey(match))
    if (returnFocus) queueMicrotask(() => input?.focus())
  }
  const measureBound = () => {
    if (!inputWrap) return
    const viewport = window.visualViewport
    const region = inputWrap.closest<HTMLElement>(".workspace__scroll") ?? inputWrap.closest(".workspace__main")?.querySelector<HTMLElement>(":scope > .workspace__scroll")
    const top = Math.max(viewport?.offsetTop ?? 0, region?.getBoundingClientRect().top ?? 0)
    setBound(autocompleteBound(inputWrap.getBoundingClientRect().top - top, viewport?.height ?? window.innerHeight, window.matchMedia("(max-width: 767px)").matches))
  }
  const pacedBound = createThrottler(measureBound, { wait: 50 })
  createEffect(() => {
    void props.text
    if (suggesting()) pacedBound.maybeExecute()
  })
  createEffect(() => {
    if (!suggesting()) return
    measureBound()
    const viewport = window.visualViewport
    viewport?.addEventListener("resize", pacedBound.maybeExecute)
    viewport?.addEventListener("scroll", pacedBound.maybeExecute)
    window.addEventListener("resize", pacedBound.maybeExecute)
    onCleanup(() => {
      viewport?.removeEventListener("resize", pacedBound.maybeExecute)
      viewport?.removeEventListener("scroll", pacedBound.maybeExecute)
      window.removeEventListener("resize", pacedBound.maybeExecute)
      pacedBound.cancel()
    })
  })
  createEffect(() => {
    const key = targetKey()
    attachmentGeneration++
    if (key) untrack(() => void remote.store.loadCatalog(props.target!))
    setParts([])
    setAgent(undefined)
    rememberedVariants.clear()
    setFileResult([])
    setAttachments([])
    setAttachmentError(undefined)
    setMobileOpen(false)
    untrack(() => closeContext())
    onCleanup(() => { attachmentGeneration++ })
  })
  createEffect(() => {
    const target = props.target
    if (needsCatalogRead(target, catalog(), remote.state().transport.kind === "open")) untrack(() => void remote.store.loadCatalog(target!))
  })
  createEffect(() => {
    const chosen = selectedModel()
    if (catalog()?.status === "ready" && !modelChoice().blocked && chosen?.variant !== undefined && rememberedVariant(chosen, chosen.profile) === undefined)
      rememberedVariants.set(variantKey(chosen, chosen.profile), chosen.variant)
    if (model() !== undefined && !modelChoice().blocked && forcedModelSwitches()[modelKey() ?? ""] === undefined && sameModel(chosen, currentModel())) setModel(undefined)
  })
  onMount(() => {
    if (!props.mobileMount) return
    const media = window.matchMedia("(max-width: 479px)")
    const close = () => setMobileOpen(false)
    media.addEventListener("change", close)
    onCleanup(() => media.removeEventListener("change", close))
  })
  onMount(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (contextOpen() && !contextTrigger?.parentElement?.contains(event.target)) closeContext()
      if (suggesting() && !inputWrap?.contains(event.target)) dismissSuggestions(false)
    }
    document.addEventListener("pointerdown", outside)
    onCleanup(() => { document.removeEventListener("pointerdown", outside) })
  })
  createEffect(() => { if (!contextWindow() && contextOpen()) closeContext() })
  createEffect(() => {
    if (mobileOpen()) queueMicrotask(() => mobileSheet?.querySelector<HTMLButtonElement>('.mini-picker__trigger')?.focus())
  })
  const findFiles = createDebouncer((query: string, id: number) => {
    void remote.store.findFiles(props.target!, query, 50).then((result) => {
      if (id !== request) return
      if (result.status === "ok") setFileResult(result.files)
      else setFileError(result.message)
    }, () => {
      if (id === request) setFileError("File search failed")
    })
  }, { wait: 220 })
  createEffect(() => {
    const match = trigger()
    const key = targetKey()
    const id = ++request
    findFiles.cancel()
    setActive(0)
    setFileResult([])
    setFileError(undefined)
    if (!key || match?.trigger !== "@" || !match.query.trim()) return
    findFiles.maybeExecute(match.query, id)
  })
  const edit = (text: string, position: number) => {
    setParts(reconcileMentions(props.text, text, parts()))
    props.onText(text)
    setAttachmentError(undefined)
    setCursor(position)
    if (autocomplete) autocomplete.scrollTop = 0
    const next = triggerAt(text, position)
    if (!next || tokenKey(next) !== dismissed()) setDismissed(undefined)
  }
  const select = (index: number) => {
    const option = options()[index]
    const match = trigger()
    if (!option || !match) return
    const result = applyMention(props.text, match.start, cursor(), option, parts())
    props.onText(result.text)
    setParts(result.parts)
    setCursor(result.cursor)
    queueMicrotask(() => { input?.focus(); input?.setSelectionRange(result.cursor, result.cursor) })
  }
  const addFiles = async (files: readonly File[]) => {
    if (props.disabled || !files.length) return
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
    if (props.disabled || reading() || (!props.allowEmpty && !props.text.trim() && !attachments().length)) return
    const chosenAgent = selectedAgent()
    const chosenModel = selectedModel()
    const pendingAgent = current()?.agent === chosenAgent ? undefined : chosenAgent
    const pendingModel = current() === undefined || modelPending() ? chosenModel : undefined
    const requested = submission(props.text, parts(), catalog(), delivery(), pendingAgent, pendingModel, modelPending() && forcedModelSwitches()[modelKey() ?? ""] !== undefined)
    if (requested.kind === "invalid") { setAttachmentError(requested.message); return }
    if ((requested.kind === "prompt" || requested.kind === "command") && modelChoice().blocked) { setAttachmentError(modelChoice().warning); return }
    if (requested.kind !== "prompt" && requested.kind !== "command" && (!props.target || !("sessionID" in props.target))) {
      setAttachmentError("Open a session to use this slash action.")
      return
    }
    if (requested.kind !== "prompt" && requested.kind !== "command" && (attachments().length || parts().some((part) => part.kind === "file" || part.kind === "agent"))) {
      setAttachmentError("Remove attachments and mentions before running this slash action.")
      return
    }
    const files = [...(requested.input && "files" in requested.input ? requested.input.files ?? [] : []), ...attachments().map((item) => ({ uri: item.uri, name: item.name }))]
    if (files.length > 64) { setAttachmentError("A message can contain at most 64 files. Remove an attachment before sending."); return }
    const generation = attachmentGeneration
    const submittedParts = parts()
    const submittedAttachments = attachments()
    try {
      const accepted = requested.kind === "command"
        ? await props.onSubmit({ kind: "command", input: { ...requested.input, ...(files.length ? { files } : {}) } })
        : requested.kind === "prompt"
          ? await props.onSubmit({ kind: "prompt", input: { ...requested.input, ...(files.length ? { files } : {}) } })
          : await props.onSubmit(requested)
      if (generation !== attachmentGeneration) return
      if (accepted === false) {
        if (files.length && remote.state().transport.kind === "open" && remote.state().uploadError) setAttachmentError(remote.state().uploadError)
        return
      }
      if (parts() === submittedParts) setParts([])
      if (attachments() === submittedAttachments) {
        setAttachments([])
        setAttachmentError(undefined)
      }
    } catch (cause) {
      if (generation === attachmentGeneration) setAttachmentError(cause instanceof Error ? cause.message : "The attachment could not be sent.")
    }
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
    if (event.key === "Escape" && suggesting()) {
      event.preventDefault()
      dismissSuggestions()
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }
  return <>
    <Show when={props.mobileMount}><Portal mount={props.mobileMount}>
      <button ref={mobileTrigger} type="button" class="composer__mobile-trigger" classList={{ "composer__mobile-trigger--pending": agentPending() || modelPending() }} aria-label={`Agent and model: ${mobileLabel()}${contextWindow() ? `; ${contextAccessible()}` : ""}${speed() ? `; generation speed ${speed()!.label}` : ""}`} aria-description={agentPending() || modelPending() ? "applies with your next send" : undefined} aria-haspopup="dialog" aria-expanded={mobileOpen()} disabled={props.disabled || catalog()?.status !== "ready"} onClick={() => setMobileOpen(true)}><Show when={contextWindow()}><span class="composer__mobile-context-ring" aria-hidden="true">{ring()}</span></Show><span class="composer__mobile-label" title={mobileLabel()}>{mobileLabel()}</span><Show when={speed()}>{(value) => <span class="composer__mobile-speed">{value().label}</span>}</Show><Icon name="chevron-down" /></button>
      <Show when={mobileOpen()}><Portal>
        <div class="mini-picker__scrim composer__selection-scrim" data-cursor="action" onClick={closeMobile} />
        <section ref={mobileSheet} class="composer__selection-sheet" role="dialog" aria-modal="true" aria-label="Choose agent and model" tabindex="-1" style={mobileSheetStyle()} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); closeMobile() }
          containTab(event, event.currentTarget)
        }}>
          <div class="mini-picker__heading"><strong>Agent and model</strong><button type="button" aria-label="Close agent and model picker" onClick={closeMobile}><Icon name="close" /></button></div>
          <Show when={contextWindow()}>{(value) => <div class="composer__context-summary"><strong>Context window</strong><div class="composer__context-bar" aria-hidden="true"><span class="composer__context-bar-fill" style={{ width: `${Math.min(100, value().fraction * 100)}%` }} /></div><span>{contextLabel()}</span><span>{value().tokens}</span></div>}</Show>
          <div class="composer__selection-options"><ComposerPicker label="Agent" icon="user" placeholder="Default agent" value={selectedAgent()} pending={agentPending()} options={primaryAgents().map((item) => ({ value: item.id, label: item.name, detail: item.description }))} disabled={props.disabled || catalog()?.status !== "ready"} onChange={setAgent} /><ModelControl models={catalog()?.models ?? []} selected={selectedModel()} selectionKey={modelKey()} recent={recentModels()} pending={modelPending()} disabled={props.disabled || catalog()?.status !== "ready" || sessionTarget() && current() === undefined} rememberedVariant={rememberedVariant} onChange={chooseModel} /></div>
        </section>
      </Portal></Show>
    </Portal></Show>
    <div class="composer">
    <div class="composer__row" classList={{ "composer__row--dragging": dragging() }} onDragOver={(event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); setDragging(true) } }} onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false) }} onDrop={(event) => { setDragging(false); if (!event.dataTransfer?.files.length) return; event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)) }}>
      <div ref={inputWrap} class="mini-composer__input-wrap">
        <textarea ref={input} class="composer__input" rows={1} aria-label="Message your agent" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={suggesting()} aria-controls={suggesting() ? "composer-autocomplete" : undefined} aria-activedescendant={options().length ? `composer-option-${active()}` : undefined}
          placeholder="Ask anything…" disabled={props.disabled} value={props.text}
          onInput={(event) => edit(event.currentTarget.value, event.currentTarget.selectionStart)}
          onPaste={(event) => { const files = Array.from(event.clipboardData?.files ?? []); if (!files.length) return; event.preventDefault(); void addFiles(files) }}
          onClick={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) setCursor(event.currentTarget.selectionStart) }} onKeyDown={keyDown} />
        <Show when={suggesting()}><div class="mini-composer__suggestions" style={{ "--composer-suggest-max": bound() === undefined ? undefined : `${bound()}px` }}>
          <div class="mini-composer__suggestions-head"><strong>Suggestions</strong><button type="button" aria-label="Close suggestions" onPointerDown={(event) => event.preventDefault()} onClick={() => dismissSuggestions()}><Icon name="close" size={16} />Close</button></div>
          <div ref={autocomplete} class="mini-composer__autocomplete" id="composer-autocomplete" role="listbox" aria-label="Suggestions" style={{ "--composer-name-width": `${Math.min(20, Math.max(9, ...options().map((item) => item.label.length)))}ch` }}>
            <For each={options()}>{(option, index) => <button id={`composer-option-${index()}`} type="button" role="option" aria-selected={index() === active()} classList={{ "mini-composer__option--active": index() === active(), "mini-composer__option--label-only": !option.description }} onPointerDown={(event) => event.preventDefault()} onClick={() => select(index())}>
              <span>{option.label}</span><Show when={option.description}><small title={option.description}>{option.description}</small></Show>
            </button>}</For>
          </div>
          <Show when={fileError()}><p class="mini-composer__suggestions-status" role="status">{fileError()}</p></Show>
        </div></Show>
      </div>
      <Show when={attachments().length}><div class="composer__attachments" aria-label="Attachments"><For each={attachments()}>{(item) => <div class="composer__attachment"><Show when={item.mime.startsWith("image/")}><img src={item.uri} alt="" /></Show><span class="composer__attachment-name" title={item.name}>{item.name}</span><span class="composer__attachment-size">{item.size < 1024 ? `${item.size} B` : `${(item.size / 1024).toFixed(1)} KiB`}</span><button type="button" aria-label={`Remove ${item.name}`} onClick={() => { setAttachments((items) => items.filter((entry) => entry.id !== item.id)); setAttachmentError(undefined) }}><Icon name="close" /></button></div>}</For></div></Show>
      <Show when={attachmentError()}><p class="composer__attachment-error" role="alert">{attachmentError()}</p></Show>
      <Show when={catalog()?.status === "error" || catalog()?.status === "unsupported"}>
        <div class="composer__catalog-status" role="status"><p class="field__hint">{catalog()?.status === "unsupported" ? "Update YCoding on the connected machine to load agents and models." : catalog()?.message ?? "The agent and model catalog could not be loaded."}</p><button type="button" class="button button--secondary button--small" aria-label="Retry agent and model catalog" disabled={props.disabled} onClick={() => { if (props.target) void remote.store.loadCatalog(props.target, { refresh: true }) }}>Retry catalog</button></div>
      </Show>
      <Show when={modelChoice().warning}>{(warning) => <p class="field__hint composer__model-warning" role="status">{warning()}</p>}</Show>
      <Show when={upload()}>{(value) => <div class="composer__upload" role="status"><span>Uploading {value().name} · {value().percent}%</span><progress aria-label={`Uploading ${value().name}`} value={value().percent} max="100" /><button type="button" onClick={() => remote.store.cancelUpload()}>Cancel upload</button></div>}</Show>
      <div class="composer__controls">
        <ComposerPicker label="Agent" icon="user" placeholder="Default agent" value={selectedAgent()} pending={agentPending()} options={primaryAgents().map((item) => ({ value: item.id, label: item.name, detail: item.description }))} disabled={props.disabled || catalog()?.status !== "ready"} onChange={setAgent} />
        <Show when={contextWindow()}><div class="composer__context"><button ref={contextTrigger} type="button" class="composer__context-trigger" aria-label={contextAccessible()} aria-expanded={contextOpen() && !contextLeaving()} onMouseEnter={() => { if (window.matchMedia("(hover: hover)").matches) showContext() }} onMouseLeave={queueContextClose} onFocus={showContext} onBlur={() => { if (!contextPinned()) queueContextClose() }} onClick={() => { if (contextPinned()) closeContext(); else { setContextPinned(true); showContext() } }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeContext() } }}>{ring()}</button><Show when={contextOpen()}><div class="composer__context-popover" classList={{ "composer__context-popover--leaving": contextLeaving() }} role="tooltip" aria-hidden={contextLeaving()} inert={contextLeaving()} onMouseEnter={contextClose.cancel} onMouseLeave={queueContextClose} onAnimationEnd={finishContext} onAnimationCancel={finishContext}><strong>Context window</strong><span>{contextLabel()}</span><span>{contextWindow()?.tokens}</span></div></Show></div></Show>
        <ModelControl models={catalog()?.models ?? []} selected={selectedModel()} selectionKey={modelKey()} recent={recentModels()} pending={modelPending()} disabled={props.disabled || catalog()?.status !== "ready" || sessionTarget() && current() === undefined} rememberedVariant={rememberedVariant} onChange={chooseModel} />
        <Show when={props.showStatus}><ComposerStatus /></Show>
        <Show when={speed()}>{(value) => <span class="composer__speed" title="Latest generation speed">{value().label}<Show when={value().trend}><span class="composer__speed-trend" aria-hidden="true"> {value().trend}</span></Show></span>}</Show>
        <span class="composer__spacer" />
        <div class="composer__actions"><input ref={fileInput} class="composer__file-input" type="file" multiple aria-label="Choose files" onChange={(event) => { void addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = "" }} /><button type="button" class="composer__attach" aria-label="Attach files" title="Attach files" disabled={props.disabled || reading() > 0} onClick={() => fileInput?.click()}><Icon name="plus" /></button><Show when={!props.allowEmpty}><button type="button" class="composer__delivery-toggle" aria-label={delivery() === "steer" ? "Steer mode; switch to Queue" : "Queue mode; switch to Steer"} title={delivery() === "steer" ? "Steer: switch to Queue" : "Queue: switch to Steer"} aria-pressed={delivery() === "queue"} onClick={() => setDelivery(delivery() === "steer" ? "queue" : "steer")}><Icon name={delivery()} /></button></Show>
          <Show when={props.running && props.onInterrupt}><button type="button" class="mini-composer__interrupt" aria-label="Interrupt the running step" onClick={props.onInterrupt}><Icon name="stop" /></button></Show>
          <button type="button" class="mini-composer__send" aria-label={props.allowEmpty ? "Create session" : "Send prompt"} disabled={props.disabled || reading() > 0 || (!props.allowEmpty && !props.text.trim() && !attachments().length)} onClick={() => void send()}><Icon name="send" /></button></div>
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
    <MiniComposer mobileMount={mobileMount()} target={props.sessionID ? { sessionID: props.sessionID } : undefined} text={text()} onText={(value) => { if (props.sessionID) remote.store.setDraft(props.sessionID, value) }} disabled={!props.canSend || !props.sessionID} running={props.running} showStatus onInterrupt={() => void remote.store.interrupt()} onSubmit={async (value) => {
      const sessionID = props.sessionID
      const draft = text()
      if (!sessionID) return false
      const result = value.kind === "command" ? await remote.store.runCommand(value.input)
        : value.kind === "prompt" ? await remote.store.sendPrompt(value.input)
          : value.kind === "compact" ? await remote.store.compactSession()
          : value.kind === "goal" ? await remote.store.setGoal(value.input.goal)
            : value.kind === "skill" ? await remote.store.activateSkill(value.input.skill)
              : value.kind === "yolo" ? await remote.store.setYolo(value.input.level ?? ([1, 2, 3, 0] as const)[remote.state().view?.autonomy?.yolo ?? 0] ?? 1)
                : false
      if (result !== false && remote.state().drafts[sessionID] === draft) remote.store.setDraft(sessionID, "")
      return result
    }} />
  </div>
}
