import { Show } from "solid-js"
import { useRemote } from "../context"
import { keepAwakeState } from "../queries"
import { createRemoteQuery } from "../query"
import { keepAwakeIndicator } from "../view-model"

export function KeepAwakeIndicator() {
  const remote = useRemote()
  const reachable = () => remote.state().transport.kind === "open" && remote.state().connection.kind === "connected"
  const awake = createRemoteQuery(remote.store.queryClient, () => ({
    ...remote.queries.keepAwake(remote.scope(), reachable()),
    refetchInterval: 2_000,
  }))
  const indicator = () => reachable() ? keepAwakeIndicator(keepAwakeState(awake())) : undefined
  return <Show when={indicator()}>{(value) => <div class="keep-awake-status"><span class={`chip chip--${value().tone} keep-awake-indicator`} data-tone={value().tone} role="status" aria-label={value().detail ? `${value().label}. ${value().detail}` : undefined}>{value().label}</span></div>}</Show>
}
