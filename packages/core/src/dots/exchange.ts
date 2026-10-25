export * as DotsExchange from "./exchange"

import { Dots } from "@ycoding-ai/schema/dots"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm"
import { Cause, Clock, Deferred, Effect, Schema } from "effect"
import { CoordinationService } from "../coordination/index"
import { Database } from "../database/database"
import { DotsRuntime } from "../dots"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import { SessionMcpEvents } from "../mcp-events/index"
import { Session } from "../session"
import { SessionEvent } from "../session/event"
import { SessionExecution } from "../session/execution"
import { SessionMessage } from "../session/message"
import { SessionPending } from "../session/pending"
import { SessionMessageTable, SessionPendingTable, SessionProviderRequestTable } from "../session/sql"
import { Permission } from "../permission"
import { Hash } from "../util/hash"

const lock = KeyedMutex.makeUnsafe<string>()
const createdType = EventRuntime.versionedType(SessionEvent.DotsExchangeCreated.type, 1)
const promotedType = EventRuntime.versionedType(SessionEvent.InputPromoted.type, 1)
const completedType = EventRuntime.versionedType(SessionEvent.Work.Completed.type, 1)
const fail = (code: Dots.ErrorCode, message: string) => new DotsRuntime.Error({ code, message })
const identity = (target: Dots.Target) => [target.profile, target.dotID, target.threadID, target.generation]
const recordID = (sessionID: Session.ID, exchangeID: string) => EventRuntime.ID.make(`evt_dots_${Hash.json([sessionID, exchangeID])}`)

export interface Options {
  readonly db: Database.Interface["db"]
  readonly events: EventRuntime.Interface
  readonly sessions: Pick<Session.Interface, "get" | "message">
  readonly coordination: CoordinationService.Interface
  readonly execution: Pick<SessionExecution.Interface, "wake" | "active">
  readonly attachment: DotsRuntime.Interface["attachment"]
  readonly authorize: (source: McpEvents.RequestContext) => Effect.Effect<McpEvents.Principal, unknown>
  readonly checkStored: (principal: McpEvents.Principal) => Effect.Effect<{ readonly expiresAt: number; readonly signal?: AbortSignal }, unknown>
  readonly withBinding: DotsRuntime.Interface["withBinding"]
  readonly approve: (input: Permission.AssertInput) => Effect.Effect<void, DotsRuntime.Error>
  readonly now: () => number
}

