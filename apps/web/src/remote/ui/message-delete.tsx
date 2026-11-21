import { createEffect, createSignal, createUniqueId, onCleanup, Show } from "solid-js"
import { Icon } from "../../ui/icon"
import "./message-delete.css"

export function MessageDelete(props: { readonly eligible: boolean; readonly onDelete: () => Promise<string | undefined> }) {
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let root!: HTMLDivElement
  let trigger: HTMLButtonElement | undefined
  createEffect(() => {
    if (!open()) return
    const dismiss = (event: PointerEvent) => { if (!event.composedPath().includes(root)) setOpen(false) }
    document.addEventListener("pointerdown", dismiss)
    onCleanup(() => document.removeEventListener("pointerdown", dismiss))
  })
  const remove = async () => {
    setBusy(true)
    setOpen(false)
    try {
      setError(await props.onDelete())
    } finally {
      setBusy(false)
    }
  }
  return <div class="message-delete" ref={root} onKeyDown={(event) => {
    if (event.key !== "Escape" || !open()) return
    event.stopPropagation()
    setOpen(false)
    trigger?.focus()
  }}>
    <Show when={props.eligible || open()}>
      <button ref={trigger} type="button" class="message-delete__menu-button" aria-label="Message actions" aria-expanded={open()} aria-controls={open() ? id : undefined} disabled={busy()} onClick={() => { setError(undefined); setOpen(!open()) }}><Icon name="more" size={16} /></button>
    </Show>
    <Show when={open()}>
      <div id={id} class="message-delete__menu"><button type="button" onClick={() => void remove()}><Icon name="trash" size={16} />Delete</button></div>
    </Show>
    <Show when={error()}>{(message) => <span class="message-delete__error" role="alert">{message()}</span>}</Show>
  </div>
}
