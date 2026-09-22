import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import "./custom-select.css"

export type CustomSelectOption = {
  readonly value: string
  readonly label: string
  readonly detail?: string
  readonly badge?: string
}

export function CustomSelect(props: {
  readonly label: string
  readonly value?: string
  readonly placeholder: string
  readonly options: readonly CustomSelectOption[]
  readonly disabled?: boolean
  readonly class?: string
  readonly sheetTitle?: string
  readonly onOpen?: () => void
  readonly onChange: (value: string) => void
}): JSX.Element {
  const id = `custom-select-${crypto.randomUUID()}`
  const listboxID = `${id}-listbox`
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const [placement, setPlacement] = createSignal({ left: 0, top: 0, width: 260 })
  const selected = createMemo(() => props.options.findIndex((option) => option.value === props.value))
  const activeIndex = createMemo(() => Math.min(Math.max(active(), 0), Math.max(props.options.length - 1, 0)))
  let root: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  let surface: HTMLDivElement | undefined
  let typeahead = ""
  let typeaheadTimer: ReturnType<typeof setTimeout> | undefined

  const openMenu = () => {
    if (props.disabled || props.options.length === 0) return
    setActive(selected() < 0 ? 0 : selected())
    setOpen(true)
    queueMicrotask(positionSurface)
    props.onOpen?.()
  }
  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => trigger?.focus())
  }
  const choose = (index: number) => {
    const option = props.options[index]
    if (option === undefined) return
    props.onChange(option.value)
    closeMenu(true)
  }
  const move = (index: number) => {
    if (props.options.length === 0) return
    setActive((index + props.options.length) % props.options.length)
  }
  const onKeyDown: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (props.disabled) return
    if (event.key === "Escape" && open()) {
      event.preventDefault()
      closeMenu(true)
      return
    }
    if (event.key === "Tab" && open()) {
      closeMenu(false)
      return
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      if (open()) choose(activeIndex())
      else openMenu()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!open()) openMenu()
      move(activeIndex() + (event.key === "ArrowDown" ? 1 : -1))
      return
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      if (!open()) openMenu()
      move(event.key === "Home" ? 0 : props.options.length - 1)
      return
    }
    if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return
    typeahead += event.key.toLocaleLowerCase()
    if (typeaheadTimer !== undefined) clearTimeout(typeaheadTimer)
    typeaheadTimer = setTimeout(() => {
      typeahead = ""
    }, 500)
    const match = props.options.findIndex((option) => option.label.toLocaleLowerCase().startsWith(typeahead))
    if (match >= 0) {
      event.preventDefault()
      if (!open()) openMenu()
      move(match)
    }
  }

  onMount(() => {
    const outside = (event: PointerEvent) => {
      if (open() && event.target instanceof Node && !root?.contains(event.target) && !surface?.contains(event.target)) closeMenu(false)
    }
    document.addEventListener("pointerdown", outside)
    window.addEventListener("resize", positionSurface)
    window.addEventListener("scroll", positionSurface, true)
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside)
      window.removeEventListener("resize", positionSurface)
      window.removeEventListener("scroll", positionSurface, true)
    })
  })
  onCleanup(() => {
    if (typeaheadTimer !== undefined) clearTimeout(typeaheadTimer)
  })
  createEffect(() => {
    if (props.disabled && open()) closeMenu(false)
  })
  createEffect(() => {
    if (props.options.length === 0) return
    if (active() >= props.options.length) setActive(props.options.length - 1)
  })
  createEffect(() => {
    if (!open()) return
    document.getElementById(`${listboxID}-${activeIndex()}`)?.scrollIntoView({ block: "nearest" })
  })

  function positionSurface() {
    if (!open() || surface === undefined || root === undefined) return
    const rootRect = root.getBoundingClientRect()
    const surfaceRect = surface.getBoundingClientRect()
    const width = Math.min(Math.max(rootRect.width, 260), window.innerWidth - 16)
    setPlacement({
      left: Math.max(8, Math.min(rootRect.right - width, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(rootRect.bottom + 8, window.innerHeight - surfaceRect.height - 8)),
      width,
    })
  }

  const label = () => props.options.find((option) => option.value === props.value)?.label ?? props.placeholder
  return (
    <div ref={root} class={`custom-select${open() ? " custom-select--open" : ""}${props.class ? ` ${props.class}` : ""}`}>
      <button
        ref={trigger}
        id={id}
        type="button"
        class="custom-select__trigger"
        role="combobox"
        aria-label={props.label}
        aria-controls={listboxID}
        aria-expanded={open()}
        aria-haspopup="listbox"
        aria-activedescendant={open() ? `${listboxID}-${activeIndex()}` : undefined}
        disabled={props.disabled}
        onClick={() => (open() ? closeMenu(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span class="custom-select__value">{label()}</span>
        <span class="custom-select__chevron" aria-hidden="true">⌄</span>
      </button>
      <Show when={open()}>
        <Portal>
        <button class="custom-select__scrim" type="button" tabIndex={-1} aria-label={`Close ${props.label}`} onClick={() => closeMenu(true)} />
        <div ref={surface} class="custom-select__surface" style={{
          "--custom-select-left": `${placement().left}px`,
          "--custom-select-top": `${placement().top}px`,
          "--custom-select-width": `${placement().width}px`,
        }}>
          <div class="custom-select__sheet-head">
            <span>
              <strong>{props.sheetTitle ?? props.label}</strong>
              <small>Available options</small>
            </span>
            <button type="button" class="custom-select__close" aria-label={`Close ${props.label}`} onClick={() => closeMenu(true)}>×</button>
          </div>
          <div id={listboxID} class="custom-select__list" role="listbox" aria-labelledby={id}>
            <For each={props.options}>
              {(option, index) => (
                <button
                  id={`${listboxID}-${index()}`}
                  type="button"
                  class={`custom-select__option${index() === activeIndex() ? " custom-select__option--active" : ""}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={option.value === props.value}
                  onPointerEnter={() => setActive(index())}
                  onClick={() => choose(index())}
                >
                  <span class="custom-select__check" aria-hidden="true">{option.value === props.value ? "✓" : ""}</span>
                  <span class="custom-select__option-body">
                    <span>{option.label}</span>
                    <Show when={option.detail}>{(detail) => <small>{detail()}</small>}</Show>
                  </span>
                  <Show when={option.badge}>{(badge) => <span class="custom-select__badge">{badge()}</span>}</Show>
                </button>
              )}
            </For>
          </div>
        </div>
        </Portal>
      </Show>
    </div>
  )
}
