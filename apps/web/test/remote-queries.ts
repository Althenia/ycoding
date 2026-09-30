import { QueryObserver } from "@tanstack/solid-query"
import { createRemoteQueries, remoteKeys, usageRead, type UsageResult } from "../src/remote/queries"
import type { RemoteStore } from "../src/remote/store"

export function queriesOf(store: RemoteStore) {
  const queries = createRemoteQueries(store.link, store.queryClient)
  const scope = () => ({ deviceID: store.state().activeDeviceID ?? "", generation: store.state().generation })
  const cached = <T>(queryKey: readonly unknown[]) => store.queryClient.getQueryCache().find<T>({ queryKey })
  const usage = <T>(queryKey: readonly unknown[]) => {
    const query = cached<UsageResult<T>>(queryKey)
    return usageRead<T>({ status: query?.state.status ?? "pending", fetchStatus: query?.state.fetchStatus ?? "idle", data: query?.state.data, error: query?.state.error ?? null })
  }
  const observe = <T, K extends readonly unknown[]>(options: ConstructorParameters<typeof QueryObserver<T, Error, T, T, K>>[1]) => {
    const observer = new QueryObserver<T, Error, T, T, K>(store.queryClient, options)
    const stop = observer.subscribe(() => {})
    return { observer, stop }
  }
  const scoped = () => store.queryClient.getQueryCache().findAll({ queryKey: remoteKeys.root })
  return { queries, scope, cached, usage, observe, scoped }
}

export const loadWorkspaces = (store: RemoteStore) => {
  const { queries, scope } = queriesOf(store)
  return store.queryClient.fetchQuery({ ...queries.workspaces(scope(), true), staleTime: 0 })
}

export const workspacesOf = (store: RemoteStore) => {
  const { cached, scope } = queriesOf(store)
  return cached<readonly unknown[]>(remoteKeys.workspaces(scope()))?.state
}
