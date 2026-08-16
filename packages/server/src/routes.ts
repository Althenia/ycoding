import { Database } from "@ycoding-ai/core/database/database"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { httpClient } from "@ycoding-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventLogger } from "@ycoding-ai/core/event-logger"
import { FileSystemSearch } from "@ycoding-ai/core/filesystem/search"
import { Observability } from "@ycoding-ai/core/observability"
import { Credential } from "@ycoding-ai/core/credential"
import { Config } from "@ycoding-ai/core/config"
import { CommandV2 } from "@ycoding-ai/core/command"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { PtyTicket } from "@ycoding-ai/core/pty/ticket"
import { Pty } from "@ycoding-ai/core/pty"
import { Project } from "@ycoding-ai/core/project"
import { ProjectArtifactStore } from "@ycoding-ai/core/project-artifact"
import { ProjectArtifactAccounting } from "@ycoding-ai/core/project-artifact/accounting"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionGenerateNode } from "@ycoding-ai/core/session/generate-node"
import { SessionModelRequest } from "@ycoding-ai/core/session/model-request"
import { SessionTitle } from "@ycoding-ai/core/session/title"
import { Shell } from "@ycoding-ai/core/shell"
import { Job } from "@ycoding-ai/core/job"
import { Global } from "@ycoding-ai/core/global"
import { InstructionDiscovery } from "@ycoding-ai/core/instruction-discovery"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { ModelsDev } from "@ycoding-ai/core/models-dev"
import { SessionRestart } from "@ycoding-ai/core/session/execution/restart"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionOrchestrationNotifier } from "@ycoding-ai/core/session/orchestration-notifier"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { SdkPlugins } from "@ycoding-ai/core/plugin/sdk"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { WellKnown } from "@ycoding-ai/core/wellknown"
import { Watcher } from "@ycoding-ai/core/filesystem/watcher"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Context, Effect, Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer } from "./location"
import { formLocationLayer } from "./middleware/form-location"
import { sessionLocationLayer } from "./middleware/session-location"
import { ServerInfo } from "./server-info"
import type { ServerOptions } from "./options"
import { randomUUID } from "node:crypto"
import { processIdentityLayer } from "./process-identity"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  EventLogger.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  Job.node,
  Project.node,
  ProjectArtifactStore.node,
  ProjectArtifactAccounting.node,
  SessionV2.node,
  PluginRuntime.providerNode,
  SdkPlugins.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  WellKnown.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
  SessionRestart.node,
  SessionOrchestration.node,
  SessionOrchestrationNotifier.node,
])

export function createRoutes(
  options: ServerOptions = {},
  serviceURLs: () => ReadonlyArray<string> = () => [],
  sourceEpoch: ServiceStatus.Epoch = ServiceStatus.Epoch.make(randomUUID()),
) {
  return makeRoutes(
    options.password
      ? ServerAuth.Config.configLayer({ password: Option.some(options.password) })
      : ServerAuth.Config.layer,
    options,
    serviceURLs,
    sourceEpoch,
  )
}

export function createEmbeddedRoutes(
  options: ServerOptions = {},
  sourceEpoch: ServiceStatus.Epoch = ServiceStatus.Epoch.make(randomUUID()),
) {
  return makeRoutes(ServerAuth.Config.configLayer({ password: Option.none() }), options, () => [], sourceEpoch)
}

function makeRoutes<AuthError, AuthServices>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  options: ServerOptions,
  serviceURLs: () => ReadonlyArray<string>,
  sourceEpoch: ServiceStatus.Epoch,
) {
  const pluginRuntimeCell = PluginRuntime.makeCell()
  const replacements: LayerNode.Replacements = [
    [Database.node, Database.configured(options.database)],
    [ModelsDev.node, ModelsDev.configured({ ...options.models, client: options.client })],
    [Watcher.node, Watcher.configured({ enabled: options.fs?.filewatcher })],
    [FileSystemSearch.node, FileSystemSearch.configured({ fff: options.fs?.fff })],
    [Global.node, Global.layerWith(options.config?.directory ? { config: options.config.directory } : {})],
    [
      Config.node,
      Config.configured({
        project: options.config?.project,
        file: options.config?.file,
        content: options.config?.content,
      }),
    ],
    [InstructionDiscovery.node, InstructionDiscovery.configured({ project: options.config?.project })],
    [CommandV2.node, CommandV2.configured({ gitbash: options.windows?.gitbash })],
    [Pty.node, Pty.configured({ gitbash: options.windows?.gitbash })],
    [Shell.node, Shell.configured({ gitbash: options.windows?.gitbash })],
    [SessionCompaction.node, SessionCompaction.configured({ client: options.client })],
    [SessionGenerateNode.node, SessionGenerateNode.configured({ client: options.client })],
    [SessionModelRequest.node, SessionModelRequest.configured({ client: options.client })],
    [SessionTitle.node, SessionTitle.configured({ client: options.client })],
    [PluginRuntime.node, PluginRuntime.layerWithCell(pluginRuntimeCell)],
    [PluginRuntime.providerNode, PluginRuntime.providerNodeWithCell(pluginRuntimeCell)],
  ]
  const serviceLayer = options.simulation
    ? Layer.unwrap(
        Effect.gen(function* () {
          const { simulationReplacements } = yield* Effect.promise(() => import("@ycoding-ai/simulation/backend"))
          const simulation = yield* simulationReplacements()
          return AppNodeBuilder.build(applicationServices, [...replacements, ...simulation])
        }),
      )
    : AppNodeBuilder.build(applicationServices, replacements)

  return serviceLayer.pipe(
    Layer.flatMap((context) => {
      const services = Layer.succeedContext(context)
      const requestServices = Layer.merge(
        Layer.succeedContext(Context.pick(PermissionSaved.Service, Project.Service, WellKnown.Service)(context)),
        ServerInfo.layer(serviceURLs),
      )
      return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(handlers.pipe(Layer.provide(services), Layer.provide(processIdentityLayer(sourceEpoch)))),
        Layer.provide(formLocationLayer),
        Layer.provide(sessionLocationLayer),
        Layer.provide(layer),
        Layer.provide(authorizationLayer),
        Layer.provide(schemaErrorLayer),
        Layer.provide(auth),
        Layer.provide(Observability.layer({ ...options.observability, client: options.client })),
        HttpRouter.provideRequest(requestServices),
        Layer.provideMerge(services),
        Layer.provideMerge(HttpRouter.layer),
      )
    }),
  )
}

export const webHandler = () => HttpRouter.toWebHandler(createRoutes().pipe(Layer.provide(HttpServer.layerServices)))
