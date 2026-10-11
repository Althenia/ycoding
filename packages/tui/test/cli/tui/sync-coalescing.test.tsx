/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { createApi, createEventStream, createFetch, json, type FetchHandler } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"

test("explicit and integration-event refreshes coalesce into one active and one trailing generation", async () => {
  const ref = { directory: "/tmp/ycoding-sync-coalescing" }
  const location = { ...ref, project: { id: "proj_sync", directory: ref.directory } }
  const paths = ["/api/integration", "/api/model", "/api/model/default", "/api/provider"]
  const first = new Map(paths.map((path) => [path, Promise.withResolvers<Response>()]))
  const second = new Map(paths.map((path) => [path, Promise.withResolvers<Response>()]))
  const counts = new Map(paths.map((path) => [path, 0]))
  const started = Promise.withResolvers<void>()
  const trailing = Promise.withResolvers<void>()
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (!counts.has(url.pathname)) return undefined
    const count = (counts.get(url.pathname) ?? 0) + 1
    counts.set(url.pathname, count)
    if (paths.every((path) => (counts.get(path) ?? 0) >= 1)) started.resolve()
    if (paths.every((path) => (counts.get(path) ?? 0) >= 2)) trailing.resolve()
    return (count === 1 ? first : second).get(url.pathname)?.promise
  }, events)
  let data!: ReturnType<typeof useData>
  const ready = Promise.withResolvers<void>()
  function Probe() {
    data = useData()
    onMount(ready.resolve)
    return <box />
  }
  const screen = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  await ready.promise
  const refresh = () =>
    Promise.all([data.location.integration.sync(ref), data.location.model.sync(ref), data.location.provider.sync(ref)])
  const response = (path: string, fresh: boolean) =>
    json({
      location,
      data:
        path === "/api/model/default"
          ? { selection: { providerID: "fixture", id: fresh ? "newest" : "stale", profile: fresh ? "Work" : "Old" } }
          : [
              {
                id: fresh ? "newest" : "stale",
                name: fresh ? "Newest" : "Stale",
                ...(path === "/api/model" ? { providerID: "fixture" } : {}),
              },
            ],
    })
  const active = refresh()
  try {
    await started.promise
    const delivered = Promise.withResolvers<void>()
    const unsubscribe = data.on("integration.updated", () => delivered.resolve())
    events.emit({ id: "evt_sync_refresh", created: 1, type: "integration.updated", location: ref, data: {} })
    await delivered.promise
    unsubscribe()
    data.location.integration.invalidate(ref)
    data.location.model.invalidate(ref)
    data.location.provider.invalidate(ref)
    const explicit = refresh()
    data.location.integration.invalidate(ref)
    data.location.model.invalidate(ref)
    data.location.provider.invalidate(ref)
    const repeated = refresh()
    expect(paths.map((path) => counts.get(path))).toEqual([1, 1, 1, 1])
    paths.forEach((path) => first.get(path)?.resolve(response(path, false)))
    await active
    await trailing.promise
    expect(data.location.integration.list(ref)).toBeUndefined()
    expect(data.location.model.list(ref)).toBeUndefined()
    expect(data.location.model.default(ref)).toBeUndefined()
    expect(data.location.provider.list(ref)).toBeUndefined()
    paths.forEach((path) => second.get(path)?.resolve(response(path, true)))
    await Promise.all([explicit, repeated])
    expect(paths.map((path) => counts.get(path))).toEqual([2, 2, 2, 2])
    expect(data.location.integration.list(ref)?.[0]?.id).toBe("newest")
    expect(data.location.model.list(ref)?.[0]?.id).toBe("newest")
    expect(data.location.model.default(ref)).toEqual({ providerID: "fixture", id: "newest", profile: "Work" })
    expect(data.location.provider.list(ref)?.[0]?.id).toBe("newest")
    await refresh()
    expect(paths.map((path) => counts.get(path))).toEqual([2, 2, 2, 2])
  } finally {
    paths.forEach((path) => {
      first.get(path)?.resolve(response(path, false))
      second.get(path)?.resolve(response(path, true))
    })
    await active
    screen.renderer.destroy()
    events.disconnect()
  }
}, 30_000)

test("a failed stale read still admits its single trailing refresh and preserves the original rejection", async () => {
  const ref = { directory: "/tmp/ycoding-sync-failure" }
  const old = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  let requests = 0
  const fixture = await mount((url) => {
    if (url.pathname !== "/api/provider") return undefined
    requests++
    if (requests === 1) {
      started.resolve()
      return old.promise
    }
    return json({
      location: { ...ref, project: { id: "proj_sync", directory: ref.directory } },
      data: [{ id: "newest", name: "Newest" }],
    })
  })
  const active = fixture.data.location.provider.sync(ref)
  const rejected = active.then(
    () => undefined,
    (error: unknown) => error,
  )
  try {
    await started.promise
    fixture.data.location.provider.invalidate(ref)
    const next = fixture.data.location.provider.sync(ref)
    const concurrent = fixture.data.location.provider.sync(ref)
    expect(requests).toBe(1)
    old.resolve(json({ message: "Unavailable" }, { status: 503 }))
    expect(await rejected).toMatchObject({ message: "Unavailable" })
    await Promise.all([next, concurrent])
    expect(requests).toBe(2)
    expect(fixture.data.location.provider.list(ref)?.[0]?.id).toBe("newest")
    await fixture.data.location.provider.sync(ref)
    expect(requests).toBe(2)
  } finally {
    old.resolve(json({ data: [] }))
    await active.catch(() => undefined)
    fixture.destroy()
  }
})

test("a failed trailing refresh releases its cache entry for an explicit retry", async () => {
  const ref = { directory: "/tmp/ycoding-sync-trailing-failure" }
  const old = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  let requests = 0
  const fixture = await mount((url) => {
    if (url.pathname !== "/api/provider") return undefined
    requests++
    if (requests === 1) {
      started.resolve()
      return old.promise
    }
    if (requests === 2) return json({ message: "Unavailable" }, { status: 503 })
    return json({
      location: { ...ref, project: { id: "proj_sync", directory: ref.directory } },
      data: [{ id: "recovered", name: "Recovered" }],
    })
  })
  const active = fixture.data.location.provider.sync(ref)
  try {
    await started.promise
    fixture.data.location.provider.invalidate(ref)
    const next = fixture.data.location.provider.sync(ref)
    const rejected = next.then(
      () => undefined,
      (error: unknown) => error,
    )
    old.resolve(
      json({
        location: { ...ref, project: { id: "proj_sync", directory: ref.directory } },
        data: [{ id: "stale", name: "Stale" }],
      }),
    )
    await active
    expect(await rejected).toMatchObject({ message: "Unavailable" })
    expect(fixture.data.location.provider.list(ref)).toBeUndefined()
    await fixture.data.location.provider.sync(ref)
    expect(requests).toBe(3)
    expect(fixture.data.location.provider.list(ref)?.[0]?.id).toBe("recovered")
  } finally {
    old.resolve(json({ data: [] }))
    await active
    fixture.destroy()
  }
})

async function mount(handler: FetchHandler) {
  const events = createEventStream()
  const calls = createFetch(handler, events)
  let data!: ReturnType<typeof useData>
  const ready = Promise.withResolvers<void>()
  function Probe() {
    data = useData()
    onMount(ready.resolve)
    return <box />
  }
  const screen = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  await ready.promise
  return {
    data,
    destroy() {
      screen.renderer.destroy()
      events.disconnect()
    },
  }
}
