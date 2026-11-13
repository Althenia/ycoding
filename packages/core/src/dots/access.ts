export * as DotsAccess from "./access"

import { Context, Effect, Layer, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Dots } from "@ycoding-ai/schema/dots"
import { Config } from "../config"
import { Credential } from "../credential"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Integration } from "../integration"
import { KV } from "../kv"
import { OpenAICodex } from "../plugin/provider/openai-codex"

export class Error extends Schema.TaggedErrorClass<Error>()("DotsAccess.Error", {
  code: Schema.Literals(["unavailable", "invalid_input", "conflict"]),
  message: Schema.String,
  rejection: Schema.optional(Dots.Rejection),
}) {}

export interface TransportStatus {
  readonly state: "off" | "connecting" | "connected" | "error"
  readonly hostname?: string
  readonly name?: string
  readonly problem?: "configuration" | "authentication" | "enrollment" | "connection"
}

export type ComputerProblem =
  | "configuration"
  | "authentication"
  | "enrollment"
  | "dot-unavailable"
  | "not-listed"
  | "admin-disabled"
  | "not-connectable"
  | "rejected"
  | "unconfirmed"
  | "connection"
  | "target-changed"
  | "not-disconnectable"
  | "not-deletable"

export interface ComputerStatus {
  readonly state: "attached" | "detached" | "unavailable" | "removed"
  readonly problem?: ComputerProblem
  readonly name?: string
  readonly target?: Dots.ComputerTarget
  readonly readiness?: "connected" | "offline" | "unknown"
  readonly usableForTasks?: boolean
  readonly dotEnvironment?: Dots.DotEnvironment
}

export type ConversationProblem =
  | "configuration"
  | "authentication"
  | "dot-unavailable"
  | "thread-unavailable"
  | "connection"
  | "durable-unavailable"
  | "rejected"
  | "malformed"
  | "stale"
  | "unsupported"
  | "invalid-answer"

export type Rejection = Dots.Rejection

export type ConversationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: ConversationProblem; readonly rejection?: Rejection }

export interface Conversation {
  readonly threads: () => Promise<ConversationResult<Dots.ThreadList>>
  readonly taskUpdates: (taskID: string, page: Dots.ConversationPage) => Promise<ConversationResult<Dots.TaskUpdates>>
  readonly read: (threadID: string, page: Dots.ConversationPage) => Promise<ConversationResult<Dots.Transcript>>
  readonly send: (threadID: string, input: Dots.ThreadSend) => Promise<ConversationResult<Dots.SendResult>>
  readonly interrupt: (threadID: string, input: Dots.ThreadInterrupt) => Promise<ConversationResult<Dots.InterruptResult>>
  readonly resume: () => Promise<ConversationResult<Dots.ResumeResult>>
  readonly requests: (threadID: string) => Promise<ConversationResult<Dots.PendingRequests>>
  readonly respond: (threadID: string, requestID: string, input: Dots.RequestResponse) => Promise<ConversationResult<Dots.RespondResult>>
}

export interface Transport {
  readonly status: () => Promise<TransportStatus>
  readonly conversation: Conversation
  readonly computer: () => Promise<ComputerStatus>
  readonly attachComputer: (input: Dots.ComputerAttach) => Promise<ComputerStatus>
  readonly detachComputer: (input: Dots.ComputerDetach) => Promise<ComputerStatus>
  readonly removeComputer: (input: Dots.ComputerRemove) => Promise<ComputerStatus>
}

