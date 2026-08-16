export * as SessionGuardrail from "./guardrail"

import path from "path"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { ConfigGuardrail } from "../config/guardrail"
import { makeLocationNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Hash } from "../util/hash"
import { SessionErrors } from "./error"
import { SessionStore } from "./store"
import { SessionGuardrailCounter } from "./guardrail-counter"
import { SessionGuardrailMatch } from "./guardrail-match"

export const RequestID = Guardrail.RequestID

export interface EvaluateInput {
  readonly sessionID: Session.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Guardrail.Request["metadata"]
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

export interface Snapshot {
  readonly sequence: number
  readonly digest: string
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
  readonly snapshot: (sessionID: Session.ID) => Effect.Effect<Snapshot, SessionErrors.NotFoundError>
  readonly withSnapshot: <A, E, R>(
    sessionID: Session.ID,
    use: (snapshot: Snapshot) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SessionErrors.NotFoundError, R>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionGuardrail") {}

interface Pending {
  readonly request: Guardrail.Request
  readonly deferred: Deferred.Deferred<void, DeclinedError>
  readonly review: ManagedReservation
  readonly approvalKey: string
}

interface ManagedReservation extends Reservation {
  readonly releaseUnlocked: Effect.Effect<void>
}

type LoadResult =
  | { readonly type: "document"; readonly document: ConfigGuardrail.Document }
  | { readonly type: "invalid"; readonly path: string }

interface ApprovalKeyInput {
  readonly rootSessionID: Session.ID
  readonly action: string
  readonly ruleIDs: ReadonlyArray<string>
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Guardrail.Request["metadata"]
}

const noReservation: Reservation = { release: Effect.void }

function approvalKey(input: ApprovalKeyInput) {
  return JSON.stringify([input.rootSessionID, input.action, input.ruleIDs, input.resources, input.metadata ?? null])
}

function canonicalJSON(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (!isPlainRecord(value)) throw new TypeError("Canonical JSON supports only JSON objects and arrays")
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
    .join(",")}}`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

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
    const reusableApprovals = new Map<string, Session.ID>()
    const approvals = new Map<Session.ID, number>()
    const blocked = new Map<Session.ID, number>()
    const sequences = new Map<Session.ID, number>()
    const locks = KeyedMutex.makeUnsafe<Session.ID>()
    const withRootLock = <A, E, R>(rootSessionID: Session.ID, effect: Effect.Effect<A, E, R>) =>
      locks.withLock(rootSessionID)(Effect.uninterruptible(effect)).pipe(Effect.interruptible)

    const advanceUnlocked = (rootSessionID: Session.ID) => {
      sequences.set(rootSessionID, (sequences.get(rootSessionID) ?? 0) + 1)
    }

    const removePendingUnlocked = (requestID: Guardrail.RequestID) => {
      const item = pending.get(requestID)
      if (!item) return
      pending.delete(requestID)
      advanceUnlocked(item.request.rootSessionID)
    }

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Array.from(pending.values()),
        (item) =>
          withRootLock(
            item.request.rootSessionID,
            Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id })).pipe(
              Effect.ensuring(
                Effect.sync(() => removePendingUnlocked(item.request.id)).pipe(
                  Effect.andThen(item.review.releaseUnlocked),
                ),
              ),
            ),
          ),
        { discard: true },
      ).pipe(
        Effect.andThen(
          Effect.forEach(
            Array.from(reusableApprovals.entries()),
            ([key, rootSessionID]) =>
              withRootLock(
                rootSessionID,
                Effect.sync(() => {
                  if (!reusableApprovals.delete(key)) return
                  advanceUnlocked(rootSessionID)
                }),
              ),
            { discard: true },
          ),
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

    const loadDirectory = Effect.fnUntraced(function* (source: string) {
      const directory = path.join(source, "guardrails")
      const files = yield* fs
        .scan("*.md", { cwd: directory, absolute: true, dot: false, symlink: false })
        .pipe(Effect.catch(() => Effect.succeed([])))
      const results = yield* Effect.forEach(
        files.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
        (file) =>
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

    const documents = Effect.fnUntraced(function* () {
      const repositories = entries
        .filter((entry): entry is Config.Directory => entry.type === "directory")
        .filter((entry) => path.resolve(entry.path) !== path.resolve(global.config))
        .toReversed()
      return yield* Effect.forEach([...repositories.map((entry) => entry.path), global.config], loadDirectory)
    })

    const evaluate = Effect.fn("SessionGuardrail.evaluate")(function* (input: EvaluateInput) {
      const rootSessionID = yield* root(input.sessionID)
      if (settings?.enabled === false) {
        const standard = SessionGuardrailMatch.evaluate({ action: input.action, resources: input.resources })
        return {
          rootSessionID,
          ...(standard.decision === "deny" ? standard : { decision: "allow" as const, ruleIDs: [], standard: false }),
        }
      }
      const loaded = yield* documents()
      return {
        rootSessionID,
        ...SessionGuardrailMatch.evaluate({
          action: input.action,
          resources: input.resources,
          custom: loaded,
        }),
      }
    })

    const reserveUnlocked = (rootSessionID: Session.ID, kind: SessionGuardrailCounter.Kind) =>
      counters.reserve(rootSessionID, kind).pipe(
        Effect.map((reservation): ManagedReservation => {
          advanceUnlocked(rootSessionID)
          let released = false
          const releaseUnlocked = Effect.suspend(() => {
            if (released) return Effect.void
            released = true
            return reservation.release.pipe(Effect.andThen(Effect.sync(() => advanceUnlocked(rootSessionID))))
          })
          return {
            release: withRootLock(rootSessionID, releaseUnlocked),
            releaseUnlocked,
          }
        }),
      )

    const reserveActionUnlocked = (rootSessionID: Session.ID, action: string) => {
      if (action === "shell") return reserveUnlocked(rootSessionID, "shell")
      if (action === "subagent") return reserveUnlocked(rootSessionID, "subagent")
      return Effect.succeed<ManagedReservation>({ ...noReservation, releaseUnlocked: Effect.void })
    }

    const assert = Effect.fn("SessionGuardrail.assert")((input: EvaluateInput) =>
      Effect.gen(function* () {
        const result = yield* evaluate(input)
        if (result.decision === "deny") {
          yield* withRootLock(
            result.rootSessionID,
            Effect.gen(function* () {
              blocked.set(result.rootSessionID, (blocked.get(result.rootSessionID) ?? 0) + 1)
              advanceUnlocked(result.rootSessionID)
              yield* events.publish(Guardrail.Event.Decided, {
                rootSessionID: result.rootSessionID,
                sessionID: input.sessionID,
                action: input.action,
                ruleIDs: [...result.ruleIDs],
                decision: "deny",
              })
            }),
          )
          return yield* new BlockedError({
            rootSessionID: result.rootSessionID,
            sessionID: input.sessionID,
            action: input.action,
            ruleIDs: [...result.ruleIDs],
            reason: result.reason ?? "Session guardrail denied this action",
          })
        }
        const reusableApprovalKey = approvalKey({
          rootSessionID: result.rootSessionID,
          action: input.action,
          ruleIDs: result.ruleIDs,
          resources: input.resources,
          metadata: input.metadata,
        })
        const admission = yield* withRootLock(
          result.rootSessionID,
          Effect.gen(function* () {
            if (result.decision === "allow" || reusableApprovals.has(reusableApprovalKey)) {
              const reservation = yield* reserveActionUnlocked(result.rootSessionID, input.action)
              yield* events.publish(Guardrail.Event.Decided, {
                rootSessionID: result.rootSessionID,
                sessionID: input.sessionID,
                action: input.action,
                ruleIDs: [...result.ruleIDs],
                decision: "allow",
              })
              return { type: "allowed" as const, reservation }
            }

            const review = yield* reserveUnlocked(result.rootSessionID, "review")
            const request = new Guardrail.Request({
              id: Guardrail.RequestID.create(),
              rootSessionID: result.rootSessionID,
              sessionID: input.sessionID,
              action: input.action,
              resources: [...input.resources],
              ruleIDs: [...result.ruleIDs],
              reason: result.reason ?? "Session guardrail review required",
              standard: result.standard,
              ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
            })
            const deferred = yield* Deferred.make<void, DeclinedError>()
            pending.set(request.id, { request, deferred, review, approvalKey: reusableApprovalKey })
            advanceUnlocked(result.rootSessionID)
            yield* events
              .publish(Guardrail.Event.Asked, request)
              .pipe(
                Effect.onError(() =>
                  Effect.sync(() => removePendingUnlocked(request.id)).pipe(Effect.andThen(review.releaseUnlocked)),
                ),
              )
            return { type: "review" as const, request, deferred, review }
          }),
        )
        if (admission.type === "allowed") return admission.reservation

        yield* Deferred.await(admission.deferred).pipe(
          Effect.ensuring(
            withRootLock(
              result.rootSessionID,
              Effect.sync(() => removePendingUnlocked(admission.request.id)).pipe(
                Effect.andThen(admission.review.releaseUnlocked),
              ),
            ),
          ),
        )
        return yield* withRootLock(result.rootSessionID, reserveActionUnlocked(result.rootSessionID, input.action))
      }),
    )

    const reply = Effect.fn("SessionGuardrail.reply")(function* (input: ReplyInput) {
      if (!pending.has(input.requestID)) return yield* new RequestNotFoundError({ requestID: input.requestID })
      const rootSessionID = yield* root(input.sessionID)
      return yield* withRootLock(
        rootSessionID,
        Effect.gen(function* () {
          const item = pending.get(input.requestID)
          if (!item) return yield* new RequestNotFoundError({ requestID: input.requestID })
          if (rootSessionID !== item.request.rootSessionID)
            return yield* new RequestNotFoundError({ requestID: input.requestID })
          removePendingUnlocked(input.requestID)
          yield* events
            .publish(Guardrail.Event.Replied, {
              rootSessionID: item.request.rootSessionID,
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: input.reply,
            })
            .pipe(Effect.onError(() => Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))))
          if (input.reply === "reject") {
            yield* Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))
            return yield* Effect.void
          }
          approvals.set(item.request.rootSessionID, (approvals.get(item.request.rootSessionID) ?? 0) + 1)
          advanceUnlocked(item.request.rootSessionID)
          if (input.reply === "always" && !reusableApprovals.has(item.approvalKey)) {
            reusableApprovals.set(item.approvalKey, item.request.rootSessionID)
            advanceUnlocked(item.request.rootSessionID)
          }
          yield* Deferred.succeed(item.deferred, undefined)
          return yield* Effect.void
        }),
      )
    })

    const forSession = Effect.fn("SessionGuardrail.forSession")(function* (sessionID: Session.ID) {
      const rootSessionID = yield* root(sessionID)
      return yield* withRootLock(
        rootSessionID,
        Effect.sync(() =>
          Array.from(pending.values(), (item) => item.request).filter(
            (request) => request.rootSessionID === rootSessionID,
          ),
        ),
      )
    })

    const statusUnlocked = Effect.fnUntraced(function* (rootSessionID: Session.ID) {
      const loaded = yield* documents()
      return new Guardrail.Status({
        rootSessionID,
        profile: settings?.enabled === false ? "disabled" : "standard",
        customRules: loaded.reduce((total, layer) => total + layer.rules.length, 0),
        approvals: approvals.get(rootSessionID) ?? 0,
        blocked: blocked.get(rootSessionID) ?? 0,
        counters: yield* counters.snapshot(rootSessionID),
        invalidFiles: loaded.flatMap((layer) => layer.invalidFiles),
      })
    })

    const snapshotUnlocked = Effect.fnUntraced(function* (rootSessionID: Session.ID) {
      const current = yield* statusUnlocked(rootSessionID)
      return {
        sequence: sequences.get(rootSessionID) ?? 0,
        digest: Hash.sha256(
          canonicalJSON({
            status: {
              rootSessionID: current.rootSessionID,
              profile: current.profile,
              customRules: current.customRules,
              approvals: current.approvals,
              blocked: current.blocked,
              counters: current.counters
                .map((counter) => ({
                  id: counter.id,
                  current: counter.current,
                  limit: counter.limit,
                  scope: counter.scope,
                }))
                .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
              invalidFiles: current.invalidFiles.toSorted(),
            },
            pending: Array.from(pending.values(), (item) => item.request)
              .filter((request) => request.rootSessionID === rootSessionID)
              .map((request) => ({
                id: request.id,
                rootSessionID: request.rootSessionID,
                sessionID: request.sessionID,
                action: request.action,
                resources: request.resources,
                ruleIDs: request.ruleIDs,
                reason: request.reason,
                standard: request.standard,
                metadata: request.metadata ?? null,
              }))
              .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
            reusableApprovals: Array.from(reusableApprovals.entries())
              .filter(([, approvalRootSessionID]) => approvalRootSessionID === rootSessionID)
              .map(([key]) => key)
              .toSorted(),
          }),
        ),
      }
    })

    const withSnapshot: Interface["withSnapshot"] = (sessionID, use) =>
      root(sessionID).pipe(
        Effect.flatMap((rootSessionID) =>
          withRootLock(rootSessionID, snapshotUnlocked(rootSessionID).pipe(Effect.flatMap(use))),
        ),
      )

    const status = Effect.fn("SessionGuardrail.status")((sessionID: Session.ID) =>
      root(sessionID).pipe(
        Effect.flatMap((rootSessionID) => withRootLock(rootSessionID, statusUnlocked(rootSessionID))),
      ),
    )

    const snapshot = Effect.fn("SessionGuardrail.snapshot")((sessionID: Session.ID) =>
      withSnapshot(sessionID, Effect.succeed),
    )

    return Service.of({ evaluate, assert, reply, forSession, status, snapshot, withSnapshot })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Global.node, EventV2.node, SessionStore.node],
})
