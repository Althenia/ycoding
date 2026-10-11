import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Context, Effect, Layer, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { location } from "../../core/test/fixture/location"
import { Api } from "../src/api"
import { ConfigHandler } from "../src/handlers/config"
import { LocationMiddleware, type LocationServices } from "../src/location"

test("GET /api/config/diagnostics exposes every recovered item from real configuration loading", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-config-http-"))
  const target = path.join(directory, "ycoding.jsonc")
  const invalid = path.join(directory, "ycoding.json")
  await fs.writeFile(target, JSON.stringify({
    shell: "/bin/zsh", snapshot: false,
    mcp: { servers: { bad: { type: "local", command: 42 }, good: { type: "local", command: ["server"] } } },
    permissions: [{ action: "shell", resource: 42, effect: "allow" }],
    guardrails: { enabled: false, max_pending_reviews: 0 },
  }))
  await fs.writeFile(invalid, "{ invalid")
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) })))
      const scope = yield* Scope.Scope
      const context = yield* Layer.buildWithScope(Layer.merge(AppNodeBuilder.build(Config.node, [
        [Config.node, Config.configured({ project: false })],
        [Global.node, Global.layerWith({ config: directory, home: path.join(directory, "home") })],
        [Database.node, Database.configured({ path: path.join(directory, "test.db") })],
        [Location.node, locationLayer],
      ]), locationLayer), scope)
      const config = Context.get(context, Config.Service)
      expect(Config.latest(yield* config.entries(), "shell")).toBe("/bin/zsh")
      expect(Config.latest(yield* config.entries(), "mcp")?.servers).toHaveProperty("good")
      const handler = HttpRouter.toWebHandler(
        HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.config"])).pipe(
          Layer.provide(ConfigHandler),
          Layer.provide(Layer.mergeAll(
            Layer.succeed(LocationMiddleware, (effect) => Effect.provide(effect, Context.makeUnsafe<LocationServices>(context.mapUnsafe))),
            Layer.succeed(Authorization, (effect) => effect),
            Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
          )),
          Layer.provide(HttpServer.layerServices),
        ),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()))
      const response = yield* Effect.promise(() => handler.handler(new Request("http://localhost/api/config/diagnostics")))
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        location: expect.objectContaining({ directory }),
        data: expect.arrayContaining([
          { path: invalid, reason: "invalid-json", message: expect.stringContaining("offset") },
          { path: target, jsonPath: "$.snapshot", reason: "removed-keys", message: expect.any(String) },
          { path: target, jsonPath: "$.mcp.servers.bad", reason: "invalid-values", message: expect.any(String) },
          { path: target, jsonPath: "$.permissions[0]", reason: "invalid-values", failClosed: true, message: expect.stringContaining("fails closed") },
          { path: target, jsonPath: "$.guardrails", reason: "invalid-values", failClosed: true, message: expect.stringContaining("fails closed") },
        ]),
      })
      expect(yield* config.diagnostics()).toHaveLength(5)
    }).pipe(Effect.scoped))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)
