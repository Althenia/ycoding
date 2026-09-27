import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useRemote } from "../context"
import { sessionStatusLabel, sessionStatusTimed } from "../projection"
import { DotTrail } from "./dot-trail"
import "./status-bar.css"

export function SessionStatusBar() {
  const remote = useRemote()
  const [now, setNow] = createSignal(Date.now())
  const view = () => remote.state().view
  const current = () => {
    const selected = view()
    if (!selected) return undefined
    const running = remote.state().sessionStatus?.running.has(selected.id) ?? remote.state().selectedSessionInfo?.running ?? false
    return running && selected.status === "idle" ? { ...selected, status: "running" as const } : selected
  }
  const waiting = () => remote.state().team?.tasks.filter((task) => task.state === "starting" || task.state === "running" || task.state === "waiting").length ?? 0
  const timed = () => current() !== undefined && sessionStatusTimed(current()!, waiting())
  createEffect(() => {
    if (!timed()) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    onCleanup(() => clearInterval(timer))
  })
  const goal = () => view()?.autonomy?.goal
  return <Show when={current() && (current()?.status === "running" || current()?.autonomy?.mode !== "normal" && current()?.autonomy !== undefined)}>
    <aside class="session-status" role="status" aria-label="Session status">
      <div class="session-status__operation"><Show when={timed()}><DotTrail /></Show><For each={sessionStatusLabel(current()!, now(), waiting()).split(" · ")}>{(segment) => <span class={`session-status__chip${/awaiting input|failed|provider error/i.test(segment) ? " session-status__chip--attention" : ""}`}>{segment}</span>}</For></div>
      <Show when={goal()}>{(current) => <div class="session-status__goal"><details><summary title={current().text}>{current().text}</summary><p>{current().text}</p></details><span>{current().status} · iteration {current().iteration} · no progress {current().noProgress}/{current().maxNoProgress}</span><Show when={current().status === "active"}><button type="button" onClick={() => void remote.store.stopGoal()}>Stop goal</button></Show></div>}</Show>
    </aside>
  </Show>
}