export function make(options: Options) {
  const authorize = (source: McpEvents.RequestContext) => options.authorize(source).pipe(
    Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(fail("authorization_failed", "The remote invocation is not authorized."))),
    Effect.flatMap((principal) => Schema.is(McpEvents.Principal)(principal) &&
      principal.epoch === source.epoch && Hash.json({ ownerID: principal.ownerID, deviceID: principal.deviceID, clientID: principal.clientID }) === Hash.json(source.principal)
      ? Effect.succeed(principal)
      : Effect.fail(fail("authorization_failed", "The resolved coordinator does not match the remote invocation."))),
  )
  const scope = Effect.fn("DotsExchange.scope")(function* (sessionID: Session.ID, targetID: Session.ID) {
    const anchor = yield* options.sessions.get(sessionID).pipe(Effect.mapError(() => fail("session_not_found", "The attachment Session does not exist.")))
    if (anchor.time.archived !== undefined) return yield* fail("target_forbidden", "The attachment Session is archived.")
    if (anchor.parentID !== undefined) return yield* fail("target_forbidden", "The attachment must be a root Session.")
    const chain = [yield* options.sessions.get(targetID).pipe(Effect.mapError(() => fail("session_not_found", "The target Session does not exist.")))]
    if (chain[0].time.archived !== undefined) return yield* fail("target_forbidden", "The target Session is archived.")
    if (chain[0].parentID !== undefined && chain[0].agent !== "btw")
      return yield* fail("target_forbidden", "Managed subagents accept input only from their native parent Session.")
    while (chain.at(-1)!.parentID !== undefined) {
      const child = chain.at(-1)!
      const parentID = child.parentID!
      if (chain.length >= 64 || chain.some((entry) => entry.id === parentID)) return yield* fail("target_forbidden", "The target family is invalid.")
      chain.push(yield* options.sessions.get(parentID).pipe(Effect.mapError(() => fail("target_forbidden", "The target owner is unavailable."))))
      if (chain.at(-1)!.time.archived !== undefined) return yield* fail("target_forbidden", "The target family contains an archived Session.")
    }
    const root = chain.at(-1)!
    const owner = yield* options.coordination.accessOf(root.id)
    return {
      rootSessionID: root.id,
      ...(owner === undefined ? {} : { groupID: owner.scope.groupID, ownerSessionID: owner.ownerSessionID ?? owner.scope.masterSessionID }),
    }
  })

  const record = Effect.fn("DotsExchange.record")(function* (sessionID: Session.ID, exchangeID: string) {
    const row = yield* options.db.select({ data: EventTable.data }).from(EventTable)
      .where(and(eq(EventTable.id, recordID(sessionID, exchangeID)), eq(EventTable.type, createdType))).get().pipe(Effect.orDie)
    return row ? Schema.decodeUnknownSync(Dots.ExchangeRecord)(row.data) : undefined
  })

  const checkFences = Effect.fn("DotsExchange.checkFences")(function* (value: Dots.ExchangeRecord, source: McpEvents.RequestContext) {
    if (Hash.json(value.source.principal) !== Hash.json(source.principal) || value.source.epoch !== source.epoch)
      return yield* fail("authorization_failed", "The exchange belongs to another coordinator or authorization generation.")
    const attachment = yield* options.attachment(value.sessionID)
    if (attachment.accountDigest !== value.accountDigest || Hash.json(identity(attachment.target)) !== Hash.json(identity(value.expectedAttachment)))
      return yield* fail("target_changed", "The exchange attachment changed; it cannot be redirected.")
    const current = yield* scope(value.sessionID, value.targetSessionID)
    if (Hash.json(current) !== Hash.json(value.scope)) return yield* fail("target_forbidden", "The exchange's native ownership changed.")
    return undefined
  })

  const validate = Effect.fn("DotsExchange.validate")(function* (value: Dots.ExchangeRecord, source: McpEvents.RequestContext) {
    yield* checkFences(value, source)
    const principal = yield* authorize(source)
    if (principal.grantID !== value.grantID) return yield* fail("authorization_failed", "The exchange grant changed.")
    yield* checkFences(value, source)
    return undefined
  })

  const task = Effect.fn("DotsExchange.nativeTask")(function* (sessionID: Session.ID) {
    const messages = yield* options.db.select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq, data: SessionMessageTable.data }).from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user"), sql`json_extract(${SessionMessageTable.data}, '$.metadata.inputOrigin') = 'human'`))
      .orderBy(desc(SessionMessageTable.seq)).limit(1).all().pipe(Effect.orDie)
    const pending = (yield* SessionPending.list(options.db, sessionID)).filter((entry) => entry.type === "user" && entry.data.metadata?.inputOrigin === "human")
    const admitted = pending.length && messages[0] ? yield* options.db.select({ seq: EventTable.seq }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, EventRuntime.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version)),
      sql`json_extract(${EventTable.data}, '$.inputID') = ${messages[0].id}`,
    )).limit(1).get().pipe(Effect.orDie) : undefined
    const latest = [...messages.map((row) => ({ id: row.id, seq: admitted?.seq ?? row.seq, data: Schema.decodeUnknownSync(SessionMessage.User)({ ...row.data, id: row.id, type: "user" }), queued: false, promotedSeq: row.seq })),
      ...pending.filter((entry): entry is SessionPending.User => entry.type === "user").map((entry) => ({ id: entry.id, seq: entry.admittedSeq, data: entry.data, queued: entry.delivery === "queue", promotedSeq: undefined }))]
      .sort((a, b) => b.seq - a.seq)[0]
    if (!latest || latest.queued || typeof latest.data.text !== "string" || !latest.data.text.trim())
      return yield* fail("target_forbidden", "Select an existing current native human task.")
    const completion = latest.promotedSeq !== undefined ? yield* options.db.select({ id: EventTable.id }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, completedType), gt(EventTable.seq, latest.promotedSeq),
    )).limit(1).get().pipe(Effect.orDie) : undefined
    if (completion) return yield* fail("target_forbidden", "The native human task has completed.")
    const revert = yield* options.db.select({ id: EventTable.id }).from(EventTable).where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, EventRuntime.versionedType(SessionEvent.RevertEvent.Committed.type, 1))))
      .orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    return { taskInputID: latest.id, text: latest.data.text, fence: Hash.json([latest.id, latest.data.text, latest.data.files, revert?.id]) }
  })
  const nativeFence = Effect.fn("DotsExchange.nativeFence")(function* (sessionID: Session.ID, targetID: Session.ID) {
    const current = yield* scope(sessionID, targetID)
    if (current.rootSessionID !== targetID) return yield* fail("target_forbidden", "Routine delegation targets a root Session only.")
    const changed = yield* options.db.select({ id: EventTable.id }).from(EventTable).where(and(
      sql`${EventTable.type} LIKE 'coordination.%'`,
      sql`(${EventTable.aggregate_id} = ${current.groupID ?? ""} OR json_extract(${EventTable.data}, '$.sessionID') = ${targetID} OR json_extract(${EventTable.data}, '$.masterSessionID') = ${targetID} OR EXISTS (SELECT 1 FROM json_each(json_extract(${EventTable.data}, '$.memberSessionIDs')) WHERE value = ${targetID}))`,
    )).orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    return { nativeScope: current, ownerFence: Hash.json(changed?.id ?? null) }
  })
  const owned = <A, E, R>(current: Dots.ExchangeRecord["scope"], effect: Effect.Effect<A, E, R>) =>
    current.groupID === undefined ? effect : options.coordination.withOwnership(Coordination.GroupID.make(current.groupID), effect)
  const localGrant = Effect.fn("DotsExchange.localGrant")(function* (binding: DotsRuntime.BindingAuthority, grant: DotsRuntime.DelegationGrant) {
    if (!grant.info.active || grant.info.expiresAt <= options.now() || grant.bindingID !== binding.incarnation ||
      grant.accountDigest !== binding.accountDigest || Hash.json(identity(grant.target)) !== Hash.json(identity(binding.target)))
      return yield* fail("authorization_failed", "The routine delegation is inactive or its binding changed.")
    const current = yield* nativeFence(grant.anchorSessionID, grant.info.targetSessionID)
    const selected = yield* task(grant.info.targetSessionID)
    if (selected.taskInputID !== grant.info.taskInputID || selected.fence !== grant.taskFence || current.ownerFence !== grant.ownerFence || Hash.json(current.nativeScope) !== Hash.json(grant.nativeScope))
      return yield* fail("target_forbidden", "The native task or ownership incarnation changed.")
    return grant
  })
  const checkedPrincipal = (principal: McpEvents.Principal) => options.checkStored(principal).pipe(Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(fail("authorization_failed", "The coordinator grant is unavailable."))))
  const liveAuthorization = (checked: { readonly expiresAt: number; readonly signal?: AbortSignal }) =>
    checked.expiresAt > options.now() && checked.signal?.aborted !== true
  const routineGrant = Effect.fn("DotsExchange.routineGrant")(function* (binding: DotsRuntime.BindingAuthority, value: Dots.RoutineReceipt, principal: McpEvents.Principal, targetSessionID: Session.ID) {
    const grant = binding.grants.get(value.delegation.id)
    if (!grant || grant.info.revision !== value.delegation.revision || grant.info.taskInputID !== value.taskInputID || grant.info.targetSessionID !== targetSessionID || Hash.json(grant.info.principal) !== Hash.json(principal))
      return yield* fail("authorization_failed", "The routine delegation does not match this authenticated task.")
    if (!grant.info.scope.operations.includes(value.instruction.operation) || (value.instruction.operation === "presentation" &&
      ((value.instruction.preferences.format !== undefined && !grant.info.scope.format?.includes(value.instruction.preferences.format)) ||
       (value.instruction.preferences.detail !== undefined && !grant.info.scope.detail?.includes(value.instruction.preferences.detail)))))
      return yield* fail("target_forbidden", "The routine operation is outside the approved scope.")
    return yield* localGrant(binding, grant)
  })
  const delegationCreate = Effect.fn("DotsExchange.delegationCreate")(function* (input: Dots.DelegationCreate & { readonly sessionID: Session.ID }) {
    const { sessionID, ...raw } = input
    const payload = yield* Schema.decodeUnknownEffect(Dots.DelegationCreate)(raw).pipe(Effect.mapError(() => fail("invalid_input", "Invalid native delegation proposal.")))
    const source = yield* record(sessionID, payload.sourceExchangeID)
    if (!source || source.targetSessionID !== payload.targetSessionID) return yield* fail("target_forbidden", "Select an authenticated exchange for this exact target.")
    const principal = { ...source.source.principal, epoch: source.source.epoch, grantID: source.grantID }
    yield* checkedPrincipal(principal)
    yield* checkFences(source, source.source)
    const selected = yield* task(payload.targetSessionID)
    if (selected.taskInputID !== payload.taskInputID) return yield* fail("target_forbidden", "The selected input is not the current native human task.")
    const current = yield* nativeFence(sessionID, payload.targetSessionID)
    const proposal = yield* options.withBinding(sessionID, (binding) => Effect.gen(function* () {
      if (Hash.json(identity(binding.target)) !== Hash.json(identity(payload.expectedAttachment))) return yield* fail("target_changed", "The attachment changed.")
      const fingerprint = Hash.json([{ ...payload, expectedAttachment: identity(payload.expectedAttachment) }, binding.incarnation, binding.accountDigest, principal, selected.fence, current])
      const existing = binding.proposals.get(payload.proposalID)
      if (existing) {
        if (existing.fingerprint !== fingerprint) return yield* fail("exchange_conflict", "The proposal ID already names another scope.")
        return { owner: false, pending: existing, bindingID: binding.incarnation, accountDigest: binding.accountDigest }
      }
      if (payload.expiresAt <= options.now() || payload.expiresAt > options.now() + 3_600_000) return yield* fail("invalid_input", "Delegation expiry must be within the next hour.")
      const pending = { fingerprint, result: Deferred.makeUnsafe<Dots.DelegationInfo, DotsRuntime.Error>() }
      binding.proposals.set(payload.proposalID, pending)
      return { owner: true, pending, bindingID: binding.incarnation, accountDigest: binding.accountDigest }
    }))
    if (!proposal.owner) {
      const prior = yield* Deferred.await(proposal.pending.result)
      return yield* options.withBinding(sessionID, (binding) => Effect.gen(function* () {
        const grant = binding.grants.get(prior.id)
        if (!grant) return yield* fail("authorization_failed", "The delegation is unavailable.")
        yield* localGrant(binding, grant)
        return grant.info
      }))
    }
    const activate = Effect.gen(function* () {
      yield* options.approve({ sessionID, action: "dots_delegate", resources: [Hash.json([sessionID, payload.targetSessionID, payload.taskInputID, proposal.pending.fingerprint])], requireHuman: true,
        metadata: Dots.DelegationReview.make({ kind: "dots-task-delegation", proposalID: payload.proposalID, sourceExchangeID: source.exchangeID,
          principal, targetSessionID: payload.targetSessionID, taskInputID: selected.taskInputID, task: selected.text, expectedAttachment: source.expectedAttachment,
          scope: payload.scope, expiresAt: payload.expiresAt, lifetime: "binding", fingerprint: proposal.pending.fingerprint }) })
      const checked = yield* checkedPrincipal(principal)
      yield* checkFences(source, source.source)
      return yield* SessionPending.withInboxLock(payload.targetSessionID)(options.withBinding(sessionID, (binding) => owned(current.nativeScope, Effect.gen(function* () {
        if (!liveAuthorization(checked)) return yield* fail("authorization_failed", "The coordinator grant changed during native approval.")
        const info: Dots.DelegationInfo = { id: payload.proposalID, revision: 1, sourceExchangeID: payload.sourceExchangeID, targetSessionID: payload.targetSessionID,
          taskInputID: selected.taskInputID, principal, scope: payload.scope, expiresAt: payload.expiresAt, active: true }
        const grant: DotsRuntime.DelegationGrant = { info, anchorSessionID: sessionID, bindingID: proposal.bindingID, accountDigest: proposal.accountDigest,
          target: source.expectedAttachment, taskFence: selected.fence, ...current }
        yield* localGrant(binding, grant)
        binding.grants.set(info.id, grant)
        return info
      }))))
    })
    return yield* activate.pipe(Effect.onExit((exit) => Deferred.done(proposal.pending.result, exit)))
  })

  const promoteRoutine: SessionPending.PromotionGuard<DotsRuntime.Error> = (entry, promote) => Effect.gen(function* () {
    const row = yield* options.db.select({ data: EventTable.data }).from(EventTable).where(and(eq(EventTable.type, createdType),
      sql`json_extract(${EventTable.data}, '$.inputID') = ${entry.id}`, sql`json_extract(${EventTable.data}, '$.targetSessionID') = ${entry.sessionID}`)).limit(1).get().pipe(Effect.orDie)
    if (!row) return yield* promote()
    const value = Schema.decodeUnknownSync(Dots.ExchangeRecord)(row.data)
    if (!value.routine) return yield* promote()
    const routine = value.routine
    const principal = { ...value.source.principal, epoch: value.source.epoch, grantID: value.grantID }
    let promoting = false
    const result = yield* checkedPrincipal(principal).pipe(Effect.flatMap((checked) => checkFences(value, value.source).pipe(Effect.andThen(
      options.withBinding(value.sessionID, (binding) => owned(value.scope, Effect.gen(function* () {
        if (!liveAuthorization(checked)) return yield* fail("authorization_failed", "The coordinator grant changed before promotion.")
        yield* routineGrant(binding, routine, principal, value.targetSessionID)
        promoting = true
        return yield* promote(routineGrant(binding, routine, principal, value.targetSessionID).pipe(Effect.match({ onFailure: () => false, onSuccess: () => liveAuthorization(checked) })))
      }))),
    ))), Effect.result)
    if (result._tag === "Success" && result.success) return true
    if (result._tag === "Failure" && promoting) return yield* Effect.fail(result.failure)
    yield* options.events.publish(SessionEvent.DotsInstructionRejected, { sessionID: entry.sessionID, inputID: entry.id, anchorSessionID: value.sessionID,
      exchangeID: value.exchangeID, delegationID: routine.delegation.id, reason: "delegation_invalid" })
    return false
  })

  const taskEnvelope = (value: Dots.ExchangeRecord): Dots.TaskEnvelope => ({
    coordinator: value.source.principal, scope: { epoch: value.source.epoch, grantID: value.grantID },
    exchangeID: value.exchangeID, messageID: value.inputID, kind: "task", origin: "plugin", targetSessionID: value.targetSessionID,
  })

  const output = Effect.fn("DotsExchange.output")(function* (value: Dots.ExchangeRecord, messageID: SessionMessage.ID, kind: "progress" | "completion" = "progress") {
    const message = yield* options.sessions.message({ sessionID: value.targetSessionID, messageID })
    if (message?.type !== "assistant") return undefined
    const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n")
    if (text.trim() === "") return undefined
    return {
      deliveryID: `dots_result_${Hash.json([value.sessionID, value.exchangeID, value.targetSessionID, messageID, kind])}`,
      messageID,
      text,
      envelope: Dots.ReportEnvelope.make({
        coordinator: value.source.principal, scope: { epoch: value.source.epoch, grantID: value.grantID },
        exchangeID: value.exchangeID, messageID, replyToMessageID: value.inputID,
        kind, origin: "agent", sourceSessionID: value.targetSessionID,
      }),
    }
  })

  const project = Effect.fn("DotsExchange.project")(function* (value: Dots.ExchangeRecord): Effect.fn.Return<Dots.Exchange> {
    const base = { exchangeID: value.exchangeID, sessionID: value.sessionID, targetSessionID: value.targetSessionID, inputID: value.inputID, channel: "task" as const, envelope: taskEnvelope(value) }
    const rejected = yield* options.db.select({ id: EventTable.id }).from(EventTable).where(and(eq(EventTable.aggregate_id, value.targetSessionID),
      eq(EventTable.type, EventRuntime.versionedType(SessionEvent.DotsInstructionRejected.type, 1)), sql`json_extract(${EventTable.data}, '$.inputID') = ${value.inputID}`)).limit(1).get().pipe(Effect.orDie)
    if (rejected) return { ...base, state: "failed", progress: [] }
    const recorded = yield* options.db.select({ data: EventTable.data }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, value.targetSessionID), eq(EventTable.type, EventRuntime.versionedType(SessionEvent.DotsReportRecorded.type, 1)),
      sql`json_extract(${EventTable.data}, '$.envelope.replyToMessageID') = ${value.inputID}`,
      sql`json_extract(${EventTable.data}, '$.envelope.exchangeID') = ${value.exchangeID}`,
    )).orderBy(desc(EventTable.seq)).limit(20).all().pipe(Effect.orDie)
    const reports = recorded.reverse().map((row) => {
      const data = Schema.decodeUnknownSync(SessionEvent.DotsReportRecorded.data)(row.data)
      return { deliveryID: data.deliveryID, messageID: data.messageID, text: data.text, envelope: data.envelope }
    })
    const completion = yield* options.db.select({ data: EventTable.data }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, value.targetSessionID), eq(EventTable.type, completedType), sql`json_extract(${EventTable.data}, '$.inputID') = ${value.inputID}`,
    )).orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    if (completion) {
      const completed = Schema.decodeUnknownSync(SessionEvent.Work.Completed.data)(completion.data)
      const result = yield* output(value, completed.assistantMessageID, "completion")
      return { ...base, state: result === undefined ? "unknown" : "completed", progress: reports, ...(result === undefined ? {} : { result }) }
    }
    const promoted = yield* options.db.select({ seq: EventTable.seq }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, value.targetSessionID), eq(EventTable.type, promotedType), sql`json_extract(${EventTable.data}, '$.inputID') = ${value.inputID}`,
    )).orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    if (!promoted) return { ...base, state: "pending", progress: [] }
    const next = yield* options.db.select({ seq: EventTable.seq }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, value.targetSessionID), eq(EventTable.type, promotedType), gt(EventTable.seq, promoted.seq),
    )).orderBy(asc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    const terminal = yield* options.db.select({ type: EventTable.type }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, value.targetSessionID), gt(EventTable.seq, promoted.seq), next ? lt(EventTable.seq, next.seq) : undefined,
      sql`${EventTable.type} IN (${EventRuntime.versionedType(SessionEvent.Execution.Failed.type, 1)}, ${EventRuntime.versionedType(SessionEvent.Execution.Interrupted.type, 1)})`,
    )).orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    const rows = yield* options.db.select({ id: SessionProviderRequestTable.assistant_message_id }).from(SessionProviderRequestTable).where(and(
      eq(SessionProviderRequestTable.session_id, value.targetSessionID), eq(SessionProviderRequestTable.input_id, value.inputID),
    )).orderBy(desc(SessionProviderRequestTable.request)).limit(20).all().pipe(Effect.orDie)
    const implicit = (yield* Effect.forEach([...new Set(rows.flatMap((row) => row.id ? [row.id] : []))].reverse(), (id) => output(value, id)))
      .filter((item): item is Dots.ExchangeOutput => item !== undefined)
    const progress = [...implicit.filter((item) => !reports.some((report) => report.messageID === item.messageID)), ...reports].slice(-20)
    const active = yield* options.execution.active
    return { ...base, state: terminal?.type === EventRuntime.versionedType(SessionEvent.Execution.Failed.type, 1) ? "failed" : terminal || next || !active.has(value.targetSessionID) ? "unknown" : "running", progress }
  })

  const activeRecord = Effect.fn("DotsExchange.activeRecord")(function* (sessionID: Session.ID) {
    const promoted = yield* options.db.select({ seq: EventTable.seq, data: EventTable.data }).from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, promotedType)))
      .orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    if (!promoted) return yield* fail("exchange_not_found", "There is no active Dots task.")
    const input = Schema.decodeUnknownSync(SessionEvent.InputPromoted.data)(promoted.data)
    const row = yield* options.db.select({ data: EventTable.data }).from(EventTable).where(and(
      eq(EventTable.type, createdType), sql`json_extract(${EventTable.data}, '$.targetSessionID') = ${sessionID}`,
      sql`json_extract(${EventTable.data}, '$.inputID') = ${input.inputID}`,
    )).limit(1).get().pipe(Effect.orDie)
    if (!row) return yield* fail("exchange_not_found", "The current input is not a Dots task.")
    const completion = yield* options.db.select({ id: EventTable.id }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, completedType),
      sql`json_extract(${EventTable.data}, '$.inputID') = ${input.inputID}`,
    )).limit(1).get().pipe(Effect.orDie)
    if (completion) return yield* fail("exchange_not_found", "The Dots task has completed.")
    return { record: Schema.decodeUnknownSync(Dots.ExchangeRecord)(row.data), generation: promoted.seq }
  })

  const createRoutine = Effect.fn("DotsExchange.createRoutine")(function* (input: Dots.ExchangeCreate & { readonly sessionID: Session.ID; readonly remoteSource: McpEvents.RequestContext }) {
    const { sessionID, remoteSource, ...raw } = input
    const payload = yield* Schema.decodeUnknownEffect(Dots.ExchangeCreate)(raw, { onExcessProperty: "error" }).pipe(Effect.mapError(() => fail("invalid_input", "Invalid routine instruction.")))
    if (payload.delegation === undefined) return yield* fail("invalid_input", "A routine instruction requires a delegation.")
    const routine: Dots.RoutineReceipt = { delegation: payload.delegation, taskInputID: payload.taskInputID, instruction: payload.instruction }
    const principal = yield* authorize(remoteSource)
    const checked = yield* checkedPrincipal(principal)
    const attachment = yield* options.attachment(sessionID)
    if (Hash.json(identity(attachment.target)) !== Hash.json(identity(payload.expectedAttachment))) return yield* fail("target_changed", "The confirmed attachment changed.")
    const current = yield* nativeFence(sessionID, payload.targetSessionID)
    const fingerprint = Hash.json({ ...payload, expectedAttachment: identity(payload.expectedAttachment), source: principal })
    return yield* lock.withLock(recordID(sessionID, payload.exchangeID))(SessionPending.withInboxLock(payload.targetSessionID)(
      options.withBinding(sessionID, (binding) => owned(current.nativeScope, Effect.gen(function* () {
        if (!liveAuthorization(checked)) return yield* fail("authorization_failed", "The coordinator grant changed before admission.")
        yield* routineGrant(binding, routine, principal, payload.targetSessionID)
        const prior = yield* record(sessionID, payload.exchangeID)
        if (prior) {
          if (prior.fingerprint !== fingerprint) return yield* fail("exchange_conflict", "The exchange ID already names another routine instruction.")
          return yield* project(prior)
        }
        const value: Dots.ExchangeRecord = { exchangeID: payload.exchangeID, sessionID, targetSessionID: payload.targetSessionID,
          inputID: SessionMessage.ID.make(`msg_dots_${Hash.json([sessionID, payload.exchangeID])}`), expectedAttachment: binding.target,
          accountDigest: binding.accountDigest, fingerprint, source: remoteSource, scope: current.nativeScope, grantID: principal.grantID, routine }
        const text = payload.instruction.operation === "continue"
          ? "Continue the existing native human task. Preserve its scope, remaining step allowance, permissions and pending human decisions."
          : `Present the existing native human task using these approved preferences: ${JSON.stringify(payload.instruction.preferences)}. Preserve its objective, permissions and pending human decisions.`
        const committed = yield* options.events.publishBatch([
          { definition: SessionEvent.DotsExchangeCreated, data: value, options: { id: recordID(sessionID, payload.exchangeID) } },
          { definition: SessionEvent.InputAdmitted, data: { sessionID: payload.targetSessionID, inputID: value.inputID,
            input: SessionPending.Message.make({ type: "user", delivery: payload.delivery, data: { text, metadata: {
              inputOrigin: "plugin", remoteMcp: remoteSource,
              dotsExchange: Dots.ExchangeMetadata.make({ exchangeID: value.exchangeID, sessionID, targetSessionID: value.targetSessionID,
                attachment: value.expectedAttachment, envelope: taskEnvelope(value), routine }),
            } } }) } },
        ], { when: routineGrant(binding, routine, principal, payload.targetSessionID).pipe(Effect.match({ onFailure: () => false, onSuccess: () => liveAuthorization(checked) })) })
        if (!committed.length) return yield* fail("authorization_failed", "The routine delegation changed before admission.")
        yield* options.execution.wake(value.targetSessionID)
        return yield* project(value)
      }))),
    ))
  })

  return {
    delegationCreate,
    promoteRoutine,
    currentRoutine: (sessionID: Session.ID) => activeRecord(sessionID).pipe(Effect.map((active) => active.record.routine), Effect.catch(() => Effect.succeed(undefined))),
    delegationStatus: Effect.fn("DotsExchange.delegationStatus")(function* (input: typeof Dots.DelegationStatusInput.Type & { readonly sessionID: Session.ID }): Effect.fn.Return<Dots.DelegationStatus, DotsRuntime.Error> {
      const current = yield* nativeFence(input.sessionID, input.targetSessionID)
      const attachment = yield* options.attachment(input.sessionID)
      if (Hash.json(identity(attachment.target)) !== Hash.json(identity(input.expectedAttachment))) return yield* fail("target_changed", "The attachment changed.")
      const rows = yield* options.db.select({ data: EventTable.data }).from(EventTable).where(and(eq(EventTable.aggregate_id, input.sessionID), eq(EventTable.type, createdType),
        sql`json_extract(${EventTable.data}, '$.targetSessionID') = ${input.targetSessionID}`)).orderBy(desc(EventTable.seq)).limit(20).all().pipe(Effect.orDie)
      const sources = (yield* Effect.forEach(rows, (row) => Effect.gen(function* () {
        const value = Schema.decodeUnknownSync(Dots.ExchangeRecord)(row.data)
        const principal = { ...value.source.principal, epoch: value.source.epoch, grantID: value.grantID }
        const checked = yield* checkedPrincipal(principal).pipe(Effect.andThen(checkFences(value, value.source)), Effect.result)
        return checked._tag === "Success" ? { sourceExchangeID: value.exchangeID, principal } : undefined
      }))).filter((value): value is NonNullable<typeof value> => value !== undefined)
        .filter((value, index, all) => all.findIndex((candidate) => Hash.json(candidate.principal) === Hash.json(value.principal)) === index)
      const selected = yield* task(input.targetSessionID).pipe(Effect.result)
      const candidates = yield* options.withBinding(input.sessionID, (binding) => Effect.succeed([...binding.grants.values()].filter((grant) => grant.info.targetSessionID === input.targetSessionID)))
      const checked = yield* Effect.forEach(candidates, (grant) => checkedPrincipal(grant.info.principal).pipe(Effect.result))
      const grants = yield* options.withBinding(input.sessionID, (binding) => owned(current.nativeScope, Effect.forEach(
        candidates, (grant, index) => localGrant(binding, grant).pipe(
          Effect.match({ onFailure: () => ({ ...grant.info, active: false }), onSuccess: () => ({ ...grant.info, active: checked[index]?._tag === "Success" && liveAuthorization(checked[index].success) }) }),
        ),
      )))
      return { sources, tasks: selected._tag === "Success" ? [{ taskInputID: selected.success.taskInputID, text: selected.success.text }] : [], grants }
    }),
    delegationRevoke: Effect.fn("DotsExchange.delegationRevoke")(function* (input: Dots.DelegationRevoke & { readonly sessionID: Session.ID }) {
      return yield* options.withBinding(input.sessionID, (binding) => Effect.gen(function* () {
        if (Hash.json(identity(binding.target)) !== Hash.json(identity(input.expectedAttachment))) return yield* fail("target_changed", "The attachment changed.")
        const grant = binding.grants.get(input.id)
        if (!grant || grant.info.revision !== input.revision) return yield* fail("authorization_failed", "The delegation is unavailable.")
        const info = { ...grant.info, active: false }
        binding.grants.set(input.id, { ...grant, info })
        return info
      }))
    }),
    resolveReport: Effect.fn("DotsExchange.resolveReport")(function* (sessionID: Session.ID, messageID?: SessionMessage.ID) {
      const active = yield* activeRecord(sessionID)
      if (messageID !== undefined) {
        const request = yield* options.db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).where(and(
          eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID),
          eq(SessionMessageTable.type, "assistant"), gt(SessionMessageTable.seq, active.generation),
        )).limit(1).get().pipe(Effect.orDie)
        if (!request) return yield* fail("target_forbidden", "The report does not belong to the current Dots task.")
      }
      yield* checkFences(active.record, active.record.source)
      yield* options.checkStored({ ...active.record.source.principal, epoch: active.record.source.epoch, grantID: active.record.grantID })
        .pipe(Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(fail("authorization_failed", "The coordinator grant is unavailable."))))
      yield* checkFences(active.record, active.record.source)
      const current = yield* activeRecord(sessionID)
      if (current.generation !== active.generation || Hash.json(current.record) !== Hash.json(active.record))
        return yield* fail("target_changed", "The active Dots task changed.")
      return current
    }),
    create: Effect.fn("DotsExchange.create")(function* (input: Dots.ExchangeCreate & { readonly sessionID: Session.ID; readonly remoteSource: McpEvents.RequestContext }) {
      if (input.delegation !== undefined) return yield* createRoutine(input)
      const principal = yield* authorize(input.remoteSource)
      if (["envelope", "grantID", "origin", "coordinator", "scope"].some((key) => key in input))
        return yield* fail("invalid_input", "Routing identity is supplied only by the authenticated adapter.")
      const payload = yield* Schema.decodeUnknownEffect(Dots.ExchangeCreate)(input).pipe(Effect.mapError(() => fail("invalid_input", "Invalid Dots exchange.")))
      if (payload.delegation !== undefined) return yield* fail("invalid_input", "A routine instruction requires its native delegation path.")
      return yield* lock.withLock(recordID(input.sessionID, input.exchangeID))(SessionPending.withInboxLock(input.targetSessionID)(Effect.gen(function* () {
        const attachment = yield* options.attachment(input.sessionID)
        if (Hash.json(identity(attachment.target)) !== Hash.json(identity(payload.expectedAttachment))) return yield* fail("target_changed", "The confirmed attachment changed.")
        const fingerprint = Hash.json({ ...payload, expectedAttachment: identity(payload.expectedAttachment), source: input.remoteSource.principal })
        const prior = yield* record(input.sessionID, input.exchangeID)
        if (prior) {
          if (prior.fingerprint !== fingerprint) return yield* fail("exchange_conflict", "The exchange ID is already used with different content or source.")
          yield* validate(prior, input.remoteSource)
          const projected = yield* project(prior)
          yield* validate(prior, input.remoteSource)
          return projected
        }
        const current = yield* scope(input.sessionID, input.targetSessionID)
        const value: Dots.ExchangeRecord = {
          exchangeID: input.exchangeID, sessionID: input.sessionID, targetSessionID: input.targetSessionID,
          inputID: SessionMessage.ID.make(`msg_dots_${Hash.json([input.sessionID, input.exchangeID])}`),
          expectedAttachment: attachment.target, accountDigest: attachment.accountDigest, fingerprint,
          source: input.remoteSource, scope: current, grantID: principal.grantID,
        }
        if (yield* SessionPending.lookup(options.db, input.targetSessionID, value.inputID)) return yield* fail("exchange_conflict", "The exchange input identity is already occupied.")
        let validationError: DotsRuntime.Error | undefined
        const committed = yield* options.events.publishBatch([
          { definition: SessionEvent.DotsExchangeCreated, data: value, options: { id: recordID(input.sessionID, input.exchangeID) } },
          { definition: SessionEvent.InputAdmitted, data: {
            sessionID: input.targetSessionID, inputID: value.inputID,
            input: SessionPending.Message.make({ type: "user", delivery: payload.delivery, data: {
              text: payload.text, metadata: {
                inputOrigin: "plugin", remoteMcp: input.remoteSource,
                dotsExchange: Dots.ExchangeMetadata.make({
                  exchangeID: value.exchangeID, sessionID: value.sessionID, targetSessionID: value.targetSessionID,
                  attachment: value.expectedAttachment,
                  envelope: taskEnvelope(value),
                }),
              },
            } }),
          } },
        ], { when: validate(value, input.remoteSource).pipe(Effect.match({
          onFailure: (error) => { validationError = error; return false },
          onSuccess: () => true,
        })) })
        if (committed.length === 0) return yield* (validationError ?? fail("target_changed", "The exchange changed before admission."))
        yield* options.execution.wake(input.targetSessionID)
        return yield* Effect.gen(function* () {
          const projected = yield* project(value)
          yield* validate(value, input.remoteSource)
          return projected
        }).pipe(Effect.mapError(() => fail("exchange_outcome_unknown", "The exchange was admitted but its return could not be confirmed; read the same exchange before another mutation.")))
      })))
    }),
    read: Effect.fn("DotsExchange.read")(function* (input: Dots.ExchangeRead & { readonly sessionID: Session.ID; readonly remoteSource: McpEvents.RequestContext }) {
      yield* authorize(input.remoteSource)
      const value = yield* record(input.sessionID, input.exchangeID)
      if (!value) return yield* fail("exchange_not_found", "The exchange does not exist on this attachment.")
      yield* validate(value, input.remoteSource)
      const projected = yield* project(value)
      yield* validate(value, input.remoteSource)
      return projected
    }),
  }
}

