import { expect } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Schema, Stream } from "effect"
import { NativeDots } from "../src/dots/native"
import { NativeDecisions } from "../src/dots/native-decisions"
import { DotsAccess } from "../src/dots/access"
import { Config } from "../src/config"
import { Credential } from "../src/credential"
import { Integration } from "../src/integration"
import { Session } from "../src/session"
import { SessionStore } from "../src/session/store"
import { SessionExecution } from "../src/session/execution"
import { SessionOrchestration } from "../src/session/orchestration"
import { SessionReview } from "../src/session/review"
import { SessionGuardrail } from "../src/session/guardrail"
import { Permission } from "../src/permission"
import { Form } from "../src/form"
import { Question } from "../src/question"
import { PluginSupervisor } from "../src/plugin/supervisor"
import { LocationServiceMap } from "../src/location-service-map"
import { Database } from "../src/database/database"
import { KV } from "../src/kv"
import { EventRuntime } from "../src/event"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionPending } from "../src/session/pending"
import { SessionRunnerModel } from "../src/session/runner/model"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Agent } from "../src/agent"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { CcaAuthorizationCloseError, CcaAuthorizationDeniedError } from "../src/cca/authorization"
import { reviewLayer } from "./fixture/review"
import { testEffect } from "./lib/effect"

const idleComputer = { computer: async () => ({ state: "detached" as const }), attachComputer: async () => ({ state: "detached" as const }) }

const it = testEffect(reviewLayer())
const metadataModel = CatalogModel.Info.make({
  id: CatalogModel.ID.make("native-metadata"), modelID: CatalogModel.ID.make("native-api-model"), providerID: Provider.ID.make("synthetic-anthropic"), name: "Native metadata",
  settings: {}, headers: {}, body: {},
  package: "uninstalled-metadata-provider", capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 100, output: 20 },
})
const metadataRef = CatalogModel.Ref.make({ id: metadataModel.id, providerID: metadataModel.providerID })
const setup = Effect.gen(function* () {
  const db = yield* Database.Service
  const events = yield* EventRuntime.Service
  const sessions = yield* Session.Service
  const store = yield* SessionStore.Service
  const execution = yield* SessionExecution.Service
  const projects = yield* Project.Service
  const kv = yield* KV.Service
  const reviews = yield* SessionReview.Service
  const orchestration = yield* SessionOrchestration.Service
  const locations = yield* LocationServiceMap.Service
  const directory = AbsolutePath.make(process.cwd())
  const root = yield* sessions.create({ location: { directory } })
  let documents: Config.GlobalDocuments = { entries: [new Config.Document({ type: "document", scope: "global", info: new Config.Info({ dots: { enabled: true, profile: "trusted" } }) })], diagnostics: [] }
  let credential = new Credential.Info({ id: Credential.ID.make("cred_native"), integrationID: Integration.ID.make("openai"), label: "trusted", value: { type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"), access: "synthetic", refresh: "synthetic", expires: 0, metadata: { accountID: "synthetic-account" } } })
  const listeners = new Set<() => void>()
  const access = DotsAccess.make({ db, kv, configuration: () => Effect.succeed({ ready: true, profile: "trusted" }) })
  yield* access.set({ enabled: true, expectedRevision: 0 })
  const decisions = (session: Session.Info) => Effect.gen(function* () {
    const permission = yield* Permission.Service
    const guardrail = yield* SessionGuardrail.Service
    const forms = yield* Form.Service
    const questions = yield* Question.Service
    return NativeDecisions.make({ permission, guardrail, forms, questions, reviews, orchestration, sessions })
  }).pipe(Effect.provide(locations.get(session.location, [LocationServiceMap.full])))
  const modelReads: string[] = []
  let modelRead = () => Effect.void
  let storeRead = (_id: Session.ID) => Effect.void
  let subscribed = () => Effect.void
  let catalogItems = false
  let selectionRead = (_session: Session.Info) => Effect.void
  let activity: ReadonlySet<Session.ID> | undefined
  let interruptions = 0
  let resolveCredential: NativeDots.Options["credential"] = () => Effect.succeed(undefined)
  let libraryFactory: NonNullable<NativeDots.Options["library"]> = () => Effect.fail(new Error("Library unavailable in fixture"))
  let historyReads = 0
  let hasModels = true
  let admission = () => Effect.void
  const recorded = new Set<string>()
  const executorGrants: SessionGuardrail.EvaluateInput[] = []
  let executorReleases = 0
  let executorReleaseFails = false
  const authorization = (session: Session.Info) => Effect.gen(function* () {
    yield* (yield* PluginSupervisor.Service).flush
    const permission = yield* Permission.Service
    const guardrail = yield* SessionGuardrail.Service
    return { permission, guardrail: { ...guardrail, assert: (input: SessionGuardrail.EvaluateInput) => guardrail.assert(input).pipe(Effect.map((reservation) => {
      executorGrants.push(input)
      return { release: reservation.release.pipe(Effect.andThen(Effect.sleep("5 millis")), Effect.andThen(Effect.suspend(() =>
        executorReleaseFails ? Effect.die(new Error("synthetic-release-secret")) : Effect.sync(() => { executorReleases++ })))) }
    })) } }
  }).pipe(Effect.provide(locations.get(session.location, [LocationServiceMap.full])))
  const host = yield* NativeDots.make({ access, db, kv, reviews, home: directory, data: path.join(os.tmpdir(), "dots-native-data"),
    library: (scope, session) => libraryFactory(scope, session),
    projectRoot: () => Effect.succeed(undefined), authorization, execution: {
    ...execution, active: execution.active.pipe(Effect.map((current) => activity ?? current)),
    interrupt: (id) => execution.interrupt(id).pipe(Effect.tap(() => Effect.sync(() => { interruptions++ }))),
  }, decisions,
    sessions: { ...sessions,
      create: (input) => admission().pipe(Effect.andThen(sessions.create(input))),
      prompt: (input) => admission().pipe(Effect.andThen(sessions.prompt(input))),
      messages: (input) => sessions.messages(input).pipe(Effect.tap(() => Effect.sync(() => { historyReads++ }))),
      list: (input) => sessions.list(input).pipe(Effect.map((result) => ({ ...result, data: [...result.data].sort((left, right) => left.id === root.id ? -1 : right.id === root.id ? 1 : left.id.localeCompare(right.id)) }))),
    },
    store: { ...store, get: (id) => store.get(id).pipe(Effect.tap(() => storeRead(id))) },
    events: { ...events, listen: (listener) => events.listen(listener).pipe(Effect.tap(() => subscribed())) },
    models: (session) => Effect.gen(function* () { modelReads.push(session.location.directory); yield* modelRead(); return [{ id: catalogItems ? session.location.directory : "model", providerID: "provider", name: "Synthetic model" }] }),
    skills: (session) => Effect.gen(function* () { yield* modelRead(); return [{ id: catalogItems ? session.location.directory : "skill", name: "Synthetic skill" }] }),
    selectedModel: (session) => Effect.gen(function* () {
      yield* selectionRead(session)
      return (yield* SessionRunnerModel.selection(session, {
        defaultSelection: () => Effect.succeed(hasModels ? metadataRef : undefined), default: () => Effect.succeed(hasModels ? metadataModel : undefined), available: () => Effect.succeed(hasModels ? [metadataModel] : []),
      }))?.ref
    }),
    projects: { ...projects, list: () => Effect.succeed([{ id: Project.ID.global, worktree: directory, sandboxes: [], time: { created: 0, updated: 0 } }]),
      directories: () => Effect.sync(() => [...recorded].map((item) => ({ directory: AbsolutePath.make(item) }))),
      recordOpened: (opened) => Effect.sync(() => { if (existsSync(opened) && statSync(opened).isDirectory()) recorded.add(opened) }) },
    credentials: { list: () => Effect.succeed([credential]) }, credential: (profile, rejected) => resolveCredential(profile, rejected),
    config: { snapshot: () => Effect.sync(() => documents), subscribe: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } } },
  })
  const pins: NativeDots.Pins = { accessRevision: 1, profile: "trusted", credentialID: credential.id, accountID: "synthetic-account", accountGeneration: 0, environmentID: "environment", connectionID: "connection", isCurrent: () => true }
  const connection = yield* Effect.promise(() => host.attach(pins))
  const channel = connection.channel({ clientID: "client", streamID: "stream" })
  const forms = yield* Form.Service.pipe(Effect.provide(locations.get(root.location, [LocationServiceMap.full])))
  return { root, access, sessions, store, events, forms, host, pins, connection, channel, modelReads, db, kv, reviews, orchestration, locations,
    historyReads: () => historyReads,
    interruptions: () => interruptions,
    executorGrants: () => [...executorGrants],
    executorReleases: () => executorReleases,
    failExecutorReleases: () => { executorReleaseFails = true },
    onCredential: (read: NativeDots.Options["credential"]) => { resolveCredential = read },
    onLibrary: (factory: NonNullable<NativeDots.Options["library"]>) => { libraryFactory = factory },
    onAdmission: (read: () => Effect.Effect<void>) => { admission = read },
    withoutModels: () => { hasModels = false },
    setActivity: (ids: readonly Session.ID[]) => { activity = new Set(ids) },
    onSelection: (read: (session: Session.Info) => Effect.Effect<void, Error>) => { selectionRead = (session) => read(session).pipe(Effect.orDie) },
    onModelRead: (read: () => Effect.Effect<void, Error>) => { modelRead = () => read().pipe(Effect.orDie) },
    onStoreRead: (read: (id: Session.ID) => Effect.Effect<void, Error>) => { storeRead = (id) => read(id).pipe(Effect.orDie) },
    onSubscribed: (read: () => Effect.Effect<void, Error>) => { subscribed = () => read().pipe(Effect.orDie) },
    distinctCatalogItems: () => { catalogItems = true },
    configure: (dots: Config.Info["dots"], shell?: string) => {
      documents = { entries: [new Config.Document({ type: "document", scope: "global", info: new Config.Info({ dots, shell }) })], diagnostics: [] }
      for (const listener of listeners) listener()
    },
    refresh: (accountGeneration: number, generation: number) => { credential = new Credential.Info({ ...credential, accountGeneration, generation }) },
  }
})

it.live("global native access includes ordinary roots, hides child and foreign roots and creates only at recorded locations", () => Effect.gen(function* () {
  const f = yield* setup
  const off = yield* f.sessions.create({ location: f.root.location })
  const child = yield* f.sessions.create({ parentID: f.root.id })
  const remote = yield* f.sessions.create({ location: f.root.location })
  yield* f.events.claim(remote.id, "remote-owner")
  expect((yield* Effect.promise(() => f.channel.listRoots())).map((item) => item.session.id)).toEqual([f.root.id, off.id])
  expect((yield* Effect.promise(() => f.channel.getRoot(off.id)))?.session.id).toBe(off.id)
  for (const id of [child.id, remote.id]) expect(yield* Effect.promise(() => f.channel.getRoot(id))).toBeUndefined()
  yield* Effect.promise(async () => { await expect(f.channel.createRoot({ directory: "/unrecorded-native-location", inputID: "create" })).rejects.toThrow() })
  const created = yield* Effect.promise(() => f.channel.createRoot({ directory: f.root.location.directory, inputID: "create" }))
  expect(created.session.origin).toBeUndefined()
  expect((yield* f.sessions.get(created.session.id)).origin).toBeUndefined()
  expect(yield* createdData(f, created.session.id)).not.toHaveProperty("origin")
  expect((yield* f.sessions.list({ parentID: null, background: "exclude" })).data.map((session) => session.id)).toContain(created.session.id)
  expect((yield* f.access.get()).enabled).toBe(true)
  expect((yield* Effect.promise(() => f.channel.createRoot({ directory: f.root.location.directory, inputID: "create" }))).session.id).toBe(created.session.id)
  yield* f.sessions.archive(f.root.id)
  expect(yield* Effect.promise(() => f.channel.getRoot(f.root.id))).toBeUndefined()
  yield* f.access.set({ enabled: false, expectedRevision: 1 })
  yield* Effect.promise(async () => { await expect(f.channel.createRoot({ directory: f.root.location.directory, inputID: "create" })).rejects.toThrow() })
  expect((yield* f.access.get()).enabled).toBe(false)
}))

it.live("global Off retires every channel without interrupting execution, consuming pending decisions or deleting admitted input", () => Effect.gen(function* () {
  const f = yield* setup
  const other = yield* f.sessions.create({ location: f.root.location })
  const form = yield* f.forms.create({ sessionID: other.id, title: "Pending decision", fields: [{ type: "string", key: "answer", required: true }] })
  const request = (yield* Effect.promise(() => f.channel.pending(other.id)))[0]!
  const admitted = yield* Effect.promise(() => f.channel.prompt({ rootID: f.root.id, inputID: "admitted-before-off", text: "Synthetic task", delivery: "queue" }))
  f.setActivity([f.root.id])
  let notifications = 0
  const unsubscribe = f.host.subscribeConfiguration(() => { notifications++ })
  yield* f.access.set({ enabled: false, expectedRevision: 1 })
  expect(notifications).toBe(1)
  expect(f.interruptions()).toBe(0)
  expect((yield* f.sessions.pending(f.root.id)).some((item) => item.id === admitted.messageID)).toBe(true)
  expect(yield* f.forms.state(form.id)).toEqual({ status: "pending" })
  yield* Effect.promise(async () => { await expect(f.channel.listRoots()).rejects.toThrow() })
  yield* Effect.promise(async () => { await expect(f.channel.settle(request.handle, { value: { answers: ["invalid"] }, action: { answers: ["Continue"] } })).rejects.toThrow() })
  expect(yield* Effect.promise(() => f.host.configuration())).toEqual({ enabled: false })
  unsubscribe()
}))

it.live("a Dots display-name change keeps native pins, channels, candidates and configuration identity", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.forms.create({ sessionID: f.root.id, title: "Pending decision", fields: [{ type: "string", key: "answer", required: true }] })
  const request = (yield* Effect.promise(() => f.channel.pending(f.root.id)))[0]!
  const before = yield* Effect.promise(() => f.host.configuration())
  let retired = 0
  let notifications = 0
  const stop = yield* Effect.promise(() => f.channel.subscribe(f.root.id, () => {}, () => { retired++ }))
  const unsubscribe = f.host.subscribeConfiguration(() => { notifications++ })
  expect(yield* Effect.promise(() => f.host.name())).toBeUndefined()
  f.configure({ enabled: true, profile: "trusted", name: "Desk Mac" })
  expect(yield* Effect.promise(() => f.host.name())).toBe("Desk Mac")
  f.configure({ enabled: true, profile: "trusted", name: "Renamed Desk" })
  expect(yield* Effect.promise(() => f.host.name())).toBe("Renamed Desk")
  expect([retired, notifications]).toEqual([0, 0])
  expect(yield* Effect.promise(() => f.host.configuration())).toEqual(before)
  expect((yield* Effect.promise(() => f.channel.pending(f.root.id)))[0]!.handle).toBe(request.handle)
  expect((yield* Effect.promise(() => f.channel.listRoots())).map((item) => item.session.id)).toContain(f.root.id)
  f.configure({ enabled: true, profile: "trusted" })
  expect(yield* Effect.promise(() => f.host.name())).toBeUndefined()
  expect([retired, notifications]).toEqual([0, 0])
  f.configure({ enabled: true, profile: "other", name: "Renamed Desk" })
  expect([retired, notifications]).toEqual([1, 1])
  unsubscribe()
  stop()
}))

