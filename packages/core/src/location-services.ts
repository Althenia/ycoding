import { Cause, Context, Effect, Fiber, Layer, Option, RcMap, Schema, Scope, Semaphore } from "effect"
import path from "node:path"
import { AccountConnectors } from "./account-connectors"
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
import { StandaloneConfig } from "./config/standalone"
import { Decision } from "./decision"
import { StandaloneDecisionAgent } from "./decision-agent/standalone"
import { StandaloneDecision } from "./decision/standalone"
import { StandalonePermissionService } from "./permission/standalone"
import { StandaloneForm } from "./form/standalone"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { FileMutation } from "./file-mutation"
import { FileSystem } from "./filesystem"
import { FileSystemSearch } from "./filesystem/search"
import { Generate } from "./generate"
import { GenerationActivity } from "./generation-activity"
import { Form } from "./form"
import { Image } from "./image"
import { LocationWatcher } from "./filesystem/location-watcher"
import { Integration } from "./integration"
import { CoordinationService } from "./coordination/index"
import { KeepAwake } from "./keep-awake"
import { InstructionDiscovery } from "./instruction-discovery"
import { InstructionBuiltIns } from "./instructions/builtins"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { Policy } from "./policy"
import { LocationAnnouncements } from "./location-announcements"
import { LocationServiceMap } from "./location-service-map"
import { MCP } from "./mcp/index"
import { Memory } from "./memory"
import { Permission } from "./permission"
import { PluginRegistry } from "./plugin"
import { PluginSupervisor } from "./plugin/supervisor"
import { CatalogContributions } from "./plugin/catalog-contributions"
import { StandaloneAgent } from "./plugin/standalone-agent"
import { ProjectCopy } from "./project/copy"
import { ProviderUsageRuntime } from "./provider-usage"
import { UsageDashboardRuntime } from "./usage-dashboard"
import { ProjectArtifactSource } from "./project-artifact/source"
import { Pty } from "./pty"
import { Question } from "./question"
import { Shell } from "./shell"
import { Reference } from "./reference"
import { ReferenceInstructions } from "./reference/instructions"
import { SessionCompaction } from "./session/compaction"
import { SessionCompactionJob } from "./session/compaction-job"
import { StandaloneCompaction } from "./session/standalone-compaction"
import { SessionAutonomy } from "./session/autonomy"
import { SessionContext } from "./session/context"
import { SessionGoal } from "./session/goal"
import { SessionGuardrail } from "./session/guardrail"
import { SessionHelperPolicy } from "./session/helper-policy"
import { StandaloneHelperPolicy } from "./session/standalone-helper-policy"
import { SessionGenerateNode } from "./session/generate-node"
import { InstructionEntry } from "./session/instruction-entry"
import { SessionInstructions } from "./session/instructions"
import { SessionLiveState } from "./session/live-state"
import { SessionContinuation } from "./session/runner/continuation"
import { SessionCacheRuntime } from "./session/runner/cache-runtime"
import { SessionRunnerLLM } from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { StandaloneModel } from "./session/runner/standalone-model"
import { SessionProviderState } from "./session/provider-state"
import { SessionModelRequest } from "./session/model-request"
import { SessionStepBoundary } from "./session/step-boundary"
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
import { StandaloneTools } from "./tool/standalone-tools"
import { StandalonePermission } from "./tool/standalone-permission"
import { ToolOutputStore } from "./tool-output-store"
import { Vcs } from "./vcs"
import { AbsolutePath } from "./schema"
import { WorkspaceID } from "@ycoding-ai/schema/workspace-id"
import { SessionScope } from "@ycoding-ai/schema/session-scope"
import { ScopeUnavailableError } from "./session/error"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Watcher } from "./filesystem/watcher"
import { filesystem } from "./effect/app-node-platform"
import { Credential } from "./credential"
import { Database } from "./database/database"
import { EventRuntime } from "./event"
import { ModelsDev } from "./models-dev"

export { LocationServiceMap } from "./location-service-map"

