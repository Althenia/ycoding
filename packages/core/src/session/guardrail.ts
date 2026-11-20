export * as SessionGuardrail from "./guardrail"

import path from "path"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Form } from "@ycoding-ai/schema/form"
import { Session } from "@ycoding-ai/schema/session"
import type { DecisionMode } from "@ycoding-ai/schema/session-autonomy"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { Clock, Context, Deferred, Duration, Effect, Layer, Option, Schema } from "effect"
import { Config } from "../config"
import { ConfigGuardrail } from "../config/guardrail"
import { StandaloneConfig } from "../config/standalone"
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
import { CoordinationEscalation } from "./coordination-escalation"
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
  readonly defer?: true
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

export interface RequestInput {
  readonly sessionID: Session.ID
  readonly requestID: Guardrail.RequestID
}

export interface Snapshot {
  readonly sequence: number
  readonly digest: string
}

export interface RequestSnapshot {
  readonly request: Guardrail.Request
  readonly fingerprint: string
}

export interface ReconsiderInput {
  readonly sessionID: Session.ID
  readonly requestID: Guardrail.RequestID
  readonly fingerprint: string
  readonly actor: "coordinator"
  readonly source: { readonly coordinatorSessionID: Session.ID; readonly groupID?: string; readonly rationale: string }
  readonly decision?: "approve" | "decline"
  readonly validate: (snapshot: Guardrail.Request) => Effect.Effect<boolean>
}

export interface EscalateInput extends CoordinationEscalation.Input {
  readonly sessionID: Session.ID
  readonly requestID: Guardrail.RequestID
}

export type EscalateResult = CoordinationEscalation.Result<Guardrail.RequestID>

export interface ReconsiderResult {
  readonly outcome: "allowed" | "denied" | "escalated" | "stale"
  readonly requestID: Guardrail.RequestID
  readonly fingerprint: string
  readonly settled: boolean
  readonly via?: "auto-guardrail" | "baseline" | "yolo" | "guardrail-rules" | "coordination"
  readonly reason?: string
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
  sessionID: Session.ID,
  itemID: SessionReviewFold.ID.pipe(optional),
  state: Schema.Literals(["open", "rejected", "full"]),
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  ruleIDs: Schema.Array(Schema.String),
  hardReview: Schema.Boolean,
}) {
  override get message() {
    if (this.state === "rejected")
      return `This action did not run. Guardrail rule(s) ${this.ruleIDs.join(", ")} were rejected in review item ${this.itemID}; an identical request stays refused.`
    if (this.state === "full")
      return `This action did not run. Guardrail rule(s) ${this.ruleIDs.join(", ")} need the user's decision, but the review box is full, so no review item was recorded.`
    return `This action did not run. Guardrail rule(s) ${this.ruleIDs.join(", ")} need the user's decision and were added to the review box as item ${this.itemID} while decisions are deferred. Do not retry it or work around it. If the user approves, you will be told to re-issue exactly this action. Continue with independent work.`
  }
}

export function reviewMessage(error: unknown): string | undefined {
  if (error instanceof DeferredError || error instanceof DeclinedError) return error.message || undefined
  if (error instanceof Permission.CorrectedError) return error.feedback
  return undefined
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

export interface DelegatedReplyInput {
  readonly explicitDecision?: true
  readonly sessionID: Session.ID
  readonly requestID: Guardrail.RequestID
  readonly reply: "once" | "reject"
  readonly fingerprint: string
  readonly source: Form.ExternalReplySource
  readonly validate: (request: Guardrail.Request) => Effect.Effect<boolean>
}

export interface Interface {
  readonly replyDelegated: (input: DelegatedReplyInput) => Effect.Effect<void, RequestNotFoundError | SessionErrors.NotFoundError>
  readonly delegatedEligible: (input: { readonly sessionID: Session.ID; readonly requestID: Guardrail.RequestID; readonly fingerprint: string; readonly reply: "once" | "reject" }) => Effect.Effect<boolean, SessionErrors.NotFoundError>
  readonly reviewPolicy: ReviewPolicy
  readonly evaluate: (input: EvaluateInput) => Effect.Effect<Evaluation, SessionErrors.NotFoundError>
  readonly assert: (input: EvaluateInput) => Effect.Effect<Reservation, AssertError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, RequestNotFoundError | SessionErrors.NotFoundError>
  readonly cancel: (input: RequestInput) => Effect.Effect<void, RequestNotFoundError | SessionErrors.NotFoundError>
  readonly retry: (input: RequestInput) => Effect.Effect<Guardrail.Request, RequestNotFoundError | SessionErrors.NotFoundError>
  readonly requestSnapshot: (
    sessionID: Session.ID,
    requestID: Guardrail.RequestID,
    family?: ReadonlyArray<Session.ID>,
  ) => Effect.Effect<RequestSnapshot | undefined, SessionErrors.NotFoundError>
  readonly reconsider: (input: ReconsiderInput) => Effect.Effect<ReconsiderResult, SessionErrors.NotFoundError>
  readonly escalate: (input: EscalateInput) => Effect.Effect<EscalateResult, SessionErrors.NotFoundError>
  readonly requestSnapshots: (sessionID: Session.ID, family?: ReadonlyArray<Session.ID>) => Effect.Effect<ReadonlyArray<RequestSnapshot>, SessionErrors.NotFoundError>
  readonly reconcileAutonomy: (sessionID: Session.ID) => Effect.Effect<void, SessionErrors.NotFoundError>
  readonly deferPending: (sessionID: Session.ID) => Effect.Effect<void, SessionErrors.NotFoundError>
  readonly forSession: (
    sessionID: Session.ID,
  ) => Effect.Effect<ReadonlyArray<Guardrail.Request>, SessionErrors.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Guardrail.Request>>
  readonly status: (sessionID: Session.ID) => Effect.Effect<Guardrail.Status, SessionErrors.NotFoundError>
  readonly snapshot: (sessionID: Session.ID) => Effect.Effect<Snapshot, SessionErrors.NotFoundError>
  readonly withSnapshot: <A, E, R>(
    sessionID: Session.ID,
    use: (snapshot: Snapshot) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SessionErrors.NotFoundError, R>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionGuardrail") {}

export interface ObservationInterface {
  readonly snapshot: (sessionID: Session.ID) => Effect.Effect<Snapshot, SessionErrors.NotFoundError | SessionErrors.ScopeUnavailableError>
  readonly withSnapshot: <A, E, R>(
    sessionID: Session.ID,
    use: (snapshot: Snapshot, validate: Effect.Effect<void, SessionErrors.ScopeUnavailableError>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SessionErrors.NotFoundError | SessionErrors.ScopeUnavailableError, R>
}

export class Observation extends Context.Service<Observation, ObservationInterface>()("@ycoding/SessionGuardrailObservation") {}

interface Pending {
  request: Guardrail.Request
  readonly created: number
  readonly deferred: Deferred.Deferred<void, DeclinedError | DeferredError>
  readonly review: ManagedReservation
  readonly directories: ReadonlyArray<string>
  readonly deferring: boolean
  readonly source?: Guardrail.Source
}

interface Classification {
  readonly yolo?: true
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

interface RuleDocuments {
  readonly rules: ReadonlyArray<Guardrail.Rule>
  readonly invalidFiles: ReadonlyArray<string>
}

interface AuthorityInterface {
  readonly pending: Map<Guardrail.RequestID, Pending>
  readonly approvals: Map<Session.ID, number>
  readonly blocked: Map<Session.ID, number>
  readonly sequences: Map<Session.ID, number>
  readonly limits: { shells: number; subagents: number; reviews: number }
  readonly counters: SessionGuardrailCounter.Interface
  readonly locks: ReturnType<typeof KeyedMutex.makeUnsafe<Session.ID>>
  readonly withRootLock: <A, E, R>(rootSessionID: Session.ID, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly advanceUnlocked: (rootSessionID: Session.ID) => void
  readonly removePendingUnlocked: (requestID: Guardrail.RequestID) => void
  readonly cancelPendingUnlocked: (requestID: Guardrail.RequestID) => Effect.Effect<void>
  readonly root: (sessionID: Session.ID) => Effect.Effect<Session.ID, SessionErrors.NotFoundError>
  readonly approvedDirectories: (rootSessionID: Session.ID) => Effect.Effect<ReadonlyArray<string>>
}

class Authority extends Context.Service<Authority, AuthorityInterface>()("@ycoding/SessionGuardrailAuthority") {}

const noReservation: Reservation = { release: Effect.void }

const decodeApproval = Schema.decodeUnknownOption(SessionEvent.GuardrailApproved.data)
const decodePermissionAssessed = Schema.decodeUnknownOption(SessionEvent.PermissionAssessed.data)
const decodePermissionReplied = Schema.decodeUnknownOption(Permission.Event.Replied.data)
const permissionAssessedType = EventRuntime.versionedType(
  SessionEvent.PermissionAssessed.type,
  SessionEvent.PermissionAssessed.durable.version,
)

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

const authorityLayer = Layer.effect(Authority, Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const sessions = yield* SessionStore.Service
  const limits = { shells: 8, subagents: 8, reviews: 16 }
  const counters = SessionGuardrailCounter.make(limits)
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
  const cancelPendingUnlocked = Effect.fnUntraced(function* (requestID: Guardrail.RequestID) {
    const item = pending.get(requestID)
    if (!item) return
    removePendingUnlocked(requestID)
    yield* events.publish(Guardrail.Event.Cancelled, { rootSessionID: item.request.rootSessionID, sessionID: item.request.sessionID, requestID })
  })
  yield* Effect.addFinalizer(() => Effect.forEach(
    Array.from(pending.values()),
    (item) => locks.withLock(item.request.rootSessionID)(
      Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id })).pipe(
        Effect.ensuring(cancelPendingUnlocked(item.request.id).pipe(Effect.andThen(item.review.releaseUnlocked))),
      ),
    ),
    { discard: true },
  ))
  const approvedDirectories = (rootSessionID: Session.ID) => database.db
    .select({ data: EventTable.data }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, rootSessionID),
      eq(EventTable.type, EventRuntime.versionedType(SessionEvent.GuardrailApproved.type, 1)),
    )).orderBy(asc(EventTable.seq)).all().pipe(
      Effect.orDie,
      Effect.map((rows) => rows.flatMap((row) => Option.match(decodeApproval(row.data), { onNone: () => [], onSome: (data) => data.directories }))),
    )
  const root = (sessionID: Session.ID): Effect.Effect<Session.ID, SessionErrors.NotFoundError> => Effect.gen(function* () {
    const session = yield* sessions.get(sessionID)
    if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
    return session.parentID ? yield* root(session.parentID) : session.id
  })
  return Authority.of({ pending, approvals, blocked, sequences, limits, counters, locks, withRootLock, advanceUnlocked, removePendingUnlocked, cancelPendingUnlocked, root, approvedDirectories })
}))