it.live("global Off during native candidate validation rejects settlement without answering its owner", () => Effect.gen(function* () {
  const f = yield* setup
  const form = yield* f.forms.create({ sessionID: f.root.id, title: "Delayed decision", fields: [{ type: "string", key: "answer", required: true }] })
  const request = (yield* Effect.promise(() => f.channel.pending(f.root.id)))[0]!
  f.onStoreRead(() => Effect.gen(function* () {
    f.onStoreRead(() => Effect.void)
    yield* f.access.set({ enabled: false, expectedRevision: 1 })
  }))
  yield* Effect.promise(async () => { await expect(f.channel.settle(request.handle, { value: { answers: ["stale"] }, action: { answers: ["Continue"] } })).rejects.toThrow() })
  expect(yield* f.forms.state(form.id)).toEqual({ status: "pending" })
  expect(yield* f.access.get()).toEqual({ enabled: false, revision: 2 })
}))

it.live("native Host scope closure unregisters its transport and rejects late attachment", () => Effect.gen(function* () {
  const f = yield* Effect.gen(function* () {
    const f = yield* setup
    const release = f.host.attachTransport({ ...idleComputer, status: async () => ({ state: "connected", hostname: "Synthetic.local" }) })
    expect((yield* f.access.status()).connection.state).toBe("connected")
    return { ...f, release }
  }).pipe(Effect.scoped)
  expect((yield* f.access.status()).connection.state).toBe("unavailable")
  expect(() => f.host.attachTransport({ ...idleComputer, status: async () => ({ state: "connecting" }) })).toThrow()
  const release = f.access.attachTransport({ ...idleComputer, status: async () => ({ state: "connecting" }) })
  f.release()
  expect((yield* f.access.status()).connection.state).toBe("connecting")
  release()
}))

