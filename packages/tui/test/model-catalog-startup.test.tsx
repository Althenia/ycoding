/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { ModelInfo } from "@ycoding-ai/client"
import { createEffect } from "solid-js"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { LocationProvider, useLocation } from "../src/context/location"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"

const location = { directory: process.cwd(), project: { id: "proj_catalog_startup", directory: process.cwd() } }
const model = {
  id: "startup-model",
  modelID: "startup-model",
  providerID: "startup-provider",
  name: "Startup model",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "high" }],
  profiles: [{ name: "work", active: true, variants: ["high"] }],
  time: { released: 1 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 128_000, output: 16_000 },
} satisfies ModelInfo
const selection = { providerID: model.providerID, id: model.id, variant: "high", profile: "work" }

async function renderCatalog() {
  const initialized = Promise.withResolvers<boolean>()
  const defaultEntered = Promise.withResolvers<void>()
  const catalog = { ready: false, requests: [] as string[] }
  const events = createEventStream()
  const transport = createFetch(async (url) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/model/default") {
      catalog.requests.push(url.pathname)
      defaultEntered.resolve()
      if (!catalog.ready) catalog.ready = await initialized.promise
      if (!catalog.ready)
        return json({ message: "Model catalog initialization timed out", service: "model.catalog" }, { status: 503 })
      return json({ location, data: { ...model, selection } })
    }
    if (url.pathname === "/api/model") {
      catalog.requests.push(url.pathname)
      return json({ location, data: catalog.ready ? [model] : [] })
    }
    return undefined
  }, events)
  const probe = {} as { data: ReturnType<typeof useData> }

  function Probe() {
    const data = useData()
    const currentLocation = useLocation()
    probe.data = data
    createEffect(() => currentLocation.set(data.location.default()))
    return <text>{data.location.model.list(currentLocation.current)?.map((item) => item.name).join(", ") ?? "No models"}</text>
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ClientProvider api={createApi(transport.fetch)}>
          <DataProvider>
            <LocationProvider>
              <Probe />
            </LocationProvider>
          </DataProvider>
        </ClientProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24 },
  )
  return { app, probe, initialized, defaultEntered, catalog }
}

test("startup loads the catalog after initialization and preserves the configured default", async () => {
  const fixture = await renderCatalog()
  try {
    await fixture.defaultEntered.promise
    const synced = fixture.probe.data.location.model.sync()
    fixture.initialized.resolve(true)
    await synced
    await fixture.app.renderOnce()
    expect(fixture.probe.data.location.model.list()).toEqual([model])
    expect(fixture.probe.data.location.model.default()).toEqual(selection)
    expect(fixture.app.captureCharFrame()).toContain("Startup model")
  } finally {
    fixture.initialized.resolve(true)
    fixture.app.renderer.destroy()
  }
})

test("failed catalog initialization is not cached and an explicit sync can load it", async () => {
  const fixture = await renderCatalog()
  try {
    await fixture.defaultEntered.promise
    const synced = fixture.probe.data.location.model.sync()
    fixture.initialized.resolve(false)
    await expect(synced).rejects.toThrow()
    expect(fixture.probe.data.location.model.list()).toBeUndefined()
    expect(fixture.probe.data.location.model.default()).toBeUndefined()
    expect(fixture.catalog.requests).toEqual(["/api/model/default"])
    fixture.catalog.ready = true
    await fixture.probe.data.location.model.sync()
    expect(fixture.probe.data.location.model.list()).toEqual([model])
    expect(fixture.probe.data.location.model.default()).toEqual(selection)
  } finally {
    fixture.initialized.resolve(false)
    fixture.app.renderer.destroy()
  }
})
