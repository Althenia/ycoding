import { expect, spyOn } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Cause, Clock, Context, DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, PlatformError, Schema, Scope, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { InvalidRequestReason, LLM, LLMError } from "@ycoding-ai/ai"
import { RequestExecutor } from "@ycoding-ai/ai/route"
import { Headers, HttpClientResponse } from "effect/unstable/http"
import { Money } from "@ycoding-ai/schema/money"
import { WorkspaceID } from "@ycoding-ai/schema/workspace-id"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { InstructionEntry } from "@ycoding-ai/core/session/instruction-entry"
import { makeGlobalNode, makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-services"
import { Project } from "@ycoding-ai/core/project"
import { Git } from "@ycoding-ai/core/git"
import { WellKnown } from "@ycoding-ai/core/wellknown"
import { Shell } from "@ycoding-ai/core/shell"
import { AppProcess } from "@ycoding-ai/core/process"
import { ShellSandbox } from "@ycoding-ai/core/shell-sandbox"
import { Pty } from "@ycoding-ai/core/pty"
import { Config } from "@ycoding-ai/core/config"
import { StandaloneConfig } from "@ycoding-ai/core/config/standalone"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { ScopeUnavailableError } from "@ycoding-ai/core/session/error"
import { Job } from "@ycoding-ai/core/job"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { Provider } from "@ycoding-ai/core/provider"
import { Npm } from "@ycoding-ai/core/npm"
import { Catalog } from "@ycoding-ai/core/catalog"
import { CatalogContributions } from "@ycoding-ai/core/plugin/catalog-contributions"
import { StandaloneCatalog } from "@ycoding-ai/core/plugin/standalone-catalog"
import { ModelsDev } from "@ycoding-ai/core/models-dev"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { PluginOperations } from "@ycoding-ai/core/plugin/operations"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventSequenceTable, EventTable } from "@ycoding-ai/core/event/sql"
import { Event } from "@ycoding-ai/schema/config"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { StandaloneModel } from "@ycoding-ai/core/session/runner/standalone-model"
import { SessionRunnerLLM } from "@ycoding-ai/core/session/runner/llm"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import { Instructions } from "@ycoding-ai/core/instructions"
import { SessionContext } from "@ycoding-ai/core/session/context"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { InstructionState } from "@ycoding-ai/core/session/instruction-state"
import { ContextManifest } from "@ycoding-ai/core/session/context-manifest"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionStepBoundary } from "@ycoding-ai/core/session/step-boundary"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTodo } from "@ycoding-ai/core/session/todo"
import { StandalonePermissionService } from "@ycoding-ai/core/permission/standalone"
import { SessionMessageTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { SessionProviderRequestTable, SessionUsageTable } from "@ycoding-ai/core/session/sql"
import { UsageAnalyticsRequestTable } from "@ycoding-ai/core/usage-analytics.sql"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { Watcher } from "@ycoding-ai/core/filesystem/watcher"
import { Database } from "@ycoding-ai/core/database/database"
import { ConfigProvider } from "@ycoding-ai/core/config/provider"
import { NodeFileSystem } from "@effect/platform-node"
import { State } from "@ycoding-ai/core/state"
import { StandaloneTools } from "@ycoding-ai/core/tool/standalone-tools"
import { StandaloneForm } from "@ycoding-ai/core/form/standalone"
import { Agent } from "@ycoding-ai/core/agent"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { testEffect } from "./lib/effect"

let projectBuilds = 0
let shellBuilds = 0
let processBuilds = 0
const projectLayer = Layer.effect(Project.Service, Effect.sync(() => {
  projectBuilds++
  return Project.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    recordOpened: () => Effect.void,
    commit: () => Effect.void,
  })
}))
class ProjectConsumer extends Context.Service<ProjectConsumer, object>()("test/StandaloneProjectConsumer") {}
const projectConsumer = makeLocationNode({
  service: ProjectConsumer,
  layer: Layer.succeed(ProjectConsumer, {}),
  deps: [Project.node],
})
class ProcessConsumer extends Context.Service<ProcessConsumer, object>()("test/StandaloneProcessConsumer") {}
const processConsumer = makeLocationNode({ service: ProcessConsumer, layer: Layer.succeed(ProcessConsumer, {}), deps: [AppProcess.node] })
class MapConsumer extends Context.Service<MapConsumer, object>()("test/StandaloneMapConsumer") {}
const mapConsumer = makeLocationNode({ service: MapConsumer, layer: Layer.succeed(MapConsumer, {}), deps: [LocationServiceMap.node] })
class FullConsumer extends Context.Service<FullConsumer, object>()("test/StandaloneFullConsumer") {}
const fullConsumer = makeLocationNode({ service: FullConsumer, layer: Layer.succeed(FullConsumer, {}), deps: [LocationServiceMap.full] })
class PluginConsumer extends Context.Service<PluginConsumer, object>()("test/StandalonePluginConsumer") {}
const pluginConsumer = makeLocationNode({ service: PluginConsumer, layer: Layer.succeed(PluginConsumer, {}), deps: [PluginRuntime.node] })
class ProviderConsumer extends Context.Service<ProviderConsumer, object>()("test/StandaloneProviderConsumer") {}
const providerConsumer = makeLocationNode({ service: ProviderConsumer, layer: Layer.succeed(ProviderConsumer, {}), deps: [PluginRuntime.providerNode] })
class SandboxConsumer extends Context.Service<SandboxConsumer, object>()("test/StandaloneSandboxConsumer") {}
const sandboxConsumer = makeLocationNode({ service: SandboxConsumer, layer: Layer.succeed(SandboxConsumer, {}), deps: [ShellSandbox.node] })
const it = testEffect(AppNodeBuilder.build(LocationServiceMap.node, [
  [Project.node, projectLayer],
  [Shell.node, Layer.effectContext(Effect.sync(() => { shellBuilds++; return Context.empty() }))],
  [AppProcess.node, Layer.tap(Layer.mock(AppProcess.Service, {
    run: () => Effect.succeed({ command: "ps", exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), stdoutTruncated: false, stderrTruncated: false }),
  }), () => Effect.sync(() => { processBuilds++ }))],
]))
const ref = Location.Ref.make({ directory: AbsolutePath.make("/synthetic/standalone") })

let configFileReads = 0
let configText = '{"default_agent":"{file:/synthetic/private}"}'
let configReadMode: "ok" | "denied" | "io" = "ok"
let configReadGate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined
const configError = (reason: "PermissionDenied" | "NotFound" | "Unknown") =>
  PlatformError.systemError({ _tag: reason, module: "FileSystem", method: "readFileString" })
const configFilesystem = Layer.effect(FSUtil.Service, Effect.map(FSUtil.Service, (fs) => ({
  ...fs,
  readFileStringSafe: (target) => Effect.gen(function* () {
    if (target !== "/synthetic/global/ycoding.json") return undefined
    if (configReadGate) { yield* Deferred.succeed(configReadGate.entered, undefined); yield* Deferred.await(configReadGate.release) }
    if (configReadMode === "denied") return undefined
    if (configReadMode === "io") return yield* configError("Unknown")
    return configText
  }),
  readFileString: (target) => Effect.gen(function* () {
    if (target === "/synthetic/global/ycoding.json") {
      if (configReadGate) { yield* Deferred.succeed(configReadGate.entered, undefined); yield* Deferred.await(configReadGate.release) }
      if (configReadMode === "denied") return yield* configError("PermissionDenied")
      if (configReadMode === "io") return yield* configError("Unknown")
      return configText
    }
    if (target === "/synthetic/global/ycoding.jsonc") return yield* configError("NotFound")
    configFileReads++
    return "synthetic"
  }),
}))).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const configOverrides = [
  [Global.node, Layer.succeed(Global.Service, Global.make({ config: "/synthetic/global" }))],
  [FSUtil.node, configFilesystem],
  [Watcher.node, Layer.mock(Watcher.Service, { subscribe: () => Stream.never })],
] as const
const fileConfig = testEffect(AppNodeBuilder.build(LayerNode.group([LocationServiceMap.node, Database.node]), configOverrides))

