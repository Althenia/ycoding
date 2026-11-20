import { children, createEffect, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"

export function watchDesktopViewport() {
  const update = () => {
    const viewport = window.visualViewport
    const height = viewport?.height ?? window.innerHeight
    const top = viewport?.offsetTop ?? 0
    document.documentElement.style.setProperty("--desktop-viewport-height", `${height}px`)
    document.documentElement.style.setProperty("--desktop-viewport-top", `${top}px`)
    document.documentElement.style.setProperty("--desktop-viewport-bottom", `${Math.max(0, window.innerHeight - height - top)}px`)
  }
  update()
  window.addEventListener("resize", update)
  window.visualViewport?.addEventListener("resize", update)
  window.visualViewport?.addEventListener("scroll", update)
  onCleanup(() => {
    window.removeEventListener("resize", update)
    window.visualViewport?.removeEventListener("resize", update)
    window.visualViewport?.removeEventListener("scroll", update)
  })
}

export function containDialogFocus(event: KeyboardEvent, element: HTMLElement) {
  if (event.key !== "Tab") return
  const controls = [...element.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(control => control.getClientRects().length > 0 && !control.closest('[inert]'))
  const next = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1) : !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : undefined
  if (!next) return
  event.preventDefault()
  next.focus({ preventScroll: true })
}

export function swipeDismiss(close: () => void) {
  let start: { x: number; y: number } | undefined
  return {
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0]
      if (touch && !(event.target instanceof Element && event.target.closest("input,textarea"))) start = { x: touch.clientX, y: touch.clientY }
    },
    onTouchEnd: (event: TouchEvent) => {
      const touch = event.changedTouches[0]
      const from = start
      start = undefined
      if (!touch || !from) return
      const x = touch.clientX - from.x, y = touch.clientY - from.y
      if (y > 64 && Math.abs(x) < y / 2) close()
    },
    onTouchCancel: () => { start = undefined },
  }
}

export function ResponsiveLayer(props: { class: string; label: string; level?: string; role?: "dialog" | "listbox" | "menu"; onClose: () => void; onKeyDown?: JSX.EventHandler<HTMLDialogElement, KeyboardEvent>; children: JSX.Element }) {
  const content = children(() => props.children)
  const [host, setHost] = createSignal<HTMLElement>()
  let resizedFocus: HTMLElement | undefined
  const coarse = window.matchMedia("(pointer: coarse)")
  const [compact, setCompact] = createSignal(coarse.matches)
  const resize = () => {
    const element = host()
    resizedFocus = element?.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    if (element instanceof HTMLDialogElement) element.close()
    setCompact(coarse.matches)
  }
  coarse.addEventListener("change", resize)
  onCleanup(() => coarse.removeEventListener("change", resize))
  let opener: HTMLElement | undefined
  let backdropDown = false
  const outside = (event: PointerEvent) => {
    const rect = host()!.getBoundingClientRect()
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
  }
  const restore = () => { if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  onMount(() => createEffect(() => {
    const element = host()
    if (!element) return
    if (compact() && element instanceof HTMLDialogElement && !element.matches(":modal")) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      element.showModal()
    }
    const focus = resizedFocus
    resizedFocus = undefined
    if (focus) queueMicrotask(() => { if (element.contains(focus)) focus.focus({ preventScroll: true }) })
  }))
  onCleanup(() => { const element = host(); const modal = element?.matches(":modal"); if (element instanceof HTMLDialogElement) element.close(); if (modal) queueMicrotask(restore) })
  const sheetSwipe = swipeDismiss(props.onClose)
  return <Dynamic component={compact() ? "dialog" : "div"} ref={setHost} class={props.class} data-responsive-layer data-compact={compact() ? "true" : undefined} data-level={props.level} role={compact() ? "dialog" : props.role} aria-label={props.label} onKeyDown={(event: KeyboardEvent & { currentTarget: HTMLDialogElement; target: Element }) => { if (compact()) containDialogFocus(event, host()!); props.onKeyDown?.(event) }}
    onCancel={(event: Event) => { event.preventDefault(); props.onClose() }}
    onPointerDown={(event: PointerEvent) => { backdropDown = compact() && event.target === host() && outside(event) }}
    onPointerUp={(event: PointerEvent) => { if (backdropDown && event.target === host() && outside(event)) props.onClose(); backdropDown = false }}>
    <Show when={compact()}><button type="button" class="compact-layer__handle" aria-label={`Close ${props.label}`} onClick={props.onClose} {...sheetSwipe}><span aria-hidden="true" /></button></Show>
    {content()}
  </Dynamic>
}
