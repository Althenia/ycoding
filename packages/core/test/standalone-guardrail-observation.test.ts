import { expect } from "bun:test"
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, PlatformError, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Event } from "@ycoding-ai/schema/event"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventSequenceTable, EventTable } from "@ycoding-ai/core/event/sql"
import { Watcher } from "@ycoding-ai/core/filesystem/watcher"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { buildLocationServiceMap, LocationServiceMap } from "@ycoding-ai/core/location-services"
import { LocationMutation } from "@ycoding-ai/core/location-mutation"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { Permission } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { ContextManifest } from "@ycoding-ai/core/session/context-manifest"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { ScopeUnavailableError } from "@ycoding-ai/core/session/error"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { InstructionStateTable, SessionContextExclusionTable, SessionContextRevisionTable, SessionContextStateTable, SessionMessageTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { StandaloneConfig } from "@ycoding-ai/core/config/standalone"
import { testEffect } from "./lib/effect"

const globalConfig = "/synthetic/observation-config"
const policyDirectory = `${globalConfig}/guardrails`
const policyFile = `${policyDirectory}/synthetic.md`
const ref = Location.Ref.make({ directory: AbsolutePath.make("/synthetic/observation-session") })
const markdown = (id: string) => `---\nid: ${id}\ndecision: ask\nactions: [synthetic]\nresources: ["example"]\nreason: Synthetic policy\n---\n`
let configText = "{}"
let content = markdown("synthetic-first")
let policyReads = 0
let policyEnumerations = 0
let hostControllerBuilds = 0
let forbiddenReads = 0
let escapedDirectory = false
let escapedFile = false
let unreadableDirectory = false

const missing = () => PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readFileString" })
const filesystem = Layer.effect(FSUtil.Service, Effect.map(FSUtil.Service, (fs) => FSUtil.Service.of({
  ...fs,
  readFileString: (target) => {
    if (target === `${globalConfig}/ycoding.json`) return Effect.succeed(configText)
    if (target === `${globalConfig}/ycoding.jsonc`) return Effect.fail(missing())
    if (target === policyFile) { policyReads++; return Effect.succeed(content) }
    forbiddenReads++
    return Effect.die("Forbidden synthetic filesystem read")
  },
  readFileStringSafe: (target) => {
    if (target === policyFile) { policyReads++; return Effect.succeed(content) }
    if (target === `${globalConfig}/ycoding.json`) return Effect.succeed(configText)
    if (target === `${globalConfig}/ycoding.jsonc`) return Effect.succeed(undefined)
    forbiddenReads++
    return Effect.die("Forbidden synthetic filesystem read")
  },
  realPath: (target) => {
    if (target === globalConfig) return Effect.succeed(target)
    if (target === policyDirectory) return Effect.succeed(escapedDirectory ? "/synthetic/outside" : target)
    if (target === policyFile) return Effect.succeed(escapedFile ? "/synthetic/outside/synthetic.md" : target)
    forbiddenReads++
    return Effect.die("Forbidden synthetic path resolution")
  },
  scan: (pattern, options) => {
    if (pattern !== "*.md" || options?.cwd !== policyDirectory) {
      forbiddenReads++
      return Effect.die("Forbidden synthetic filesystem scan")
    }
    policyEnumerations++
    return unreadableDirectory
      ? Effect.fail(new FSUtil.FileSystemError({ method: "scan", cause: new Error("Synthetic unreadable policy") }))
      : Effect.succeed([policyFile])
  },
  readDirectoryEntries: (target) => {
    if (target !== policyDirectory) { forbiddenReads++; return Effect.die("Forbidden synthetic directory read") }
    policyEnumerations++
    return unreadableDirectory
      ? Effect.fail(new FSUtil.FileSystemError({ method: "readDirectoryEntries", cause: new Error("Synthetic unreadable policy") }))
      : Effect.succeed<FSUtil.DirEntry[]>([{ name: "synthetic.md", type: "file" }])
  },
}))).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const replacements = [
  [Global.node, Layer.succeed(Global.Service, Global.make({ config: globalConfig }))],
  [FSUtil.node, filesystem],
  [Watcher.node, Layer.mock(Watcher.Service, { subscribe: () => Stream.never })],
] as const
const it = testEffect(AppNodeBuilder.build(LayerNode.group([LocationServiceMap.node, Database.node, EventRuntime.node, FSUtil.node]), replacements))
const coldObserver = testEffect(AppNodeBuilder.build(LayerNode.group([LocationServiceMap.node, Database.node, EventRuntime.node, KeepAwake.observationNode]), [
  ...replacements,
  [KeepAwake.node, Layer.effect(KeepAwake.Service, Effect.sync(() => { hostControllerBuilds++; throw new Error("Forbidden keep-awake controller") }))],
]))
const seed = (scope: "bound" | "standalone") => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const id = SessionSchema.ID.make(`ses_guardrail_observation_${scope}`)
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] }).run()
  yield* db.insert(SessionTable).values({ id, scope, project_id: Project.ID.global, directory: ref.directory, title: "Synthetic" }).run()
  return id
})
const reset = Effect.sync(() => {
  configText = "{}"
  content = markdown("synthetic-first")
  policyReads = 0
  policyEnumerations = 0
  hostControllerBuilds = 0
  forbiddenReads = 0
  escapedDirectory = false
  escapedFile = false
  unreadableDirectory = false
})

