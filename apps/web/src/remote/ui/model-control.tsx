import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "../../ui/icon"
import type { ModelOption } from "../catalog"
import type { ModelRefView } from "../projection"
import { containTab, createSheetFrame } from "./composer-sheet"
import { effortLabel, effortLevel, modelSelection, modelSpeeds, orderedModelOptions, orderedVariants, profileForModel, switchModelSpeed, variantsForModel, type ModelSpeed } from "./composer-logic"

const sparkles = [
  { x: 6, y: 34, delay: 0, size: 2 }, { x: 13, y: 66, delay: 0.7, size: 1.5 }, { x: 21, y: 28, delay: 1.3, size: 2.5 },
  { x: 29, y: 58, delay: 0.4, size: 1.5 }, { x: 37, y: 40, delay: 1.9, size: 2 }, { x: 44, y: 70, delay: 1.1, size: 1.5 },
  { x: 52, y: 30, delay: 0.2, size: 2.5 }, { x: 60, y: 62, delay: 1.6, size: 2 }, { x: 68, y: 44, delay: 0.9, size: 1.5 },
  { x: 76, y: 26, delay: 1.4, size: 2 }, { x: 83, y: 64, delay: 0.5, size: 2.5 }, { x: 91, y: 38, delay: 1.8, size: 1.5 },
] as const

