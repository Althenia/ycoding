import { expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Session } from "@ycoding-ai/core/session"
import { DotsRuntime } from "@ycoding-ai/core/dots"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { Location } from "@ycoding-ai/core/location"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionMcpEvents } from "@ycoding-ai/core/mcp-events/index"
import { CoordinationService } from "@ycoding-ai/core/coordination/index"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Context, Effect, Layer, LayerMap } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmbeddedRoutes } from "../src/routes"
import { Api } from "../src/api"
import { DotsHandler } from "../src/handlers/dots"
import type { LocationServices } from "../src/location"
import { SessionLocationMiddleware } from "../src/middleware/session-location"

test("runtime controls forward the confirmed target and return the runtime status", async () => {
  const target = { profile: "fixture", dotID: "dot", threadID: "thread", generation: "generation", label: "Fixture" }
  const calls: Array<{ action: string } & Parameters<DotsRuntime.Interface["pause"]>[0]> = []
  let rejected = false
  const unbinds: Array<Parameters<DotsRuntime.Interface["unbind"]>[0]> = []
  const control = (action: "pause" | "resume", input: Parameters<DotsRuntime.Interface["pause"]>[0]) =>
    rejected
      ? Effect.fail(new DotsRuntime.Error({ code: "target_changed", message: "Confirm the current destination." }))
      : Effect.sync(() => {
          calls.push({ action, ...input })
          return { enabled: true, state: "connected" as const, target, runtimeState: action === "pause" ? "paused" as const : "unpaused" as const }
        })
  const service = DotsRuntime.Service.of({
    withBinding: () => Effect.die("Unexpected delegation binding access"),
    attachment: () => Effect.die("Unexpected exchange attachment lookup"),
    targets: () => Effect.die("Unexpected destination lookup"),
    bind: () => Effect.die("Unexpected binding"),
    status: () => Effect.die("Unexpected status lookup"),
    send: () => Effect.die("Unexpected send"),
    pause: (input) => control("pause", input),
    resume: (input) => control("resume", input),
    unbind: (input) =>
      rejected
        ? Effect.fail(new DotsRuntime.Error({ code: "target_changed", message: "Confirm the current destination." }))
        : Effect.sync(() => {
            unbinds.push(input)
            return { enabled: true, state: "disconnected" as const }
          }),
  })
  const location = Context.makeUnsafe<LocationServices>(Context.make(DotsRuntime.Service, service).mapUnsafe)
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.dots"])).pipe(
    Layer.provide(DotsHandler),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(SessionLocationMiddleware, (effect) => Effect.provide(effect, location)),
      Layer.succeed(Authorization, (effect) => effect),
      Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    )),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(Layer.mergeAll(
      Layer.mock(Session.Service, {
        daybreak: { set: () => Effect.die("Unexpected Session daybreak access") },
        autonomy: {
          get: () => Effect.die("Unexpected Session autonomy access"),
          set: () => Effect.die("Unexpected Session autonomy access"),
          effective: () => Effect.die("Unexpected Session autonomy access"),
        },
        revert: {
          stage: () => Effect.die("Unexpected Session revert access"),
          clear: () => Effect.die("Unexpected Session revert access"),
          commit: () => Effect.die("Unexpected Session revert access"),
        },
      }),
      Layer.mock(SessionExecution.Service, {}),
      Layer.mock(SessionOrchestration.Service, {}),
      Layer.mock(SessionMcpEvents.Authorization.Service, {}),
      Layer.effect(LocationServiceMap.Service, LayerMap.make((_: Location.Ref) => Layer.effectContext<LocationServices, never, never>(Effect.die("Unexpected Location runtime access")))),
      Layer.mock(CoordinationService.Service, {}),
      Database.layer({ path: ":memory:" }),
      Layer.mock(EventRuntime.Service, {}),
    )),
  ))
  const request = (action: string, body: unknown) => handler.handler(new Request(`http://localhost/api/session/ses_control/dots/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), Context.empty())
  try {
    for (const action of ["pause", "resume"]) {
      const response = await request(action, { expectedTarget: target })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: { enabled: true, state: "connected", target, runtimeState: action === "pause" ? "paused" : "unpaused" } })
      expect(calls.at(-1)).toEqual({ action, sessionID: Session.ID.make("ses_control"), expectedTarget: target })
      expect((await request(action, { turnID: "turn" })).status).toBe(400)
    }
    expect(calls).toHaveLength(2)
    const unbound = await request("unbind", { expectedTarget: target })
    expect(unbound.status).toBe(200)
    expect(await unbound.json()).toEqual({ data: { enabled: true, state: "disconnected" } })
    expect(unbinds).toEqual([{ sessionID: Session.ID.make("ses_control"), expectedTarget: target }])
    expect((await request("unbind", { turnID: "turn" })).status).toBe(400)
    expect(unbinds).toHaveLength(1)
    rejected = true
    expect((await request("pause", { expectedTarget: target })).status).toBe(400)
    expect((await request("unbind", { expectedTarget: target })).status).toBe(400)
    expect(calls).toHaveLength(2)
    expect(unbinds).toHaveLength(1)
  } finally {
    await handler.dispose()
  }
})

const target = {
  profile: "synthetic-missing",
  dotID: "dot",
  threadID: "thread",
  generation: "1",
  label: "Synthetic",
}

const mounted = async (
  settings: unknown,
  check: (request: (path: string, body?: unknown) => Promise<Response>) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "ycoding-dots-server-"))
  const directory = join(root, "workspace")
  await Promise.all([mkdir(directory), mkdir(join(root, "config"))])
  if (settings !== undefined) await writeFile(join(root, "config", "ycoding.json"), JSON.stringify(settings))
  let sessionID: Session.ID | undefined
  const handler = HttpRouter.toWebHandler(
    createEmbeddedRoutes({
      database: { path: join(root, "session.db") },
      config: { directory: join(root, "config"), project: false },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    }).pipe(
      Layer.provide(NodeHttpServer.layerHttpServices),
      Layer.tap((context) =>
        Effect.gen(function* () {
          const session = yield* Context.get(context, Session.Service).create({
            location: { directory: AbsolutePath.make(directory) },
            title: "Synthetic Dots Session",
          })
          sessionID = session.id
        }),
      ),
    ),
  )
  const request = (path: string, body?: unknown) =>
    handler.handler(
      new Request(
        `http://localhost/api/session/${sessionID}/${path}`,
        body === undefined
          ? undefined
          : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      ),
      Context.empty(),
    )
  try {
    await handler.handler(new Request("http://localhost/api/session"), Context.empty())
    expect(sessionID).toBeDefined()
    await check(request)
  } finally {
    await handler.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

test("mounted Dots endpoints stay disabled by default and reject every operation but status", async () => {
  for (const settings of [undefined, { dots: {} }, { dots: { enabled: false } }])
    await mounted(settings, async (request) => {
      const status = await request("dots")
      expect(status.status).toBe(200)
      expect(await status.json()).toEqual({ data: { enabled: false, state: "disconnected" } })
      const rejections = await Promise.all([
        request("dots/targets?profile=synthetic-missing"),
        request("dots/bind", target),
        request("dots/send", { id: "synthetic-request", text: "Do not send", expectedTarget: target }),
        request("dots/pause", { expectedTarget: target }),
        request("dots/resume", { expectedTarget: target }),
      ])
      const unbound = await request("dots/unbind", { expectedTarget: target })
      expect(unbound.status).toBe(200)
      expect(await unbound.json()).toEqual({ data: { enabled: false, state: "disconnected" } })
      for (const response of rejections) {
        expect(response.status).toBe(400)
        const text = await response.text()
        expect(text).toContain("Dots is disabled")
        expect(text).not.toMatch(/accessToken|refreshToken|Bearer /)
      }
      expect((await request("dots/cancel", { turnID: "synthetic-turn" })).status).toBe(404)
    })
}, 60_000)

test("mounted Dots controls resolve their Location runtime and fail closed before binding when enabled", async () => {
  await mounted({ dots: { enabled: true } }, async (request) => {
    const status = await request("dots")
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ data: { enabled: true, state: "disconnected" } })
    const targets = await request("dots/targets?profile=synthetic-missing")
    expect(targets.status).toBe(400)
    const text = await targets.text()
    expect(text).not.toContain("Dots is disabled")
    expect(text).not.toMatch(/accessToken|refreshToken|Bearer /)
    expect((await request("dots/bind", target)).status).toBe(400)
    expect(
      (await request("dots/send", { id: "synthetic-request", text: "Do not send", expectedTarget: target })).status,
    ).toBe(400)
    expect((await request("dots/pause", { expectedTarget: target })).status).toBe(400)
    expect((await request("dots/resume", { expectedTarget: target })).status).toBe(400)
    const unbound = await request("dots/unbind", { expectedTarget: target })
    expect(unbound.status).toBe(200)
    expect(await unbound.json()).toEqual({ data: { enabled: true, state: "disconnected" } })
    expect((await request("dots/cancel", { turnID: "synthetic-turn" })).status).toBe(404)
  })
}, 30_000)
