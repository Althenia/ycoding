import { For } from "solid-js"
import { useRemote } from "../context"
import { projectEscalationLines, type ProjectEscalationView } from "../project-escalation"
import { notificationSessionTitle } from "../store"

export function ProjectEscalationNote(props: { readonly escalation: ProjectEscalationView }) {
  const remote = useRemote()
  const lines = () => projectEscalationLines(props.escalation, (sessionID) => notificationSessionTitle(remote.state(), sessionID))
  return <div role="group" aria-label="Project escalation" data-project-escalation>
    <p class="request__note" role="status">Project escalation</p>
    <For each={lines()}>{(line) => <p class="request__note" data-project-escalation-session={line.sessionID}><strong>{line.label}</strong>: {line.reason}</p>}</For>
  </div>
}
