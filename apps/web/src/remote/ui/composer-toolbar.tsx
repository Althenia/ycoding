import { createEffect, createSignal, createUniqueId, onCleanup, onMount, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import "./composer-toolbar.css"

export function revealComposerControls(control: HTMLElement | undefined) {
  control?.dispatchEvent(new Event("reveal-composer-controls", { bubbles: true }))
}

export function ComposerToolbar(props: { class?: string; compact?: boolean; leading: JSX.Element; children: JSX.Element; trailing: JSX.Element }) {
  const id = createUniqueId()
  const [compact, setCompact] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  let bar!: HTMLDivElement
  let leading!: HTMLDivElement
  let trailing!: HTMLDivElement
  let panel!: HTMLDivElement
  let items!: HTMLDivElement
  let trigger!: HTMLButtonElement
  const controls = () => [...items.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(button =>
    button.getClientRects().length > 0 && getComputedStyle(button).visibility === "visible" && !button.closest('[inert]') && button.closest('[role="dialog"], [role="menu"], [role="listbox"]') === panel)
  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) trigger.focus({ preventScroll: true })
  }
  const fit = () => {
    const width = bar.getBoundingClientRect().width
    if (!width) return
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0
    const itemGap = parseFloat(getComputedStyle(items).columnGap) || 0
    items.dataset.measuring = "true"
    const widths = [...items.children].flatMap(item => item.getClientRects().length && getComputedStyle(item).position !== "absolute" ? [item.getBoundingClientRect().width] : [])
    delete items.dataset.measuring
    const required = leading.getBoundingClientRect().width + trailing.getBoundingClientRect().width + 2 * gap + widths.reduce((sum, value) => sum + value, itemGap * Math.max(0, widths.length - 1))
    const next = !!props.compact || required > width + 0.5
    if (compact() !== next) {
      const focus = document.activeElement
      setOpen(next && panel.contains(focus))
      setCompact(next)
      if (!next && focus === trigger) queueMicrotask(() => (controls()[0] ?? leading.querySelector('button'))?.focus({ preventScroll: true }))
    }
    const viewportTop = window.visualViewport?.offsetTop ?? 0
    const barTop = bar.getBoundingClientRect().top
    const frameTop = bar.closest('[data-composer-frame]')?.getBoundingClientRect().top ?? barTop
    const top = frameTop - viewportTop >= 160 ? frameTop : barTop
    panel.style.setProperty("--composer-toolbar-rise", `${barTop - top}px`)
    panel.style.setProperty("--composer-toolbar-room", `${Math.max(0, top - viewportTop - 16)}px`)
  }
  onMount(() => {
    let frame: number | undefined
    const schedule = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => { frame = undefined; fit() })
    }
    const observer = new ResizeObserver(schedule)
    const observe = () => {
      observer.disconnect()
      for (const box of [bar, leading, trailing, items, ...items.children]) observer.observe(box)
      schedule()
    }
    const mutations = new MutationObserver(observe)
    mutations.observe(items, { childList: true })
    const reveal = () => { if (compact()) { fit(); setOpen(true) } }
    const dismiss = (event: PointerEvent) => {
      if (open() && event.target instanceof Element && !bar.contains(event.target) && !panel.querySelector('[aria-expanded="true"]') && !event.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) close(false)
    }
    bar.addEventListener("reveal-composer-controls", reveal)
    document.addEventListener("pointerdown", dismiss)
    window.visualViewport?.addEventListener("resize", schedule)
    window.visualViewport?.addEventListener("scroll", schedule)
    createEffect(() => { void props.compact; schedule() })
    observe()
    onCleanup(() => {
      observer.disconnect()
      mutations.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      bar.removeEventListener("reveal-composer-controls", reveal)
      document.removeEventListener("pointerdown", dismiss)
      window.visualViewport?.removeEventListener("resize", schedule)
      window.visualViewport?.removeEventListener("scroll", schedule)
    })
  })
  const keyboard: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = event => {
    if (!compact() || !open() || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    const focus = document.activeElement
    const layer = focus?.closest('[role="dialog"], [role="menu"], [role="listbox"]')
    if (layer && layer !== panel) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && focus instanceof HTMLButtonElement) {
      const actions = controls()
      const at = actions.indexOf(focus)
      if (at < 0) return
      event.preventDefault()
      actions[(at + (event.key === "ArrowDown" ? 1 : actions.length - 1)) % actions.length]?.focus()
    }
  }
  return <div ref={bar} class={`composer-toolbar${props.class ? ` ${props.class}` : ""}`} data-overflow={compact() ? "true" : undefined} onKeyDown={keyboard}>
    <div ref={leading} class="composer-toolbar__leading">{props.leading}</div>
    <button ref={trigger} type="button" class="composer-toolbar__more" aria-label="More composer controls" aria-haspopup="dialog" aria-expanded={open()} aria-controls={id} hidden={!compact()} onClick={() => {
      if (open()) return close(true)
      fit()
      setOpen(true)
      queueMicrotask(() => (controls()[0] ?? panel).focus({ preventScroll: true }))
    }}><Icon name="settings" size={16} /><span>Controls</span><Icon name="chevron-down" size={16} /></button>
    <div ref={panel} id={id} class="composer-toolbar__secondary" role={compact() ? "dialog" : undefined} aria-label={compact() ? "Composer controls" : undefined} tabindex={compact() ? -1 : undefined} data-open={open() ? "true" : undefined} inert={compact() && !open()}>
      <div ref={items} class="composer-toolbar__items">{props.children}</div>
    </div>
    <div ref={trailing} class="composer-toolbar__trailing">{props.trailing}</div>
  </div>
}