fileConfig.effect("retains a stale standalone form for cancellation without accepting an answer", () =>
  Effect.gen(function* () {
    configReadMode = "ok"
    configText = "{}"
    const locations = yield* LocationServiceMap.Service
    const context = yield* locations.contextEffect(ref, [StandaloneForm.node, StandaloneConfig.node], "standalone")
    const forms = Context.get(context, StandaloneForm.Service)
    const config = Context.get(context, StandaloneConfig.Service)
    const form = yield* forms.create({ sessionID: "ses_synthetic_fenced_form", title: "Synthetic", fields: [{ key: "answer", type: "string", required: true }] })
    configReadMode = "denied"
    expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
    configReadMode = "ok"
    yield* config.reload()
    const answer = yield* Effect.exit(forms.reply({ id: form.id, answer: { answer: "synthetic" } }))
    expect(Exit.isFailure(answer) && Option.getOrUndefined(Cause.findErrorOption(answer.cause))).toBeInstanceOf(StandaloneConfig.InvalidError)
    expect((yield* forms.state(form.id)).status).toBe("pending")
    yield* forms.cancel(form.id)
    expect((yield* forms.state(form.id)).status).toBe("cancelled")
  }).pipe(Effect.ensuring(Effect.sync(() => { configReadMode = "ok"; configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

fileConfig.effect("keeps owner-held standalone forms cancellable after a borrowed Context closes", () =>
  Effect.gen(function* () {
    configReadMode = "ok"
    configText = "{}"
    const locations = yield* LocationServiceMap.Service
    const owner = yield* Scope.make()
    const borrower = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
    yield* Effect.addFinalizer(() => Scope.close(borrower, Exit.void))
    const context = yield* locations.contextEffect(ref, [StandaloneForm.node, StandaloneConfig.node], "standalone").pipe(Effect.provideService(Scope.Scope, owner))
    const forms = Context.get(context, StandaloneForm.Service)
    const config = Context.get(context, StandaloneConfig.Service)
    const view = yield* locations.contextEffect(ref, [StandaloneForm.node, StandaloneConfig.node], "standalone").pipe(Effect.provideService(Scope.Scope, borrower))
    expect(Context.get(view, StandaloneForm.Service)).toBe(forms)
    const form = yield* forms.create({ sessionID: "ses_synthetic_disposed_form", title: "Synthetic", fields: [{ key: "answer", type: "string", required: true }] })
    const generation = (yield* config.snapshot()).generation
    yield* locations.invalidate(ref, "standalone")
    yield* Scope.close(borrower, Exit.void)
    expect((yield* config.snapshot()).generation).toBe(generation)
    expect((yield* forms.state(form.id)).status).toBe("pending")
    yield* forms.cancel(form.id)
    expect((yield* forms.state(form.id)).status).toBe("cancelled")
    yield* Scope.close(owner, Exit.void)
    const closed = yield* Effect.exit(config.snapshot())
    const error = Exit.isFailure(closed) ? Option.getOrUndefined(Cause.findErrorOption(closed.cause)) : undefined
    expect(error).toBeInstanceOf(StandaloneConfig.InvalidError)
    expect(error).toMatchObject({ reason: "closed" })
  }).pipe(Effect.ensuring(Effect.sync(() => { configReadMode = "ok"; configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

fileConfig.live("reopens standalone permission requests after invalid configuration is repaired", () =>
  Effect.gen(function* () {
    configReadMode = "ok"
    configText = "{}"
    const locations = yield* LocationServiceMap.Service
    const context = yield* locations.contextEffect(ref, [StandalonePermissionService.node, StandaloneConfig.node], "standalone")
    const permission = Context.get(context, StandalonePermissionService.Service)
    const config = Context.get(context, StandaloneConfig.Service)
    const db = (yield* Database.Service).db
    const sessionID = SessionSchema.ID.make("ses_synthetic_permission_reload")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: sessionID, scope: "standalone", project_id: Project.ID.global, directory: ref.directory, title: "Synthetic" }).run()
    const first = yield* permission.ask({ sessionID, action: "synthetic-first", resources: ["example"], requireExplicitDecision: true })
    expect(first.effect).toBe("ask")
    configReadMode = "denied"
    expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
    const approval = yield* Effect.exit(permission.reply({ requestID: first.id, reply: "once" }))
    expect(Exit.isFailure(approval) && Option.getOrUndefined(Cause.findErrorOption(approval.cause))).toBeInstanceOf(StandaloneConfig.InvalidError)
    expect(yield* permission.get(first.id)).toBeDefined()
    yield* permission.reply({ requestID: first.id, reply: "reject" })
    expect(yield* permission.get(first.id)).toBeUndefined()
    configReadMode = "ok"
    yield* config.reload()
    expect((yield* config.snapshot()).generation).toBeGreaterThan(0)
    const next = yield* permission.ask({ sessionID, action: "synthetic-next", resources: ["example"], requireExplicitDecision: true })
    expect(next.effect).toBe("ask")
    yield* permission.reply({ requestID: next.id, reply: "reject" })
  }).pipe(Effect.ensuring(Effect.sync(() => { configReadMode = "ok"; configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

fileConfig.effect("applies global agent and permission settings in standalone scope", () =>
  Effect.gen(function* () {
    configText = JSON.stringify({ default_agent: "GSD", agents: { GSD: { description: "Synthetic override" } }, permissions: [{ action: "question", resource: "synthetic-only", effect: "deny" }] })
    const locations = yield* LocationServiceMap.Service
    const agent = yield* Agent.Service.use((service) => service.default()).pipe(Effect.provide(locations.get(ref, [Agent.node], "standalone")))
    expect(agent?.id).toBe(Agent.ID.make("GSD"))
    expect(agent?.description).toBe("Synthetic override")
    expect(agent?.permissions).toContainEqual({ action: "question", resource: "synthetic-only", effect: "deny" })
  }).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)
fileConfig.effect("applies global permissions to standalone built-in agents", () =>
  Effect.gen(function* () {
    configText = JSON.stringify({ permissions: [{ action: "question", resource: "synthetic-only", effect: "deny" }] })
    const locations = yield* LocationServiceMap.Service
    const agent = yield* Agent.Service.use((service) => service.get(Agent.ID.make("god"))).pipe(Effect.provide(locations.get(ref, [Agent.node], "standalone")))
    expect(agent?.permissions).toContainEqual({ action: "question", resource: "synthetic-only", effect: "deny" })
  }).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

testEffect(AppNodeBuilder.build(Config.globalNode, configOverrides)).effect("bound global config retains file substitution", () =>
  Effect.gen(function* () {
    const global = yield* Config.GlobalService
    expect((yield* global.snapshot()).entries.some((entry) => entry.info.default_agent === "synthetic")).toBe(true)
    expect(configFileReads).toBe(1)
  }),
)

fileConfig.effect("rejects standalone config file references before reading arbitrary paths", () =>
  Effect.gen(function* () {
    configFileReads = 0
    const locations = yield* LocationServiceMap.Service
    const result = yield* Effect.exit(Effect.flatMap(StandaloneConfig.Service, (config) => config.snapshot()).pipe(Effect.provide(locations.get(ref, [StandaloneConfig.node], "standalone"))))
    expect(configFileReads).toBe(0)
    expect(Exit.isFailure(result) && Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(StandaloneConfig.InvalidError)
  }),
)

fileConfig.effect("does not materialize unused standalone extension file references", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"safe","mcp":{"ignored":{"command":"{file:/synthetic/private}"}}}'
    configFileReads = 0
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const config = yield* StandaloneConfig.Service
      expect((yield* config.snapshot()).entries.some((entry) => entry.info.default_agent === "safe")).toBe(true)
      expect(configFileReads).toBe(0)
    }).pipe(Effect.provide(locations.get(ref, [StandaloneConfig.node], "standalone")), Effect.ensuring(Effect.sync(() => {
      configText = '{"default_agent":"{file:/synthetic/private}"}'
    })))
  }),
)

fileConfig.effect("rejects selected environment references and property names without evaluating environment or files", () =>
  Effect.gen(function* () {
    configText = "{}"
    configFileReads = 0
    const locations = yield* LocationServiceMap.Service
    const context = yield* locations.contextEffect(ref, [StandaloneConfig.node], "standalone")
    const config = Context.get(context, StandaloneConfig.Service)
    const descriptor = Object.getOwnPropertyDescriptor(process, "env")
    if (!descriptor) return yield* Effect.die("Environment descriptor is unavailable")
    let environmentReads = 0
    Object.defineProperty(process, "env", { configurable: true, get: () => {
      environmentReads++
      throw new Error("Forbidden environment evaluation")
    } })
    yield* Effect.gen(function* () {
      for (const input of [
        { default_agent: "{env:SYNTHETIC_CONFIG_REFERENCE}" },
        { providers: { "{env:SYNTHETIC_CONFIG_REFERENCE}": {} } },
        { providers: { synthetic: { settings: { "{env:SYNTHETIC_CONFIG_REFERENCE}": "literal" } } } },
      ]) {
        configText = JSON.stringify(input)
        const result = yield* Effect.exit(config.snapshot())
        const error = Exit.isFailure(result) ? Option.getOrUndefined(Cause.findErrorOption(result.cause)) : undefined
        expect(error).toBeInstanceOf(StandaloneConfig.InvalidError)
        expect(error).toMatchObject({ reason: "environment-reference" })
        expect(environmentReads).toBe(0)
        expect(configFileReads).toBe(0)
      }
      configText = JSON.stringify({ default_agent: "god", mcp: { ignored: { command: "{env:SYNTHETIC_CONFIG_REFERENCE}", "{file:/synthetic/private}": "literal" } } })
      expect((yield* config.snapshot()).entries[0]?.info.default_agent).toBe("god")
      expect(environmentReads).toBe(0)
      expect(configFileReads).toBe(0)
    }).pipe(Effect.ensuring(Effect.sync(() => {
      Object.defineProperty(process, "env", descriptor)
      configText = '{"default_agent":"{file:/synthetic/private}"}'
    })))
  }),
)

fileConfig.effect("publishes immutable standalone configuration snapshots", () =>
  Effect.gen(function* () {
    configText = JSON.stringify({ default_agent: "god", providers: { synthetic: { settings: { baseURL: "https://synthetic.invalid" } } } })
    const locations = yield* LocationServiceMap.Service
    const config = yield* StandaloneConfig.Service.pipe(Effect.provide(locations.get(ref, [StandaloneConfig.node], "standalone")))
    const snapshot = yield* config.snapshot()
    expect(snapshot.entries[0]?.info.providers?.synthetic?.settings?.baseURL).toBe("https://synthetic.invalid")
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.entries)).toBe(true)
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true)
    expect(Object.isFrozen(snapshot.entries[0]?.info)).toBe(true)
    expect(Object.isFrozen(snapshot.entries[0]?.info.providers?.synthetic?.settings)).toBe(true)
  }).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

fileConfig.effect("keeps an evicted standalone configuration leased until its actual scope closes", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"god"}'
    const locations = yield* LocationServiceMap.Service
    const lease = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(lease, Exit.void))
    const context = yield* locations.contextEffect(ref, [StandaloneConfig.node], "standalone").pipe(Effect.provideService(Scope.Scope, lease))
    const config = Context.get(context, StandaloneConfig.Service)
    const initial = yield* config.snapshot()
    yield* locations.invalidate(ref, "standalone")
    expect((yield* config.snapshot()).generation).toBe(initial.generation)
    yield* Scope.close(lease, Exit.void)
    const closed = yield* Effect.exit(config.snapshot())
    const error = Exit.isFailure(closed) ? Option.getOrUndefined(Cause.findErrorOption(closed.cause)) : undefined
    expect(error).toBeInstanceOf(StandaloneConfig.InvalidError)
    expect(error).toMatchObject({ reason: "closed" })
    expect(Exit.isFailure(yield* Effect.exit(config.assert(initial.generation)))).toBe(true)
    const next = yield* locations.contextEffect(ref, [StandaloneConfig.node], "standalone")
    const fresh = Context.get(next, StandaloneConfig.Service)
    expect(fresh).not.toBe(config)
    expect(Config.latest((yield* fresh.snapshot()).entries, "default_agent")).toBe("god")
  }).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

const failedRetiringEntered = Deferred.makeUnsafe<void>()
const failedRetiringRelease = Deferred.makeUnsafe<void>()
let failedRetiringBuilds = 0
const failedRetiring = testEffect(AppNodeBuilder.build(LocationServiceMap.node, [[SessionTodo.node, makeLocationNode({
  service: SessionTodo.Service,
  layer: Layer.effect(SessionTodo.Service, Effect.gen(function* () {
    failedRetiringBuilds++
    if (failedRetiringBuilds === 1) {
      yield* Deferred.succeed(failedRetiringEntered, undefined)
      yield* Deferred.await(failedRetiringRelease)
      return yield* Effect.fail(new Error("Synthetic retired constructor failure"))
    }
    return SessionTodo.Service.of({ get: () => Effect.succeed([]), update: () => Effect.void })
  })),
  deps: [],
})]]))

failedRetiring.effect("keeps a replacement standalone entry when a retired constructor fails", () =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Effect.addFinalizer(() => Deferred.succeed(failedRetiringRelease, undefined).pipe(Effect.asVoid))
    const building = yield* locations.contextEffect(ref, [SessionTodo.node], "standalone").pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
    yield* awaitNativeBoundary(failedRetiringEntered, Fiber.join(building))
    yield* locations.invalidate(ref, "standalone")
    const next = yield* locations.contextEffect(ref, [SessionTodo.node], "standalone")
    const fresh = Context.get(next, SessionTodo.Service)
    yield* Deferred.succeed(failedRetiringRelease, undefined)
    expect(Exit.isFailure(yield* Fiber.join(building))).toBe(true)
    expect((yield* locations.loaded()).some((entry) => entry.scope === "standalone" && entry.ref.directory === ref.directory)).toBe(true)
    const current = yield* locations.contextEffect(ref, [SessionTodo.node], "standalone")
    expect(Context.get(current, SessionTodo.Service)).toBe(fresh)
    expect(failedRetiringBuilds).toBe(2)
  }),
)

fileConfig.effect("rejects selected file-reference property names before schema decoding", () =>
  Effect.gen(function* () {
    configFileReads = 0
    const locations = yield* LocationServiceMap.Service
    const config = yield* StandaloneConfig.Service.pipe(Effect.provide(locations.get(ref, [StandaloneConfig.node], "standalone")))
    for (const input of [
      { providers: { "{file:/synthetic/private}": {} } },
      { providers: { synthetic: { settings: { "{file:/synthetic/private}": "literal" } } } },
    ]) {
      configText = JSON.stringify(input)
      const result = yield* Effect.exit(config.snapshot())
      const error = Exit.isFailure(result) ? Option.getOrUndefined(Cause.findErrorOption(result.cause)) : undefined
      expect(error).toBeInstanceOf(StandaloneConfig.InvalidError)
      expect(error).toMatchObject({ reason: "file-reference" })
    }
    expect(configFileReads).toBe(0)
  }).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

fileConfig.effect("rejects malformed standalone configuration and revokes prior generations", () =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const config = yield* StandaloneConfig.Service.pipe(Effect.provide(locations.get(ref, [StandaloneConfig.node], "standalone")))
    for (const invalid of ["", " ", "{", "[]", '{"default_agent":7}']) {
      configText = '{"default_agent":"god"}'
      const initial = yield* config.snapshot()
      configText = invalid
      const result = yield* Effect.exit(config.snapshot())
      expect(Exit.isFailure(result) && Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(StandaloneConfig.InvalidError)
      configText = '{"default_agent":"god"}'
      yield* config.reload()
      expect(Exit.isFailure(yield* Effect.exit(config.assert(initial.generation)))).toBe(true)
    }
  }).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

fileConfig.effect("keeps standalone config reload fail-closed after a forbidden file reference", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"safe"}'
    configFileReads = 0
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const config = yield* StandaloneConfig.Service
      const initial = yield* config.snapshot()
      expect(initial.entries.some((entry) => entry.info.default_agent === "safe")).toBe(true)
      configText = '{"default_agent":"{file:/synthetic/private}"}'
      expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(config.snapshot()))).toBe(true)
      expect(configFileReads).toBe(0)
      configText = '{"default_agent":"safe"}'
      yield* config.reload()
      expect(Exit.isFailure(yield* Effect.exit(config.assert(initial.generation)))).toBe(true)
    }).pipe(Effect.provide(locations.get(ref, [StandaloneConfig.node], "standalone")), Effect.ensuring(Effect.sync(() => {
      configText = '{"default_agent":"{file:/synthetic/private}"}'
    })))
  }),
)