export interface Interface {
  readonly get: () => Effect.Effect<Dots.Access, Error>
  readonly set: (input: Dots.AccessSet) => Effect.Effect<Dots.Access, Error>
  readonly status: () => Effect.Effect<Dots.NativeStatus, Error>
  readonly attachComputer: (input: Dots.ComputerAttach) => Effect.Effect<Dots.NativeStatus, Error>
  readonly detachComputer: (input: Dots.ComputerDetach) => Effect.Effect<Dots.NativeStatus, Error>
  readonly removeComputer: (input: Dots.ComputerRemove) => Effect.Effect<Dots.NativeStatus, Error>
  readonly threads: () => Effect.Effect<Dots.ThreadList, Error>
  readonly taskUpdates: (taskID: string, page: Dots.ConversationPage) => Effect.Effect<Dots.TaskUpdates, Error>
  readonly readThread: (threadID: string, page: Dots.ConversationPage) => Effect.Effect<Dots.Transcript, Error>
  readonly sendMessage: (threadID: string, input: Dots.ThreadSend) => Effect.Effect<Dots.SendResult, Error>
  readonly interruptTurn: (threadID: string, input: Dots.ThreadInterrupt) => Effect.Effect<Dots.InterruptResult, Error>
  readonly resume: () => Effect.Effect<Dots.ResumeResult, Error>
  readonly requests: (threadID: string) => Effect.Effect<Dots.PendingRequests, Error>
  readonly respond: (threadID: string, requestID: string, input: Dots.RequestResponse) => Effect.Effect<Dots.RespondResult, Error>
  readonly subscribe: (listener: () => void) => () => void
  readonly attachTransport: (transport: Transport) => () => void
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/DotsAccess") {}

export function configured(entries: readonly Config.Entry[], credentials: readonly Credential.Info[]) {
  const selected = Config.dots(entries)
  if (!selected.enabled) return false
  const exact = credentials.filter((credential) => credential.label === selected.profile && credential.integrationID === "openai")
  return exact.length === 1 && exact[0]!.value.type === "oauth" && Boolean(OpenAICodex.accountID(exact[0]!.value))
}

const display = (value: string | undefined, limit: number) => value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, limit) || undefined
const guidance = {
  configuration: "Native configuration is unavailable. Check global Dots configuration.",
  authentication: "The selected ChatGPT profile is unavailable. Check its authentication; the connector retries automatically.",
  enrollment: "Native enrollment failed. Check the selected profile and connection; the connector retries automatically.",
  connection: "The native connection failed. The connector retries automatically.",
} satisfies Record<NonNullable<TransportStatus["problem"]>, string>
const computerGuidance = {
  configuration: "Turn on Dots access with a ready ChatGPT profile to attach this computer.",
  authentication: "The selected ChatGPT profile could not be used. Check its sign-in.",
  enrollment: "This computer's Dots executor is not enrolled for the selected account yet. Keep Dots access on and try again.",
  "dot-unavailable": "No single active Dot was found for this account.",
  "not-listed": "This computer is not among your Dot's computers yet. Keep Dots access on and try again.",
  "admin-disabled": "Your workspace administrator has disabled local computer access.",
  "not-connectable": "ChatGPT does not allow attaching this computer right now.",
  rejected: "ChatGPT refused the request.",
  unconfirmed: "The outcome is unconfirmed. Do not repeat the request; refresh status and confirm the current computer before any new attempt.",
  connection: "Your Dot's computers could not be read. Try again.",
  "target-changed": "The Dots computer or account changed. Refresh and confirm the current computer before changing it.",
  "not-disconnectable": "ChatGPT does not allow detaching this computer right now.",
  "not-deletable": "ChatGPT does not allow removing this computer right now.",
} satisfies Record<ComputerProblem, string>
const conversationGuidance = {
  configuration: "Turn on Dots access with a ready ChatGPT profile to use your Dot's conversation.",
  authentication: "The selected ChatGPT profile could not be used. Check its sign-in.",
  "dot-unavailable": "No single active Dot was found for this account.",
  "thread-unavailable": "This thread does not belong to your Dot.",
  connection: "Your Dot could not be reached. Try again.",
  "durable-unavailable": "The Dots conversation connection is not ready. Try again shortly.",
  rejected: "ChatGPT refused the request.",
  malformed: "ChatGPT returned a response that could not be read.",
  stale: "This request was already answered or is no longer pending. Refresh the pending requests.",
  unsupported: "This request type cannot be answered from YCoding.",
  "invalid-answer": "The answer does not match this request.",
} satisfies Record<ConversationProblem, string>
const rejectionLabel = (value: unknown, limit: number) => typeof value === "string" ? display(value, limit) : undefined
const rejectionOf = (value: Rejection | undefined): Rejection | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const errorCode = rejectionLabel(value.errorCode, 128)
  const errorType = rejectionLabel(value.errorType, 128)
  const message = rejectionLabel(value.message, 1000)
  const rejection = {
    ...(value.code !== undefined && Number.isSafeInteger(value.code) ? { code: value.code } : {}),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorType === undefined ? {} : { errorType }),
    ...(message === undefined ? {} : { message }),
  }
  return Object.keys(rejection).length ? rejection : undefined
}
const conversationErrorCode = (problem: ConversationProblem): Error["code"] =>
  problem === "stale" ? "conflict" : problem === "unsupported" || problem === "invalid-answer" ? "invalid_input" : "unavailable"
