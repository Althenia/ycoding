import { createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Icon } from "./icon"

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
  readonly label: string
  readonly header?: JSX.Element
  readonly returnFocus?: HTMLElement
  readonly onClose: () => void
  readonly onDismiss?: () => void
  readonly requestClose?: (close: () => void) => void
  readonly children: JSX.Element
}) {
  const [closing, setClosing] = createSignal(false)
  let element: HTMLDialogElement | undefined
  let returnFocus: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = () => {
    if (closing()) return
    setClosing(true)
    if (element?.open) element.close()
    props.onDismiss?.()
    returnFocus?.focus()
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      props.onClose()
      return
    }
    timer = setTimeout(props.onClose, parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--yc-dur-base")))
  }
  onMount(() => {
    returnFocus = props.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    element?.showModal()
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
      aria-hidden={closing() ? "true" : undefined}
      inert={closing()}
      data-closing={closing() ? "" : undefined}
      onClose={() => { if (!closing()) close() }}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close() }}
      onKeyDown={(event) => {
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
      <div class="overlay__surface">
        <div class="overlay__head">
          {props.header ?? <span class="overlay__title">{props.label}</span>}
          <button
            type="button"
            class="button button--ghost button--icon overlay__close"
            aria-label={`Close ${props.label}`}
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
