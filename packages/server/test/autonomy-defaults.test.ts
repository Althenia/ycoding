import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { AutonomyDefaults } from "@ycoding-ai/core/autonomy-defaults"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Global } from "@ycoding-ai/core/global"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Api } from "../src/api"
import { AutonomyDefaultsHandler } from "../src/handlers/autonomy-defaults"

function serve(config: string) {
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.autonomyDefaults"])).pipe(
      Layer.provide(
        AutonomyDefaultsHandler.pipe(
          Layer.provide(
            Layer.mergeAll(
              AppNodeBuilder.build(LayerNode.group([AutonomyDefaults.node]), [[Global.node, Global.layerWith({ config })]]),
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
    new Request("http://localhost/api/autonomy-defaults", {
      method,
      ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
    }),
  )

test("serves saved autonomy defaults and refuses an unaccepted yolo default without writing", async () => {
  const config = await mkdtemp(path.join(os.tmpdir(), "ycoding-autonomy-handler-"))
  const handler = serve(config)
  try {
    expect(await (await request(handler, "GET")).json()).toEqual({ data: { permissions: "manual", guardrails: "manual", answers: "manual" } })
    const refused = await request(handler, "PUT", '{"permissions":"yolo"}')
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ field: "acceptYolo", message: "Saving a YOLO default requires explicit risk acceptance" })
    expect(await Bun.file(path.join(config, "ycoding.json")).exists()).toBe(false)
    expect((await request(handler, "PUT", "{}")).status).toBe(400)
    expect((await request(handler, "PUT", '{"permissions":"sleep"}')).status).toBe(400)
    const saved = (await (await request(handler, "PUT", '{"permissions":"yolo","answers":"auto","acceptYolo":true}')).json()) as {
      data: { permissions: string; answers: string; yoloAcceptedAt: { permissions: number } }
    }
    expect(saved.data).toMatchObject({ permissions: "yolo", guardrails: "manual", answers: "auto" })
    expect(typeof saved.data.yoloAcceptedAt.permissions).toBe("number")
    expect(JSON.parse(await readFile(path.join(config, "ycoding.json"), "utf8")).autonomy.defaults.yolo_accepted_at.permissions).toBe(saved.data.yoloAcceptedAt.permissions)
    expect(await (await request(handler, "PUT", '{"permissions":"manual"}')).json()).toEqual({ data: { permissions: "manual", guardrails: "manual", answers: "auto" } })
  } finally {
    await handler.dispose()
    await rm(config, { recursive: true, force: true })
  }
})

test("autonomy defaults is a local authenticated operation with stable OpenAPI identifiers", () => {
  const group = Api.groups["server.autonomyDefaults"]
  expect(Object.keys(group.endpoints).sort()).toEqual(["autonomyDefaults.get", "autonomyDefaults.set"])
  expect(group.endpoints["autonomyDefaults.get"].middlewares.has(Authorization)).toBe(true)
  expect(group.endpoints["autonomyDefaults.set"].middlewares.has(Authorization)).toBe(true)
  const path = OpenApi.fromApi(Api).paths["/api/autonomy-defaults"]
  expect(path?.get?.operationId).toBe("autonomyDefaults.get")
  expect(path?.put?.operationId).toBe("autonomyDefaults.set")
})
