import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, LayerMap, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { CoordinationService } from "@ycoding-ai/core/coordination/index"
import { Database } from "@ycoding-ai/core/database/database"
import { SessionProviderRequestTable } from "@ycoding-ai/core/session/sql"
import { EventRuntime } from "@ycoding-ai/core/event"
import { DotsRuntime } from "@ycoding-ai/core/dots"
import { DotsExchange } from "@ycoding-ai/core/dots/exchange"
import { DotsReporting } from "@ycoding-ai/core/dots/report"
import { DotsReportTool } from "@ycoding-ai/core/dots/report-tool"
import { SessionMcpEvents } from "@ycoding-ai/core/mcp-events/index"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Api } from "@ycoding-ai/server/api"
import { DotsHandler } from "@ycoding-ai/server/handlers/dots"
import { SessionLocationMiddleware } from "@ycoding-ai/server/middleware/session-location"
import type { LocationServices } from "@ycoding-ai/server/location"
import { createLocalServer } from "../src/remote-local"
import { createSessionRegistry, createSubscriptions } from "../src/remote-operations"
import { createRemoteMcp } from "../src/remote-mcp"

test("authenticated MCP exchanges cross the typed protocol into owner-checked durable inputs and correlated returns", async () => {
  const wakes: Session.ID[] = []
  const layer = AppNodeBuilder.build(LayerNode.group([
    Database.node, EventRuntime.node, SessionProjector.node, Session.node,
    SessionExecution.node, SessionOrchestration.node, CoordinationService.node,
  ]), [[SessionExecution.node, Layer.mock(SessionExecution.Service, {
    active: Effect.succeed(new Set<Session.ID>()),
    wake: (id) => Effect.sync(() => { wakes.push(id) }),
    interrupt: () => Effect.void,
  })]])
  await Effect.runPromise(Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventRuntime.Service
    const database = yield* Database.Service
    const coordination = yield* CoordinationService.Service
    const location = { directory: AbsolutePath.make(tmpdir()) }
    const anchor = yield* sessions.create({ location, title: "Anchor" })
    const alphaLocation = { directory: AbsolutePath.make(join(tmpdir(), "ycoding-dots-alpha-location")) }
    const alpha = yield* sessions.create({ location: alphaLocation, title: "Alpha" })
    const beta = yield* sessions.create({ location, title: "Beta" })
    const outsider = yield* sessions.create({ location, title: "Outsider" })
    const group = yield* coordination.create({ name: "Synthetic", masterSessionID: anchor.id, memberSessionIDs: [alpha.id, beta.id] })
    yield* coordination.activate(group.id)
    const expectedAttachment = { profile: "synthetic", dotID: "dot_fixture", threadID: "thread_fixture", generation: "generation_fixture", label: "V" }
    const source = { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } }
    let authorized = true
    const verified: unknown[] = []
    const anchorAttachmentReads: string[] = []
    const targetAttachmentReads: string[] = []
    const mappedLocations: Location.Ref[] = []
    const context = Context.add(
      yield* Effect.context<Session.Service | SessionOrchestration.Service | SessionExecution.Service | CoordinationService.Service | Database.Service | EventRuntime.Service>(),
      DotsRuntime.Service,
      DotsRuntime.Service.of({
        targets: () => Effect.succeed([expectedAttachment]),
        bind: () => Effect.die("No rebinding is permitted"),
        status: () => Effect.succeed({ enabled: true, state: "connected", target: expectedAttachment }),
        attachment: (sessionID) => Effect.sync(() => { anchorAttachmentReads.push(sessionID) }).pipe(Effect.as({ target: expectedAttachment, accountDigest: "a".repeat(64) })),
        send: () => Effect.die("MCP return reads must not post room messages"),
        pause: () => Effect.die("No runtime control is permitted"),
        resume: () => Effect.die("No runtime control is permitted"),
      }),
    ).pipe(Context.add(Location.Service, { ...location, project: { id: anchor.projectID, directory: location.directory } }), Context.add(SessionMcpEvents.Authorization.Service, SessionMcpEvents.Authorization.Service.of({
      capabilities: Effect.succeed(true),
      resolve: (value) => Effect.suspend(() => {
        verified.push(value)
        expect(value).toEqual(source)
        return authorized
          ? Effect.succeed({ grantID: "grant_fixture", expiresAt: Date.now() + 60_000 })
          : Effect.fail(new McpEvents.Failure({ category: "unauthorized", reason: "grant_revoked" }))
      }),
      check: (principal) => {
        expect(principal).toEqual({ ...source.principal, epoch: source.epoch, grantID: "grant_fixture" })
        return authorized ? Effect.succeed({ expiresAt: Date.now() + 60_000 }) : Effect.fail(new McpEvents.Failure({ category: "unauthorized", reason: "grant_revoked" }))
      },
    })))
    const locations = yield* LayerMap.make((ref: Location.Ref) => Layer.suspend(() => {
      mappedLocations.push(ref)
      return Layer.succeedContext(Context.makeUnsafe<LocationServices>(context.mapUnsafe))
    }))
    const configured = Context.add(context, LocationServiceMap.Service, locations)
    const reportingContext = configured.pipe(
      Context.add(Location.Service, { ...alphaLocation, project: { id: alpha.projectID, directory: alphaLocation.directory } }),
      Context.add(DotsRuntime.Service, DotsRuntime.Service.of({
        targets: () => Effect.die("The reporting Location must not list targets"),
        bind: () => Effect.die("No rebinding is permitted"),
        status: () => Effect.die("The reporting Location must not read status"),
        attachment: (sessionID) => Effect.sync(() => { targetAttachmentReads.push(sessionID) }).pipe(Effect.andThen(Effect.fail(new DotsRuntime.Error({ code: "not_bound", message: "The reporting Location has no attachment." })))),
        send: () => Effect.die("MCP return reads must not post room messages"),
        pause: () => Effect.die("No runtime control is permitted"),
        resume: () => Effect.die("No runtime control is permitted"),
      })),
    )
    const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.dots"])).pipe(
      Layer.provide(DotsHandler),
      Layer.provideMerge(Layer.succeedContext(configured)),
      Layer.provide(Layer.mergeAll(
        Layer.succeed(SessionLocationMiddleware, (effect) => Effect.provide(effect, Context.makeUnsafe<LocationServices>(configured.mapUnsafe))),
        Layer.succeed(Authorization, (effect) => effect),
        Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
      )),
      Layer.provide(HttpServer.layerServices),
    ))
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler.handler(request, Context.empty()) })
    const local = Object.assign(createLocalServer({ url: server.url.href }), {
      listPage: async () => ({ data: [anchor, alpha, beta, outsider] }),
      getSession: (id: string) => Effect.runPromise(sessions.get(Session.ID.make(id))),
    })
    const registry = createSessionRegistry({ local })
    yield* Effect.promise(() => registry.refresh())
    const mcp = createRemoteMcp({ local, sessions: registry, subscriptions: createSubscriptions(), resource: "https://example.test/mcp", allowed: (epoch) => authorized && epoch === source.epoch })
    const call = async (name: string, sessionID: string, input: unknown) => {
      const response = await mcp.fetch(new Request("https://example.test/mcp", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { sessionID, input }, _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "synthetic", version: "1" },
        } } }),
      }), source)
      const body: unknown = await response.json()
      if (response.status === 503) return { isError: true }
      return Schema.decodeUnknownSync(Schema.Struct({
        result: Schema.Struct({
          isError: Schema.optional(Schema.Boolean),
          content: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }))),
          structuredContent: Schema.optional(Schema.Struct({
            data: Schema.optional(Schema.Struct({
              inputID: Schema.String,
              state: Schema.String,
              result: Schema.optional(Schema.Struct({ text: Schema.String, deliveryID: Schema.String })),
            })),
          })),
        }),
      }))(body).result
    }
    const input = (exchangeID: string, targetSessionID: Session.ID) => ({ exchangeID, expectedAttachment, targetSessionID, channel: "task", delivery: "queue", text: `Task ${exchangeID}` })
    try {
      const a = yield* Effect.promise(() => call("session_dots_exchange_create", anchor.id, input("alpha", alpha.id)))
      const b = yield* Effect.promise(() => call("session_dots_exchange_create", anchor.id, input("beta", beta.id)))
      expect(a.isError).toBeUndefined()
      expect(b.isError).toBeUndefined()
      expect(verified).toHaveLength(6)
      for (const value of verified) expect(value).toEqual(source)
      expect(wakes.filter((id) => id === alpha.id || id === beta.id)).toEqual([alpha.id, beta.id])
      const pendingAlpha = yield* SessionPending.list(database.db, alpha.id)
      const pendingBeta = yield* SessionPending.list(database.db, beta.id)
      expect(pendingAlpha[0]?.data.metadata).toMatchObject({ inputOrigin: "plugin", remoteMcp: source })
      expect(pendingBeta[0]?.data.metadata).toMatchObject({ inputOrigin: "plugin", remoteMcp: source })
      for (const [target, created, text] of [[beta, b, "Beta answer"], [alpha, a, "Alpha answer"]] as const) {
        const inputID = created.structuredContent?.data?.inputID
        expect(inputID).toBeDefined()
        if (inputID === undefined) throw new Error("No admission identity")
        const assistantMessageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.InputPromoted, { sessionID: target.id, inputID: SessionMessage.ID.make(inputID) })
        yield* events.publish(SessionEvent.Step.Started, { sessionID: target.id, assistantMessageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
        if (target.id === alpha.id) {
          expect(yield* database.db.select({ id: SessionProviderRequestTable.id }).from(SessionProviderRequestTable).all().pipe(Effect.orDie)).toEqual([])
          const exchanges = yield* DotsExchange.service.pipe(Effect.provide(reportingContext))
          const reporting = DotsReporting.make({ db: database.db, events, resolve: exchanges.resolveReport })
          const reportTool = DotsReportTool.make({ resolve: exchanges.resolveReport, report: reporting.report, permission: { assert: () => Effect.void }, guardrail: { assert: () => Effect.succeed({ release: Effect.void }) } })
          yield* reportTool.execute({ kind: "progress", text: "Synthetic tool report" }, { sessionID: target.id, messageID: assistantMessageID, callID: "call_integration_report", agent: Agent.ID.make("build"), progress: () => Effect.void })
          expect(targetAttachmentReads).toEqual([])
          expect(anchorAttachmentReads).toContain(anchor.id)
          expect(mappedLocations.length).toBeGreaterThan(0)
          for (const mapped of mappedLocations) expect(mapped).toEqual(anchor.location)
        }
        yield* events.publish(SessionEvent.Text.Started, { sessionID: target.id, assistantMessageID, ordinal: 0 })
        yield* events.publish(SessionEvent.Text.Ended, { sessionID: target.id, assistantMessageID, ordinal: 0, text })
        yield* events.publish(SessionEvent.Work.Completed, { sessionID: target.id, inputID: SessionMessage.ID.make(inputID), assistantMessageID })
      }
      const resultB = yield* Effect.promise(() => call("session_dots_exchange_read", anchor.id, { exchangeID: "beta" }))
      const resultA = yield* Effect.promise(() => call("session_dots_exchange_read", anchor.id, { exchangeID: "alpha" }))
      expect(resultB.structuredContent?.data?.result?.text).toBe("Beta answer")
      expect(resultA.structuredContent?.data?.result?.text).toBe("Alpha answer")
      const visible = resultA.content?.map((item) => item.text).join("\n")
      expect(visible).toContain(`[Dots | from=${alpha.id} | to=owner_fixture/device_fixture/client_fixture | exchange=alpha |`)
      expect(visible).toContain(`reply=${a.structuredContent?.data?.inputID} | kind=progress]\nSynthetic tool report`)
      expect(visible).toContain("kind=completion]\nAlpha answer")
      expect(resultA.structuredContent?.data?.result?.deliveryID).not.toBe(resultB.structuredContent?.data?.result?.deliveryID)
      expect((yield* Effect.promise(() => call("session_dots_exchange_create", anchor.id, input("outsider", outsider.id)))).isError).toBeUndefined()
      expect((yield* Effect.promise(() => call("session_dots_exchange_create", alpha.id, input("sibling", beta.id)))).isError).toBeUndefined()
      yield* coordination.update(group.id, { revision: (yield* coordination.get(group.id)).revision, memberSessionIDs: [beta.id] })
      expect((yield* Effect.promise(() => call("session_dots_exchange_read", anchor.id, { exchangeID: "alpha" }))).isError).toBe(true)
      authorized = false
      expect((yield* Effect.promise(() => call("session_dots_exchange_create", anchor.id, input("revoked", beta.id)))).isError).toBe(true)
      expect(wakes.filter((id) => id === alpha.id || id === beta.id)).toHaveLength(3)
      expect(wakes).toHaveLength(4)
    } finally {
      yield* Effect.promise(() => mcp.close())
      yield* Effect.promise(() => handler.dispose())
      yield* Effect.promise(() => server.stop(true))
    }
  }).pipe(Effect.scoped, Effect.provide(layer)))
}, 30_000)
