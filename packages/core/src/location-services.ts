import { Cause, Context, Effect, Fiber, Layer, RcMap, Scope, Semaphore } from "effect"
import path from "node:path"
import { Agent } from "./agent"
import { AISDK } from "./aisdk"
import { Browser } from "./browser"
import { BrowserAdmission } from "./browser/admission"
import { IsolatedBrowserExecutor } from "./browser/isolated-executor"
import { IsolatedBrowser } from "./isolated-browser"
import { Catalog } from "./catalog"
import { Computer } from "./computer"
import { Command } from "./command"
import { Config } from "./config"
import { Decision } from "./decision"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { FileMutation } from "./file-mutation"
import { FileSystem } from "./filesystem"
import { FileSystemSearch } from "./filesystem/search"
import { Generate } from "./generate"
import { Form } from "./form"
import { Image } from "./image"
import { LocationWatcher } from "./filesystem/location-watcher"
import { Integration } from "./integration"
import { InstructionDiscovery } from "./instruction-discovery"
import { InstructionBuiltIns } from "./instructions/builtins"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { Policy } from "./policy"
import { LocationServiceMap } from "./location-service-map"
import { MCP } from "./mcp/index"
import { Memory } from "./memory"
import { Permission } from "./permission"
import { PluginRegistry } from "./plugin"
import { PluginSupervisor } from "./plugin/supervisor"
import { CatalogContributions } from "./plugin/catalog-contributions"
import { ProjectCopy } from "./project/copy"
import { ProviderUsageRuntime } from "./provider-usage"
import { ProjectArtifactSource } from "./project-artifact/source"
import { Pty } from "./pty"
import { Question } from "./question"
import { Shell } from "./shell"
import { Reference } from "./reference"
import { ReferenceInstructions } from "./reference/instructions"
import { SessionCompaction } from "./session/compaction"
import { SessionContext } from "./session/context"
import { SessionGoal } from "./session/goal"
import { SessionGuardrail } from "./session/guardrail"
import { SessionHelperPolicy } from "./session/helper-policy"
import { SessionGenerateNode } from "./session/generate-node"
import { InstructionEntry } from "./session/instruction-entry"
import { SessionInstructions } from "./session/instructions"
import { SessionLiveState } from "./session/live-state"
import { SessionContinuation } from "./session/runner/continuation"
import { SessionRunnerLLM } from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { SessionProviderState } from "./session/provider-state"
import { SessionTitle } from "./session/title"
import { SessionPrediction } from "./session/prediction"
import { SessionPromptGenerator } from "./session/prompt-generator"
import { SessionTodo } from "./session/todo"
import { Skill } from "./skill"
import { SkillInstructions } from "./skill/instructions"
import { Snapshot } from "./snapshot"
import { McpTool } from "./tool/mcp"
import { ReadToolFileSystem } from "./tool/read-filesystem"
import { ToolRegistry } from "./tool/registry"
import { ToolOutputStore } from "./tool-output-store"
import { Vcs } from "./vcs"
import { AbsolutePath } from "./schema"

export { LocationServiceMap } from "./location-service-map"

const locationServiceNodes = [
  Location.node,
  Policy.node,
  Config.node,
  Decision.node,
  Agent.node,
  Command.node,
  Reference.node,
  Integration.node,
  Catalog.node,
  AISDK.node,
  PluginRegistry.node,
  ProviderUsageRuntime.node,
  CatalogContributions.node,
  PluginSupervisor.node,
  ProjectCopy.node,
  ProjectCopy.refreshNode,
  FileSystemSearch.node,
  FileSystem.node,
  Pty.node,
  Shell.node,
  Skill.node,
  ProjectArtifactSource.node,
  InstructionBuiltIns.node,
  InstructionDiscovery.node,
  LocationMutation.node,
  FileMutation.node,
  MCP.node,
  Memory.node,
  Permission.node,
  SessionGuardrail.node,
  BrowserAdmission.node,
  IsolatedBrowserExecutor.node,
  Browser.node,
  IsolatedBrowser.node,
  Computer.node,
  ToolOutputStore.node,
  ToolRegistry.node,
  ToolRegistry.toolsNode,
  Image.node,
  SkillInstructions.node,
  ReferenceInstructions.node,
  InstructionEntry.node,
  Form.node,
  Question.node,
  Generate.node,
  SessionGenerateNode.node,
  ReadToolFileSystem.node,
  McpTool.node,
  SessionInstructions.node,
  SessionLiveState.node,
  SessionRunnerModel.node,
  SessionHelperPolicy.node,
  SessionCompaction.node,
  SessionContext.node,
  SessionGoal.node,
  SessionTitle.node,
  SessionPrediction.node,
  SessionPromptGenerator.node,
  SessionTodo.node,
  Snapshot.node,
  SessionProviderState.node,
  SessionContinuation.node,
  SessionRunnerLLM.node,
  Vcs.node,
  // Start repository watches only after boot-critical filesystem and Git work.
  LocationWatcher.node,
] as const satisfies readonly Node.LocationNode<unknown, unknown>[]

export const locationServices = LayerNode.group<typeof locationServiceNodes>(locationServiceNodes)

export type LocationServices = LayerNode.Output<typeof locationServices>
export type LocationError = LayerNode.Error<typeof locationServices>

