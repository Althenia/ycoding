export * as SessionGuardrail from "./guardrail"

import path from "path"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"
import { and, asc, desc, eq } from "drizzle-orm"
import { Clock, Context, Deferred, Duration, Effect, Layer, Option, Schema } from "effect"
import { Config } from "../config"
import { ConfigGuardrail } from "../config/guardrail"
import { Decision } from "../decision"
import { DecisionChoice } from "../decision-choice"
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
import { optional } from "../schema"
import { Hash } from "../util/hash"
import { SessionAutonomy } from "./autonomy"
import { SessionErrors } from "./error"
import { SessionEvent } from "./event"
import { SessionStore } from "./store"
import { SessionGuardrailCounter } from "./guardrail-counter"
import { SessionGuardrailMatch } from "./guardrail-match"
import { SessionGuardrailStandard } from "./guardrail-standard"
import { SessionReviewFold } from "./review-fold"
import { ModelIncident } from "../model-incident/index"

export const RequestID = Guardrail.RequestID

export interface EvaluateInput {
  readonly sessionID: Session.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly source?: Guardrail.Source
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
  message: Schema.String.pipe(optional),
}) {}

export class DeferredError extends Schema.TaggedErrorClass<DeferredError>()("Guardrail.DeferredError", {
  requestID: Guardrail.RequestID,
  itemID: SessionReviewFold.ID,
  ruleIDs: Schema.Array(Schema.String),
}) {
  override get message() {
    return `This action did not run. Guardrail rule(s) ${this.ruleIDs.join(", ")} need the user's decision and were added to the review box as item ${this.itemID} while the user is asleep. Do not retry it or work around it. If the user approves, you will be told to re-issue exactly this action. Continue with independent work.`
  }
}

export function reviewMessage(error: unknown): string | undefined {
  if (error instanceof DeferredError || error instanceof DeclinedError) return error.message || undefined
}

export class RequestNotFoundError extends Schema.TaggedErrorClass<RequestNotFoundError>()(
  "Guardrail.RequestNotFoundError",
  { requestID: Guardrail.RequestID },
) {}

export type AssertError =
  | BlockedError
  | DeclinedError
  | DeferredError
  | SessionGuardrailCounter.CapExceededError
  | SessionErrors.NotFoundError

export interface ReviewPolicy {
  readonly enabled: boolean
  readonly decideReviews: boolean
  readonly decideHardReviews: boolean
}

export interface Interface {
  readonly reviewPolicy: ReviewPolicy
  readonly evaluate: (input: EvaluateInput) => Effect.Effect<Evaluation, SessionErrors.NotFoundError>
  readonly assert: (input: EvaluateInput) => Effect.Effect<Reservation, AssertError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, RequestNotFoundError | SessionErrors.NotFoundError>
  readonly deferPending: (sessionID: Session.ID) => Effect.Effect<void, SessionErrors.NotFoundError>
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
  readonly deferred: Deferred.Deferred<void, DeclinedError | DeferredError>
  readonly review: ManagedReservation
  readonly directories: ReadonlyArray<string>
  readonly decisionModel: boolean
  readonly source?: Guardrail.Source
}

