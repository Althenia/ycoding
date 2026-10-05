import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "../../ui/icon"
import type { ModelOption } from "../catalog"
import type { ModelRefView } from "../projection"
import { effortLevel, modelSelection, orderedModelOptions, orderedVariants, pairedFastModel, switchFastModel } from "./composer-logic"

/** Fixed sparkle field: positions are stable so the fill reveals the same sky as it grows. */
const sparkles = [
  { x: 6, y: 34, delay: 0, size: 2 }, { x: 13, y: 66, delay: 0.7, size: 1.5 }, { x: 21, y: 28, delay: 1.3, size: 2.5 },
  { x: 29, y: 58, delay: 0.4, size: 1.5 }, { x: 37, y: 40, delay: 1.9, size: 2 }, { x: 44, y: 70, delay: 1.1, size: 1.5 },
  { x: 52, y: 30, delay: 0.2, size: 2.5 }, { x: 60, y: 62, delay: 1.6, size: 2 }, { x: 68, y: 44, delay: 0.9, size: 1.5 },
  { x: 76, y: 26, delay: 1.4, size: 2 }, { x: 83, y: 64, delay: 0.5, size: 2.5 }, { x: 91, y: 38, delay: 1.8, size: 1.5 },
] as const

export function ModelControl(props: { readonly models: readonly ModelOption[]; readonly selected?: ModelRefView; readonly recent?: readonly ModelRefView[]; readonly disabled?: boolean; readonly pending?: boolean; readonly rememberedVariant?: (model: ModelOption) => string | undefined; readonly onChange: (model: ModelRefView) => void }) {
  const [open, setOpen] = createSignal(false)
  const [listing, setListing] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [compact, setCompact] = createSignal(false)
  const [position, setPosition] = createSignal({ left: 8, top: 8, width: 340 })
  const [drag, setDrag] = createSignal<{ pointerID: number; fraction: number }>()
  const selection = () => modelSelection(props.models, props.selected)
  const selected = () => selection().model
  const option = () => props.models.find((item) => item.providerID === selected()?.providerID && item.id === selected()?.id)
  const pair = () => pairedFastModel(props.models, selected())
  const displayOption = () => pair()?.base ?? option()
  const stops = () => orderedVariants(option()?.variants ?? [])
  const selectedIndex = () => {
    const variant = selected()?.variant
    return variant === undefined ? 0 : Math.max(0, stops().indexOf(variant))
  }
  const fraction = () => drag()?.fraction ?? (stops().length < 2 ? 0 : selectedIndex() / (stops().length - 1))
  const level = () => selection().blocked || selected()?.variant === undefined ? "unselected" : effortLevel(selected()?.variant)
  const glow = () => selected()?.variant === undefined ? 0 : (drag()?.fraction ?? (selectedIndex() + 1) / stops().length)
  const effortLabel = () => selection().blocked ? `Unavailable: ${selected()?.variant ?? selected()?.id}` : selected()?.variant ?? "Model settings"
  const models = () => orderedModelOptions(props.models, props.recent ?? [], selected()).filter((item) => `${item.name} ${item.id} ${item.providerName ?? item.providerID}`.toLowerCase().includes(query().toLowerCase()))
  const isRecent = (item: ModelOption) => props.recent?.some((model) => model.providerID === item.providerID && model.id === item.id) ?? false
  const recentCount = () => models().filter(isRecent).length
  let trigger: HTMLButtonElement | undefined
  let surface: HTMLDivElement | undefined
  let search: HTMLInputElement | undefined

  const close = (focus = false) => {
    setOpen(false)
    setDrag(undefined)
    setListing(false)
    setQuery("")
    if (focus) queueMicrotask(() => trigger?.focus())
  }
  const chooseVariant = (index: number) => {
    const item = option()
    const variant = stops()[index]
    if (!item || variant === undefined) return
    props.onChange({ providerID: item.providerID, id: item.id, variant })
  }
  const clearOverride = () => {
    const item = option()
    if (item) props.onChange({ providerID: item.providerID, id: item.id })
  }
  const toggleFast = () => {
    const next = switchFastModel(props.models, selected())
    if (next) props.onChange(next)
  }
  const chooseModel = (item: ModelOption) => {
    setDrag(undefined)
    const remembered = props.rememberedVariant?.(item)
    const chosen = { providerID: item.providerID, id: item.id, ...(remembered !== undefined && item.variants.includes(remembered) ? { variant: remembered } : {}) }
    props.onChange(pair()?.active ? switchFastModel(props.models, chosen) ?? chosen : chosen)
    setListing(false)
    setQuery("")
    if (!item.variants.length) close(true)
  }
  const reposition = () => {
    if (!open() || compact() || !trigger || !surface) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(340, window.innerWidth - 16)
    setPosition({ left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8), top: rect.top - surface.offsetHeight >= 8 ? rect.top - surface.offsetHeight - 8 : Math.min(rect.bottom + 8, window.innerHeight - surface.offsetHeight - 8), width })
  }
  const pointerFraction = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const rect = event.currentTarget.getBoundingClientRect()
    // The thumb travels inside the track, so the usable span excludes half a thumb at each end.
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
    if (open()) queueMicrotask(() => { reposition(); if (searching) search?.focus() })
  })
  return <div class="model-control">
    <button ref={trigger} type="button" class="model-control__trigger" classList={{ "mini-picker__trigger--pending": props.pending }} aria-label="Model" aria-description={props.pending ? "applies with your next send" : undefined} aria-expanded={open()} aria-haspopup="dialog" disabled={props.disabled} onClick={() => { if (open()) close(); else { setListing(false); setOpen(true) } }}>
      <span class="model-control__name">{displayOption()?.name ?? props.selected?.id ?? "Model"}</span><Show when={option()?.variants.length}><span class="model-control__effort">{effortLabel()}</span></Show><Icon name="chevron-down" />
    </button>
    <Show when={open()}><Portal>
      <Show when={compact()}><div class="mini-picker__scrim" data-cursor="action" onClick={() => close()} /></Show>
      <div ref={surface} class="mini-picker__surface model-control__surface" classList={{ "mini-picker__surface--sheet": compact(), "model-control__surface--dragging": !!drag() }} data-level={level()} style={compact() ? undefined : { left: `${position().left}px`, top: `${position().top}px`, width: `${position().width}px` }} role="dialog" aria-label={listing() ? "Choose model" : "Reasoning effort"} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); if (listing()) { setListing(false); queueMicrotask(() => surface?.querySelector<HTMLButtonElement>(".model-control__switch")?.focus()) } else close(true) }
        if (!listing()) return
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((active() + (event.key === "ArrowDown" ? 1 : -1) + models().length) % (models().length || 1)) }
        if (event.key === "Enter" && models()[active()]) { event.preventDefault(); chooseModel(models()[active()]!) }
      }}>
        <Show when={listing()}><div class="mini-picker__heading"><strong><Icon name="chevron-right" /> Choose model</strong><button type="button" aria-label="Close model picker" onClick={() => close(true)}><Icon name="close" /></button></div></Show>
        <Show when={!listing()}>
          <div class="model-control__hero"><button type="button" class="model-control__fast" aria-label="Fast model" aria-pressed={pair()?.active ?? false} aria-disabled={!pair()} aria-description={!pair() ? `No paired fast model for ${displayOption()?.name ?? "this model"}` : undefined} title={pair() ? "Switch paired fast model" : "No paired fast model"} onClick={toggleFast}><Icon name="zap" /></button><button type="button" class="model-control__switch" onClick={() => { setListing(true); setActive(0) }}><strong>{effortLabel()}</strong><span>{displayOption()?.name ?? "Choose model"}<Icon name="chevron-down" /></span></button><div class="model-control__heading-actions"><Show when={option()}><button type="button" aria-label="Clear reasoning effort override" title="Clear reasoning effort override" onClick={clearOverride}><Icon name="reset" /></button></Show><button type="button" aria-label="Close model picker" onClick={() => close(true)}><Icon name="close" /></button></div></div>
          <Show when={stops().length && !selection().blocked}><div class="model-control__slider" role="slider" tabindex="0" aria-label="Reasoning effort" aria-valuemin="0" aria-valuemax={stops().length - 1} aria-valuenow={selectedIndex()} aria-valuetext={selected()?.variant ?? "No effort override"} onKeyDown={(event) => {
            const next = event.key === "Home" ? 0 : event.key === "End" ? stops().length - 1 : event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp" ? Math.min(stops().length - 1, selectedIndex() + 1) : event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown" ? Math.max(0, selectedIndex() - 1) : undefined
            if (next === undefined) return
            event.preventDefault()
            chooseVariant(next)
          }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDrag({ pointerID:event.pointerId, fraction:pointerFraction(event) }) }} onPointerMove={(event) => { if (drag()?.pointerID === event.pointerId) setDrag({ pointerID:event.pointerId, fraction:pointerFraction(event) }) }} onPointerUp={(event) => { if (drag()?.pointerID !== event.pointerId) return; const next = Math.round(pointerFraction(event) * (stops().length - 1)); setDrag(undefined); chooseVariant(next) }} onPointerCancel={(event) => { if (drag()?.pointerID === event.pointerId) setDrag(undefined) }} onLostPointerCapture={(event) => { if (drag()?.pointerID === event.pointerId) setDrag(undefined) }}>
            <div class="model-control__track" style={{ "--composer-effort-fraction": String(fraction()), "--composer-effort-glow": String(glow()) }}><div class="model-control__fill"><div class="model-control__sparkles" aria-hidden="true"><For each={sparkles}>{(sparkle) => <i style={{ left: `${sparkle.x}%`, top: `${sparkle.y}%`, "--composer-sparkle-delay": `${sparkle.delay}s`, "--composer-sparkle-size": `${sparkle.size}px` }} />}</For></div></div><span class="model-control__thumb" /></div>
            <div class="model-control__labels"><For each={stops()}>{(variant) => <span>{variant}</span>}</For></div>
          </div></Show>
        </Show>
        <Show when={listing()}><input ref={search} class="mini-picker__search" type="search" aria-label="Search models" placeholder="Search models…" value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setActive(0) }} /><div class="mini-picker__list" role="listbox" aria-label="Models"><For each={models()}>{(item, index) => <><Show when={index() === 0 || index() === recentCount() || !isRecent(item) && !isRecent(models()[index() - 1]!) && models()[index() - 1]?.providerID !== item.providerID}><div class="mini-picker__group model-control__provider" role="presentation">{isRecent(item) ? "Recent" : item.providerName ?? item.providerID}</div></Show><button type="button" role="option" aria-label={isRecent(item) ? `${item.name} · ${item.providerName ?? item.providerID} · ${item.id}` : undefined} aria-selected={displayOption()?.providerID === item.providerID && displayOption()?.id === item.id} class="mini-picker__option model-control__model" classList={{ "mini-picker__option--active": active() === index() }} onPointerEnter={() => setActive(index())} onClick={() => chooseModel(item)}>{item.name}<small>{isRecent(item) ? `${item.providerName ?? item.providerID} · ` : ""}{item.id}</small></button></>}</For><Show when={!models().length}><p class="mini-picker__empty">No matches</p></Show></div></Show>
      </div>
    </Portal></Show>
  </div>
}