it.live("unreadable native authority reports configuration failure and permanently retires its existing channels", () => Effect.gen(function* () {
  const f = yield* setup
  let retired = 0
  let notifications = 0
  const stop = yield* Effect.promise(() => f.channel.subscribe(f.root.id, () => {}, () => { retired++ }))
  const unsubscribe = f.host.subscribeConfiguration(() => { notifications++ })
  yield* f.kv.set("dots.native-access", { enabled: true, revision: -1 })
  yield* Effect.promise(async () => { await expect(f.host.configuration()).rejects.toThrow() })
  expect(retired).toBe(1)
  expect(notifications).toBe(1)
  expect((yield* f.access.status().pipe(Effect.flip)).code).toBe("unavailable")
  yield* Effect.promise(async () => { await expect(f.host.configuration()).rejects.toThrow() })
  expect(notifications).toBe(1)
  yield* f.kv.set("dots.native-access", { enabled: true, revision: 1 })
  yield* Effect.promise(async () => { await expect(f.channel.listRoots()).rejects.toThrow() })
  unsubscribe()
  stop()
}))

for (const kind of ["credential", "root", "content"] as const) it.live(`unreadable native authority retires ${kind} event observers without failing the event publisher`, () => Effect.gen(function* () {
  const f = yield* setup
  let retired = 0
  let forwarded = 0
  let observed = 0
  const stop = yield* Effect.promise(() => f.channel.subscribe(f.root.id, () => { forwarded++ }, () => { retired++ }))
  const unlisten = yield* f.events.listen(() => Effect.sync(() => { observed++ }))
  yield* f.kv.set("dots.native-access", { enabled: true, revision: -1 })
  const event: Effect.Effect<unknown, Form.AlreadyExistsError | Form.InvalidFormError> = kind === "credential"
    ? f.events.publish(Integration.Event.ConnectionUpdated, { integrationID: Integration.ID.make("openai") })
    : kind === "content"
      ? f.events.publish(SessionEvent.PredictionUpdated, { sessionID: f.root.id, sourceMessageID: SessionMessage.ID.create(), text: "Synthetic prediction" })
      : f.forms.create({ sessionID: f.root.id, title: "Unchanged owner", fields: [{ type: "string", key: "answer" }] })
  expect((yield* event.pipe(Effect.exit))._tag).toBe("Success")
  expect(retired).toBe(1)
  expect(forwarded).toBe(0)
  expect(observed).toBeGreaterThan(0)
  yield* f.kv.set("dots.native-access", { enabled: true, revision: 1 })
  yield* Effect.promise(async () => { await expect(f.channel.listRoots()).rejects.toThrow() })
  yield* unlisten
  stop()
}))

for (const kind of ["create", "prompt"] as const) it.live(`unreadable native authority denies ${kind} at the Session admission validator`, () => Effect.gen(function* () {
  const f = yield* setup
  f.onAdmission(() => f.kv.set("dots.native-access", { enabled: true, revision: -1 }))
  const request = kind === "create"
    ? f.channel.createRoot({ directory: f.root.location.directory, inputID: "unreadable-authority" })
    : f.channel.prompt({ rootID: f.root.id, inputID: "unreadable-authority", text: "Synthetic denied task", delivery: "queue" })
  yield* Effect.promise(async () => { await expect(request).rejects.toBeInstanceOf(Session.NotFoundError) })
  expect((yield* f.sessions.list({})).data.map((session) => session.id)).toEqual([f.root.id])
  expect(yield* f.sessions.pending(f.root.id)).toEqual([])
}))

for (const reenabling of [false, true]) it.live(`credential resolution rejects delayed authority after global Off${reenabling ? "-On" : ""}`, () => Effect.gen(function* () {
  const f = yield* setup
  f.onCredential(() => Effect.gen(function* () {
    expect((yield* f.access.set({ enabled: false, expectedRevision: 1 }).pipe(Effect.exit))._tag).toBe("Success")
    if (reenabling) expect((yield* f.access.set({ enabled: true, expectedRevision: 2 }).pipe(Effect.exit))._tag).toBe("Success")
    return { access: "synthetic", key: "synthetic", profile: f.pins.profile, credentialID: f.pins.credentialID, accountID: f.pins.accountID, accountGeneration: 0 }
  }))
  expect(yield* Effect.promise(() => f.host.credential("trusted"))).toBeUndefined()
}))

it.live("global access never exposes missing or deleted roots or descendants under foreign ownership", () => Effect.gen(function* () {
  const f = yield* setup
  const removed = yield* f.sessions.create({ location: f.root.location })
  yield* f.sessions.remove(removed.id)
  expect(yield* Effect.promise(() => f.channel.getRoot(removed.id))).toBeUndefined()
  expect(yield* Effect.promise(() => f.channel.getRoot("ses_missing"))).toBeUndefined()
  const child = yield* f.sessions.create({ parentID: f.root.id })
  const grandchild = yield* f.sessions.create({ parentID: child.id })
  const forms = yield* Effect.forEach([child, grandchild], (session) => f.forms.create({ sessionID: session.id, title: "Private child", fields: [{ type: "string", key: "answer" }] }))
  yield* f.events.claim(child.id, "foreign-owner")
  const pending = yield* Effect.promise(() => f.channel.pending(f.root.id))
  for (const form of forms) expect(pending.some((request) => request.itemID === form.id)).toBe(false)
}))

it.live("config off-on and account replacement retire handles while unrelated config and refresh preserve access", () => Effect.gen(function* () {
  const f = yield* setup
  yield* Effect.promise(async () => { await expect(f.host.attach({ ...f.pins, credentialID: "foreign" })).rejects.toThrow() })
  yield* Effect.promise(async () => { await expect(f.host.attach({ ...f.pins, isCurrent: () => false })).rejects.toThrow() })
  f.configure({ enabled: true, profile: "trusted" }, "different-shell")
  f.refresh(0, 1)
  expect((yield* Effect.promise(() => f.channel.getRoot(f.root.id)))?.session.id).toBe(f.root.id)
  f.configure({ enabled: false })
  f.configure({ enabled: true, profile: "trusted" })
  yield* Effect.promise(async () => { await expect(f.channel.listRoots()).rejects.toThrow() })
  expect((yield* f.access.get()).enabled).toBe(true)
  const current = yield* Effect.promise(() => f.host.attach({ ...f.pins, connectionID: "new-connection" }))
  const channel = current.channel({ clientID: "client", streamID: "new-stream" })
  f.refresh(1, 2)
  yield* Effect.promise(async () => { await expect(channel.listRoots()).rejects.toThrow() })
  yield* Effect.promise(async () => { await expect(f.host.attach(f.pins)).rejects.toThrow() })
  expect((yield* f.access.get()).enabled).toBe(true)
}))

it.live("native prompt retries keep the original admitted input and trusted provenance", () => Effect.gen(function* () {
  const f = yield* setup
  const input = { rootID: f.root.id, inputID: "stable-input", text: "Synthetic native task", delivery: "queue" as const }
  const first = yield* Effect.promise(() => f.channel.prompt(input))
  const second = yield* Effect.promise(() => f.channel.prompt({ ...input, text: "Replacement must not overwrite" }))
  expect(second).toEqual(first)
  const pending = (yield* f.sessions.pending(f.root.id)).find((item) => item.id === first.messageID)
  expect(pending?.type === "user" && pending.data.text).toBe(input.text)
  expect(pending?.type === "user" && pending.data.metadata?.nativeSource).toMatchObject({ kind: "dots-native", clientID: "client", streamID: "stream", requestID: "stable-input" })
  const local = yield* f.sessions.prompt({ sessionID: f.root.id, text: "Untrusted source field", resume: false, metadata: { nativeSource: { kind: "dots-native" } } })
  expect(local.data.metadata?.nativeSource).toBeUndefined()
}))

