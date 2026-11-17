import { children, createEffect, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"

export function useCompact(query = "(max-width: 700px)", beforeChange?: () => void) {
  const media = window.matchMedia(query)
  const [compact, setCompact] = createSignal(media.matches)
  const update = () => { beforeChange?.(); setCompact(media.matches) }
  media.addEventListener("change", update)
  onCleanup(() => media.removeEventListener("change", update))
  return compact
}

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

export function createCompactInspector() {
  const [open, setOpen] = createSignal(false)
  let opener: HTMLElement | undefined
  return {
    open,
    show: () => { opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined; setOpen(true) },
    close: () => { setOpen(false); queueMicrotask(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }) }) },
  }
}

export function containDialogFocus(event: KeyboardEvent, element: HTMLElement) {
  if (event.key !== "Tab") return
  const controls = [...element.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(control => control.getClientRects().length > 0 && !control.closest('[inert]'))
  const next = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1) : !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : undefined
  if (!next) return
  event.preventDefault()
  next.focus({ preventScroll: true })
}

export function swipeDismiss(close: () => void, direction: "left" | "down") {
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
      if (direction === "left" ? x < -64 && Math.abs(y) < -x / 2 : y > 64 && Math.abs(x) < y / 2) close()
    },
    onTouchCancel: () => { start = undefined },
  }
}

export function ResponsiveLayer(props: { class: string; label: string; id?: string; mode?: "sheet" | "drawer" | "panel"; shown?: boolean; full?: boolean; level?: string; role?: "dialog" | "listbox" | "menu" | "complementary"; onClose: () => void; onKeyDown?: JSX.EventHandler<HTMLDialogElement, KeyboardEvent>; children: JSX.Element }) {
  const content = children(() => props.children)
  const [host, setHost] = createSignal<HTMLElement>()
  let resizedFocus: HTMLElement | undefined
  const compact = useCompact(props.mode === "drawer" || props.mode === "panel" ? "(max-width: 700px)" : "(max-width: 700px), (pointer: coarse)", () => {
    const element = host()
    resizedFocus = element?.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    if (element instanceof HTMLDialogElement) element.close()
  })
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
    if (compact() && element instanceof HTMLDialogElement) {
      if (props.shown === false) { element.close(); restore(); return }
      if (element.matches(":modal")) return
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      element.showModal()
    }
    const focus = resizedFocus
    resizedFocus = undefined
    if (focus) queueMicrotask(() => { if (element.contains(focus)) focus.focus({ preventScroll: true }) })
  }))
  onCleanup(() => { const element = host(); const modal = element?.matches(":modal"); if (element instanceof HTMLDialogElement) element.close(); if (modal) queueMicrotask(restore) })
  const drawerSwipe = swipeDismiss(props.onClose, "left")
  const sheetSwipe = swipeDismiss(props.onClose, "down")
  return <Dynamic component={compact() ? "dialog" : props.mode === "drawer" || props.mode === "panel" ? "aside" : "div"} ref={setHost} id={props.id} class={props.class} data-responsive-layer data-compact={compact() ? "true" : undefined} data-mode={props.mode ?? "sheet"} data-full={props.full ? "true" : undefined} data-level={props.level} role={compact() ? "dialog" : props.role} aria-label={props.label} onKeyDown={(event: KeyboardEvent & { currentTarget: HTMLDialogElement; target: Element }) => { if (compact()) containDialogFocus(event, host()!); props.onKeyDown?.(event) }}
    onCancel={(event: Event) => { event.preventDefault(); props.onClose() }}
    onPointerDown={(event: PointerEvent) => { backdropDown = compact() && event.target === host() && outside(event) }}
    onPointerUp={(event: PointerEvent) => { if (backdropDown && event.target === host() && outside(event)) props.onClose(); backdropDown = false }}
    onTouchStart={(event: TouchEvent) => { if (props.mode === "drawer") drawerSwipe.onTouchStart(event) }}
    onTouchEnd={(event: TouchEvent) => { if (props.mode === "drawer") drawerSwipe.onTouchEnd(event) }} onTouchCancel={drawerSwipe.onTouchCancel}>
    <Show when={compact() && props.mode !== "drawer"}><button type="button" class="compact-layer__handle" aria-label={`Close ${props.label}`} onClick={props.onClose} {...sheetSwipe}><span aria-hidden="true" /></button></Show>
    {content()}
  </Dynamic>
}
