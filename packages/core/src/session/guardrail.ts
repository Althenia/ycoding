export * as SessionGuardrail from "./guardrail"

import path from "path"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { ConfigGuardrail } from "../config/guardrail"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { SessionErrors } from "./error"
import { SessionStore } from "./store"
import { SessionGuardrailCounter } from "./guardrail-counter"
import { SessionGuardrailMatch } from "./guardrail-match"

export const RequestID = Guardrail.RequestID

export interface EvaluateInput {
  readonly sessionID: Session.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface Evaluation {
  readonly rootSessionID: Session.ID
  readonly decision: Guardrail.RuleDecision
  readonly ruleIDs: ReadonlyArray<string>
  readonly reason?: string
  readonly standard: boolean
}

export interface Reservation {
  readonly release: Effect.Effect<void>
}

export interface ReplyInput {
  readonly sessionID: Session.ID
  readonly requestID: Guardrail.RequestID
  readonly reply: Guardrail.Reply
}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("Guardrail.BlockedError", {
  rootSessionID: Session.ID,
  sessionID: Session.ID,
  action: Schema.String,
  ruleIDs: Schema.Array(Schema.String),
  reason: Schema.String,
}) {}

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("Guardrail.DeclinedError", {
  requestID: Guardrail.RequestID,
}) {}

export class RequestNotFoundError extends Schema.TaggedErrorClass<RequestNotFoundError>()(
  "Guardrail.RequestNotFoundError",
  { requestID: Guardrail.RequestID },
) {}

export type AssertError =
  | BlockedError
  | DeclinedError
  | SessionGuardrailCounter.CapExceededError
  | SessionErrors.NotFoundError

export interface Interface {
  readonly evaluate: (input: EvaluateInput) => Effect.Effect<Evaluation, SessionErrors.NotFoundError>
  readonly assert: (input: EvaluateInput) => Effect.Effect<Reservation, AssertError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, RequestNotFoundError | SessionErrors.NotFoundError>
  readonly forSession: (
    sessionID: Session.ID,
  ) => Effect.Effect<ReadonlyArray<Guardrail.Request>, SessionErrors.NotFoundError>
  readonly status: (sessionID: Session.ID) => Effect.Effect<Guardrail.Status, SessionErrors.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionGuardrail") {}

interface Pending {
  readonly request: Guardrail.Request
  readonly deferred: Deferred.Deferred<void, DeclinedError>
  readonly review: Reservation
}

type LoadResult =
  | { readonly type: "document"; readonly document: ConfigGuardrail.Document }
  | { readonly type: "invalid"; readonly path: string }

const noReservation: Reservation = { release: Effect.void }

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service
    const entries = yield* config.entries()
    const settings = Config.latest(entries, "guardrails")
    const counters = SessionGuardrailCounter.make({
      shells: settings?.max_concurrent_shells ?? 8,
      subagents: settings?.max_concurrent_subagents ?? 8,
      reviews: settings?.max_pending_reviews ?? 16,
    })
    const pending = new Map<Guardrail.RequestID, Pending>()
    const approvals = new Map<Session.ID, number>()
    const blocked = new Map<Session.ID, number>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        pending.values(),
        (item) =>
          Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id })).pipe(
            Effect.ensuring(item.review.release),
          ),
        { discard: true },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    function root(sessionID: Session.ID): Effect.Effect<Session.ID, SessionErrors.NotFoundError> {
      return Effect.gen(function* () {
        const session = yield* sessions.get(sessionID)
        if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
        if (!session.parentID) return session.id
        return yield* root(session.parentID)
      })
    }

    const documents = Effect.fnUntraced(function* () {
      const directory = path.join(global.config, "guardrails")
      const files = yield* fs
        .scan("*.md", { cwd: directory, absolute: true, dot: false, symlink: false })
        .pipe(Effect.catch(() => Effect.succeed([])))
      const results = yield* Effect.forEach(files.toSorted((left, right) => left.localeCompare(right)), (file) =>
        fs.readFileStringSafe(file).pipe(
          Effect.map((content): LoadResult => {
            if (content === undefined) return { type: "invalid", path: file }
            try {
              return { type: "document", document: ConfigGuardrail.parse(file, content) }
            } catch {
              return { type: "invalid", path: file }
            }
          }),
          Effect.catch(() => Effect.succeed<LoadResult>({ type: "invalid", path: file })),
        ),
      )
      return {
        rules: results.flatMap((result) =>
          result.type === "document" && result.document.enabled && result.document.rule ? [result.document.rule] : [],
        ),
        invalidFiles: results.flatMap((result) => (result.type === "invalid" ? [result.path] : [])),
      }
    })

    const evaluate = Effect.fn("SessionGuardrail.evaluate")(function* (input: EvaluateInput) {
      const rootSessionID = yield* root(input.sessionID)
      if (settings?.enabled === false)
        return {
          rootSessionID,
          decision: "allow" as const,
          ruleIDs: [],
          standard: false,
        }
      const loaded = yield* documents()
      return {
        rootSessionID,
        ...SessionGuardrailMatch.evaluate({
          action: input.action,
          resources: input.resources,
          custom: loaded.rules,
          invalidFiles: loaded.invalidFiles,
        }),
      }
    })

    const reserve = (rootSessionID: Session.ID, action: string) => {
      if (action === "shell") return counters.reserve(rootSessionID, "shell")
      if (action === "subagent") return counters.reserve(rootSessionID, "subagent")
      return Effect.succeed(noReservation)
    }

    const assert = Effect.fn("SessionGuardrail.assert")((input: EvaluateInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* evaluate(input)
          if (result.decision === "deny") {
            blocked.set(result.rootSessionID, (blocked.get(result.rootSessionID) ?? 0) + 1)
            yield* events.publish(Guardrail.Event.Decided, {
              rootSessionID: result.rootSessionID,
              sessionID: input.sessionID,
              action: input.action,
              ruleIDs: [...result.ruleIDs],
              decision: "deny",
            })
            return yield* new BlockedError({
              rootSessionID: result.rootSessionID,
              sessionID: input.sessionID,
              action: input.action,
              ruleIDs: [...result.ruleIDs],
              reason: result.reason ?? "Session guardrail denied this action",
            })
          }
          if (result.decision === "allow") {
            const reservation = yield* reserve(result.rootSessionID, input.action)
            yield* events.publish(Guardrail.Event.Decided, {
              rootSessionID: result.rootSessionID,
              sessionID: input.sessionID,
              action: input.action,
              ruleIDs: [...result.ruleIDs],
              decision: "allow",
            })
            return reservation
          }

          const review = yield* counters.reserve(result.rootSessionID, "review")
          const request = new Guardrail.Request({
            id: Guardrail.RequestID.create(),
            rootSessionID: result.rootSessionID,
            sessionID: input.sessionID,
            action: input.action,
            resources: [...input.resources],
            ruleIDs: [...result.ruleIDs],
            reason: result.reason ?? "Session guardrail review required",
            standard: result.standard,
            ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
          })
          const deferred = yield* Deferred.make<void, DeclinedError>()
          pending.set(request.id, { request, deferred, review })
          yield* events
            .publish(Guardrail.Event.Asked, request)
            .pipe(
              Effect.onError(() =>
                Effect.sync(() => pending.delete(request.id)).pipe(Effect.andThen(review.release)),
              ),
            )
          yield* restore(Deferred.await(deferred)).pipe(
            Effect.ensuring(
              Effect.sync(() => pending.delete(request.id)).pipe(Effect.andThen(review.release)),
            ),
          )
          approvals.set(result.rootSessionID, (approvals.get(result.rootSessionID) ?? 0) + 1)
          return yield* reserve(result.rootSessionID, input.action)
        }),
      ),
    )

    const reply = Effect.fn("SessionGuardrail.reply")(function* (input: ReplyInput) {
      const item = pending.get(input.requestID)
      if (!item) return yield* new RequestNotFoundError({ requestID: input.requestID })
      const rootSessionID = yield* root(input.sessionID)
      if (rootSessionID !== item.request.rootSessionID)
        return yield* new RequestNotFoundError({ requestID: input.requestID })
      yield* events.publish(Guardrail.Event.Replied, {
        rootSessionID: item.request.rootSessionID,
        sessionID: item.request.sessionID,
        requestID: item.request.id,
        reply: input.reply,
      })
      if (input.reply === "reject") {
        yield* Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))
        return yield* Effect.void
      }
      yield* Deferred.succeed(item.deferred, undefined)
      return yield* Effect.void
    })

    const forSession = Effect.fn("SessionGuardrail.forSession")(function* (sessionID: Session.ID) {
      const rootSessionID = yield* root(sessionID)
      return Array.from(pending.values(), (item) => item.request).filter(
        (request) => request.rootSessionID === rootSessionID,
      )
    })

    const status = Effect.fn("SessionGuardrail.status")(function* (sessionID: Session.ID) {
      const rootSessionID = yield* root(sessionID)
      const loaded = yield* documents()
      return new Guardrail.Status({
        rootSessionID,
        profile: settings?.enabled === false ? "disabled" : "standard",
        customRules: loaded.rules.length,
        approvals: approvals.get(rootSessionID) ?? 0,
        blocked: blocked.get(rootSessionID) ?? 0,
        counters: yield* counters.snapshot(rootSessionID),
        invalidFiles: loaded.invalidFiles,
      })
    })

    return Service.of({ evaluate, assert, reply, forSession, status })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Global.node, EventV2.node, SessionStore.node],
})