it.live("opaque native form handles reject cross-stream, empty, stale, and duplicate settlement and retain provenance", () => Effect.gen(function* () {
  const f = yield* setup
  const form = yield* f.forms.create({ sessionID: f.root.id, title: "Synthetic choice", fields: [{ type: "string", key: "choice", required: true }] })
  const request = (yield* Effect.promise(() => f.channel.pending(f.root.id))).find((item) => item.itemID === form.id)!
  expect(request).toBeDefined()
  const second = f.connection.channel({ clientID: "other-client", streamID: "other-stream" })
  const answers = { value: { answers: ["selected"] }, action: { answers: ["Continue"] } }
  yield* Effect.promise(async () => { await expect(second.settle(request.handle, answers)).rejects.toThrow() })
  yield* Effect.promise(async () => { await expect(f.channel.settle(request.handle, {})).rejects.toThrow() })
  expect((yield* f.forms.state(form.id)).status).toBe("pending")
  const settlements = yield* Effect.promise(() => Promise.allSettled([f.channel.settle(request.handle, answers), f.channel.settle(request.handle, answers)]))
  expect(settlements.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(settlements.filter((result) => result.status === "rejected")).toHaveLength(1)
  expect((yield* f.forms.state(form.id)).status).toBe("answered")
  yield* Effect.promise(async () => { await expect(f.channel.settle(request.handle, answers)).rejects.toThrow() })
  const log = yield* f.events.log({ aggregateID: f.root.id, follow: false }).pipe(Stream.runCollect)
  const receipts = Array.from(log).filter((event) => event.type === SessionEvent.DotsDecisionSettled.type)
  expect(receipts).toHaveLength(1)
  const receipt = receipts[0]
  if (!receipt || EventRuntime.isSynced(receipt)) throw new Error("Missing native settlement receipt")
  expect(Schema.decodeUnknownSync(SessionEvent.DotsDecisionSettled.data)(receipt.data).source).toMatchObject({ kind: "dots-native", credentialID: "cred_native", accountGeneration: 0, clientID: "client", streamID: "stream", requestID: request.id, rootSessionID: f.root.id, accessRevision: 1 })
  const next = yield* f.forms.create({ sessionID: f.root.id, title: "Revoked choice", fields: [{ type: "string", key: "choice", required: true }] })
  const stale = (yield* Effect.promise(() => f.channel.pending(f.root.id))).find((item) => item.itemID === next.id)!
  yield* f.access.set({ enabled: false, expectedRevision: 1 })
  yield* f.access.set({ enabled: true, expectedRevision: 2 })
  yield* Effect.promise(async () => { await expect(f.channel.settle(stale.handle, answers)).rejects.toThrow() })
  expect((yield* f.forms.state(next.id)).status).toBe("pending")
  f.channel.retire()
  yield* Effect.promise(async () => { await expect(f.channel.pending(f.root.id)).rejects.toThrow() })
}))

it.live("native forms preserve typed options, conditional fields, and multiselect values without JSON transport", () => Effect.gen(function* () {
  const f = yield* setup
  const form = yield* f.forms.create({ sessionID: f.root.id, title: "Typed selection", fields: [
    { type: "multiselect", key: "features", required: true, minItems: 1, maxItems: 1, options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
    { type: "integer", key: "count", required: true, minimum: 2, maximum: 4, when: [{ key: "features", op: "eq", value: "a" }] },
    { type: "string", key: "hidden", required: true, when: [{ key: "features", op: "eq", value: "b" }] },
  ] })
  const first = (yield* Effect.promise(() => f.channel.pending(f.root.id))).find((item) => item.itemID === form.id)!
  expect(first.questions.some((item) => item.question.includes("Alpha") && item.options?.some((option) => option.label === "Select"))).toBe(true)
  expect(first.questions.some((item) => item.question.includes("Return JSON"))).toBe(false)
  yield* Effect.promise(async () => { await expect(f.channel.settle(first.handle, { "option:0": { answers: ["Select"] }, action: { answers: ["Continue"] } })).rejects.toThrow() })
  yield* Effect.promise(() => f.channel.settle(first.handle, { "option:0": { answers: ["Select"] }, "option:1": { answers: ["Do not select"] }, action: { answers: ["Continue"] } }))
  expect((yield* f.forms.state(form.id)).status).toBe("pending")
  const second = (yield* Effect.promise(() => f.channel.pending(f.root.id))).find((item) => item.itemID === form.id)!
  expect(second.id).not.toBe(first.id)
  expect(second.questions[0]!.header).toBe("count")
  yield* Effect.promise(async () => { await expect(f.channel.settle(first.handle, { value: { answers: ["3"] }, action: { answers: ["Continue"] } })).rejects.toThrow() })
  yield* Effect.promise(async () => { await expect(f.channel.settle(second.handle, { value: { answers: ["1"] }, action: { answers: ["Continue"] } })).rejects.toThrow() })
  yield* Effect.promise(() => f.channel.settle(second.handle, { value: { answers: ["3"] }, action: { answers: ["Continue"] } }))
  expect(yield* f.forms.state(form.id)).toEqual({ status: "answered", answer: { features: ["a"], count: 3 } })
}))

it.live("native catalogs union global eligible root contexts and reject a global revocation", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.sessions.create({ location: f.root.location })
  yield* f.sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })
  expect(yield* Effect.promise(() => f.channel.models())).toEqual([{ id: "model", providerID: "provider", name: "Synthetic model" }])
  expect(f.modelReads).toEqual([f.root.location.directory, "/tmp"])
  expect(yield* Effect.promise(() => f.channel.skills())).toEqual([{ id: "skill", name: "Synthetic skill" }])
  f.onModelRead(() => Effect.gen(function* () {
    yield* f.access.set({ enabled: false, expectedRevision: 1 })
  }))
  yield* Effect.promise(async () => { await expect(f.channel.models()).rejects.toThrow() })
  const count = f.modelReads.length
  yield* Effect.promise(async () => { await expect(f.channel.models()).rejects.toThrow() })
  expect(f.modelReads).toHaveLength(count)
  yield* Effect.promise(async () => { await expect(f.channel.skills()).rejects.toThrow() })
}))

it.live("custom multiselect stages get distinct native IDs and commit only after finishing", () => Effect.gen(function* () {
  const f = yield* setup
  const form = yield* f.forms.create({ sessionID: f.root.id, title: "Custom selections", fields: [{ type: "multiselect", key: "values", required: true, custom: true, options: [] }] })
  const initial = (yield* Effect.promise(() => f.channel.pending(f.root.id))).find((item) => item.itemID === form.id)!
  yield* Effect.promise(() => f.channel.settle(initial.handle, { action: { answers: ["Custom answer"] } }))
  const ids = [initial.id]
  for (const value of ["first", "second"]) {
    const stage = (yield* Effect.promise(() => f.channel.pending(f.root.id))).find((item) => item.itemID === form.id)!
    expect(ids).not.toContain(stage.id)
    ids.push(stage.id)
    yield* Effect.promise(() => f.channel.settle(stage.handle, { action: { answers: ["Add value"] }, value: { answers: [value] } }))
    expect((yield* f.forms.state(form.id)).status).toBe("pending")
  }
  const final = (yield* Effect.promise(() => f.channel.pending(f.root.id))).find((item) => item.itemID === form.id)!
  expect(ids).not.toContain(final.id)
  yield* Effect.promise(() => f.channel.settle(final.handle, { action: { answers: ["Finish"] } }))
  expect(yield* f.forms.state(form.id)).toEqual({ status: "answered", answer: { values: ["first", "second"] } })
}))

for (const reason of ["revision", "archive"] as const) it.live(`native subscription retires once on global ${reason} or its root archive but not another root archive`, () => Effect.gen(function* () {
  const f = yield* setup
  const other = yield* f.sessions.create({ location: f.root.location })
  let retired = 0
  let resolve!: () => void
  const closed = new Promise<void>((done) => { resolve = done })
  const stop = yield* Effect.promise(() => f.channel.subscribe(f.root.id, () => {}, () => { retired++; resolve() }))
  yield* f.sessions.archive(other.id)
  expect(retired).toBe(0)
  if (reason === "archive") yield* f.sessions.archive(f.root.id)
  else yield* f.access.set({ enabled: false, expectedRevision: 1 })
  yield* Effect.promise(() => closed).pipe(Effect.timeout("500 millis"))
  if (reason === "revision") yield* f.access.set({ enabled: true, expectedRevision: 2 })
  f.channel.retire()
  stop()
  expect(retired).toBe(1)
}))

it.live("root listing excludes an earlier root archived during a later root read", () => Effect.gen(function* () {
  const f = yield* setup
  const other = yield* f.sessions.create({ location: f.root.location })
  f.onStoreRead((id) => Effect.gen(function* () {
    if (id !== other.id) return
    f.onStoreRead(() => Effect.void)
    yield* f.sessions.archive(f.root.id)
  }))
  expect((yield* Effect.promise(() => f.channel.listRoots())).map((item) => item.session.id)).toEqual([other.id])
}))

for (const kind of ["models", "skills"] as const) it.live(`native ${kind} exclude an earlier contribution archived during a later validation`, () => Effect.gen(function* () {
  const f = yield* setup
  const other = yield* f.sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })
  f.distinctCatalogItems()
  let reads = 0
  f.onModelRead(() => Effect.sync(() => {
    if (++reads !== 2) return
    f.onStoreRead((id) => Effect.gen(function* () {
      if (id !== other.id) return
      f.onStoreRead(() => Effect.void)
      yield* f.sessions.archive(f.root.id)
    }))
  }))
  expect((yield* Effect.promise(() => f.channel[kind]())).map((item) => item.id)).toEqual([other.location.directory])
}))

for (const retired of ["source", "account"] as const) it.live(`native catalog rejects ${retired} retirement during a delayed read`, () => Effect.gen(function* () {
  const f = yield* setup
  f.onModelRead(() => Effect.sync(() => {
    if (retired === "source") f.connection.retire()
    else f.refresh(1, 1)
  }))
  yield* Effect.promise(async () => { await expect(f.channel.models()).rejects.toThrow() })
}))

