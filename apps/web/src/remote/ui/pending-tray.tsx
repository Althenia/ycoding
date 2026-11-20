import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js"
import { Icon } from "../../ui/icon"
import { useRemote } from "../context"
import { pendingTrayItems } from "../view-model"
import "./pending-tray.css"

export function PendingTray(): JSX.Element {
  const remote = useRemote()
  const items = createMemo(() => pendingTrayItems(
    remote.state().view?.messages ?? [],
    new Set(remote.state().mutations.filter((mutation) => mutation.kind === "prompt" || mutation.kind === "command").map((mutation) => mutation.id)),
  ))
  const [expanded, setExpanded] = createSignal(false)
  const [busy, setBusy] = createSignal<string>()
  const [note, setNote] = createSignal<string>()
  let clear: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(clear))
  const activeSessionID = remote.select((state) => state.activeSessionID)
  createEffect(on(activeSessionID, () => { setExpanded(false); setNote(undefined); setBusy(undefined) }, { defer: true }))
  const act = async (kind: "remove" | "steer", id: string) => {
    if (busy() !== undefined) return
    setBusy(id)
    setNote(undefined)
    clearTimeout(clear)
    const result = await remote.store.settlePendingInput(kind, id)
    setBusy(undefined)
    setNote(result)
    if (result !== undefined) clear = setTimeout(() => setNote(undefined), 6_000)
  }
  return <Show when={items().length > 0 || note() !== undefined}>
    <section class="pending-tray" aria-label="Pending messages" data-expanded={expanded() ? "true" : undefined}>
      <Show when={items().length > 0}>
        <button type="button" class="pending-tray__toggle" aria-expanded={expanded()} aria-controls="pending-tray-list" onClick={() => setExpanded(!expanded())}>
          <Icon name="queue" size={16} /><strong>{items().length} pending</strong>
          <Show when={!expanded()}><span class="pending-tray__preview">{items()[0]!.text}</span></Show>
          <Icon name={expanded() ? "chevron-down" : "chevron-up"} size={16} />
        </button>
        <Show when={expanded()}>
          <ol id="pending-tray-list" class="pending-tray__list">
            <For each={items().map((item) => item.id)}>{(id) => {
              const item = () => items().find((entry) => entry.id === id)
              return <Show when={item()}>{(entry) => <li class="pending-tray__item">
                <span class="pending-tray__text">{entry().text}</span>
                <button type="button" class="pending-tray__action" aria-label="Steer now" data-tooltip="Steer now" disabled={busy() !== undefined} onClick={() => void act("steer", id)}><Icon name="steer" size={16} /></button>
                <button type="button" class="pending-tray__action" aria-label="Remove pending message" data-tooltip="Remove pending message" disabled={busy() !== undefined} onClick={() => void act("remove", id)}><Icon name="close" size={16} /></button>
              </li>}</Show>
            }}</For>
          </ol>
        </Show>
      </Show>
      <Show when={note()}>{(text) => <p class="pending-tray__note" role="status">{text()}</p>}</Show>
    </section>
  </Show>
}
