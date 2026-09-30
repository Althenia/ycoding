import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { AppProcess } from "@ycoding-ai/core/process"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Api } from "../src/api"
import { KeepAwakeHandler } from "../src/handlers/keep-awake"

function serve(platform: NodeJS.Platform, spawned: string[]) {
  const service = Layer.effect(
    KeepAwake.Service,
    Effect.gen(function* () {
      return yield* KeepAwake.make({
        spawner: yield* AppProcess.Service,
        platform,
        pid: process.pid,
        command: () => {
          spawned.push("inhibitor")
          return ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
        },
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.keepAwake"])).pipe(
      Layer.provide(
        KeepAwakeHandler.pipe(
          Layer.provide(
            Layer.mergeAll(
              service,
              Layer.succeed(Authorization, (effect) => effect),
              Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
            ),
          ),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
  )
}

const request = (handler: ReturnType<typeof serve>, method: string, body?: string) =>
  handler.handler(
    new Request("http://localhost/api/keep-awake", {
      method,
      ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
    }),
  )

test("serves the runtime keep-awake switch and validates its input", async () => {
  const spawned: string[] = []
  const handler = serve("darwin", spawned)
  try {
    expect(await (await request(handler, "GET")).json()).toEqual({ data: { state: "off" } })
    expect((await request(handler, "PUT", '{"enabled":"yes"}')).status).toBe(400)
    expect((await request(handler, "PUT", "{}")).status).toBe(400)
    expect(spawned).toEqual([])
    expect(await (await request(handler, "PUT", '{"enabled":true}')).json()).toEqual({ data: { state: "on" } })
    expect(await (await request(handler, "PUT", '{"enabled":true}')).json()).toEqual({ data: { state: "on" } })
    expect(spawned).toEqual(["inhibitor"])
    expect(await (await request(handler, "GET")).json()).toEqual({ data: { state: "on" } })
    expect(await (await request(handler, "PUT", '{"enabled":false}')).json()).toEqual({ data: { state: "off" } })
    expect(await (await request(handler, "GET")).json()).toEqual({ data: { state: "off" } })
  } finally {
    await handler.dispose()
  }
})

test("reports an unsupported platform as a successful status without starting an inhibitor", async () => {
  const spawned: string[] = []
  const handler = serve("linux", spawned)
  const unsupported = { data: { state: "unsupported", message: "Keep machine awake is available on macOS only." } }
  try {
    expect(await (await request(handler, "GET")).json()).toEqual(unsupported)
    const response = await request(handler, "PUT", '{"enabled":true}')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(unsupported)
    expect(spawned).toEqual([])
  } finally {
    await handler.dispose()
  }
})

test("keep-awake is a local authenticated operation with stable OpenAPI identifiers", () => {
  const group = Api.groups["server.keepAwake"]
  expect(Object.keys(group.endpoints).sort()).toEqual(["keepAwake.get", "keepAwake.set"])
  expect(group.endpoints["keepAwake.get"].middlewares.has(Authorization)).toBe(true)
  expect(group.endpoints["keepAwake.set"].middlewares.has(Authorization)).toBe(true)
  const path = OpenApi.fromApi(Api).paths["/api/keep-awake"]
  expect(path?.get?.operationId).toBe("v2.keepAwake.get")
  expect(path?.put?.operationId).toBe("v2.keepAwake.set")
})