it.live("global retirement resets drafts for every root and descendant without settling their owners", () => Effect.gen(function* () {
  const f = yield* setup
  const child = yield* f.sessions.create({ parentID: f.root.id })
  const other = yield* f.sessions.create({ location: f.root.location })
  const forms = yield* Effect.forEach([f.root, child, other], (session) => f.forms.create({ sessionID: session.id, title: "Staged answer", fields: [
    { type: "string", key: "first", required: true }, { type: "string", key: "second", required: true },
  ] }))
  const initial = [...(yield* Effect.promise(() => f.channel.pending(f.root.id))), ...(yield* Effect.promise(() => f.channel.pending(other.id)))]
  for (const request of initial) yield* Effect.promise(() => f.channel.settle(request.handle, { value: { answers: ["old"] }, action: { answers: ["Continue"] } }))
  const staged = [...(yield* Effect.promise(() => f.channel.pending(f.root.id))), ...(yield* Effect.promise(() => f.channel.pending(other.id)))]
  expect(staged).toHaveLength(3)
  expect(staged.every((request) => request.questions[0]?.header === "second")).toBe(true)
  yield* f.access.set({ enabled: false, expectedRevision: 1 })
  yield* f.access.set({ enabled: true, expectedRevision: 2 })
  for (const request of staged)
    yield* Effect.promise(async () => { await expect(f.channel.settle(request.handle, { value: { answers: ["stale"] }, action: { answers: ["Continue"] } })).rejects.toThrow() })
  yield* Effect.promise(async () => { await expect(f.host.attach(f.pins)).rejects.toThrow() })
  const connection = yield* Effect.promise(() => f.host.attach({ ...f.pins, accessRevision: 3, connectionID: "fresh-connection" }))
  const channel = connection.channel({ clientID: "client", streamID: "fresh-stream" })
  const fresh = [...(yield* Effect.promise(() => channel.pending(f.root.id))), ...(yield* Effect.promise(() => channel.pending(other.id)))]
  expect(fresh).toHaveLength(3)
  for (const request of fresh) {
    expect(request.questions[0]?.header).toBe("first")
    expect(staged.some((old) => old.handle === request.handle || old.id === request.id)).toBe(false)
    yield* Effect.promise(() => channel.settle(request.handle, { value: { answers: ["fresh"] }, action: { answers: ["Continue"] } }))
  }
  for (const request of [...(yield* Effect.promise(() => channel.pending(f.root.id))), ...(yield* Effect.promise(() => channel.pending(other.id)))])
    yield* Effect.promise(() => channel.settle(request.handle, { value: { answers: ["done"] }, action: { answers: ["Continue"] } }))
  for (const form of forms) expect(yield* f.forms.state(form.id)).toEqual({ status: "answered", answer: { first: "fresh", second: "done" } })
}))

it.live("subscription setup revocation retires once and forwards no later content", () => Effect.gen(function* () {
  const f = yield* setup
  let retired = 0
  const received: string[] = []
  f.onSubscribed(() => Effect.gen(function* () {
    f.onSubscribed(() => Effect.void)
    yield* f.access.set({ enabled: false, expectedRevision: 1 })
  }))
  const stop = yield* Effect.promise(() => f.channel.subscribe(f.root.id, (event) => { received.push(event.type) }, () => { retired++ }))
  expect(retired).toBe(1)
  yield* f.access.set({ enabled: true, expectedRevision: 2 })
  yield* f.forms.create({ sessionID: f.root.id, title: "Not forwarded", fields: [{ type: "string", key: "answer" }] })
  f.channel.retire()
  stop()
  expect(retired).toBe(1)
  expect(received).toEqual([])
}))

it.live("native root snapshots share configured model and live activity without loading history or provider packages", () => Effect.gen(function* () {
  const f = yield* setup
  const expected = { session: f.root, selectedModel: metadataRef, active: false, waiting: [] }
  expect(yield* Effect.promise(() => f.channel.getRoot(f.root.id))).toEqual(expected)
  expect(yield* Effect.promise(() => f.channel.listRoots())).toEqual([expected])
  const created = yield* Effect.promise(() => f.channel.createRoot({ directory: f.root.location.directory, inputID: "snapshot-create" }))
  expect(created).toMatchObject({ selectedModel: metadataRef, active: false, waiting: [] })
  expect(created.session.id).not.toBe(f.root.id)
  expect(f.historyReads()).toBe(0)
  f.setActivity([created.session.id])
  expect((yield* Effect.promise(() => f.channel.getRoot(f.root.id)))?.active).toBe(false)
  f.setActivity([f.root.id])
  expect((yield* Effect.promise(() => f.channel.getRoot(f.root.id)))?.active).toBe(true)
  const read = yield* Effect.promise(() => f.channel.readRoot(f.root.id))
  expect(read).toMatchObject({ ...expected, active: true, messages: [] })
  expect(f.historyReads()).toBe(1)
  f.setActivity([])
  f.withoutModels()
  expect(yield* Effect.promise(() => f.channel.getRoot(f.root.id))).toEqual({ session: f.root, active: false, waiting: [] })
}))

it.live("native root snapshot waits follow permission and family input owners rather than question wording", () => Effect.gen(function* () {
  const f = yield* setup
  const agent = Agent.ID.make("native-snapshot")
  const services = yield* Effect.gen(function* () { return { agents: yield* Agent.Service, permissions: yield* Permission.Service } }).pipe(Effect.provide(f.locations.get(f.root.location, [LocationServiceMap.full])))
  yield* services.agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
  const approval = yield* services.permissions.ask({ sessionID: f.root.id, agent, action: "edit", resources: ["Which option?"], requireExplicitDecision: true })
  expect(approval.effect).toBe("ask")
  const child = yield* f.sessions.create({ parentID: f.root.id })
  yield* f.forms.create({ sessionID: child.id, title: "Approval", fields: [{ type: "string", key: "answer", required: true }] })
  yield* f.forms.create({ sessionID: f.root.id, title: "Allow once", fields: [{ type: "string", key: "answer", required: true }] })
  expect(yield* Effect.promise(() => f.channel.getRoot(f.root.id))).toMatchObject({ active: false, waiting: ["approval", "user-input"] })
  f.setActivity([f.root.id])
  expect((yield* Effect.promise(() => f.channel.readRoot(f.root.id))).waiting).toEqual(["approval", "user-input"])
  const permission = (yield* services.permissions.forSession(f.root.id))[0]!
  const request = (yield* Effect.promise(() => f.channel.pending(f.root.id))).find((item) => item.itemID === permission.id)!
  yield* Effect.promise(() => f.channel.settle(request.handle, { answer: { answers: ["Reject"] } }))
  expect((yield* Effect.promise(() => f.channel.getRoot(f.root.id)))?.waiting).toEqual(["user-input"])
}))

for (const method of ["get", "read", "list", "create"] as const) it.live(`native ${method} snapshot does not expose a root revoked during model enrichment`, () => Effect.gen(function* () {
  const f = yield* setup
  f.onSelection((session) => Effect.gen(function* () {
    f.onSelection(() => Effect.void)
    yield* f.access.set({ enabled: false, expectedRevision: 1 })
  }))
  if (method === "get") expect(yield* Effect.promise(() => f.channel.getRoot(f.root.id))).toBeUndefined()
  else if (method === "list") yield* Effect.promise(async () => { await expect(f.channel.listRoots()).rejects.toThrow() })
  else yield* Effect.promise(async () => { await expect(method === "read" ? f.channel.readRoot(f.root.id) : f.channel.createRoot({ directory: f.root.location.directory, inputID: "revoked-create" })).rejects.toThrow() })
}))

it.live("native root list revalidates earlier snapshots after later model enrichment", () => Effect.gen(function* () {
  const f = yield* setup
  const other = yield* f.sessions.create({ location: f.root.location })
  f.onSelection((session) => Effect.gen(function* () {
    if (session.id !== other.id) return
    f.onSelection(() => Effect.void)
    yield* f.sessions.archive(f.root.id)
  }))
  expect((yield* Effect.promise(() => f.channel.listRoots())).map((item) => item.session.id)).toEqual([other.id])
}))

for (const retired of ["source", "account"] as const) it.live(`native root metadata rejects ${retired} retirement during enrichment`, () => Effect.gen(function* () {
  const f = yield* setup
  f.onSelection(() => Effect.sync(() => { if (retired === "source") f.connection.retire(); else f.refresh(1, 1) }))
  expect(yield* Effect.promise(() => f.channel.getRoot(f.root.id))).toBeUndefined()
}))

