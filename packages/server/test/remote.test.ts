import { expect, test } from "bun:test"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Api } from "../src/api"
import { RemoteHandler } from "../src/handlers/remote"
import { RemoteConnection } from "../src/remote-connection"

test("serves one backend remote switch and validates its input", async () => {
  const calls: boolean[] = []
  let state: "off" | "connecting" | "on" = "off"
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.remote"])).pipe(
      Layer.provide(RemoteHandler.pipe(Layer.provide(Layer.mergeAll(
        Layer.succeed(RemoteConnection.Service, RemoteConnection.Service.of({
          status: async () => ({ state }),
          set: async (enabled) => { calls.push(enabled); state = enabled ? "connecting" : "off"; return { state } },
          shutdown: async () => {},
        })),
        Layer.succeed(Authorization, (effect) => effect),
        Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
      )))),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  const request = (method: string, body?: string) => handler.handler(new Request("http://localhost/api/remote", {
    method,
    ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
  }))

  try {
    expect(await (await request("GET")).json()).toEqual({ data: { state: "off" } })
    expect((await request("PUT", '{"enabled":"yes"}')).status).toBe(400)
    expect(calls).toEqual([])
    expect(await (await request("PUT", '{"enabled":true}')).json()).toEqual({ data: { state: "connecting" } })
    state = "on"
    expect(await (await request("GET")).json()).toEqual({ data: { state: "on" } })
    expect(await (await request("PUT", '{"enabled":false}')).json()).toEqual({ data: { state: "off" } })
    expect(calls).toEqual([true, false])
  } finally {
    await handler.dispose()
  }
})