export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service> {
  // Structural Equal is own-key-set sensitive, so `{ directory }` (schema-decoded
  // payloads omit optional keys) and `{ directory, workspaceID: undefined }` are
  // different RcMap keys. The RcMap caches by the raw key before the build
  // callback runs, so canonicalize at the map boundary to the key-present shape.
  const canonical = (ref: Location.Ref) =>
    Location.Ref.make({
      directory: AbsolutePath.make(path.resolve(ref.directory)),
      workspaceID: ref.workspaceID,
    })
  const identity = (ref: Location.Ref) => JSON.stringify([ref.directory, ref.workspaceID ?? null])
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const shared = Layer.CurrentMemoMap.forkOrCreate(yield* Effect.context<never>())
      const entries = new Map<string, Entry>()
      const rcMap: RcMap.RcMap<Location.Ref, Entry> = yield* RcMap.make({
        lookup: (ref: Location.Ref) =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope
            const entry = makeEntry(ref, scope)
            entries.set(identity(ref), entry)
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                if (entries.get(identity(ref)) === entry) entries.delete(identity(ref))
              }),
            )
            return entry
          }),
        idleTimeToLive: "60 minutes",
      })

      const makeEntry = (ref: Location.Ref, scope: Scope.Scope): Entry => {
        const memoMap = Layer.forkMemoMapUnsafe(shared)
        const requested = new Set<LayerNode.AnyNode>()
        const globals = new Set<LayerNode.AnyNode>()
        const built = new Set<string>()
        const semaphore = Semaphore.makeUnsafe(1)
        let stages: Record<string, number> = {}
        let context = Context.empty() as Context.Context<unknown>
        let globalContext = Context.empty() as Context.Context<unknown>
        const bound = replacements.concat([
          [Location.node, Location.boundNode(ref)],
          [LocationServiceMap.node, Layer.succeed(LocationServiceMap.Service, service)],
        ])
        const shareable = LayerNode.compiler(bound)
        const nodes = LayerNode.compiler(
          bound,
          (node, implementation) =>
            node.tag !== Node.tags.values.location
              ? implementation
              : Layer.suspend(() => {
                  const started = performance.now()
                  return Layer.tap(implementation, () =>
                    Effect.sync(() => {
                      stages[node.name] = Math.round(performance.now() - started)
                    }),
                  )
                }),
          (node) => node.tag === Node.tags.values.global,
        )
        const build = (requests: LocationServiceMap.Nodes) =>
          Effect.gen(function* () {
            const missing = requests
              .flatMap((node) => nodes.members(node === LocationServiceMap.full ? locationServices : node))
              .filter((node, index, all) => !requested.has(node) && all.indexOf(node) === index)
            if (missing.length === 0) return context
            const startedAt = performance.now()
            stages = {}
            const closure = nodes.closure(missing)
            const unshared = closure.filter((node) => node.tag === Node.tags.values.global && !globals.has(node))
            if (unshared.length > 0)
              globalContext = Context.merge(
                globalContext,
                yield* Layer.buildWithMemoMap(shareable.layer(unshared), shared, scope),
              )
            unshared.forEach((node) => globals.add(node))
            const output = yield* Layer.buildWithMemoMap(
              nodes.layer(missing).pipe(Layer.provide(Layer.succeedContext(globalContext))),
              memoMap,
              scope,
            )
            missing.forEach((node) => requested.add(node))
            closure
              .filter((node) => node.tag === Node.tags.values.location)
              .forEach((node) => built.add(node.name))
            context = Context.merge(context, output)
            yield* Effect.logInfo("location services booted", {
              directory: ref.directory,
              workspaceID: ref.workspaceID,
              durationMs: Math.round(performance.now() - startedAt),
              stages,
            })
            return context
          })
        return {
          ref,
          built,
          extend: (requests) =>
            semaphore.withPermit(build(requests)).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
        }
      }

      const retire = (key: Location.Ref) =>
        Effect.suspend(() => {
          entries.delete(identity(key))
          return RcMap.invalidate(rcMap, key)
        })
      const contextEffect = <const Items extends LocationServiceMap.Nodes>(ref: Location.Ref, requests: Items) =>
        Effect.gen(function* () {
          const key = canonical(ref)
          const entry = yield* RcMap.get(rcMap, key)
          return yield* entry
            .extend(requests)
            .pipe(Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : retire(key))))
        }) as Effect.Effect<
          Context.Context<LayerNode.Output<Items[number]>>,
          LayerNode.Error<Items[number]>,
          Scope.Scope
        >
      const service: LocationServiceMap.Interface = {
        contextEffect,
        get: (ref, requests) => Layer.effectContext(service.contextEffect(ref, requests)),
        invalidate: (ref) => retire(canonical(ref)),
        loaded: () =>
          Effect.sync(() => Array.from(entries.values(), (entry) => ({ ref: entry.ref, built: Array.from(entry.built) }))),
      }
      return service
    }),
  )
}

type Entry = {
  readonly ref: Location.Ref
  readonly built: ReadonlySet<string>
  readonly extend: (requests: LocationServiceMap.Nodes) => Effect.Effect<Context.Context<unknown>, unknown>
}

// This is temporary for backwards compatibility
export const locationServiceMapLayer = buildLocationServiceMap()