coldObserver.effect("standalone live state reads real global policy and observes changes without host discovery", () => Effect.gen(function* () {
  yield* reset
  const sessionID = yield* seed("standalone")
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [SessionLiveState.node], "standalone")
  const live = Context.get(context, SessionLiveState.Service)
  const first = yield* live.load(sessionID)
  expect(first.sources.guardrails.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(policyReads).toBeGreaterThan(0)
  expect(policyEnumerations).toBeGreaterThan(0)
  const awake = yield* KeepAwake.Observation
  expect(yield* awake.get).toBeUndefined()
  expect(hostControllerBuilds).toBe(0)
  content = "---\nid: malformed\n---\n"
  const second = yield* live.load(sessionID)
  expect(second.sources.guardrails.digest).not.toBe(first.sources.guardrails.digest)
  expect(forbiddenReads).toBe(0)
}))

it.effect("standalone policy observation rejects directory and document symlink escapes before reads", () => Effect.gen(function* () {
  yield* reset
  const sessionID = yield* seed("standalone")
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [SessionLiveState.node], "standalone")
  const live = Context.get(context, SessionLiveState.Service)
  for (const directory of [true, false]) {
    escapedDirectory = directory
    escapedFile = !directory
    expect(Exit.isFailure(yield* Effect.exit(live.load(sessionID)))).toBe(true)
    expect(policyReads).toBe(0)
    expect(forbiddenReads).toBe(0)
  }
}).pipe(Effect.ensuring(reset)))

it.effect("standalone unreadable global policy fails instead of observing an empty rule set", () => Effect.gen(function* () {
  yield* reset
  const sessionID = yield* seed("standalone")
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [SessionLiveState.node], "standalone")
  unreadableDirectory = true
  expect(Exit.isFailure(yield* Effect.exit(Context.get(context, SessionLiveState.Service).load(sessionID)))).toBe(true)
  expect(policyReads).toBe(0)
  expect(forbiddenReads).toBe(0)
}).pipe(Effect.ensuring(reset)))

it.effect("guardrail observation shares enforcement pending counters and the root snapshot lock", () => Effect.gen(function* () {
  yield* reset
  const sessionID = yield* seed("bound")
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const context = yield* Layer.build(AppNodeBuilder.build(
    LayerNode.group([SessionGuardrail.node, SessionGuardrail.observationNode]),
    [
      ...replacements,
      [Database.node, Layer.succeed(Database.Service, database)],
      [EventRuntime.node, Layer.succeed(EventRuntime.Service, events)],
      [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([new Config.Directory({ type: "directory", path: AbsolutePath.make(globalConfig) })]) })],
      [Location.node, Layer.succeed(Location.Service, Location.Service.of({ ...ref, project: { id: Project.ID.global, directory: ref.directory } }))],
      [LocationMutation.node, Layer.mock(LocationMutation.Service, {})],
      [Permission.node, Layer.mock(Permission.Service, {})],
      [Decision.node, Layer.mock(Decision.Service, {})],
    ],
  ))
  const enforcement = Context.get(context, SessionGuardrail.Service)
  const observation = Context.get(context, SessionGuardrail.Observation)
  const asked = yield* Deferred.make<Guardrail.Request>()
  const listening = yield* events.subscribe(Guardrail.Event.Asked).pipe(
    Stream.take(1),
    Stream.runForEach((event) => Deferred.succeed(asked, event.data).pipe(Effect.asVoid)),
    Effect.forkScoped({ startImmediately: true }),
  )
  const executing = yield* enforcement.assert({ sessionID, action: "synthetic", resources: ["example"] }).pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
  const request = yield* Deferred.await(asked)
  const pending = yield* observation.snapshot(sessionID)
  expect(pending).toEqual(yield* enforcement.snapshot(sessionID))
  expect((yield* enforcement.status(sessionID)).counters.find((counter) => counter.id === "reviews")?.current).toBe(1)
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const held = yield* enforcement.withSnapshot(sessionID, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkScoped({ startImmediately: true }))
  yield* Deferred.await(entered)
  let observed = false
  const reading = yield* observation.snapshot(sessionID).pipe(Effect.tap(() => Effect.sync(() => { observed = true })), Effect.forkScoped({ startImmediately: true }))
  yield* Effect.yieldNow
  expect(observed).toBe(false)
  yield* Deferred.succeed(release, undefined)
  yield* Fiber.join(held)
  yield* Fiber.join(reading)
  yield* enforcement.reply({ sessionID, requestID: request.id, reply: "reject" })
  expect((yield* observation.snapshot(sessionID)).digest).not.toBe(pending.digest)
  expect(yield* observation.snapshot(sessionID)).toEqual(yield* enforcement.snapshot(sessionID))
  expect(Exit.isFailure(yield* Fiber.join(executing))).toBe(true)
  yield* Fiber.join(listening)
  expect(forbiddenReads).toBe(0)
}))

