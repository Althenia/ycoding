export * as CcaAuthorization from "./authorization"

import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Cause, Effect, Exit } from "effect"
import type { Permission } from "../permission"
import type { SessionGuardrail } from "../session/guardrail"
import type { CcaAuthorizationGrant, CcaAuthorizationInput, CcaDecisionStep, CcaDecisionTrace, CcaPendingDecision } from "./errors"

export type { CcaAuthorizationGrant, CcaAuthorizationInput, CcaDecisionStep, CcaDecisionTrace, CcaPendingDecision } from "./errors"

export type CcaAuthorize = (input: CcaAuthorizationInput) => Promise<CcaAuthorizationGrant>

export interface CcaAuthorization {
  readonly authorize: CcaAuthorize
  readonly close: () => Promise<void>
  readonly defers?: boolean
}

export class CcaAuthorizationDeniedError extends Error {
  readonly trace: CcaDecisionTrace
  readonly pending?: readonly CcaPendingDecision[]
  readonly busy?: true

  constructor(trace: CcaDecisionTrace = [], refusal: { readonly pending?: readonly CcaPendingDecision[]; readonly busy?: true } = {}) {
    super("CCA authorization denied")
    this.name = "CcaAuthorizationDeniedError"
    this.trace = trace
    if (refusal.pending !== undefined && refusal.pending.length > 0) this.pending = refusal.pending
    if (refusal.busy) this.busy = true
  }
}

export class CcaAuthorizationCloseError extends Error {
  constructor() {
    super("CCA authorization cleanup failed")
    this.name = "CcaAuthorizationCloseError"
  }
}

export interface CcaObservedEvent {
  readonly type: string
  readonly data: unknown
}

export interface CreateCcaAuthorizationOptions {
  readonly sessionID: SessionGuardrail.EvaluateInput["sessionID"]
  readonly permission: Permission.Interface
  readonly guardrail: SessionGuardrail.Interface
  readonly events?: {
    readonly listen: (listener: (event: CcaObservedEvent) => Effect.Effect<void>) => Effect.Effect<Effect.Effect<void>>
  }
  readonly assertCurrent: (
    sessionID: SessionGuardrail.EvaluateInput["sessionID"],
  ) => Effect.Effect<void, unknown, never>
  readonly runPromise?: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>
  readonly holderID?: () => string
  readonly timeoutMs?: number
  readonly defer?: boolean
  readonly reviewDirectories?: (sessionID: string, itemID: string) => Effect.Effect<readonly string[]>
}

const defaultTimeoutMs = 15_000

type Kind = CcaDecisionStep["kind"]
type Ask = { readonly requestID: string; reply?: "once" | "always" | "reject"; by?: "user" | "auto" | "yolo" }

