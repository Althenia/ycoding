export * as NativeDots from "./native"

import { Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { EventManifest } from "@ycoding-ai/schema/event-manifest"
import type { Model } from "@ycoding-ai/schema/model"
import { Form } from "../form"
import { Session } from "../session"
import { SessionMessage } from "../session/message"
import { SessionStore } from "../session/store"
import { SessionExecution } from "../session/execution"
import { SessionRunnerModel } from "../session/runner/model"
import { SessionOrchestration } from "../session/orchestration"
import { SessionReview } from "../session/review"
import { SessionGuardrail } from "../session/guardrail"
import { Permission } from "../permission"
import { Question } from "../question"
import { Config } from "../config"
import { Credential } from "../credential"
import { Integration } from "../integration"
import { OpenAICodex } from "../plugin/provider/openai-codex"
import { RemoteControlCredential } from "../remote-control/credential"
import { Database } from "../database/database"
import { EventRuntime } from "../event"
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
  readonly profile: string
  readonly credentialID: string
  readonly accountID: string
  readonly accountGeneration: number
}

export interface Pins {
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
export interface Host {
  readonly configuration: () => Promise<Configuration>
  readonly credential: (profile: string, rejectedAccessToken?: string) => Promise<RemoteControlCredential.Resolved | undefined>
  readonly subscribeConfiguration: (listener: () => void) => () => void
  readonly attach: (pins: Pins) => Promise<Connection>
}

export class Error extends Schema.TaggedErrorClass<Error>()("NativeDots.Error", {
  code: Schema.Literals(["unavailable", "invalid_input", "stale"]),
  message: Schema.String,
}) {}
const unavailable = () => new Error({ code: "unavailable", message: "Native Session access is unavailable" })
const invalid = () => new Error({ code: "invalid_input", message: "The native request does not match its pending operation" })
const identity = (value: Configuration) => value.enabled
  ? [value.profile, value.credentialID, value.accountID, value.accountGeneration] : [false]
const nonempty = (value: string) => value.trim().length > 0 && value.length <= 256

export interface Options {
  readonly config: { readonly snapshot: () => Effect.Effect<Config.GlobalDocuments>; readonly subscribe: (listener: () => void) => () => void }
  readonly credentials: Pick<Credential.Interface, "list">
  readonly credential: (profile: string, rejectedAccessToken?: string) => Effect.Effect<RemoteControlCredential.Resolved | undefined>
  readonly db: Database.Interface
  readonly store: SessionStore.Interface
  readonly sessions: Session.Interface
  readonly events: EventRuntime.Interface
  readonly execution: SessionExecution.Interface
  readonly projects: Project.Interface
  readonly decisions: (session: Session.Info) => Effect.Effect<NativeDecisions.Interface, unknown>
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
  const retire = () => { for (const connection of connections) connection.retire(); connections.clear() }
  const notify = () => { for (const listener of listeners) listener() }
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
    if (available && config.enabled) {
      const matching = (yield* options.credentials.list(Integration.ID.make("openai"))).filter((item) => item.label === config.profile)
      const credential = matching.length === 1 ? matching[0] : undefined
      const accountID = credential?.value.type === "oauth" ? OpenAICodex.accountID(credential.value) : undefined
      if (credential && accountID) result = { enabled: true, profile: config.profile, credentialID: credential.id, accountID, accountGeneration: credential.accountGeneration }
    }
    if (!isDeepStrictEqual(identity(previous), identity(result))) { previous = result; retire(); notify() }
    return result
  })
  yield* configuration()
  yield* Effect.acquireRelease(options.events.listen((event) => Effect.gen(function* () {
    if (event.type === Integration.Event.ConnectionUpdated.type) yield* configuration()
    yield* Effect.forEach(observers, (observe) => observe(event), { discard: true })
  })), (stop) => stop)
  const access = DotsAccess.make({ db: options.db, sessions: options.store, events: options.events, configured: () => configuration().pipe(Effect.map((value) => value.enabled)) })
  const host: Host = {
    configuration: () => Effect.runPromise(configuration()),
    credential: (profile, rejected) => Effect.runPromise(Effect.gen(function* () {
      const current = yield* configuration()
      if (!current.enabled || profile !== current.profile) return undefined
      const credential = yield* options.credential(profile, rejected)
      yield* configuration()
      if (!credential || credential.credentialID !== current.credentialID || credential.accountID !== current.accountID || credential.accountGeneration !== current.accountGeneration) return undefined
      return credential
    })),
    subscribeConfiguration: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    attach: (input) => Effect.runPromise(Effect.gen(function* () {
      const pins = { ...input }
      const current = yield* configuration()
      if (!current.enabled || !isDeepStrictEqual(identity(current), [pins.profile, pins.credentialID, pins.accountID, pins.accountGeneration]) ||
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
          })
          const requireLive = Effect.fnUntraced(function* () { if (!(yield* valid())) return yield* unavailable() })
          const root = Effect.fnUntraced(function* (id: string) {
            yield* requireLive()
            const state = yield* access.get(Session.ID.make(id)).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!state?.enabled || state.inherited || !state.configured) {
              const lifetime = roots.get(id)
              if (lifetime) retireRoot(lifetime)
              return yield* unavailable()
            }
            lifetimeFor(state)
            return state
          })
          const validate = (source: Form.NativeReplySource) => Effect.gen(function* () {
            if (!(yield* valid()) || !currentRoot(source)) return false
            const state = yield* access.get(source.rootSessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
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
          const observe: EventRuntime.Subscriber = (event) => Effect.gen(function* () {
            const lifetime = event.durable && roots.get(event.durable.aggregateID)
            if (lifetime) yield* validate(source(lifetime, "lifetime"))
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
              const accessState = yield* access.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
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
              const allowed = yield* Effect.forEach(context.sources, validate)
              if (!allowed.some(Boolean)) continue
              contributions.push({ sources: context.sources, items: yield* read(context.session) })
            }
            return yield* options.db.db.transaction(() => Effect.gen(function* () {
              const visible: typeof contributions = []
              for (const contribution of contributions) {
                const allowed = yield* Effect.forEach(contribution.sources, validate)
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
            retire: () => { open = false; observers.delete(observe); for (const lifetime of roots.values()) retireRoot(lifetime); requests.clear() },
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
              const known = yield* options.projects.list()
              let directory: AbsolutePath | undefined
              for (const project of known) {
                if (project.worktree === input.directory) directory = AbsolutePath.make(input.directory)
                for (const item of yield* options.projects.directories({ projectID: project.id }))
                  if (item.directory === input.directory) directory = item.directory
              }
              if (!directory) return yield* unavailable()
              const session = yield* options.sessions.create({
                id: Session.ID.make(`ses_native_${Hash.json([pins.credentialID, pins.accountGeneration, input.inputID])}`),
                location: { directory }, ...(input.title === undefined ? {} : { title: input.title }), native: { validate: valid },
              })
              const state = yield* root(session.id)
              const value = yield* snapshot(session, state)
              if (!(yield* validate(source(state, "create")))) return yield* unavailable()
              return value
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
              const state = yield* access.get(session.id).pipe(Effect.mapError(unavailable))
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
                const permitted = yield* access.get(Session.ID.make(id)).pipe(Effect.catch(() => Effect.succeed(undefined)))
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
  }
  return host
})

export const live = Effect.gen(function* () {
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
  return yield* make({ config, credentials, db, store, sessions, events, execution, projects,
    selectedModel: (session) => Catalog.Service.use((catalog) => SessionRunnerModel.selection(session, catalog.model)).pipe(
      Effect.map((selection) => selection?.ref), Effect.provide(locations.get(session.location))),
    models: (session) => Catalog.Service.use((catalog) => catalog.model.available()).pipe(
      Effect.map((models) => models.map((model) => ({ id: model.id, providerID: model.providerID, name: model.name }))),
      Effect.provide(locations.get(session.location))),
    skills: (session) => Skill.Service.use((skills) => skills.list()).pipe(
      Effect.map((skills) => skills.map((skill) => ({ id: skill.id, name: skill.name }))),
      Effect.provide(locations.get(session.location))),
    credential: (profile, rejected) => RemoteControlCredential.resolveStored(credentials, profile, rejected),
    decisions: (session) => Effect.gen(function* () {
      const permission = yield* Permission.Service
      const guardrail = yield* SessionGuardrail.Service
      const forms = yield* Form.Service
      const questions = yield* Question.Service
      return NativeDecisions.make({ permission, guardrail, forms, questions, reviews, orchestration, sessions })
    }).pipe(Effect.provide(locations.get(session.location))),
  })
})
