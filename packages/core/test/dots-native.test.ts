import { expect } from "bun:test"
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
import { LocationServiceMap } from "../src/location-service-map"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { SessionEvent } from "../src/session/event"
import { SessionPending } from "../src/session/pending"
import { SessionRunnerModel } from "../src/session/runner/model"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Agent } from "../src/agent"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { reviewLayer } from "./fixture/review"
import { testEffect } from "./lib/effect"

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
  const reviews = yield* SessionReview.Service
  const orchestration = yield* SessionOrchestration.Service
  const locations = yield* LocationServiceMap.Service
  const directory = AbsolutePath.make(process.cwd())
  const root = yield* sessions.create({ location: { directory } })
  let documents: Config.GlobalDocuments = { entries: [new Config.Document({ type: "document", scope: "global", info: new Config.Info({ dots: { enabled: true, profile: "trusted" } }) })], diagnostics: [] }
  let credential = new Credential.Info({ id: Credential.ID.make("cred_native"), integrationID: Integration.ID.make("openai"), label: "trusted", value: { type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"), access: "synthetic", refresh: "synthetic", expires: 0, metadata: { accountID: "synthetic-account" } } })
  const listeners = new Set<() => void>()
  const access = DotsAccess.make({ db, events, sessions: store, configured: () => Effect.succeed(true) })
  yield* access.set({ sessionID: root.id, enabled: true, expectedRevision: 0 })
  const decisions = (session: Session.Info) => Effect.gen(function* () {
    const permission = yield* Permission.Service
    const guardrail = yield* SessionGuardrail.Service
    const forms = yield* Form.Service
    const questions = yield* Question.Service
    return NativeDecisions.make({ permission, guardrail, forms, questions, reviews, orchestration, sessions })
  }).pipe(Effect.provide(locations.get(session.location)))
  const modelReads: string[] = []
  let modelRead = () => Effect.void
  let storeRead = (_id: Session.ID) => Effect.void
  let subscribed = () => Effect.void
  let catalogItems = false
  let selectionRead = (_session: Session.Info) => Effect.void
  let activity: ReadonlySet<Session.ID> | undefined
  let historyReads = 0
  let hasModels = true
  const host = yield* NativeDots.make({ db, execution: { ...execution, active: execution.active.pipe(Effect.map((current) => activity ?? current)) }, decisions,
    sessions: { ...sessions,
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
    projects: { ...projects, list: () => Effect.succeed([{ id: Project.ID.global, worktree: directory, sandboxes: [], time: { created: 0, updated: 0 } }]), directories: () => Effect.succeed([]) },
    credentials: { list: () => Effect.succeed([credential]) }, credential: () => Effect.succeed(undefined),
    config: { snapshot: () => Effect.sync(() => documents), subscribe: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } } },
  })
  const pins: NativeDots.Pins = { profile: "trusted", credentialID: credential.id, accountID: "synthetic-account", accountGeneration: 0, environmentID: "environment", connectionID: "connection", isCurrent: () => true }
  const connection = yield* Effect.promise(() => host.attach(pins))
  const channel = connection.channel({ clientID: "client", streamID: "stream" })
  const forms = yield* Form.Service.pipe(Effect.provide(locations.get(root.location)))
  return { root, access, sessions, store, events, forms, host, pins, connection, channel, modelReads, db, reviews, orchestration, locations,
    historyReads: () => historyReads,
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

it.live("native access hides local-off, child, archived, and remote roots and creates only at recorded locations", () => Effect.gen(function* () {
  const f = yield* setup
  const off = yield* f.sessions.create({ location: f.root.location })
  const child = yield* f.sessions.create({ parentID: f.root.id })
  const remote = yield* f.sessions.create({ location: f.root.location })
  yield* f.events.claim(remote.id, "remote-owner")
  expect((yield* Effect.promise(() => f.channel.listRoots())).map((item) => item.session.id)).toEqual([f.root.id])
  for (const id of [off.id, child.id, remote.id]) expect(yield* Effect.promise(() => f.channel.getRoot(id))).toBeUndefined()
  yield* Effect.promise(async () => { await expect(f.channel.createRoot({ directory: "/unrecorded-native-location", inputID: "create" })).rejects.toThrow() })
  const created = yield* Effect.promise(() => f.channel.createRoot({ directory: f.root.location.directory, inputID: "create" }))
  expect((yield* f.access.get(created.session.id)).enabled).toBe(true)
  expect((yield* Effect.promise(() => f.channel.createRoot({ directory: f.root.location.directory, inputID: "create" }))).session.id).toBe(created.session.id)
  yield* f.access.set({ sessionID: created.session.id, enabled: false, expectedRevision: 1 })
  yield* Effect.promise(async () => { await expect(f.channel.createRoot({ directory: f.root.location.directory, inputID: "create" })).rejects.toThrow() })
  expect((yield* f.access.get(created.session.id)).enabled).toBe(false)
  yield* f.sessions.archive(f.root.id)
  expect(yield* Effect.promise(() => f.channel.getRoot(f.root.id))).toBeUndefined()
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
  expect((yield* f.access.get(f.root.id)).enabled).toBe(true)
  const current = yield* Effect.promise(() => f.host.attach({ ...f.pins, connectionID: "new-connection" }))
  const channel = current.channel({ clientID: "client", streamID: "new-stream" })
  f.refresh(1, 2)
  yield* Effect.promise(async () => { await expect(channel.listRoots()).rejects.toThrow() })
  yield* Effect.promise(async () => { await expect(f.host.attach(f.pins)).rejects.toThrow() })
  expect((yield* f.access.get(f.root.id)).enabled).toBe(true)
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
  yield* f.access.set({ sessionID: f.root.id, enabled: false, expectedRevision: 1 })
  yield* f.access.set({ sessionID: f.root.id, enabled: true, expectedRevision: 2 })
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

it.live("native catalogs union only accessible root contexts and remove revoked contributions", () => Effect.gen(function* () {
  const f = yield* setup
  const same = yield* f.sessions.create({ location: f.root.location })
  yield* f.access.set({ sessionID: same.id, enabled: true, expectedRevision: 0 })
  yield* f.sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })
  expect(yield* Effect.promise(() => f.channel.models())).toEqual([{ id: "model", providerID: "provider", name: "Synthetic model" }])
  expect(f.modelReads).toEqual([f.root.location.directory])
  expect(yield* Effect.promise(() => f.channel.skills())).toEqual([{ id: "skill", name: "Synthetic skill" }])
  f.onModelRead(() => Effect.gen(function* () {
    yield* f.access.set({ sessionID: f.root.id, enabled: false, expectedRevision: 1 })
    yield* f.access.set({ sessionID: same.id, enabled: false, expectedRevision: 1 })
  }))
  expect(yield* Effect.promise(() => f.channel.models())).toEqual([])
  const count = f.modelReads.length
  expect(yield* Effect.promise(() => f.channel.models())).toEqual([])
  expect(f.modelReads).toHaveLength(count)
  expect(yield* Effect.promise(() => f.channel.skills())).toEqual([])
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

for (const reason of ["revision", "archive"] as const) it.live(`native subscription retires once on its root ${reason} but not another root`, () => Effect.gen(function* () {
  const f = yield* setup
  const other = yield* f.sessions.create({ location: f.root.location })
  yield* f.access.set({ sessionID: other.id, enabled: true, expectedRevision: 0 })
  let retired = 0
  let resolve!: () => void
  const closed = new Promise<void>((done) => { resolve = done })
  const stop = yield* Effect.promise(() => f.channel.subscribe(f.root.id, () => {}, () => { retired++; resolve() }))
  yield* f.access.set({ sessionID: other.id, enabled: false, expectedRevision: 1 })
  expect(retired).toBe(0)
  if (reason === "archive") yield* f.sessions.archive(f.root.id)
  else yield* f.access.set({ sessionID: f.root.id, enabled: false, expectedRevision: 1 })
  yield* Effect.promise(() => closed).pipe(Effect.timeout("500 millis"))
  if (reason === "revision") yield* f.access.set({ sessionID: f.root.id, enabled: true, expectedRevision: 2 })
  f.channel.retire()
  stop()
  expect(retired).toBe(1)
}))

it.live("root listing excludes an earlier root revoked during a later root read", () => Effect.gen(function* () {
  const f = yield* setup
  const other = yield* f.sessions.create({ location: f.root.location })
  yield* f.access.set({ sessionID: other.id, enabled: true, expectedRevision: 0 })
  f.onStoreRead((id) => Effect.gen(function* () {
    if (id !== other.id) return
    f.onStoreRead(() => Effect.void)
    yield* f.access.set({ sessionID: f.root.id, enabled: false, expectedRevision: 1 })
  }))
  expect((yield* Effect.promise(() => f.channel.listRoots())).map((item) => item.session.id)).toEqual([other.id])
}))

for (const kind of ["models", "skills"] as const) it.live(`native ${kind} exclude an earlier contribution revoked during a later validation`, () => Effect.gen(function* () {
  const f = yield* setup
  const other = yield* f.sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })
  yield* f.access.set({ sessionID: other.id, enabled: true, expectedRevision: 0 })
  f.distinctCatalogItems()
  let reads = 0
  f.onModelRead(() => Effect.sync(() => {
    if (++reads !== 2) return
    f.onStoreRead((id) => Effect.gen(function* () {
      if (id !== other.id) return
      f.onStoreRead(() => Effect.void)
      yield* f.access.set({ sessionID: f.root.id, enabled: false, expectedRevision: 1 })
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

it.live("root retirement resets root and descendant drafts without resetting another root", () => Effect.gen(function* () {
  const f = yield* setup
  const child = yield* f.sessions.create({ parentID: f.root.id })
  const other = yield* f.sessions.create({ location: f.root.location })
  yield* f.access.set({ sessionID: other.id, enabled: true, expectedRevision: 0 })
  const forms = yield* Effect.forEach([f.root, child, other], (session) => f.forms.create({ sessionID: session.id, title: "Staged answer", fields: [
    { type: "string", key: "first", required: true }, { type: "string", key: "second", required: true },
  ] }))
  const initial = [...(yield* Effect.promise(() => f.channel.pending(f.root.id))), ...(yield* Effect.promise(() => f.channel.pending(other.id)))]
  for (const request of initial) yield* Effect.promise(() => f.channel.settle(request.handle, { value: { answers: ["old"] }, action: { answers: ["Continue"] } }))
  const staged = [...(yield* Effect.promise(() => f.channel.pending(f.root.id))), ...(yield* Effect.promise(() => f.channel.pending(other.id)))]
  expect(staged).toHaveLength(3)
  expect(staged.every((request) => request.questions[0]?.header === "second")).toBe(true)
  yield* f.access.set({ sessionID: f.root.id, enabled: false, expectedRevision: 1 })
  yield* f.access.set({ sessionID: f.root.id, enabled: true, expectedRevision: 2 })
  for (const request of staged.filter((request) => request.threadID === f.root.id))
    yield* Effect.promise(async () => { await expect(f.channel.settle(request.handle, { value: { answers: ["stale"] }, action: { answers: ["Continue"] } })).rejects.toThrow() })
  const fresh = yield* Effect.promise(() => f.channel.pending(f.root.id))
  expect(fresh).toHaveLength(2)
  for (const request of fresh) {
    expect(request.questions[0]?.header).toBe("first")
    expect(staged.some((old) => old.handle === request.handle || old.id === request.id)).toBe(false)
    yield* Effect.promise(() => f.channel.settle(request.handle, { value: { answers: ["fresh"] }, action: { answers: ["Continue"] } }))
  }
  for (const request of yield* Effect.promise(() => f.channel.pending(f.root.id)))
    yield* Effect.promise(() => f.channel.settle(request.handle, { value: { answers: ["done"] }, action: { answers: ["Continue"] } }))
  const otherRequest = staged.find((request) => request.threadID === other.id)!
  expect((yield* Effect.promise(() => f.channel.pending(other.id)))[0]?.handle).toBe(otherRequest.handle)
  yield* Effect.promise(() => f.channel.settle(otherRequest.handle, { value: { answers: ["continued"] }, action: { answers: ["Continue"] } }))
  for (const form of forms.slice(0, 2)) expect(yield* f.forms.state(form.id)).toEqual({ status: "answered", answer: { first: "fresh", second: "done" } })
  expect(yield* f.forms.state(forms[2]!.id)).toEqual({ status: "answered", answer: { first: "old", second: "continued" } })
}))

it.live("subscription setup revocation retires once and forwards no later content", () => Effect.gen(function* () {
  const f = yield* setup
  let retired = 0
  const received: string[] = []
  f.onSubscribed(() => Effect.gen(function* () {
    f.onSubscribed(() => Effect.void)
    yield* f.access.set({ sessionID: f.root.id, enabled: false, expectedRevision: 1 })
  }))
  const stop = yield* Effect.promise(() => f.channel.subscribe(f.root.id, (event) => { received.push(event.type) }, () => { retired++ }))
  expect(retired).toBe(1)
  yield* f.access.set({ sessionID: f.root.id, enabled: true, expectedRevision: 2 })
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
  const services = yield* Effect.gen(function* () { return { agents: yield* Agent.Service, permissions: yield* Permission.Service } }).pipe(Effect.provide(f.locations.get(f.root.location)))
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
    yield* f.access.set({ sessionID: session.id, enabled: false, expectedRevision: 1 })
  }))
  if (method === "get") expect(yield* Effect.promise(() => f.channel.getRoot(f.root.id))).toBeUndefined()
  else if (method === "list") expect(yield* Effect.promise(() => f.channel.listRoots())).toEqual([])
  else yield* Effect.promise(async () => { await expect(method === "read" ? f.channel.readRoot(f.root.id) : f.channel.createRoot({ directory: f.root.location.directory, inputID: "revoked-create" })).rejects.toThrow() })
}))

it.live("native root list revalidates earlier snapshots after later model enrichment", () => Effect.gen(function* () {
  const f = yield* setup
  const other = yield* f.sessions.create({ location: f.root.location })
  yield* f.access.set({ sessionID: other.id, enabled: true, expectedRevision: 0 })
  f.onSelection((session) => Effect.gen(function* () {
    if (session.id !== other.id) return
    f.onSelection(() => Effect.void)
    yield* f.access.set({ sessionID: f.root.id, enabled: false, expectedRevision: 1 })
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
  yield* f.access.set({ sessionID: root.id, enabled: true, expectedRevision: 0 })
  yield* Effect.promise(async () => { await expect(f.channel.getRoot(root.id)).rejects.toThrow("missing-model") })
}))

for (const boundary of ["permission", "guardrail"] as const) it.live(`missing Session during deferred ${boundary} validation fails closed without settlement`, () => Effect.gen(function* () {
  const f = yield* setup
  const agent = Agent.ID.make("native-validation")
  const agents = yield* Agent.Service.pipe(Effect.provide(f.locations.get(f.root.location)))
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "allow" }] }))
  const root = yield* f.sessions.create({ location: f.root.location, agent })
  const services = yield* Effect.gen(function* () {
    return { permission: yield* Permission.Service, guardrail: yield* SessionGuardrail.Service, questions: yield* Question.Service }
  }).pipe(Effect.provide(f.locations.get(f.root.location)))
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
