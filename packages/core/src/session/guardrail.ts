export * as SessionGuardrail from "./guardrail"

import path from "path"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"
import { and, asc, eq } from "drizzle-orm"
import { Context, Deferred, Duration, Effect, Layer, Option, Schema } from "effect"
import { Config } from "../config"
import { ConfigGuardrail } from "../config/guardrail"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { Permission } from "../permission"
import { Hash } from "../util/hash"
import { SessionAutonomy } from "./autonomy"
import { SessionErrors } from "./error"
import { SessionEvent } from "./event"
import { SessionStore } from "./store"
import { SessionGuardrailCounter } from "./guardrail-counter"
import { SessionGuardrailMatch } from "./guardrail-match"
import { SessionGuardrailStandard } from "./guardrail-standard"

export const RequestID = Guardrail.RequestID

export interface EvaluateInput {
  readonly sessionID: Session.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Guardrail.Request["metadata"]
  /** Admit ordinary and hard review decisions without a request; deny decisions still block. */
  readonly skipReview?: boolean
  readonly holder?: string
}

export interface Evaluation {
  readonly rootSessionID: Session.ID
  readonly decision: Guardrail.RuleDecision
  readonly ruleIDs: ReadonlyArray<string>
  readonly reason?: string
  readonly standard: boolean
  readonly hardReview: boolean
  readonly risk?: Guardrail.Risk
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

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionGuardrail") {}

interface Pending {
  readonly request: Guardrail.Request
  readonly deferred: Deferred.Deferred<void, DeclinedError>
  readonly review: ManagedReservation
  readonly directories: ReadonlyArray<string>
}

interface Classification {
  readonly evaluation: Evaluation
  readonly directories: ReadonlyArray<string>
}

interface ManagedReservation extends Reservation {
  readonly releaseUnlocked: Effect.Effect<void>
}

type LoadResult =
  | { readonly type: "document"; readonly document: ConfigGuardrail.Document }
  | { readonly type: "invalid"; readonly path: string }

const noReservation: Reservation = { release: Effect.void }

const decodeApproval = Schema.decodeUnknownOption(SessionEvent.GuardrailApproved.data)

function classified(evaluation: Evaluation): Classification {
  return { evaluation, directories: [] }
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
    const database = yield* Database.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const events = yield* EventRuntime.Service
    const sessions = yield* SessionStore.Service
    const autonomy = yield* SessionAutonomy.Service
    const location = yield* Location.Service
    const locationMutation = yield* LocationMutation.Service
    const permission = yield* Permission.Service
    const globalRoots = [global.config, global.data, global.cache, global.state, global.tmp, global.bin, global.log, global.repos]
      .map((root) => path.resolve(root))
    const entries = yield* config.entries()
    const settings = Config.latest(entries, "guardrails")
    const counters = SessionGuardrailCounter.make({
      shells: settings?.max_concurrent_shells ?? 8,
      subagents: settings?.max_concurrent_subagents ?? 8,
      reviews: settings?.max_pending_reviews ?? 16,
    })
    const shellWait = Duration.seconds(settings?.shell_wait_seconds ?? 60)
    const pending = new Map<Guardrail.RequestID, Pending>()
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
      ),
    )

    const approvedDirectories = (rootSessionID: Session.ID) =>
      database.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, rootSessionID),
            eq(EventTable.type, EventRuntime.versionedType(SessionEvent.GuardrailApproved.type, 1)),
          ),
        )
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) =>
            rows.flatMap((row) =>
              Option.match(decodeApproval(row.data), { onNone: () => [], onSome: (data) => data.directories }),
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

    const classify = Effect.fn("SessionGuardrail.evaluate")(function* (input: EvaluateInput) {
      const rootSessionID = yield* root(input.sessionID)
      const paths = {
        workdir: typeof input.metadata?.workdir === "string" ? input.metadata.workdir : location.directory,
        project: location.vcs ? location.project.directory : location.directory,
        home: global.home,
        tmpdir: process.env.TMPDIR,
      }
      if (settings?.enabled === false) {
        const loaded = yield* documents()
        const standard = SessionGuardrailMatch.evaluate({
          action: input.action,
          resources: input.resources,
          paths,
          custom: loaded.map((layer) => ({
            rules: layer.rules.filter((rule) => rule.decision === "hard_review"),
            invalidFiles: [],
          })),
        })
        return classified({
          rootSessionID,
          ...(standard.decision === "deny" || standard.hardReview
            ? standard
            : { decision: "allow" as const, ruleIDs: [], standard: false, hardReview: false }),
        })
      }
      const loaded = yield* documents()
      const result = {
        rootSessionID,
        ...SessionGuardrailMatch.evaluate({
          action: input.action,
          resources: input.resources,
          paths,
          custom: loaded,
        }),
      }
      if (!result.standard || result.ruleIDs[0] !== "standard.review.outside-repo" || input.skipReview === true)
        return classified(result)
      const directories = input.resources.flatMap((resource) =>
        SessionGuardrailStandard.outsideTargets(input.action, resource, paths)).reduce((result, target) => {
        result.set(target.path, result.get(target.path) === true || target.directory)
        return result
      }, new Map<string, boolean>())
      const candidates = [...directories.keys()]
      const boundary = (target: string) => (directories.get(target) === true ? target : path.dirname(target))
      const approved = yield* approvedDirectories(rootSessionID)
      const trustedPaths = yield* Effect.filter(candidates, (target) =>
        approved.some((directory) => FSUtil.contains(directory, target))
          ? Effect.succeed(true)
          : locationMutation.repositoryWorktree(target).pipe(
          Effect.catch(() => Effect.succeed(false)),
          Effect.flatMap((checkout) => {
            if (checkout || globalRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`)))
              return Effect.succeed(true)
            return permission.evaluateEffective({
              sessionID: input.sessionID,
              action: "external_directory",
              resource: path.join(boundary(target), "*").replaceAll("\\", "/"),
            }).pipe(Effect.map((effect) => effect === "allow"))
          }),
        ))
      const resources = SessionGuardrailStandard.semanticResources(input.action, input.resources, paths).filter((resource) =>
        SessionGuardrailStandard.outsidePaths(input.action, resource, { ...paths, trustedPaths }).length > 0)
      if (resources.length === 0)
        return classified({ rootSessionID, decision: "allow", ruleIDs: [], standard: false, hardReview: false })
      return {
        ...classified(result),
        directories: [...new Set(candidates.filter((target) => !trustedPaths.includes(target)).map(boundary))],
      }
    })

    const evaluate: Interface["evaluate"] = (input) => classify(input).pipe(Effect.map((result) => result.evaluation))

    const managed = (rootSessionID: Session.ID, reservation: SessionGuardrailCounter.Reservation): ManagedReservation => {
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
    }

    const reserveUnlocked = (rootSessionID: Session.ID, kind: SessionGuardrailCounter.Kind) =>
      counters.reserve(rootSessionID, kind).pipe(Effect.map((reservation) => managed(rootSessionID, reservation)))

    const reserveActionUnlocked = (rootSessionID: Session.ID, action: string) => {
      if (action === "subagent") return reserveUnlocked(rootSessionID, "subagent")
      return Effect.succeed<ManagedReservation>({ ...noReservation, releaseUnlocked: Effect.void })
    }

    const reserveShell = (rootSessionID: Session.ID, holder: string | undefined) =>
      Effect.uninterruptibleMask((restore) =>
        restore(counters.reserve(rootSessionID, "shell", { holder, wait: shellWait })).pipe(
          Effect.map((reservation) => managed(rootSessionID, reservation)),
        ),
      )

    const assert = Effect.fn("SessionGuardrail.assert")((input: EvaluateInput) =>
      Effect.gen(function* () {
        const classification = yield* classify(input)
        const result = classification.evaluation
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
        const admission = yield* withRootLock(
          result.rootSessionID,
          Effect.gen(function* () {
            const autoGuardrail = yield* autonomy
              .canAutoGuardrail(result.rootSessionID)
              .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
            if (
              result.decision === "allow" ||
              input.skipReview ||
              (result.decision === "ask" && !result.hardReview && autoGuardrail)
            ) {
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
              ...(result.hardReview ? { hardReview: true } : {}),
              ...(result.risk ? { risk: result.risk } : {}),
              ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
            })
            const deferred = yield* Deferred.make<void, DeclinedError>()
            pending.set(request.id, { request, deferred, review, directories: classification.directories })
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
        if (admission.type === "allowed" && input.action !== "shell") return admission.reservation
        if (admission.type === "review")
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
        if (input.action !== "shell")
          return yield* withRootLock(result.rootSessionID, reserveActionUnlocked(result.rootSessionID, input.action))
        return yield* reserveShell(result.rootSessionID, input.holder)
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
          const reply = item.request.hardReview && input.reply === "always" ? "reject" : input.reply
          yield* events
            .publish(Guardrail.Event.Replied, {
              rootSessionID: item.request.rootSessionID,
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply,
            })
            .pipe(Effect.onError(() => Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))))
          if (reply === "reject") {
            yield* Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))
            return yield* Effect.void
          }
          if (reply === "always" && item.directories.length > 0) {
            yield* events
              .publish(SessionEvent.GuardrailApproved, {
                sessionID: item.request.rootSessionID,
                directories: [...item.directories],
              })
              .pipe(Effect.onError(() => Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))))
            advanceUnlocked(item.request.rootSessionID)
          }
          approvals.set(item.request.rootSessionID, (approvals.get(item.request.rootSessionID) ?? 0) + 1)
          advanceUnlocked(item.request.rootSessionID)
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
      const approved = yield* approvedDirectories(rootSessionID)
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
                hardReview: request.hardReview ?? false,
                risk: request.risk ?? null,
                metadata: request.metadata ?? null,
              }))
              .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
            approvedDirectories: [...new Set(approved)].toSorted(),
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
  deps: [
    Config.node,
    Database.node,
    FSUtil.node,
    Global.node,
    LocationMutation.node,
    Permission.node,
    EventRuntime.node,
    SessionStore.node,
    SessionAutonomy.node,
    Location.node,
  ],
})