export function attachmentForSession(input: {
  readonly sessions: Pick<Session.Interface, "get">
  readonly currentLocation: Location.Ref
  readonly current: Pick<DotsRuntime.Interface, "attachment">
  readonly runtimeAt: (location: Location.Ref) => Effect.Effect<Pick<DotsRuntime.Interface, "attachment">, DotsRuntime.Error>
}): DotsRuntime.Interface["attachment"] {
  return (sessionID) => Effect.gen(function* () {
    const session = yield* input.sessions.get(sessionID).pipe(Effect.mapError(() => fail("session_not_found", "The attachment Session does not exist.")))
    const same = session.location.directory === input.currentLocation.directory && session.location.workspaceID === input.currentLocation.workspaceID
    const runtime = same ? input.current : yield* input.runtimeAt(session.location)
    return yield* runtime.attachment(sessionID)
  })
}

export const service = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const sessions = yield* Session.Service
  const coordination = yield* CoordinationService.Service
  const execution = yield* SessionExecution.Service
  const dots = yield* DotsRuntime.Service
  const currentLocation = yield* Location.Service
  const locations = yield* LocationServiceMap.Service
  const authorization = yield* SessionMcpEvents.Authorization.Service
  const permission = yield* Permission.Service
  const runtimeFor = (sessionID: Session.ID) => Effect.gen(function* () {
    const session = yield* sessions.get(sessionID).pipe(Effect.mapError(() => fail("session_not_found", "The attachment Session does not exist.")))
    if (session.location.directory === currentLocation.directory && session.location.workspaceID === currentLocation.workspaceID) return dots
    return yield* DotsRuntime.Service.pipe(Effect.provide(locations.get(session.location)), Effect.mapError(() => fail("connection_unavailable", "The attachment Location is unavailable.")))
  })
  return make({ db: database.db, events, sessions, coordination, execution, attachment: attachmentForSession({ sessions, currentLocation, current: dots,
    runtimeAt: (location) => DotsRuntime.Service.pipe(Effect.provide(locations.get(location)), Effect.mapError(() => fail("connection_unavailable", "The attachment Location is unavailable."))),
  }),
    withBinding: (sessionID, use) => runtimeFor(sessionID).pipe(Effect.flatMap((runtime) => runtime.withBinding(sessionID, use))),
    approve: (input) => permission.assert(input).pipe(Effect.mapError(() => fail("authorization_failed", "A native human approval is required to activate delegation."))),
    now: () => Date.now(),
    checkStored: (principal) => authorization.check(principal).pipe(Effect.flatMap((checked) =>
      checked.expiresAt > Date.now() && checked.signal?.aborted !== true
        ? Effect.succeed(checked)
        : Effect.fail(fail("authorization_failed", "The coordinator grant is unavailable.")))),
    authorize: (source) => Effect.gen(function* () {
      const grant = yield* authorization.resolve(source)
      if (grant.expiresAt <= (yield* Clock.currentTimeMillis)) return yield* fail("authorization_failed", "The remote grant expired.")
      return { ...source.principal, epoch: source.epoch, grantID: grant.grantID }
    }),
  })
})
