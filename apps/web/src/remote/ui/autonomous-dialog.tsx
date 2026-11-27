import { Show, createEffect, createSignal } from "solid-js"
import { Modal } from "../../ui/modal"
import { autonomyAnnouncement, autonomyChange, autonomyDefaultAnnouncement, autonomyDefaultChange, autonomyRows, requiresYoloConfirmation, type AutonomyIntent, type AutonomyModes } from "../autonomy"
import { useRemote } from "../context"
import { createRemoteQuery } from "../query"
import { AutonomousPanel } from "./autonomous-panel"

const [requests, setRequests] = createSignal(0)

export const autonomousDialogRequests = requests
export const requestAutonomousDialog = () => setRequests((count) => count + 1)

export function AutonomousDialog(props: { readonly returnFocus: HTMLElement; readonly onClose: () => void }) {
  const remote = useRemote()
  const [selected, setSelected] = createSignal(0)
  const [announcement, setAnnouncement] = createSignal("")
  const [pending, setPending] = createSignal<{ readonly target: "session" | "default"; readonly change: Partial<AutonomyModes> }>()
  const [savingDefault, setSavingDefault] = createSignal(false)
  const [defaultFailure, setDefaultFailure] = createSignal<string>()
  const sessionID = remote.state().view?.id
  let close: (() => void) | undefined
  const view = () => remote.state().view
  const autonomy = () => view()?.autonomy
  const reachable = () => remote.state().transport.kind === "open" && remote.state().connection.kind === "connected"
  const defaults = createRemoteQuery(remote.store.queryClient, () => remote.queries.autonomyDefaults(remote.scope(), reachable()))
  const saved = () => defaults().data
  const modeRequests = () => remote.state().mutations.filter((mutation) =>
    mutation.sessionID === sessionID && mutation.operation === "session.autonomy.set" && ["permissions", "guardrails", "answers"].some((key) => key in mutation.input))
  createEffect(() => {
    if (view()?.id !== sessionID || autonomy() === undefined) close?.()
  })
  const persist = async (change: Partial<AutonomyModes>) => {
    setPending(undefined)
    setAnnouncement("")
    if (!await remote.store.setAutonomous(change)) return
    setAnnouncement(autonomyAnnouncement(change, autonomyRows(autonomy())))
  }
  const persistDefault = async (change: Partial<AutonomyModes>, acceptYolo: boolean) => {
    const scope = remote.scope()
    setPending(undefined)
    setAnnouncement("")
    setDefaultFailure(undefined)
    if (scope === undefined) return
    setSavingDefault(true)
    const result = await remote.queries.saveAutonomyDefaults(scope, change, acceptYolo)
    setSavingDefault(false)
    if (result.reached) setAnnouncement(autonomyDefaultAnnouncement(change))
    else setDefaultFailure(result.message)
  }
  const run = (intent: AutonomyIntent) => {
    if (intent.type === "select") {
      setSelected(intent.index)
      return
    }
    const current = autonomy()
    if (current === undefined) return
    setDefaultFailure(undefined)
    if (intent.type === "save-default" || intent.type === "reset-default") {
      const known = saved()
      if (known === undefined) return
      const change = autonomyDefaultChange(intent, current)
      if (requiresYoloConfirmation(known, change)) setPending({ target: "default", change })
      else void persistDefault(change, false)
      return
    }
    const change = autonomyChange(intent, current)
    if (requiresYoloConfirmation(current, change)) {
      setPending({ target: "session", change })
      return
    }
    void persist(change)
  }
  return <Modal class="overlay--autonomous" label="Autonomous" returnFocus={props.returnFocus} onClose={props.onClose} requestClose={(handoff) => { close = handoff }}>
    <Show when={pending()} fallback={<Show when={autonomy()}>{(current) => <AutonomousPanel
      autonomy={current()}
      selected={selected()}
      defaults={saved()}
      defaultsUnreadable={defaults().status === "error" ? defaults().error?.message : undefined}
      busy={savingDefault() || modeRequests().some((mutation) => mutation.state === "sending")}
      reachable={reachable()}
      failure={defaultFailure() ?? modeRequests().find((mutation) => mutation.state !== "sending")?.detail}
      announcement={announcement()}
      onIntent={run}
    />}</Show>}>{(request) => <div role="alert">
      <p>YOLO disables all blockers in the selected categories, including hard, catastrophic and destructive guardrails, permission blocks, and all questions, free-text and open questions. It pushes progression aggressively. You accept full responsibility for the consequences.</p>
      <button type="button" class="button button--secondary" ref={(element) => queueMicrotask(() => element.focus())} onClick={() => setPending(undefined)}>Cancel</button>
      <button type="button" class="button button--primary" disabled={!reachable()} onClick={() => void (request().target === "default" ? persistDefault(request().change, true) : persist(request().change))}>{request().target === "default" ? "Accept risk & save YOLO default" : "Accept risk & enable YOLO"}</button>
    </div>}</Show>
  </Modal>
}