const locationServiceNodes = [
  Location.node,
  AccountConnectors.node,
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
  UsageDashboardRuntime.node,
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
  const identity = (ref: Location.Ref, scope: SessionScope) => JSON.stringify([ref.directory, ref.workspaceID ?? null, scope])
  const decodeIdentity = Schema.decodeUnknownSync(Schema.Tuple([Schema.String, Schema.NullOr(Schema.String), SessionScope]))
  const allowed = new Set([
    Location.node.name, StandaloneConfig.node.name, Global.node.name, FSUtil.node.name, Watcher.node.name, filesystem.name,
    Catalog.node.name, CatalogContributions.node.name, Integration.standaloneNode.name, ModelsDev.standaloneNode.name,
    StandaloneModel.node.name, Agent.node.name, Policy.node.name, Credential.node.name, EventRuntime.node.name, Database.node.name,
    ToolRegistry.node.name, StandaloneTools.node.name, StandalonePermission.node.name, StandalonePermissionService.node.name, "@ycoding/ToolHooks", StandaloneForm.node.name, SessionAutonomy.node.name, StandaloneDecision.node.name,
    StandaloneDecisionAgent.node.name, StandaloneHelperPolicy.node.name, "@ycoding/SessionStore", "session-projector",
    "@ycoding/UsageAnalytics/Projector", "@ycoding/SessionProviderRequest", "@ycoding/TelemetryConsent",
    "@ycoding/LLMClient", "@ycoding/LLM/RequestExecutor", "effect/HttpClient", "@ycoding/LLM/WebSocketExecutor",
    Permission.node.name, "@ycoding/PermissionSaved", "@ycoding/PermissionSession", SessionTodo.node.name,
    SessionLiveState.standaloneNode.name, SessionGuardrail.standaloneObservationNode.name, "@ycoding/SessionGuardrailAuthority", KeepAwake.observationNode.name, KeepAwake.observationOwner.name,
    SessionContext.standaloneNode.name, InstructionBuiltIns.node.name, InstructionEntry.node.name, CoordinationService.node.name,
    SessionRunnerLLM.standaloneNode.name, SessionStepBoundary.node.name, GenerationActivity.node.name,
    SessionModelRequest.standaloneNode.name, SessionCacheRuntime.node.name, SessionContinuation.node.name,
    SessionProviderState.node.name, SessionCompactionJob.node.name, StandaloneCompaction.node.name, SessionTitle.standaloneNode.name,
    LocationServiceMap.node.name,
  ])
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const shared = Layer.CurrentMemoMap.forkOrCreate(yield* Effect.context<never>())
      const entries = new Map<string, Entry>()
      const rcMap: RcMap.RcMap<string, Entry> = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.gen(function* () {
            const [directory, workspaceID, placement] = decodeIdentity(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(key))
            const ref = Location.Ref.make({ directory: AbsolutePath.make(directory), workspaceID: workspaceID === null ? undefined : WorkspaceID.make(workspaceID) })
            const root = yield* Scope.Scope
            const scope = yield* Scope.fork(root)
            const entry = makeEntry(ref, scope, placement)
            entries.set(key, entry)
            yield* Scope.addFinalizer(
              root,
              Effect.sync(() => {
                if (entries.get(key) === entry) entries.delete(key)
              }),
            )
            return entry
          }),
        idleTimeToLive: "60 minutes",
      })

      const makeEntry = (ref: Location.Ref, scope: Scope.Scope, placement: SessionScope): Entry => {
        const memoMap = Layer.forkMemoMapUnsafe(shared)
        const requested = new Set<LayerNode.AnyNode>()
        const globals = new Set<LayerNode.AnyNode>()
        const built = new Set<string>()
        const gates: LocationAnnouncements.Gate[] = []
        const reads = new LocationAnnouncements.Reads()
        const semaphore = Semaphore.makeUnsafe(1)
        let stages: Record<string, number> = {}
        let context = Context.empty() as Context.Context<unknown>
        let globalContext = Context.empty() as Context.Context<unknown>
        const bound = replacements.concat([[LocationServiceMap.node, Layer.succeed(LocationServiceMap.Service, service)]], placement === "standalone"
          ? [[Location.node, Location.standaloneNode(ref)],
             [Catalog.node, Catalog.standaloneNode], [CatalogContributions.node, CatalogContributions.standaloneNode],
             [Agent.node, StandaloneAgent.node],
             [SessionLiveState.node, SessionLiveState.standaloneNode],
             [SessionContext.node, SessionContext.standaloneNode],
             [SessionRunnerLLM.node, SessionRunnerLLM.standaloneNode],
             [SessionCompaction.node, StandaloneCompaction.node],
             [SessionGuardrail.observationNode, SessionGuardrail.standaloneObservationNode],
             [ToolRegistry.node, ToolRegistry.standaloneNode]]
           : [[Location.node, Location.boundNode(ref)]])
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
            if (placement === "standalone") {
              const visited = new Set<LayerNode.AnyNode>()
              const hasFull = (node: LayerNode.AnyNode): boolean => {
                if (node === LocationServiceMap.full) return true
                if (node.kind === "group") return node.dependencies.some(hasFull)
                return nodes.members(node).some((resolved) => {
                  if (visited.has(resolved)) return false
                  visited.add(resolved)
                  return resolved.dependencies.some(hasFull)
                })
              }
              if (requests.some(hasFull)) return yield* new ScopeUnavailableError({ operation: "location services" })
              const resolved = nodes.closure(requests.flatMap((node) => nodes.members(node)))
              if (resolved.some((node) => !allowed.has(node.name))) return yield* new ScopeUnavailableError({ operation: "location services" })
            }
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
            const gate = new LocationAnnouncements.Gate(false, reads)
            const output = yield* Layer.buildWithMemoMap(
              nodes.layer(missing).pipe(Layer.provide(Layer.succeedContext(globalContext))),
              memoMap,
              scope,
            ).pipe(Effect.provideService(LocationAnnouncements.Current, gate))
            gates.push(gate)
            gate.settle()
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => gates.forEach((item) => item.close())),
            )
            missing.forEach((node) => requested.add(node))
            closure
              .filter((node) => node.tag === Node.tags.values.location)
              .forEach((node) => built.add(node.name))
            context = Context.merge(context, output).pipe(Context.add(LocationAnnouncements.CurrentReads, reads))
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
          scope: placement,
          built,
          extend: (requests) =>
            semaphore.withPermit(build(requests)).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
        }
      }

      const retire = (key: string, expected?: Entry) =>
        Effect.suspend(() => {
          if (expected && entries.get(key) !== expected) return Effect.void
          entries.delete(key)
          return RcMap.invalidate(rcMap, key)
        })
      const contextEffect = <const Items extends LocationServiceMap.Nodes, S extends SessionScope = "bound">(ref: Location.Ref, requests: Items, placement?: S) =>
        Effect.gen(function* () {
          const key = identity(canonical(ref), placement ?? "bound")
          const entry = yield* RcMap.get(rcMap, key)
          return yield* entry
            .extend(requests)
            .pipe(Effect.tapCause((cause) =>
              Cause.hasInterruptsOnly(cause) || Option.getOrUndefined(Cause.findErrorOption(cause)) instanceof ScopeUnavailableError
                ? Effect.void : retire(key, entry),
            ))
        }) as Effect.Effect<
          Context.Context<LayerNode.Output<Items[number]>>,
          LayerNode.Error<Items[number]> | (S extends "standalone" ? ScopeUnavailableError : never),
          Scope.Scope
        >
      const service: LocationServiceMap.Interface = {
        contextEffect,
        get: (ref, requests, placement) => Layer.effectContext(service.contextEffect(ref, requests, placement)),
        invalidate: (ref, placement) => retire(identity(canonical(ref), placement ?? "bound")),
        loaded: () =>
          Effect.sync(() => Array.from(entries.values(), (entry) => ({ ref: entry.ref, scope: entry.scope, built: Array.from(entry.built) }))),
      }
      return service
    }),
  )
}

type Entry = {
  readonly ref: Location.Ref
  readonly scope: SessionScope
  readonly built: ReadonlySet<string>
  readonly extend: (requests: LocationServiceMap.Nodes) => Effect.Effect<Context.Context<unknown>, unknown>
}

// This is temporary for backwards compatibility
export const locationServiceMapLayer = buildLocationServiceMap()
