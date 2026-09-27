import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"

export type PickerOption = { readonly value: string; readonly label: string; readonly detail?: string; readonly group?: string }

export function ComposerPicker(props: {
  readonly label: string
  readonly value?: string
  readonly placeholder: string
  readonly options: readonly PickerOption[]
  readonly disabled?: boolean
  readonly searchable?: boolean
  readonly onChange: (value: string) => void
}): JSX.Element {
  const id = `composer-picker-${crypto.randomUUID()}`
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [compact, setCompact] = createSignal(false)
  const [position, setPosition] = createSignal({ left: 0, top: 0, width: 280 })
  const filtered = () => props.options.filter((option) => `${option.label} ${option.detail ?? ""} ${option.group ?? ""}`.toLocaleLowerCase().includes(query().toLocaleLowerCase()))
  let trigger: HTMLButtonElement | undefined
  let surface: HTMLDivElement | undefined
  let searchInput: HTMLInputElement | undefined

  const close = (focus = false) => {
    setOpen(false)
    setQuery("")
    if (focus) queueMicrotask(() => trigger?.focus())
  }
  const choose = (index: number) => {
    const option = filtered()[index]
    if (!option) return
    props.onChange(option.value)
    close(true)
  }
  const move = (delta: number) => {
    if (!filtered().length) return
    setActive((active() + delta + filtered().length) % filtered().length)
  }
  const keys: JSX.EventHandler<HTMLElement, KeyboardEvent> = (event) => {
    if (event.key === "Escape") {
      if (!open()) return
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!open()) setOpen(true)
      move(event.key === "ArrowDown" ? 1 : -1)
      return
    }
    if (event.key === "Enter" && open()) {
      event.preventDefault()
      choose(active())
    }
  }
  const reposition = () => {
    if (!open() || compact() || !trigger || !surface) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16)
    setPosition({ left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8), top: Math.max(8, rect.top - surface.offsetHeight - 8), width })
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
    if (open()) queueMicrotask(() => { reposition(); searchInput?.focus() })
  })
  return <div class="mini-picker">
    <button ref={trigger} type="button" class="mini-picker__trigger" role="combobox" aria-label={props.label} aria-haspopup="listbox" aria-expanded={open()} aria-controls={`${id}-list`} aria-activedescendant={open() && !props.searchable && filtered().length ? `${id}-${active()}` : undefined} disabled={props.disabled} onKeyDown={keys} onClick={() => { setActive(Math.max(0, filtered().findIndex((option) => option.value === props.value))); setOpen(!open()) }}>
      <span>{props.options.find((option) => option.value === props.value)?.label ?? props.placeholder}</span><span aria-hidden="true">⌄</span>
    </button>
    <Show when={open()}><Portal>
      <Show when={compact()}><div class="mini-picker__scrim" onClick={() => close()} /></Show>
      <div ref={surface} class={`mini-picker__surface${compact() ? " mini-picker__surface--sheet" : ""}`} style={compact() ? undefined : { left: `${position().left}px`, top: `${position().top}px`, width: `${position().width}px` }} onKeyDown={keys}>
        <div class="mini-picker__heading"><strong>{props.label}</strong><button type="button" aria-label={`Close ${props.label}`} onClick={() => close(true)}>×</button></div>
        <Show when={props.searchable}><input ref={searchInput} class="mini-picker__search" type="search" role="combobox" aria-label={`Search ${props.label}`} aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={filtered().length ? `${id}-${active()}` : undefined} placeholder="Search models…" value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setActive(0) }} /></Show>
        <div id={`${id}-list`} role="listbox" aria-label={props.label} aria-activedescendant={filtered().length ? `${id}-${active()}` : undefined} class="mini-picker__list">
          <For each={filtered()}>{(option, index) => <>
            <Show when={option.group && (index() === 0 || filtered()[index() - 1]?.group !== option.group)}><div class="mini-picker__group" role="presentation">{option.group}</div></Show>
            <button id={`${id}-${index()}`} class="mini-picker__option" classList={{ "mini-picker__option--active": index() === active() }} type="button" role="option" aria-selected={props.value === option.value} onPointerEnter={() => setActive(index())} onClick={() => choose(index())}>
              <span>{option.label}</span><Show when={option.detail}><small>{option.detail}</small></Show>
            </button>
          </>}</For>
          <Show when={!filtered().length}><p class="mini-picker__empty">No matches</p></Show>
        </div>
      </div>
    </Portal></Show>
  </div>
}