export function createCcaAuthorization(options: CreateCcaAuthorizationOptions): CcaAuthorization {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("CCA authorization timeoutMs must be a positive finite number")
  }
  const run = options.runPromise ?? (<A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect))
  const outstanding = new Set<() => Promise<void>>()
  const claimed = new Set<string>()
  let closed = false
  let cleanupFailed = false

  const authorize: CcaAuthorize = async (input) => {
    if (closed) throw new CcaAuthorizationDeniedError()
    let acquired: SessionGuardrail.Reservation | undefined
    let stage: Kind | undefined
    const passed = new Set<Kind>()
    const asks = new Map<Kind, Ask>()
    let expired = false
    const pending = new Map<Kind, CcaPendingDecision>()
    const capture = (kind: Kind) => (cause: Cause.Cause<unknown>) => Effect.sync(() => {
      const found = cause.reasons.flatMap((reason) => {
        const value = Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined
        const decision = deferred(kind, value, options.sessionID, input)
        return decision === undefined ? [] : [decision]
      })[0]
      if (found !== undefined && !pending.has(kind)) pending.set(kind, found)
    })
    const defer = options.defer ? { defer: true as const } : {}
    const observe = (event: CcaObservedEvent) => Effect.sync(() => {
      const data = record(event.data)
      if (data === undefined || data.sessionID !== options.sessionID) return
      const asked = event.type === "permission.asked" ? "permission" : event.type === "guardrail.asked" ? "guardrail" : undefined
      if (asked !== undefined) {
        if (stage !== asked || asks.has(asked) || typeof data.id !== "string" || claimed.has(data.id)) return
        if (data.action !== input.action || !isDeepStrictEqual(data.resources, input.resources)) return
        claimed.add(data.id)
        asks.set(asked, { requestID: data.id })
        return
      }
      const permission = asks.get("permission")
      if (permission !== undefined && permission.requestID === data.requestID) {
        if (event.type === "permission.replied") permission.reply = reply(data.reply)
        if (event.type === "session.permission.assessed") permission.by = data.via === "yolo" ? "yolo" : "auto"
      }
      const guardrail = asks.get("guardrail")
      if (event.type === "guardrail.replied" && guardrail !== undefined && guardrail.requestID === data.requestID) {
        guardrail.reply = reply(data.reply)
        guardrail.by = data.authority === "yolo" ? "yolo" : data.decidedBy === "decision-model" ? "auto" : "user"
      }
    })
    const step = (kind: Kind): CcaDecisionStep => {
      const allowed = passed.has(kind)
      const ask = asks.get(kind)
      if (ask === undefined) {
        if (allowed) return { kind, reply: "allow", by: "rule" }
        return expired ? { kind, reply: "expired", by: "expired" } : { kind, reply: "reject", by: "rule" }
      }
      if (ask.reply === undefined) {
        if (expired && !allowed) return { kind, requestID: ask.requestID, reply: "expired", by: "expired" }
        return { kind, requestID: ask.requestID, reply: allowed ? "once" : "reject", by: ask.by ?? "auto" }
      }
      return { kind, requestID: ask.requestID, reply: ask.reply, by: ask.by ?? "user" }
    }
    const trace = (): CcaDecisionTrace => {
      if (options.events === undefined || stage === undefined) return []
      return stage === "permission" ? [step("permission")] : [step("permission"), step("guardrail")]
    }
    const sequence = Effect.gen(function* () {
      yield* options.assertCurrent(options.sessionID)
      stage = "permission"
      const permitted = yield* options.permission.assert({
        sessionID: options.sessionID,
        action: input.action,
        resources: input.resources,
        save: [...input.resources],
        ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        ...defer,
      }).pipe(Effect.tapCause(capture("permission")), Effect.exit)
      if (Exit.isSuccess(permitted)) passed.add("permission")
      if (Exit.isFailure(permitted) && pending.get("permission")?.state !== "open") return yield* Effect.failCause(permitted.cause)
      stage = "guardrail"
      const reserved = yield* options.guardrail.assert({
        sessionID: options.sessionID,
        action: input.action,
        resources: input.resources,
        ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        holder: `cca:${(options.holderID ?? randomUUID)()}`,
        ...defer,
      }).pipe(Effect.tapCause(capture("guardrail")), Effect.exit)
      if (Exit.isFailure(reserved)) {
        if (!pending.has("guardrail")) pending.clear()
        return yield* Effect.failCause(reserved.cause)
      }
      acquired = reserved.value
      passed.add("guardrail")
      if (Exit.isFailure(permitted)) return yield* Effect.failCause(permitted.cause)
      yield* options.assertCurrent(options.sessionID)
      if (closed) return yield* Effect.fail(new CcaAuthorizationDeniedError())
      return acquired
    })
    const program = sequence.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || acquired === undefined
          ? Effect.void
          : Effect.exit(acquired.release).pipe(
              Effect.tap((releaseExit) =>
                Exit.isFailure(releaseExit)
                  ? Effect.sync(() => {
                      cleanupFailed = true
                    })
                  : Effect.void,
              ),
              Effect.asVoid,
            ),
      ),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.sync(() => { expired = true }).pipe(Effect.andThen(Effect.fail(new CcaAuthorizationDeniedError()))),
      }),
    )
    let granted: SessionGuardrail.Reservation
    try {
      granted = await run(options.events === undefined
        ? program
        : Effect.acquireUseRelease(options.events.listen(observe), () => program, (stop) => stop))
    } catch {
      if (pending.size === 0) throw new CcaAuthorizationDeniedError(trace(), expired && options.defer ? { busy: true } : {})
      const decisions = await Promise.all([...pending.values()].map(async (found) => {
        if (found.kind !== "guardrail" || found.state !== "open" || found.itemID === undefined || !options.reviewDirectories) return found
        return { ...found, directories: await run(options.reviewDirectories(found.sessionID, found.itemID)) }
      }))
      throw new CcaAuthorizationDeniedError(trace(), { pending: decisions })
    }
    let released = false
    const release = async () => {
      if (released) return
      released = true
      outstanding.delete(release)
      try {
        await run(granted.release)
      } catch {
        cleanupFailed = true
        throw new CcaAuthorizationCloseError()
      }
    }
    outstanding.add(release)
    return { release, trace: trace() }
  }

  const close = async () => {
    if (closed) {
      if (cleanupFailed) throw new CcaAuthorizationCloseError()
      return
    }
    closed = true
    const results = await Promise.allSettled([...outstanding].map((release) => release()))
    if (results.some((result) => result.status === "rejected")) cleanupFailed = true
    if (cleanupFailed) throw new CcaAuthorizationCloseError()
  }

  return { authorize, close, defers: options.defer === true }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function reply(value: unknown) {
  return value === "once" || value === "always" || value === "reject" ? value : undefined
}

function deferred(
  kind: Kind,
  value: unknown,
  sessionID: string,
  input: CcaAuthorizationInput,
): CcaPendingDecision | undefined {
  const error = record(value)
  if (error?._tag !== (kind === "permission" ? "Permission.DeferredError" : "Guardrail.DeferredError")) return undefined
  const state = error.state === "rejected" || error.state === "full" ? error.state : "open"
  return {
    kind,
    sessionID: typeof error.sessionID === "string" ? error.sessionID : sessionID,
    ...(typeof error.itemID === "string" ? { itemID: error.itemID } : {}),
    action: typeof error.action === "string" ? error.action : input.action,
    resources: Array.isArray(error.resources) ? error.resources.filter((item): item is string => typeof item === "string") : [...input.resources],
    hardReview: error.hardReview === true,
    state,
  }
}