const authorityNode = makeLocationNode({ service: Authority, layer: authorityLayer, deps: [Database.node, EventRuntime.node, SessionStore.node] })

function parseDocument(file: string, content: string | undefined): LoadResult {
  if (content === undefined) return { type: "invalid", path: file }
  try {
    return { type: "document", document: ConfigGuardrail.parse(file, content) }
  } catch {
    return { type: "invalid", path: file }
  }
}

function ruleDocuments(results: ReadonlyArray<LoadResult>): RuleDocuments {
  return {
    rules: results.flatMap((result) => result.type === "document" && result.document.enabled && result.document.rule ? [result.document.rule] : []),
    invalidFiles: results.flatMap((result) => result.type === "invalid" ? [result.path] : []),
  }
}

const loadDirectory = (fs: FSUtil.Interface, source: string) => Effect.gen(function* () {
  const files = yield* fs.scan("*.md", { cwd: path.join(source, "guardrails"), absolute: true, dot: false, symlink: false }).pipe(Effect.catch(() => Effect.succeed([])))
  return ruleDocuments(yield* Effect.forEach(files.toSorted((left, right) => left < right ? -1 : left > right ? 1 : 0), (file) =>
    fs.readFileStringSafe(file).pipe(Effect.map((content) => parseDocument(file, content)), Effect.catch(() => Effect.succeed<LoadResult>({ type: "invalid", path: file }))),
  ))
})

const loadStandaloneDocuments = (fs: FSUtil.Interface, source: string) => Effect.gen(function* () {
  const unavailable = () => new SessionErrors.ScopeUnavailableError({ operation: "global guardrail policy" })
  const canonical = (target: string) => fs.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => fs.readLink(target).pipe(
      Effect.flatMap(() => Effect.fail(unavailable())),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
    )),
    Effect.mapError(unavailable),
  )
  const root = yield* canonical(source)
  if (root === undefined) return [ruleDocuments([])]
  const directory = path.join(source, "guardrails")
  const resolved = yield* canonical(directory)
  if (resolved === undefined) return [ruleDocuments([])]
  if (!FSUtil.contains(root, resolved)) return yield* unavailable()
  const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.mapError(unavailable))
  const files = entries.filter((entry) => (entry.type === "file" || entry.type === "symlink") && !entry.name.startsWith(".") && entry.name.endsWith(".md")).map((entry) => path.join(directory, entry.name))
  const results = yield* Effect.forEach(files.toSorted((left, right) => left < right ? -1 : left > right ? 1 : 0), (file) => Effect.gen(function* () {
    if (path.dirname(file) !== directory || !file.endsWith(".md")) return yield* unavailable()
    const physical = yield* fs.realPath(file).pipe(Effect.mapError(unavailable))
    if (path.dirname(physical) !== resolved || !FSUtil.contains(root, physical)) return yield* unavailable()
    const content = yield* fs.readFileString(physical).pipe(Effect.mapError(unavailable))
    return parseDocument(file, content)
  }))
  return [ruleDocuments(results)]
})

