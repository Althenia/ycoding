import { createSignal, onCleanup, type JSX } from "solid-js"
import { createToastTimer, toastDuration, toastExit } from "./toast-timer"

export const maxToasts = 3

export function Toast(props: {
  readonly class: string
  readonly role?: "status" | "alert"
  readonly onDismiss: () => void
  readonly children: (dismiss: () => void) => JSX.Element
}): JSX.Element {
  const [state, setState] = createSignal({ paused: false, leaving: false })
  let root: HTMLDivElement | undefined
  const timer = createToastTimer({ duration: toastDuration, exit: toastExit, onChange: setState, onDone: () => props.onDismiss() })
  onCleanup(timer.dispose)
  return (
    <div ref={root} class={`yc-toast ${props.class}`} classList={{ "yc-toast--paused": state().paused, "yc-toast--leaving": state().leaving }} role={props.role} onMouseEnter={timer.pause} onMouseLeave={() => { if (!root?.contains(document.activeElement)) timer.resume() }} onFocusIn={timer.pause} onFocusOut={(event) => { if (!(event.relatedTarget instanceof Node) || !root?.contains(event.relatedTarget)) timer.resume() }}>
      {props.children(timer.dismiss)}
      <span class="yc-toast__progress" aria-hidden="true" />
    </div>
  )
}