interface Classification {
  readonly evidence?: SessionGuardrailStandard.Match["evidence"]
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

function classified(input: Evaluation & { readonly evidence?: SessionGuardrailStandard.Match["evidence"] }): Classification {
  const { evidence, ...evaluation } = input
  return { evaluation, directories: [], evidence }
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
    const decision = yield* Decision.Service
    const location = yield* Location.Service
    const locationMutation = yield* LocationMutation.Service
    const permission = yield* Permission.Service
    const globalRoots = [global.config, global.data, global.cache, global.state, global.tmp, global.bin, global.log, global.repos]
      .map((root) => path.resolve(root))
    const entries = yield* config.entries()
    const settings = Config.latest(entries, "guardrails")
    const reviewPolicy: ReviewPolicy = {
      enabled: settings?.enabled !== false,
      decideReviews: settings?.decide_reviews === true,
      decideHardReviews: settings?.decide_hard_reviews !== false,
    }
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

    const classify = Effect.fn("SessionGuardrail.evaluate")(function* (input: EvaluateInput, dismissedStandardRules?: ReadonlySet<string>) {
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
          dismissedStandardRules,
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
          dismissedStandardRules,
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
        evidence: SessionGuardrailStandard.match(input.action, resources[0]!, { ...paths, trustedPaths }, dismissedStandardRules)?.evidence,
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

    const reviewFingerprint = (input: EvaluateInput, result: Evaluation) =>
      SessionReviewFold.fingerprint({
        action: input.action,
        resources: input.resources,
        workdir: typeof input.metadata?.workdir === "string" ? input.metadata.workdir : location.directory,
        ruleIDs: result.ruleIDs,
        hardReview: result.hardReview,
        metadata: input.metadata,
      })

    const openReview = Effect.fnUntraced(function* (
      item: Pending,
      outcome: Guardrail.Escalation & { readonly reason: "disabled" | "escalated" | "sleep_entry" | DecisionChoice.UnsettledReason },
      conversion = false,
    ) {
      return yield* SessionReviewFold.open(database.db, events, {
        sessionID: item.request.sessionID,
        rootID: item.request.rootSessionID,
        kind: "guardrail",
        reason: outcome.reason,
        ...(outcome.choice === undefined ? {} : { choice: outcome.choice }),
        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
        ...(outcome.grades === undefined ? {} : { grades: outcome.grades }),
        origin: item.source ? { messageID: item.source.messageID, callID: item.source.callID } : { requestID: item.request.id },
        payload: {
          type: "guardrail",
          action: DecisionChoice.redactText(item.request.action),
          resources: item.request.resources.map((resource) => DecisionChoice.redactText(resource)),
          ruleIDs: [...item.request.ruleIDs],
          reason: item.request.reason,
          hardReview: item.request.hardReview ?? false,
          directories: [...item.directories],
          fingerprint: reviewFingerprint(
            {
              sessionID: item.request.sessionID,
              action: item.request.action,
              resources: item.request.resources,
              metadata: item.request.metadata,
            },
            {
              rootSessionID: item.request.rootSessionID,
              decision: "ask",
              ruleIDs: item.request.ruleIDs,
              standard: item.request.standard,
              hardReview: item.request.hardReview ?? false,
            },
          ),
          requestID: item.request.id,
        },
        limit: settings?.max_pending_reviews ?? 16,
        conversion,
      })
    })

    const assert = Effect.fn("SessionGuardrail.assert")((input: EvaluateInput) =>
      Effect.gen(function* () {
        const classification = yield* Effect.gen(function* () {
          const dismissedStandardRules = new Set<string>()
          while (true) {
            const current = yield* classify(input, dismissedStandardRules)
            const matched = current.evaluation
            const ruleID = matched.ruleIDs[0]
            if (settings?.decide_reviews !== true || matched.decision !== "ask" || !matched.standard || !ruleID?.startsWith("standard.review.") || input.skipReview) return current
            if (!current.evidence) return current
            if (!matched.hardReview) {
              const auto = yield* autonomy.canAutoGuardrail(matched.rootSessionID).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
              const asleep = yield* autonomy.isAsleep(matched.rootSessionID).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
              if (auto && !asleep) return current
            }
            const judgment = yield* DecisionChoice.verifyMatch(decision, {
              sessionID: input.sessionID,
              state: {
                matchedRule: { id: ruleID, reason: matched.reason ?? "Standard guardrail review" },
                untrustedEvidence: {
                  action: input.action, resources: [...input.resources],
                  classifier: { matchedSegment: current.evidence.matchedSegment, resolvedTargets: [...current.evidence.resolvedTargets] },
                  workdir: typeof input.metadata?.workdir === "string" ? input.metadata.workdir : location.directory,
                  project: location.vcs ? location.project.directory : location.directory,
                },
              },
            })
            if (!judgment || judgment.answer) return current
            yield* events.publish(SessionEvent.GuardrailDismissed, { sessionID: matched.rootSessionID, reviewSessionID: input.sessionID, ruleID, confidence: judgment.confidence, ...(input.source ? { source: input.source } : {}) })
            dismissedStandardRules.add(ruleID)
          }
        })
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
        const reservation = yield* Effect.acquireUseRelease(locks.withLock(result.rootSessionID)(
          Effect.gen(function* () {
            const autoGuardrail = yield* autonomy
              .canAutoGuardrail(result.rootSessionID)
              .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
            const asleep = yield* autonomy
              .isAsleep(result.rootSessionID)
              .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
            const decisionEnabled = settings?.decide_reviews === true && (!result.hardReview || settings?.decide_hard_reviews !== false)
            if (
              result.decision === "allow" ||
              input.skipReview ||
              (result.decision === "ask" && !result.hardReview && autoGuardrail && !asleep)
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

            if (
              result.decision === "ask" &&
              (yield* SessionReviewFold.consume(database.db, events, input.sessionID, "guardrail", reviewFingerprint(input, result)))
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
            const deferred = yield* Deferred.make<void, DeclinedError | DeferredError>()
            pending.set(request.id, {
              request,
              deferred,
              review,
              directories: classification.directories,
              decisionModel: decisionEnabled,
              ...(input.source ? { source: input.source } : {}),
            })
            advanceUnlocked(result.rootSessionID)
            if (!decisionEnabled && !asleep)
              yield* events
                .publish(Guardrail.Event.Asked, request)
                .pipe(
                  Effect.onError(() =>
                    Effect.sync(() => removePendingUnlocked(request.id)).pipe(Effect.andThen(review.releaseUnlocked)),
                  ),
                )
            return decisionEnabled || asleep
              ? { type: "decision-review" as const, request, deferred, review }
              : { type: "review" as const, request, deferred, review }
          }),
        ), (admission) => Effect.gen(function* () {
          if (admission.type === "allowed") return admission.reservation
          if (admission.type === "decision-review") {
            const outcome = settings?.decide_reviews !== true || (result.hardReview && settings?.decide_hard_reviews === false)
              ? { type: "unsettled" as const, reason: "disabled" as const }
              : yield* DecisionChoice.grade(decision, {
              sessionID: input.sessionID,
              name: "guardrail",
              instructions:
                "Grade every listed choice independently with bounded evidence; do not select a winner. Approve when the action is scoped to its intended target and reversible or low-impact if wrong. Approve_all grants the offered ordinary Always approval, including durable outside-directory approval where applicable, and needs stronger evidence. Reject when evidence establishes the action should not proceed. Escalate when evidence is insufficient, scope or intent is ambiguous, or a human must decide. Approve_all requires 0.9; approve requires 0.8 for ordinary reviews and 0.95 for hard reviews; reject requires 0.8. Conflicting qualifying approval and rejection grades escalate.",
              state: {
                action: input.action,
                resources: [...input.resources],
                reason: result.reason ?? "Session guardrail review required",
                ruleIDs: [...result.ruleIDs],
                hardReview: result.hardReview,
                standard: result.standard,
                risk: result.risk
                  ? {
                      level: result.risk.level,
                      label: result.risk.label,
                      score: result.risk.score,
                      metric: result.risk.metric,
                    }
                  : null,
                sessionID: input.sessionID,
                rootSessionID: result.rootSessionID,
                workdir: typeof input.metadata?.workdir === "string" ? input.metadata.workdir : location.directory,
              },
              choices: [
                ...(result.hardReview ? [] : [{ value: "approve_all", description: "Grant this ordinary review's Always approval" }]),
                { value: "approve", description: "Approve this single guardrail review once" },
                { value: "reject", description: "Reject this guardrail review" },
                { value: "escalate", description: "Ask the user to decide this guardrail review" },
              ],
            })
            const grades = outcome.type === "grades" ? Schema.decodeUnknownOption(Schema.Array(Guardrail.Grade))(outcome.grades) : Option.none()
            const ranked = Option.isSome(grades) ? grades.value.toSorted((a, b) => b.confidence - a.confidence) : []
            const qualifying = ranked.filter((grade) => grade.choice === "approve_all" ? grade.confidence >= 0.9
              : grade.choice === "approve" ? grade.confidence >= (result.hardReview ? 0.95 : 0.8)
              : grade.choice === "reject" && grade.confidence >= 0.8)
            const escalated = qualifying.length === 0 ||
              ranked.some((grade) => grade.choice === "escalate" && grade.confidence >= (ranked[0]?.confidence ?? 0)) ||
              (qualifying.some((grade) => grade.choice === "reject") && qualifying.some((grade) => grade.choice === "approve" || grade.choice === "approve_all"))
            const selected = escalated ? ranked.find((grade) => grade.choice === "escalate" && grade.confidence === ranked[0]?.confidence) ?? ranked[0] : qualifying[0]
            const choice = selected?.choice
            const provenance = {
              ...(choice === undefined ? {} : { choice }),
              ...(selected === undefined ? {} : { confidence: selected.confidence }),
              ...(Option.isSome(grades) ? { grades: grades.value } : {}),
            }
            const handedOff = escalated && (yield* withRootLock(result.rootSessionID, Effect.gen(function* () {
              const asleep = yield* autonomy.isAsleep(result.rootSessionID).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(true)))
              const item = pending.get(admission.request.id)
              if (!item) return yield* new DeclinedError({ requestID: admission.request.id })
              if (asleep) {
                const opened = yield* openReview(item, {
                  reason: outcome.type === "unsettled" ? outcome.reason : qualifying.length === 0 && choice !== "escalate" ? "low_confidence" : "escalated",
                  ...provenance,
                }).pipe(
                  Effect.catchTag("SessionReview.FullError", () => Effect.succeed(undefined)),
                )
                removePendingUnlocked(item.request.id)
                if (!opened) {
                  yield* Deferred.fail(item.deferred, new DeclinedError({
                    requestID: item.request.id,
                    message: "This action did not run. The user's review box is full, so this guardrail review was not recorded. Continue independent work and stop when only blocked work remains.",
                  }))
                  return "settled" as const
                }
                yield* events.publish(Guardrail.Event.Deferred, {
                  rootSessionID: result.rootSessionID,
                  sessionID: input.sessionID,
                  requestID: item.request.id,
                  itemID: opened.itemID,
                })
                yield* Deferred.fail(item.deferred, new DeferredError({ requestID: item.request.id, itemID: opened.itemID, ruleIDs: [...result.ruleIDs] }))
                return "settled" as const
              }
              if (outcome.type === "unsettled" && outcome.reason === "disabled") {
                pending.set(item.request.id, { ...item, decisionModel: false })
                advanceUnlocked(result.rootSessionID)
                yield* events.publish(Guardrail.Event.Asked, item.request)
                return true
              }
              const time = yield* Clock.currentTimeMillis
              yield* events.publish(SessionEvent.GuardrailEscalated, {
                sessionID: input.sessionID, requestID: admission.request.id, ruleIDs: [...item.request.ruleIDs], ...provenance, ...(item.source ? { source: item.source } : {}),
              }, {
                commit: () => ModelIncident.recordEscalation(database.db, {
                  sessionID: input.sessionID,
                  requestID: admission.request.id,
                  messageID: item.source?.messageID,
                  ruleIDs: item.request.ruleIDs,
                  hardReview: item.request.hardReview === true,
                  time,
                }),
              })
              const request = new Guardrail.Request({ ...item.request, escalation: provenance })
              pending.set(request.id, { ...item, request, decisionModel: false })
              advanceUnlocked(result.rootSessionID)
              yield* events.publish(Guardrail.Event.Asked, request)
              return true
            })).pipe(Effect.onError(() => Deferred.fail(admission.deferred, new DeclinedError({ requestID: admission.request.id })))))
            if (!handedOff) yield* reply(
              {
                sessionID: result.rootSessionID,
                requestID: admission.request.id,
                reply: choice === "approve_all" ? "always" : choice === "approve" ? "once" : "reject",
              },
              provenance,
            ).pipe(
              Effect.onError(() => Deferred.fail(admission.deferred, new DeclinedError({ requestID: admission.request.id }))),
              Effect.mapError(() => new DeclinedError({ requestID: admission.request.id })),
            )
          }
          yield* Deferred.await(admission.deferred)
        }), (admission) => admission.type === "allowed" ? Effect.void : locks.withLock(result.rootSessionID)(
          Effect.sync(() => removePendingUnlocked(admission.request.id)).pipe(Effect.andThen(admission.review.releaseUnlocked)),
        ))
        if (reservation && input.action !== "shell") return reservation
        if (input.action !== "shell")
          return yield* withRootLock(result.rootSessionID, reserveActionUnlocked(result.rootSessionID, input.action))
        return yield* reserveShell(result.rootSessionID, input.holder)
      }),
    )

    const reply = Effect.fn("SessionGuardrail.reply")(function* (
      input: ReplyInput,
      provenance?: Guardrail.Escalation,
    ) {
      if (!pending.has(input.requestID)) return yield* new RequestNotFoundError({ requestID: input.requestID })
      const rootSessionID = yield* root(input.sessionID)
      return yield* withRootLock(
        rootSessionID,
        Effect.gen(function* () {
          const item = pending.get(input.requestID)
          if (!item) return yield* new RequestNotFoundError({ requestID: input.requestID })
          if (item.decisionModel && provenance === undefined)
            return yield* new RequestNotFoundError({ requestID: input.requestID })
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
              ...(provenance
                ? { decidedBy: "decision-model" as const, ...provenance }
                : {}),
            })
            .pipe(Effect.onError(() => Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))))
          const rejection = {
            sessionID: item.request.sessionID,
            requestID: item.request.id,
            messageID: item.source?.messageID,
            ruleIDs: item.request.ruleIDs,
            hardReview: item.request.hardReview === true,
          }
          const time = yield* Clock.currentTimeMillis
          if (provenance) {
            yield* events
              .publish(SessionEvent.GuardrailDecided, {
                sessionID: item.request.rootSessionID,
                reviewSessionID: item.request.sessionID,
                requestID: item.request.id,
                reply,
                choice: provenance.choice,
                confidence: provenance.confidence,
                grades: provenance.grades,
                ruleIDs: [...item.request.ruleIDs],
                ...(item.source ? { source: item.source } : {}),
              }, {
                commit: () => reply === "reject"
                  ? ModelIncident.recordRejection(database.db, { ...rejection, decidedBy: "decision-model", time })
                  : Effect.void,
              })
              .pipe(
                Effect.onError(() => Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))),
              )
          }
          if (reply === "reject") {
            if (!provenance)
              yield* ModelIncident.recordRejection(database.db, { ...rejection, decidedBy: "human", time }).pipe(
                Effect.onError(() => Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))),
              )
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
            (request) => request.rootSessionID === rootSessionID && !pending.get(request.id)?.decisionModel,
          ),
        ),
      )
    })

    const deferPending = Effect.fn("SessionGuardrail.deferPending")(function* (sessionID: Session.ID) {
      const requests = yield* forSession(sessionID)
      const rootSessionID = yield* root(sessionID)
      yield* withRootLock(rootSessionID, Effect.forEach(requests, (request) =>
        Effect.gen(function* () {
          const item = pending.get(request.id)
          if (!item || item.decisionModel) return
          const opened = yield* openReview(item, {
            reason: "sleep_entry",
            ...(request.escalation?.choice === undefined ? {} : { choice: request.escalation.choice }),
            ...(request.escalation?.confidence === undefined ? {} : { confidence: request.escalation.confidence }),
            ...(request.escalation?.grades === undefined ? {} : { grades: request.escalation.grades }),
          }, true).pipe(Effect.orDie)
          removePendingUnlocked(request.id)
          yield* events.publish(Guardrail.Event.Deferred, {
            rootSessionID,
            sessionID: request.sessionID,
            requestID: request.id,
            itemID: opened.itemID,
          })
          yield* Deferred.fail(item.deferred, new DeferredError({ requestID: request.id, itemID: opened.itemID, ruleIDs: [...request.ruleIDs] }))
          yield* item.review.releaseUnlocked
        }), { discard: true }))
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
        Effect.flatMap((rootSessionID) =>
          withRootLock(
            rootSessionID,
            Effect.gen(function* () {
              const current = yield* statusUnlocked(rootSessionID)
              const rows = yield* database.db
                .select({ data: EventTable.data, created: EventTable.created })
                .from(EventTable)
                .where(
                  and(
                    eq(EventTable.aggregate_id, rootSessionID),
                    eq(EventTable.type, EventRuntime.versionedType(SessionEvent.GuardrailDecided.type, 1)),
                  ),
                )
                .orderBy(desc(EventTable.seq))
                .limit(100)
                .all()
                .pipe(Effect.orDie)
              const decode = Schema.decodeUnknownOption(SessionEvent.GuardrailDecided.data)
              const decisions = rows.toReversed().flatMap((row) =>
                Option.match(decode(row.data), {
                  onNone: () => [],
                  onSome: (data) => [
                    { sessionID: data.reviewSessionID, created: row.created, requestID: data.requestID, reply: data.reply, choice: data.choice, confidence: data.confidence, grades: data.grades, ruleIDs: data.ruleIDs, source: data.source },
                  ],
                }),
              )
              const dismissedRows = yield* database.db.select({ id: EventTable.id, data: EventTable.data, created: EventTable.created }).from(EventTable).where(and(
                eq(EventTable.aggregate_id, rootSessionID),
                eq(EventTable.type, EventRuntime.versionedType(SessionEvent.GuardrailDismissed.type, 1)),
              )).orderBy(desc(EventTable.seq)).limit(100).all().pipe(Effect.orDie)
              const decodeDismissal = Schema.decodeUnknownOption(SessionEvent.GuardrailDismissed.data)
              const dismissals = dismissedRows.toReversed().flatMap((row) => Option.match(decodeDismissal(row.data), {
                onNone: () => [], onSome: (data) => [{ sessionID: data.reviewSessionID, created: row.created, eventID: row.id, ruleID: data.ruleID, confidence: data.confidence, source: data.source }],
              }))
              return new Guardrail.Status({ ...current, ...(decisions.length ? { decisions } : {}), ...(dismissals.length ? { dismissals } : {}) })
            }),
          ),
        ),
      ),
    )

    const snapshot = Effect.fn("SessionGuardrail.snapshot")((sessionID: Session.ID) =>
      withSnapshot(sessionID, Effect.succeed),
    )

    return Service.of({ reviewPolicy, evaluate, assert, reply: (input) => reply(input), deferPending, forSession, status, snapshot, withSnapshot })
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
    Decision.node,
    Location.node,
  ],
})
