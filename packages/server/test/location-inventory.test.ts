import { expect, test } from "bun:test"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Database } from "@ycoding-ai/core/database/database"
import { Global } from "@ycoding-ai/core/global"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Api } from "../src/api"
import { LocationHandler } from "../src/handlers/location"
import { layer } from "../src/location"
import fs from "fs/promises"
import os from "os"
import path from "path"

test("GET /api/location retains an opened directory across a fresh server and Project service layer", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-location-")))
  const database = path.join(directory, "projects.db")
  const global = {
    home: path.join(directory, "global", "home"),
    data: path.join(directory, "global", "data"),
    cache: path.join(directory, "global", "cache"),
    config: path.join(directory, "global", "config"),
    state: path.join(directory, "global", "state"),
    tmp: path.join(directory, "global", "tmp"),
    bin: path.join(directory, "global", "bin"),
    log: path.join(directory, "global", "log"),
    repos: path.join(directory, "global", "repos"),
  }
  await Promise.all(Object.values(global).map((item) => fs.mkdir(item, { recursive: true })))
  const openedDirectory = AbsolutePath.make(directory)
  const projectInfo = {
    directory: AbsolutePath.make(path.parse(directory).root),
    id: Project.ID.global,
  }
  const url = new URL("http://localhost/api/location")
  url.searchParams.set("location[directory]", openedDirectory)

  try {
    const first = server(database, global)
    const firstScope = await Effect.runPromise(Scope.make())
    try {
      const firstContext = await Effect.runPromise(Layer.buildWithScope(first.projectLayer, firstScope))
      const project = Context.get(firstContext, Project.Service)
      const initialResponse = await first.handler.handler(
        new Request(url),
        Context.make(Project.Service, project),
      )
      expect(initialResponse.status).toBe(200)
      expect(await initialResponse.json()).toMatchObject({ directory: openedDirectory, project: projectInfo })
    } finally {
      await first.handler.dispose()
      await Effect.runPromise(Scope.close(firstScope, Exit.void))
    }

    const second = server(database, global)
    const inventory = await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.buildWithScope(second.projectLayer, yield* Scope.Scope)
        const project = Context.get(context, Project.Service)
        return {
          projects: yield* project.list(),
          directories: yield* project.directories({ projectID: Project.ID.global }),
        }
      }).pipe(Effect.scoped),
    )
    await second.handler.dispose()
    expect(inventory.projects).toContainEqual(
      expect.objectContaining({ id: Project.ID.global, worktree: projectInfo.directory }),
    )
    expect(inventory.directories).toContainEqual({ directory: openedDirectory, strategy: undefined })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

function server(database: string, global: Global.Interface) {
  const projectLayer = AppNodeBuilder.build(LayerNode.group([Project.node, LocationServiceMap.node]), [
    [Database.node, Database.configured({ path: database })],
    [Global.node, Global.layerWith(global)],
  ])
  const services = Layer.mergeAll(
    projectLayer,
    layer.pipe(Layer.provide(projectLayer)),
    Layer.succeed(Authorization, (effect) => effect),
    Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
  )
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.location"])).pipe(
      Layer.provide(LocationHandler.pipe(Layer.provide(services))),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  return { handler, projectLayer }
}
