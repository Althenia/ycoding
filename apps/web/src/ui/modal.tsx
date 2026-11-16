import { createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Icon } from "./icon"
import { visualViewportFrame, watchVisualViewport } from "./visual-viewport"
import "./button.css"
import "./modal.css"

/**
 * Native modal dialog: one primitive, three presentations.
 *
 * `showModal()` requires a connected element that is not already open, so the call
 * happens in `onMount` and the `open` attribute is never set in markup. The element
 * is the `.overlay` root; the surface, head, close control, and body are rendered
 * here so every consumer gets the same label, dismissal, and scroll containment.
 *
 * The `class` prop names the presentation; the base is a dialog at 768 and above and
 * a sheet below it, and each modifier changes motion or geometry only:
 * `overlay--dialog` fades and scales, `overlay--sheet` rises from the block-end edge,
 * `overlay--slideover` enters from the inline-end edge.
 *
 * Closing (Escape, a scrim click the browser maps to cancel, or the close control)
 * reports back to the owner, which unmounts this component.
 */
export function Modal(props: {
  readonly class?: string
  readonly surfaceStyle?: JSX.CSSProperties
  readonly label: string
  readonly header?: JSX.Element
  readonly returnFocus: HTMLElement
  readonly pointerOpened?: boolean
  readonly onClose: () => void
  readonly onDismiss?: () => void
  readonly requestClose?: (close: () => void) => void
  readonly children: JSX.Element
}) {
  const [closing, setClosing] = createSignal(false)
  const [pointerFocus, setPointerFocus] = createSignal(props.pointerOpened === true)
  let element: HTMLDialogElement | undefined
  let surface: HTMLDivElement | undefined
  let gesture: { readonly x: number; readonly y: number; readonly drawer: boolean } | undefined
  let scrimPointer: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const [frame, setFrame] = createSignal<ReturnType<typeof visualViewportFrame>>()
  const close = () => {
    if (closing()) return
    setClosing(true)
    if (element?.open) element.close()
    props.onDismiss?.()
    props.returnFocus.focus({ preventScroll: true })
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      props.onClose()
      return
    }
    timer = setTimeout(props.onClose, parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--yc-dur-base")))
  }
  onMount(() => {
    onCleanup(watchVisualViewport((viewport) => setFrame(visualViewportFrame(viewport))))
    element?.showModal()
    queueMicrotask(() => {
      if (!element?.open || element.contains(document.activeElement)) return
      const control = element.querySelector<HTMLElement>('[autofocus]:not([disabled])')
        ?? element.querySelector<HTMLElement>('input[type="radio"]:checked:not([disabled])')
        ?? element.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])')
      control?.focus({ preventScroll: true })
    })
    props.requestClose?.(close)
  })
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
    if (element?.open) element.close()
  })
  return (
    <dialog
      ref={element}
      class={`overlay${props.class ? ` ${props.class}` : ""}`}
      aria-label={props.label}
      aria-modal="true"
      aria-hidden={closing() ? "true" : undefined}
      inert={closing()}
      data-closing={closing() ? "" : undefined}
      onClose={() => { if (!closing()) close() }}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close() }}
      onPointerDown={(event) => {
        setPointerFocus(true)
        if (event.target === element) scrimPointer = event.pointerId
      }}
      onPointerUp={(event) => {
        const outside = scrimPointer === event.pointerId && event.target === element
        scrimPointer = undefined
        if (!outside || !surface) return
        const box = surface.getBoundingClientRect()
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close()
      }}
      onPointerCancel={() => { scrimPointer = undefined }}
      onTouchStart={(event) => {
        gesture = undefined
        if (event.touches.length !== 1 || !(event.target instanceof Element) || !window.matchMedia("(max-width: 767px), (max-height: 599px) and (pointer: coarse)").matches) return
        const drawer = element?.classList.contains("overlay--sessions-sheet") === true
        const touch = event.touches[0]!
        const handle = event.target === surface && surface && getComputedStyle(surface, "::before").content === '""' && touch.clientY <= surface.getBoundingClientRect().top + parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--yc-hit-min"))
        if (!drawer && ((!handle && !event.target.closest(".overlay__head")) || event.target.closest("button, a, input, select, textarea"))) return
        gesture = { x: touch.clientX, y: touch.clientY, drawer }
      }}
      onTouchCancel={() => { gesture = undefined }}
      onTouchEnd={(event) => {
        const start = gesture
        gesture = undefined
        const touch = event.changedTouches[0]
        if (!start || !touch || event.touches.length) return
        const dx = touch.clientX - start.x
        const dy = touch.clientY - start.y
        if (start.drawer ? dx < -48 && Math.abs(dx) > Math.abs(dy) * 1.5 : dy > 48 && dy > Math.abs(dx) * 1.5) close()
      }}
      onKeyDown={(event) => {
        setPointerFocus(false)
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return }
        if (event.key !== "Tab") return
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )].filter((control) => control.getClientRects().length > 0)
        const next = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1)
          : !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : undefined
        if (!next) return
        event.preventDefault()
        next.focus()
      }}
    >
      <div ref={surface} class="overlay__surface" style={{ "--overlay-viewport-top": frame() ? `${frame()!.top}px` : undefined, "--overlay-viewport-height": frame() ? `${frame()!.height}px` : undefined, ...props.surfaceStyle }}>
        <div class="overlay__head">
          {props.header ?? <span class="overlay__title">{props.label}</span>}
          <button
            type="button"
            class="button button--ghost button--icon overlay__close"
            aria-label={`Close ${props.label}`}
            data-pointer-focus={pointerFocus() ? "" : undefined}
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="overlay__body">{props.children}</div>
      </div>
    </dialog>
  )
}