fileConfig.effect("fails closed on unreadable global config and revokes generations on identical recovery", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"god"}'
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const config = yield* StandaloneConfig.Service
      const initial = yield* config.snapshot()
      configReadMode = "denied"
      expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(config.snapshot()))).toBe(true)
      configReadMode = "ok"
      yield* config.reload()
      expect(Exit.isFailure(yield* Effect.exit(config.assert(initial.generation)))).toBe(true)
      const recovered = yield* config.snapshot()
      configReadMode = "io"
      expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
      configReadMode = "ok"
      yield* config.reload()
      expect(Exit.isFailure(yield* Effect.exit(config.assert(recovered.generation)))).toBe(true)
    }).pipe(Effect.provide(locations.get(ref, [StandaloneConfig.node], "standalone")))
  }).pipe(Effect.ensuring(Effect.sync(() => { configReadMode = "ok"; configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

fileConfig.effect("does not publish a standalone config read after its scope closes", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"god"}'
    const owner = yield* Scope.make()
    const context = yield* Layer.buildWithScope(LayerNode.compile(StandaloneConfig.node, configOverrides), owner)
    const config = Context.get(context, StandaloneConfig.Service)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    configReadGate = { entered, release }
    const reading = yield* config.snapshot().pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(entered)
    yield* Scope.close(owner, Exit.void)
    configReadGate = undefined
    yield* Deferred.succeed(release, undefined)
    expect(Exit.isFailure(yield* Fiber.join(reading))).toBe(true)
  }).pipe(Effect.ensuring(Effect.sync(() => { configReadGate = undefined; configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

fileConfig.effect("revokes a standalone generation after a read error and identical recovery", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"god"}'
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const config = yield* StandaloneConfig.Service
      const initial = yield* config.snapshot()
      configReadMode = "io"
      expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
      configReadMode = "ok"
      yield* config.reload()
      expect(Exit.isFailure(yield* Effect.exit(config.assert(initial.generation)))).toBe(true)
    }).pipe(Effect.provide(locations.get(ref, [StandaloneConfig.node], "standalone")))
  }).pipe(Effect.ensuring(Effect.sync(() => { configReadMode = "ok"; configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

fileConfig.effect("serializes a blocked generation assertion with reload", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"god"}'
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const config = yield* StandaloneConfig.Service
      const initial = yield* config.snapshot()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      configReadGate = { entered, release }
      const checking = yield* config.assert(initial.generation).pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(entered)
      configText = '{"default_agent":"GSD"}'
      configReadGate = undefined
      const reloading = yield* config.reload().pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(checking))).toBe(true)
      yield* Fiber.join(reloading)
      expect((yield* config.snapshot()).generation).not.toBe(initial.generation)
    }).pipe(Effect.provide(locations.get(ref, [StandaloneConfig.node], "standalone")))
  }).pipe(Effect.ensuring(Effect.sync(() => { configReadGate = undefined; configText = '{"default_agent":"{file:/synthetic/private}"}' }))),
)

fileConfig.effect("permanently revokes retained standalone tool dispatch and requires fresh materialization after repair", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"god"}'
    configFileReads = 0
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const context = yield* locations.contextEffect(ref, [StandaloneTools.node, StandaloneConfig.node, SessionTodo.node, StandalonePermissionService.node], "standalone")
      const db = (yield* Database.Service).db
      const sessionID = SessionSchema.ID.make("ses_config_tool_reload")
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, scope: "standalone", project_id: Project.ID.global, directory: ref.directory, title: "Synthetic" }).run()
      const config = Context.get(context, StandaloneConfig.Service)
      const registry = Context.get(context, StandaloneTools.Service)
      const todos = Context.get(context, SessionTodo.Service)
      const tools = yield* registry.materialize()
      const items = [{ content: "Synthetic accepted item", status: "pending" as const, priority: "medium" as const }]
      const call = { sessionID, agent: Agent.ID.make("god"), messageID: SessionMessage.ID.make("msg_config_tool_reload"), call: { type: "tool-call" as const, id: "call_todo", name: "todowrite", input: { todos: items } } }
      expect((yield* tools.settle(call)).error).toBeUndefined()
      expect(yield* todos.get(sessionID)).toEqual(items)
      const changed = { ...call, call: { ...call.call, input: { todos: [{ ...items[0]!, content: "Synthetic stale item" }] } } }
      configText = '{"default_agent":"{file:/synthetic/private}"}'
      expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
      const rejected = yield* Effect.exit(tools.settle(changed))
      expect(Exit.isFailure(rejected) && Option.getOrUndefined(Cause.findErrorOption(rejected.cause))).toBeInstanceOf(StandaloneConfig.InvalidError)
      expect(configFileReads).toBe(0)
      expect(yield* todos.get(sessionID)).toEqual(items)
      const before = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
      configText = '{"default_agent":"god"}'
      yield* config.reload()
      const settled = yield* Deferred.make<void>()
      const settling = yield* tools.settle(changed).pipe(Effect.exit, Effect.tap(() => Deferred.succeed(settled, undefined)), Effect.forkScoped({ startImmediately: true }))
      yield* adjust("500 millis")
      const pending = yield* Context.get(context, StandalonePermissionService.Service).list()
      const after = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
      expect({ todos: yield* todos.get(sessionID), pending: pending.map((request) => ({ id: request.id, sessionID: request.sessionID })), events: after.length }).toEqual({ todos: items, pending: [], events: before.length })
      expect(yield* Deferred.isDone(settled)).toBe(true)
      const stale = yield* Fiber.join(settling)
      expect(Exit.isFailure(stale) && Option.getOrUndefined(Cause.findErrorOption(stale.cause))).toBeInstanceOf(StandaloneConfig.InvalidError)
      expect(yield* todos.get(sessionID)).toEqual(items)
      const materialized = yield* Deferred.make<void>()
      const materializing = yield* registry.materialize().pipe(Effect.onExit(() => Deferred.succeed(materialized, undefined)), Effect.forkScoped({ startImmediately: true }))
      yield* adjust("500 millis")
      expect(yield* Deferred.isDone(materialized)).toBe(true)
      const fresh = yield* Fiber.join(materializing)
      expect((yield* fresh.settle(changed)).error).toBeUndefined()
      expect(yield* todos.get(sessionID)).toEqual(changed.call.input.todos)
    }).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' })))
  }),
)

fileConfig.effect("enforces a reloaded deny on retained standalone task_complete dispatch", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"god"}'
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const context = yield* locations.contextEffect(ref, [StandaloneTools.node, StandaloneConfig.node], "standalone")
      const db = (yield* Database.Service).db
      const sessionID = SessionSchema.ID.make("ses_config_tool_deny")
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, scope: "standalone", project_id: Project.ID.global, directory: ref.directory, title: "Synthetic" }).run()
      const config = Context.get(context, StandaloneConfig.Service)
      const tools = yield* Context.get(context, StandaloneTools.Service).materialize()
      const call = { sessionID, agent: Agent.ID.make("god"), messageID: SessionMessage.ID.make("msg_config_tool_deny"), call: { type: "tool-call" as const, id: "call_complete", name: "task_complete", input: {} } }
      expect((yield* tools.settle(call)).error).toBeUndefined()
      configText = '{"default_agent":"god","permissions":[{"action":"task_complete","resource":"*","effect":"deny"}]}'
      yield* config.reload()
      const stale = yield* Effect.exit(tools.settle(call))
      expect(Exit.isFailure(stale) && Option.getOrUndefined(Cause.findErrorOption(stale.cause))).toBeInstanceOf(StandaloneConfig.InvalidError)
      const materialized = yield* Deferred.make<void>()
      const materializing = yield* Context.get(context, StandaloneTools.Service).materialize().pipe(Effect.onExit(() => Deferred.succeed(materialized, undefined)), Effect.forkScoped({ startImmediately: true }))
      yield* adjust("500 millis")
      expect(yield* Deferred.isDone(materialized)).toBe(true)
      const fresh = yield* Fiber.join(materializing)
      expect((yield* fresh.settle(call)).error).toBeDefined()
    }).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' })))
  }),
)

fileConfig.effect("enforces the Session permission ceiling and ownership on standalone task_complete", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"god"}'
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const context = yield* locations.contextEffect(ref, [StandaloneTools.node], "standalone")
      const db = (yield* Database.Service).db
      const sessionID = SessionSchema.ID.make("ses_task_complete_deny")
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, scope: "standalone", project_id: Project.ID.global, directory: ref.directory, title: "Synthetic", permission: [
        { action: "task_complete", resource: "*", effect: "deny" },
        { action: "goal", resource: "get", effect: "deny" },
      ] }).run()
      const tools = yield* Context.get(context, StandaloneTools.Service).materialize()
      const call = { sessionID, agent: Agent.ID.make("god"), messageID: SessionMessage.ID.make("msg_task_complete_deny"), call: { type: "tool-call" as const, id: "call_complete", name: "task_complete", input: {} } }
      expect((yield* tools.settle(call)).error).toBeDefined()
      expect((yield* tools.settle({ ...call, call: { ...call.call, name: "goal", input: { action: "get" } } })).error).toBeDefined()
      expect((yield* tools.settle({ ...call, sessionID: SessionSchema.ID.make("ses_missing_owner") })).error).toBeDefined()
      const other = SessionSchema.ID.make("ses_other_location")
      yield* db.insert(SessionTable).values({ id: other, scope: "standalone", project_id: Project.ID.global, directory: "/synthetic/other", title: "Synthetic" }).run()
      const bound = SessionSchema.ID.make("ses_wrong_scope")
      yield* db.insert(SessionTable).values({ id: bound, scope: "bound", project_id: Project.ID.global, directory: ref.directory, title: "Synthetic" }).run()
      const workspace = SessionSchema.ID.make("ses_wrong_workspace")
      yield* db.insert(SessionTable).values({ id: workspace, scope: "standalone", project_id: Project.ID.global, directory: ref.directory, workspace_id: WorkspaceID.make("wrk_other"), title: "Synthetic" }).run()
      for (const target of [other, bound, workspace])
        for (const name of ["question", "todowrite", "goal", "task_complete"])
          expect((yield* tools.settle({ ...call, sessionID: target, call: { ...call.call, name } })).error?.type).toBe("tool.scope_unavailable")
    }).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' })))
  }),
)

const forbiddenBuilds: string[] = []
const forbid = <A, I>(service: Context.Service<A, I>, name: string) => Layer.effect(service, Effect.sync(() => {
  forbiddenBuilds.push(name)
  throw new Error(`Forbidden constructor: ${name}`)
}))
const coldExecution = testEffect(AppNodeBuilder.build(LayerNode.group([SessionExecution.node, LocationServiceMap.node, Database.node]), [
  [Global.node, Layer.succeed(Global.Service, Global.make({ config: "/synthetic/standalone-config" }))],
  [AppProcess.node, forbid(AppProcess.Service, "AppProcess")],
  [Project.node, forbid(Project.Service, "Project")],
  [Git.node, forbid(Git.Service, "Git")],
  [Shell.node, forbid(Shell.Service, "Shell")],
  [PluginSupervisor.node, forbid(PluginSupervisor.Service, "PluginSupervisor")],
  [Npm.node, forbid(Npm.Service, "Npm")],
  [WellKnown.node, forbid(WellKnown.Service, "WellKnown")],
]))
const projectionRegistrations: { type: string; runtime: EventRuntime.Interface }[] = []
const projectionInvocations: string[] = []
let trackedDatabase: Database.Interface | undefined
let trackedRuntime: EventRuntime.Interface | undefined
const trackedEvents = makeGlobalNode({
  service: EventRuntime.Service,
  layer: Layer.effect(EventRuntime.Service, Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    trackedRuntime = events
    trackedDatabase = yield* Database.Service
    return EventRuntime.Service.of({
      ...events,
      project: (definition, projector) => Effect.sync(() => { projectionRegistrations.push({ type: definition.type, runtime: events }) }).pipe(
        Effect.andThen(events.project(definition, (event) => Effect.sync(() => { projectionInvocations.push(definition.type) }).pipe(Effect.andThen(projector(event))))),
      ),
    })
  })).pipe(Layer.provide(EventRuntime.layer)),
  deps: [Database.node],
})
const trackedReplacements = [
  [EventRuntime.node, trackedEvents],
  [AppProcess.node, forbid(AppProcess.Service, "AppProcess")],
  [Project.node, forbid(Project.Service, "Project")],
  [Git.node, forbid(Git.Service, "Git")],
  [Shell.node, forbid(Shell.Service, "Shell")],
  [PluginSupervisor.node, forbid(PluginSupervisor.Service, "PluginSupervisor")],
  [Npm.node, forbid(Npm.Service, "Npm")],
  [WellKnown.node, forbid(WellKnown.Service, "WellKnown")],
] as const
const trackedExecution = testEffect(AppNodeBuilder.build(LayerNode.group([SessionExecution.node, LocationServiceMap.node, Database.node, EventRuntime.node]), trackedReplacements))
const trackedMap = testEffect(AppNodeBuilder.build(LayerNode.group([LocationServiceMap.node, Database.node, EventRuntime.node]), trackedReplacements))

coldExecution.effect("cold SessionExecution and outer LocationServiceMap construct without forbidden host services", () =>
  Effect.gen(function* () {
    yield* SessionExecution.Service
    expect(forbiddenBuilds).toEqual([])
  }),
)

coldExecution.effect("preflights a conflicting managed owner without scheduling work", () =>
  Effect.gen(function* () {
    const execution = yield* SessionExecution.Service
    const owner = { pid: process.pid, pgid: process.pid, started: "synthetic-first" }
    for (const invalid of [{ ...owner, pid: process.pid + 1 }, { ...owner, started: " " }]) {
      const result = yield* Effect.exit(execution.prepareTask(invalid))
      expect(Exit.isFailure(result) && Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(ScopeUnavailableError)
    }
    yield* execution.prepareTask(owner)
    for (const conflict of [{ ...owner, started: "synthetic-conflict" }, { ...owner, pgid: owner.pgid + 1 }]) {
      const result = yield* Effect.exit(execution.prepareTask(conflict))
      expect(Exit.isFailure(result) && Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(ScopeUnavailableError)
    }
    expect(yield* execution.active).toEqual(new Set())
  }),
)

coldExecution.effect("resolves the standalone direct tools without forbidden host constructors", () =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const tools = yield* StandaloneTools.Service.pipe(Effect.provide(locations.get(ref, [StandaloneTools.node], "standalone")))
    expect((yield* tools.materialize()).definitions.map((tool) => tool.name).sort()).toEqual(["goal", "question", "task_complete", "todowrite"])
    expect(forbiddenBuilds).toEqual([])
  }),
)

