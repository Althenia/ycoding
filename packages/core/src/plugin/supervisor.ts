export * as PluginSupervisor from "./supervisor"

import type { Plugin } from "@ycoding-ai/plugin/effect/plugin"
import { Event } from "@ycoding-ai/schema/config"
import { Context, Deferred, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { Agent } from "../agent"
import { AISDK } from "../aisdk"
import { Browser } from "../browser"
import { IsolatedBrowser } from "../isolated-browser"
import { Catalog } from "../catalog"
import { Command } from "../command"
import { Computer } from "../computer"
import { Config } from "../config"
import { Credential } from "../credential"
import { Decision } from "../decision"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { EventRuntime } from "../event"
import { FileMutation } from "../file-mutation"
import { FileSystem } from "../filesystem"
import { Form } from "../form"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Image } from "../image"
import { Integration } from "../integration"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { Git } from "../git"
import { ProjectCopy } from "../project/copy"
import { ModelsDev } from "../models-dev"
import { Memory } from "../memory"
import { MCP } from "../mcp"
import { Npm } from "../npm"
import { Permission } from "../permission"
import { CoordinationRuntime } from "../session/coordination-runtime"
import { ProviderUsageRuntime } from "../provider-usage"
import { PluginRegistry } from "../plugin"
import { PluginPromise } from "../plugin/promise"
import { Reference } from "../reference"
import { Ripgrep } from "../ripgrep"
import { SessionAutonomy } from "../session/autonomy"
import { SessionStore } from "../session/store"
import { SessionGuardrail } from "../session/guardrail"
import { SessionCompaction } from "../session/compaction"
import { SessionInstructions } from "../session/instructions"
import { SessionRunnerModel } from "../session/runner/model"
import { SessionTodo } from "../session/todo"
import { Shell } from "../shell"
import { Skill } from "../skill"
import { ReadToolFileSystem } from "../tool/read-filesystem"
import { ToolRegistry } from "../tool/registry"
import { WebSearchTool } from "../tool/websearch"
import { WellKnown } from "../wellknown"
import { CatalogContributions } from "./catalog-contributions"
import { PluginInternal } from "./internal"
import { PluginOperations } from "./operations"
import { PluginRuntime } from "./runtime"
import { ProjectArtifactSource } from "../project-artifact/source"
import { ProjectArtifactStore } from "../project-artifact"
import { SdkPlugins } from "./sdk"
import { importModule } from "#runtime-import"

const PluginModule = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      effect: Schema.declare<Plugin["effect"]>((input): input is Plugin["effect"] => typeof input === "function"),
    }),
    Schema.Struct({
      id: Schema.String,
      setup: Schema.declare<Parameters<typeof PluginPromise.fromPromise>[0]["setup"]>(
        (input): input is Parameters<typeof PluginPromise.fromPromise>[0]["setup"] => typeof input === "function",
      ),
    }),
  ]),
})

const load = Effect.fn("PluginSupervisor.load")(function* (operation: Extract<PluginOperations.Operation, { type: "add" }>) {
  const npm = yield* Npm.Service
  const entrypoint = path.isAbsolute(operation.target)
    ? pathToFileURL(operation.target).href
    : (yield* npm.add(operation.target, { subpaths: ["server", ""] })).entrypoint
  if (!entrypoint) return
  // Bun currently ignores query parameters when caching file:// imports.
  const source =
    operation.mtime === undefined
      ? entrypoint
      : typeof Bun !== "undefined"
        ? `${operation.target.replaceAll("\\", "/")}?mtime=${operation.mtime}`
        : `${entrypoint}?mtime=${operation.mtime}`
  yield* Effect.log({
    msg: "loading plugin",
    id: operation.target,
    entrypoint: source,
  })
  const mod = yield* Effect.promise(() => importModule(source))
  const decoded = Schema.decodeUnknownOption(PluginModule)(mod)
  if (Option.isNone(decoded)) {
    return yield* Effect.fail(
      new Error(
        `Invalid plugin export: ${operation.target}. Export Plugin.define({ id, setup }) or Plugin.define({ id, effect }).`,
      ),
    )
  }
  const value = decoded.value.default
  const plugin = "effect" in value ? value : PluginPromise.fromPromise(value)
  return {
    id: plugin.id,
    version: JSON.stringify(operation),
    effect: (host) => plugin.effect({ ...host, options: operation.options }),
  } satisfies PluginRegistry.Versioned
})

