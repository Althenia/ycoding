import { expect, test } from "bun:test"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { createRemoteQuery } from "./query"

// Reactivity across option changes is proven in the browser suites (usage-page, keep-awake-settings, new-session);
// this unit covers the observer contract that does not need Solid's client runtime.
test("createRemoteQuery reports the cache synchronously, follows the fetch, and stops after disposal", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const pending: { settle?: (value: string) => void } = {}
  const options = queryOptions({ queryKey: ["probe"], queryFn: () => new Promise<string>((settle) => { pending.settle = settle }) })
  const { read, dispose } = createRoot((dispose) => ({ read: createRemoteQuery(client, () => options), dispose }))
  expect(read()).toMatchObject({ status: "pending", fetchStatus: "fetching", data: undefined })
  pending.settle?.("first")
  await Bun.sleep(10)
  expect(read()).toMatchObject({ status: "success", data: "first", fetchStatus: "idle" })
  dispose()
  const refetched = client.refetchQueries({ queryKey: ["probe"] })
  await Bun.sleep(10)
  pending.settle?.("second")
  await refetched
  await Bun.sleep(10)
  expect(read().data).toBe("first")
  expect(client.getQueryState(options.queryKey)?.data).toBe("second")
})
