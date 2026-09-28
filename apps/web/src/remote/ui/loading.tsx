import { createSignal, onCleanup, onMount, type JSX } from "solid-js"
import "./loading.css"

export function LoadingPlaceholder(props: {
  readonly kind: "session" | "conversation" | "history" | "image" | "repository" | "usage" | "chart" | "office" | "team" | "output" | "screen"
  readonly label: string
  readonly announce?: boolean
}): JSX.Element {
  const [visible, setVisible] = createSignal(false)
  onMount(() => {
    const timer = setTimeout(() => setVisible(true), 140)
    onCleanup(() => clearTimeout(timer))
  })
  return <div class={`loading-placeholder loading-placeholder--${props.kind}`} role={props.announce === false ? undefined : "status"} aria-hidden={props.announce === false ? "true" : undefined} style={{ visibility: visible() ? "visible" : "hidden" }}>
    <span class="visually-hidden">{props.label}</span>
    <span class="loading-placeholder__shape" aria-hidden="true">
      <span class="loading-placeholder__bar" />
      <span class="loading-placeholder__bar" />
      <span class="loading-placeholder__bar" />
    </span>
  </div>
}