export interface Interface {
  /** Wait for the initial plugin generation and startup updates to settle. */
  readonly flush: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/PluginSupervisor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* PluginRegistry.Service
    const contributions = yield* CatalogContributions.Service
    const sdk = yield* SdkPlugins.Service
    const config = yield* Config.Service
    const events = yield* EventRuntime.Service
    yield* registry.surround(contributions.list)
    const lock = Semaphore.makeUnsafe(1)
    const ready = yield* Deferred.make<void>()
    let observed = 0
    let applied = -1

    const activate = Effect.fn("PluginSupervisor.activate")(function* (target: number) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          if (applied >= target) return
          // Resolve YCoding's internal plugins with their privileged Location services.
          const internal = yield* PluginInternal.list()
          // Combine internal plugins with host-contributed SDK plugins in boot order.
          const pre = [
            ...internal.pre.map((plugin) => ({
              ...plugin,
              version: "internal",
            })),
            ...sdk.all(),
          ]
          const post = internal.post.map((plugin) => ({
            ...plugin,
            version: "internal",
          }))
          const entries = yield* config.entries()
          const operations = yield* PluginOperations.scan(entries)
          // Apply config operations and load enabled package plugins into one ordered generation.
          const plugins = yield* PluginOperations.resolve(pre, post, operations, Config.capabilities(entries), load)
          // Replace the active generation in one scoped, batched activation.
          yield* registry.activate(plugins)
          applied = target
        }),
      )
    })
    const updates = yield* events
      .subscribe([Event.Updated, SdkPlugins.Updated])
      .pipe(Stream.toQueue({ capacity: 1, strategy: "sliding" }))
    const signals = yield* Stream.concat(
      Stream.succeed(0),
      Stream.fromQueue(updates).pipe(Stream.mapEffect(() => Effect.sync(() => ++observed))),
    ).pipe(Stream.broadcast({ capacity: 1, strategy: "sliding", replay: 1 }))
    const attempt = (target: number) =>
      activate(target).pipe(
        Effect.map(() => observed === target),
        Effect.catchCause((cause) => Effect.logError("failed to reload plugins", { cause }).pipe(Effect.as(false))),
      )

    yield* signals.pipe(
      Stream.mapEffect(attempt),
      Stream.filter((settled) => settled),
      Stream.take(1),
      Stream.runDrain,
      Effect.andThen(Deferred.succeed(ready, undefined)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* signals.pipe(
      Stream.filterEffect(() => Deferred.isDone(ready)),
      Stream.debounce("100 millis"),
      Stream.runForEach((target) =>
        activate(target).pipe(Effect.catchCause((cause) => Effect.logError("failed to reload plugins", { cause }))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    return Service.of({ flush: Deferred.await(ready) })
  }),
)

const nodeLayer = layer as Layer.Layer<Service, never, PluginInternal.Requirements | CatalogContributions.Service>

export const node = makeLocationNode({
  service: Service,
  layer: nodeLayer,
  deps: [
    AISDK.node,
    PluginRegistry.node,
    CatalogContributions.node,
    SdkPlugins.node,
    Agent.node,
    Browser.node,
    IsolatedBrowser.node,
    Catalog.node,
    Command.node,
    Computer.node,
    Config.node,
    Credential.node,
    Decision.node,
    Database.node,
    EventRuntime.node,
    FileMutation.node,
    Git.node,
    FileSystem.node,
    FSUtil.node,
    Global.node,
    httpClient,
    Image.node,
    Integration.node,
    Location.node,
    LocationMutation.node,
    ProjectCopy.node,
    ModelsDev.node,
    Memory.node,
    MCP.node,
    Npm.node,
    Permission.node,
    CoordinationRuntime.node,
    ProviderUsageRuntime.node,
    SessionAutonomy.node,
    SessionStore.node,
    SessionGuardrail.node,
    SessionCompaction.node,
    PluginRuntime.node,
    Form.node,
    ReadToolFileSystem.node,
    Reference.node,
    Ripgrep.node,
    SessionInstructions.node,
    SessionRunnerModel.node,
    SessionTodo.node,
    Shell.node,
    Skill.node,
    ProjectArtifactSource.node,
    ProjectArtifactStore.node,
    ToolRegistry.toolsNode,
    WebSearchTool.configNode,
    WellKnown.node,
  ],
})

export { layer }
