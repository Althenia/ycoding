import { Show, createEffect, createSignal } from "solid-js"
import { Modal } from "../../ui/modal"
import { autonomyAnnouncement, autonomyChange, autonomyRows, type AutonomyIntent } from "../autonomy"
import { useRemote } from "../context"
import { AutonomousPanel } from "./autonomous-panel"

const [requests, setRequests] = createSignal(0)

export const autonomousDialogRequests = requests
export const requestAutonomousDialog = () => setRequests((count) => count + 1)

export function AutonomousDialog(props: { readonly returnFocus: HTMLElement; readonly onClose: () => void }) {
  const remote = useRemote()
  const [selected, setSelected] = createSignal(0)
  const [announcement, setAnnouncement] = createSignal("")
  const sessionID = remote.state().view?.id
  let close: (() => void) | undefined
  const view = () => remote.state().view
  const autonomy = () => view()?.autonomy
  const modeRequests = () => remote.state().mutations.filter((mutation) =>
    mutation.sessionID === sessionID && mutation.operation === "session.autonomy.set" && ["permissions", "guardrails", "answers"].some((key) => key in mutation.input))
  createEffect(() => {
    if (view()?.id !== sessionID || autonomy() === undefined) close?.()
  })
  const run = async (intent: AutonomyIntent) => {
    if (intent.type === "select") {
      setSelected(intent.index)
      return
    }
    const current = autonomy()
    if (current === undefined) return
    const change = autonomyChange(intent, current)
    setAnnouncement("")
    if (!await remote.store.setAutonomous(change)) return
    setAnnouncement(autonomyAnnouncement(change, autonomyRows(autonomy())))
  }
  return <Modal class="overlay--autonomous" label="Autonomous" returnFocus={props.returnFocus} onClose={props.onClose} requestClose={(handoff) => { close = handoff }}>
    <Show when={autonomy()}>{(current) => <AutonomousPanel
      autonomy={current()}
      selected={selected()}
      busy={modeRequests().some((mutation) => mutation.state === "sending")}
      reachable={remote.state().transport.kind === "open" && remote.state().connection.kind === "connected"}
      failure={modeRequests().find((mutation) => mutation.state !== "sending")?.detail}
      announcement={announcement()}
      onIntent={(intent) => { void run(intent) }}
    />}</Show>
  </Modal>
}
