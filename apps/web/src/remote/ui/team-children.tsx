import { For, Show, type JSX } from "solid-js"
import { useRemote } from "../context"
import { createRemoteQuery } from "../query"
import type { TeamSubagent } from "./team-model"
import { LoadingPlaceholder } from "./loading"

export function TeamChildren(props: {
  readonly familyID: string
  readonly task: () => TeamSubagent
  readonly ancestors: () => readonly string[]
  readonly cursor: () => string | undefined
  readonly onCursor: (cursor: string | undefined) => void
  readonly onInspect: (task: TeamSubagent) => void
}): JSX.Element {
  const remote = useRemote()
  const connected = () => remote.state().transport.kind === "open" && remote.state().connection.kind === "connected"
  const query = createRemoteQuery(remote.store.queryClient, () => remote.queries.childTeam(remote.scope(), connected(), props.familyID, props.task().sessionID, props.cursor()))
  const cyclic = () => query().data?.tasks.some(task => props.ancestors().includes(task.sessionID)) === true
  const children = () => cyclic() ? [] : query().data?.tasks ?? []
  return <section class="team-children" aria-label={`Children of ${props.task().description}`} aria-busy={query().isFetching}>
    <div class="team-overview__section-heading"><h3>Children</h3><button type="button" class="team-view__button" disabled={!connected() || query().isFetching} onClick={() => void query().refetch()}>Refresh children</button></div>
    <p class="team-view__note">Inspect reported descendants here. Decisions remain with their owning Session.</p>
    <Show when={!connected()}><p role="status">Reconnect the machine to load children.</p></Show>
    <Show when={query().isPending}><LoadingPlaceholder kind="team" label="Loading child subagents…" /></Show>
    <Show when={query().isError}><p role="alert">{query().error?.message}</p></Show>
    <Show when={cyclic()}><p role="alert">The device returned a cyclic child list.</p></Show>
    <Show when={query().isSuccess && children().length === 0 && !cyclic()}><p role="status">No child subagents have been reported.</p></Show>
    <ul class="team-children__list"><For each={children().map(task => task.sessionID)}>{id => {
      const task = () => children().find(task => task.sessionID === id)!
      return <li><button type="button" class="team-view__button" data-child-id={id} aria-label={`Inspect ${task().description}`} onClick={() => props.onInspect(task())}><strong>{task().description}</strong><span>{task().agent ?? "Agent unreported"} · {task().state}</span></button></li>
    }}</For></ul>
    <Show when={query().data?.next}>{next => <button type="button" class="team-view__button" disabled={query().isFetching} onClick={() => props.onCursor(next())}>Load older descendants</button>}</Show>
    <Show when={props.cursor()}><button type="button" class="team-view__button" disabled={query().isFetching} onClick={() => props.onCursor(undefined)}>First children</button></Show>
  </section>
}