const activationRows = (sessionID: SessionSchema.ID) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return yield* Effect.all([
    db.select().from(SessionContextRevisionTable).where(eq(SessionContextRevisionTable.session_id, sessionID)).all(),
    db.select().from(SessionContextStateTable).where(eq(SessionContextStateTable.session_id, sessionID)).all(),
    db.select().from(SessionContextExclusionTable).where(eq(SessionContextExclusionTable.session_id, sessionID)).all(),
    db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all(),
  ])
})

const activationManifest = (sessionID: SessionSchema.ID, observation: Parameters<typeof SessionGuardrail.Observation.of>[0]) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const data = ["old", "retained"].map((name) => {
    const message = SessionMessage.User.make({ id: SessionMessage.ID.make(`msg_policy_${name}`), type: "user", text: "Synthetic duplicate", time: { created: DateTime.makeUnsafe(1) } })
    const { id, type, ...value } = Schema.encodeSync(SessionMessage.Info)(message)
    return { id: message.id, type, value }
  })
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 2 }).run()
  yield* db.insert(SessionContextRevisionTable).values({ session_id: sessionID, revision: 0, time_created: 0 }).run()
  yield* db.insert(SessionContextStateTable).values({ session_id: sessionID, status: "active", revision: 0 }).run()
  yield* db.insert(InstructionStateTable).values({ session_id: sessionID, epoch_start: 0, through_seq: 0, initial_values: {}, current_values: {} }).run()
  yield* db.insert(SessionMessageTable).values(data.map((entry, index) => ({ id: entry.id, session_id: sessionID, type: entry.type, seq: index + 1, data: entry.value, time_created: 1, time_updated: 1 }))).run()
  const items = data.map((entry, position) => ({ kind: "message" as const, messageID: entry.id, position, terminalSeq: Event.Seq.make(position + 1), inputKind: "user", payload: Schema.decodeUnknownSync(Schema.Json)(entry.value), tokens: 8 }))
  const database = yield* SessionLiveState.captureDatabase(db, sessionID)
  const guardrails = yield* observation.snapshot(sessionID)
  const protectedState = SessionLiveState.toProtectedState({ ...database.sources, guardrails })
  const coveredThrough = { messageID: data[1]!.id, seq: Event.Seq.make(2) }
  const result = ContextManifest.validate({
    candidate: { schemaVersion: 1, baseContextRevision: 0, coveredThrough, protectedState, exclusions: [{ reason: "exact_duplicate", target: ContextManifest.selector(items[0]!), evidence: ContextManifest.selector(items[1]!) }] },
    evidence: { baseContextRevision: 0, coveredThrough, items, settlements: [], authorities: [], resourceAuthorities: [], toolResults: [], recentTail: [], protectedTargets: [], providerLinks: [], protectedState },
  })
  if (!result.valid) return yield* Effect.die(result.issues)
  return result.manifest
})

const activator = (extra: LayerNode.Replacements) => Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const shared = [
    ...replacements,
    [Database.node, Layer.succeed(Database.Service, database)],
    [EventRuntime.node, Layer.succeed(EventRuntime.Service, events)],
  ] as const
  const context = yield* Layer.build(AppNodeBuilder.build(SessionContextState.node, [
    ...shared,
    ...extra,
    [LocationServiceMap.node, buildLocationServiceMap([...shared, ...extra])],
  ]))
  return Context.get(context, SessionContextState.Service)
})

