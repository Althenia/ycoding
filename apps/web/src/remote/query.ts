import { QueryObserver, type DefaultError, type QueryClient, type QueryKey, type QueryObserverOptions, type QueryObserverResult } from "@tanstack/solid-query"
import { createComputed, createSignal, onCleanup, type Accessor } from "solid-js"

/**
 * A Solid Query read that never suspends: `createQuery` backs `data` with a Solid resource whose
 * loading state reaches the nearest `Suspense` boundary (the router wraps every route match in one),
 * which detaches the whole remote shell during a fetch. Observing the query cache directly keeps the
 * same keys, freshness, invalidation, and preloads while the panel stays mounted.
 */
export function createRemoteQuery<TQueryFnData, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(
  client: QueryClient,
  options: Accessor<QueryObserverOptions<TQueryFnData, TError, TData, TQueryFnData, TQueryKey>>,
): Accessor<QueryObserverResult<TData, TError>> {
  const defaulted = () => client.defaultQueryOptions(options())
  const observer = new QueryObserver(client, defaulted())
  const [result, setResult] = createSignal(observer.getOptimisticResult(defaulted()))
  createComputed(() => {
    const next = defaulted()
    observer.setOptions(next)
    setResult(observer.getOptimisticResult(next))
  })
  onCleanup(observer.subscribe((next) => setResult(next)))
  return result
}
