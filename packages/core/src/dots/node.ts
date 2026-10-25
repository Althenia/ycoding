export * as DotsRuntimeNode from "./node"

import { Event } from "@ycoding-ai/schema/config"
import { Context, Effect, Layer } from "effect"
import { DotsRuntime } from "../dots"
import { AttachmentStore } from "../attachment-store"
import { Config } from "../config"
import { ConfigCapabilities } from "../config/capabilities"
import { Database } from "../database/database"
import { makeLocationNode, type Node } from "../effect/app-node"
import { EventRuntime } from "../event"
import { Integration } from "../integration"
import { Location } from "../location"
import { Permission } from "../permission"
import { PluginRuntime } from "../plugin/runtime"
import { SessionGuardrail } from "../session/guardrail"
import type { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import type { Tools } from "../tool/tools"
import { DotsAttachments } from "./attachments"
import { DotsHttp } from "./http"
import { DotsPubSub } from "./pubsub"
import { DotsRoom } from "./room"
import { DotsSocket } from "./socket"
import { DotsTool } from "./tool"
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
  readonly registrations: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<Parameters<Tools.Interface["registerBatch"]>[0]>
}

export class RequestTools extends Context.Service<RequestTools, RequestToolsInterface>()("@ycoding/DotsRequestTools") {}

export const makeRequestTools = (input: Parameters<typeof DotsTool.make>[0]): RequestToolsInterface => ({
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
      return RequestTools.of(makeRequestTools({ dots, directory: location.directory, permission, guardrail }))
    }),
  ),
  deps: [node, Location.node, Permission.node, SessionGuardrail.node],
})
