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
}) {}

export interface TransportStatus {
  readonly state: "off" | "connecting" | "connected" | "error"
  readonly hostname?: string
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

export interface ComputerStatus {
  readonly state: "attached" | "detached" | "unavailable"
  readonly problem?: ComputerProblem
}

export interface Transport {
  readonly status: () => Promise<TransportStatus>
  readonly computer: () => Promise<ComputerStatus>
  readonly attachComputer: () => Promise<ComputerStatus>
}

export interface Interface {
  readonly get: () => Effect.Effect<Dots.Access, Error>
  readonly set: (input: Dots.AccessSet) => Effect.Effect<Dots.Access, Error>
  readonly status: () => Effect.Effect<Dots.NativeStatus, Error>
  readonly attachComputer: () => Effect.Effect<Dots.NativeStatus, Error>
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
  rejected: "ChatGPT refused the attach request.",
  unconfirmed: "ChatGPT did not confirm the attach. Check the state again before retrying.",
  connection: "Your Dot's computers could not be read. Try again.",
} satisfies Record<ComputerProblem, string>
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
  const observe = Effect.fn("DotsAccess.status")(function* (read: (transport: Transport) => Promise<ComputerStatus>) {
    const initial = yield* get()
    const configuration = yield* input.configuration()
    const owner = attached
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
    const hostname = owner === attached && initial.revision === access.revision ? display(observed?.hostname, 256) : undefined
    const connection: Dots.NativeStatus["connection"] = !owner || owner !== attached ? { state: "unavailable" }
      : !access.enabled || !current.ready ? { state: "off" }
      : initial.revision !== access.revision || !isDeepStrictEqual(configuration, current) ? { state: "connecting" }
      : observed ? {
        state: observed.state,
        ...(observed.problem ? { message: guidance[observed.problem] } : {}),
      } : { state: "connecting" }
    const computerMessage = computed?.problem !== undefined && Object.hasOwn(computerGuidance, computed.problem) ? computerGuidance[computed.problem] : undefined
    const computer: Dots.NativeStatus["computer"] = !owner || owner !== attached ? undefined
      : initial.revision !== access.revision || !computed ? { state: "unavailable" }
      : { state: computed.state, ...(computerMessage ? { message: computerMessage } : {}) }
    return {
      access,
      configuration: { ready: current.ready, ...(profile ? { profile } : {}), ...(message ? { message } : {}) },
      connection: { ...connection, ...(hostname ? { hostname } : {}) },
      ...(computer ? { computer } : {}),
    }
  })
  return {
    get,
    set: Effect.fn("DotsAccess.set")(function* (value) {
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
    }),
    status: () => observe((transport) => transport.computer()),
    attachComputer: Effect.fn("DotsAccess.attachComputer")(function* () {
      const owner = attached
      if (!owner) return yield* new Error({ code: "unavailable", message: "The native transport is unavailable" })
      const access = yield* get()
      const ready = access.enabled && (yield* input.configuration()).ready
      const result = ready
        ? yield* Effect.tryPromise(() => owner.transport.attachComputer()).pipe(Effect.catch(() => Effect.succeed(computerFailure)))
        : { state: "unavailable" as const, problem: "configuration" as const }
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
