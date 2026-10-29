export * as NativeDots from "./native"

import { Effect, Schema } from "effect"
import { existsSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { eq } from "drizzle-orm"
import { EventManifest } from "@ycoding-ai/schema/event-manifest"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import type { Model } from "@ycoding-ai/schema/model"
import { Form } from "../form"
import { Session } from "../session"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { SessionStore } from "../session/store"
import { SessionExecution } from "../session/execution"
import { SessionRunnerModel } from "../session/runner/model"
import { SessionOrchestration } from "../session/orchestration"
import { SessionReview } from "../session/review"
import { SessionGuardrail } from "../session/guardrail"
import { Permission } from "../permission"
import { PluginSupervisor } from "../plugin/supervisor"
import { Question } from "../question"
import { createCcaAuthorization, type CcaAuthorization } from "../cca/authorization"
import type { CcaScopeFor } from "../cca/executor"
import { CcaTranscript } from "../cca/transcript"
import { Config } from "../config"
import { Credential } from "../credential"
import { Integration } from "../integration"
import { OpenAICodex } from "../plugin/provider/openai-codex"
import { RemoteControlCredential } from "../remote-control/credential"
import { Database } from "../database/database"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { KV } from "../kv"
import { EventRuntime } from "../event"
import { EventSequenceTable } from "../event/sql"
import { LocationServiceMap } from "../location-service-map"
import { Project } from "../project"
import { Catalog } from "../catalog"
import { Skill } from "../skill"
import { AbsolutePath } from "../schema"
import { Hash } from "../util/hash"
import { DotsAccess } from "./access"
import { NativeDecisions } from "./native-decisions"

export type Configuration = { readonly enabled: false } | {
  readonly enabled: true
  readonly accessRevision: number
  readonly profile: string
  readonly credentialID: string
  readonly accountID: string
  readonly accountGeneration: number
}

export interface Pins {
  readonly accessRevision: number
  readonly profile: string
  readonly credentialID: string
  readonly accountID: string
  readonly accountGeneration: number
  readonly environmentID: string
  readonly connectionID: string
  readonly isCurrent: () => boolean
}

const candidateBrand = Symbol("NativeDots.Candidate")
export interface Candidate { readonly [candidateBrand]: true }
export interface NativeRequest {
  readonly id: string
  readonly threadID: string
  readonly turnID: string
  readonly itemID: string
  readonly questions: readonly NativeDecisions.InputQuestion[]
  readonly handle: Candidate
}
export type Answers = Readonly<Record<string, { readonly answers: readonly string[] }>>

export interface RootSnapshot {
  readonly session: Session.Info
  readonly selectedModel?: Model.Ref
  readonly active: boolean
  readonly waiting: readonly ("approval" | "user-input")[]
}

export interface Channel {
  readonly models: () => Promise<readonly { readonly id: string; readonly providerID: string; readonly name?: string }[]>
  readonly skills: () => Promise<readonly { readonly id: string; readonly name?: string }[]>
  readonly listRoots: () => Promise<RootSnapshot[]>
  readonly getRoot: (rootID: string) => Promise<RootSnapshot | undefined>
  readonly readRoot: (rootID: string) => Promise<RootSnapshot & { readonly messages: SessionMessage.Info[] }>
  readonly createRoot: (input: { readonly inputID: string; readonly directory: string; readonly title?: string }) => Promise<RootSnapshot>
  readonly renameRoot: (input: { readonly rootID: string; readonly title: string }) => Promise<void>
  readonly archiveRoot: (rootID: string) => Promise<void>
  readonly unarchiveRoot: (rootID: string) => Promise<RootSnapshot>
  readonly removeRoot: (rootID: string) => Promise<void>
  readonly subscribeEscalations: (listener: (rootID: string) => void) => Promise<() => void>
  readonly prompt: (input: { readonly rootID: string; readonly inputID: string; readonly text: string; readonly delivery: "steer" | "queue" }) => Promise<{ readonly messageID: string }>
  readonly interrupt: (rootID: string) => Promise<void>
  readonly pending: (rootID: string) => Promise<NativeRequest[]>
  readonly settle: (handle: Candidate, answers: Answers) => Promise<void>
  readonly subscribe: (rootID: string, listener: (event: EventManifest.ServerEvent) => void, onRetire?: () => void) => Promise<() => void>
  readonly retire: () => void
}
export interface Connection {
  readonly channel: (address: { readonly clientID: string; readonly streamID: string }) => Channel
  readonly retire: () => void
}
export interface ExecutorScope {
  readonly sessionID: string
  readonly authorization: CcaAuthorization
  readonly transcript: CcaTranscript.Recorder
  readonly close: () => Promise<void>
}
export interface Attribution {
  readonly threadId?: string
  readonly toolCallId?: string
}
export interface ThreadScope extends ExecutorScope {
  readonly directory: string
  readonly roots: readonly string[]
}
export interface ProjectCatalog {
  readonly environmentId: string
  readonly projects: { readonly projectId: string; readonly name: string; readonly rootPaths: string[] }[]
}
export interface PreparedWorkspace {
  readonly cwd: string
  readonly runtimeWorkspaceRoots: string[]
  readonly projectId?: string
}
export interface Host {
  readonly attachTransport: (transport: DotsAccess.Transport) => () => void
  readonly configuration: () => Promise<Configuration>
  readonly credential: (profile: string, rejectedAccessToken?: string) => Promise<RemoteControlCredential.Resolved | undefined>
  readonly subscribeConfiguration: (listener: () => void) => () => void
  readonly attach: (pins: Pins) => Promise<Connection>
  readonly threadScope: (input: { readonly environmentID: string; readonly threadID: string; readonly cwd?: string }) => Promise<ThreadScope>
  readonly unattributedScope: (input: { readonly environmentID: string }) => Promise<ThreadScope>
  readonly projectCatalog: (input: { readonly environmentID: string }) => Promise<ProjectCatalog>
  readonly assignProject: (input: { readonly environmentID: string; readonly threadID: string; readonly projectID: string }) => Promise<{
    readonly environmentId: string
    readonly projectId: string
    readonly threadId: string
  }>
  readonly prepareWorkspace: (input: {
    readonly environmentID: string
    readonly threadID?: string
    readonly cwd: string | null
    readonly projectID?: string
  }) => Promise<PreparedWorkspace>
}

export const executorScopeFor = (host: Pick<Host, "threadScope" | "unattributedScope">, environmentID: string): CcaScopeFor =>
  (attribution, context) => attribution?.threadId === undefined
    ? host.unattributedScope({ environmentID })
    : host.threadScope({ environmentID, threadID: attribution.threadId, ...(context.cwd === undefined ? {} : { cwd: context.cwd }) })

export class Error extends Schema.TaggedErrorClass<Error>()("NativeDots.Error", {
  code: Schema.Literals(["unavailable", "invalid_input", "stale", "not_found"]),
  message: Schema.String,
}) {}
const unavailable = () => new Error({ code: "unavailable", message: "Native Session access is unavailable" })
const invalid = () => new Error({ code: "invalid_input", message: "The native request does not match its pending operation" })
const unknownProject = () => new Error({ code: "not_found", message: "The project is not in the catalog" })
const identity = (value: Configuration) => value.enabled
  ? [value.profile, value.credentialID, value.accountID, value.accountGeneration, value.accessRevision] : [false]
const nonempty = (value: string) => value.trim().length > 0 && value.length <= 256
const escalationTypes = new Set<string>([
  ...[Permission.Event.Asked, Permission.Event.Replied, Permission.Event.Deferred, Permission.Event.Cancelled],
  ...[Guardrail.Event.Asked, Guardrail.Event.Replied, Guardrail.Event.Decided, Guardrail.Event.Deferred, Guardrail.Event.Cancelled],
  ...[Question.Event.Asked, Question.Event.Replied, Question.Event.Rejected, Question.Event.TimedOut, Question.Event.Deferred],
  ...[Form.Event.Created, Form.Event.Replied, Form.Event.Cancelled, Form.Event.TimedOut, Form.Event.Deferred, Form.Event.Assessed],
  ...[SessionEvent.Review.Deferred, SessionEvent.Review.Decided, SessionEvent.Review.Withdrawn, SessionEvent.Review.Consumed],
  ...[SessionEvent.Task.Updated, SessionEvent.GuardrailEscalated, SessionEvent.GuardrailDecided, SessionEvent.GuardrailDismissed],
  ...[SessionEvent.PermissionAssessed, SessionEvent.Unarchived],
].map((definition) => definition.type))
const eventSessionID = (data: Record<string, unknown>) => {
  if (typeof data.sessionID === "string") return data.sessionID
  if (typeof data.rootSessionID === "string") return data.rootSessionID
  const form = data.form
  if (typeof form === "object" && form !== null && "sessionID" in form && typeof form.sessionID === "string") return form.sessionID
  return undefined
}

export interface Options {
  readonly access: DotsAccess.Interface
  readonly config: { readonly snapshot: () => Effect.Effect<Config.GlobalDocuments>; readonly subscribe: (listener: () => void) => () => void }
  readonly credentials: Pick<Credential.Interface, "list">
  readonly credential: (profile: string, rejectedAccessToken?: string) => Effect.Effect<RemoteControlCredential.Resolved | undefined>
  readonly db: Database.Interface
  readonly kv: KV.Interface
  readonly reviews: Pick<SessionReview.Interface, "list">
  readonly home: string
  readonly data: string
  readonly projectRoot: (directory: AbsolutePath) => Effect.Effect<AbsolutePath | undefined>
  readonly store: SessionStore.Interface
  readonly sessions: Session.Interface
  readonly events: EventRuntime.Interface
  readonly execution: SessionExecution.Interface
  readonly projects: Project.Interface
  readonly decisions: (session: Session.Info) => Effect.Effect<NativeDecisions.Interface, unknown>
  readonly authorization: (session: Session.Info) => Effect.Effect<{ readonly permission: Permission.Interface; readonly guardrail: SessionGuardrail.Interface }, unknown>
  readonly selectedModel: (session: Session.Info) => Effect.Effect<Model.Ref | undefined, unknown>
  readonly models: (session: Session.Info) => Effect.Effect<readonly { readonly id: string; readonly providerID: string; readonly name?: string }[], unknown>
  readonly skills: (session: Session.Info) => Effect.Effect<readonly { readonly id: string; readonly name?: string }[], unknown>
}

export const make = Effect.fn("NativeDots.make")(function* (options: Options) {
  const select = (documents: Config.GlobalDocuments) => documents.diagnostics.length ? { enabled: false as const } : Config.dots(documents.entries)
  let selected = select(yield* options.config.snapshot())
  let available = true
  let previous: Configuration = { enabled: false }
  const connections = new Set<Connection>()
  const observers = new Set<EventRuntime.Subscriber>()
  const listeners = new Set<() => void>()
  const transportStops = new Set<() => void>()
  const retire = () => { for (const connection of connections) connection.retire(); connections.clear() }
  const notify = () => { for (const listener of listeners) listener() }
  yield* Effect.acquireRelease(Effect.sync(() => options.access.subscribe(() => { retire(); notify() })),
    (unsubscribe) => Effect.sync(() => { unsubscribe(); for (const stop of transportStops) stop() }))
  yield* Effect.acquireRelease(Effect.sync(() => options.config.subscribe(() => {
    const next = select(Effect.runSync(options.config.snapshot()))
    if (isDeepStrictEqual(selected, next)) return
    selected = next
    retire()
    notify()
  })), (unsubscribe) => Effect.sync(() => { available = false; unsubscribe(); retire() }))
  const configuration = Effect.fnUntraced(function* () {
    let result: Configuration = { enabled: false }
    const config = selected
    const access = yield* options.access.get().pipe(Effect.tapError(() => Effect.sync(() => {
      const changed = previous.enabled
      previous = { enabled: false }
      retire()
      if (changed) notify()
    })))
    if (available && config.enabled && access.enabled) {
      const matching = (yield* options.credentials.list(Integration.ID.make("openai"))).filter((item) => item.label === config.profile)
      const credential = matching.length === 1 ? matching[0] : undefined
      const accountID = credential?.value.type === "oauth" ? OpenAICodex.accountID(credential.value) : undefined
      if (credential && accountID) result = { enabled: true, accessRevision: access.revision, profile: config.profile, credentialID: credential.id, accountID, accountGeneration: credential.accountGeneration }
    }
    if (!isDeepStrictEqual(identity(previous), identity(result))) { previous = result; retire(); notify() }
    return result
  })
  yield* configuration()
  yield* Effect.acquireRelease(options.events.listen((event) => Effect.gen(function* () {
    if (event.type === Integration.Event.ConnectionUpdated.type)
      yield* configuration().pipe(Effect.catchTag("DotsAccess.Error", () => Effect.void))
    yield* Effect.forEach(observers, (observe) => observe(event), { discard: true })
  })), (stop) => stop)
  const accessFor = Effect.fnUntraced(function* (sessionID: Session.ID, includeArchived = false) {
    const selected = yield* options.store.get(sessionID)
    if (!selected) return yield* unavailable()
    const visited = new Set<Session.ID>()
    let current = selected
    while (true) {
      if (visited.has(current.id) || visited.size >= 64 || (!includeArchived && current.time.archived !== undefined)) return yield* unavailable()
      visited.add(current.id)
      const owner = yield* options.db.db.select({ ownerID: EventSequenceTable.owner_id }).from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, current.id)).get().pipe(Effect.orDie)
      if (owner?.ownerID) return yield* unavailable()
      if (!current.parentID) break
      const parent = yield* options.store.get(current.parentID)
      if (!parent) return yield* unavailable()
      current = parent
    }
    return { sessionID, rootSessionID: current.id, inherited: current.id !== sessionID,
      ...(yield* options.access.get()), configured: (yield* configuration()).enabled }
  })
  const openedDirectory = Effect.fnUntraced(function* (directory: unknown) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return yield* invalid()
    const requested = AbsolutePath.make(path.resolve(directory))
    yield* options.projects.recordOpened(requested)
    for (const project of yield* options.projects.list()) {
      if (project.worktree === requested) return requested
      for (const item of yield* options.projects.directories({ projectID: project.id }))
        if (item.directory === requested) return item.directory
    }
    return yield* unavailable()
  })
  type ScopeEntry = {
    readonly key: string
    readonly kind: "thread" | "unattributed"
    session: Session.Info
    readonly authorization: CcaAuthorization
    readonly transcript: CcaTranscript.Recorder
    readonly pinned: () => Effect.Effect<boolean>
    refs: number
    closing?: Promise<void>
  }
  const entries = new Map<string, ScopeEntry>()
  const locks = new Map<string, Promise<void>>()
  const locked = <A>(key: string, run: () => Promise<A>): Promise<A> => {
    const result = (locks.get(key) ?? Promise.resolve()).then(run)
    const settled = result.then(() => {}, () => {})
    locks.set(key, settled)
    void settled.then(() => {
      if (locks.get(key) === settled) locks.delete(key)
    })
    return result
  }
  const closeEntry = (entry: ScopeEntry) => {
    if (entries.get(entry.key) === entry) entries.delete(entry.key)
    return (entry.closing ??= entry.transcript.flush().then(() => entry.authorization.close()))
  }
  const release = (entry: ScopeEntry) => {
    entry.refs--
    return entry.refs > 0 ? Promise.resolve() : closeEntry(entry)
  }
  yield* Effect.addFinalizer(() => Effect.promise(() => Promise.allSettled([...entries.values()].map(closeEntry))))
  const requireEnabled = Effect.fnUntraced(function* () {
    const current = yield* configuration().pipe(Effect.mapError(unavailable))
    if (!current.enabled) return yield* unavailable()
    const config = selected
    return () => configuration().pipe(
      Effect.map((state) => selected === config && isDeepStrictEqual(identity(state), identity(current))),
      Effect.catch(() => Effect.succeed(false)),
    )
  })
  const catalogProjects = Effect.fnUntraced(function* () {
    return (yield* options.projects.list()).filter((project) => project.id !== Project.ID.global && isDirectory(project.worktree))
  })
  const findProject = Effect.fnUntraced(function* (projectID: string) {
    const project = (yield* catalogProjects()).find((item) => item.id === projectID)
    if (!project) return yield* unknownProject()
    return project
  })
  const automaticTitle = Effect.fnUntraced(function* (directory: string) {
    const project = (yield* catalogProjects()).find((item) => item.worktree === directory)
    return `Dots · ${project ? projectName(project) : path.basename(directory)}`
  })
  const usable = Effect.fnUntraced(function* (sessionID: Session.ID | undefined) {
    if (!sessionID) return undefined
    const session = yield* options.store.get(sessionID)
    return session && session.time.archived === undefined && session.parentID === undefined ? session : undefined
  })
  const createSession = Effect.fnUntraced(function* (input: {
    readonly key: string
    readonly directory: string
    readonly title: string
    readonly pinned: () => Effect.Effect<boolean>
    readonly projectID?: string
  }) {
    const directory = yield* openedDirectory(input.directory)
    const session = yield* options.sessions.create({ location: { directory }, title: input.title, native: { validate: input.pinned } })
      .pipe(Effect.mapError(unavailable))
    yield* options.kv.set(input.key, { sessionID: session.id, ...(input.projectID === undefined ? {} : { projectID: input.projectID }) })
    return session
  })
  const firstDirectory = Effect.fnUntraced(function* (cwd: string | undefined) {
    if (cwd === undefined) return options.home
    const resolved = AbsolutePath.make(path.resolve(cwd))
    const root = yield* options.projectRoot(resolved)
    return [root, resolved].find((candidate) => candidate !== undefined && isDirectory(candidate)) ?? options.home
  })
  const retitle = (entry: ScopeEntry, command: string) => Effect.gen(function* () {
    const session = yield* options.store.get(entry.session.id)
    if (!session || session.title !== (yield* automaticTitle(session.location.directory))) return
    yield* options.sessions.rename({ sessionID: session.id, title: `${session.title} · ${command.slice(0, 60)}` })
  })
  const makeEntry = Effect.fnUntraced(function* (key: string, kind: ScopeEntry["kind"], session: Session.Info, pinned: () => Effect.Effect<boolean>) {
    const services = yield* options.authorization(session).pipe(Effect.mapError(unavailable))
    const transcript = CcaTranscript.make({
      sessionID: session.id,
      directory: () => entry.session.location.directory,
      shellDirectory: () => path.join(options.data, "shell", entry.session.projectID),
      events: options.events,
      ...(kind === "thread" ? { command: (command: string) => retitle(entry, command) } : {}),
    })
    const entry: ScopeEntry = {
      key, kind, session, pinned, refs: 0,
      authorization: createCcaAuthorization({
        sessionID: session.id, permission: services.permission, guardrail: services.guardrail, events: options.events, defer: true,
        reviewDirectories: (sessionID, itemID) => options.reviews.list(Session.ID.make(sessionID)).pipe(
          Effect.map((items) => items.flatMap((item) => item.itemID === itemID && item.payload.type === "guardrail" ? item.payload.directories : [])),
          Effect.catch(() => Effect.succeed([])),
        ),
        assertCurrent: (sessionID) => Effect.gen(function* () {
          if (sessionID !== entry.session.id || !(yield* pinned())) return yield* unavailable()
          yield* accessFor(sessionID)
        }),
      }),
      transcript: kind === "thread" ? transcript : { ...transcript, read: () => {} },
    }
    return entry
  })
  const handle = (entry: ScopeEntry): ThreadScope => {
    let released: Promise<void> | undefined
    return {
      sessionID: entry.session.id,
      get directory() {
        return entry.session.location.directory
      },
      get roots() {
        return entry.kind === "unattributed" ? [options.home] : collapse([entry.session.location.directory, options.home])
      },
      authorization: entry.authorization,
      transcript: entry.transcript,
      close: () => (released ??= release(entry)),
    }
  }
  const scopeFor = (key: string, spec: { readonly kind: "thread"; readonly cwd?: string } | { readonly kind: "unattributed" }) =>
    Effect.runPromise(Effect.gen(function* () {
      const pinned = yield* requireEnabled()
      const cached = entries.get(key)
      if (cached) {
        cached.refs++
        if ((yield* cached.pinned()) && (yield* usable(cached.session.id)) !== undefined) return handle(cached)
        if (entries.get(key) === cached) entries.delete(key)
        yield* Effect.tryPromise(() => release(cached)).pipe(Effect.catch((cause) => Effect.logWarning("native executor scope cleanup failed", { cause })))
      }
      const stored = mapping(yield* options.kv.get(key))
      const existing = yield* usable(stored?.sessionID)
      const session = existing ?? (spec.kind === "unattributed"
        ? yield* createSession({ key, directory: options.home, title: "Dots · unattributed", pinned })
        : yield* Effect.gen(function* () {
            const project = stored?.projectID === undefined ? undefined : (yield* catalogProjects()).find((item) => item.id === stored.projectID)
            const directory = project?.worktree ?? (yield* firstDirectory(spec.cwd))
            return yield* createSession({ key, directory, title: yield* automaticTitle(directory), pinned, ...(project ? { projectID: project.id } : {}) })
          }))
      const entry = yield* makeEntry(key, spec.kind, session, pinned)
      entry.refs = 1
      entries.set(key, entry)
      return handle(entry)
    }))
  const bindDirectory = Effect.fnUntraced(function* (key: string, directory: string, projectID?: string) {
    const pinned = yield* requireEnabled()
    const stored = mapping(yield* options.kv.get(key))
    if (projectID === undefined && stored?.projectID !== undefined) return
    const session = yield* usable(stored?.sessionID)
    if (!session) {
      yield* createSession({ key, directory, title: yield* automaticTitle(directory), pinned, ...(projectID === undefined ? {} : { projectID }) })
      return
    }
    if ((yield* options.sessions.messages({ sessionID: session.id })).length > 0) return
    if (session.location.directory !== directory) {
      const automatic = yield* automaticTitle(session.location.directory)
      const target = yield* openedDirectory(directory)
      yield* options.sessions.move({ sessionID: session.id, directory: target }).pipe(Effect.mapError(unavailable))
      if (session.title === automatic) yield* options.sessions.rename({ sessionID: session.id, title: yield* automaticTitle(target) }).pipe(Effect.mapError(unavailable))
    }
    if (projectID !== undefined) yield* options.kv.set(key, { sessionID: session.id, projectID })
    const entry = entries.get(key)
    const moved = yield* options.store.get(session.id)
    if (entry && moved) entry.session = moved
  })
  const host: Host = {
    attachTransport: (transport) => {
      if (!available) throw unavailable()
      const release = options.access.attachTransport(transport)
      const stop = () => { release(); transportStops.delete(stop) }
      transportStops.add(stop)
      return stop
    },
    configuration: () => Effect.runPromise(configuration()),
    credential: (profile, rejected) => Effect.runPromise(Effect.gen(function* () {
      const current = yield* configuration()
      if (!current.enabled || profile !== current.profile) return undefined
      const credential = yield* options.credential(profile, rejected)
      const latest = yield* configuration()
      if (!isDeepStrictEqual(identity(latest), identity(current)) || !credential || credential.credentialID !== current.credentialID || credential.accountID !== current.accountID || credential.accountGeneration !== current.accountGeneration) return undefined
      return credential
    })),
    subscribeConfiguration: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    attach: (input) => Effect.runPromise(Effect.gen(function* () {
      const pins = { ...input }
      const current = yield* configuration()
      if (!current.enabled || !isDeepStrictEqual(identity(current), [pins.profile, pins.credentialID, pins.accountID, pins.accountGeneration, pins.accessRevision]) ||
        !nonempty(pins.environmentID) || !nonempty(pins.connectionID) || !pins.isCurrent()) return yield* unavailable()
      const config = selected
      let alive = true
      const channels = new Map<string, Channel>()
      const connection: Connection = {
        retire: () => { alive = false; for (const channel of channels.values()) channel.retire(); connections.delete(connection) },
        channel: (input) => {
          const address = { ...input }
          if (!alive || !nonempty(address.clientID) || !nonempty(address.streamID)) throw unavailable()
          const key = JSON.stringify([address.clientID, address.streamID])
          const existing = channels.get(key)
          if (existing) return existing
          let open = true
          type RootLifetime = {
            readonly rootSessionID: Session.ID
            readonly revision: number
            active: boolean
            readonly decisions: Map<Session.ID, NativeDecisions.Interface>
            readonly stops: Set<() => void>
          }
          const roots = new Map<string, RootLifetime>()
          const candidates = new WeakMap<Candidate, { readonly request: NativeDecisions.Request; readonly source: Form.NativeReplySource; readonly lifetime: RootLifetime }>()
          const requests = new Map<string, NativeRequest>()
          const retireRoot = (lifetime: RootLifetime) => {
            if (!lifetime.active) return
            lifetime.active = false
            if (roots.get(lifetime.rootSessionID) === lifetime) roots.delete(lifetime.rootSessionID)
            for (const [key, request] of requests) if (candidates.get(request.handle)?.lifetime === lifetime) {
              candidates.delete(request.handle)
              requests.delete(key)
            }
            lifetime.decisions.clear()
            for (const stop of lifetime.stops) stop()
            lifetime.stops.clear()
          }
          const lifetimeFor = (state: { readonly rootSessionID: Session.ID; readonly revision: number }) => {
            const existing = roots.get(state.rootSessionID)
            if (existing?.revision === state.revision) return existing
            if (existing) retireRoot(existing)
            const lifetime: RootLifetime = { ...state, active: true, decisions: new Map(), stops: new Set() }
            roots.set(state.rootSessionID, lifetime)
            return lifetime
          }
          const currentRoot = (source: Form.NativeReplySource) => roots.get(source.rootSessionID)?.revision === source.accessRevision
          const valid = Effect.fnUntraced(function* () {
            const state = yield* configuration()
            return open && alive && pins.isCurrent() && selected === config && state.enabled && isDeepStrictEqual(identity(state), identity(current))
          }, Effect.catchTag("DotsAccess.Error", () => Effect.succeed(false)))
          const requireLive = Effect.fnUntraced(function* () { if (!(yield* valid())) return yield* unavailable() })
          const root = Effect.fnUntraced(function* (id: string) {
            yield* requireLive()
            const state = yield* accessFor(Session.ID.make(id)).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!state?.enabled || state.inherited || !state.configured) {
              const lifetime = roots.get(id)
              if (lifetime) retireRoot(lifetime)
              return yield* unavailable()
            }
            lifetimeFor(state)
            return state
          })
          const validate = (source: Form.NativeReplySource, includeArchived = false) => Effect.gen(function* () {
            if (!(yield* valid()) || !currentRoot(source)) return false
            const state = yield* accessFor(source.rootSessionID, includeArchived).pipe(Effect.catch(() => Effect.succeed(undefined)))
            const allowed = state !== undefined && !state.inherited && state.enabled && state.configured && state.revision === source.accessRevision
            if (!allowed && currentRoot(source)) retireRoot(roots.get(source.rootSessionID)!)
            return allowed && currentRoot(source)
          })
          const source = (state: { readonly rootSessionID: Session.ID; readonly revision: number }, requestID: string): Form.NativeReplySource => ({
            kind: "dots-native", profile: pins.profile, credentialID: pins.credentialID,
            accountID: pins.accountID, accountGeneration: pins.accountGeneration, environmentID: pins.environmentID,
            connectionID: pins.connectionID, clientID: address.clientID, streamID: address.streamID,
            rootSessionID: state.rootSessionID, accessRevision: state.revision, requestID,
          })
          const targetRoot = Effect.fnUntraced(function* (id: string) {
            yield* requireLive()
            const state = yield* accessFor(Session.ID.make(id), true).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!state?.enabled || state.inherited || !state.configured) {
              const lifetime = roots.get(id)
              if (lifetime) retireRoot(lifetime)
              return yield* unavailable()
            }
            lifetimeFor(state)
            if (!(yield* validate(source(state, "lifecycle"), true))) return yield* unavailable()
            return state
          })
          const retireRootID = (rootSessionID: Session.ID) => {
            const lifetime = roots.get(rootSessionID)
            if (lifetime) retireRoot(lifetime)
          }
          const escalations = new Set<(rootID: string) => void>()
          const deliver = (notify: (rootID: string) => void, rootID: string) => Effect.gen(function* () {
            if (!open) return
            try { notify(rootID) } catch {
              channel.retire()
              yield* Effect.logWarning("native escalation consumer failed")
            }
          })
          const escalate = (event: EventManifest.ServerEvent) => Effect.gen(function* () {
            const id = eventSessionID(event.data as Record<string, unknown>)
            if (!id) return
            const state = yield* accessFor(Session.ID.make(id)).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!state?.enabled || !state.configured) return
            const rootState = yield* root(state.rootSessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!rootState || !(yield* validate(source(rootState, "escalation")))) return
            for (const notify of [...escalations]) yield* deliver(notify, rootState.rootSessionID)
          })
          const observe: EventRuntime.Subscriber = (event) => Effect.gen(function* () {
            const lifetime = event.durable && roots.get(event.durable.aggregateID)
            if (lifetime) yield* validate(source(lifetime, "lifetime"))
            if (escalations.size && escalationTypes.has(event.type) && EventManifest.isServer(event)) yield* escalate(event)
          }).pipe(Effect.asVoid)
          const decisionsFor = (session: Session.Info, lifetime: RootLifetime) => Effect.gen(function* () {
            if (!lifetime.active) return yield* unavailable()
            const existing = lifetime.decisions.get(session.id)
            if (existing) return existing
            const decisions = yield* options.decisions(session)
            if (!lifetime.active) return yield* unavailable()
            const current = lifetime.decisions.get(session.id) ?? decisions
            lifetime.decisions.set(session.id, current)
            return current
          })
          const pendingFor = (state: Pick<RootLifetime, "rootSessionID" | "revision">) => Effect.gen(function* () {
            const lifetime = lifetimeFor(state)
            const result: NativeDecisions.Request[] = []
            const queue = [state.rootSessionID]
            const visited = new Set<string>()
            while (queue.length) {
              const sessionID = queue.shift()!
              if (visited.has(sessionID)) continue
              visited.add(sessionID)
              const accessState = yield* accessFor(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!accessState?.enabled || accessState.rootSessionID !== state.rootSessionID) continue
              const session = yield* options.sessions.get(sessionID)
              const decisions = yield* decisionsFor(session, lifetime)
              result.push(...(yield* decisions.pending(sessionID)))
              if (!lifetime.active) return yield* unavailable()
              queue.push(...(yield* options.sessions.list({ parentID: sessionID })).data.map((child) => child.id))
            }
            return { lifetime, requests: result }
          })
          const snapshot = (session: Session.Info, state: Pick<RootLifetime, "rootSessionID" | "revision">) => Effect.gen(function* () {
            const selectedModel = yield* options.selectedModel(session)
            if (!(yield* validate(source(state, "snapshot")))) return yield* unavailable()
            const pending = yield* pendingFor(state)
            const active = (yield* options.execution.active).has(session.id)
            const waiting = (["approval", "user-input"] as const).filter((kind) => pending.requests.some((request) => request.waitKind === kind))
            return { session, ...(selectedModel === undefined ? {} : { selectedModel }), active, waiting } satisfies RootSnapshot
          })
          const missingSnapshot = (error: unknown): error is Error => Schema.is(Error)(error) && error.code === "unavailable"
          const catalog = <A>(read: (session: Session.Info) => Effect.Effect<readonly A[], unknown>, keyOf: (item: A) => string) => Effect.gen(function* () {
            yield* requireLive()
            const contexts = new Map<string, { session: Session.Info; sources: Form.NativeReplySource[] }>()
            for (const session of (yield* options.sessions.list({ parentID: null })).data) {
              const state = yield* root(session.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!state) continue
              const key = JSON.stringify([session.location.directory, session.location.workspaceID ?? null])
              const context = contexts.get(key) ?? { session, sources: [] }
              context.sources.push(source(state, "catalog"))
              contexts.set(key, context)
            }
            const contributions: { readonly sources: Form.NativeReplySource[]; readonly items: readonly A[] }[] = []
            for (const context of contexts.values()) {
              const allowed = yield* Effect.forEach(context.sources, (item) => validate(item))
              if (!allowed.some(Boolean)) continue
              contributions.push({ sources: context.sources, items: yield* read(context.session) })
            }
            return yield* options.db.db.transaction(() => Effect.gen(function* () {
              const visible: typeof contributions = []
              for (const contribution of contributions) {
                const allowed = yield* Effect.forEach(contribution.sources, (item) => validate(item))
                const sources = contribution.sources.filter((_, index) => allowed[index])
                if (sources.length) visible.push({ ...contribution, sources })
              }
              yield* requireLive()
              const result = new Map<string, A>()
              for (const contribution of visible) if (contribution.sources.some(currentRoot))
                for (const item of contribution.items) if (!result.has(keyOf(item))) result.set(keyOf(item), item)
              return [...result.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item)
            })).pipe(Effect.orDie)
          })
          const channel: Channel = {
            retire: () => { open = false; observers.delete(observe); escalations.clear(); for (const lifetime of roots.values()) retireRoot(lifetime); requests.clear() },
            models: () => Effect.runPromise(catalog(options.models, (model) => JSON.stringify([model.providerID, model.id]))),
            skills: () => Effect.runPromise(catalog(options.skills, (skill) => skill.id)),
            listRoots: () => Effect.runPromise(Effect.gen(function* () {
              yield* requireLive()
              const result: { readonly snapshot: RootSnapshot; readonly source: Form.NativeReplySource }[] = []
              for (const session of (yield* options.sessions.list({ parentID: null })).data) {
                const allowed = yield* root(session.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!allowed) continue
                const value = yield* snapshot(session, allowed).pipe(Effect.catchIf(missingSnapshot, () => Effect.succeed(undefined)))
                if (value) result.push({ snapshot: value, source: source(allowed, "list") })
              }
              return yield* options.db.db.transaction(() => Effect.gen(function* () {
                const allowed = yield* Effect.forEach(result, (item) => validate(item.source))
                yield* requireLive()
                return result.filter((item, index) => allowed[index] && currentRoot(item.source)).map((item) => item.snapshot)
              })).pipe(Effect.orDie)
            })),
            getRoot: (id) => Effect.runPromise(Effect.gen(function* () {
              const state = yield* root(id).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!state) return undefined
              const session = yield* options.sessions.get(state.sessionID)
              const value = yield* snapshot(session, state).pipe(Effect.catchIf(missingSnapshot, () => Effect.succeed(undefined)))
              if (!(yield* validate(source(state, "read")))) return undefined
              return value
            })),
            readRoot: (id) => Effect.runPromise(Effect.gen(function* () {
              const state = yield* root(id)
              const session = yield* options.sessions.get(state.sessionID)
              const messages = yield* options.sessions.messages({ sessionID: state.sessionID })
              const value = yield* snapshot(session, state)
              if (!(yield* validate(source(state, "read")))) return yield* unavailable()
              return { ...value, messages }
            })),
            createRoot: (input) => Effect.runPromise(Effect.gen(function* () {
              yield* requireLive()
              if (!nonempty(input.inputID)) return yield* invalid()
              const directory = yield* openedDirectory(input.directory)
              const session = yield* options.sessions.create({
                id: Session.ID.make(`ses_native_${Hash.json([pins.credentialID, pins.accountGeneration, input.inputID])}`),
                location: { directory }, ...(input.title === undefined ? {} : { title: input.title }), native: { validate: valid },
              })
              const state = yield* root(session.id)
              const value = yield* snapshot(session, state)
              if (!(yield* validate(source(state, "create")))) return yield* unavailable()
              return value
            })),
            renameRoot: (input) => Effect.runPromise(Effect.gen(function* () {
              if (typeof input.title !== "string" || !input.title.trim()) return yield* invalid()
              const state = yield* root(input.rootID)
              if (!(yield* validate(source(state, "rename")))) return yield* unavailable()
              yield* options.sessions.rename({ sessionID: state.rootSessionID, title: input.title }).pipe(Effect.mapError(unavailable))
            })),
            archiveRoot: (id) => Effect.runPromise(Effect.gen(function* () {
              const state = yield* root(id)
              if (!(yield* validate(source(state, "archive")))) return yield* unavailable()
              yield* options.sessions.archive(state.rootSessionID).pipe(Effect.mapError(unavailable))
              retireRootID(state.rootSessionID)
            })),
            unarchiveRoot: (id) => Effect.runPromise(Effect.gen(function* () {
              const target = yield* targetRoot(id)
              yield* options.sessions.unarchive(target.rootSessionID).pipe(Effect.mapError(unavailable))
              const state = yield* root(target.rootSessionID)
              const session = yield* options.sessions.get(state.sessionID)
              const value = yield* snapshot(session, state)
              if (!(yield* validate(source(state, "unarchive")))) return yield* unavailable()
              return value
            })),
            removeRoot: (id) => Effect.runPromise(Effect.gen(function* () {
              const target = yield* targetRoot(id)
              const queue: Session.ID[] = [target.rootSessionID]
              const visited = new Set<Session.ID>()
              while (queue.length) {
                const sessionID = queue.shift()!
                if (visited.has(sessionID)) return yield* unavailable()
                visited.add(sessionID)
                const state = yield* accessFor(sessionID, true).pipe(Effect.mapError(unavailable))
                if (!state.enabled || state.rootSessionID !== target.rootSessionID) return yield* unavailable()
                for (const child of (yield* options.sessions.list({ parentID: sessionID })).data) {
                  if (child.parentID !== sessionID) return yield* unavailable()
                  queue.push(child.id)
                }
              }
              if (!(yield* validate(source(target, "remove"), true))) return yield* unavailable()
              retireRootID(target.rootSessionID)
              yield* options.sessions.remove(target.rootSessionID).pipe(Effect.mapError(unavailable))
            })),
            subscribeEscalations: (listener) => Effect.runPromise(Effect.gen(function* () {
              yield* requireLive()
              let stopped = false
              const notify = (rootID: string) => { if (!stopped) listener(rootID) }
              const stop = () => { stopped = true; escalations.delete(notify) }
              escalations.add(notify)
              for (const session of (yield* options.sessions.list({ parentID: null })).data) {
                if (stopped || !open) break
                const state = yield* root(session.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!state) continue
                const pending = yield* pendingFor(state).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!pending?.requests.length || !(yield* validate(source(state, "escalation")))) continue
                yield* deliver(notify, state.rootSessionID)
              }
              if (!(yield* valid())) {
                stop()
                return yield* unavailable()
              }
              return stop
            })),
            prompt: (input) => Effect.runPromise(Effect.gen(function* () {
              const state = yield* root(input.rootID)
              if (!nonempty(input.inputID) || !input.text.trim() || (input.delivery !== "queue" && input.delivery !== "steer")) return yield* invalid()
              const provenance = source(state, input.inputID)
              const pending = yield* options.sessions.prompt({
                id: SessionMessage.ID.make(`msg_native_${Hash.json([state.rootSessionID, pins.credentialID, pins.accountGeneration, input.inputID])}`),
                sessionID: state.rootSessionID, text: input.text, delivery: input.delivery,
                native: { source: provenance, validate: () => validate(provenance) },
              })
              return { messageID: pending.id }
            })),
            interrupt: (id) => Effect.runPromise(Effect.gen(function* () {
              const state = yield* root(id)
              if (!(yield* validate(source(state, "interrupt")))) return yield* unavailable()
              yield* options.execution.interrupt(state.rootSessionID)
            })),
            pending: (id) => Effect.runPromise(Effect.gen(function* () {
              const state = yield* root(id)
              const pending = yield* pendingFor(state)
              const result: NativeRequest[] = []
              if (!(yield* validate(source(state, "pending")))) return yield* unavailable()
              for (const request of pending.requests) {
                const key = JSON.stringify([state.revision, request.sessionID, request.id, request.fingerprint, request.stage ?? 0, request.questions])
                let native = requests.get(key)
                if (!native) {
                  const id = `native_${Hash.json([pins.connectionID, address, key])}`
                  const handle: Candidate = Object.freeze({ [candidateBrand]: true as const })
                  native = { id, threadID: state.rootSessionID, turnID: request.turnID, itemID: request.id, questions: request.questions, handle }
                  candidates.set(handle, { request, source: source(state, id), lifetime: pending.lifetime })
                  requests.set(key, native)
                }
                result.push(native)
              }
              const live = new Set(result.map((item) => item.handle))
              for (const [key, request] of requests) if (request.threadID === state.rootSessionID && !live.has(request.handle)) {
                candidates.delete(request.handle)
                requests.delete(key)
              }
              return result
            })),
            settle: (handle, answers) => Effect.runPromise(Effect.gen(function* () {
              const candidate = candidates.get(handle)
              if (!candidate || !(yield* validate(candidate.source))) return yield* unavailable()
              const session = yield* options.sessions.get(candidate.request.sessionID)
              const state = yield* accessFor(session.id).pipe(Effect.mapError(unavailable))
              if (state.rootSessionID !== candidate.source.rootSessionID) return yield* unavailable()
              const decisions = yield* decisionsFor(session, candidate.lifetime)
              yield* decisions.settle(candidate.request, answers, candidate.source, () => validate(candidate.source))
              candidates.delete(handle)
              for (const [key, request] of requests) if (request.handle === handle) requests.delete(key)
            })),
            subscribe: (id, listener, onRetire) => Effect.runPromise(Effect.gen(function* () {
              const state = yield* root(id)
              const lifetime = lifetimeFor(state)
              const provenance = source(state, "stream")
              let stopped = false
              let unsubscribe: Effect.Effect<void> | undefined
              const stop = (notify: boolean) => {
                if (stopped) return
                stopped = true
                if (unsubscribe) Effect.runSync(unsubscribe)
                lifetime.stops.delete(retire)
                if (notify) try { onRetire?.() } catch { Effect.runSync(Effect.logWarning("native retirement consumer failed")) }
              }
              const retire = () => { retireRoot(lifetime); stop(true) }
              lifetime.stops.add(retire)
              unsubscribe = yield* options.events.listen((event) => Effect.gen(function* () {
                if (stopped) return
                if (!(yield* validate(provenance))) { retire(); return }
                if (!EventManifest.isServer(event)) return
                const data = event.data as Record<string, unknown>
                const id = typeof data.sessionID === "string" ? data.sessionID :
                  typeof data.form === "object" && data.form !== null && "sessionID" in data.form && typeof data.form.sessionID === "string" ? data.form.sessionID : undefined
                if (!id) return
                const permitted = yield* accessFor(Session.ID.make(id)).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (permitted?.enabled && permitted.rootSessionID === state.rootSessionID && (yield* validate(provenance))) {
                  try { listener(event) } catch {
                    channel.retire()
                    yield* Effect.logWarning("native event consumer failed")
                  }
                }
              }))
              if (stopped) Effect.runSync(unsubscribe)
              else {
                if (!(yield* validate(provenance))) retire()
              }
              return () => stop(false)
            })),
          }
          observers.add(observe)
          channels.set(key, channel)
          return channel
        },
      }
      connections.add(connection)
      return connection
    })),
    threadScope: (input) => {
      if (!nonempty(input.environmentID) || !nonempty(input.threadID) || (input.cwd !== undefined && !path.isAbsolute(input.cwd)))
        return Promise.reject(invalid())
      const key = threadKey(input.environmentID, input.threadID)
      return locked(key, () => scopeFor(key, { kind: "thread", cwd: input.cwd }))
    },
    unattributedScope: (input) => {
      if (!nonempty(input.environmentID)) return Promise.reject(invalid())
      const key = `dots.cca.unattributed.${input.environmentID}`
      return locked(key, () => scopeFor(key, { kind: "unattributed" }))
    },
    projectCatalog: (input) => Effect.runPromise(Effect.gen(function* () {
      if (!nonempty(input.environmentID)) return yield* invalid()
      yield* requireEnabled()
      const projects = yield* catalogProjects()
      return {
        environmentId: input.environmentID,
        projects: projects.map((project) => ({ projectId: project.id, name: projectName(project), rootPaths: [project.worktree] })),
      }
    })),
    assignProject: (input) => {
      if (!nonempty(input.environmentID) || !nonempty(input.threadID) || !nonempty(input.projectID)) return Promise.reject(invalid())
      const key = threadKey(input.environmentID, input.threadID)
      return locked(key, () => Effect.runPromise(Effect.gen(function* () {
        yield* requireEnabled()
        const project = yield* findProject(input.projectID)
        yield* bindDirectory(key, project.worktree, project.id)
        return { environmentId: input.environmentID, projectId: project.id, threadId: input.threadID }
      })))
    },
    prepareWorkspace: (input) => {
      if (!nonempty(input.environmentID) || (input.threadID !== undefined && !nonempty(input.threadID)) ||
        (input.cwd !== null && (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd))) ||
        (input.projectID !== undefined && !nonempty(input.projectID))) return Promise.reject(invalid())
      const prepare = () => Effect.runPromise(Effect.gen(function* () {
        yield* requireEnabled()
        if (input.projectID !== undefined) {
          const project = yield* findProject(input.projectID)
          const cwd = input.cwd !== null && contains(project.worktree, path.resolve(input.cwd)) ? path.resolve(input.cwd) : project.worktree
          if (input.threadID !== undefined) yield* bindDirectory(threadKey(input.environmentID, input.threadID), project.worktree, project.id)
          return { cwd, runtimeWorkspaceRoots: [project.worktree], projectId: project.id } satisfies PreparedWorkspace
        }
        if (input.cwd === null) return { cwd: options.home, runtimeWorkspaceRoots: [options.home] } satisfies PreparedWorkspace
        const cwd = AbsolutePath.make(path.resolve(input.cwd))
        const root = (yield* options.projectRoot(cwd)) ?? cwd
        if (input.threadID !== undefined && isDirectory(root)) yield* bindDirectory(threadKey(input.environmentID, input.threadID), root)
        return { cwd, runtimeWorkspaceRoots: [root] } satisfies PreparedWorkspace
      }))
      return input.threadID === undefined ? prepare() : locked(threadKey(input.environmentID, input.threadID), prepare)
    },
  }
  return host
})