it.live("native root metadata preserves known model-selection failures", () => Effect.gen(function* () {
  const f = yield* setup
  const root = yield* f.sessions.create({ location: f.root.location, model: { ...metadataRef, id: CatalogModel.ID.make("missing-model") } })
  yield* Effect.promise(async () => { await expect(f.channel.getRoot(root.id)).rejects.toThrow("missing-model") })
}))

for (const boundary of ["permission", "guardrail"] as const) it.live(`missing Session during deferred ${boundary} validation fails closed without settlement`, () => Effect.gen(function* () {
  const f = yield* setup
  const agent = Agent.ID.make("native-validation")
  const agents = yield* Agent.Service.pipe(Effect.provide(f.locations.get(f.root.location, [LocationServiceMap.full])))
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "allow" }] }))
  const root = yield* f.sessions.create({ location: f.root.location, agent })
  const services = yield* Effect.gen(function* () {
    return { permission: yield* Permission.Service, guardrail: yield* SessionGuardrail.Service, questions: yield* Question.Service }
  }).pipe(Effect.provide(f.locations.get(f.root.location, [LocationServiceMap.full])))
  const requestID = Guardrail.RequestID.make("grq_missing_session")
  const item = yield* f.reviews.open({ sessionID: root.id, kind: "guardrail", reason: "sleep_entry", origin: { requestID }, limit: 10,
    payload: { type: "guardrail", action: "shell", resources: ["synthetic command"], ruleIDs: [], reason: "Synthetic review", hardReview: false, directories: [], fingerprint: "a".repeat(64), requestID },
  })
  let checked = 0
  const missing = () => Effect.sync(() => { checked++ }).pipe(Effect.andThen(Effect.fail(new Session.NotFoundError({ sessionID: root.id }))))
  const decisions = NativeDecisions.make({ ...services, forms: f.forms, reviews: f.reviews, orchestration: f.orchestration, sessions: f.sessions,
    permission: boundary === "permission" ? { ...services.permission, evaluateEffective: missing } : services.permission,
    guardrail: boundary === "guardrail" ? { ...services.guardrail, evaluate: missing } : services.guardrail,
  })
  const request = (yield* decisions.pending(root.id)).find((request) => request.id === item.itemID)!
  const source: Form.NativeReplySource = { kind: "dots-native", profile: f.pins.profile, credentialID: f.pins.credentialID, accountID: f.pins.accountID,
    accountGeneration: f.pins.accountGeneration, environmentID: f.pins.environmentID, connectionID: f.pins.connectionID,
    clientID: "client", streamID: "stream", rootSessionID: root.id, accessRevision: 1, requestID: request.id }
  const error = yield* decisions.settle(request, { answer: { answers: ["Allow once"] } }, source, () => Effect.succeed(true)).pipe(Effect.flip)
  expect(checked).toBe(1)
  expect(error).toBeInstanceOf(SessionReview.ConflictError)
  expect((yield* f.reviews.list(root.id)).map((review) => review.itemID)).toEqual([item.itemID])
  expect(yield* SessionPending.lookup(f.db.db, root.id, SessionReview.promptID(item.itemID))).toBeUndefined()
  const log = yield* f.events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
  expect(log.filter((event) => event.type === SessionEvent.DotsDecisionSettled.type || event.type === SessionEvent.Review.Decided.type)).toEqual([])
}))

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "dots-native-root-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

it.live("native createRoot accepts an existing unrecorded absolute directory and rejects relative, missing, or file locations", () => Effect.gen(function* () {
  const f = yield* setup
  const directory = yield* temporaryDirectory
  const created = yield* Effect.promise(() => f.channel.createRoot({ directory: path.join(directory, "."), inputID: "unrecorded-create", title: "Synthetic root" }))
  expect(created.session.location.directory).toBe(AbsolutePath.make(directory))
  expect(created.session.title).toBe("Synthetic root")
  expect((yield* Effect.promise(() => f.channel.createRoot({ directory, inputID: "unrecorded-create" }))).session.id).toBe(created.session.id)
  const missing = path.join(directory, "missing")
  const file = path.join(directory, "file.txt")
  yield* Effect.promise(() => writeFile(file, "synthetic"))
  for (const target of ["relative/synthetic", missing, file])
    yield* Effect.promise(async () => { await expect(f.channel.createRoot({ directory: target, inputID: `reject-${target}` })).rejects.toBeInstanceOf(NativeDots.Error) })
  expect(existsSync(missing)).toBe(false)
  expect((yield* f.sessions.list({ parentID: null })).data.filter((session) => session.location.directory !== f.root.location.directory).map((session) => session.id)).toEqual([created.session.id])
}).pipe(Effect.scoped))

it.live("native rename stores the exact title only for a current eligible root", () => Effect.gen(function* () {
  const f = yield* setup
  const child = yield* f.sessions.create({ parentID: f.root.id })
  yield* Effect.promise(() => f.channel.renameRoot({ rootID: f.root.id, title: "  Synthetic title  " }))
  expect((yield* f.sessions.get(f.root.id)).title).toBe("  Synthetic title  ")
  yield* Effect.promise(async () => { await expect(f.channel.renameRoot({ rootID: f.root.id, title: "   " })).rejects.toBeInstanceOf(NativeDots.Error) })
  yield* Effect.promise(async () => { await expect(f.channel.renameRoot({ rootID: child.id, title: "Child title" })).rejects.toBeInstanceOf(NativeDots.Error) })
  yield* f.sessions.archive(f.root.id)
  yield* Effect.promise(async () => { await expect(f.channel.renameRoot({ rootID: f.root.id, title: "Archived title" })).rejects.toBeInstanceOf(NativeDots.Error) })
  expect((yield* f.sessions.get(f.root.id)).title).toBe("  Synthetic title  ")
  expect((yield* f.sessions.get(child.id)).title).not.toBe("Child title")
}))

it.live("native archive hides the root and retires its candidates while unarchive restores fresh access", () => Effect.gen(function* () {
  const f = yield* setup
  const other = yield* f.sessions.create({ location: f.root.location })
  const child = yield* f.sessions.create({ parentID: f.root.id })
  const form = yield* f.forms.create({ sessionID: f.root.id, title: "Archived decision", fields: [{ type: "string", key: "answer", required: true }] })
  const stale = (yield* Effect.promise(() => f.channel.pending(f.root.id))).find((item) => item.itemID === form.id)!
  yield* Effect.promise(async () => { await expect(f.channel.archiveRoot(child.id)).rejects.toBeInstanceOf(NativeDots.Error) })
  yield* Effect.promise(() => f.channel.archiveRoot(f.root.id))
  expect((yield* f.sessions.get(f.root.id)).time.archived).toBeDefined()
  expect(yield* Effect.promise(() => f.channel.getRoot(f.root.id))).toBeUndefined()
  expect((yield* Effect.promise(() => f.channel.listRoots())).map((item) => item.session.id)).toEqual([other.id])
  yield* Effect.promise(async () => { await expect(f.channel.archiveRoot(f.root.id)).rejects.toBeInstanceOf(NativeDots.Error) })
  yield* Effect.promise(async () => { await expect(f.channel.settle(stale.handle, { value: { answers: ["stale"] }, action: { answers: ["Continue"] } })).rejects.toThrow() })
  expect(yield* f.forms.state(form.id)).toEqual({ status: "pending" })
  yield* Effect.promise(async () => { await expect(f.channel.unarchiveRoot(child.id)).rejects.toBeInstanceOf(NativeDots.Error) })
  const restored = yield* Effect.promise(() => f.channel.unarchiveRoot(f.root.id))
  expect(restored.session.id).toBe(f.root.id)
  expect(restored.session.time.archived).toBeUndefined()
  expect(restored.waiting).toEqual(["user-input"])
  expect((yield* Effect.promise(() => f.channel.unarchiveRoot(f.root.id))).session.id).toBe(f.root.id)
  expect((yield* Effect.promise(() => f.channel.getRoot(f.root.id)))?.session.id).toBe(f.root.id)
  yield* Effect.promise(async () => { await expect(f.channel.settle(stale.handle, { value: { answers: ["stale"] }, action: { answers: ["Continue"] } })).rejects.toThrow() })
  const fresh = (yield* Effect.promise(() => f.channel.pending(f.root.id))).find((item) => item.itemID === form.id)!
  expect(fresh.handle).not.toBe(stale.handle)
  yield* Effect.promise(() => f.channel.settle(fresh.handle, { value: { answers: ["fresh"] }, action: { answers: ["Continue"] } }))
  expect(yield* f.forms.state(form.id)).toEqual({ status: "answered", answer: { answer: "fresh" } })
}))

