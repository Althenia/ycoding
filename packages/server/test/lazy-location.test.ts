import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpRouter } from "effect/unstable/http"
import { Catalog } from "@ycoding-ai/core/catalog"
import { LocationWatcher } from "@ycoding-ai/core/filesystem/location-watcher"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { CatalogContributions } from "@ycoding-ai/core/plugin/catalog-contributions"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { createRoutes } from "../src/routes"

async function withServer(
  run: (input: {
    directory: string
    sessionDirectory: string
    request: (path: string, init?: RequestInit) => Promise<Response>
    loaded: () => Promise<readonly LocationServiceMap.Loaded[]>
    sessionID: () => Session.ID
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "ycoding-lazy-location-"))
  const directory = join(root, "workspace")
  const sessionDirectory = join(root, "session-workspace")
  await mkdir(directory)
  await mkdir(sessionDirectory)
  let locations: LocationServiceMap.Interface | undefined
  let sessionID: Session.ID | undefined
  const handler = HttpRouter.toWebHandler(
    createRoutes({
      password: "fixture",
      database: { path: join(root, "session.db") },
      config: { directory: join(root, "config"), project: false },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    }).pipe(
      Layer.provide(NodeHttpServer.layerHttpServices),
      Layer.tap((context) =>
        Effect.gen(function* () {
          locations = Context.get(context, LocationServiceMap.Service)
          sessionID = (yield* Context.get(context, Session.Service).create({
            location: { directory: AbsolutePath.make(sessionDirectory) },
            title: "Synthetic",
          })).id
        }),
      ),
    ),
  )
  const headers = { authorization: `Basic ${Buffer.from("ycoding:fixture").toString("base64")}` }
  try {
    await handler.handler(new Request("http://localhost/api/health", { headers }), Context.empty())
    await run({
      directory,
      sessionDirectory,
      request: (path, init) =>
        handler.handler(new Request(`http://localhost${path}`, { ...init, headers }), Context.empty()),
      loaded: () => Effect.runPromise(locations!.loaded()),
      sessionID: () => sessionID!,
    })
  } finally {
    await handler.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

const query = (directory: string) => `location[directory]=${encodeURIComponent(directory)}`

test("a model list request builds only the catalog slice of a fresh Location", async () => {
  await withServer(async ({ directory, request, loaded }) => {
    const response = await request(`/api/model?${query(directory)}`)
    expect(response.status).toBe(200)
    const entries = (await loaded()).filter((item) => item.ref.directory === directory)
    expect(entries).toHaveLength(1)
    const built = entries[0]!.built
    expect(built).toContain(Catalog.node.name)
    expect(built).toContain(CatalogContributions.node.name)
    expect(built).not.toContain(MCP.node.name)
    expect(built).not.toContain(LocationWatcher.node.name)
    expect(built).not.toContain(PluginSupervisor.node.name)
  })
}, 60_000)

test("a provider list request stays within the catalog slice", async () => {
  await withServer(async ({ directory, request, loaded }) => {
    const response = await request(`/api/provider?${query(directory)}`)
    expect(response.status).toBe(200)
    const built = (await loaded()).find((item) => item.ref.directory === directory)!.built
    expect(built).toContain(CatalogContributions.node.name)
    expect(built).not.toContain(MCP.node.name)
    expect(built).not.toContain(PluginSupervisor.node.name)
  })
}, 60_000)

test("a session request builds the full Location graph", async () => {
  await withServer(async ({ sessionDirectory, request, loaded, sessionID }) => {
    const response = await request(`/api/session/${sessionID()}/pending`)
    expect(response.status).toBe(200)
    const entries = await loaded()
    const entry = entries.find((item) => item.ref.directory === sessionDirectory)
    expect(entry).toBeDefined()
    expect(entry!.built).toEqual(
      expect.arrayContaining([
        Catalog.node.name,
        CatalogContributions.node.name,
        MCP.node.name,
        LocationWatcher.node.name,
        PluginSupervisor.node.name,
      ]),
    )
  })
}, 60_000)

test("a full request after a catalog request extends the same Location", async () => {
  await withServer(async ({ directory, request, loaded }) => {
    await request(`/api/model?${query(directory)}`)
    const find = async () => (await loaded()).filter((item) => item.ref.directory === directory)
    expect((await find())[0]!.built).not.toContain(MCP.node.name)
    expect((await request(`/api/location?${query(directory)}`)).status).toBe(200)
    const entries = await find()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.built).toContain(MCP.node.name)
  })
}, 60_000)

test("debug evict of an idle Location releases it without rebuilding it", async () => {
  await withServer(async ({ directory, request, loaded }) => {
    await request(`/api/model?${query(directory)}`)
    const listed = await request("/api/debug/location")
    expect(listed.status).toBe(200)
    expect(await listed.json()).toContainEqual({ directory })

    const evicted = await request(`/api/debug/location?${query(directory)}`, { method: "DELETE" })
    expect(evicted.status).toBe(204)
    expect((await loaded()).filter((item) => item.ref.directory === directory)).toEqual([])
    expect(await (await request("/api/debug/location")).json()).not.toContainEqual({ directory })
  })
}, 60_000)
