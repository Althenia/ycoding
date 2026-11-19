import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import type { ModelOption } from "../catalog"
import type { ModelRefView } from "../projection"
import { modelEffortNotice } from "../view-model"
import { effortLabel, effortLevel, modelSelection, modelSpeeds, orderedModelOptions, orderedVariants, profileForModel, switchModelSpeed, variantsForModel, type ModelSpeed } from "./composer-logic"
import { SharedEffortControl } from "./shared-workspace"

const sparkles = [
  { x: 6, y: 34, delay: 0, size: 2 }, { x: 13, y: 66, delay: 0.7, size: 1.5 }, { x: 21, y: 28, delay: 1.3, size: 2.5 },
  { x: 29, y: 58, delay: 0.4, size: 1.5 }, { x: 37, y: 40, delay: 1.9, size: 2 }, { x: 44, y: 70, delay: 1.1, size: 1.5 },
  { x: 52, y: 30, delay: 0.2, size: 2.5 }, { x: 60, y: 62, delay: 1.6, size: 2 }, { x: 68, y: 44, delay: 0.9, size: 1.5 },
  { x: 76, y: 26, delay: 1.4, size: 2 }, { x: 83, y: 64, delay: 0.5, size: 2.5 }, { x: 91, y: 38, delay: 1.8, size: 1.5 },
] as const

export function ReasoningEffort(props: { readonly models: readonly ModelOption[]; readonly selected?: ModelRefView; readonly disabled?: boolean; readonly onChange: (model: ModelRefView) => void }) {
  const option = () => props.models.find((item) => item.providerID === props.selected?.providerID && item.id === props.selected?.id)
  const stops = () => orderedVariants(variantsForModel(option(), props.selected?.profile), option())
  const stale = () => props.selected?.variant !== undefined && !stops().includes(props.selected.variant)
  const choose = (variant?: string) => {
    const current = props.selected
    if (!current) return
    props.onChange({ providerID: current.providerID, id: current.id, ...(current.profile === undefined ? {} : { profile: current.profile }), ...(variant === undefined ? {} : { variant }) })
  }
  return <SharedEffortControl variants={stops().map((value) => ({ value, label: effortLabel(value, option()) }))} current={props.selected?.variant} currentLabel={props.selected?.variant === undefined ? "Model default" : effortLabel(props.selected.variant, option())} available={option() !== undefined} stale={stale()} selected={props.selected !== undefined} disabled={props.disabled} onSelect={choose} />
}