export function ModelControl(props: { readonly models: readonly ModelOption[]; readonly selected?: ModelRefView; readonly selectionKey?: string; readonly recent?: readonly ModelRefView[]; readonly disabled?: boolean; readonly pending?: boolean; readonly rememberedVariant?: (model: ModelOption, profile?: string) => string | undefined; readonly onChange: (model: ModelRefView) => void }) {
  const [open, setOpen] = createSignal(false)
  const [listing, setListing] = createSignal(false)
  const [choices, setChoices] = createSignal<"profile" | "speed">()
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [compact, setCompact] = createSignal(false)
  const [position, setPosition] = createSignal({ left: 8, top: 8, width: 340 })
  const [drag, setDrag] = createSignal<{ pointerID: number; fraction: number }>()
  const selection = () => modelSelection(props.models, props.selected)
  const selected = () => selection().model
  const option = () => props.models.find((item) => item.providerID === selected()?.providerID && item.id === selected()?.id)
  const speeds = () => modelSpeeds(props.models, selected())
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
  const models = (): (ModelOption & { readonly recentSelection?: ModelRefView })[] => orderedModelOptions(props.models, props.recent ?? [], selected()).filter((item) => `${item.name} ${item.id} ${item.providerName ?? item.providerID}`.toLowerCase().includes(query().toLowerCase()))
  const isRecent = (item: ModelOption & { readonly recentSelection?: ModelRefView }) => item.recentSelection !== undefined
  const recentCount = () => models().filter(isRecent).length
  let trigger: HTMLButtonElement | undefined
  let surface: HTMLDivElement | undefined
  let search: HTMLInputElement | undefined
  const id = `model-control-${crypto.randomUUID()}`
  const sheetStyle = createSheetFrame(() => compact() && open())

  const close = (focus = false) => {
    setOpen(false)
    setDrag(undefined)
    setListing(false)
    setChoices(undefined)
    setQuery("")
    if (focus) queueMicrotask(() => trigger?.focus())
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
    const previous = choices()
    setChoices(undefined)
    setListing(false)
    setQuery("")
    queueMicrotask(() => surface?.querySelector<HTMLButtonElement>(previous === "profile" ? '[aria-label="Profile"]' : previous === "speed" ? '[aria-label="Model speed"]' : ".model-control__switch")?.focus({ preventScroll: true }))
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
    setDrag(undefined)
    const profile = item.recentSelection === undefined ? profileForModel(props.models, selected(), item) : item.recentSelection.profile
    const variants = variantsForModel(item, profile)
    const remembered = props.rememberedVariant?.(item, profile)
    const currentVariant = selected()?.providerID === item.providerID && selected()?.id === item.id && selected()?.profile === profile ? selected()?.variant : undefined
    const variant = remembered !== undefined && variants.includes(remembered) ? remembered
      : currentVariant !== undefined && variants.includes(currentVariant) ? currentVariant : undefined
    const chosen = { providerID: item.providerID, id: item.id, ...(variant === undefined ? {} : { variant }), ...(profile === undefined ? {} : { profile }) }
    props.onChange(speeds()?.active && speeds()!.active !== "standard" ? switchModelSpeed(props.models, chosen, speeds()!.active) ?? chosen : chosen)
    setListing(false)
    setQuery("")
    if (!item.variants.length && !(item.profiles ?? []).some((entry) => (entry.variants?.length ?? 0) > 0)) close(true)
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
    const media = window.matchMedia("(max-width: 767px)")
    setCompact(media.matches)
    const resize = () => { setCompact(media.matches); close() }
    const outside = (event: PointerEvent) => {
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
    const searching = listing()
    const choosing = choices()
    if (!open()) return
    queueMicrotask(() => {
      reposition()
      const target = searching ? search : choosing ? surface?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]:not([disabled])') ?? surface?.querySelector<HTMLElement>('[role="option"]:not([disabled])') : surface?.querySelector<HTMLElement>(".model-control__switch")
      target?.focus({ preventScroll: compact() })
    })
  })
  return <div class="model-control">
    <button ref={trigger} type="button" class="model-control__trigger" classList={{ "mini-picker__trigger--pending": props.pending }} aria-label="Model" aria-description={props.pending ? "applies with your next send" : undefined} aria-expanded={open()} aria-haspopup="dialog" disabled={props.disabled} onClick={() => { if (open()) close(); else { setListing(false); setOpen(true) } }}>
      <span class="model-control__name">{displayOption()?.name ?? props.selected?.id ?? "Model"}</span><Show when={selected()?.profile}><span class="model-control__effort">{selected()?.profile}</span></Show><Show when={stops().length}><span class="model-control__effort">{effort()}</span></Show><Icon name="chevron-down" />
    </button>
    <Show when={open()}><Portal>
      <Show when={compact()}><div class="mini-picker__scrim" data-cursor="action" onClick={() => close()} /></Show>
      <div ref={surface} class="mini-picker__surface model-control__surface" classList={{ "mini-picker__surface--sheet": compact(), "model-control__surface--dragging": !!drag() }} data-level={level()} style={compact() ? sheetStyle() : { left: `${position().left}px`, top: `${position().top}px`, width: `${position().width}px` }} role="dialog" aria-modal={compact() ? "true" : undefined} aria-label={listing() ? "Choose model" : choices() === "profile" ? "Choose profile" : choices() === "speed" ? "Model speed" : "Model settings"} onKeyDown={(event) => {
        if (compact() && surface && containTab(event, surface)) { event.stopPropagation(); return }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (listing() || choices()) returnToSettings(); else close(true) }
        if (choices() && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault()
          const options = [...surface!.querySelectorAll<HTMLButtonElement>('[role="option"]:not([disabled])')]
          const index = options.findIndex((option) => option === document.activeElement)
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
          options[next]?.focus()
          return
        }
        if (!listing()) return
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((active() + (event.key === "ArrowDown" ? 1 : -1) + models().length) % (models().length || 1)); queueMicrotask(() => document.getElementById(`${id}-${active()}`)?.scrollIntoView({ block: "nearest" })) }
        if (event.key === "Enter" && models()[active()]) { event.preventDefault(); chooseModel(models()[active()]!) }
      }}>
        <Show when={listing()}><div class="mini-picker__heading"><strong><Icon name="chevron-right" /> Choose model</strong><button type="button" aria-label="Close model picker" onClick={() => close(true)}><Icon name="close" /></button></div></Show>
        <Show when={choices()}><div class="mini-picker__heading"><button type="button" class="model-control__back" aria-label="Back to model settings" onClick={returnToSettings}><Icon name="chevron-right" /></button><strong>{choices() === "profile" ? "Choose profile" : "Model speed"}</strong><button type="button" aria-label="Close model picker" onClick={() => close(true)}><Icon name="close" /></button></div><div class="mini-picker__list model-control__choices" role="listbox" aria-label={choices() === "profile" ? "Profiles" : "Model speeds"}>
          <Show when={choices() === "profile"}><For each={profiles()}>{(profile) => <button type="button" class="mini-picker__option" role="option" aria-selected={(selected()?.profile ?? "") === profile.value} onClick={() => chooseProfile(profile.value)}>{profile.label}<Show when={profile.detail}><small>{profile.detail}</small></Show></button>}</For><Show when={!profiles().length}><p class="mini-picker__empty">No available profiles</p></Show></Show>
          <Show when={choices() === "speed"}><For each={speeds()?.options}>{(speed) => <button type="button" class="mini-picker__option" role="option" aria-selected={speeds()?.active === speed.speed} disabled={!speed.available} aria-description={!speed.available ? "The selected profile is not available at this speed. Choose an available profile first." : undefined} onClick={() => chooseSpeed(speed.speed)}>{speed.label}<Show when={!speed.available}><small>Selected profile unavailable</small></Show></button>}</For></Show>
        </div></Show>
        <Show when={!listing() && !choices()}>
          <div class="model-control__hero"><button type="button" class="model-control__fast" aria-label="Model speed" aria-pressed={speeds()?.active !== undefined && speeds()?.active !== "standard"} aria-expanded={choices() === "speed"} aria-haspopup="listbox" aria-disabled={(speeds()?.options.length ?? 0) < 2} aria-description={(speeds()?.options.length ?? 0) < 2 ? `No alternate model speed for ${displayOption()?.name ?? "this model"}` : `Current speed: ${speeds()?.options.find((entry) => entry.speed === speeds()?.active)?.label}`} title="Model speed" onClick={() => { if ((speeds()?.options.length ?? 0) > 1) setChoices("speed") }}><Icon name="zap" /></button><button type="button" class="model-control__switch" onClick={() => { setListing(true); setActive(0) }}><strong>{effort()}</strong><span>{displayOption()?.name ?? "Choose model"}<Icon name="chevron-down" /></span></button><div class="model-control__heading-actions"><Show when={option()}><button type="button" aria-label="Clear reasoning effort override" title="Clear reasoning effort override" onClick={clearOverride}><Icon name="reset" /></button></Show><button type="button" aria-label="Close model picker" onClick={() => close(true)}><Icon name="close" /></button></div></div>
          <Show when={option()}><div class="model-control__profile"><button type="button" aria-label="Profile" aria-haspopup="listbox" aria-expanded={choices() === "profile"} disabled={props.disabled} onClick={() => setChoices("profile")}><span>Profile · {profileLabel()}</span><Icon name="chevron-right" /></button></div></Show>
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
        <Show when={listing()}><input ref={search} class="mini-picker__search" type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={models().length ? `${id}-${active()}` : undefined} aria-label="Search models" placeholder="Search models…" value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setActive(0) }} /><div id={`${id}-list`} class="mini-picker__list" role="listbox" aria-label="Models"><For each={models()}>{(item, index) => <><Show when={index() === 0 || index() === recentCount() || !isRecent(item) && !isRecent(models()[index() - 1]!) && models()[index() - 1]?.providerID !== item.providerID}><div class="mini-picker__group model-control__provider" role="presentation">{isRecent(item) ? "Recent" : item.providerName ?? item.providerID}</div></Show><button id={`${id}-${index()}`} type="button" role="option" aria-label={isRecent(item) ? `${item.name} · ${item.providerName ?? item.providerID} · ${item.id}${item.recentSelection?.profile ? ` · profile ${item.recentSelection.profile}` : ""}` : undefined} aria-selected={displayOption()?.providerID === item.providerID && displayOption()?.id === item.id && (item.recentSelection === undefined || displayOption()?.providerID === item.recentSelection.providerID && displayOption()?.id === item.recentSelection.id && selected()?.profile === item.recentSelection.profile)} class="mini-picker__option model-control__model" classList={{ "mini-picker__option--active": active() === index() }} onPointerEnter={() => setActive(index())} onClick={() => chooseModel(item)}>{item.name}<small>{isRecent(item) ? `${item.providerName ?? item.providerID} · ${item.recentSelection?.profile ? `Profile ${item.recentSelection.profile} · ` : ""}` : ""}{item.id}</small></button></>}</For><Show when={!models().length}><p class="mini-picker__empty">No matches</p></Show></div></Show>
      </div>
    </Portal></Show>
  </div>
}