coldExecution.effect("constructs the real standalone runner without forbidden host constructors", () =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* SessionRunner.Service.pipe(Effect.provide(locations.get(ref, [SessionRunnerLLM.node], "standalone")))
    expect(forbiddenBuilds).toEqual([])
  }),
)

coldExecution.effect("selects standalone context without host instructions or constructors", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sessionID = SessionSchema.ID.make("ses_standalone_context")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: sessionID, scope: "standalone", project_id: Project.ID.global, directory: ref.directory, title: "Synthetic" }).run()
    const locations = yield* LocationServiceMap.Service
    const selected = yield* SessionContext.Service.use((context) => context.select(sessionID)).pipe(
      Effect.provide(locations.get(ref, [SessionContext.node], "standalone")),
    )
    expect(selected.session.scope).toBe("standalone")
    const admitted = Object.keys((yield* Instructions.diff(yield* Instructions.read(selected.instructions))).delta)
    expect(admitted).toContain("core/date")
    for (const key of ["core/environment", "core/git-worktree", "core/git-attribution", "core/shell-memory"])
      expect(admitted).not.toContain(key)
    expect(forbiddenBuilds).toEqual([])
  }),
)

trackedExecution.effect("registers shared analytics once when the outer execution precedes standalone tools", () =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const before = projectionRegistrations.filter((entry) => entry.type === SessionEvent.ProviderRequestRecorded.type).length
    yield* StandaloneTools.Service.pipe(Effect.provide(locations.get(ref, [StandaloneTools.node], "standalone")))
    const registrations = projectionRegistrations.filter((entry) => entry.type === SessionEvent.ProviderRequestRecorded.type)
    expect(new Set(registrations.map((entry) => entry.runtime)).size).toBe(1)
    expect(before).toBe(2)
    expect(registrations).toHaveLength(before)
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    expect(trackedDatabase?.db).toBe(database.db)
    const sessionID = SessionSchema.ID.make("ses_shared_projection")
    yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] }).run()
    yield* database.db.insert(SessionTable).values({ id: sessionID, scope: "standalone", project_id: Project.ID.global, directory: ref.directory, title: "Synthetic" }).run()
    yield* events.publish(SessionEvent.ProviderRequestRecorded, {
      id: ProviderRequest.ID.make("prq_shared_projection"), sessionID, source: "step", agent: Agent.ID.make("build"),
      model: CatalogModel.Ref.make({ providerID: Provider.ID.make("synthetic"), id: CatalogModel.ID.make("model") }),
      routeID: "synthetic", promptCacheKey: "namespace", systemDigest: "system", toolDigest: "tools", request: 1,
      attempts: 2, invalidation: "first-request", continuation: "full", cost: Money.USD.make(3),
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, time: DateTime.makeUnsafe(1),
    })
    expect(projectionInvocations.filter((type) => type === SessionEvent.ProviderRequestRecorded.type)).toHaveLength(2)
    expect(yield* database.db.select().from(SessionProviderRequestTable).all()).toHaveLength(1)
    expect(yield* database.db.select().from(UsageAnalyticsRequestTable).all()).toHaveLength(1)
    const usage = yield* database.db.select().from(SessionUsageTable).all()
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ logical: 1, physical: 2, cost: 3, input: 1, output: 2, reasoning: 3, cache_read: 4, cache_write: 5 })
    expect(forbiddenBuilds).toEqual([])
  }),
)

trackedMap.effect("shares projections when standalone tools precede execution", () =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* StandaloneTools.Service.pipe(Effect.provide(locations.get(ref, [StandaloneTools.node], "standalone")))
    const runtime = trackedRuntime
    const before = projectionRegistrations.filter((entry) => entry.runtime === runtime && entry.type === SessionEvent.ProviderRequestRecorded.type).length
    const database = yield* Database.Service
    yield* SessionExecution.Service.pipe(Effect.provide(AppNodeBuilder.build(SessionExecution.node, trackedReplacements)))
    const registrations = projectionRegistrations.filter((entry) => entry.runtime === runtime && entry.type === SessionEvent.ProviderRequestRecorded.type)
    expect(trackedRuntime).toBe(runtime)
    expect(trackedDatabase?.db).toBe(database.db)
    expect(before).toBe(2)
    expect(registrations).toHaveLength(before)
    expect(forbiddenBuilds).toEqual([])
  }),
)

let credentialWrites = 0
let pluginFilesystemAttempts = 0
let installs = 0
let supervisorBuilds = 0
let savedCredentials: Credential.Info[] = []
let snapshotOverride: Credential.Info | undefined
let configEntries: Config.Document[] = []
let eventRuntime: EventRuntime.Interface | undefined
const syntheticProvider = Provider.ID.make("synthetic-openai")
const syntheticIntegration = Integration.ID.make(syntheticProvider)
const syntheticModel = CatalogModel.ID.make("synthetic-model")
const metadata = testEffect(AppNodeBuilder.build(LayerNode.group([LocationServiceMap.node, Database.node]), [
  [Project.node, projectLayer],
  [Global.node, Layer.succeed(Global.Service, Global.make({ config: "/synthetic/global" }))],
  [FSUtil.node, Layer.effect(FSUtil.Service, Effect.map(FSUtil.Service, (fs) => FSUtil.Service.of({
    ...fs,
    readFileStringSafe: (path) => {
      const index = path === "/synthetic/global/ycoding.json" ? 0 : path === "/synthetic/global/ycoding.jsonc" ? 1 : -1
      return index < 0 ? fs.readFileStringSafe(path) : Effect.succeed(configEntries[index] ? JSON.stringify(configEntries[index].info) : undefined)
    },
    readFileString: (path) => {
      const index = path === "/synthetic/global/ycoding.json" ? 0 : path === "/synthetic/global/ycoding.jsonc" ? 1 : -1
      if (index < 0) return fs.readFileString(path)
      return configEntries[index] ? Effect.succeed(JSON.stringify(configEntries[index].info)) : Effect.fail(configError("NotFound"))
    },
    stat: (path) => { pluginFilesystemAttempts++; return fs.stat(path) },
    isFile: (path) => { pluginFilesystemAttempts++; return fs.isFile(path) },
    readDirectoryEntries: (path) => { pluginFilesystemAttempts++; return fs.readDirectoryEntries(path) },
    scan: (pattern, options) => { pluginFilesystemAttempts++; return fs.scan(pattern, options) },
  }))).pipe(Layer.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))],
  [Npm.node, Layer.mock(Npm.Service, {
    add: () => { installs++; return Effect.die("unexpected install") },
  })],
  [PluginSupervisor.node, Layer.tap(Layer.mock(PluginSupervisor.Service, {}), () => Effect.sync(() => { supervisorBuilds++ }))],
  [EventRuntime.node, makeGlobalNode({
    service: EventRuntime.Service,
    layer: Layer.tap(EventRuntime.layer, (context) => Effect.sync(() => { eventRuntime = Context.get(context, EventRuntime.Service) })),
    deps: [Database.node],
  })],
  [AppProcess.node, Layer.mock(AppProcess.Service, {
    run: () => Effect.succeed({ command: "ps", exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), stdoutTruncated: false, stderrTruncated: false }),
  })],
  [ModelsDev.standaloneNode, Layer.mock(ModelsDev.ReadonlyService, {
    get: () => Effect.succeed([{
      info: { id: syntheticProvider, name: "Synthetic OpenAI", package: "@ycoding-ai/ai/providers/openai" },
      models: [{ ...CatalogModel.Info.empty(syntheticProvider, syntheticModel), package: "@ycoding-ai/ai/providers/openai" }],
      environment: ["SYNTHETIC_OPENAI_KEY"],
    }]),
  })],
  [Config.globalNode, Layer.mock(Config.GlobalService, {
    reload: () => Effect.void,
    snapshot: () => Effect.succeed({ entries: configEntries, diagnostics: [] }),
    subscribe: () => () => {},
  })],
  [Credential.node, Layer.mock(Credential.Service, {
    all: () => Effect.succeed([...savedCredentials]),
    list: (id) => Effect.succeed(savedCredentials.filter((item) => item.integrationID === id)),
    get: (id) => Effect.succeed(snapshotOverride ?? savedCredentials.find((item) => item.id === id)),
    create: () => { credentialWrites++; return Effect.die("unexpected credential write") },
    update: () => { credentialWrites++; return Effect.die("unexpected credential write") },
    remove: () => { credentialWrites++; return Effect.die("unexpected credential write") },
    activate: () => { credentialWrites++; return Effect.die("unexpected credential write") },
    refresh: () => { credentialWrites++; return Effect.die("unexpected credential refresh") },
  })],
]))

metadata.effect("S2-01 standalone construction exposes built-in catalog metadata and auth descriptors without writes", () => Effect.gen(function* () {
  credentialWrites = 0
  installs = 0
  savedCredentials = []
  configEntries = []
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [...CatalogContributions.nodes, Integration.standaloneNode], "standalone")
  const catalog = Context.get(context, Catalog.Service)
  const integrations = Context.get(context, Integration.StandaloneService)
  expect((yield* catalog.provider.all()).map((provider) => provider.id)).toContain(syntheticProvider)
  expect((yield* catalog.model.all()).map((model) => model.id)).toContain(syntheticModel)
  const integration = yield* integrations.get(syntheticIntegration)
  expect(integration?.methods).toContainEqual({ type: "key" })
  expect(credentialWrites).toBe(0)
  expect(installs).toBe(0)
}))

metadata.effect("standalone runner exposes only four session-local tools", () => Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [StandaloneTools.node], "standalone")
  const materialized = yield* Context.get(context, StandaloneTools.Service).materialize()
  expect(materialized.definitions.map((tool) => tool.name).sort()).toEqual(["goal", "question", "task_complete", "todowrite"])
  const sessionID = Session.ID.make("ses_synthetic_tools")
  const db = (yield* Database.Service).db
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] }).run()
  yield* db.insert(SessionTable).values({ id: sessionID, scope: "standalone", project_id: Project.ID.global, directory: ref.directory, title: "Synthetic" }).run()
  const base = { sessionID, agent: Agent.ID.make("god"), messageID: SessionMessage.ID.make("msg_synthetic_tools") }
  for (const name of ["execute", "shell", "read", "webfetch", "subagent", "memory", "skill"]) {
    const settled = yield* materialized.settle({ ...base, call: { type: "tool-call", id: `call_${name}`, name, input: {} } })
    expect(settled.error?.type).toBe("tool.unknown")
  }
  const complete = yield* materialized.settle({ ...base, call: { type: "tool-call", id: "call_complete", name: "task_complete", input: {} } })
  expect(complete.error).toBeUndefined()
}))

metadata.effect("standalone agents retain built-ins without discovered custom agents", () => Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [Agent.node], "standalone")
  const agents = Context.get(context, Agent.Service)
  expect((yield* agents.default())?.id).toBe(Agent.defaultID)
  const system = (yield* agents.get(Agent.defaultID))?.system ?? ""
  expect(system).toContain("question, todowrite, goal, task_complete")
  expect(system).toContain("no host filesystem, shell, worktree, subagent, plugin, skill, MCP, or network access")
  expect(system).not.toContain("Delegate execution")
  expect(system).not.toContain("MAINCHAT_CAPABILITIES")
  for (const id of ["god", "compaction", "title", "goal", "summary", "decision", "yolo-permission", "yolo-guardrail", "yolo-answer"])
    expect(yield* agents.get(Agent.ID.make(id))).toBeDefined()
  expect(yield* agents.get(Agent.ID.make("synthetic-custom"))).toBeUndefined()
  expect(supervisorBuilds).toBe(0)
}))

metadata.effect("S2-04 external declarations never trigger plugin scanning", () => Effect.gen(function* () {
  let scans = 0
  const scan = spyOn(PluginOperations, "scan").mockImplementation(() => {
    scans++
    return Effect.die("unexpected plugin scan")
  })
  savedCredentials = []
  credentialWrites = 0
  pluginFilesystemAttempts = 0
  installs = 0
  supervisorBuilds = 0
  const sentinel = globalThis as typeof globalThis & { __standalonePluginEvaluations?: number }
  const previousEvaluations = sentinel.__standalonePluginEvaluations
  sentinel.__standalonePluginEvaluations = 0
  configEntries = [
    new Config.Document({ type: "document", scope: "global", info: Config.Info.make({
      plugins: ["synthetic-package", new URL("./fixture/standalone-plugin-sentinel.ts", import.meta.url).href, "./fixture/standalone-plugin-sentinel.ts"],
    }) }),
  ]
  try {
    const locations = yield* LocationServiceMap.Service
    const context = yield* locations.contextEffect(ref, CatalogContributions.nodes, "standalone")
    expect((yield* Context.get(context, Catalog.Service).provider.all()).map((provider) => provider.id)).toContain(syntheticProvider)
    expect(scans).toBe(0)
    expect(pluginFilesystemAttempts).toBe(0)
    expect(installs).toBe(0)
    expect(supervisorBuilds).toBe(0)
    expect(sentinel.__standalonePluginEvaluations).toBe(0)
    expect(credentialWrites).toBe(0)
  } finally {
    scan.mockRestore()
    if (previousEvaluations === undefined) delete sentinel.__standalonePluginEvaluations
    else sentinel.__standalonePluginEvaluations = previousEvaluations
    configEntries = []
  }
}))