export function ModelControl(props: { readonly models: readonly ModelOption[]; readonly selected?: ModelRefView; readonly selectionKey?: string; readonly recent?: readonly ModelRefView[]; readonly disabled?: boolean; readonly pending?: boolean; readonly rememberedVariant?: (model: ModelOption, profile?: string) => string | undefined; readonly onChange: (model: ModelRefView) => void }) {
  const [view, setView] = createSignal<"models" | "settings" | "settings-models" | "profile" | "speed">()
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [compact, setCompact] = createSignal(false)
  const [position, setPosition] = createSignal({ left: 8, top: 8, width: 340 })
  const [drag, setDrag] = createSignal<{ pointerID: number; fraction: number }>()
  const open = () => view() !== undefined
  const listing = () => view() === "models" || view() === "settings-models"
  const nested = () => view() === "settings-models" || view() === "profile" || view() === "speed"
  const selection = createMemo(() => modelSelection(props.models, props.selected))
  const selected = () => selection().model
  const option = createMemo(() => props.models.find((item) => item.providerID === selected()?.providerID && item.id === selected()?.id))
  const speeds = createMemo(() => modelSpeeds(props.models, selected()))
  const displayOption = () => speeds()?.base ?? option()
  const stops = () => orderedVariants(variantsForModel(option(), selected()?.profile), option())
  const selectedIndex = () => {
    const variant = selected()?.variant
    return variant === undefined ? 0 : Math.max(0, stops().indexOf(variant))
  }
  const fraction = () => drag()?.fraction ?? (stops().length < 2 ? 0 : selectedIndex() / (stops().length - 1))
  const level = () => selection().blocked || selected()?.variant === undefined ? "unselected" : effortLevel(selected()?.variant, option())
  const glow = () => selected()?.variant === undefined ? 0 : (drag()?.fraction ?? (selectedIndex() + 1) / stops().length)
  const effort = () => selection().blocked ? `Unavailable: ${selected()?.variant ?? selected()?.id}` : selected()?.variant === undefined ? "Model settings" : effortLabel(selected()!.variant!, option())
  const profileLabel = () => selected()?.profile === undefined ? option()?.enabled === false ? "Choose a profile" : "Default"
    : option()?.profiles?.some((profile) => profile.name === selected()?.profile) ? selected()!.profile : `Unavailable: ${selected()!.profile}`
  const profiles = () => [...(option()?.enabled === false ? [] : [{ value: "", label: "Use provider default", detail: "Use the provider's default profile" }]), ...(option()?.profiles ?? []).map((profile) => ({ value: profile.name, label: profile.name, detail: profile.active ? "Global provider default" : undefined }))]
  // The row template reads this for every model. A plain function repeats the catalog sort and freezes the sheet.
  const orderedModels = createMemo(() => orderedModelOptions(props.models, props.recent ?? [], selected()))
  const modelProfile = (item: ModelOption & { readonly recentSelection?: ModelRefView }) => item.recentSelection === undefined ? profileForModel(props.models, selected(), item) : item.recentSelection.profile
  const models = createMemo(() => {
    const term = query().trim().toLowerCase()
    return term ? orderedModels().filter((item) => [item.name, item.id, item.providerName ?? item.providerID, item.providerID, modelProfile(item)].join(" ").toLowerCase().includes(term)) : orderedModels()
  })
  const activeIndex = () => Math.min(active(), Math.max(0, models().length - 1))
  const isRecent = (item: ModelOption & { readonly recentSelection?: ModelRefView }) => item.recentSelection !== undefined
  const recentCount = createMemo(() => models().filter(isRecent).length)
  let trigger: HTMLButtonElement | undefined
  let surface: HTMLDivElement | undefined
  let search: HTMLInputElement | undefined
  let modelSwitch: HTMLButtonElement | undefined
  let settingsInvoker: HTMLButtonElement | undefined
  const id = `model-control-${crypto.randomUUID()}`
  let dismissSheet: (() => void) | undefined
  const panelLabel = () => listing() ? "Choose model" : view() === "profile" ? "Choose profile" : view() === "speed" ? "Model speed" : "Model settings"

  const close = (focus = false) => {
    if (compact() && dismissSheet) { dismissSheet(); return }
    settingsInvoker = undefined
    setView(undefined)
    setDrag(undefined)
    setQuery("")
    if (focus) trigger?.focus({ preventScroll: true })
  }
  let previousSelectionKey = props.selectionKey
  createEffect(() => {
    if (props.selectionKey === previousSelectionKey) return
    previousSelectionKey = props.selectionKey
    close()
  })
  const chooseVariant = (index: number) => {
    const item = option()
    const variant = stops()[index]
    if (!item || variant === undefined) return
    props.onChange({ providerID: item.providerID, id: item.id, variant, ...(selected()?.profile === undefined ? {} : { profile: selected()!.profile }) })
  }
  const clearOverride = () => {
    const item = option()
    if (item) props.onChange({ providerID: item.providerID, id: item.id, ...(selected()?.profile === undefined ? {} : { profile: selected()!.profile }) })
  }
  const returnToSettings = () => {
    setQuery("")
    setDrag(undefined)
    setView("settings")
  }
  const openModels = (invoker?: HTMLButtonElement) => {
    settingsInvoker = invoker
    setActive(0)
    setView(invoker ? "settings-models" : "models")
  }
  const chooseSpeed = (speed: ModelSpeed) => {
    const next = switchModelSpeed(props.models, selected(), speed)
    if (next) props.onChange(next)
    returnToSettings()
  }
  const chooseProfile = (profile: string) => {
    const item = option()
    if (!item || !profiles().some((entry) => entry.value === profile)) return
    const selectedProfile = profile || undefined
    const variants = variantsForModel(item, selectedProfile)
    const remembered = props.rememberedVariant?.(item, selectedProfile)
    const currentVariant = selected()?.variant
    const variant = currentVariant !== undefined && variants.includes(currentVariant) ? currentVariant
      : remembered !== undefined && variants.includes(remembered) ? remembered : undefined
    props.onChange({ providerID: item.providerID, id: item.id, ...(variant === undefined ? {} : { variant }), ...(selectedProfile === undefined ? {} : { profile: selectedProfile }) })
    returnToSettings()
  }
  const chooseModel = (item: ModelOption & { readonly recentSelection?: ModelRefView }) => {
    const profile = modelProfile(item)
    const current = selected()
    if (current && displayOption()?.providerID === item.providerID && displayOption()?.id === item.id && current.profile === profile && !selection().blocked) {
      props.onChange(current)
    } else {
      const remembered = props.rememberedVariant?.(item, profile)
      const variant = remembered !== undefined && variantsForModel(item, profile).includes(remembered) ? remembered : undefined
      const chosen = { providerID: item.providerID, id: item.id, ...(variant === undefined ? {} : { variant }), ...(profile === undefined ? {} : { profile }) }
      const speed = speeds()?.active
      props.onChange(speed && speed !== "standard" ? switchModelSpeed(props.models, chosen, speed) ?? chosen : chosen)
    }
    if (view() === "settings-models") returnToSettings()
    else close(true)
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    if (nested()) returnToSettings()
    else close(true)
  }
  const reposition = () => {
    if (!open() || compact() || !trigger || !surface) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(340, window.innerWidth - 16)
    setPosition({ left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8), top: rect.top - surface.offsetHeight >= 8 ? rect.top - surface.offsetHeight - 8 : Math.min(rect.bottom + 8, window.innerHeight - surface.offsetHeight - 8), width })
  }
  const pointerFraction = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const inset = Math.min(rect.height, rect.width / 4) / 2
    return Math.max(0, Math.min(1, (event.clientX - rect.left - inset) / Math.max(1, rect.width - inset * 2)))
  }
  onMount(() => {
    const media = window.matchMedia("(max-width: 767px), (max-height: 599px) and (pointer: coarse)")
    setCompact(media.matches)
    const resize = () => { dismissSheet = undefined; close(); setCompact(media.matches) }
    const outside = (event: PointerEvent) => {
      if (compact()) return
      if (open() && event.target instanceof Node && !surface?.contains(event.target) && !trigger?.contains(event.target)) close()
    }
    media.addEventListener("change", resize)
    document.addEventListener("pointerdown", outside)
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)
    onCleanup(() => {
      media.removeEventListener("change", resize)
      document.removeEventListener("pointerdown", outside)
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
    })
  })
  createEffect(() => {
    const page = view()
    if (!page) return
    queueMicrotask(() => {
      if (view() !== page) return
      reposition()
      const target = listing() ? search : nested() ? surface?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]:not([disabled])') ?? surface?.querySelector<HTMLElement>('[role="option"]:not([disabled])') : settingsInvoker ?? modelSwitch
      target?.focus({ preventScroll: true })
      if (page === "settings") settingsInvoker = undefined
    })
  })
  const settingsAction = () => <button type="button" class="button button--ghost button--icon model-control__list-settings" aria-label="Model settings" onClick={returnToSettings}><Icon name="settings" /></button>
  return <div class="model-control">
    <button ref={trigger} type="button" class="model-control__trigger" classList={{ "mini-picker__trigger--pending": props.pending }} aria-label="Model" aria-description={`${displayOption()?.name ?? props.selected?.id ?? "Model"}${displayOption() && displayOption()?.id !== selected()?.id ? `; model ID ${selected()?.id}` : ""}${selected()?.profile ? `; profile ${selected()?.profile}` : ""}${props.pending ? "; applies with your next send" : ""}`} aria-expanded={open()} aria-haspopup="dialog" disabled={props.disabled} onClick={() => { if (open()) close(); else openModels() }}>
      <span class="model-control__name">{displayOption()?.name ?? props.selected?.id ?? "Model"}</span><Show when={selected()?.profile}><span class="model-control__effort">{selected()?.profile}</span></Show><Show when={stops().length}><span class="model-control__effort">{effort()}</span></Show><Icon name="chevron-down" />
    </button>
    <Show when={open()}><Portal ref={(portal) => portal.addEventListener("keydown", escape, { capture: true })}>{(() => {
      const content = <div ref={surface} class="mini-picker__surface model-control__surface" classList={{ "mini-picker__surface--sheet": compact(), "model-control__surface--dragging": !!drag() }} data-level={level()} style={compact() ? undefined : { left: `${position().left}px`, top: `${position().top}px`, width: `${position().width}px` }} role={compact() ? undefined : "dialog"} aria-label={compact() ? undefined : panelLabel()} onKeyDown={(event) => {
        if ((view() === "profile" || view() === "speed") && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault()
          const options = [...surface!.querySelectorAll<HTMLButtonElement>('[role="option"]:not([disabled])')]
          const index = options.findIndex((option) => option === document.activeElement)
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
          options[next]?.focus()
        }
      }}>
        <Show when={view() !== "settings" && !compact()}><div class="mini-picker__heading"><Show when={nested()}><button type="button" class="model-control__back" aria-label="Back to model settings" onClick={returnToSettings}><Icon name="chevron-right" /></button></Show><strong><Show when={view() === "models"}><Icon name="chevron-right" /></Show>{panelLabel()}</strong><Show when={view() === "models"}>{settingsAction()}</Show><button type="button" aria-label="Close model picker" onClick={() => close(true)}><Icon name="close" /></button></div></Show>
        <Show when={view() === "profile" || view() === "speed"}><div class="mini-picker__list model-control__choices" role="listbox" aria-label={view() === "profile" ? "Profiles" : "Model speeds"}>
          <Show when={view() === "profile"}><For each={profiles()}>{(profile) => <button type="button" class="mini-picker__option" role="option" aria-selected={(selected()?.profile ?? "") === profile.value} onClick={() => chooseProfile(profile.value)}>{profile.label}<Show when={profile.detail}><small>{profile.detail}</small></Show></button>}</For><Show when={!profiles().length}><p class="mini-picker__empty">No available profiles</p></Show></Show>
          <Show when={view() === "speed"}><For each={speeds()?.options}>{(speed) => <button type="button" class="mini-picker__option" role="option" aria-selected={speeds()?.active === speed.speed} disabled={!speed.available} aria-description={!speed.available ? "The selected profile is not available at this speed. Choose an available profile first." : undefined} onClick={() => chooseSpeed(speed.speed)}>{speed.label}<Show when={!speed.available}><small>Selected profile unavailable</small></Show></button>}</For></Show>
        </div></Show>
        <Show when={view() !== "models"}><div hidden={view() !== "settings"} inert={view() !== "settings"}>
          <div class="model-control__hero"><button type="button" class="model-control__fast" aria-label="Model speed" aria-pressed={speeds()?.active !== undefined && speeds()?.active !== "standard"} aria-expanded={view() === "speed"} aria-haspopup="listbox" aria-disabled={(speeds()?.options.length ?? 0) < 2} aria-description={(speeds()?.options.length ?? 0) < 2 ? `No alternate model speed for ${displayOption()?.name ?? "this model"}` : `Current speed: ${speeds()?.options.find((entry) => entry.speed === speeds()?.active)?.label}`} data-tooltip="Model speed" onClick={(event) => { if ((speeds()?.options.length ?? 0) < 2) return; settingsInvoker = event.currentTarget; setView("speed") }}><Icon name="zap" /></button><button ref={modelSwitch} type="button" class="model-control__switch" aria-label="Choose model" aria-description={`${displayOption()?.name ?? "Model"}; ${effort()}`} aria-haspopup="listbox" aria-expanded={view() === "settings-models"} onClick={(event) => openModels(event.currentTarget)}><strong>{effort()}</strong><span>{displayOption()?.name ?? "Choose model"}<Icon name="chevron-down" /></span></button><div class="model-control__heading-actions"><Show when={view() === "settings" && option()}><button type="button" aria-label="Clear reasoning effort override" data-tooltip="Clear reasoning effort override" onClick={clearOverride}><Icon name="reset" /></button></Show><Show when={view() === "settings" && !compact()}><button type="button" aria-label="Close model picker" onClick={() => close(true)}><Icon name="close" /></button></Show></div></div>
          <Show when={option()}><div class="model-control__profile"><button type="button" aria-label="Profile" aria-haspopup="listbox" aria-expanded={view() === "profile"} disabled={props.disabled} onClick={(event) => { settingsInvoker = event.currentTarget; setView("profile") }}><span>Profile · {profileLabel()}</span><Icon name="chevron-right" /></button></div></Show>
        </div></Show>
        <Show when={view() === "settings"}>
          <Show when={modelEffortNotice({ known: option() !== undefined, blocked: selection().blocked === true, variants: stops().length })}>{(notice) => <p class="field__hint" style={{ padding: "var(--yc-space-2) var(--yc-space-3)" }}>{notice()}</p>}</Show>
          <Show when={stops().length && !selection().blocked}><div class="model-control__slider" role="slider" tabindex="0" aria-label="Reasoning effort" aria-valuemin="0" aria-valuemax={stops().length - 1} aria-valuenow={selectedIndex()} aria-valuetext={selected()?.variant === undefined ? "No effort override" : effort()} onKeyDown={(event) => {
            const next = event.key === "Home" ? 0 : event.key === "End" ? stops().length - 1 : event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp" ? Math.min(stops().length - 1, selectedIndex() + 1) : event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown" ? Math.max(0, selectedIndex() - 1) : undefined
            if (next === undefined) return
            event.preventDefault()
            chooseVariant(next)
          }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDrag({ pointerID:event.pointerId, fraction:pointerFraction(event) }) }} onPointerMove={(event) => { if (drag()?.pointerID === event.pointerId) setDrag({ pointerID:event.pointerId, fraction:pointerFraction(event) }) }} onPointerUp={(event) => { if (drag()?.pointerID !== event.pointerId) return; const next = Math.round(pointerFraction(event) * (stops().length - 1)); setDrag(undefined); chooseVariant(next) }} onPointerCancel={(event) => { if (drag()?.pointerID === event.pointerId) setDrag(undefined) }} onLostPointerCapture={(event) => { if (drag()?.pointerID === event.pointerId) setDrag(undefined) }}>
            <div class="model-control__track" style={{ "--composer-effort-fraction": String(fraction()), "--composer-effort-glow": String(glow()) }}><div class="model-control__fill"><For each={[JSON.stringify(selected())]}>{() => <div class="model-control__sparkles" aria-hidden="true"><For each={sparkles}>{(sparkle) => <i style={{ left: `${sparkle.x}%`, top: `${sparkle.y}%`, "--composer-sparkle-delay": `${-sparkle.delay}s`, "--composer-sparkle-size": `${sparkle.size}px` }} />}</For></div>}</For></div><span class="model-control__thumb" /></div>
            <div class="model-control__labels" style={{ "grid-template-columns": `repeat(${stops().length}, minmax(0, 1fr))` }}><For each={stops()}>{(variant) => <span>{effortLabel(variant, option())}</span>}</For></div>
          </div></Show>
        </Show>
        <Show when={listing()}><input ref={search} class="mini-picker__search" type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={models().length ? `${id}-${activeIndex()}` : undefined} aria-label="Search models" placeholder="Search models…" value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setActive(0) }} onKeyDown={(event) => {
          if (event.isComposing || !models().length) return
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            setActive((activeIndex() + (event.key === "ArrowDown" ? 1 : -1) + models().length) % models().length)
            document.getElementById(`${id}-${activeIndex()}`)?.scrollIntoView({ block: "nearest" })
          }
          if (event.key === "Enter") { event.preventDefault(); chooseModel(models()[activeIndex()]!) }
        }} /><div id={`${id}-list`} class="mini-picker__list" role="listbox" aria-label="Models"><For each={models()}>{(item, index) => {
          const profile = () => modelProfile(item)
          const isSelected = () => displayOption()?.providerID === item.providerID && displayOption()?.id === item.id && selected()?.profile === profile()
          return <><Show when={index() === 0 || index() === recentCount() || !isRecent(item) && !isRecent(models()[index() - 1]!) && models()[index() - 1]?.providerID !== item.providerID}><div class="mini-picker__group model-control__provider" role="presentation">{isRecent(item) ? "Recent" : item.providerName ?? item.providerID}</div></Show><button id={`${id}-${index()}`} type="button" role="option" aria-label={`${item.name} · ${item.providerName ?? item.providerID} · ${item.id}${profile() ? ` · profile ${profile()}` : ""}`} aria-description={`${item.providerName && item.providerName !== item.providerID ? `Provider ID: ${item.providerID}.` : ""}${isSelected() && selected()?.id !== item.id ? ` Selected model ID: ${selected()?.id}.` : ""}`.trim() || undefined} aria-selected={isSelected()} class="mini-picker__option model-control__model" classList={{ "mini-picker__option--active": activeIndex() === index() }} onPointerEnter={() => setActive(index())} onClick={() => chooseModel(item)}>{item.name}<small>{isRecent(item) ? `${item.providerName ?? item.providerID} · ` : ""}{profile() ? `Profile ${profile()} · ` : ""}{item.id}</small></button></>
        }}</For><Show when={!models().length}><p class="mini-picker__empty">No matches</p></Show></div></Show>
      </div>
      return compact() ? <Modal class="overlay--sheet overlay--composer-picker overlay--model-control" label={panelLabel()} header={<><Show when={nested()}><button type="button" class="button button--ghost button--icon" aria-label="Back to model settings" onClick={returnToSettings}><Icon name="arrow-left" /></button></Show><strong>{panelLabel()}</strong><Show when={view() === "models"}>{settingsAction()}</Show></>} returnFocus={trigger!} requestClose={(close) => { dismissSheet = close }} onClose={() => { dismissSheet = undefined; close() }}>{content}</Modal> : content
    })()}</Portal></Show>
  </div>
}