it.effect("scoped activation preserves reduced graph provisioning errors without committing state", () => Effect.gen(function* () {
  yield* reset
  const sessionID = yield* seed("standalone")
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [SessionGuardrail.standaloneObservationNode], "standalone")
  const manifest = yield* activationManifest(sessionID, Context.get(context, SessionGuardrail.Observation))
  let forbiddenBuilds = 0
  const forbidden = makeLocationNode({ service: StandaloneConfig.Service, layer: Layer.effect(StandaloneConfig.Service, Effect.sync(() => { forbiddenBuilds++; throw new Error("Forbidden policy constructor") })), deps: [Project.node] })
  const replacement = [StandaloneConfig.node, forbidden] as const
  const compiler = LayerNode.compiler([replacement])
  expect(compiler.closure(compiler.members(StandaloneConfig.node)).map((node) => node.name)).toContain(Project.node.name)
  expect(() => AppNodeBuilder.build(StandaloneConfig.node, [replacement])).not.toThrow()
  const state = yield* activator([replacement])
  const before = yield* activationRows(sessionID)
  const result = yield* Effect.exit(state.activate({ sessionID, manifest }))
  expect(yield* activationRows(sessionID)).toEqual(before)
  expect(forbiddenBuilds).toBe(0)
  if (Exit.isFailure(result) && Option.getOrUndefined(Cause.findErrorOption(result.cause)) === undefined)
    return yield* Effect.die(Cause.squash(result.cause))
  expect(Exit.isFailure(result) && Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(ScopeUnavailableError)
}))

it.effect("scoped activation serializes published generation revocation against the real commit", () => Effect.gen(function* () {
  yield* reset
  const sessionID = yield* seed("standalone")
  const locations = yield* LocationServiceMap.Service
  const context = yield* locations.contextEffect(ref, [SessionGuardrail.standaloneObservationNode, StandaloneConfig.node], "standalone")
  const observation = Context.get(context, SessionGuardrail.Observation)
  const config = Context.get(context, StandaloneConfig.Service)
  const manifest = yield* activationManifest(sessionID, observation)
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const timeline: string[] = []
  const fs = yield* FSUtil.Service
  let boundaryReads = 0
  const fenced = FSUtil.Service.of({ ...fs, readFileString: (...args) => args[0] === policyFile
    ? Effect.sync(() => { boundaryReads++ }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Deferred.await(release)), Effect.andThen(fs.readFileString(...args)))
    : fs.readFileString(...args),
  })
  const events = yield* EventRuntime.Service
  const publish: EventRuntime.Interface["publish"] = (definition, data, options) => events.publish(definition, data, options).pipe(
    Effect.tap(() => definition.type === SessionEvent.Compaction.Ended.type ? Effect.sync(() => { timeline.push("activation-committed") }) : Effect.void),
  )
  const state = yield* activator([
    [FSUtil.node, Layer.succeed(FSUtil.Service, fenced)],
    [StandaloneConfig.node, Layer.succeed(StandaloneConfig.Service, config)],
    [EventRuntime.node, Layer.succeed(EventRuntime.Service, EventRuntime.Service.of({ ...events, publish }))],
  ])
  const activating = yield* state.activate({ sessionID, manifest }).pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
  yield* Effect.raceFirst(Deferred.await(entered), Fiber.join(activating).pipe(Effect.flatMap((result) =>
    Effect.die(Exit.isFailure(result) ? Cause.squash(result.cause) : new Error("Activation completed before the commit barrier")),
  )))
  expect(boundaryReads).toBe(1)
  configText = '{"default_agent":"{file:/synthetic/private}"}'
  const reloading = yield* config.reload().pipe(Effect.exit, Effect.tap(() => Effect.sync(() => { timeline.push("generation-published") })), Effect.forkScoped({ startImmediately: true }))
  yield* Effect.yieldNow
  yield* Deferred.succeed(release, undefined)
  const result = yield* Fiber.join(activating)
  const reloaded = yield* Fiber.join(reloading)
  expect(Exit.isFailure(reloaded) && Option.getOrUndefined(Cause.findErrorOption(reloaded.cause))).toMatchObject({ _tag: "StandaloneConfig.InvalidError", reason: "file-reference" })
  if (Exit.isFailure(result)) return yield* Effect.die(Cause.squash(result.cause))
  expect(Exit.isSuccess(result)).toBe(true)
  expect(timeline).toEqual(["activation-committed", "generation-published"])
}).pipe(Effect.ensuring(reset)))
