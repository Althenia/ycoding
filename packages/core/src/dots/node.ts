export * as DotsRuntimeNode from "./node"

import { Event } from "@ycoding-ai/schema/config"
import { Context, Effect, Layer, Stream } from "effect"
import { and, eq, sql } from "drizzle-orm"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsRuntime } from "../dots"
import { AttachmentStore } from "../attachment-store"
import { Config } from "../config"
import { ConfigCapabilities } from "../config/capabilities"
import { Database } from "../database/database"
import { makeLocationNode, type Node } from "../effect/app-node"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { Integration } from "../integration"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import { Permission } from "../permission"
import { Form } from "../form"
import { Question } from "../question"
import { PluginRuntime } from "../plugin/runtime"
import { SessionGuardrail } from "../session/guardrail"
import { Session } from "../session"
import { SessionEvent } from "../session/event"
import { SessionExecution } from "../session/execution"
import { SessionMcpEvents } from "../mcp-events/index"
import { CoordinationService } from "../coordination/index"
import type { SessionSchema } from "../session/schema"
import type { SessionPending } from "../session/pending"
import { SessionStore } from "../session/store"
import type { Tools } from "../tool/tools"
import { DotsAttachments } from "./attachments"
import { DotsHttp } from "./http"
import { DotsPubSub } from "./pubsub"
import { DotsRoom } from "./room"
import { DotsSocket } from "./socket"
import { DotsTool } from "./tool"
import { DotsExchange } from "./exchange"
import { DotsReporting } from "./report"
import { DotsReportTool } from "./report-tool"
import { DotsContext } from "./context"
import { ToolRegistry } from "../tool/registry"
import type { DotsTransport } from "./transport"

export const configured = (transport: DotsTransport.Interface) =>
  Layer.effect(
    DotsRuntime.Service,
    Effect.gen(function* () {
      const integration = yield* Integration.Service
      const store = yield* AttachmentStore.Service
      const database = yield* Database.Service
      const runtime = yield* PluginRuntime.Service
      const sessionStore = yield* SessionStore.Service
      const location = yield* Location.Service
      const config = yield* Config.Service
      const events = yield* EventRuntime.Service
      return DotsRuntime.Service.of(
        yield* DotsRuntime.make({
          enabled: () =>
            config.entries().pipe(Effect.map((entries) => ConfigCapabilities.allowsDots(Config.capabilities(entries)))),
          changes: events.subscribe(Event.Updated),
          integration,
          transport,
          attachments: DotsAttachments.make({ store }),
          sessions: {
            exists: (sessionID) =>
              sessionStore
                .get(sessionID)
                .pipe(
                  Effect.map(
                    (info) =>
                      info !== undefined &&
                      info.location.directory === location.directory &&
                      info.location.workspaceID === location.workspaceID,
                  ),
                ),
            admit: (input) =>
              DotsRuntime.admitPeer({ db: database.db, sessions: runtime.session }, input).pipe(Effect.asVoid),
          },
        }),
      )
    }),
  )

export const withTransport = (transport: DotsTransport.Interface): Node.LocationNode<DotsRuntime.Service> =>
  makeLocationNode({
    service: DotsRuntime.Service,
    layer: configured(transport),
    deps: [
      Integration.node,
      AttachmentStore.node,
      Database.node,
      PluginRuntime.node,
      SessionStore.node,
      Location.node,
      Config.node,
      EventRuntime.node,
    ],
  })

const http = DotsHttp.make({ fetch: (url, init) => globalThis.fetch(url, init) })
const pubsub = DotsPubSub.make({ http, open: (url, headers) => DotsSocket.open(url, [], headers) })

export const node: Node.LocationNode<DotsRuntime.Service> = withTransport(DotsRoom.make({ http, pubsub }))

export interface RequestToolsInterface {
  readonly promoteRoutine: SessionPending.PromotionGuard<DotsRuntime.Error>
  readonly registrations: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<Parameters<Tools.Interface["registerBatch"]>[0]>
  readonly observation: (sessionID: SessionSchema.ID, permissions: Permission.Ruleset, toolsDisabled: boolean) => Effect.Effect<DotsContext.State>
}

export class RequestTools extends Context.Service<RequestTools, RequestToolsInterface>()("@ycoding/DotsRequestTools") {}