it.live("native remove deletes a root family including archived members and archived roots", () => Effect.gen(function* () {
  const f = yield* setup
  const child = yield* f.sessions.create({ parentID: f.root.id })
  const grandchild = yield* f.sessions.create({ parentID: child.id })
  yield* f.sessions.archive(child.id)
  const archived = yield* f.sessions.create({ location: f.root.location })
  yield* f.sessions.archive(archived.id)
  yield* Effect.promise(async () => { await expect(f.channel.removeRoot(child.id)).rejects.toBeInstanceOf(NativeDots.Error) })
  expect(yield* f.store.get(child.id)).toBeDefined()
  yield* Effect.promise(() => f.channel.removeRoot(f.root.id))
  for (const id of [f.root.id, child.id, grandchild.id]) expect(yield* f.store.get(id)).toBeUndefined()
  yield* Effect.promise(() => f.channel.removeRoot(archived.id))
  expect(yield* f.store.get(archived.id)).toBeUndefined()
  yield* Effect.promise(async () => { await expect(f.channel.removeRoot(archived.id)).rejects.toBeInstanceOf(NativeDots.Error) })
}))

it.live("native remove refuses a family with a foreign-owned descendant before deleting anything", () => Effect.gen(function* () {
  const f = yield* setup
  const child = yield* f.sessions.create({ parentID: f.root.id })
  const foreign = yield* f.sessions.create({ parentID: child.id })
  yield* f.events.claim(foreign.id, "foreign-owner")
  yield* Effect.promise(async () => { await expect(f.channel.removeRoot(f.root.id)).rejects.toBeInstanceOf(NativeDots.Error) })
  for (const id of [f.root.id, child.id, foreign.id]) expect(yield* f.store.get(id)).toBeDefined()
  expect((yield* Effect.promise(() => f.channel.getRoot(f.root.id)))?.session.id).toBe(f.root.id)
}))

it.live("native escalation subscription reports pending roots initially and later decision changes until stopped", () => Effect.gen(function* () {
  const f = yield* setup
  const quiet = yield* f.sessions.create({ location: f.root.location })
  const other = yield* f.sessions.create({ location: f.root.location })
  const child = yield* f.sessions.create({ parentID: other.id })
  yield* f.forms.create({ sessionID: f.root.id, title: "Initial decision", fields: [{ type: "string", key: "answer", required: true }] })
  const first: string[] = []
  const second: string[] = []
  const waiters: (() => void)[] = []
  const stopFirst = yield* Effect.promise(() => f.channel.subscribeEscalations((rootID) => { first.push(rootID) }))
  expect(first).toEqual([f.root.id])
  const stopSecond = yield* Effect.promise(() => f.channel.subscribeEscalations((rootID) => { second.push(rootID); waiters.shift()?.() }))
  expect(second).toEqual([f.root.id])
  const next = () => new Promise<void>((resolve) => { waiters.push(resolve) })
  const later = next()
  yield* f.forms.create({ sessionID: child.id, title: "Later decision", fields: [{ type: "string", key: "answer", required: true }] })
  yield* Effect.promise(() => later).pipe(Effect.timeout("2 seconds"))
  expect(first).toContain(other.id)
  expect(first).not.toContain(child.id)
  expect(first).not.toContain(quiet.id)
  stopFirst()
  stopFirst()
  const count = first.length
  const after = next()
  yield* f.forms.create({ sessionID: f.root.id, title: "After stop", fields: [{ type: "string", key: "answer", required: true }] })
  yield* Effect.promise(() => after).pipe(Effect.timeout("2 seconds"))
  expect(first).toHaveLength(count)
  expect(second.at(-1)).toBe(f.root.id)
  f.channel.retire()
  stopSecond()
  yield* Effect.promise(async () => { await expect(f.channel.subscribeEscalations(() => {})).rejects.toBeInstanceOf(NativeDots.Error) })
}))

type Fixture = Effect.Success<typeof setup>
const createdData = (f: Fixture, sessionID: Session.ID) => f.sessions.log({ sessionID }).pipe(
  Stream.filter((item): item is SessionEvent.PublicDurableEvent => !EventRuntime.isSynced(item)),
  Stream.runCollect,
  Effect.map((events) => Array.from(events).find((event) => event.type === "session.created")?.data),
)
const listed = (f: Fixture, background?: "exclude") => f.sessions.list({ parentID: null, ...(background === undefined ? {} : { background }) }).pipe(
  Effect.map((page) => page.data.map((session) => session.id)),
)
const openExecutor = (f: Fixture, directory: string) => Effect.promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-synthetic", cwd: directory }))
const executorRead = (directory: string) => ({ action: "read", resources: [path.join(directory, "synthetic.txt")] })
const executorDenied = (operation: Promise<unknown>) => Effect.promise(async () => { await expect(operation).rejects.toBeInstanceOf(CcaAuthorizationDeniedError) })

it.live("private Library factories bind the real Session and native principal and retire without reviving", () => Effect.gen(function* () {
  const f = yield* setup
  const seen: unknown[] = []
  let closed = 0
  f.onLibrary((scope, session) => Effect.sync(() => {
    seen.push({ sessionID: scope.sessionID, principal: scope.principal, location: session.location })
    return { open: async () => ({ tools: [], check: scope.current, call: async () => ({ result: "synthetic" }), close: async () => { closed++ } }) }
  }))
  const scope = yield* Effect.promise(() => f.host.threadScope({ environmentID: "environment", threadID: "library-thread", cwd: f.root.location.directory }))
  const process = yield* Effect.promise(() => scope.library!.open({ processID: "process-one", cwd: scope.directory, readFile: async () => ({ canonical: "/synthetic", bytes: new Uint8Array() }) }))
  expect(seen).toEqual([{ sessionID: scope.sessionID, principal: { profile: f.pins.profile, credentialID: f.pins.credentialID, accountID: f.pins.accountID, accountGeneration: f.pins.accountGeneration, accessRevision: f.pins.accessRevision }, location: (yield* f.sessions.get(Session.ID.make(scope.sessionID))).location }])
  f.configure({ enabled: true, profile: "trusted", name: "Renamed desk" })
  yield* Effect.promise(() => process.check())
  expect(scope.librarySignal?.aborted).toBe(false)
  yield* f.access.set({ enabled: false, expectedRevision: 1 })
  expect(scope.librarySignal?.aborted).toBe(true)
  expect(closed).toBe(1)
  yield* Effect.promise(async () => { await expect(process.check()).rejects.toBeInstanceOf(NativeDots.Error) })
  yield* f.access.set({ enabled: true, expectedRevision: 2 })
  yield* Effect.promise(async () => { await expect(scope.library!.open({ processID: "process-two", cwd: scope.directory, readFile: async () => ({ canonical: "/synthetic", bytes: new Uint8Array() }) })).rejects.toBeInstanceOf(NativeDots.Error) })
  yield* Effect.promise(() => scope.close())
}))


it.live("native thread scope rejects unavailable access or configuration and invalid input before creating a Session", () => Effect.gen(function* () {
  const f = yield* setup
  const directory = yield* temporaryDirectory
  const rejects = (input: { readonly environmentID: string; readonly threadID: string; readonly cwd?: string }) => Effect.promise(async () => {
    const error = await f.host.threadScope(input).then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(NativeDots.Error)
    expect((error as NativeDots.Error).message).not.toContain(directory)
  })
  yield* rejects({ environmentID: "environment", threadID: "thread-synthetic", cwd: "relative/synthetic" })
  yield* rejects({ environmentID: "environment", threadID: "   ", cwd: directory })
  yield* rejects({ environmentID: "", threadID: "thread-synthetic", cwd: directory })
  f.configure({ enabled: false })
  yield* rejects({ environmentID: "environment", threadID: "thread-synthetic", cwd: directory })
  f.configure({ enabled: true, profile: "trusted" })
  yield* f.kv.set("dots.native-access", { enabled: true, revision: -1 })
  yield* rejects({ environmentID: "environment", threadID: "thread-synthetic", cwd: directory })
  yield* f.kv.set("dots.native-access", { enabled: true, revision: 1 })
  yield* f.access.set({ enabled: false, expectedRevision: 1 })
  yield* rejects({ environmentID: "environment", threadID: "thread-synthetic", cwd: directory })
  expect((yield* f.sessions.list({})).data.map((session) => session.id)).toEqual([f.root.id])
}).pipe(Effect.scoped))

it.live("native thread scope falls back to home when the first command's cwd is missing or a file", () => Effect.gen(function* () {
  const f = yield* setup
  const directory = yield* temporaryDirectory
  const file = path.join(directory, "file.txt")
  yield* Effect.promise(() => writeFile(file, "synthetic"))
  for (const [threadID, cwd] of [["thread-missing", path.join(directory, "missing")], ["thread-file", file]] as const) {
    const scope = yield* Effect.promise(() => f.host.threadScope({ environmentID: "environment", threadID, cwd }))
    expect(scope.directory).toBe(f.root.location.directory)
    yield* Effect.promise(() => scope.close())
  }
  expect(existsSync(path.join(directory, "missing"))).toBe(false)
}).pipe(Effect.scoped))

