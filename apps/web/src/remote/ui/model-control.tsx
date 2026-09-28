import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "../../ui/icon"
import type { ModelOption } from "../catalog"
import type { ModelRefView } from "../projection"
import { orderedVariants } from "./composer-logic"

export function ModelControl(props: { readonly models: readonly ModelOption[]; readonly selected?: ModelRefView; readonly disabled?: boolean; readonly pending?: boolean; readonly onChange: (model: ModelRefView) => void }) {
  const [open, setOpen] = createSignal(false)
  const [listing, setListing] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [compact, setCompact] = createSignal(false)
  const [position, setPosition] = createSignal({ left: 8, top: 8, width: 340 })
  const [drag, setDrag] = createSignal<{ pointerID: number; fraction: number }>()
  const option = () => props.models.find((item) => item.providerID === props.selected?.providerID && item.id === props.selected?.id)
  const stops = () => orderedVariants(option()?.variants ?? [])
  const selectedIndex = () => Math.max(0, stops().indexOf(props.selected?.variant ?? option()?.defaultVariant ?? stops()[0]!))
  const fraction = () => drag()?.fraction ?? (stops().length < 2 ? 0 : selectedIndex() / (stops().length - 1))
  const level = () => selectedIndex() === stops().length - 1 && stops().length > 1 ? "top" : (props.selected?.variant ?? option()?.defaultVariant ?? stops()[0])?.toLowerCase() === "medium" ? "medium" : "standard"
  const models = () => props.models.filter((item) => `${item.name} ${item.id} ${item.providerName ?? item.providerID}`.toLowerCase().includes(query().toLowerCase())).sort((left, right) => left.providerID.localeCompare(right.providerID))
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
    if (!item || !variant) return
    props.onChange({ providerID: item.providerID, id: item.id, variant })
  }
  const chooseModel = (item: ModelOption) => {
    setDrag(undefined)
    props.onChange({ providerID: item.providerID, id: item.id, ...(item.defaultVariant ? { variant: item.defaultVariant } : {}) })
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
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
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
    <button ref={trigger} type="button" class="model-control__trigger" classList={{ "mini-picker__trigger--pending": props.pending }} aria-label="Model" aria-description={props.pending ? "applies with your next send" : undefined} aria-expanded={open()} aria-haspopup="dialog" disabled={props.disabled} onClick={() => { if (open()) close(); else { setListing(!option()?.variants.length); setOpen(true) } }}>
      <span class="model-control__name">{option()?.name ?? props.selected?.id ?? "Model"}</span><Show when={option()?.variants.length}><span class="model-control__effort">{props.selected?.variant ?? option()?.defaultVariant ?? stops()[0]}</span></Show><Icon name="chevron-down" />
    </button>
    <Show when={open()}><Portal>
      <Show when={compact()}><div class="mini-picker__scrim" onClick={() => close()} /></Show>
      <div ref={surface} class="mini-picker__surface model-control__surface" classList={{ "mini-picker__surface--sheet": compact(), "model-control__surface--dragging": !!drag() }} data-level={level()} style={compact() ? undefined : { left: `${position().left}px`, top: `${position().top}px`, width: `${position().width}px` }} role="dialog" aria-label={listing() ? "Choose model" : "Reasoning effort"} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); if (listing() && stops().length) { setListing(false); queueMicrotask(() => surface?.querySelector<HTMLButtonElement>(".model-control__switch")?.focus()) } else close(true) }
        if (!listing()) return
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((active() + (event.key === "ArrowDown" ? 1 : -1) + models().length) % (models().length || 1)) }
        if (event.key === "Enter" && models()[active()]) { event.preventDefault(); chooseModel(models()[active()]!) }
      }}>
        <Show when={listing()}><div class="mini-picker__heading"><strong><Icon name="chevron-right" /> Choose model</strong><button type="button" aria-label="Close model picker" onClick={() => close(true)}><Icon name="close" /></button></div></Show>
        <Show when={!listing()}>
          <div class="model-control__hero"><Icon name="zap" /><button type="button" class="model-control__switch" onClick={() => { setListing(true); setActive(0) }}><strong>{props.selected?.variant ?? option()?.defaultVariant ?? stops()[0]}</strong><span>{option()?.name ?? "Choose model"}<Icon name="chevron-down" /></span></button><div class="model-control__heading-actions"><Show when={option()?.defaultVariant}><button type="button" aria-label="Reset reasoning effort" title="Reset reasoning effort" onClick={() => chooseVariant(stops().indexOf(option()!.defaultVariant!))}><Icon name="reset" /></button></Show><button type="button" aria-label="Close model picker" onClick={() => close(true)}><Icon name="close" /></button></div></div>
          <Show when={stops().length}><div class="model-control__slider" role="slider" tabindex="0" aria-label="Reasoning effort" aria-valuemin="0" aria-valuemax={stops().length - 1} aria-valuenow={selectedIndex()} aria-valuetext={stops()[selectedIndex()]} onKeyDown={(event) => {
            const next = event.key === "Home" ? 0 : event.key === "End" ? stops().length - 1 : event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp" ? Math.min(stops().length - 1, selectedIndex() + 1) : event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown" ? Math.max(0, selectedIndex() - 1) : undefined
            if (next === undefined) return
            event.preventDefault()
            chooseVariant(next)
          }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDrag({ pointerID:event.pointerId, fraction:pointerFraction(event) }) }} onPointerMove={(event) => { if (drag()?.pointerID === event.pointerId) setDrag({ pointerID:event.pointerId, fraction:pointerFraction(event) }) }} onPointerUp={(event) => { if (drag()?.pointerID !== event.pointerId) return; const next = Math.round(pointerFraction(event) * (stops().length - 1)); setDrag(undefined); chooseVariant(next) }} onPointerCancel={(event) => { if (drag()?.pointerID === event.pointerId) setDrag(undefined) }} onLostPointerCapture={(event) => { if (drag()?.pointerID === event.pointerId) setDrag(undefined) }}>
            <div class="model-control__track"><div class="model-control__fill" style={{ width: `${fraction() * 100}%` }} /><div class="model-control__sparkles" aria-hidden="true" /><div class="model-control__stops"><For each={stops()}>{(_, index) => <span classList={{ "model-control__stop--active": index() <= selectedIndex() }} />}</For></div><span class="model-control__thumb" style={{ left: `${fraction() * 100}%` }} /></div>
            <div class="model-control__labels"><For each={stops()}>{(variant) => <span>{variant}</span>}</For></div>
          </div></Show>
        </Show>
        <Show when={listing()}><input ref={search} class="mini-picker__search" type="search" aria-label="Search models" placeholder="Search models…" value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setActive(0) }} /><div class="mini-picker__list" role="listbox" aria-label="Models"><For each={models()}>{(item, index) => <><Show when={index() === 0 || models()[index() - 1]?.providerID !== item.providerID}><div class="mini-picker__group model-control__provider" role="presentation">{item.providerName ?? item.providerID}</div></Show><button type="button" role="option" aria-selected={props.selected?.providerID === item.providerID && props.selected?.id === item.id} class="mini-picker__option model-control__model" classList={{ "mini-picker__option--active": active() === index() }} onPointerEnter={() => setActive(index())} onClick={() => chooseModel(item)}>{item.name}<small>{item.id}</small></button></>}</For><Show when={!models().length}><p class="mini-picker__empty">No matches</p></Show></div></Show>
      </div>
    </Portal></Show>
  </div>
}
