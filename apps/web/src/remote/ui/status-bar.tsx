import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useRemote } from "../context"
import { sessionStatusLabel, sessionStatusTimed } from "../projection"
import { DotTrail } from "./dot-trail"
import "./status-bar.css"

export function ComposerStatus() {
  const remote = useRemote()
  const [now, setNow] = createSignal(Date.now())
  const [goalOpen, setGoalOpen] = createSignal(false)
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
  const label = () => current() ? sessionStatusLabel(current()!, now(), waiting()) : "ready"
  const elapsed = () => current()?.executionStarted === undefined ? "" : `${Math.floor(Math.max(0, now() - current()!.executionStarted!) / 60_000)}:${String(Math.floor(Math.max(0, now() - current()!.executionStarted!) / 1000) % 60).padStart(2, "0")}`
  const visible = () => current()?.status === "running" || current()?.status === "failed"
  const goal = () => view()?.autonomy?.goal
  const yolo = () => view()?.autonomy?.yolo ?? 0
  return <div class="session-status" role="status" aria-label="Session status">
    <span class="session-status__slot" classList={{ "session-status__slot--empty": !visible(), "session-status__slot--attention": /awaiting input|failed|provider error/i.test(label()) }}>
      <Show when={visible()}><Show when={timed()}><DotTrail /></Show><span class="session-status__label">{label().replace(/^(?:YOLO \d+(?: \+ Goal)?|Goal) · (?:auto-approve|autonomous) · /, "").replace(/\? awaiting input/i, "Waiting for your decision").replace(/cooking/i, "Running")}</span><span class="session-status__mobile" aria-hidden="true">{elapsed() || (/awaiting input/i.test(label()) ? "Wait" : label().split(" · ")[0])}</span></Show>
    </span>
    <Show when={yolo() > 0}><span class="session-status__yolo" title={`YOLO ${yolo()} · auto-approve`}>YOLO {yolo()}</span></Show>
    <Show when={goal()?.status === "active"}><div class="session-status__goal"><button type="button" class="session-status__goal-trigger" aria-expanded={goalOpen()} onClick={() => setGoalOpen(!goalOpen())}>Goal <span class="session-status__goal-count">{goal()?.iteration}</span></button><Show when={goalOpen()}><div class="session-status__goal-popover" role="dialog" aria-label="Goal details"><p>{goal()?.text}</p><span>{goal()?.status} · iteration {goal()?.iteration} · no progress {goal()?.noProgress}/{goal()?.maxNoProgress}</span><button type="button" onClick={() => { setGoalOpen(false); void remote.store.stopGoal() }}>Stop goal</button></div></Show></div></Show>
  </div>
}