function observe<E>(authority: AuthorityInterface, policy: Effect.Effect<{
  readonly settings: ConfigGuardrail.Info | undefined
  readonly documents: ReadonlyArray<RuleDocuments>
}, E>) {
  const statusUnlocked = (rootSessionID: Session.ID) => Effect.gen(function* () {
    const current = yield* policy
    Object.assign(authority.limits, { shells: current.settings?.max_concurrent_shells ?? 8, subagents: current.settings?.max_concurrent_subagents ?? 8, reviews: current.settings?.max_pending_reviews ?? 16 })
    return new Guardrail.Status({
      rootSessionID,
      profile: current.settings?.enabled === false ? "disabled" : "standard",
      customRules: current.documents.reduce((total, layer) => total + layer.rules.length, 0),
      approvals: authority.approvals.get(rootSessionID) ?? 0,
      blocked: authority.blocked.get(rootSessionID) ?? 0,
      counters: yield* authority.counters.snapshot(rootSessionID),
      invalidFiles: current.documents.flatMap((layer) => layer.invalidFiles),
    })
  })
  const snapshotUnlocked = (rootSessionID: Session.ID) => Effect.gen(function* () {
    const current = yield* statusUnlocked(rootSessionID)
    const approved = yield* authority.approvedDirectories(rootSessionID)
    return {
      sequence: authority.sequences.get(rootSessionID) ?? 0,
      digest: Hash.sha256(canonicalJSON({
        status: {
          rootSessionID: current.rootSessionID,
          profile: current.profile,
          customRules: current.customRules,
          approvals: current.approvals,
          blocked: current.blocked,
          counters: current.counters.map((counter) => ({ id: counter.id, current: counter.current, limit: counter.limit, scope: counter.scope })).toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
          invalidFiles: current.invalidFiles.toSorted(),
        },
        pending: Array.from(authority.pending.values(), (item) => item.request).filter((request) => request.rootSessionID === rootSessionID).map((request) => ({
          id: request.id, rootSessionID: request.rootSessionID, sessionID: request.sessionID, action: request.action,
          resources: request.resources, ruleIDs: request.ruleIDs, reason: request.reason, standard: request.standard,
          hardReview: request.hardReview ?? false, risk: request.risk ?? null, metadata: request.metadata ?? null,
        })).toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        approvedDirectories: [...new Set(approved)].toSorted(),
      })),
    }
  })
  const withSnapshot = <A, E2, R>(sessionID: Session.ID, use: (snapshot: Snapshot) => Effect.Effect<A, E2, R>) => authority.root(sessionID).pipe(
    Effect.flatMap((rootSessionID) => authority.withRootLock(rootSessionID, snapshotUnlocked(rootSessionID).pipe(Effect.flatMap(use)))),
  )
  return { statusUnlocked, withSnapshot, snapshot: (sessionID: Session.ID) => withSnapshot(sessionID, Effect.succeed) }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const events = yield* EventRuntime.Service
    const autonomy = yield* SessionAutonomy.Service
    const location = yield* Location.Service
    const locationMutation = yield* LocationMutation.Service
    const permission = yield* Permission.Service
    const globalRoots = [global.config, global.data, global.cache, global.state, global.tmp, global.bin, global.log, global.repos]
      .map((root) => path.resolve(root))
    const entries = yield* config.entries()
    const settings = Config.latest(entries, "guardrails")
    const reviewPolicy: ReviewPolicy = {
      enabled: settings?.enabled !== false,
      decideReviews: settings?.decide_reviews !== false,
      decideHardReviews: settings?.decide_hard_reviews !== false,
    }
    const authority = yield* Authority
    Object.assign(authority.limits, {
      shells: settings?.max_concurrent_shells ?? 8,
      subagents: settings?.max_concurrent_subagents ?? 8,
      reviews: settings?.max_pending_reviews ?? 16,
    })
    const counters = authority.counters
    const shellWait = Duration.seconds(settings?.shell_wait_seconds ?? 60)
    const hardReviewExpiryMinutes = settings?.hard_review_expiry_minutes ?? 1440
    const pending = authority.pending
    const reconsidering = new Set<Guardrail.RequestID>()
    const approvals = authority.approvals
    const blocked = authority.blocked
    const locks = authority.locks
    const withRootLock = authority.withRootLock
    const advanceUnlocked = authority.advanceUnlocked
    const removePendingUnlocked = authority.removePendingUnlocked
    const cancelPendingUnlocked = authority.cancelPendingUnlocked
    const root = authority.root
    const approvedDirectories = authority.approvedDirectories

    const explicitApprovals = new Map<string, ReadonlyArray<{
      readonly action: string
      readonly resources: ReadonlyArray<string>
      readonly reply: "once" | "always"
    }>>()
    const callKey = (sessionID: string, source: { readonly messageID: string; readonly callID: string }) =>
      `${sessionID}\0${source.messageID}\0${source.callID}`
    const unlisten = yield* events.listen((event) => {
      if (event.type !== Permission.Event.Replied.type) return Effect.void
      const replied = decodePermissionReplied(event.data)
      if (Option.isNone(replied) || replied.value.reply === "reject") return Effect.void
      const reply = replied.value.reply
      return permission.get(replied.value.requestID).pipe(
        Effect.map((request) => {
          if (!request?.source || request.sessionID !== replied.value.sessionID) return
          const key = callKey(request.sessionID, request.source)
          const recorded = explicitApprovals.get(key) ?? []
          explicitApprovals.delete(key)
          explicitApprovals.set(key, [
            ...recorded.slice(-7),
            { action: request.action, resources: request.resources.slice(0, 20).map((resource) => resource.slice(0, 1000)), reply },
          ])
          const oldest = explicitApprovals.keys().next()
          if (explicitApprovals.size > 256 && !oldest.done) explicitApprovals.delete(oldest.value)
        }),
      )
    })
    yield* Effect.addFinalizer(() => unlisten)

    const documents = Effect.fnUntraced(function* () {
      const repositories = entries
        .filter((entry): entry is Config.Directory => entry.type === "directory")
        .filter((entry) => path.resolve(entry.path) !== path.resolve(global.config))
        .toReversed()
      return yield* Effect.forEach([...repositories.map((entry) => entry.path), global.config], (source) => loadDirectory(fs, source))
    })

    const classify = Effect.fn("SessionGuardrail.evaluate")(function* (input: EvaluateInput, mode?: DecisionMode) {
      const rootSessionID = yield* root(input.sessionID)
      const current = mode ?? (yield* DecisionChoice.decisionMode(autonomy, rootSessionID, "guardrails"))
      if (current === "yolo")
        return { ...classified({ rootSessionID, decision: "allow", ruleIDs: [], standard: false, hardReview: false }), yolo: true as const }
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
      if (result.evidence?.uncertainFilesystem) return classified(result)
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
        evidence: SessionGuardrailStandard.match(input.action, resources[0]!, { ...paths, trustedPaths })?.evidence,
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
      (input.defer ? SessionReviewFold.deferredFingerprint : SessionReviewFold.fingerprint)({
        action: input.action,
        resources: input.resources,
        workdir: typeof input.metadata?.workdir === "string" ? input.metadata.workdir : location.directory,
        ruleIDs: result.ruleIDs,
        hardReview: result.hardReview,
        metadata: input.metadata,
      })

    const requestFingerprint = (request: Guardrail.Request) =>
      reviewFingerprint(
        { sessionID: request.sessionID, action: request.action, resources: request.resources, metadata: request.metadata },
        {
          rootSessionID: request.rootSessionID,
          decision: "ask",
          ruleIDs: request.ruleIDs,
          standard: request.standard,
          hardReview: request.hardReview ?? false,
        },
      )

    const rejections = new Set<string>()
    const recordExplicitReply = (request: Guardrail.Request, reply: Guardrail.Reply) => {
      const key = `${request.sessionID}\0${requestFingerprint(request)}`
      rejections.delete(key)
      if (reply !== "reject") return
      rejections.add(key)
      const oldest = rejections.values().next()
      if (rejections.size > 512 && !oldest.done) rejections.delete(oldest.value)
    }

    const applicabilityOf = Effect.fnUntraced(function* (input: EvaluateInput, result: Evaluation) {
      const fingerprint = reviewFingerprint(input, result)
      const source = input.source
      const settlements = source === undefined
        ? []
        : yield* database.db
            .select({ data: EventTable.data })
            .from(EventTable)
            .where(
              and(
                eq(EventTable.aggregate_id, input.sessionID),
                eq(EventTable.type, permissionAssessedType),
                sql`json_extract(${EventTable.data}, '$.source.messageID') = ${source.messageID}`,
                sql`json_extract(${EventTable.data}, '$.source.callID') = ${source.callID}`,
              ),
            )
            .orderBy(asc(EventTable.seq))
            .limit(8)
            .all()
            .pipe(Effect.orDie)
      const reviews = (yield* SessionReviewFold.fold(database.db, [input.sessionID]))
        .filter((item) => item.kind === "guardrail" && "fingerprint" in item.payload && item.payload.fingerprint === fingerprint)
        .toSorted((left, right) => left.created - right.created)
        .slice(-5)
      const prior: Permission.Prior[] = [
        ...(rejections.has(`${input.sessionID}\0${fingerprint}`) ? [{ source: "explicit" as const, status: "rejected" as const }] : []),
        ...reviews.map((item) => ({ source: "review" as const, status: Permission.reviewStatus(item) })),
      ]
      return {
        gate: "guardrail" as const,
        sameCall: [
          ...settlements.flatMap((row) =>
            Option.match(decodePermissionAssessed(row.data), {
              onNone: () => [],
              onSome: (data) => [{
                gate: "permission" as const,
                source: "automated" as const,
                outcome: data.outcome,
                via: data.via,
                choice: data.choice ?? null,
                confidence: data.confidence ?? null,
              }],
            }),
          ),
          ...(source === undefined ? [] : explicitApprovals.get(callKey(input.sessionID, source)) ?? []).map((approval) => ({
            gate: "permission" as const,
            source: "explicit" as const,
            outcome: "allow" as const,
            reply: approval.reply,
            action: approval.action,
            resources: [...approval.resources],
          })),
        ],
        prior,
      }
    })

    type ReviewOutcome = Omit<Guardrail.Escalation, "reason"> & { readonly reason: "disabled" | "escalated" | "defer_entry" | "conflicting_grades" | DecisionChoice.UnsettledReason }

    const openReview = (item: Pending, outcome: ReviewOutcome, conversion = false) =>
      SessionReviewFold.open(database.db, events, reviewInput(item, outcome, conversion))

    const deferredError = (request: Guardrail.Request, state: DeferredError["state"], itemID?: SessionReviewFold.ID) =>
      new DeferredError({
        requestID: request.id,
        sessionID: request.sessionID,
        ...(itemID === undefined ? {} : { itemID }),
        state,
        action: request.action,
        resources: request.resources.map((resource) => DecisionChoice.redactText(resource)),
        ruleIDs: [...request.ruleIDs],
        hardReview: request.hardReview ?? false,
      })

    const reviewInput = (item: Pending, outcome: ReviewOutcome, conversion = false) =>
      ({
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
          fingerprint: requestFingerprint(item.request),
          requestID: item.request.id,
          ...CoordinationEscalation.redacted(item.request.coordinationEscalation),
        },
        limit: settings?.max_pending_reviews ?? 16,
        conversion,
      }) satisfies SessionReviewFold.OpenInput

    const assert = Effect.fn("SessionGuardrail.assert")((input: EvaluateInput) =>
      Effect.gen(function* () {
        const initial = yield* classify(input)
        const rootSessionID = initial.evaluation.rootSessionID
        const reservation = yield* Effect.acquireUseRelease(locks.withLock(rootSessionID)(
          Effect.gen(function* () {
            const mode = yield* DecisionChoice.decisionMode(autonomy, rootSessionID, "guardrails")
            const classification = initial.yolo && mode !== "yolo" ? yield* classify(input, mode) : initial
            const result = classification.evaluation
            if (mode === "yolo" || result.decision === "allow" || (result.decision !== "deny" && input.skipReview)) {
              const reservation = yield* reserveActionUnlocked(result.rootSessionID, input.action)
              yield* events.publish(Guardrail.Event.Decided, {
                rootSessionID: result.rootSessionID, sessionID: input.sessionID, action: input.action,
                ruleIDs: mode === "yolo" ? [] : [...result.ruleIDs], decision: "allow",
              }).pipe(Effect.onError(() => reservation.releaseUnlocked))
              return { type: "allowed" as const, reservation }
            }
            if (result.decision === "deny") {
              blocked.set(result.rootSessionID, (blocked.get(result.rootSessionID) ?? 0) + 1)
              advanceUnlocked(result.rootSessionID)
              yield* events.publish(Guardrail.Event.Decided, {
                rootSessionID: result.rootSessionID, sessionID: input.sessionID, action: input.action,
                ruleIDs: [...result.ruleIDs], decision: "deny",
              })
              return yield* new BlockedError({
                rootSessionID: result.rootSessionID, sessionID: input.sessionID, action: input.action,
                ruleIDs: [...result.ruleIDs], reason: result.reason ?? "Session guardrail denied this action",
              })
            }
            const deferred = yield* autonomy.isDeferred(result.rootSessionID)
              .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
            if ((result.standard && !result.hardReview && mode === "auto" && !deferred &&
              !Permission.explicitRejected((yield* applicabilityOf(input, result)).prior)) ||
              (yield* SessionReviewFold.consume(database.db, events, input.sessionID, "guardrail", reviewFingerprint(input, result)))) {
              const reservation = yield* reserveActionUnlocked(result.rootSessionID, input.action)
              yield* events.publish(Guardrail.Event.Decided, {
                rootSessionID: result.rootSessionID, sessionID: input.sessionID, action: input.action,
                ruleIDs: [...result.ruleIDs], decision: "allow",
              }).pipe(Effect.onError(() => reservation.releaseUnlocked))
              return { type: "allowed" as const, reservation }
            }
            const review = yield* reserveUnlocked(result.rootSessionID, "review")
            const created = yield* Clock.currentTimeMillis
            const request = new Guardrail.Request({
              id: Guardrail.RequestID.create(), created, rootSessionID: result.rootSessionID, sessionID: input.sessionID,
              action: input.action, resources: [...input.resources], ruleIDs: [...result.ruleIDs],
              reason: result.reason ?? "Session guardrail review required", standard: result.standard,
              ...(result.hardReview ? { hardReview: true } : {}), ...(result.risk ? { risk: result.risk } : {}),
              ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
              ...(input.source === undefined ? {} : { source: input.source }),
            })
            const item: Pending = {
              request, created, review, directories: classification.directories,
              deferred: yield* Deferred.make<void, DeclinedError | DeferredError>(), deferring: deferred || input.defer === true,
              ...(input.source ? { source: input.source } : {}),
            }
            pending.set(request.id, item)
            advanceUnlocked(result.rootSessionID)
            if (!item.deferring) yield* events.publish(Guardrail.Event.Asked, request).pipe(
              Effect.onError(() => Effect.sync(() => removePendingUnlocked(request.id)).pipe(Effect.andThen(review.releaseUnlocked))),
            )
            return { type: "review" as const, item, fingerprint: reviewFingerprint(input, result) }
          }),
        ), (admission) => Effect.gen(function* () {
          if (admission.type === "allowed") return admission.reservation
          const item = admission.item
          if (item.deferring) yield* withRootLock(rootSessionID, Effect.gen(function* () {
            if (pending.get(item.request.id) !== item) return
            if (input.defer) {
              const review = reviewInput(item, { reason: "disabled" })
              const deferred = yield* SessionReviewFold.deferOpen(database.db, events, {
                ...review, origin: { requestID: item.request.id, executor: true },
                payload: { ...review.payload, fingerprint: admission.fingerprint },
              })
              removePendingUnlocked(item.request.id)
              if (deferred.state === "open" && deferred.opened) yield* events.publish(Guardrail.Event.Deferred, {
                rootSessionID, sessionID: input.sessionID, requestID: item.request.id, itemID: deferred.itemID,
              })
              yield* Deferred.fail(item.deferred, deferredError(item.request, deferred.state, deferred.state === "full" ? undefined : deferred.itemID))
              return
            }
            if (!(yield* autonomy.isDeferred(rootSessionID).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(true))))) {
              pending.set(item.request.id, { ...item, deferring: false })
              advanceUnlocked(rootSessionID)
              yield* events.publish(Guardrail.Event.Asked, item.request)
              return
            }
            const opened = yield* openReview(item, { reason: "disabled" }).pipe(Effect.catchTag("SessionReview.FullError", () => Effect.succeed(undefined)))
            removePendingUnlocked(item.request.id)
            if (!opened) {
              yield* Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id,
                message: "This action did not run. The user's review box is full, so this guardrail review was not recorded. Continue independent work and stop when only blocked work remains.",
              }))
              return
            }
            yield* events.publish(Guardrail.Event.Deferred, {
              rootSessionID, sessionID: input.sessionID, requestID: item.request.id, itemID: opened.itemID,
            })
            yield* Deferred.fail(item.deferred, deferredError(item.request, "open", opened.itemID))
          })).pipe(Effect.onError(() => Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))))
          if (!item.request.hardReview) return yield* Deferred.await(item.deferred)
          const remaining = item.created + hardReviewExpiryMinutes * 60_000 - (yield* Clock.currentTimeMillis)
          yield* Deferred.await(item.deferred).pipe(Effect.timeoutOrElse({
            duration: Duration.millis(Math.max(0, remaining)),
            orElse: () => withRootLock(rootSessionID, Effect.suspend(() => {
              const current = pending.get(item.request.id)
              return current === undefined || current.deferring ? Effect.void : closeUnlocked(current, "expired")
            })).pipe(Effect.andThen(Deferred.await(item.deferred))),
          }))
        }), (admission) => admission.type === "allowed" ? Effect.void : locks.withLock(rootSessionID)(
          cancelPendingUnlocked(admission.item.request.id).pipe(Effect.ensuring(admission.item.review.releaseUnlocked)),
        ))
        if (reservation && input.action !== "shell") return reservation
        if (input.action !== "shell") return yield* withRootLock(rootSessionID, reserveActionUnlocked(rootSessionID, input.action))
        return yield* reserveShell(rootSessionID, input.holder)
      }),
    )

    const reply = Effect.fn("SessionGuardrail.reply")(function* (input: ReplyInput) {
      if (!pending.has(input.requestID)) return yield* new RequestNotFoundError({ requestID: input.requestID })
      const rootSessionID = yield* root(input.sessionID)
      return yield* withRootLock(rootSessionID, replyUnlocked(rootSessionID, input))
    })

    const replyUnlocked = (
      rootSessionID: Session.ID,
      input: ReplyInput,
    ) =>
      Effect.gen(function* () {
        const item = pending.get(input.requestID)
        if (!item) return yield* new RequestNotFoundError({ requestID: input.requestID })
        if (item.deferring)
          return yield* new RequestNotFoundError({ requestID: input.requestID })
        if (rootSessionID !== item.request.rootSessionID)
          return yield* new RequestNotFoundError({ requestID: input.requestID })
        if (input.reply !== "reject" && (yield* evaluate({ sessionID: item.request.sessionID,
          action: item.request.action, resources: item.request.resources, metadata: item.request.metadata })).decision === "deny")
          return yield* new RequestNotFoundError({ requestID: input.requestID })
        removePendingUnlocked(input.requestID)
        recordExplicitReply(item.request, input.reply)
        const reply = item.request.hardReview && input.reply === "always" ? "reject" : input.reply
        yield* events
          .publish(Guardrail.Event.Replied, {
            rootSessionID: item.request.rootSessionID,
            sessionID: item.request.sessionID,
            requestID: item.request.id,
            reply,
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
        if (reply === "reject") {
          yield* ModelIncident.recordRejection(database.db, { ...rejection, decidedBy: "client", time }).pipe(
            Effect.onError(() => Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))),
          )
          yield* Deferred.fail(item.deferred, new DeclinedError({
            requestID: item.request.id,
            message: "Guardrail request was rejected. This action did not run.",
          }))
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
      })

    const closeUnlocked = (item: Pending, reason: Guardrail.ClosedReason) => {
      const rootSessionID = item.request.rootSessionID
      removePendingUnlocked(item.request.id)
      return Effect.all([
        events.publish(Guardrail.Event.Cancelled, { rootSessionID, sessionID: item.request.sessionID, requestID: item.request.id, reason }),
        events.publish(SessionEvent.GuardrailDecided, {
          sessionID: rootSessionID,
          reviewSessionID: item.request.sessionID,
          requestID: item.request.id,
          reply: "reject",
          reason,
          ruleIDs: [...item.request.ruleIDs],
          ...(item.source ? { source: item.source } : {}),
        }),
      ], { discard: true }).pipe(Effect.ensuring(Deferred.fail(item.deferred, new DeclinedError({
        requestID: item.request.id,
        message: reason === "expired"
          ? `Guardrail review expired after ${hardReviewExpiryMinutes} minutes without a decision. This action did not run.`
          : "Guardrail review was cancelled. This action did not run.",
      })).pipe(Effect.andThen(item.review.releaseUnlocked))))
    }

    const pendingFor = (rootSessionID: Session.ID, input: RequestInput) => {
      const item = pending.get(input.requestID)
      return item === undefined || item.deferring || item.request.rootSessionID !== rootSessionID
        ? Effect.fail(new RequestNotFoundError({ requestID: input.requestID }))
        : Effect.succeed(item)
    }

    const cancel = Effect.fn("SessionGuardrail.cancel")(function* (input: RequestInput) {
      if (!pending.has(input.requestID)) return yield* new RequestNotFoundError({ requestID: input.requestID })
      const rootSessionID = yield* root(input.sessionID)
      return yield* withRootLock(rootSessionID, Effect.gen(function* () {
        yield* closeUnlocked(yield* pendingFor(rootSessionID, input), "cancelled")
      }))
    })

    const retry = Effect.fn("SessionGuardrail.retry")(function* (input: RequestInput) {
      if (!pending.has(input.requestID)) return yield* new RequestNotFoundError({ requestID: input.requestID })
      const rootSessionID = yield* root(input.sessionID)
      return yield* withRootLock(rootSessionID, Effect.gen(function* () {
        const item = yield* pendingFor(rootSessionID, input)
        yield* events.publish(Guardrail.Event.Asked, item.request)
        return item.request
      }))
    })

    const delegatedGate = (item: Pending, reply: "once" | "reject") =>
      !item.deferring && item.request.standard && item.request.hardReview !== true && item.request.ruleIDs.every((rule) => rule.startsWith("standard.")) &&
      (reply === "reject" || !rejections.has(`${item.request.sessionID}\0${requestFingerprint(item.request)}`))
    const delegatedEligible = Effect.fn("SessionGuardrail.delegatedEligible")(function* (input: { readonly sessionID: Session.ID; readonly requestID: Guardrail.RequestID; readonly fingerprint: string; readonly reply: "once" | "reject" }) {
      const rootSessionID = yield* root(input.sessionID)
      return yield* withRootLock(rootSessionID, Effect.sync(() => {
        const item = pending.get(input.requestID)
        return item !== undefined && item.request.rootSessionID === rootSessionID && item.request.sessionID === input.sessionID &&
          requestFingerprint(item.request) === input.fingerprint && delegatedGate(item, input.reply)
      }))
    })
    const replyDelegated = Effect.fn("SessionGuardrail.replyDelegated")(function* (input: DelegatedReplyInput) {
      if (!pending.has(input.requestID)) return yield* new RequestNotFoundError({ requestID: input.requestID })
      const rootSessionID = yield* root(input.sessionID)
      return yield* withRootLock(rootSessionID, Effect.gen(function* () {
        const item = pending.get(input.requestID)
        const eligible = Effect.gen(function* () {
          if (!item || pending.get(input.requestID) !== item || requestFingerprint(item.request) !== input.fingerprint) return false
          if (!input.explicitDecision && !delegatedGate(item, input.reply)) return false
          if (item.deferring) return false
          if (input.reply === "reject") return true
          const current = yield* evaluate({ sessionID: item.request.sessionID, action: item.request.action, resources: item.request.resources, metadata: item.request.metadata })
          if (current.decision === "deny") return false
          if (!input.explicitDecision && (current.hardReview || (current.decision !== "allow" && !current.standard))) return false
          return current.decision === "allow" || current.ruleIDs.toSorted().join("\0") === item.request.ruleIDs.toSorted().join("\0")
        })
        if (!item || rootSessionID !== item.request.rootSessionID || item.request.sessionID !== input.sessionID ||
          !(yield* eligible) || !(yield* input.validate(item.request)))
          return yield* new RequestNotFoundError({ requestID: input.requestID })
        const time = yield* Clock.currentTimeMillis
        const committed = yield* events.publishBatch([{ definition: SessionEvent.DotsDecisionSettled, data: {
          sessionID: item.request.sessionID,
          source: input.source,
          target: { kind: "guardrail", requestID: item.request.id, fingerprint: input.fingerprint },
          reply: input.reply,
        }, options: input.explicitDecision && input.reply === "reject" ? { commit: () => ModelIncident.recordRejection(database.db, {
          sessionID: item.request.sessionID, requestID: item.request.id, ruleIDs: [...item.request.ruleIDs],
          ...(item.source ? { messageID: item.source.messageID } : {}), hardReview: item.request.hardReview ?? false, decidedBy: "client", time,
        }) } : undefined }], { when: Effect.gen(function* () { return (yield* eligible) && (yield* input.validate(item.request)) }).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false))) })
        if (committed.length === 0) return yield* new RequestNotFoundError({ requestID: input.requestID })
        if (input.explicitDecision) recordExplicitReply(item.request, input.reply)
        removePendingUnlocked(input.requestID)
        yield* events.publish(Guardrail.Event.Replied, { rootSessionID: item.request.rootSessionID, sessionID: item.request.sessionID, requestID: item.request.id, reply: input.reply }).pipe(Effect.ensuring(Effect.gen(function* () {
          if (input.reply === "reject") {
            yield* Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id, message: "Guardrail request was rejected. This action did not run." }))
            return
          }
          approvals.set(item.request.rootSessionID, (approvals.get(item.request.rootSessionID) ?? 0) + 1)
          advanceUnlocked(item.request.rootSessionID)
          yield* Deferred.succeed(item.deferred, undefined)
        })))
        return yield* Effect.void
      }))
    })

    const requestSnapshot = Effect.fn("SessionGuardrail.requestSnapshot")(function* (
      sessionID: Session.ID,
      requestID: Guardrail.RequestID,
      family?: ReadonlyArray<Session.ID>,
    ) {
      const rootSessionID = yield* root(sessionID)
      const sessions = family ?? [sessionID]
      return yield* withRootLock(
        rootSessionID,
        Effect.sync(() => {
          const item = pending.get(requestID)
          return item === undefined || item.request.rootSessionID !== rootSessionID || !sessions.includes(item.request.sessionID)
            ? undefined
            : { request: item.request, fingerprint: requestFingerprint(item.request) }
        }),
      )
    })

    const requestSnapshots = Effect.fn("SessionGuardrail.requestSnapshots")(function* (sessionID: Session.ID, family?: ReadonlyArray<Session.ID>) {
      const rootSessionID = yield* root(sessionID)
      const sessions = family ?? [sessionID]
      return yield* withRootLock(
        rootSessionID,
        Effect.sync(() =>
          Array.from(pending.values())
            .filter(
              (item) =>
                item.request.rootSessionID === rootSessionID && sessions.includes(item.request.sessionID) && !item.deferring,
            )
            .slice(0, 50)
            .map((item) => ({ request: item.request, fingerprint: requestFingerprint(item.request) })),
        ),
      )
    })

    const reconsider = Effect.fn("SessionGuardrail.reconsider")((input: ReconsiderInput) =>
      Effect.gen(function* () {
        const rootSessionID = yield* root(input.sessionID)
        return yield* Effect.acquireUseRelease(
          withRootLock(
            rootSessionID,
            Effect.sync((): { readonly item?: Pending; readonly result?: ReconsiderResult } => {
              const item = pending.get(input.requestID)
              if (
                item === undefined ||
                item.request.rootSessionID !== rootSessionID ||
                item.request.sessionID !== input.sessionID ||
                requestFingerprint(item.request) !== input.fingerprint
              )
                return { result: { outcome: "stale", requestID: input.requestID, fingerprint: input.fingerprint, settled: false } }
              if (item.deferring || reconsidering.has(input.requestID))
                return {
                  result: {
                    outcome: "escalated",
                    requestID: input.requestID,
                    fingerprint: input.fingerprint,
                    settled: false,
                    reason: "native-assessment-in-progress",
                  },
                }
              reconsidering.add(input.requestID)
              return { item }
            }),
          ),
          (acquired) =>
            acquired.item === undefined
              ? Effect.succeed(acquired.result!)
              : Effect.uninterruptible(
                  Effect.gen(function* () {
                    const item = acquired.item!
                    if ((yield* DecisionChoice.decisionMode(autonomy, rootSessionID, "guardrails")) === "yolo") {
                      yield* reconcileAutonomy(item.request.sessionID)
                      return { requestID: input.requestID, fingerprint: input.fingerprint, outcome: "allowed" as const, settled: true, via: "yolo" as const }
                    }
                    const base = { requestID: input.requestID, fingerprint: input.fingerprint }
                    if (input.decision === undefined && (item.request.hardReview === true || item.request.ruleIDs.includes("configuration.invalid")))
                      return { ...base, outcome: "escalated" as const, settled: false, reason: "explicit-decision:hard-review" }
                    if (input.decision === "approve" && item.request.ruleIDs.includes("configuration.invalid"))
                      return { ...base, outcome: "escalated" as const, settled: false, reason: "configuration-invalid" }
                    if (!(yield* input.validate(item.request)))
                      return { ...base, outcome: "escalated" as const, settled: false, reason: "delegation-invalid" }
                    const evaluateInput: EvaluateInput = {
                      sessionID: item.request.sessionID,
                      action: item.request.action,
                      resources: item.request.resources,
                      metadata: item.request.metadata,
                      ...(item.source ? { source: item.source } : {}),
                    }
                    if (input.decision === "decline")
                      return yield* withRootLock(
                        rootSessionID,
                        Effect.gen(function* () {
                          if (pending.get(input.requestID) !== item) return { ...base, outcome: "stale" as const, settled: false }
                          if (!(yield* input.validate(item.request)))
                            return { ...base, outcome: "escalated" as const, settled: false, reason: "delegation-invalid" }
                          removePendingUnlocked(input.requestID)
                          yield* events.publish(Guardrail.Event.Replied, {
                            rootSessionID,
                            sessionID: item.request.sessionID,
                            requestID: item.request.id,
                            reply: "reject",
                          })
                          yield* events.publish(SessionEvent.GuardrailDecided, {
                            sessionID: rootSessionID,
                            reviewSessionID: item.request.sessionID,
                            requestID: item.request.id,
                            reply: "reject",
                            ruleIDs: [...item.request.ruleIDs],
                            ...(item.source ? { source: item.source } : {}),
                            actor: "coordinator",
                            coordinatorSessionID: input.source.coordinatorSessionID,
                            ...(input.source.groupID === undefined ? {} : { groupID: input.source.groupID }),
                            rationale: input.source.rationale,
                          })
                          yield* Deferred.fail(item.deferred, new DeclinedError({
                            requestID: item.request.id,
                            message: Permission.coordinationDeclineFeedback("guardrail", input.source.rationale),
                          }))
                          return { ...base, outcome: "denied" as const, settled: true, via: "coordination" as const }
                        }),
                      )
                    const settleRulesUnlocked = (decision: "allow" | "deny", ruleIDs: ReadonlyArray<string>) =>
                      Effect.gen(function* () {
                        removePendingUnlocked(input.requestID)
                        if (decision === "deny") {
                          blocked.set(rootSessionID, (blocked.get(rootSessionID) ?? 0) + 1)
                          advanceUnlocked(rootSessionID)
                        }
                        yield* events.publish(Guardrail.Event.Decided, {
                          rootSessionID,
                          sessionID: item.request.sessionID,
                          action: item.request.action,
                          ruleIDs: [...ruleIDs],
                          decision,
                        })
                        yield* events.publish(Guardrail.Event.Replied, {
                          rootSessionID,
                          sessionID: item.request.sessionID,
                          requestID: item.request.id,
                          reply: decision === "allow" ? "once" : "reject",
                        })
                        if (decision === "allow") yield* Deferred.succeed(item.deferred, undefined)
                        else yield* Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))
                        return {
                          ...base,
                          outcome: decision === "allow" ? ("allowed" as const) : ("denied" as const),
                          settled: true,
                          via: "guardrail-rules" as const,
                        }
                      })
                    const settleRules = () =>
                      withRootLock(
                        rootSessionID,
                        Effect.gen(function* () {
                          if (pending.get(input.requestID) !== item) return { ...base, outcome: "stale" as const, settled: false }
                          if (!(yield* input.validate(item.request)))
                            return { ...base, outcome: "escalated" as const, settled: false, reason: "delegation-invalid" }
                          const current = (yield* classify(evaluateInput)).evaluation
                          if (current.decision === "ask" || current.decision === "hard_review")
                            return { ...base, outcome: "escalated" as const, settled: false, reason: "guardrail-ask" }
                          return yield* settleRulesUnlocked(current.decision, current.ruleIDs)
                        }),
                      )
                    const unchanged = (current: Evaluation) =>
                      current.hardReview === (item.request.hardReview ?? false) &&
                      current.standard === item.request.standard &&
                      current.ruleIDs.join("\0") === item.request.ruleIDs.join("\0")
                    const classification = yield* classify(evaluateInput)
                    const result = classification.evaluation
                    if (result.decision !== "ask") return yield* settleRules()
                    if (!unchanged(result)) return { ...base, outcome: "stale" as const, settled: false }
                    if (result.hardReview) return { ...base, outcome: "escalated" as const, settled: false, reason: "explicit-decision:hard-review" }
                    if (!result.standard) return { ...base, outcome: "escalated" as const, settled: false, reason: "explicit-decision:custom-review" }
                    if (input.decision === "approve")
                      return yield* withRootLock(
                        rootSessionID,
                        Effect.gen(function* () {
                          if (pending.get(input.requestID) !== item) return { ...base, outcome: "stale" as const, settled: false }
                          if (!(yield* input.validate(item.request)))
                            return { ...base, outcome: "escalated" as const, settled: false, reason: "delegation-invalid" }
                          const current = (yield* classify(evaluateInput)).evaluation
                          if (current.decision !== "ask" && current.decision !== "hard_review") return yield* settleRulesUnlocked(current.decision, current.ruleIDs)
                          if (!unchanged(current)) return { ...base, outcome: "stale" as const, settled: false }
                          if (current.hardReview) return { ...base, outcome: "escalated" as const, settled: false, reason: "explicit-decision:hard-review" }
                          if (!current.standard) return { ...base, outcome: "escalated" as const, settled: false, reason: "explicit-decision:custom-review" }
                          removePendingUnlocked(input.requestID)
                          yield* events.publish(Guardrail.Event.Decided, {
                            rootSessionID,
                            sessionID: item.request.sessionID,
                            action: item.request.action,
                            ruleIDs: [...current.ruleIDs],
                            decision: "allow",
                          })
                          yield* events.publish(Guardrail.Event.Replied, {
                            rootSessionID,
                            sessionID: item.request.sessionID,
                            requestID: item.request.id,
                            reply: "once",
                          })
                          yield* events.publish(SessionEvent.GuardrailDecided, {
                            sessionID: rootSessionID,
                            reviewSessionID: item.request.sessionID,
                            requestID: item.request.id,
                            reply: "once",
                            ruleIDs: [...item.request.ruleIDs],
                            ...(item.source ? { source: item.source } : {}),
                            actor: "coordinator",
                            coordinatorSessionID: input.source.coordinatorSessionID,
                            ...(input.source.groupID === undefined ? {} : { groupID: input.source.groupID }),
                            rationale: input.source.rationale,
                          })
                          yield* Deferred.succeed(item.deferred, undefined)
                          return { ...base, outcome: "allowed" as const, settled: true, via: "coordination" as const }
                        }),
                      )
                    const mode = yield* DecisionChoice.decisionMode(autonomy, rootSessionID, "guardrails")
                    const deferred = yield* autonomy
                      .isDeferred(rootSessionID)
                      .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
                    if (mode === "auto" && !deferred) {
                      return yield* withRootLock(
                        rootSessionID,
                        Effect.gen(function* () {
                          if (pending.get(input.requestID) !== item) return { ...base, outcome: "stale" as const, settled: false }
                          if (!(yield* input.validate(item.request)))
                            return { ...base, outcome: "escalated" as const, settled: false, reason: "delegation-invalid" }
                          const current = yield* evaluate(evaluateInput)
                          if (current.decision !== "ask" || current.hardReview || !current.standard ||
                            current.ruleIDs.toSorted().join("\0") !== item.request.ruleIDs.toSorted().join("\0"))
                            return { ...base, outcome: "stale" as const, settled: false }
                          if (Permission.explicitRejected((yield* applicabilityOf(evaluateInput, current)).prior))
                            return { ...base, outcome: "escalated" as const, settled: false, reason: "explicit-rejected" }
                          removePendingUnlocked(input.requestID)
                          yield* events.publish(Guardrail.Event.Decided, {
                            rootSessionID,
                            sessionID: item.request.sessionID,
                            action: item.request.action,
                            ruleIDs: [...result.ruleIDs],
                            decision: "allow",
                          })
                          yield* events.publish(Guardrail.Event.Replied, {
                            rootSessionID,
                            sessionID: item.request.sessionID,
                            requestID: item.request.id,
                            reply: "once",
                          })
                          yield* events.publish(SessionEvent.GuardrailDecided, {
                            sessionID: rootSessionID,
                            reviewSessionID: item.request.sessionID,
                            requestID: item.request.id,
                            reply: "once",
                            ruleIDs: [...item.request.ruleIDs],
                            ...(item.source ? { source: item.source } : {}),
                            actor: "coordinator",
                            coordinatorSessionID: input.source.coordinatorSessionID,
                            ...(input.source.groupID === undefined ? {} : { groupID: input.source.groupID }),
                            rationale: input.source.rationale,
                          })
                          yield* Deferred.succeed(item.deferred, undefined)
                          return { ...base, outcome: "allowed" as const, settled: true, via: "auto-guardrail" as const }
                        }),
                      )
                    }

                    return { ...base, outcome: "escalated" as const, settled: false, reason: "native-assessment-unavailable" }
                  }),
                ),
          (acquired) =>
            Effect.sync(() => {
              if (acquired.item !== undefined) reconsidering.delete(input.requestID)
            }),
        )
      }),
    )

    const escalate = Effect.fn("SessionGuardrail.escalate")(function* (input: EscalateInput) {
      const rootSessionID = yield* root(input.sessionID)
      return yield* withRootLock(
        rootSessionID,
        Effect.uninterruptible(
          Effect.gen(function* () {
            const item = pending.get(input.requestID)
            if (item === undefined) {
              const review = yield* CoordinationEscalation.deferredItem(database.db, { ...input, type: "guardrail" })
              if (review === undefined || review.payload.type !== "guardrail") return CoordinationEscalation.result(input.requestID, input)
              return CoordinationEscalation.deferred(input.requestID, input, { itemID: review.itemID, coordinationEscalation: review.payload.coordinationEscalation })
            }
            if (
              item.request.rootSessionID !== rootSessionID ||
              item.request.sessionID !== input.sessionID ||
              requestFingerprint(item.request) !== input.fingerprint
            )
              return CoordinationEscalation.result(input.requestID, input)
            const appended = CoordinationEscalation.append(item.request.coordinationEscalation, input.source)
            if (appended.type !== "appended") return CoordinationEscalation.result(input.requestID, input, appended)
            item.request = new Guardrail.Request({ ...item.request, coordinationEscalation: appended.value })
            yield* events.publish(Coordination.Event.RequestEscalated, {
              sessionID: item.request.sessionID,
              rootSessionID,
              kind: "review",
              requestID: item.request.id,
              coordinationEscalation: appended.value,
            })
            return CoordinationEscalation.result(input.requestID, input, appended)
          }),
        ),
      )
    })

    const forSession = Effect.fn("SessionGuardrail.forSession")(function* (sessionID: Session.ID) {
      const rootSessionID = yield* root(sessionID)
      return yield* withRootLock(
        rootSessionID,
        Effect.sync(() =>
          Array.from(pending.values(), (item) => item.request).filter(
            (request) => request.rootSessionID === rootSessionID && !pending.get(request.id)?.deferring,
          ),
        ),
      )
    })

    const list = Effect.fn("SessionGuardrail.list")(function* () {
      return Array.from(pending.values()).filter((item) => !item.deferring).map((item) => item.request)
    })

    const reconcileAutonomy = Effect.fn("SessionGuardrail.reconcileAutonomy")(function* (sessionID: Session.ID) {
      const rootSessionID = yield* root(sessionID)
      yield* withRootLock(rootSessionID, Effect.gen(function* () {
        if ((yield* DecisionChoice.decisionMode(autonomy, rootSessionID, "guardrails")) !== "yolo") return
        for (const item of pending.values()) {
          if (item.request.sessionID !== sessionID) continue
          removePendingUnlocked(item.request.id)
          yield* Effect.gen(function* () {
            yield* events.publish(Guardrail.Event.Decided, {
              rootSessionID, sessionID, action: item.request.action, ruleIDs: [], decision: "allow",
            })
            yield* events.publish(Guardrail.Event.Replied, {
              rootSessionID, sessionID, requestID: item.request.id, reply: "once", authority: "yolo",
            })
            yield* events.publish(SessionEvent.GuardrailDecided, {
              sessionID: rootSessionID, reviewSessionID: sessionID, requestID: item.request.id,
              reply: "once", authority: "yolo", ruleIDs: [...item.request.ruleIDs],
              ...(item.source ? { source: item.source } : {}),
            })
          }).pipe(Effect.onError(() => Deferred.fail(item.deferred, new DeclinedError({ requestID: item.request.id }))),
            Effect.ensuring(item.review.releaseUnlocked))
          approvals.set(rootSessionID, (approvals.get(rootSessionID) ?? 0) + 1)
          advanceUnlocked(rootSessionID)
          yield* Deferred.succeed(item.deferred, undefined)
        }
        yield* SessionReviewFold.withFamilyLock(rootSessionID)(Effect.gen(function* () {
          for (const item of yield* SessionReviewFold.fold(database.db, [sessionID])) {
            if (item.kind !== "guardrail" || item.withdrawn !== undefined || item.consumed) continue
            yield* SessionReviewFold.withdrawItem(events, sessionID, item.itemID, "autonomy")
          }
        }))
      }))
    })

    const deferPending = Effect.fn("SessionGuardrail.deferPending")(function* (sessionID: Session.ID) {
      const requests = yield* forSession(sessionID)
      const rootSessionID = yield* root(sessionID)
      yield* withRootLock(rootSessionID, Effect.forEach(requests, (request) =>
        Effect.gen(function* () {
          const item = pending.get(request.id)
          if (!item || item.deferring) return
          const opened = yield* openReview(item, {
            reason: request.escalation?.reason ?? "defer_entry",
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
          yield* Deferred.fail(item.deferred, deferredError(request, "open", opened.itemID))
          yield* item.review.releaseUnlocked
        }), { discard: true }))
    })

    const observation = observe(authority, Effect.gen(function* () { return { settings, documents: yield* documents() } }))
    const statusUnlocked = observation.statusUnlocked
    const withSnapshot = observation.withSnapshot

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
                    { sessionID: data.reviewSessionID, created: row.created, requestID: data.requestID, reply: data.reply, authority: data.authority, choice: data.choice, confidence: data.confidence, grades: data.grades, ruleIDs: data.ruleIDs, source: data.source, reason: data.reason },
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

    return Service.of({ reviewPolicy, evaluate, assert, reply: (input) => reply(input), cancel, retry, replyDelegated, delegatedEligible, requestSnapshot, reconsider, escalate, requestSnapshots, reconcileAutonomy, deferPending, forSession, list, status, snapshot, withSnapshot })
  }),
).pipe(Layer.provide(authorityLayer))

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
    authorityNode,
  ],
})