const ConversationIdentity = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
const RespondInput = Dots.RequestResponse.check(Schema.makeFilter((value) => (value.decision === undefined) !== (value.answers === undefined), {
  expected: "exactly one of decision or answers",
}))
const removedGuidance = "This computer was removed from your ChatGPT account and Dots access is off. Turn Dots access on to enroll it again."
const computerFailure: ComputerStatus = { state: "unavailable", problem: "connection" }

export function make(input: {
  readonly db: Database.Interface
  readonly kv: KV.Interface
  readonly configuration: () => Effect.Effect<Dots.NativeStatus["configuration"]>
}): Interface {
  const listeners = new Set<() => void>()
  let attached: { readonly transport: Transport } | undefined
  const get = Effect.fn("DotsAccess.get")(function* () {
    const value = yield* input.kv.get("dots.native-access")
    if (value === undefined) return { enabled: false, revision: 0 }
    return yield* Schema.decodeUnknownEffect(Dots.Access)(value).pipe(Effect.mapError(() =>
      new Error({ code: "unavailable", message: "The global Dots access preference is invalid" })))
  })
  type Snapshot = { readonly owner: typeof attached; readonly access: Dots.Access; readonly configuration: Dots.NativeStatus["configuration"] }
  const snapshot = Effect.fnUntraced(function* () {
    const owner = attached
    const access = yield* get()
    const configuration = yield* input.configuration()
    return { owner, access, configuration }
  })
  const observe = Effect.fn("DotsAccess.status")(function* (read: (transport: Transport) => Promise<ComputerStatus>, baseline?: Snapshot) {
    const initial = baseline ?? (yield* snapshot())
    const owner = initial.owner
    const [observed, computed] = owner
      ? yield* Effect.all([
        Effect.tryPromise(() => owner.transport.status()).pipe(Effect.catch(() => Effect.succeed<TransportStatus>({ state: "error", problem: "connection" }))),
        Effect.tryPromise(() => read(owner.transport)).pipe(Effect.catch(() => Effect.succeed(computerFailure))),
      ], { concurrency: 2 })
      : [undefined, undefined]
    const access = yield* get()
    const current = yield* input.configuration()
    const profile = display(current.profile, 256)
    const message = display(current.message, 500)
    const currentBinding = owner === attached && initial.access.revision === access.revision && isDeepStrictEqual(initial.configuration, current)
    const hostname = currentBinding ? display(observed?.hostname, 256) : undefined
    const name = currentBinding ? display(observed?.name, 256) : undefined
    const connection: Dots.NativeStatus["connection"] = !owner || owner !== attached ? { state: "unavailable" }
      : !access.enabled || !current.ready ? { state: "off" }
      : !currentBinding ? { state: "connecting" }
      : observed ? {
        state: observed.state,
        ...(observed.problem ? { message: guidance[observed.problem] } : {}),
      } : { state: "connecting" }
    const computerMessage = computed?.problem !== undefined && Object.hasOwn(computerGuidance, computed.problem) ? computerGuidance[computed.problem] : undefined
    const computer: Dots.NativeStatus["computer"] = !owner || owner !== attached ? undefined
      : !currentBinding || !computed ? { state: "unavailable" }
      : computed.state === "removed" ? { state: "removed", message: removedGuidance }
      : !access.enabled || !current.ready ? { state: "unavailable", message: computerGuidance.configuration }
      : { state: computed.state, ...(computerMessage ? { message: computerMessage } : {}),
        ...(display(computed.name, 256) ? { name: display(computed.name, 256) } : {}),
        ...(computed.target === undefined ? {} : { target: computed.target }),
        ...(computed.readiness === undefined ? {} : { readiness: computed.readiness }),
        ...(computed.usableForTasks === undefined ? {} : { usableForTasks: computed.usableForTasks }),
        ...(computed.dotEnvironment === undefined ? {} : { dotEnvironment: computed.dotEnvironment }) }
    return {
      access,
      configuration: { ready: current.ready, ...(profile ? { profile } : {}), ...(message ? { message } : {}) },
      connection: { ...connection, ...(hostname ? { hostname } : {}), ...(name ? { name } : {}) },
      ...(computer ? { computer } : {}),
    }
  })
  const set = Effect.fn("DotsAccess.set")(function* (value: Dots.AccessSet) {
    const request = yield* Schema.decodeUnknownEffect(Dots.AccessSet)(value).pipe(Effect.mapError(() =>
      new Error({ code: "invalid_input", message: "Invalid global Dots access change" })))
    return yield* input.db.db.transaction(() => Effect.gen(function* () {
      const current = yield* get()
      if (current.revision !== request.expectedRevision)
        return yield* new Error({ code: "conflict", message: "Global Dots access revision changed" })
      if (request.enabled && !(yield* input.configuration()).ready)
        return yield* new Error({ code: "unavailable", message: "Configure the selected OpenAI OAuth profile before enabling Dots access" })
      if (current.enabled === request.enabled) return { changed: false, access: current }
      const access = { enabled: request.enabled, revision: current.revision + 1 }
      yield* input.kv.set("dots.native-access", access)
      return { changed: true, access }
    })).pipe(
      Effect.catchTag("SqlError", Effect.die),
      Effect.tap((result) => Effect.sync(() => { if (result.changed) for (const listener of listeners) listener() })),
      Effect.map((result) => result.access),
      Effect.uninterruptible,
    )
  })
  const change = Effect.fnUntraced(function* (run: (transport: Transport) => Promise<ComputerStatus>) {
    const initial = yield* snapshot()
    const owner = initial.owner
    if (!owner) return yield* new Error({ code: "unavailable", message: "The native transport is unavailable" })
    const ready = owner === attached && initial.access.enabled && initial.configuration.ready
    const result = ready
      ? yield* Effect.tryPromise(() => run(owner.transport)).pipe(Effect.catch(() => Effect.succeed(computerFailure)))
      : { state: "unavailable" as const, problem: "configuration" as const }
    return { initial, result }
  })
  const converse = <A>(schema: Schema.Decoder<A>, inputs: readonly (readonly [Schema.Decoder<unknown>, unknown])[], run: (conversation: Conversation) => Promise<ConversationResult<unknown>>) => Effect.gen(function* () {
    for (const [codec, value] of inputs)
      yield* Schema.decodeUnknownEffect(codec)(value, { onExcessProperty: "error" }).pipe(Effect.mapError(() =>
        new Error({ code: "invalid_input", message: "Invalid Dots conversation request" })))
    const initial = yield* snapshot()
    const owner = initial.owner
    if (!owner || owner !== attached) return yield* new Error({ code: "unavailable", message: "The native transport is unavailable" })
    if (!initial.access.enabled || !initial.configuration.ready)
      return yield* new Error({ code: "unavailable", message: conversationGuidance.configuration })
    const result = yield* Effect.tryPromise(() => run(owner.transport.conversation)).pipe(
      Effect.catch(() => Effect.succeed<ConversationResult<unknown>>({ ok: false, problem: "connection" })))
    if (!result.ok) {
      const problem = Object.hasOwn(conversationGuidance, result.problem) ? result.problem : "connection"
      const rejection = problem === "rejected" ? rejectionOf(result.rejection) : undefined
      return yield* new Error({ code: conversationErrorCode(problem), message: conversationGuidance[problem], ...(rejection === undefined ? {} : { rejection }) })
    }
    return yield* Schema.decodeUnknownEffect(schema)(result.value).pipe(Effect.mapError(() =>
      new Error({ code: "unavailable", message: conversationGuidance.malformed })))
  })
  return {
    get,
    set,
    threads: () => converse(Dots.ThreadList, [], (conversation) => conversation.threads()),
    taskUpdates: (taskID, page) => converse(Dots.TaskUpdates, [[ConversationIdentity, taskID], [Dots.ConversationPage, page]], (conversation) => conversation.taskUpdates(taskID, page)),
    readThread: (threadID, page) => converse(Dots.Transcript, [[ConversationIdentity, threadID], [Dots.ConversationPage, page]], (conversation) => conversation.read(threadID, page)),
    sendMessage: (threadID, input) => converse(Dots.SendResult, [[ConversationIdentity, threadID], [Dots.ThreadSend, input]], (conversation) => conversation.send(threadID, input)),
    interruptTurn: (threadID, input) => converse(Dots.InterruptResult, [[ConversationIdentity, threadID], [Dots.ThreadInterrupt, input]], (conversation) => conversation.interrupt(threadID, input)),
    resume: () => converse(Dots.ResumeResult, [], (conversation) => conversation.resume()),
    requests: (threadID) => converse(Dots.PendingRequests, [[ConversationIdentity, threadID]], (conversation) => conversation.requests(threadID)),
    respond: (threadID, requestID, input) => converse(Dots.RespondResult, [[ConversationIdentity, threadID], [ConversationIdentity, requestID], [RespondInput, input]], (conversation) => conversation.respond(threadID, requestID, input)),
    status: () => observe((transport) => transport.computer()),
    attachComputer: Effect.fn("DotsAccess.attachComputer")(function* (input: Dots.ComputerAttach) {
      const { initial, result } = yield* change((transport) => transport.attachComputer(input))
      return yield* observe(() => Promise.resolve(result), initial)
    }),
    detachComputer: Effect.fn("DotsAccess.detachComputer")(function* (input: Dots.ComputerDetach) {
      const { initial, result } = yield* change((transport) => transport.detachComputer(input))
      return yield* observe(() => Promise.resolve(result), initial)
    }),
    removeComputer: Effect.fn("DotsAccess.removeComputer")(function* (input: Dots.ComputerRemove) {
      const { initial, result } = yield* change((transport) => transport.removeComputer(input))
      if (result.state !== "removed") return yield* observe(() => Promise.resolve(result), initial)
      const current = yield* get()
      if (current.enabled) yield* set({ enabled: false, expectedRevision: current.revision })
      return yield* observe(() => Promise.resolve(result))
    }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    attachTransport: (transport) => {
      if (attached) throw new Error({ code: "unavailable", message: "The native transport already has an owner" })
      const owner = { transport }
      attached = owner
      return () => { if (attached === owner) attached = undefined }
    },
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const db = yield* Database.Service
    const kv = yield* KV.Service
    const config = yield* Config.GlobalService
    const credentials = yield* Credential.Service
    return make({ db, kv, configuration: () => Effect.gen(function* () {
      const snapshot = yield* config.snapshot()
      const selected = Config.dots(snapshot.entries)
      if (snapshot.diagnostics.length) return { ready: false, message: "Global Dots configuration is invalid." }
      if (!selected.enabled) return { ready: false, message: "Enable Dots in global configuration." }
      const ready = configured(snapshot.entries, yield* credentials.list(Integration.ID.make("openai")))
      return { ready, profile: selected.profile, ...(!ready ? { message: "The selected OpenAI OAuth profile is unavailable." } : {}) }
    }) })
  })),
  deps: [Database.node, KV.node, Config.globalNode, Credential.node],
})
