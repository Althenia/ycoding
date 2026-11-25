import { For, Show, createMemo, type JSX } from "solid-js"
import type { CoordinationBoard, CoordinationPendingRequest } from "../../../../../packages/client/src/promise/generated/types"
import "./swarm-board.css"

export type SwarmBoardView = {
  readonly participants: readonly {
    readonly id: string
    readonly parentID?: string
    readonly role: "master" | "supervisor" | "member" | "subagent"
    readonly title: string
    readonly state: string
    readonly agent?: string
    readonly model?: string
  }[]
  readonly tasks: readonly {
    readonly id: string
    readonly title: string
    readonly sessionID: string
    readonly ownerID: string
    readonly dependencies: readonly string[]
    readonly state: string
    readonly result?: { readonly messageID?: string; readonly summary?: string }
  }[]
  readonly handoffs: readonly { readonly sessionID: string; readonly fromID?: string; readonly toID?: string; readonly time: string }[]
  readonly reviews: readonly { readonly sessionID: string; readonly request: CoordinationPendingRequest }[]
}

export function swarmBoardView(board: CoordinationBoard): SwarmBoardView {
  return {
    participants: board.nodes.map((node) => ({ id: node.sessionID, parentID: node.parentSessionID, role: node.role, title: node.title, state: node.state, agent: node.agentID,
      model: node.model && `${node.model.providerID}/${node.model.id}${node.model.variant ? ` · ${node.model.variant}` : ""}${node.model.profile ? ` · ${node.model.profile}` : ""}` })),
    tasks: board.tasks.map((task) => ({ id: task.taskID, title: task.title, sessionID: task.sessionID, ownerID: task.ownerSessionID, dependencies: task.dependsOnTaskIDs, state: task.state, result: task.result })),
    handoffs: board.handoffs.map((entry) => ({ sessionID: entry.sessionID, fromID: entry.fromSessionID, toID: entry.toSessionID, time: new Date(entry.time).toLocaleString() })),
    reviews: board.reviews,
  }
}

export function SwarmBoard(props: { readonly view: () => SwarmBoardView; readonly onOpenSession: (sessionID: string) => void }): JSX.Element {
  const participants = createMemo(() => props.view().participants)
  const master = () => participants().find((entry) => entry.role === "master")
  const participant = (id: string) => participants().find((entry) => entry.id === id)
  const label = (id: string) => participant(id)?.title ?? id
  const parentID = (entry: SwarmBoardView["participants"][number]) => entry.parentID ?? (entry.role === "member" ? master()?.id : undefined)
  const roots = createMemo(() => participants().filter((entry) => !parentID(entry) || !participant(parentID(entry)!)).map((entry) => entry.id))
  const children = (id: string, ancestors: readonly string[]) => participants().filter((entry) => parentID(entry) === id && !ancestors.includes(entry.id)).map((entry) => entry.id)
  const Node = (node: { readonly id: string; readonly ancestors: readonly string[] }): JSX.Element => {
    const entry = () => participant(node.id)!
    const descendants = () => children(node.id, [...node.ancestors, node.id])
    return <li data-session-id={node.id} class="swarm-board__node">
      <div class="swarm-board__participant"><div><span class="swarm-board__eyebrow">{entry().role === "master" ? "Master · main agent" : entry().role}</span><h4>{entry().title}</h4><p class="swarm-board__meta">Session {entry().id} · {entry().state}</p><p class="swarm-board__meta">Agent {entry().agent ?? "unreported"} · Model {entry().model ?? "unreported"}</p></div><button type="button" onClick={() => props.onOpenSession(node.id)} aria-label={`Open session ${entry().title}`}>Open session</button></div>
      <Show when={descendants().length > 0}><ul><For each={descendants()}>{(id) => <Node id={id} ancestors={[...node.ancestors, node.id]} />}</For></ul></Show>
    </li>
  }
  return <div class="swarm-board">
    <section aria-label="Hierarchy"><h3>Hierarchy</h3><Show when={roots().length > 0} fallback={<p>No participants reported.</p>}><ul class="swarm-board__tree"><For each={roots()}>{(id) => <Node id={id} ancestors={[]} />}</For></ul></Show></section>
    <section aria-label="Tasks"><h3>Tasks</h3><Show when={props.view().tasks.length > 0} fallback={<p>No tasks reported.</p>}><ul class="swarm-board__list"><For each={props.view().tasks.map((task) => task.id)}>{(id) => {
      const task = () => props.view().tasks.find((entry) => entry.id === id)!
      return <li class="swarm-board__item" data-task-id={id}><div class="swarm-board__row"><strong>{task().title}</strong><span class="swarm-board__state">{task().state}</span></div><p>Owner: {label(task().ownerID)} · Session {task().ownerID}</p><p>Task Session: {label(task().sessionID)} · {task().sessionID}</p><p>Dependencies: {task().dependencies.length ? task().dependencies.map((dependency) => props.view().tasks.find((entry) => entry.id === dependency)?.title ?? dependency).join(", ") : "Independent"}</p><Show when={task().result}>{(result) => <p>Result: {result().summary ?? "No summary reported"}<Show when={result().messageID}> · Message {result().messageID}</Show></p>}</Show></li>
    }}</For></ul></Show></section>
    <section aria-label="Handoffs"><h3>Handoffs</h3><Show when={props.view().handoffs.length > 0} fallback={<p>No handoffs reported.</p>}><ul class="swarm-board__list"><For each={props.view().handoffs}>{(handoff) => <li class="swarm-board__item"><strong>{label(handoff.sessionID)}</strong><p>From: {handoff.fromID ? label(handoff.fromID) : "Unreported"} · To: {handoff.toID ? label(handoff.toID) : "Unreported"}</p><p>{handoff.time}</p></li>}</For></ul></Show></section>
    <section aria-label="Reviews"><h3>Reviews</h3><Show when={props.view().reviews.length > 0} fallback={<p>No pending reviews.</p>}><ul class="swarm-board__list"><For each={props.view().reviews}>{(review) => <li class="swarm-board__item"><div class="swarm-board__row"><strong>{review.request.kind}</strong><span class="swarm-board__state">Pending</span></div><p>{review.request.summary}</p><p>Reported by: {label(review.sessionID)} · {review.sessionID}</p><Show when={review.request.requestSessionID} fallback={<p>Request Session unreported.</p>}>{(target) => <button type="button" onClick={() => props.onOpenSession(target())}>Open request Session</button>}</Show></li>}</For></ul></Show></section>
  </div>
}