export const observationNode = makeLocationNode({
  service: Observation,
  layer: Layer.effect(Observation, Effect.map(Service, (guardrails) => Observation.of({
    snapshot: guardrails.snapshot,
    withSnapshot: (sessionID, use) => guardrails.withSnapshot(sessionID, (snapshot) => use(snapshot, Effect.void)),
  }))),
  deps: [node],
})

export const standaloneObservationNode = makeLocationNode({
  service: Observation,
  layer: Layer.effect(Observation, Effect.gen(function* () {
    const authority = yield* Authority
    const config = yield* StandaloneConfig.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const unavailable = () => new SessionErrors.ScopeUnavailableError({ operation: "global guardrail policy" })
    const withSnapshot: ObservationInterface["withSnapshot"] = (sessionID, use) => Effect.gen(function* () {
      const current = yield* config.snapshot().pipe(Effect.mapError(unavailable))
      return yield* config.withCurrent(current.generation, (validate) => {
        const valid = validate.pipe(Effect.mapError(unavailable))
        const policy = Effect.gen(function* () {
          const documents = yield* loadStandaloneDocuments(fs, global.config)
          yield* valid
          return { settings: Config.latest(current.entries, "guardrails"), documents }
        })
        return observe(authority, policy).withSnapshot(sessionID, (snapshot) => use(snapshot, valid))
      }).pipe(Effect.mapError((error) => error instanceof StandaloneConfig.InvalidError ? unavailable() : error))
    })
    return Observation.of({ snapshot: (sessionID) => withSnapshot(sessionID, Effect.succeed), withSnapshot })
  })),
  deps: [authorityNode, StandaloneConfig.node, FSUtil.node, Global.node],
})