metadata.effect("S2-05 updates, delayed reconciliation and scope disposal cannot mutate credentials", () => Effect.gen(function* () {
  savedCredentials = []
  configEntries = []
  credentialWrites = 0
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, CatalogContributions.nodes, "standalone")
  const catalog = Context.get(context, Catalog.Service)
  const events = eventRuntime
  if (!events) return yield* Effect.die("event runtime unavailable")
  yield* catalog.provider.all()
  yield* events.publish(Event.Updated, {})
  yield* events.publish(Integration.Event.ConnectionUpdated, { integrationID: syntheticIntegration })
  yield* adjust("61 seconds")
  yield* catalog.provider.all()
  yield* locations.invalidate(ref, "standalone")
  expect(credentialWrites).toBe(0)
}))

metadata.effect("S2-06 legacy credentials remain unchanged during standalone activation", () => Effect.gen(function* () {
  configEntries = []
  credentialWrites = 0
  savedCredentials = [
    Credential.Info.make({ id: Credential.ID.make("cred_synthetic_legacy"), integrationID: Integration.ID.make("anthropic"), label: "legacy", value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("claude-setup-token"), access: "synthetic-setup-token", refresh: "synthetic-refresh", expires: 0 }) }),
    Credential.Info.make({ id: Credential.ID.make("cred_synthetic_unmanaged"), integrationID: Integration.ID.make("anthropic"), label: "unmanaged", value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("claude-code"), access: "synthetic-access", refresh: "synthetic-refresh", expires: 0 }) }),
  ]
  const before = structuredClone(savedCredentials)
  const locations = yield* LocationServiceMap.Service
  yield* locations.contextEffect(ref, CatalogContributions.nodes, "standalone")
  expect(savedCredentials).toEqual(before)
  expect(credentialWrites).toBe(0)
}))

metadata.effect("S2-07 absent and expired credentials never trigger activation or refresh", () => Effect.gen(function* () {
  configEntries = []
  credentialWrites = 0
  const locations = yield* LocationServiceMap.Service
  const previous = process.env.CURSOR_API_KEY
  process.env.CURSOR_API_KEY = "synthetic-ambient-key"
  try {
    for (const credentials of [[], [Credential.Info.make({
      id: Credential.ID.make("cred_synthetic_cursor"), integrationID: Integration.ID.make("cursor"), label: "expired",
      value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("cursor"), access: "synthetic-expired", refresh: "synthetic-refresh", expires: 0 }),
    })]]) {
      savedCredentials = credentials
      yield* locations.contextEffect(ref, CatalogContributions.nodes, "standalone")
      yield* locations.invalidate(ref, "standalone")
      expect(credentialWrites).toBe(0)
    }
  } finally {
    if (previous === undefined) delete process.env.CURSOR_API_KEY
    else process.env.CURSOR_API_KEY = previous
  }
}))

const profile = (label: string, active: boolean, integrationID = syntheticIntegration) => Credential.Info.make({
  id: Credential.ID.make(`cred_synthetic_${label}`), integrationID, label,
  value: Credential.Key.make({ type: "key", key: `synthetic-${label}-key` }),
  active, accountGeneration: 1, generation: 1,
})
const sessionWithProfile = (modelID = syntheticModel, variant?: CatalogModel.VariantID) => Session.Info.make({
  id: Session.ID.make("ses_synthetic_standalone"), projectID: Project.ID.make("proj_standalone_sessions"), scope: "standalone",
  title: "synthetic", cost: Money.USD.zero, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) }, location: ref,
  model: { providerID: syntheticProvider, id: modelID, profile: "B", ...(variant ? { variant } : {}) },
})
const profileContext = Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  return yield* locations.contextEffect(ref, [Catalog.node, CatalogContributions.standaloneNode, StandaloneModel.node], "standalone")
})

const awaitNativeBoundary = (entered: Deferred.Deferred<void>, finished: Effect.Effect<Exit.Exit<unknown, unknown>>) =>
  Effect.raceFirst(Deferred.await(entered), finished.pipe(Effect.flatMap((result) =>
    Effect.die(Exit.isFailure(result) ? Cause.squash(result.cause) : new Error("Operation completed before the native boundary")),
  )))

const rawProviderReplacements = [
  ...configOverrides,
  [ModelsDev.standaloneNode, Layer.mock(ModelsDev.ReadonlyService, {
    get: () => Effect.succeed([{
      info: { id: syntheticProvider, name: "Synthetic OpenAI", package: "@ycoding-ai/ai/providers/openai" },
      models: [{ ...CatalogModel.Info.empty(syntheticProvider, syntheticModel), package: "@ycoding-ai/ai/providers/openai" }],
      environment: ["SYNTHETIC_OPENAI_KEY"],
    }]),
  })],
  [Credential.node, Layer.mock(Credential.Service, {
    all: () => Effect.succeed([profile("B", false)]),
    list: () => Effect.succeed([profile("B", false)]),
    get: () => Effect.succeed(profile("B", false)),
  })],
] as const
const rawProvider = testEffect(AppNodeBuilder.build(LocationServiceMap.node, rawProviderReplacements))

const runtimeRequests: string[] = []
const runtimeOwners: { database: Database.Interface; events: EventRuntime.Interface }[] = []
const runtimeDependencies: { database: Database.Interface; events: EventRuntime.Interface; boundary: ReturnType<typeof SessionStepBoundary.make>; locations: LocationServiceMap.Interface; instructions: InstructionEntry.Interface }[] = []
const runtimeNodes = LayerNode.group([SessionExecution.node, LocationServiceMap.node, Database.node, EventRuntime.node, SessionContextState.node, SessionStepBoundary.node, SessionStore.node, Global.node])
const runtimeReplacements = [
  ...rawProviderReplacements,
  [Global.node, Layer.succeed(Global.Service, Global.make({ config: "/synthetic/global", state: "/synthetic/runner-state" }))],
  [EventRuntime.node, makeGlobalNode({
    service: EventRuntime.Service,
    layer: Layer.tap(EventRuntime.layer, (context) => Effect.gen(function* () {
      const database = yield* Database.Service
      runtimeOwners.push({ database, events: Context.get(context, EventRuntime.Service) })
    })),
    deps: [Database.node],
  })],
  [InstructionEntry.node, makeLocationNode({
    service: InstructionEntry.Service,
    layer: Layer.tap(InstructionEntry.layer, (context) => Effect.gen(function* () {
      runtimeDependencies.push({ database: yield* Database.Service, events: yield* EventRuntime.Service, boundary: yield* SessionStepBoundary.Service, locations: yield* LocationServiceMap.Service, instructions: Context.get(context, InstructionEntry.Service) })
    })),
    deps: [Database.node, EventRuntime.node, SessionStepBoundary.node, LocationServiceMap.node],
  })],
  [AppProcess.node, forbid(AppProcess.Service, "AppProcess")],
  [Project.node, forbid(Project.Service, "Project")],
  [Git.node, forbid(Git.Service, "Git")],
  [Shell.node, forbid(Shell.Service, "Shell")],
  [PluginSupervisor.node, forbid(PluginSupervisor.Service, "PluginSupervisor")],
  [Npm.node, forbid(Npm.Service, "Npm")],
  [WellKnown.node, forbid(WellKnown.Service, "WellKnown")],
  [LayerNodePlatform.requestExecutor, Layer.succeed(RequestExecutor.Service, {
    execute: (request) => Effect.sync(() => {
      runtimeRequests.push(request.url)
      expect(request.url).toBe("https://api.openai.com/v1/responses")
      expect(request.headers.authorization).toBe("Bearer synthetic-B-key")
      const item = { type: "message", id: "msg_synthetic_output", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic standalone response", annotations: [] }] }
      const response = { id: "resp_synthetic", object: "response", status: "completed", model: "synthetic-model", output: [item], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Synthetic standalone response" },
        { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Synthetic standalone response" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ]
      return HttpClientResponse.fromWeb(request, new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
    }),
  })],
] as const
const persistedRunner = testEffect(AppNodeBuilder.build(runtimeNodes, runtimeReplacements))
const seedRuntimeSession = (id: string) => Effect.gen(function* () {
  configReadMode = "ok"
  configText = '{"default_agent":"god"}'
  runtimeRequests.length = 0
  const global = yield* Global.Service
  const directory = AbsolutePath.make(`${global.state}/standalone-sessions`)
  const database = yield* Database.Service
  const sessionID = SessionSchema.ID.make(id)
  yield* database.db.insert(ProjectTable).values({ id: Location.standaloneProjectID, worktree: directory, sandboxes: [] }).run()
  yield* database.db.insert(SessionTable).values({ id: sessionID, scope: "standalone", project_id: Location.standaloneProjectID, directory, title: "Synthetic", agent: "god", model: sessionWithProfile().model }).run()
  yield* SessionContextState.initialize(database.db, sessionID, 0)
  return sessionID
})

persistedRunner.effect("routes persisted standalone placement through real context loading, execution and activation", () => Effect.gen(function* () {
  const sessionID = yield* seedRuntimeSession("ses_standalone_runtime")
  const execution = yield* SessionExecution.Service
  const locations = yield* LocationServiceMap.Service
  const store = yield* SessionStore.Service
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const boundary = yield* SessionStepBoundary.Service
  const state = yield* SessionContextState.Service
  const duplicates = ["old", "retained"].map((name, position) => {
    const message = SessionMessage.User.make({ id: SessionMessage.ID.make(`msg_runtime_duplicate_${name}`), type: "user", text: "Synthetic repeated input", time: { created: DateTime.makeUnsafe(1) } })
    const { id, type, ...data } = Schema.encodeSync(SessionMessage.User)(message)
    return { kind: "message" as const, messageID: message.id, position, terminalSeq: EventRuntime.Seq.make(position + 1), inputKind: type, data, payload: Schema.decodeUnknownSync(Schema.Json)(data), tokens: 8 }
  })
  yield* database.db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 2 }).run()
  yield* database.db.insert(SessionMessageTable).values(duplicates.map((item) => ({ id: item.messageID, session_id: sessionID, type: "user" as const, seq: item.terminalSeq, data: item.data, time_created: 1, time_updated: 1 }))).run()
  yield* execution.resume(sessionID)
  yield* execution.awaitIdle(sessionID)
  const session = yield* store.get(sessionID)
  if (!session) return yield* Effect.die("Missing synthetic Session")
  expect(session.projectID).toBe(Location.standaloneProjectID)
  expect(session.scope).toBe("standalone")
  expect(runtimeRequests).toEqual(["https://api.openai.com/v1/responses"])
  expect(yield* execution.active).toEqual(new Set())
  const config = yield* Effect.gen(function* () {
    const context = yield* locations.contextEffect(session.location, [SessionContext.node, SessionLiveState.node, Location.node, StandaloneConfig.node, InstructionEntry.node], session.scope)
    expect(Context.get(context, Location.Service).project.id).toBe(session.projectID)
    const loader = Context.get(context, SessionContext.Service)
    const observed = runtimeDependencies.filter((entry) => entry.instructions === Context.get(context, InstructionEntry.Service))
    expect(observed).toHaveLength(1)
    expect(observed[0]?.locations).toBe(locations)
    expect(observed[0]?.database).toBe(database)
    expect(observed[0]?.events).toBe(events)
    expect(observed[0]?.boundary).toBe(boundary)
    expect(new Set(runtimeOwners.filter((owner) => owner.database === database).map((owner) => owner.events))).toEqual(new Set([events]))
    const loaded = yield* loader.load(yield* loader.select(sessionID))
    expect(loaded.session.projectID).toBe(Location.standaloneProjectID)
    expect(loaded.model.ref.profile).toBe("B")
    expect(loaded.contextRevision).toBe(0)
    expect(loaded.messages.some((message) => message.type === "assistant" && message.content.some((part) => part.type === "text" && part.text === "Synthetic standalone response"))).toBe(true)
    const row = yield* database.db.select().from(SessionMessageTable).where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant"))).get()
    if (!row || row.type !== "assistant") return yield* Effect.die("Missing synthetic assistant message")
    const item = { kind: "message" as const, messageID: SessionMessage.ID.make(row.id), position: 2, terminalSeq: EventRuntime.Seq.make(row.seq), inputKind: row.type, payload: Schema.decodeUnknownSync(Schema.Json)(row.data), tokens: 8 }
    const coveredThrough = { messageID: item.messageID, seq: item.terminalSeq }
    const live = yield* Context.get(context, SessionLiveState.Service).load(sessionID)
    const protectedState = SessionLiveState.toProtectedState(live.sources)
    const canonicalDuplicates = yield* Effect.forEach(duplicates, (item) => Effect.gen(function* () {
      const canonical = yield* database.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, item.messageID)).get()
      if (!canonical) return yield* Effect.die("Missing canonical duplicate input")
      return { ...item, payload: Schema.decodeUnknownSync(Schema.Json)(canonical.data) }
    }))
    const validated = ContextManifest.validate({
      candidate: { schemaVersion: 1, baseContextRevision: 0, coveredThrough, protectedState, exclusions: [{ reason: "exact_duplicate", target: ContextManifest.selector(canonicalDuplicates[0]!), evidence: ContextManifest.selector(canonicalDuplicates[1]!) }] },
      evidence: { baseContextRevision: 0, coveredThrough, items: [...canonicalDuplicates, item], settlements: [], authorities: [], resourceAuthorities: [], toolResults: [], recentTail: [], protectedTargets: [], providerLinks: [], protectedState },
    })
    if (!validated.valid) return yield* Effect.die(validated.issues)
    expect((yield* state.activate({ sessionID, manifest: validated.manifest })).revision).toBe(1)
    const compacted = yield* loader.load(yield* loader.select(sessionID))
    expect(compacted.contextRevision).toBe(1)
    expect(compacted.messages.some((message) => message.id === duplicates[0]!.messageID)).toBe(false)
    expect(compacted.messages.some((message) => message.id === duplicates[1]!.messageID)).toBe(true)
    return Context.get(context, StandaloneConfig.Service)
  }).pipe(Effect.scoped)
  expect(yield* database.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, sessionID)).all()).toHaveLength(1)
  expect(forbiddenBuilds).toEqual([])
  yield* locations.invalidate(session.location, session.scope)
  const closed = yield* Effect.exit(config.snapshot())
  expect(Exit.isFailure(closed) && Option.getOrUndefined(Cause.findErrorOption(closed.cause))).toMatchObject({ _tag: "StandaloneConfig.InvalidError", reason: "closed" })
}))

