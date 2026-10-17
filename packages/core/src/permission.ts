export * as Permission from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Layer, Schema, Semaphore, Stream } from "effect"
import { Permission } from "@ycoding-ai/schema/permission"
import { EventRuntime } from "./event"
import { Location } from "./location"
import { Agent } from "./agent"
import { SessionErrors } from "./session/error"
import { SessionSchema } from "./session/schema"
import { SessionAutonomy } from "./session/autonomy"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import { Database } from "./database/database"
import { Config } from "./config"
import { DecisionChoice } from "./decision-choice"
import { PermissionSaved } from "./permission/saved"
import { SessionEvent } from "./session/event"
import { SessionMessage } from "./session/message"
import { SessionReviewFold } from "./session/review-fold"

const PermissionEffect = Permission.Effect
export { PermissionEffect as Effect }
export { Rule, Ruleset } from "@ycoding-ai/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: Agent.ID.pipe(Schema.optional),
  consumeReview: Schema.Boolean.pipe(Schema.optional),
}).annotate({ identifier: "Permission.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
  rejectScope: Schema.Literals(["request", "session"]).pipe(Schema.optional),
}).annotate({ identifier: "Permission.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "Permission.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("Permission.DeclinedError", {}) {}

export class DeferredError extends Schema.TaggedErrorClass<DeferredError>()("Permission.DeferredError", {
  requestID: ID,
  itemID: SessionReviewFold.ID,
  action: Schema.String,
}) {
  override get message() {
    return `This action did not run. Permission ${this.action} needs the user's decision and was added to the review box as item ${this.itemID} while the user is asleep. Do not retry it or work around it. If the user approves, you will be told to re-issue exactly this action. Continue with independent work.`
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("Permission.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Permission denied: ${this.permission}`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

function denied(input: Pick<AssertInput, "action" | "resources">, rules: Permission.Ruleset) {
  return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
}

function relevant(input: Pick<AssertInput, "action">, rules: Permission.Ruleset) {
  return rules.filter((rule) => Wildcard.match(input.action, rule.action))
}

function decision(
  input: Pick<AssertInput, "action" | "resources">,
  configured: Permission.Ruleset,
  remembered: Permission.Ruleset,
) {
  if (denied(input, configured)) return { effect: "deny" as const, rules: configured }
  const rules = [...configured, ...remembered]
  const effects = input.resources.map((resource) => evaluate(input.action, resource, rules).effect)
  const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
  return { effect, rules }
}

export interface EvaluateEffectiveInput {
  readonly sessionID: SessionSchema.ID
  readonly agent?: Agent.ID
  readonly action: string
  readonly resource: string
}

export interface Interface {
  readonly evaluateEffective: (
    input: EvaluateEffectiveInput,
  ) => Effect.Effect<Permission.Effect, SessionErrors.NotFoundError>
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionErrors.NotFoundError>
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  readonly deferPending: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Permission") {}

export const evaluateEffective = Effect.fn("Permission.evaluateEffective")(function* (input: EvaluateEffectiveInput) {
  const service = yield* Service
  return yield* service.evaluateEffective(input)
})

interface Pending {
  readonly request: Request
  readonly agent?: Agent.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError | DeferredError>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const database = yield* Database.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const pending = new Map<ID, Pending>()
    const settlement = yield* Semaphore.make(1)
    const exclusive = settlement.withPermit

    yield* Effect.addFinalizer(() =>
      exclusive(Effect.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new DeclinedError()), {
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      )),
    )

    const savedRules = Effect.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const configured = Effect.fn("Permission.configured")(function* (
      sessionID: SessionSchema.ID,
      agentID?: Agent.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return [...(agent?.permissions ?? missingAgentPermissions), ...(session.permissionCeiling ?? [])]
    })

    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return decision(input, rules, [])
      return decision(input, rules, yield* savedRules())
    })

    const evaluateEffective = Effect.fn("Permission.evaluateEffectiveService")(function* (
      input: EvaluateEffectiveInput,
    ) {
      return (
        yield* evaluateInput({
          sessionID: input.sessionID,
          agent: input.agent,
          action: input.action,
          resources: [input.resource],
        })
      ).effect
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      }
    }

    const create = (request: Request, agent?: Agent.ID) =>
      exclusive(Effect.uninterruptible(
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError | DeferredError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id))
            return yield* Effect.die(new Error(`Duplicate pending permission ID: ${request.id}`))
          if (yield* asleep(request.sessionID)) {
            const review = yield* openReview(request).pipe(Effect.orDie)
            yield* Deferred.fail(deferred, new DeferredError({ requestID: request.id, itemID: review.itemID, action: request.action }))
            return item
          }
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request)
            .pipe(Effect.onError(() => Effect.sync(() => pending.delete(request.id))))
          return item
        }),
      ))

    yield* events.subscribe(SessionEvent.AgentSelected).pipe(
      Stream.runForEach((event) =>
        exclusive(Effect.gen(function* () {
          for (const [id, item] of pending) {
            if (item.request.sessionID !== event.data.sessionID || item.agent === event.data.agent) continue
            yield* events.publish(Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "reject",
            })
            yield* Deferred.fail(item.deferred, new DeclinedError())
            pending.delete(id)
          }
        })),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    const autonomy = yield* SessionAutonomy.Service
    const autonomousPermission = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      return yield* autonomy
        .canAutoPermission(sessionID)
        .pipe(Effect.mapError(() => new SessionErrors.NotFoundError({ sessionID })))
    })

    const fingerprintOf = (input: AssertInput) =>
      SessionReviewFold.fingerprint({ action: input.action, resources: input.resources, workdir: location.directory, metadata: input.metadata })

    const openReview = Effect.fnUntraced(function* (value: Request, conversion = false) {
      const origin = value.source?.messageID.startsWith("msg_")
        ? { messageID: SessionMessage.ID.make(value.source.messageID), callID: value.source.callID }
        : { requestID: value.id }
      return yield* SessionReviewFold.open(database.db, events, {
        sessionID: value.sessionID,
        kind: "permission",
        reason: conversion ? "sleep_entry" : "escalated",
        origin,
        payload: {
          type: "permission",
          action: DecisionChoice.redactText(value.action),
          resources: value.resources.map((resource) => DecisionChoice.redactText(resource)),
          ...(value.save === undefined ? {} : { save: [...value.save] }),
          fingerprint: fingerprintOf(value),
          requestID: value.id,
        },
        limit: Config.latest(yield* config.entries(), "guardrails")?.max_pending_reviews ?? 16,
        conversion,
      })
    })

    const asleep = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      return yield* autonomy.isAsleep(sessionID).pipe(
        Effect.mapError(() => new SessionErrors.NotFoundError({ sessionID })),
      )
    })

    const deferPending = Effect.fn("Permission.deferPending")(function* (sessionID: SessionSchema.ID) {
      const entries = Array.from(pending.values()).filter((item) => item.request.sessionID === sessionID)
      yield* Effect.forEach(entries, (item) =>
        exclusive(Effect.uninterruptible(Effect.gen(function* () {
          if (pending.get(item.request.id) !== item) return
          const review = yield* openReview(item.request, true).pipe(Effect.orDie)
          pending.delete(item.request.id)
          yield* Deferred.fail(item.deferred, new DeferredError({ requestID: item.request.id, itemID: review.itemID, action: item.request.action }))
          yield* events.publish(Event.Deferred, { sessionID, requestID: item.request.id, itemID: review.itemID })
        }))), { discard: true })
    })

    const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input)
      if (result.effect === "ask" && (yield* autonomousPermission(input.sessionID)))
        return { id: value.id, effect: "allow" as const }
      if (result.effect === "ask") {
        if (input.consumeReview !== false && (yield* SessionReviewFold.consume(database.db, events, input.sessionID, "permission", fingerprintOf(input))))
          return { id: value.id, effect: "allow" as const }
        if (yield* asleep(input.sessionID)) {
          yield* openReview(value).pipe(Effect.catchTag("SessionReview.FullError", (error) => Effect.die(error)))
          return { id: value.id, effect: result.effect }
        }
        yield* create(value, input.agent)
      }
      return { id: value.id, effect: result.effect }
    })

    const assert = Effect.fn("Permission.assert")((input: AssertInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new BlockedError({
              rules: relevant(input, result.rules),
              permission: input.action,
              resources: input.resources,
            })
          }
          if (result.effect === "allow") return
          if (yield* autonomousPermission(input.sessionID)) return
          if (input.consumeReview !== false && (yield* SessionReviewFold.consume(database.db, events, input.sessionID, "permission", fingerprintOf(input)))) return
          const value = request(input)
          if (yield* asleep(input.sessionID)) {
            const review = yield* openReview(value).pipe(
              Effect.catchTag("SessionReview.FullError", (error) => Effect.die(error)),
            )
            return yield* Effect.die(new DeferredError({ requestID: value.id, itemID: review.itemID, action: value.action }))
          }
          const item = yield* create(value, input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
            Effect.catchTag("Permission.DeferredError", (error) => Effect.die(error)),
            Effect.ensuring(
              exclusive(Effect.sync(() => {
                if (pending.get(item.request.id) === item) pending.delete(item.request.id)
              })),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("Permission.reply")((input: ReplyInput) =>
      exclusive(Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            if (input.rejectScope === "request") return
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              yield* Deferred.fail(item.deferred, new DeclinedError())
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            const input = { ...item.request }
            const rules = yield* configured(item.request.sessionID, item.agent).pipe(
              Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
            )
            if (!rules) continue
            if (denied(input, rules)) continue
            const effective = [...rules, ...rememberedRules]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
            yield* events.publish(Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      )),
    )

    const list = Effect.fn("Permission.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = Effect.fn("Permission.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ evaluateEffective, ask, assert, deferPending, reply, get, forSession, list })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventRuntime.node, Database.node, Config.node, Location.node, Agent.node, SessionAutonomy.node, SessionStore.node, PermissionSaved.node],
})
