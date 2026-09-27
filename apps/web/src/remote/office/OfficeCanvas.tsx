import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { OfficePreferences, OfficeSnapshot } from "./types"
import type { OfficeHandle } from "./create-game"
import "./office.css"

export function OfficeCanvas(props: {
  readonly snapshot: OfficeSnapshot
  readonly preferences: OfficePreferences
  readonly onSelectSession: (id: string) => void
  readonly onNormalView: () => void
}) {
  let host!: HTMLDivElement
  let handle: OfficeHandle | undefined
  let disposed = false
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const query = window.matchMedia("(prefers-reduced-motion: reduce)")
  const [systemReduced, setSystemReduced] = createSignal(query.matches)
  const change = (event: MediaQueryListEvent) => setSystemReduced(event.matches)
  query.addEventListener("change", change)
  const input = () => ({ snapshot: props.snapshot, preferences: props.preferences, systemReduced: systemReduced() })
  createEffect(() => {
    const current = input()
    handle?.update(current)
  })
  onMount(() => {
    void import("./create-game").then(({ mountOffice }) => {
      if (disposed) return
      handle = mountOffice(host, input(), props.onSelectSession, setError)
      handle.update(input())
      setLoading(false)
    }).catch(() => {
      if (!disposed) { setError("The office could not start. Your normal workspace is still available."); setLoading(false) }
    })
  })
  onCleanup(() => {
    disposed = true
    query.removeEventListener("change", change)
    handle?.destroy()
    handle = undefined
  })
  return <section class="office-stage" aria-label="Office visualization">
    <div class="office-camera-controls" aria-label="Office camera">
      <button type="button" onClick={() => handle?.zoomBy(1.25)} aria-label="Zoom in">+</button>
      <button type="button" onClick={() => handle?.zoomBy(0.8)} aria-label="Zoom out">−</button>
      <button type="button" onClick={() => handle?.fit()}>Fit office</button>
      <button type="button" onClick={() => handle?.follow()}>Follow selected</button>
      <button type="button" onClick={props.onNormalView}>Normal view</button>
    </div>
    <Show when={loading()}><p class="office-notice" role="status">Loading the office renderer…</p></Show>
    <Show when={error()}>{(message) => <p class="office-notice" role="alert">{message()} <button type="button" onClick={props.onNormalView}>Use normal view</button></p>}</Show>
    <div ref={host} class="office-canvas-host" aria-hidden="true" />
  </section>
}