persistedRunner.effect("rejects retained real context selections after an identical standalone config repair", () => Effect.gen(function* () {
  const sessionID = yield* seedRuntimeSession("ses_standalone_context_generation")
  const store = yield* SessionStore.Service
  const locations = yield* LocationServiceMap.Service
  const session = yield* store.get(sessionID)
  if (!session) return yield* Effect.die("Missing synthetic Session")
  const context = yield* locations.contextEffect(session.location, [SessionContext.node, StandaloneConfig.node], session.scope)
  const loader = Context.get(context, SessionContext.Service)
  const config = Context.get(context, StandaloneConfig.Service)
  const selected = yield* loader.select(sessionID)
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  yield* InstructionState.prepare(database.db, events, selected.instructions, sessionID)
  configText = '{"default_agent":"{file:/synthetic/private}"}'
  expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
  configText = '{"default_agent":"god"}'
  yield* config.reload()
  const stale = yield* Effect.exit(loader.load(selected))
  expect(Exit.isFailure(stale) && Option.getOrUndefined(Cause.findErrorOption(stale.cause))).toBeInstanceOf(ScopeUnavailableError)
  const selectedAgain = yield* Deferred.make<void>()
  const selecting = yield* loader.select(sessionID).pipe(Effect.onExit(() => Deferred.succeed(selectedAgain, undefined)), Effect.forkScoped({ startImmediately: true }))
  expect(yield* Deferred.isDone(selectedAgain)).toBe(false)
  yield* adjust("500 millis")
  expect(yield* Deferred.isDone(selectedAgain)).toBe(true)
  const fresh = yield* Fiber.join(selecting)
  const loadedAgain = yield* Deferred.make<void>()
  const reloads = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
  const clock = yield* Clock.Clock
  let sleeping = 0
  const loading = yield* loader.load(fresh).pipe(
    Effect.provideService(Clock.Clock, {
      ...clock,
      sleep: (duration) => Effect.gen(function* () {
        expect(Duration.toMillis(duration)).toBe(500)
        const entered = reloads[sleeping++]
        if (!entered) return yield* Effect.die("Unexpected standalone registry debounce")
        yield* Deferred.succeed(entered, undefined)
        yield* clock.sleep(duration)
      }),
    }),
    Effect.onExit(() => Deferred.succeed(loadedAgain, undefined)),
    Effect.forkScoped({ startImmediately: true }),
  )
  expect(yield* Deferred.isDone(loadedAgain)).toBe(false)
  for (const entered of reloads) {
    yield* awaitNativeBoundary(entered, Fiber.await(loading))
    yield* adjust("500 millis")
  }
  yield* Deferred.await(loadedAgain)
  expect(yield* Deferred.isDone(loadedAgain)).toBe(true)
  expect((yield* Fiber.join(loading)).model.ref.profile).toBe("B")
  expect(runtimeRequests).toEqual([])
  expect(forbiddenBuilds).toEqual([])
}))

let forbiddenRuntimeConfigurations = 0
const rejectedRunner = testEffect(AppNodeBuilder.build(runtimeNodes, [
  ...runtimeReplacements,
  [StandaloneConfig.node, makeLocationNode({
    service: StandaloneConfig.Service,
    layer: Layer.effect(StandaloneConfig.Service, Effect.sync(() => { forbiddenRuntimeConfigurations++; throw new Error("Forbidden runtime configuration") })),
    deps: [AppProcess.node],
  })],
]))
rejectedRunner.effect("rejects the complete replaced standalone runner closure before constructing it", () => Effect.gen(function* () {
  const sessionID = yield* seedRuntimeSession("ses_standalone_runtime_rejected")
  const execution = yield* SessionExecution.Service
  const result = yield* Effect.exit(execution.resume(sessionID))
  const error = Exit.isFailure(result) ? Option.getOrUndefined(Cause.findErrorOption(result.cause)) : undefined
  expect(error).toBeInstanceOf(ScopeUnavailableError)
  expect(error).toMatchObject({ operation: "location services" })
  expect(forbiddenRuntimeConfigurations).toBe(0)
  expect(forbiddenBuilds).toEqual([])
  expect(runtimeRequests).toEqual([])
}))

rawProvider.effect("fences standalone resolved model ownership across invalidation and identical repair", () => Effect.gen(function* () {
  configText = '{"default_agent":"god"}'
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [StandaloneModel.node, StandaloneConfig.node], "standalone")
  const models = Context.get(context, StandaloneModel.Service)
  const config = Context.get(context, StandaloneConfig.Service)
  const original = yield* models.resolve(sessionWithProfile())
  expect(Exit.isSuccess(yield* Effect.exit(models.assert(original)))).toBe(true)
  const forged = yield* Effect.exit(models.assert({ ...original }))
  expect(Exit.isFailure(forged) && Option.getOrUndefined(Cause.findErrorOption(forged.cause))).toBeInstanceOf(StandaloneConfig.InvalidError)
  configText = '{"default_agent":"{file:/synthetic/private}"}'
  expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
  expect(Exit.isFailure(yield* Effect.exit(models.assert(original)))).toBe(true)
  configText = '{"default_agent":"god"}'
  yield* config.reload()
  expect(Exit.isFailure(yield* Effect.exit(models.assert(original)))).toBe(true)
  const resolved = yield* Deferred.make<void>()
  const resolving = yield* models.resolve(sessionWithProfile()).pipe(Effect.onExit(() => Deferred.succeed(resolved, undefined)), Effect.forkScoped({ startImmediately: true }))
  yield* adjust("1000 millis")
  expect(yield* Deferred.isDone(resolved)).toBe(true)
  expect(Exit.isSuccess(yield* Effect.exit(models.assert(yield* Fiber.join(resolving))))).toBe(true)
}))

rawProvider.effect("blocks prebuilt standalone catalog and resolver after invalid config reload", () =>
  Effect.gen(function* () {
    configText = '{"default_agent":"god"}'
    configFileReads = 0
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const context = yield* locations.contextEffect(ref, [CatalogContributions.standaloneNode, StandaloneModel.node, StandaloneConfig.node], "standalone")
      const config = Context.get(context, StandaloneConfig.Service)
      const catalog = Context.get(context, StandaloneCatalog.Service)
      const resolver = Context.get(context, StandaloneModel.Service)
      expect((yield* resolver.resolve(sessionWithProfile())).ref.profile).toBe("B")
      configText = '{"default_agent":"{file:/synthetic/private}"}'
      expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
      const current = yield* Effect.exit(catalog.model.get(syntheticProvider, syntheticModel, "B"))
      expect(Exit.isFailure(current) && Option.getOrUndefined(Cause.findErrorOption(current.cause))).toBeInstanceOf(StandaloneConfig.InvalidError)
      const result = yield* Effect.exit(resolver.resolve(sessionWithProfile()))
      expect(Exit.isFailure(result) && Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(StandaloneConfig.InvalidError)
      expect(configFileReads).toBe(0)
    }).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' })))
  }),
)

rawProvider.effect("rechecks standalone preparation after delayed authentication and generation revocation", () => Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  for (const revocation of ["reload", "close"] as const) {
    configText = '{"default_agent":"god"}'
    const lease = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(lease, Exit.void))
    const context = yield* locations.contextEffect(ref, [StandaloneModel.node, StandaloneConfig.node], "standalone").pipe(Effect.provideService(Scope.Scope, lease))
    const config = Context.get(context, StandaloneConfig.Service)
    const resolved = yield* Context.get(context, StandaloneModel.Service).resolve(sessionWithProfile())
    const original = resolved.model.route
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const route = original.with({ auth: { ...original.auth, apply: (input) => Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(original.auth.apply(input)),
    ) } })
    const request = LLM.request({ model: resolved.model, prompt: "Synthetic delayed authentication" })
    const body = yield* route.body.from(request)
    const finished = yield* Deferred.make<void>()
    let prepared = false
    let dispatches = 0
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
    const preparing = yield* Effect.gen(function* () {
      const transport = yield* route.prepareTransport(body, request)
      prepared = true
      yield* route.transport.frames(transport, request, {
        http: { execute: () => Effect.sync(() => { dispatches++ }).pipe(Effect.andThen(Effect.fail(new LLMError({
          module: "synthetic", method: "execute", reason: new InvalidRequestReason({ message: "Unexpected synthetic dispatch" }),
        })))) },
      }).pipe(Stream.runDrain)
    }).pipe(Effect.exit, Effect.onExit(() => Deferred.succeed(finished, undefined)), Effect.forkScoped({ startImmediately: true }))
    yield* awaitNativeBoundary(entered, Fiber.join(preparing))
    if (revocation === "reload") {
      configText = '{"default_agent":"{file:/synthetic/private}"}'
      expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
      configText = '{"default_agent":"god"}'
      yield* config.reload()
    } else {
      yield* locations.invalidate(ref, "standalone")
      yield* config.snapshot()
      yield* Scope.close(lease, Exit.void)
      const closed = yield* Effect.exit(config.snapshot())
      const error = Exit.isFailure(closed) ? Option.getOrUndefined(Cause.findErrorOption(closed.cause)) : undefined
      expect(error).toBeInstanceOf(StandaloneConfig.InvalidError)
      expect(error).toMatchObject({ reason: "closed" })
      expect(yield* Deferred.isDone(finished)).toBe(false)
    }
    yield* Deferred.succeed(release, undefined)
    const result = yield* Fiber.join(preparing)
    const error = Exit.isFailure(result) ? Option.getOrUndefined(Cause.findErrorOption(result.cause)) : undefined
    expect(error).toBeInstanceOf(LLMError)
    expect(error).toMatchObject({ module: "standalone.config" })
    expect(prepared).toBe(false)
    expect(dispatches).toBe(0)
    yield* locations.invalidate(ref, "standalone")
    yield* Scope.close(lease, Exit.void)
  }
}).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' }))))

rawProvider.effect("fences native HTTP dispatch after an awaited transport observation and identical repair", () => Effect.gen(function* () {
  configText = '{"default_agent":"god"}'
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [StandaloneModel.node, StandaloneConfig.node], "standalone")
  const config = Context.get(context, StandaloneConfig.Service)
  const resolved = yield* Context.get(context, StandaloneModel.Service).resolve(sessionWithProfile())
  const route = resolved.model.route
  const request = LLM.request({ model: resolved.model, prompt: "Synthetic delayed request" })
  const body = yield* route.body.from(request)
  const prepared = yield* route.prepareTransport(body, request)
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let dispatches = 0
  const running = yield* route.transport.frames(prepared, request, {
    http: { execute: () => Effect.sync(() => { dispatches++ }).pipe(Effect.andThen(Effect.fail(new LLMError({
      module: "synthetic", method: "execute", reason: new InvalidRequestReason({ message: "Unexpected synthetic dispatch" }),
    })))) },
    observeAttempt: (info) => info.phase === "started" ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void,
  }).pipe(Stream.runDrain, Effect.exit, Effect.forkScoped({ startImmediately: true }))
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
  yield* awaitNativeBoundary(entered, Fiber.join(running))
  configText = '{"default_agent":"{file:/synthetic/private}"}'
  expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
  configText = '{"default_agent":"god"}'
  yield* config.reload()
  yield* Deferred.succeed(release, undefined)
  const result = yield* Fiber.join(running)
  const error = Exit.isFailure(result) ? Option.getOrUndefined(Cause.findErrorOption(result.cause)) : undefined
  expect(error).toBeInstanceOf(LLMError)
  expect(error).toMatchObject({ module: "standalone.config" })
  expect(dispatches).toBe(0)
}).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' }))))