export const makeRequestTools = (input: Parameters<typeof DotsTool.make>[0]): Pick<RequestToolsInterface, "registrations"> => ({
  registrations: (sessionID) =>
    input.dots.status(sessionID).pipe(
      Effect.orDie,
      Effect.map((status) => {
        if (!status.enabled || status.target === undefined) return []
        const tools = DotsTool.make({ ...input, target: status.target, state: status.state, runtimeState: status.runtimeState })
        return [{ tools: {
          dots_send: tools.dots_send,
          ...(tools.dots_pause === undefined ? {} : { dots_pause: tools.dots_pause }),
          ...(tools.dots_resume === undefined ? {} : { dots_resume: tools.dots_resume }),
        } }]
      }),
    ),
})

export const requestToolsNode: Node.LocationNode<RequestTools> = makeLocationNode({
  service: RequestTools,
  layer: Layer.effect(
    RequestTools,
    Effect.gen(function* () {
      const dots = yield* DotsRuntime.Service
      const location = yield* Location.Service
      const permission = yield* Permission.Service
      const guardrail = yield* SessionGuardrail.Service
      const database = yield* Database.Service
      const events = yield* EventRuntime.Service
      const config = yield* Config.Service
      const registry = yield* ToolRegistry.Service
      const observed = new Set<SessionSchema.ID>()
      const observer = DotsContext.make({ db: database.db, events })
      const exchanges = yield* DotsExchange.service
      const reporting = DotsReporting.make({ db: database.db, events, resolve: exchanges.resolveReport })
      const report = DotsReportTool.make({ resolve: exchanges.resolveReport, report: reporting.report, permission, guardrail })
      const native = makeRequestTools({ dots, directory: location.directory, permission, guardrail })
      const associated = (sessionID: SessionSchema.ID) => database.db.select({ id: EventTable.id }).from(EventTable).where(and(
        eq(EventTable.type, EventRuntime.versionedType(SessionEvent.DotsExchangeCreated.type, 1)),
        sql`json_extract(${EventTable.data}, '$.targetSessionID') = ${sessionID}`,
      )).limit(1).get().pipe(Effect.orDie, Effect.map((row) => row !== undefined))
      const registrations: RequestToolsInterface["registrations"] = (sessionID) => Effect.gen(function* () {
        const enabled = ConfigCapabilities.allowsDots(Config.capabilities(yield* config.entries()))
        const base = yield* native.registrations(sessionID)
        return enabled ? [...base, { tools: { dots_report: report } }] : base
      })
      const service = RequestTools.of({
        promoteRoutine: exchanges.promoteRoutine,
        registrations,
        observation: (sessionID, permissions, toolsDisabled) => Effect.gen(function* (): Effect.fn.Return<DotsContext.State> {
          observed.add(sessionID)
          const routine = yield* exchanges.currentRoutine(sessionID)
          const delegated = yield* exchanges.currentDelegated(sessionID)
          const receipts = { ...(routine === undefined ? {} : { routine }), ...(delegated === undefined ? {} : { delegated }) }
          const capabilities = Config.capabilities(yield* config.entries())
          if (!ConfigCapabilities.allowsDots(capabilities)) return { state: "disabled", reason: "capability_disabled" }
          if (!(yield* associated(sessionID))) return { state: "disabled", reason: "no_task" }
          const available = yield* registry.available(permissions, capabilities, yield* registrations(sessionID))
          if (toolsDisabled || !available.has("dots_report")) return { state: "disabled", reason: "tool_unavailable", ...receipts }
          return yield* exchanges.resolveReport(sessionID).pipe(
            Effect.map(({ record }) => ({ state: "enabled" as const, tool: "dots_report" as const, ...receipts, envelope: Dots.TaskEnvelope.make({
              coordinator: record.source.principal, scope: { epoch: record.source.epoch, grantID: record.grantID },
              exchangeID: record.exchangeID, messageID: record.inputID, targetSessionID: record.targetSessionID,
              kind: "task", origin: "plugin",
            }) })),
            Effect.catch((error) => Effect.succeed({ state: "disabled" as const, reason: error.code === "exchange_not_found" ? "no_task" as const : "unavailable" as const, ...receipts })),
          )
        }),
      })
      yield* events.subscribe(Event.Updated).pipe(
        Stream.runForEach(() => Effect.gen(function* () {
          if (ConfigCapabilities.allowsDots(Config.capabilities(yield* config.entries()))) return
          yield* Effect.forEach([...observed], (sessionID) => observer.observe(sessionID, { state: "disabled", reason: "capability_disabled" }), { discard: true })
        })),
        Effect.forkScoped,
      )
      return service
    }),
  ),
  deps: [node, Location.node, Permission.node, SessionGuardrail.node, Database.node, EventRuntime.node, Config.node, ToolRegistry.node,
    Session.node, SessionExecution.node, CoordinationService.node, SessionMcpEvents.Authorization.node, LocationServiceMap.node, Form.node, Question.node],
})