it.live("native thread scope creates a durable eligible root at the requested Location that receives native escalations", () => Effect.gen(function* () {
  const f = yield* setup
  const directory = yield* temporaryDirectory
  const escalated: string[] = []
  const waiters: (() => void)[] = []
  const stop = yield* Effect.promise(() => f.channel.subscribeEscalations((rootID) => { escalated.push(rootID); waiters.shift()?.() }))
  const scope = yield* Effect.promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-synthetic", cwd: path.join(directory, ".") }))
  const session = yield* f.store.get(Session.ID.make(scope.sessionID))
  expect(session).toMatchObject({ id: scope.sessionID, title: `Dots · ${path.basename(directory)}`, location: { directory: AbsolutePath.make(directory) } })
  expect(session?.parentID).toBeUndefined()
  expect(session?.time.archived).toBeUndefined()
  expect(session?.origin).toBe("dots-executor")
  expect((yield* f.sessions.get(session!.id)).origin).toBe("dots-executor")
  expect(yield* createdData(f, session!.id)).toMatchObject({ origin: "dots-executor" })
  expect(yield* listed(f)).toContain(session!.id)
  expect(yield* listed(f, "exclude")).not.toContain(session!.id)
  expect((yield* Effect.promise(() => f.channel.listRoots())).map((item) => item.session.id)).toContain(Session.ID.make(scope.sessionID))
  const forms = yield* Form.Service.pipe(Effect.provide(f.locations.get(session!.location, [LocationServiceMap.full])))
  const delivered = new Promise<void>((resolve) => { waiters.push(resolve) })
  const form = yield* forms.create({ sessionID: session!.id, title: "Executor decision", fields: [{ type: "string", key: "answer", required: true }] })
  yield* Effect.promise(() => delivered).pipe(Effect.timeout("2 seconds"))
  expect(escalated).toEqual([scope.sessionID])
  expect((yield* Effect.promise(() => f.channel.pending(scope.sessionID))).map((request) => request.itemID)).toEqual([form.id])
  stop()
  yield* Effect.promise(() => scope.close())
}).pipe(Effect.scoped))

it.live("native executor Sessions keep their background classification when renamed, reused or replaced", () => Effect.gen(function* () {
  const f = yield* setup
  const directory = yield* temporaryDirectory
  const unattributed = yield* Effect.promise(() => f.host.unattributedScope({ environmentID: "environment" }))
  const unattributedID = Session.ID.make(unattributed.sessionID)
  expect((yield* f.sessions.get(unattributedID)).origin).toBe("dots-executor")
  expect(yield* createdData(f, unattributedID)).toMatchObject({ origin: "dots-executor" })
  yield* Effect.promise(() => unattributed.close())

  const first = yield* openExecutor(f, directory)
  const firstID = Session.ID.make(first.sessionID)
  yield* f.sessions.rename({ sessionID: firstID, title: "Renamed by the user" })
  yield* Effect.promise(() => first.close())
  const reused = yield* openExecutor(f, directory)
  expect(reused.sessionID).toBe(first.sessionID)
  expect(yield* f.sessions.get(firstID)).toMatchObject({ title: "Renamed by the user", origin: "dots-executor" })
  yield* Effect.promise(() => reused.close())

  yield* f.sessions.archive(firstID)
  const replacement = yield* openExecutor(f, directory)
  const replacementID = Session.ID.make(replacement.sessionID)
  expect(replacementID).not.toBe(firstID)
  expect(yield* f.kv.get("dots.cca.thread.environment.thread-synthetic")).toMatchObject({ sessionID: replacementID })
  expect((yield* f.sessions.get(replacementID)).origin).toBe("dots-executor")
  expect(yield* f.sessions.get(firstID)).toMatchObject({ title: "Renamed by the user", origin: "dots-executor" })
  const history = Array.from(yield* Stream.runCollect(f.sessions.log({ sessionID: firstID }).pipe(
    Stream.filter((item): item is SessionEvent.PublicDurableEvent => !EventRuntime.isSynced(item)))))
  expect(history.map((event) => event.type)).toEqual(expect.arrayContaining(["session.created", "session.renamed", "session.archived"]))
  expect(yield* listed(f)).toEqual(expect.arrayContaining([f.root.id, unattributedID, firstID, replacementID]))
  const visible = yield* listed(f, "exclude")
  expect(visible).toContain(f.root.id)
  for (const id of [unattributedID, firstID, replacementID]) expect(visible).not.toContain(id)
  yield* Effect.promise(() => replacement.close())
}).pipe(Effect.scoped))

it.live("native executor authorization grants an allowed operation for its Session and releases the grant once", () => Effect.gen(function* () {
  const f = yield* setup
  const directory = yield* temporaryDirectory
  const scope = yield* openExecutor(f, directory)
  const grant = yield* Effect.promise(() => scope.authorization.authorize(executorRead(directory)))
  expect(f.executorGrants().map((input) => [input.sessionID, input.action, input.resources])).toEqual([[scope.sessionID, "read", executorRead(directory).resources]])
  expect(f.executorGrants()[0]?.holder).toStartWith("cca:")
  yield* Effect.promise(() => grant.release())
  yield* Effect.promise(() => grant.release())
  expect(f.executorReleases()).toBe(1)
  yield* Effect.promise(() => scope.close())
  expect(f.executorReleases()).toBe(1)
}).pipe(Effect.scoped))

for (const reason of ["access", "configuration"] as const) it.live(`native executor authorization denies the next operation after global ${reason} Off and stays denied after On`, () => Effect.gen(function* () {
  const f = yield* setup
  const directory = yield* temporaryDirectory
  const scope = yield* openExecutor(f, directory)
  yield* Effect.promise(() => scope.authorization.authorize(executorRead(directory)).then((grant) => grant.release()))
  if (reason === "access") yield* f.access.set({ enabled: false, expectedRevision: 1 })
  else f.configure({ enabled: false })
  yield* executorDenied(scope.authorization.authorize(executorRead(directory)))
  if (reason === "access") yield* f.access.set({ enabled: true, expectedRevision: 2 })
  else f.configure({ enabled: true, profile: "trusted" })
  yield* executorDenied(scope.authorization.authorize(executorRead(directory)))
  expect(f.executorGrants()).toHaveLength(1)
  yield* Effect.promise(() => scope.close())
}).pipe(Effect.scoped))

for (const change of ["archived", "deleted", "foreign-owned"] as const) it.live(`native executor authorization denies after its Session is ${change}`, () => Effect.gen(function* () {
  const f = yield* setup
  const directory = yield* temporaryDirectory
  const scope = yield* openExecutor(f, directory)
  const sessionID = Session.ID.make(scope.sessionID)
  if (change === "archived") yield* f.sessions.archive(sessionID)
  else if (change === "deleted") yield* f.sessions.remove(sessionID)
  else yield* f.events.claim(sessionID, "foreign-owner")
  yield* executorDenied(scope.authorization.authorize(executorRead(directory)))
  expect(f.executorGrants()).toEqual([])
  yield* Effect.promise(() => scope.close())
}).pipe(Effect.scoped))

it.live("native executor scope close is idempotent, awaits outstanding grant releases and denies later operations", () => Effect.gen(function* () {
  const f = yield* setup
  const directory = yield* temporaryDirectory
  const scope = yield* openExecutor(f, directory)
  const grants = yield* Effect.promise(() => Promise.all([scope.authorization.authorize(executorRead(directory)), scope.authorization.authorize(executorRead(directory))]))
  const first = scope.close()
  yield* Effect.promise(() => scope.close())
  expect(f.executorReleases()).toBe(2)
  yield* Effect.promise(() => first)
  for (const grant of grants) yield* Effect.promise(() => grant.release())
  yield* Effect.promise(() => scope.close())
  expect(f.executorReleases()).toBe(2)
  yield* executorDenied(scope.authorization.authorize(executorRead(directory)))
  expect(f.executorGrants()).toHaveLength(2)
}).pipe(Effect.scoped))

it.live("native executor scope close reports a grant release failure as the same fixed error on every call", () => Effect.gen(function* () {
  const f = yield* setup
  const directory = yield* temporaryDirectory
  const scope = yield* openExecutor(f, directory)
  yield* Effect.promise(() => scope.authorization.authorize(executorRead(directory)))
  f.failExecutorReleases()
  for (const _ of [1, 2]) {
    const error = yield* Effect.promise(() => scope.close().then(() => undefined, (caught: unknown) => caught))
    expect(error).toBeInstanceOf(CcaAuthorizationCloseError)
    expect((error as Error).message).toBe("CCA authorization cleanup failed")
  }
}).pipe(Effect.scoped))