rawProvider.effect("fences native WebSocket sends after a delayed open returns to a revoked generation", () => Effect.gen(function* () {
  configText = JSON.stringify({ default_agent: "god", providers: { [syntheticProvider]: { settings: { transport: "websocket" } } } })
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [StandaloneModel.node, StandaloneConfig.node], "standalone")
  const config = Context.get(context, StandaloneConfig.Service)
  const resolved = yield* Context.get(context, StandaloneModel.Service).resolve(sessionWithProfile())
  const route = resolved.model.route
  expect(route.transport.id).toMatch(/websocket/i)
  const request = LLM.request({ model: resolved.model, prompt: "Synthetic delayed socket" })
  const body = yield* route.body.from(request)
  const prepared = yield* route.prepareTransport(body, request)
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let sends = 0
  let closes = 0
  let httpDispatches = 0
  const unexpected = () => new LLMError({ module: "synthetic", method: "send", reason: new InvalidRequestReason({ message: "Unexpected synthetic send" }) })
  const running = yield* route.transport.frames(prepared, request, {
    http: { execute: () => Effect.sync(() => { httpDispatches++ }).pipe(Effect.andThen(Effect.fail(unexpected()))) },
    webSocket: { open: () => Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.as({ sendText: () => Effect.sync(() => { sends++ }).pipe(Effect.andThen(Effect.fail(unexpected()))), messages: Stream.empty, close: Effect.sync(() => { closes++ }), isOpen: () => closes === 0 }),
    ) },
  }).pipe(Stream.runDrain, Effect.exit, Effect.forkScoped({ startImmediately: true }))
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
  yield* awaitNativeBoundary(entered, Fiber.join(running))
  configText = '{"default_agent":"{file:/synthetic/private}"}'
  expect(Exit.isFailure(yield* Effect.exit(config.reload()))).toBe(true)
  yield* Deferred.succeed(release, undefined)
  const result = yield* Fiber.join(running)
  const error = Exit.isFailure(result) ? Option.getOrUndefined(Cause.findErrorOption(result.cause)) : undefined
  expect(error).toBeInstanceOf(LLMError)
  expect(error).toMatchObject({ module: "standalone.config" })
  expect(sends).toBe(0)
  expect(httpDispatches).toBe(0)
  expect(closes).toBe(1)
}).pipe(Effect.ensuring(Effect.sync(() => { configText = '{"default_agent":"{file:/synthetic/private}"}' }))))

const syntheticAmbient = Effect.gen(function* () {
  const descriptor = Object.getOwnPropertyDescriptor(process, "env")
  if (!descriptor) return yield* Effect.die("Environment descriptor is unavailable")
  let reads = 0
  const environment: Record<string, string | undefined> = {}
  Object.defineProperty(environment, "OPENAI_API_KEY", { enumerable: true, get: () => { reads++; return "synthetic-ambient-key" } })
  yield* Effect.addFinalizer(() => Effect.sync(() => { Object.defineProperty(process, "env", descriptor) }))
  Object.defineProperty(process, "env", { configurable: true, value: environment, writable: true })
  return () => reads
})

metadata.effect("S2-09 exact inactive profile reaches the native factory", () => Effect.gen(function* () {
  configEntries = [new Config.Document({ type: "document", scope: "global", info: Config.Info.make({
    providers: { [syntheticProvider]: new ConfigProvider.Info({ settings: { apiKey: "synthetic-configured-key", auth: { id: "synthetic-auth-override" } } }) },
  }) })]
  credentialWrites = 0
  snapshotOverride = undefined
  const a = profile("A", true)
  const b = profile("B", false)
  savedCredentials = [a, b]
  const ambientReads = yield* syntheticAmbient
    const context = yield* profileContext
    const resolver = Context.get(context, StandaloneModel.Service)
    const selected = yield* resolver.resolve(sessionWithProfile())
    expect(selected.ref.profile).toBe("B")
    expect(selected.profileBinding).toMatchObject({ credentialID: b.id, accountGeneration: b.accountGeneration, profile: "B" })
    const headers = yield* selected.model.route.auth.apply({
      request: LLM.request({ model: selected.model, prompt: "synthetic" }), method: "POST",
      url: "https://synthetic.invalid/v1", body: "{}", headers: Headers.empty,
    })
    expect(headers.authorization).toBe("Bearer synthetic-B-key")
    expect(ambientReads()).toBe(0)
    expect(credentialWrites).toBe(0)
}))

metadata.effect("S2-09 unverified Bedrock fails before package construction", () => Effect.gen(function* () {
  configEntries = []
  credentialWrites = 0
  snapshotOverride = undefined
  savedCredentials = [profile("A", true), profile("B", false)]
  let factories = 0
  const factory = spyOn(Provider, "loadPackage").mockImplementation(() => {
    factories++
    return Effect.die("unexpected provider construction")
  })
  try {
    const context = yield* profileContext
    yield* Context.get(context, Catalog.Service).transform((draft) => {
      draft.model.update(syntheticProvider, syntheticModel, (model) => { model.package = "aisdk:@ai-sdk/amazon-bedrock" })
    })
    const error = yield* Context.get(context, StandaloneModel.Service).resolve(sessionWithProfile()).pipe(Effect.flip)
    expect(error).toMatchObject({ _tag: "SessionRunnerModel.UnsupportedPackageError" })
    expect(factories).toBe(0)
    expect(credentialWrites).toBe(0)
  } finally {
    factory.mockRestore()
  }
}))

metadata.effect("S2-09 unsupported OAuth fails before native construction", () => Effect.gen(function* () {
  configEntries = []
  credentialWrites = 0
  snapshotOverride = undefined
  const context = yield* profileContext
  const resolver = Context.get(context, StandaloneModel.Service)
  const loadPackage = Provider.loadPackage
  let factories = 0
  const factory = spyOn(Provider, "loadPackage").mockImplementation((specifier, npm, scope) => {
    factories++
    return loadPackage(specifier, npm, scope)
  })
  try {
    const b = profile("B", false)
    for (const value of [
      Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("unverified"), access: "synthetic-access", refresh: "synthetic-refresh", expires: 0 }),
    ]) {
      savedCredentials = [profile("A", true), Credential.Info.make({ ...b, value })]
      const result = yield* resolver.resolve(sessionWithProfile()).pipe(
        Effect.as("resolved"), Effect.catch((error) => Effect.succeed(error._tag)),
      )
      expect(result).toBe("SessionRunnerModel.UnsupportedPackageError")
    }
    expect(factories).toBe(0)
    expect(credentialWrites).toBe(0)
  } finally {
    factory.mockRestore()
  }
}))

metadata.effect("S2-09 empty and whitespace secrets fail before contextual or factory resolution", () => Effect.gen(function* () {
  configEntries = []
  credentialWrites = 0
  snapshotOverride = undefined
  const context = yield* profileContext
  const resolver = Context.get(context, StandaloneModel.Service)
  const catalog = Context.get(context, Catalog.Service)
  const ambientReads = yield* syntheticAmbient
  const originalContext = catalog.model.forConnection
  const originalDefault = catalog.model.defaultSelection
  const originalFactory = Provider.loadPackage
  let contextual = 0
  let defaults = 0
  let factories = 0
  const contextSpy = spyOn(catalog.model, "forConnection").mockImplementation((...args) => { contextual++; return originalContext(...args) })
  const defaultSpy = spyOn(catalog.model, "defaultSelection").mockImplementation(() => { defaults++; return originalDefault() })
  const factorySpy = spyOn(Provider, "loadPackage").mockImplementation((...args) => { factories++; return originalFactory(...args) })
  try {
    const b = profile("B", false)
    for (const secret of ["", "  "]) {
      for (const value of [
        Credential.Key.make({ type: "key", key: secret }),
        Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"), access: secret, refresh: "synthetic-refresh", expires: 0 }),
      ]) {
        savedCredentials = [profile("A", true), Credential.Info.make({ ...b, value })]
        const result = yield* resolver.resolve(sessionWithProfile()).pipe(
          Effect.as("resolved"), Effect.catch((error) => Effect.succeed(error._tag)),
        )
        expect(result).toBe("SessionRunnerModel.ProfileUnavailableError")
      }
    }
    expect(contextual).toBe(0)
    expect(defaults).toBe(0)
    expect(factories).toBe(0)
    expect(ambientReads()).toBe(0)
    expect(credentialWrites).toBe(0)
  } finally {
    contextSpy.mockRestore()
    defaultSpy.mockRestore()
    factorySpy.mockRestore()
  }
}))

metadata.effect("S2-09 supported ChatGPT OAuth retains the selected stored binding", () => Effect.gen(function* () {
  configEntries = []
  credentialWrites = 0
  snapshotOverride = undefined
  const openai = Integration.ID.make("openai")
  const b = Credential.Info.make({
    ...profile("B", false, openai),
    value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"),
      access: "synthetic-oauth-B", refresh: "synthetic-refresh", expires: 9999999999999 }),
  })
  savedCredentials = [profile("A", true, openai), b]
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [Catalog.node, CatalogContributions.standaloneNode, Integration.standaloneNode, StandaloneModel.node], "standalone")
  yield* Context.get(context, Integration.StandaloneService).transform((draft) => draft.update(openai, (item) => { item.name = "OpenAI" }))
  yield* Context.get(context, Catalog.Service).transform((draft) => draft.provider.update(syntheticProvider, (item) => { item.integrationID = openai }))
  const selected = yield* Context.get(context, StandaloneModel.Service).resolve(sessionWithProfile())
  expect(selected.profileBinding).toMatchObject({ integrationID: openai, credentialID: b.id, profile: "B" })
  expect(selected.model.route.id).toBe("openai-codex-responses")
  const headers = yield* selected.model.route.auth.apply({
    request: LLM.request({ model: selected.model, prompt: "synthetic" }), method: "POST",
    url: "https://synthetic.invalid", body: "{}", headers: Headers.empty,
  })
  expect(headers.authorization).toBe("Bearer synthetic-oauth-B")
  expect(credentialWrites).toBe(0)
}))