const threadKey = (environmentID: string, threadID: string) => `dots.cca.thread.${environmentID}.${threadID}`
const contains = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
const collapse = (roots: readonly string[]) => {
  const unique = roots.filter((root, index) => roots.indexOf(root) === index)
  return unique.filter((root) => !unique.some((other) => other !== root && contains(other, root)))
}
const isDirectory = (directory: string) => existsSync(directory) && statSync(directory).isDirectory()
const projectName = (project: Project.Info) => project.name ?? path.basename(project.worktree)
const mapping = (value: unknown) => {
  if (typeof value !== "object" || value === null || !("sessionID" in value) || typeof value.sessionID !== "string") return undefined
  return {
    sessionID: Session.ID.make(value.sessionID),
    ...("projectID" in value && typeof value.projectID === "string" ? { projectID: value.projectID } : {}),
  }
}


export const live = Effect.gen(function* () {
  const access = yield* DotsAccess.Service
  const kv = yield* KV.Service
  const global = yield* Global.Service
  const fsutil = yield* FSUtil.Service
  const config = yield* Config.GlobalService
  const credentials = yield* Credential.Service
  const db = yield* Database.Service
  const store = yield* SessionStore.Service
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const execution = yield* SessionExecution.Service
  const projects = yield* Project.Service
  const locations = yield* LocationServiceMap.Service
  const reviews = yield* SessionReview.Service
  const orchestration = yield* SessionOrchestration.Service
  return yield* make({ access, config, credentials, db, kv, reviews, store, sessions, events, execution, projects,
    home: os.homedir(), data: global.data, projectRoot: (directory) => Project.root(fsutil, directory),
    selectedModel: (session) => Catalog.Service.use((catalog) => SessionRunnerModel.selection(session, catalog.model)).pipe(
      Effect.map((selection) => selection?.ref), Effect.provide(locations.get(session.location, [LocationServiceMap.full]))),
    models: (session) => Catalog.Service.use((catalog) => catalog.model.available()).pipe(
      Effect.map((models) => models.map((model) => ({ id: model.id, providerID: model.providerID, name: model.name }))),
      Effect.provide(locations.get(session.location, [LocationServiceMap.full]))),
    skills: (session) => Skill.Service.use((skills) => skills.list()).pipe(
      Effect.map((skills) => skills.map((skill) => ({ id: skill.id, name: skill.name }))),
      Effect.provide(locations.get(session.location, [LocationServiceMap.full]))),
    credential: (profile, rejected) => RemoteControlCredential.resolveStored(credentials, profile, rejected),
    authorization: (session) => Effect.gen(function* () {
      yield* (yield* PluginSupervisor.Service).flush
      return { permission: yield* Permission.Service, guardrail: yield* SessionGuardrail.Service }
    }).pipe(Effect.provide(locations.get(session.location, [Permission.node, SessionGuardrail.node, PluginSupervisor.node]))),
    decisions: (session) => Effect.gen(function* () {
      const permission = yield* Permission.Service
      const guardrail = yield* SessionGuardrail.Service
      const forms = yield* Form.Service
      const questions = yield* Question.Service
      return NativeDecisions.make({ permission, guardrail, forms, questions, reviews, orchestration, sessions })
    }).pipe(
      Effect.provide(
        locations.get(session.location, [Permission.node, SessionGuardrail.node, Form.node, Question.node]),
      ),
    ),
  })
})