metadata.effect("S2-10 missing persisted model or profile cannot inherit configured defaults", () => Effect.gen(function* () {
  configEntries = []
  credentialWrites = 0
  snapshotOverride = undefined
  savedCredentials = [profile("A", true), profile("B", false)]
  const context = yield* profileContext
  const catalog = Context.get(context, Catalog.Service)
  yield* catalog.transform((draft) => draft.model.default.set(syntheticProvider, syntheticModel, { profile: "B" }))
  const defaultSelection = catalog.model.defaultSelection
  const loadPackage = Provider.loadPackage
  let defaultCalls = 0
  let factories = 0
  const selectionSpy = spyOn(catalog.model, "defaultSelection").mockImplementation(() => {
    defaultCalls++
    return defaultSelection()
  })
  const factorySpy = spyOn(Provider, "loadPackage").mockImplementation((specifier, npm, scope) => {
    factories++
    return loadPackage(specifier, npm, scope)
  })
  try {
    const resolver = Context.get(context, StandaloneModel.Service)
    for (const model of [undefined, { providerID: syntheticProvider, id: syntheticModel }]) {
      const session = Session.Info.make({ ...sessionWithProfile(), model })
      const result = yield* resolver.resolve(session).pipe(
        Effect.as("resolved"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      )
      expect(result).toBe(model ? "SessionRunnerModel.ProfileUnavailableError" : "SessionRunnerModel.ModelNotSelectedError")
    }
    expect(defaultCalls).toBe(0)
    expect(factories).toBe(0)
    expect(credentialWrites).toBe(0)
  } finally {
    selectionSpy.mockRestore()
    factorySpy.mockRestore()
  }
}))

metadata.effect("S2-10 invalid explicit profiles fail before factory resolution", () => Effect.gen(function* () {
  configEntries = []
  credentialWrites = 0
  snapshotOverride = undefined
  const a = profile("A", true)
  const b = profile("B", false)
  const foreign = profile("B", false, Integration.ID.make("synthetic-foreign"))
  const context = yield* profileContext
  const resolver = Context.get(context, StandaloneModel.Service)
  const binding = SessionEvent.ProfileBinding.make({ providerID: syntheticProvider, integrationID: syntheticIntegration,
    profile: "B", credentialID: b.id, accountGeneration: b.accountGeneration })
  let factories = 0
  const factory = spyOn(Provider, "loadPackage").mockImplementation(() => { factories++; return Effect.die("unexpected provider construction") })
  try {
  for (const test of [
    { credentials: [a], binding: undefined, snapshot: undefined },
    { credentials: [a, b, profile("B", false)], binding: undefined, snapshot: undefined },
    { credentials: [a, foreign], binding: undefined, snapshot: undefined },
    { credentials: [a, b], binding: { ...binding, providerID: Provider.ID.make("synthetic-foreign") }, snapshot: undefined },
    { credentials: [a, b], binding: { ...binding, profile: "A" }, snapshot: undefined },
    { credentials: [a, b], binding: { ...binding, accountGeneration: 2 }, snapshot: undefined },
    { credentials: [a, b], binding, snapshot: a },
  ]) {
    savedCredentials = test.credentials
    snapshotOverride = test.snapshot
    const result = yield* resolver.resolve(sessionWithProfile(), { binding: test.binding }).pipe(Effect.flip)
    expect(result).toMatchObject({ _tag: "SessionRunnerModel.ProfileUnavailableError", profile: "B" })
  }
  snapshotOverride = undefined
  expect(factories).toBe(0)
  expect(credentialWrites).toBe(0)
  } finally { factory.mockRestore() }
}))

metadata.effect("S2-11 explicit profile resolves its account-specific model and variant", () => Effect.gen(function* () {
  configEntries = [new Config.Document({ type: "document", scope: "global", info: Config.Info.make({
    providers: { [syntheticProvider]: new ConfigProvider.Info({ body: { synthetic_config_overlay: "configured" } }) },
  }) })]
  credentialWrites = 0
  snapshotOverride = undefined
  const a = profile("A", true)
  const b = profile("B", false)
  savedCredentials = [a, b]
  const context = yield* profileContext
  const catalog = Context.get(context, Catalog.Service)
  const exclusiveID = CatalogModel.ID.make("synthetic-B-exclusive")
  const variant = CatalogModel.VariantID.make("synthetic-B-variant")
  yield* catalog.transform((draft) => {
    draft.model.account.update(a, syntheticProvider, [])
    draft.model.account.update(b, syntheticProvider, [{
      ...CatalogModel.Info.empty(syntheticProvider, exclusiveID), package: "@ycoding-ai/ai/providers/openai",
      settings: { baseURL: "https://synthetic.invalid/B" }, variants: [{ id: variant, settings: {}, body: { synthetic_overlay: "B" } }],
    }])
  }).pipe(Effect.provideService(State.Phase, State.phases.pre))
  const selected = yield* Context.get(context, StandaloneModel.Service).resolve(sessionWithProfile(exclusiveID, variant))
  expect(selected.ref).toMatchObject({ id: exclusiveID, profile: "B", variant })
  expect(selected.model.route.endpoint.baseURL).toContain("/B")
  expect(selected.model.route.defaults.http?.body).toMatchObject({ synthetic_overlay: "B" })
  expect(selected.model.route.defaults.http?.body).toMatchObject({ synthetic_config_overlay: "configured" })
  expect(selected.profileBinding?.credentialID).toBe(b.id)
  expect(credentialWrites).toBe(0)
}))

metadata.effect("S2-01 standalone availability excludes unverified packages and credential forms but retains metadata", () => Effect.gen(function* () {
  configEntries = []
  snapshotOverride = undefined
  const b = profile("B", false)
  const c = profile("C", false)
  savedCredentials = [
    profile("A", true),
    Credential.Info.make({ ...b, value: Credential.Key.make({ type: "key", key: "  " }) }),
    Credential.Info.make({ ...c, value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("unverified"), access: "synthetic-access", refresh: "synthetic-refresh", expires: 0 }) }),
  ]
  const context = yield* profileContext
  const catalog = Context.get(context, Catalog.Service)
  const unsupportedID = CatalogModel.ID.make("synthetic-unsupported")
  yield* catalog.transform((draft) => {
    draft.model.update(syntheticProvider, unsupportedID, (model) => { model.package = "aisdk:@ai-sdk/openai" })
  })
  expect(yield* catalog.model.get(syntheticProvider, unsupportedID)).toMatchObject({ id: unsupportedID, package: "aisdk:@ai-sdk/openai" })
  expect((yield* catalog.model.all()).map((model) => model.id)).toContain(unsupportedID)
  const available = yield* catalog.model.available()
  expect(available.map((model) => model.id)).toContain(syntheticModel)
  expect(available.map((model) => model.id)).not.toContain(unsupportedID)
  expect(available.find((model) => model.id === syntheticModel)?.profiles?.map((item) => item.name)).toEqual(["A"])
}))

metadata.effect("S2-01 standalone default excludes unsupported adapters and empty credentials", () => Effect.gen(function* () {
  configEntries = []
  snapshotOverride = undefined
  const context = yield* profileContext
  const catalog = Context.get(context, Catalog.Service)
  const b = profile("B", true)
  savedCredentials = [Credential.Info.make({ ...b, value: Credential.Key.make({ type: "key", key: "  " }) })]
  yield* catalog.transform((draft) => draft.model.default.set(syntheticProvider, syntheticModel))
  expect(yield* catalog.model.available()).toEqual([])
  expect(yield* catalog.model.default()).toBeUndefined()
  expect(yield* catalog.model.defaultSelection()).toBeUndefined()

  savedCredentials = [b]
  yield* catalog.transform((draft) => draft.model.update(syntheticProvider, syntheticModel, (model) => {
    model.package = "aisdk:@ai-sdk/openai"
  }))
  expect(yield* catalog.model.available()).toEqual([])
  expect(yield* catalog.model.default()).toBeUndefined()
  expect(yield* catalog.model.defaultSelection()).toBeUndefined()
}))

it.effect("S2-02 rejects forbidden transitive dependencies and late full extension", () => Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  projectBuilds = 0
  shellBuilds = 0
  processBuilds = 0
  const context = yield* locations.contextEffect(ref, [Location.node], "standalone")
  expect(Context.get(context, Location.Service).project.id).toBe(Project.ID.make("proj_standalone_sessions"))
  expect(Option.isNone(Context.getOption(context, LocationServiceMap.Service))).toBe(true)
  expect(Option.isNone(Context.getOption(context, PluginRuntime.Service))).toBe(true)
  const forbidden = yield* locations.contextEffect(ref, [projectConsumer], "standalone").pipe(Effect.flip)
  expect(forbidden).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
  expect(yield* locations.contextEffect(ref, [Shell.node], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
  expect(yield* locations.contextEffect(ref, [processConsumer], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
  expect(yield* locations.contextEffect(ref, [sandboxConsumer], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
  expect(yield* locations.contextEffect(ref, [Pty.node], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
  expect(yield* locations.contextEffect(ref, [mapConsumer], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
  expect(yield* locations.contextEffect(ref, [fullConsumer], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
  expect(yield* locations.contextEffect(ref, [pluginConsumer], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
  expect(yield* locations.contextEffect(ref, [providerConsumer], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
  const full = yield* locations.contextEffect(ref, [LocationServiceMap.full], "standalone").pipe(Effect.flip)
  expect(full).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
  expect(projectBuilds).toBe(0)
  expect(shellBuilds).toBe(0)
  expect(processBuilds).toBe(0)
}))

it.effect("S2-02 excludes a warmed bound plugin runtime from standalone contexts", () => Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  yield* locations.contextEffect(ref, [Location.node], "bound")
  const warm = PluginRuntime.providerLayer.pipe(Layer.provide(Layer.mergeAll(
    Layer.mock(Session.Service, {
      daybreak: { set: () => Effect.die("unexpected") },
      autonomy: { get: () => Effect.die("unexpected"), set: () => Effect.die("unexpected"), effective: () => Effect.die("unexpected") },
      revert: { stage: () => Effect.die("unexpected"), clear: () => Effect.die("unexpected"), commit: () => Effect.die("unexpected") },
    }),
    Layer.mock(Job.Service, {}),
    Layer.succeed(LocationServiceMap.Service, locations),
    Layer.mock(SessionOrchestration.Service, {}),
  )))
  yield* Layer.build(warm)
  const context = yield* locations.contextEffect(ref, [Location.node], "standalone")
  expect(Option.isNone(Context.getOption(context, PluginRuntime.Service))).toBe(true)
  expect(Option.isNone(Context.getOption(context, LocationServiceMap.Service))).toBe(true)
  expect(yield* locations.contextEffect(ref, [pluginConsumer], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
}))

const unsafeGlobalConfig = makeGlobalNode({
  service: Config.GlobalService,
  layer: Layer.mock(Config.GlobalService, {
    reload: () => Effect.void,
    snapshot: () => Effect.succeed({ entries: [], diagnostics: [] }),
    subscribe: () => () => {},
  }),
  deps: [AppProcess.node],
})
const transitive = testEffect(AppNodeBuilder.build(LocationServiceMap.node, [
  [Config.globalNode, unsafeGlobalConfig],
  [AppProcess.node, Layer.mock(AppProcess.Service, {
    run: () => Effect.succeed({ command: "ps", exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), stdoutTruncated: false, stderrTruncated: false }),
  })],
]))
transitive.effect("S2-02 rejects a forbidden dependency of an allowed replacement", () => Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  expect(yield* locations.contextEffect(ref, [Config.node], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
}))

const fullGlobalConfig = { ...unsafeGlobalConfig, dependencies: [LocationServiceMap.full] }
const nestedFull = testEffect(AppNodeBuilder.build(LocationServiceMap.node, [
  [Config.globalNode, fullGlobalConfig],
  [AppProcess.node, Layer.mock(AppProcess.Service, {
    run: () => Effect.succeed({ command: "ps", exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), stdoutTruncated: false, stderrTruncated: false }),
  })],
]))
nestedFull.effect("S2-02 rejects a full group nested inside an allowed replacement", () => Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  expect(yield* locations.contextEffect(ref, [Config.node], "standalone").pipe(Effect.flip)).toMatchObject({ _tag: "Session.ScopeUnavailableError" })
}))

it.effect("S2-08 standalone package loader admits only verified native OpenAI adapters", () => Effect.gen(function* () {
  let installs = 0
  const npm: Npm.Interface = {
    add: () => { installs++; return Effect.die("unexpected install") },
    install: () => Effect.die("unexpected install"),
    which: () => Effect.die("unexpected lookup"),
  }
  yield* Provider.loadPackage("@ycoding-ai/ai/providers/anthropic")
  for (const specifier of [
    "file:///synthetic/untrusted.mjs",
    "@ycoding-ai/ai/providers/unregistered",
    "@ycoding-ai/ai/providers/anthropic",
    "@ai-sdk/openai",
    "not-installed-synthetic-provider",
  ]) {
    const error = yield* Provider.loadPackage(specifier, npm, "standalone").pipe(Effect.flip)
    expect(error).toMatchObject({ _tag: "Provider.LoadError", package: specifier })
  }
  for (const specifier of ["@ycoding-ai/ai/providers/openai", "@ycoding-ai/ai/providers/openai/responses"]) {
    const adapter = yield* Provider.loadPackage(specifier, npm, "standalone")
    expect(typeof adapter.model).toBe("function")
  }
  expect(installs).toBe(0)
}))

it.effect("S2-01 invalid models snapshot does not remove cache or fetch", () => Effect.gen(function* () {
  let removals = 0
  const fs = Context.get(yield* Layer.build(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))), FSUtil.Service)
  const context = yield* Layer.build(AppNodeBuilder.build(ModelsDev.standaloneNode, [
    [FSUtil.node, Layer.succeed(FSUtil.Service, { ...fs,
      readJson: () => Effect.fail(new FSUtil.FileSystemError({ method: "readJson", cause: new Error("synthetic invalid snapshot") })),
      remove: () => { removals++; return Effect.die("unexpected removal") },
    })],
  ]))
  yield* Context.get(context, ModelsDev.ReadonlyService).get()
  expect(removals).toBe(0)
}))

it.effect("S2-03 isolates bound and standalone cache entries and workspace identities", () => Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  const workspace = Location.Ref.make({ ...ref, workspaceID: WorkspaceID.make("wrk_synthetic") })
  for (const first of ["bound", "standalone"] as const) {
    const second = first === "bound" ? "standalone" : "bound"
    const left = yield* locations.contextEffect(ref, [Location.node], first)
    const right = yield* locations.contextEffect(ref, [Location.node], second)
    const other = yield* locations.contextEffect(workspace, [Location.node], first)
    expect(Context.get(left, Location.Service)).not.toBe(Context.get(right, Location.Service))
    expect(Context.get(left, Location.Service)).not.toBe(Context.get(other, Location.Service))
    yield* locations.invalidate(ref)
    yield* locations.invalidate(ref, "standalone")
    yield* locations.invalidate(workspace)
    yield* locations.invalidate(workspace, "standalone")
  }
  const [bound, standalone] = yield* Effect.all([
    locations.contextEffect(ref, [Location.node], "bound"),
    locations.contextEffect(ref, [Location.node], "standalone"),
  ], { concurrency: "unbounded" })
  expect(Context.get(bound, Location.Service)).not.toBe(Context.get(standalone, Location.Service))
}))
