export * as DotsExchange from "./exchange"

import { Dots } from "@ycoding-ai/schema/dots"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import type { Task } from "@ycoding-ai/schema/session-orchestration"
import type { Item } from "@ycoding-ai/schema/session-review"
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm"
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
import { SessionMessageTable, SessionProviderRequestTable, SessionTable } from "../session/sql"
import { Permission } from "../permission"
import { Form } from "../form"
import { Question } from "../question"
import { SessionGuardrail } from "../session/guardrail"
import { CoordinationDecisions } from "../session/coordination-decisions"
import { Hash } from "../util/hash"
import { DotsAuthority } from "./authority"
import { SessionOrchestration } from "../session/orchestration"
import { SessionReview } from "../session/review"

const lock = KeyedMutex.makeUnsafe<string>()
const createdType = EventRuntime.versionedType(SessionEvent.DotsExchangeCreated.type, 1)
const promotedType = EventRuntime.versionedType(SessionEvent.InputPromoted.type, 1)
const completedType = EventRuntime.versionedType(SessionEvent.Work.Completed.type, 1)
const fail = (code: Dots.ErrorCode, message: string) => new DotsRuntime.Error({ code, message })
const identity = (target: Dots.Target) => [target.profile, target.dotID, target.threadID, target.generation]
const recordID = (sessionID: Session.ID, exchangeID: string) => EventRuntime.ID.make(`evt_dots_${Hash.json([sessionID, exchangeID])}`)

export type PendingDecision =
  | { readonly kind: "permission"; readonly sessionID: Session.ID; readonly requestID: string; readonly fingerprint: string; readonly action: string; readonly resources: ReadonlyArray<string>; readonly metadata?: Readonly<Record<string, unknown>>; readonly sourceMessageID?: string; readonly delegatedEligible?: boolean }
  | { readonly kind: "guardrail"; readonly sessionID: Session.ID; readonly requestID: string; readonly fingerprint: string; readonly action: string; readonly resources: ReadonlyArray<string>; readonly ruleIDs: ReadonlyArray<string>; readonly standard: boolean; readonly hardReview?: boolean; readonly sourceMessageID?: string; readonly delegatedEligible?: boolean }
  | { readonly kind: "form"; readonly sessionID: Session.ID; readonly formID: string; readonly fingerprint: string; readonly title: string; readonly fields: Form.Fields; readonly metadata?: Readonly<Record<string, unknown>>; readonly sourceMessageID?: string; readonly delegatedEligible?: boolean }
  | { readonly kind: "question"; readonly sessionID: Session.ID; readonly requestID: string; readonly fingerprint: string; readonly questions: ReadonlyArray<Question.Info>; readonly sourceMessageID?: string; readonly delegatedEligible?: boolean }
  | { readonly kind: "subagent_question"; readonly sessionID: Session.ID; readonly fingerprint: string; readonly task: Task; readonly sourceMessageID?: string; readonly delegatedEligible?: boolean }
  | { readonly kind: "review"; readonly sessionID: Session.ID; readonly fingerprint: string; readonly item: Item; readonly sourceMessageID?: string; readonly delegatedEligible?: boolean }

export type DecisionChoiceInput = { readonly reply: "once" | "reject" } | { readonly answers: Form.Answer | ReadonlyArray<Question.Answer> } |
  { readonly cancelled: true } | { readonly text?: string; readonly data?: Schema.Json } | { readonly dismissed: true } | { readonly decision: Dots.ReviewDecision }

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
  readonly decisions?: {
    readonly pending: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<PendingDecision>, unknown>
    readonly permissionEffect: (sessionID: Session.ID, action: string, resource: string) => Effect.Effect<"allow" | "deny" | "ask", unknown>
    readonly settle: (input: { readonly pending: PendingDecision; readonly choice: DecisionChoiceInput; readonly source: Form.ExternalReplySource; readonly explicitDecision?: true; readonly validate: () => Effect.Effect<boolean> }) => Effect.Effect<void, unknown>
  }
}

export const questionFingerprint = Question.fingerprint

const formSourceMessageID = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const tool = metadata?.tool
  return tool && typeof tool === "object" && !Array.isArray(tool) && typeof (tool as Record<string, unknown>).messageID === "string"
    ? (tool as Record<string, string>).messageID
    : undefined
}

export function decisionServices(deps: {
  readonly permission: Pick<Permission.Interface, "snapshots" | "replyDelegated" | "delegatedEligible" | "evaluateEffective">
  readonly guardrail: Pick<SessionGuardrail.Interface, "requestSnapshots" | "replyDelegated" | "delegatedEligible">
  readonly forms: Pick<Form.Interface, "snapshots" | "replyDelegated" | "cancelDelegated">
  readonly questions: Pick<Question.Interface, "list" | "replyDelegated" | "rejectDelegated">
  readonly reviews?: Pick<SessionReview.Interface, "pendingSnapshots" | "decideDelegated">
  readonly orchestration?: Pick<SessionOrchestration.Interface, "questionSnapshots" | "answer">
  readonly sessions?: Pick<Session.Interface, "get">
}): NonNullable<Options["decisions"]> {
  return {
    pending: (sessionID) => Effect.gen(function* () {
      const items: PendingDecision[] = []
      for (const item of yield* deps.permission.snapshots(sessionID))
        items.push({ kind: "permission", sessionID, requestID: item.request.id, fingerprint: item.fingerprint, action: item.request.action, resources: item.request.resources,
          delegatedEligible: yield* deps.permission.delegatedEligible({ requestID: item.request.id, fingerprint: item.fingerprint, reply: "once" }).pipe(Effect.catch(() => Effect.succeed(false))),
          ...(item.request.metadata === undefined ? {} : { metadata: item.request.metadata }), ...(item.request.source === undefined ? {} : { sourceMessageID: item.request.source.messageID }) })
      for (const item of yield* deps.guardrail.requestSnapshots(sessionID))
        items.push({ kind: "guardrail", sessionID, requestID: item.request.id, fingerprint: item.fingerprint, action: item.request.action, resources: item.request.resources,
          delegatedEligible: yield* deps.guardrail.delegatedEligible({ sessionID, requestID: item.request.id, fingerprint: item.fingerprint, reply: "once" }).pipe(Effect.catch(() => Effect.succeed(false))),
          ruleIDs: item.request.ruleIDs, standard: item.request.standard, ...(item.request.hardReview === undefined ? {} : { hardReview: item.request.hardReview }),
          ...(item.request.source === undefined ? {} : { sourceMessageID: item.request.source.messageID as string }) })
      for (const item of yield* deps.forms.snapshots(sessionID)) {
        if (item.state.status !== "pending") continue
        const sourceMessageID = formSourceMessageID(item.form.metadata)
        items.push({ kind: "form", sessionID, formID: item.form.id, fingerprint: item.fingerprint, title: item.form.title, fields: item.form.fields,
          ...(item.form.metadata === undefined ? {} : { metadata: item.form.metadata }), ...(sourceMessageID === undefined ? {} : { sourceMessageID }) })
      }
      for (const request of yield* deps.questions.list()) {
        if (request.sessionID !== sessionID) continue
        items.push({ kind: "question", sessionID, requestID: request.id, fingerprint: questionFingerprint(request), questions: request.questions,
          ...(request.tool === undefined ? {} : { sourceMessageID: request.tool.messageID }) })
      }
      if (deps.reviews) for (const item of yield* deps.reviews.pendingSnapshots(sessionID)) {
        if (item.item.sessionID === sessionID) items.push({ kind: "review", sessionID, item: item.item, fingerprint: item.fingerprint })
      }
      if (deps.sessions && deps.orchestration) {
        const session = yield* deps.sessions.get(sessionID)
        if (session.parentID) for (const item of yield* deps.orchestration.questionSnapshots(session.parentID)) {
          if (item.task.sessionID === sessionID && item.task.question && !item.task.question.deferred)
            items.push({ kind: "subagent_question", sessionID, task: item.task, fingerprint: item.fingerprint })
        }
      }
      return items
    }),
    permissionEffect: (sessionID, action, resource) => deps.permission.evaluateEffective({ sessionID, action, resource }),
    settle: (input) => Effect.gen(function* () {
      const pending = input.pending
      const explicit = input.explicitDecision === true
      const capability = explicit ? { explicitDecision: true as const } : {}
      if (pending.kind === "permission" && "reply" in input.choice)
        return yield* deps.permission.replyDelegated({ requestID: Permission.ID.create(pending.requestID), reply: input.choice.reply, fingerprint: pending.fingerprint, source: input.source, ...capability,
          validate: (current) => explicit || current.source?.messageID !== undefined && current.source.messageID === pending.sourceMessageID &&
            CoordinationDecisions.explicitDecisionReason({ kind: "permission", action: current.action, resources: current.resources, metadata: current.metadata }) === undefined
            ? input.validate() : Effect.succeed(false) })
      if (pending.kind === "guardrail" && "reply" in input.choice)
        return yield* deps.guardrail.replyDelegated({ sessionID: pending.sessionID, requestID: Guardrail.RequestID.create(pending.requestID), reply: input.choice.reply, fingerprint: pending.fingerprint, source: input.source, ...capability,
          validate: (current) => explicit || current.source?.messageID !== undefined && current.source.messageID === pending.sourceMessageID &&
            CoordinationDecisions.explicitDecisionReason({ kind: "review", action: current.action, resources: current.resources, ruleIDs: current.ruleIDs, hardReview: current.hardReview }) === undefined
            ? input.validate() : Effect.succeed(false) })
      if (pending.kind === "form" && "answers" in input.choice && Schema.is(Form.Answer)(input.choice.answers))
        return yield* deps.forms.replyDelegated({ id: Form.ID.create(pending.formID), answer: input.choice.answers, fingerprint: pending.fingerprint, source: input.source, ...capability,
          validate: (current) => explicit || formSourceMessageID(current.metadata) !== undefined && formSourceMessageID(current.metadata) === pending.sourceMessageID &&
            CoordinationDecisions.explicitDecisionReason({ kind: "question", resources: [current.title, ...current.fields.flatMap((field) => [field.key, field.title ?? "", field.description ?? ""])], metadata: current.metadata }) === undefined
            ? input.validate() : Effect.succeed(false) })
      if (pending.kind === "question" && "answers" in input.choice && Schema.is(Schema.Array(Question.Answer))(input.choice.answers))
        return yield* deps.questions.replyDelegated({ requestID: Question.ID.ascending(pending.requestID), answers: input.choice.answers, fingerprint: pending.fingerprint, source: input.source, ...capability,
          validate: (current) => explicit || current.tool?.messageID !== undefined && current.tool.messageID === pending.sourceMessageID &&
            CoordinationDecisions.explicitDecisionReason({ kind: "question", resources: current.questions.flatMap((item) => [item.question, item.header, ...item.options.map((option) => option.label)]) }) === undefined
            ? input.validate() : Effect.succeed(false) })
      if (explicit && input.source.kind === "dots-client") {
        if (pending.kind === "form" && "cancelled" in input.choice)
          return yield* deps.forms.cancelDelegated({ id: Form.ID.create(pending.formID), fingerprint: pending.fingerprint, source: input.source, ...capability, validate: input.validate })
        if (pending.kind === "question" && "cancelled" in input.choice)
          return yield* deps.questions.rejectDelegated({ requestID: Question.ID.ascending(pending.requestID), fingerprint: pending.fingerprint, source: input.source, ...capability, validate: input.validate })
        if (pending.kind === "review" && "decision" in input.choice && deps.reviews)
          return yield* deps.reviews.decideDelegated({ sessionID: pending.sessionID, itemID: pending.item.itemID, decision: input.choice.decision, fingerprint: pending.fingerprint, source: input.source, ...capability, validate: input.validate })
        if (pending.kind === "subagent_question" && deps.orchestration && pending.task.question && ("text" in input.choice || "data" in input.choice || "dismissed" in input.choice)) {
          yield* deps.orchestration.answer({ parentID: pending.task.parentID, childID: pending.task.sessionID, questionID: pending.task.question.id,
            ...("dismissed" in input.choice ? { text: "The authenticated Dots client dismissed this question without answering; proceed on your own judgment." } : "text" in input.choice ? { text: input.choice.text } : {}), ...("data" in input.choice ? { data: input.choice.data } : {}),
            dots: { source: input.source, fingerprint: pending.fingerprint, ...capability, validate: input.validate } })
          return
        }
      }
      return yield* Effect.fail(new Error("The decision does not match the native request."))
    }),
  }
}

export function make(options: Options) {
  const authority = DotsAuthority.make(options)
  const authorize = (source: McpEvents.RequestContext) => options.authorize(source).pipe(
    Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(fail("authorization_failed", "The remote invocation is not authorized."))),
    Effect.flatMap((principal) => Schema.is(McpEvents.Principal)(principal) &&
      principal.epoch === source.epoch && Hash.json({ ownerID: principal.ownerID, deviceID: principal.deviceID, clientID: principal.clientID }) === Hash.json(source.principal)
      ? Effect.succeed(principal)
      : Effect.fail(fail("authorization_failed", "The resolved coordinator does not match the remote invocation."))),
  )
  const scope = Effect.fn("DotsExchange.scope")(function* (sessionID: Session.ID, targetID: Session.ID, decision = false) {
    const anchor = yield* options.sessions.get(sessionID).pipe(Effect.mapError(() => fail("session_not_found", "The attachment Session does not exist.")))
    if (anchor.time.archived !== undefined) return yield* fail("target_forbidden", "The attachment Session is archived.")
    if (anchor.parentID !== undefined) return yield* fail("target_forbidden", "The attachment must be a root Session.")
    const chain = [yield* options.sessions.get(targetID).pipe(Effect.mapError(() => fail("session_not_found", "The target Session does not exist.")))]
    if (chain[0].time.archived !== undefined) return yield* fail("target_forbidden", "The target Session is archived.")
    if (!decision && chain[0].parentID !== undefined && chain[0].agent !== "btw")
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
    const current = yield* scope(value.sessionID, value.targetSessionID, value.delegated?.instruction.operation === "decision")
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
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user"), sql`json_extract(${SessionMessageTable.data}, '$.metadata.inputOrigin') = 'direct'`))
      .orderBy(desc(SessionMessageTable.seq)).limit(1).all().pipe(Effect.orDie)
    const pending = (yield* SessionPending.list(options.db, sessionID)).filter((entry) => entry.type === "user" && entry.data.metadata?.inputOrigin === "direct")
    const admitted = pending.length && messages[0] ? yield* options.db.select({ seq: EventTable.seq }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, EventRuntime.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version)),
      sql`json_extract(${EventTable.data}, '$.inputID') = ${messages[0].id}`,
    )).limit(1).get().pipe(Effect.orDie) : undefined
    const latest = [...messages.map((row) => ({ id: row.id, seq: admitted?.seq ?? row.seq, data: Schema.decodeUnknownSync(SessionMessage.User)({ ...row.data, id: row.id, type: "user" }), queued: false, promotedSeq: row.seq })),
      ...pending.filter((entry): entry is SessionPending.User => entry.type === "user").map((entry) => ({ id: entry.id, seq: entry.admittedSeq, data: entry.data, queued: entry.delivery === "queue", promotedSeq: undefined }))]
      .sort((a, b) => b.seq - a.seq)[0]
    if (!latest || latest.queued || typeof latest.data.text !== "string" || !latest.data.text.trim())
      return yield* fail("target_forbidden", "Select an existing current direct task.")
    const completion = latest.promotedSeq !== undefined ? yield* options.db.select({ id: EventTable.id }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, completedType), gt(EventTable.seq, latest.promotedSeq),
    )).limit(1).get().pipe(Effect.orDie) : undefined
    if (completion) return yield* fail("target_forbidden", "The direct task has completed.")
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
    if ("basis" in grant.info) {
      if (current.ownerFence !== grant.ownerFence || Hash.json(current.nativeScope) !== Hash.json(grant.nativeScope))
        return yield* fail("target_forbidden", "The native ownership incarnation changed.")
      return grant
    }
    const selected = yield* task(grant.info.targetSessionID)
    if (selected.taskInputID !== grant.info.taskInputID || selected.fence !== grant.taskFence || current.ownerFence !== grant.ownerFence || Hash.json(current.nativeScope) !== Hash.json(grant.nativeScope))
      return yield* fail("target_forbidden", "The native task or ownership incarnation changed.")
    return grant
  })
  const checkedPrincipal = (principal: McpEvents.Principal) => options.checkStored(principal).pipe(Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(fail("authorization_failed", "The coordinator grant is unavailable."))))
  const liveAuthorization = (checked: { readonly expiresAt: number; readonly signal?: AbortSignal }) =>
    checked.expiresAt > options.now() && checked.signal?.aborted !== true
  const deviceGrant = Effect.fn("DotsExchange.deviceGrant")(function* (binding: DotsRuntime.BindingAuthority, ref: Dots.DelegationRef, principal: McpEvents.Principal, operation: "task" | "decision", sessionID: Session.ID) {
    const info = (yield* authority.grants(sessionID)).find((grant) => grant.id === ref.id)
    if (!info) return undefined
    const saved = yield* authority.binding(sessionID)
    if (!info.active || info.revision !== ref.revision || info.expiresAt <= options.now() || info.bindingID !== binding.incarnation || saved?.id !== binding.incarnation ||
      saved.accountDigest !== binding.accountDigest || !DotsAuthority.sameTarget(saved.target, binding.target) || Hash.json(info.principal) !== Hash.json(principal) || !info.scope.operations.includes(operation))
      return yield* fail("authorization_failed", "The device delegation is inactive or its authenticated scope changed.")
    return info
  })
  const deviceBinding = Effect.fn("DotsExchange.deviceBinding")(function* (sessionID: Session.ID) {
    const anchor = yield* options.sessions.get(sessionID).pipe(Effect.mapError(() => fail("session_not_found", "The attachment Session does not exist.")))
    if (anchor.time.archived !== undefined || anchor.parentID !== undefined) return yield* fail("target_forbidden", "Select a nonarchived root attachment Session.")
    return yield* options.withBinding(sessionID, (binding) => Effect.succeed({ id: binding.incarnation, target: binding.target, accountDigest: binding.accountDigest }))
  })
  const pageCursor = Schema.Struct({ scope: Schema.String, after: Schema.String })
  const decodeCursor = (cursor: string | undefined, expected: string) => Effect.try({
    try: () => {
      if (cursor === undefined) return ""
      const value = Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(pageCursor)))(Buffer.from(cursor, "base64url").toString("utf8"))
      if (value.scope !== expected) throw new Error("Cursor scope changed")
      return value.after
    },
    catch: () => fail("invalid_input", "The cursor does not match this authenticated inventory."),
  })
  const cursorFor = (scope: string, after: string) => Buffer.from(JSON.stringify({ scope, after })).toString("base64url")
  const deviceDelegationRead = Effect.fn("DotsExchange.deviceDelegationRead")(function* (input: Dots.DeviceDelegationRead & { readonly sessionID: Session.ID; readonly remoteSource: McpEvents.RequestContext }): Effect.fn.Return<Dots.DeviceDelegationStatus, DotsRuntime.Error> {
    const { sessionID, remoteSource, ...raw } = input
    const payload = yield* Schema.decodeUnknownEffect(Dots.DeviceDelegationRead)(raw).pipe(Effect.mapError(() => fail("invalid_input", "Invalid device delegation inventory.")))
    const principal = yield* authorize(remoteSource)
    const checked = yield* checkedPrincipal(principal)
    const binding = yield* deviceBinding(sessionID)
    const scope = Hash.json([principal, sessionID, binding.id])
    const after = yield* decodeCursor(payload.cursor, scope)
    const matches = (yield* authority.grants(sessionID)).filter((grant) => Hash.json(grant.principal) === Hash.json(principal) && grant.id > after)
    const limit = payload.limit ?? 20
    const grants = matches.slice(0, limit).map((grant) => ({ ...grant, active: grant.active && grant.expiresAt > options.now() && grant.bindingID === binding.id }))
    if (!liveAuthorization(checked)) return yield* fail("authorization_failed", "The coordinator grant changed during the read.")
    return { binding: { id: binding.id, target: binding.target }, grants, ...(matches.length <= limit ? {} : { nextCursor: cursorFor(scope, grants.at(-1)!.id) }) }
  })
  const deviceDelegationCreate = Effect.fn("DotsExchange.deviceDelegationCreate")(function* (input: Dots.DeviceDelegationCreate & { readonly sessionID: Session.ID; readonly remoteSource: McpEvents.RequestContext }): Effect.fn.Return<Dots.DeviceDelegationInfo, DotsRuntime.Error> {
    const { sessionID, remoteSource, ...raw } = input
    const payload = yield* Schema.decodeUnknownEffect(Dots.DeviceDelegationCreate)(raw).pipe(Effect.mapError(() => fail("invalid_input", "Invalid device delegation enrollment.")))
    const principal = yield* authorize(remoteSource)
    const checked = yield* checkedPrincipal(principal)
    yield* deviceBinding(sessionID)
    const fingerprint = Hash.json(["create", payload, principal])
    return yield* DotsAuthority.withLock(sessionID)(options.withBinding(sessionID, (binding) => Effect.gen(function* () {
      if (binding.incarnation !== payload.bindingID || !DotsAuthority.sameTarget(binding.target, payload.expectedAttachment) || !liveAuthorization(checked)) return yield* fail("authorization_failed", "The bound conversation or OAuth grant changed.")
      const prior = yield* authority.mutation(sessionID, payload.exchangeID)
      const grants = yield* authority.grants(sessionID)
      if (prior) {
        if (prior.type !== EventRuntime.versionedType(Dots.DeviceDelegationCreated.type, 1) || prior.data.fingerprint !== fingerprint) return yield* fail("exchange_conflict", "The exchange ID already names another delegation mutation.")
        const grant = grants.find((grant) => grant.id === payload.id)
        if (!grant) return yield* fail("authorization_failed", "The recorded delegation is unavailable.")
        return grant
      }
      if (grants.some((grant) => grant.id === payload.id) || binding.grants.has(payload.id)) return yield* fail("exchange_conflict", "The delegation ID is already in use.")
      const grant: Dots.DeviceDelegationInfo = { id: payload.id, revision: 1, basis: "device", anchorSessionID: sessionID, bindingID: binding.incarnation, principal, scope: payload.scope, expiresAt: checked.expiresAt, active: true }
      const committed = yield* options.events.publishBatch([{ definition: Dots.DeviceDelegationCreated, data: { sessionID, exchangeID: payload.exchangeID, fingerprint, grant }, options: { id: DotsAuthority.mutationID(sessionID, payload.exchangeID) } }], { when: Effect.gen(function* () {
        const saved = yield* authority.binding(sessionID)
        const anchor = yield* options.sessions.get(sessionID).pipe(Effect.orDie)
        return liveAuthorization(checked) && saved?.id === binding.incarnation && anchor.time.archived === undefined
      }) })
      if (!committed.length) return yield* fail("authorization_failed", "The device delegation changed before enrollment.")
      return grant
    })))
  })
  const deviceDelegationRevoke = Effect.fn("DotsExchange.deviceDelegationRevoke")(function* (input: Dots.DeviceDelegationRevoke & { readonly sessionID: Session.ID; readonly remoteSource: McpEvents.RequestContext }): Effect.fn.Return<Dots.DeviceDelegationInfo, DotsRuntime.Error> {
    const { sessionID, remoteSource, ...raw } = input
    const payload = yield* Schema.decodeUnknownEffect(Dots.DeviceDelegationRevoke)(raw).pipe(Effect.mapError(() => fail("invalid_input", "Invalid device delegation revocation.")))
    const principal = yield* authorize(remoteSource)
    const checked = yield* checkedPrincipal(principal)
    yield* deviceBinding(sessionID)
    const fingerprint = Hash.json(["revoke", payload, principal])
    return yield* DotsAuthority.withLock(sessionID)(options.withBinding(sessionID, (binding) => Effect.gen(function* () {
      if (binding.incarnation !== payload.bindingID || !DotsAuthority.sameTarget(binding.target, payload.expectedAttachment) || !liveAuthorization(checked)) return yield* fail("authorization_failed", "The bound conversation or OAuth grant changed.")
      const prior = yield* authority.mutation(sessionID, payload.exchangeID)
      const grant = (yield* authority.grants(sessionID)).find((grant) => grant.id === payload.id && Hash.json(grant.principal) === Hash.json(principal))
      if (!grant || grant.bindingID !== binding.incarnation) return yield* fail("authorization_failed", "The device delegation is unavailable.")
      if (prior) {
        if (prior.type !== EventRuntime.versionedType(Dots.DeviceDelegationRevoked.type, 1) || prior.data.fingerprint !== fingerprint) return yield* fail("exchange_conflict", "The exchange ID already names another delegation mutation.")
        return grant
      }
      if (grant.revision !== payload.revision) return yield* fail("exchange_conflict", "The device delegation revision changed.")
      const revision = grant.revision + 1
      const committed = yield* options.events.publishBatch([{ definition: Dots.DeviceDelegationRevoked, data: { sessionID, exchangeID: payload.exchangeID, fingerprint, delegationID: grant.id, revision, principal }, options: { id: DotsAuthority.mutationID(sessionID, payload.exchangeID) } }], { when: Effect.gen(function* () {
        const saved = yield* authority.binding(sessionID)
        return saved?.id === binding.incarnation && liveAuthorization(checked)
      }) })
      if (!committed.length) return yield* fail("authorization_failed", "The bound conversation changed before revocation.")
      return { ...grant, revision, active: false }
    })))
  })
  const routineGrant = Effect.fn("DotsExchange.routineGrant")(function* (binding: DotsRuntime.BindingAuthority, value: Dots.RoutineReceipt, principal: McpEvents.Principal, targetSessionID: Session.ID) {
    const grant = binding.grants.get(value.delegation.id)
    if (!grant || "basis" in grant.info || grant.info.revision !== value.delegation.revision || grant.info.taskInputID !== value.taskInputID || grant.info.targetSessionID !== targetSessionID || Hash.json(grant.info.principal) !== Hash.json(principal))
      return yield* fail("authorization_failed", "The routine delegation does not match this authenticated task.")
    if (!grant.info.scope.operations.includes(value.instruction.operation) || (value.instruction.operation === "presentation" &&
      ((value.instruction.preferences.format !== undefined && !grant.info.scope.format?.includes(value.instruction.preferences.format)) ||
       (value.instruction.preferences.detail !== undefined && !grant.info.scope.detail?.includes(value.instruction.preferences.detail)))))
      return yield* fail("target_forbidden", "The routine operation is outside the approved scope.")
    return yield* localGrant(binding, grant)
  })
  const delegatedGrant = Effect.fn("DotsExchange.delegatedGrant")(function* (binding: DotsRuntime.BindingAuthority, value: Dots.DelegatedReceipt, principal: McpEvents.Principal, targetSessionID: Session.ID) {
    const grant = binding.grants.get(value.delegation.id)
    if (!grant || !("basis" in grant.info) || grant.info.revision !== value.delegation.revision || grant.info.targetSessionID !== targetSessionID || Hash.json(grant.info.principal) !== Hash.json(principal))
      return yield* fail("authorization_failed", "The session delegation does not match this authenticated invocation.")
    if (!grant.info.scope.operations.includes(value.instruction.operation))
      return yield* fail("target_forbidden", "The delegated operation is outside the approved scope.")
    return yield* localGrant(binding, grant)
  })
  const assistantsFor = Effect.fn("DotsExchange.assistantsFor")(function* (targetSessionID: Session.ID, inputID: SessionMessage.ID) {
    const promoted = yield* options.db.select({ seq: EventTable.seq }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, targetSessionID), eq(EventTable.type, promotedType), sql`json_extract(${EventTable.data}, '$.inputID') = ${inputID}`,
    )).orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    if (!promoted) return new Set<string>()
    const next = yield* options.db.select({ seq: EventTable.seq }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, targetSessionID), eq(EventTable.type, promotedType), gt(EventTable.seq, promoted.seq),
    )).orderBy(asc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    const rows = yield* options.db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).where(and(
      eq(SessionMessageTable.session_id, targetSessionID), eq(SessionMessageTable.type, "assistant"),
      gt(SessionMessageTable.seq, promoted.seq), next ? lt(SessionMessageTable.seq, next.seq) : undefined,
    )).limit(64).all().pipe(Effect.orDie)
    return new Set(rows.map((row) => row.id as string))
  })
  const inputForAssistant = Effect.fn("DotsExchange.inputForAssistant")(function* (targetSessionID: Session.ID, sourceMessageID: string) {
    const assistant = yield* options.db.select({ seq: SessionMessageTable.seq }).from(SessionMessageTable).where(and(
      eq(SessionMessageTable.session_id, targetSessionID), eq(SessionMessageTable.type, "assistant"), eq(SessionMessageTable.id, SessionMessage.ID.make(sourceMessageID)),
    )).limit(1).get().pipe(Effect.orDie)
    if (!assistant) return undefined
    const promoted = yield* options.db.select({ data: EventTable.data }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, targetSessionID), eq(EventTable.type, promotedType), lt(EventTable.seq, assistant.seq),
    )).orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    if (!promoted) return undefined
    return Schema.decodeUnknownSync(SessionEvent.InputPromoted.data)(promoted.data).inputID
  })
  const eligibleDecision = (pending: PendingDecision, assistants: ReadonlySet<string>) => {
    if (pending.delegatedEligible === false) return false
    if (pending.sourceMessageID === undefined || !assistants.has(pending.sourceMessageID)) return false
    if (pending.kind === "permission")
      return CoordinationDecisions.explicitDecisionReason({ kind: "permission", action: pending.action, resources: pending.resources, metadata: pending.metadata }) === undefined
    if (pending.kind === "guardrail")
      return pending.standard && pending.hardReview !== true && pending.ruleIDs.every((rule) => rule.startsWith("standard.")) &&
        CoordinationDecisions.explicitDecisionReason({ kind: "review", action: pending.action, resources: pending.resources, ruleIDs: pending.ruleIDs, hardReview: pending.hardReview }) === undefined
    if (pending.kind === "form")
      return pending.fields.every((field) => field.type !== "external") &&
        CoordinationDecisions.explicitDecisionReason({ kind: "question", resources: [pending.title, ...pending.fields.flatMap((field) => [field.key, field.title ?? "", field.description ?? ""])], metadata: pending.metadata }) === undefined
    return pending.kind === "question" && CoordinationDecisions.explicitDecisionReason({ kind: "question", resources: pending.questions.flatMap((item) => [item.question, item.header, ...item.options.map((option) => option.label)]) }) === undefined
  }
  const decisionTargetOf = (pending: PendingDecision): Dots.DecisionTarget =>
    pending.kind === "permission" ? { kind: "permission", requestID: Permission.ID.create(pending.requestID), fingerprint: pending.fingerprint }
      : pending.kind === "guardrail" ? { kind: "guardrail", requestID: Guardrail.RequestID.create(pending.requestID), fingerprint: pending.fingerprint }
        : pending.kind === "form" ? { kind: "form", formID: Form.ID.create(pending.formID), fingerprint: pending.fingerprint }
          : pending.kind === "question" ? { kind: "question", requestID: Question.ID.ascending(pending.requestID), fingerprint: pending.fingerprint }
            : pending.kind === "subagent_question" ? { kind: "subagent_question", questionID: pending.task.question!.id, fingerprint: pending.fingerprint }
              : { kind: "review", itemID: pending.item.itemID, fingerprint: pending.fingerprint }
  const candidateOf = (pending: PendingDecision): Dots.DecisionCandidate => ({
    target: decisionTargetOf(pending),
    ...(pending.kind === "permission" ? { action: pending.action.slice(0, 256), resources: pending.resources.slice(0, 20).map((item) => item.slice(0, 1000)) } : {}),
    ...(pending.kind === "guardrail" ? { action: pending.action.slice(0, 256), resources: pending.resources.slice(0, 20).map((item) => item.slice(0, 1000)), ruleIDs: pending.ruleIDs.slice(0, 20).map((item) => item.slice(0, 256)) } : {}),
    ...(pending.kind === "form" ? { title: pending.title.slice(0, 256), fields: pending.fields } : {}),
    ...(pending.kind === "question" ? { questions: [...pending.questions] } : {}),
    ...(pending.kind === "subagent_question" ? { subagentQuestion: pending.task.question } : {}),
    ...(pending.kind === "review" ? { review: pending.item } : {}),
  })
  const pendingDecisions = Effect.fn("DotsExchange.pendingDecisions")(function* (targetSessionID: Session.ID) {
    if (!options.decisions) return [] as ReadonlyArray<PendingDecision>
    return yield* options.decisions.pending(targetSessionID).pipe(
      Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(fail("authorization_failed", "Pending native decisions are unavailable."))),
    )
  })
  const decisionsList = Effect.fn("DotsExchange.decisionsList")(function* (input: Dots.DecisionsList & { readonly sessionID: Session.ID; readonly remoteSource: McpEvents.RequestContext }): Effect.fn.Return<Dots.DecisionsPage, DotsRuntime.Error> {
    const { sessionID, remoteSource, ...raw } = input
    const payload = yield* Schema.decodeUnknownEffect(Dots.DecisionsList)(raw).pipe(Effect.mapError(() => fail("invalid_input", "Invalid native decision inventory.")))
    const principal = yield* authorize(remoteSource)
    const checked = yield* checkedPrincipal(principal)
    const inventory = Hash.json([principal, sessionID, payload.bindingID, payload.delegation, payload.targetSessionID])
    const after = yield* decodeCursor(payload.cursor, inventory)
    const limit = payload.limit ?? 20
    const validate = () => options.withBinding(sessionID, (binding) => Effect.gen(function* () {
      if (binding.incarnation !== payload.bindingID || !DotsAuthority.sameTarget(binding.target, payload.expectedAttachment) || !liveAuthorization(checked)) return yield* fail("authorization_failed", "The authenticated device scope changed.")
      if (!(yield* deviceGrant(binding, payload.delegation, principal, "decision", sessionID))) return yield* fail("authorization_failed", "A device-wide decision delegation is required.")
      yield* deviceBindingAnchor()
    }))
    const deviceBindingAnchor = () => options.sessions.get(sessionID).pipe(Effect.mapError(() => fail("session_not_found", "The attachment Session does not exist.")), Effect.flatMap((anchor) => anchor.time.archived === undefined && anchor.parentID === undefined ? Effect.void : Effect.fail(fail("target_forbidden", "The attachment Session is unavailable."))))
    yield* validate()
    if (payload.targetSessionID) yield* scope(sessionID, payload.targetSessionID, true)
    const data: Array<{ targetSessionID: Session.ID; candidate: Dots.DecisionCandidate; key: string }> = []
    let scanAfter: Session.ID | undefined
    while (true) {
      const rows = yield* options.db.select({ id: SessionTable.id }).from(SessionTable).where(and(
        isNull(SessionTable.time_archived), payload.targetSessionID ? eq(SessionTable.id, payload.targetSessionID) : undefined,
        scanAfter === undefined ? sql`${SessionTable.id} >= ${after.split("\0")[0] ?? ""}` : gt(SessionTable.id, scanAfter),
      )).orderBy(asc(SessionTable.id)).limit(64).all().pipe(Effect.orDie)
      for (const row of rows) {
        const current = yield* scope(sessionID, row.id, true).pipe(Effect.result)
        if (current._tag === "Failure") continue
        const candidates = (yield* pendingDecisions(row.id)).map((pending) => ({ targetSessionID: row.id, candidate: candidateOf(pending), key: `${row.id}\0${Hash.json(decisionTargetOf(pending))}` }))
          .filter((entry) => entry.key > after).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
        data.push(...candidates.slice(0, limit + 1 - data.length))
        if (data.length > limit) {
          yield* validate()
          return { data: data.slice(0, limit).map(({ targetSessionID, candidate }) => ({ targetSessionID, candidate })), nextCursor: cursorFor(inventory, data[limit - 1]!.key) }
        }
      }
      if (rows.length < 64 || payload.targetSessionID !== undefined) break
      scanAfter = rows.at(-1)!.id
      yield* Effect.yieldNow
    }
    yield* validate()
    return { data: data.map(({ targetSessionID, candidate }) => ({ targetSessionID, candidate })) }
  })
  const decisionCandidates = Effect.fn("DotsExchange.decisionCandidates")(function* (value: Dots.ExchangeRecord) {
    if (!value.delegated || value.delegated.instruction.operation !== "task") return [] as Dots.DecisionCandidate[]
    const device = (yield* authority.grants(value.sessionID)).find((grant) => grant.id === value.delegated!.delegation.id)
    if (device) {
      const valid = yield* options.withBinding(value.sessionID, (binding) => deviceGrant(binding, value.delegated!.delegation, device.principal, "decision", value.sessionID)).pipe(Effect.result)
      if (valid._tag === "Failure") return [] as Dots.DecisionCandidate[]
      return (yield* pendingDecisions(value.targetSessionID)).slice(0, 20).map(candidateOf)
    }
    const grant = yield* options.withBinding(value.sessionID, (binding) => Effect.succeed(binding.grants.get(value.delegated!.delegation.id))).pipe(Effect.result)
    if (grant._tag === "Failure" || !grant.success || !("basis" in grant.success.info) || grant.success.info.revision !== value.delegated.delegation.revision || !grant.success.info.scope.operations.includes("decision") || !grant.success.info.active || grant.success.info.expiresAt <= options.now())
      return [] as Dots.DecisionCandidate[]
    const assistants = yield* assistantsFor(value.targetSessionID, value.inputID)
    const pending = yield* pendingDecisions(value.targetSessionID).pipe(Effect.result)
    if (pending._tag === "Failure") return [] as Dots.DecisionCandidate[]
    return pending.success.filter((item) => eligibleDecision(item, assistants)).slice(0, 20).map(candidateOf)
  })
  const decisionOutcomeOf = Effect.fn("DotsExchange.decisionOutcomeOf")(function* (value: Dots.ExchangeRecord) {
    if (!value.delegated || value.delegated.instruction.operation !== "decision") return undefined
    const instruction = value.delegated.instruction
    const reply = "reply" in instruction ? { reply: instruction.reply } : {}
    if (!options.decisions) return { target: instruction.target, state: "unknown" as const, ...reply }
    const receiptRow = yield* options.db.select({ data: EventTable.data }).from(EventTable).where(and(
      eq(EventTable.aggregate_id, value.targetSessionID), eq(EventTable.type, EventRuntime.versionedType(SessionEvent.DotsDecisionSettled.type, 1)),
      sql`json_extract(${EventTable.data}, '$.source.exchangeID') = ${value.exchangeID}`,
      sql`json_extract(${EventTable.data}, '$.source.anchorSessionID') = ${value.sessionID}`,
      sql`json_extract(${EventTable.data}, '$.source.delegationID') = ${value.delegated.delegation.id}`,
      sql`json_extract(${EventTable.data}, '$.source.revision') = ${value.delegated.delegation.revision}`,
    )).limit(1).get().pipe(Effect.orDie)
    const receipt = receiptRow ? Schema.decodeUnknownSync(SessionEvent.DotsDecisionSettled.data)(receiptRow.data) : undefined
    if (receipt && Hash.json(receipt.target) === Hash.json(instruction.target)) return { target: instruction.target, state: "settled" as const, ...reply }
    const pending = yield* pendingDecisions(value.targetSessionID).pipe(Effect.result)
    if (pending._tag === "Failure") return { target: instruction.target, state: "unknown" as const, ...reply }
    const found = pending.success.find((item) => Hash.json(decisionTargetOf(item)) === Hash.json(instruction.target))
    const sameKind = pending.success.find((item) => {
      const target = decisionTargetOf(item)
      return Hash.json({ ...target, fingerprint: "" }) === Hash.json({ ...instruction.target, fingerprint: "" })
    })
    return { target: instruction.target, state: found ? "pending" as const : sameKind ? "stale" as const : "unknown" as const, ...reply }
  })
  const sessionDelegationCreate = Effect.fn("DotsExchange.sessionDelegationCreate")(function* (input: Dots.SessionDelegationCreate & { readonly sessionID: Session.ID }) {
    const { sessionID, ...raw } = input
    const payload = yield* Schema.decodeUnknownEffect(Dots.SessionDelegationCreate)(raw).pipe(Effect.mapError(() => fail("invalid_input", "Invalid native delegation proposal.")))
    const source = yield* record(sessionID, payload.sourceExchangeID)
    if (!source || source.targetSessionID !== payload.targetSessionID) return yield* fail("target_forbidden", "Select an authenticated exchange for this exact target.")
    const principal = { ...source.source.principal, epoch: source.source.epoch, grantID: source.grantID }
    yield* checkedPrincipal(principal)
    yield* checkFences(source, source.source)
    const current = yield* nativeFence(sessionID, payload.targetSessionID)
    const proposal = yield* options.withBinding(sessionID, (binding) => Effect.gen(function* () {
      if ((yield* authority.grants(sessionID)).some((grant) => grant.id === payload.proposalID)) return yield* fail("exchange_conflict", "The delegation ID already names a device delegation.")
      if (Hash.json(identity(binding.target)) !== Hash.json(identity(payload.expectedAttachment))) return yield* fail("target_changed", "The attachment changed.")
      const fingerprint = Hash.json([{ ...payload, expectedAttachment: identity(payload.expectedAttachment) }, binding.incarnation, binding.accountDigest, principal, current])
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
      yield* options.approve({ sessionID, action: "dots_delegate", resources: [Hash.json([sessionID, payload.targetSessionID, "session", proposal.pending.fingerprint])], requireExplicitDecision: true,
        metadata: Dots.SessionDelegationReview.make({ kind: "dots-session-delegation", proposalID: payload.proposalID, sourceExchangeID: source.exchangeID,
          principal, targetSessionID: payload.targetSessionID, expectedAttachment: source.expectedAttachment,
          scope: payload.scope, expiresAt: payload.expiresAt, lifetime: "binding", fingerprint: proposal.pending.fingerprint }) })
      const checked = yield* checkedPrincipal(principal)
      yield* checkFences(source, source.source)
      return yield* SessionPending.withInboxLock(payload.targetSessionID)(options.withBinding(sessionID, (binding) => owned(current.nativeScope, Effect.gen(function* () {
        if (!liveAuthorization(checked)) return yield* fail("authorization_failed", "The coordinator grant changed during native approval.")
        const info: Dots.SessionDelegationInfo = { id: payload.proposalID, revision: 1, sourceExchangeID: payload.sourceExchangeID, targetSessionID: payload.targetSessionID,
          basis: "session", principal, scope: payload.scope, expiresAt: payload.expiresAt, active: true }
        const grant: DotsRuntime.DelegationGrant = { info, anchorSessionID: sessionID, bindingID: proposal.bindingID, accountDigest: proposal.accountDigest,
          target: source.expectedAttachment, ...current }
        yield* localGrant(binding, grant)
        binding.grants.set(info.id, grant)
        return info as Dots.DelegationInfo
      }))))
    })
    return yield* activate.pipe(Effect.onExit((exit) => Deferred.done(proposal.pending.result, exit)))
  })
  const delegationCreate = Effect.fn("DotsExchange.delegationCreate")(function* (input: Dots.DelegationCreate & { readonly sessionID: Session.ID }) {
    if ("basis" in input) return yield* sessionDelegationCreate(input as Dots.SessionDelegationCreate & { readonly sessionID: Session.ID })
    const { sessionID, ...raw } = input
    const payload = yield* Schema.decodeUnknownEffect(Dots.DelegationCreate)(raw).pipe(Effect.mapError(() => fail("invalid_input", "Invalid native delegation proposal.")))
    if ("basis" in payload) return yield* fail("invalid_input", "Invalid native delegation proposal.")
    if ((yield* authority.grants(sessionID)).some((grant) => grant.id === payload.proposalID)) return yield* fail("exchange_conflict", "The delegation ID already names a device delegation.")
    const source = yield* record(sessionID, payload.sourceExchangeID)
    if (!source || source.targetSessionID !== payload.targetSessionID) return yield* fail("target_forbidden", "Select an authenticated exchange for this exact target.")
    const principal = { ...source.source.principal, epoch: source.source.epoch, grantID: source.grantID }
    yield* checkedPrincipal(principal)
    yield* checkFences(source, source.source)
    const selected = yield* task(payload.targetSessionID)
    if (selected.taskInputID !== payload.taskInputID) return yield* fail("target_forbidden", "The selected input is not the current direct task.")
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
      yield* options.approve({ sessionID, action: "dots_delegate", resources: [Hash.json([sessionID, payload.targetSessionID, payload.taskInputID, proposal.pending.fingerprint])], requireExplicitDecision: true,
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
    const delegated = value.delegated?.instruction.operation === "task" ? value.delegated : undefined
    if (!value.routine && !delegated) return yield* promote()
    const routine = value.routine
    const principal = { ...value.source.principal, epoch: value.source.epoch, grantID: value.grantID }
    const check = (binding: DotsRuntime.BindingAuthority) => delegated
      ? deviceGrant(binding, delegated.delegation, principal, "task", value.sessionID).pipe(Effect.flatMap((grant) => grant ? Effect.void : delegatedGrant(binding, delegated, principal, value.targetSessionID).pipe(Effect.asVoid)))
      : routineGrant(binding, routine!, principal, value.targetSessionID).pipe(Effect.asVoid)
    let promoting = false
    const result = yield* checkedPrincipal(principal).pipe(Effect.flatMap((checked) => checkFences(value, value.source).pipe(Effect.andThen(
      options.withBinding(value.sessionID, (binding) => owned(value.scope, Effect.gen(function* () {
        if (!liveAuthorization(checked)) return yield* fail("authorization_failed", "The coordinator grant changed before promotion.")
        yield* check(binding)
        promoting = true
        return yield* promote(check(binding).pipe(Effect.match({ onFailure: () => false, onSuccess: () => liveAuthorization(checked) })))
      }))),
    ))), Effect.result)
    if (result._tag === "Success" && result.success) return true
    if (result._tag === "Failure" && promoting) return yield* Effect.fail(result.failure)
    yield* options.events.publish(SessionEvent.DotsInstructionRejected, { sessionID: entry.sessionID, inputID: entry.id, anchorSessionID: value.sessionID,
      exchangeID: value.exchangeID, delegationID: delegated ? delegated.delegation.id : routine!.delegation.id, reason: "delegation_invalid" })
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

  const project = Effect.fn("DotsExchange.project")(function* (value: Dots.ExchangeRecord): Effect.fn.Return<Dots.Exchange, DotsRuntime.Error> {
    const decisions = yield* decisionCandidates(value)
    const decisionOutcome = yield* decisionOutcomeOf(value)
    const base = { exchangeID: value.exchangeID, sessionID: value.sessionID, targetSessionID: value.targetSessionID, inputID: value.inputID, channel: "task" as const, envelope: taskEnvelope(value),
      ...(value.delegated?.instruction.operation === "task" ? { decisions } : {}), ...(decisionOutcome === undefined ? {} : { decisionOutcome }) }
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
    if (!("taskInputID" in payload) || payload.taskInputID === undefined || !("delegation" in payload) || payload.delegation === undefined || !("instruction" in payload) || payload.instruction === undefined ||
      (payload.instruction.operation !== "continue" && payload.instruction.operation !== "presentation"))
      return yield* fail("invalid_input", "A routine instruction requires a delegation.")
    const routineInstruction: Dots.RoutineInstruction = payload.instruction.operation === "continue" ? { operation: "continue" } : { operation: "presentation", preferences: payload.instruction.preferences }
    const routine: Dots.RoutineReceipt = { delegation: payload.delegation, taskInputID: payload.taskInputID, instruction: routineInstruction }
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
        const text = routineInstruction.operation === "continue"
          ? "Continue the existing direct task. Preserve its scope, remaining step allowance, permissions and pending explicit decisions."
          : `Present the existing direct task using these approved preferences: ${JSON.stringify(routineInstruction.preferences)}. Preserve its objective, permissions and pending explicit decisions.`
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

  const findDecision = Effect.fn("DotsExchange.findDecision")(function* (value: Dots.ExchangeRecord) {
    if (!value.delegated || value.delegated.instruction.operation !== "decision" || !options.decisions)
      return yield* fail("target_forbidden", "Delegated decisions are unavailable.")
    const instruction = value.delegated.instruction
    const pending = yield* pendingDecisions(value.targetSessionID)
    const found = pending.find((item) => Hash.json(decisionTargetOf(item)) === Hash.json(instruction.target))
    if (!found) {
      if (pending.some((item) => Hash.json({ ...decisionTargetOf(item), fingerprint: "" }) === Hash.json({ ...instruction.target, fingerprint: "" }))) return yield* fail("exchange_conflict", "The native decision changed since it was listed.")
      return yield* fail("target_forbidden", "The native decision does not exist or is not eligible for delegated settlement.")
    }
    const device = (yield* authority.grants(value.sessionID)).some((grant) => grant.id === value.delegated!.delegation.id)
    const sourceInputID = found.sourceMessageID === undefined ? undefined : yield* inputForAssistant(value.targetSessionID, found.sourceMessageID)
    const sourceRecord = sourceInputID === undefined ? undefined : yield* options.db.select({ data: EventTable.data }).from(EventTable).where(and(eq(EventTable.type, createdType),
      sql`json_extract(${EventTable.data}, '$.targetSessionID') = ${value.targetSessionID}`,
      sql`json_extract(${EventTable.data}, '$.inputID') = ${sourceInputID}`)).limit(1).get().pipe(Effect.orDie)
    const taskRecord = sourceRecord ? Schema.decodeUnknownSync(Dots.ExchangeRecord)(sourceRecord.data) : undefined
    const assistants = taskRecord === undefined ? new Set<string>() : yield* assistantsFor(value.targetSessionID, taskRecord.inputID)
    if (!device && (taskRecord?.delegated?.instruction.operation !== "task" || taskRecord.sessionID !== value.sessionID || taskRecord.grantID !== value.grantID ||
      taskRecord.accountDigest !== value.accountDigest || Hash.json(identity(taskRecord.expectedAttachment)) !== Hash.json(identity(value.expectedAttachment)) ||
      Hash.json(taskRecord.source.principal) !== Hash.json(value.source.principal) || taskRecord.source.epoch !== value.source.epoch ||
      taskRecord.delegated.delegation.id !== value.delegated.delegation.id ||
      taskRecord.delegated.delegation.revision !== value.delegated.delegation.revision || !eligibleDecision(found, assistants)))
      return yield* fail("target_forbidden", "The native decision is not eligible for delegated settlement.")
    if ((found.kind === "permission" || found.kind === "guardrail") && "reply" in instruction && instruction.reply === "once") {
      for (const resource of found.resources) {
        const effect = yield* options.decisions.permissionEffect(value.targetSessionID, found.action, resource).pipe(
          Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(fail("authorization_failed", "Native permission rules are unavailable."))),
        )
        if (effect === "deny") return yield* fail("target_forbidden", "A native permission rule denies this action.")
      }
    }
    return found
  })
  const settleDecision = Effect.fn("DotsExchange.settleDecision")(function* (value: Dots.ExchangeRecord, validate: () => Effect.Effect<boolean>, device?: Dots.DeviceDelegationInfo) {
    if (!value.delegated || value.delegated.instruction.operation !== "decision" || !options.decisions)
      return yield* fail("target_forbidden", "Delegated decisions are unavailable.")
    const instruction = value.delegated.instruction
    const found = yield* findDecision(value)
    const source: Form.ExternalReplySource = device
      ? { kind: "dots-client", anchorSessionID: value.sessionID, bindingID: device.bindingID, delegationID: device.id, revision: device.revision, exchangeID: value.exchangeID, principal: device.principal }
      : { kind: "dots-delegation", anchorSessionID: value.sessionID, delegationID: value.delegated.delegation.id, revision: value.delegated.delegation.revision, exchangeID: value.exchangeID }
    const { operation: _operation, target: _target, ...choice } = instruction
    yield* options.decisions.settle({ pending: found, choice, source, ...(device ? { explicitDecision: true as const } : {}), validate }).pipe(
      Effect.catchDefect(() => Effect.fail(fail("exchange_outcome_unknown", "The decision outcome could not be confirmed; read the same exchange before another mutation."))),
      Effect.mapError((error) => error instanceof DotsRuntime.Error ? error : fail("invalid_input", "The native validator rejected this decision.")),
    )
    return "settled" as const
  })
  const createDelegated = Effect.fn("DotsExchange.createDelegated")(function* (input: Dots.ExchangeCreate & { readonly sessionID: Session.ID; readonly remoteSource: McpEvents.RequestContext }) {
    const { sessionID, remoteSource, ...raw } = input
    const payload = yield* Schema.decodeUnknownEffect(Dots.ExchangeCreate)(raw, { onExcessProperty: "error" }).pipe(Effect.mapError(() => fail("invalid_input", "Invalid delegated instruction.")))
    if (!("instruction" in payload) || !("delegation" in payload) || payload.delegation === undefined || !("operation" in payload.instruction) || (payload.instruction.operation !== "task" && payload.instruction.operation !== "decision"))
      return yield* fail("invalid_input", "A delegated instruction requires a session delegation.")
    const receipt: Dots.DelegatedReceipt = { delegation: payload.delegation, instruction: payload.instruction }
    const principal = yield* authorize(remoteSource)
    const checked = yield* checkedPrincipal(principal)
    const attachment = yield* options.attachment(sessionID)
    if (Hash.json(identity(attachment.target)) !== Hash.json(identity(payload.expectedAttachment))) return yield* fail("target_changed", "The confirmed attachment changed.")
    const isDevice = (yield* authority.grants(sessionID)).some((grant) => grant.id === receipt.delegation.id)
    const current = yield* scope(sessionID, payload.targetSessionID, isDevice && receipt.instruction.operation === "decision")
    const fingerprint = Hash.json({ ...payload, expectedAttachment: identity(payload.expectedAttachment), source: principal })
    const admission = Effect.gen(function* () {
      const committed = yield* options.withBinding(sessionID, (binding) => owned(current, Effect.gen(function* () {
        if (!liveAuthorization(checked)) return yield* fail("authorization_failed", "The coordinator grant changed before admission.")
        const device = yield* deviceGrant(binding, receipt.delegation, principal, receipt.instruction.operation, sessionID)
        if (!device) yield* delegatedGrant(binding, receipt, principal, payload.targetSessionID)
        const prior = yield* record(sessionID, payload.exchangeID)
        if (prior) {
          if (prior.fingerprint !== fingerprint) return yield* fail("exchange_conflict", "The exchange ID already names another delegated instruction.")
          return { value: prior, fresh: false }
        }
        const value: Dots.ExchangeRecord = { exchangeID: payload.exchangeID, sessionID, targetSessionID: payload.targetSessionID,
          inputID: SessionMessage.ID.make(`msg_dots_${Hash.json([sessionID, payload.exchangeID])}`), expectedAttachment: binding.target,
          accountDigest: binding.accountDigest, fingerprint, source: remoteSource, scope: current, grantID: principal.grantID, delegated: receipt }
        const guard = Effect.gen(function* () {
          const live = yield* checkedPrincipal(principal)
          yield* checkFences(value, remoteSource)
          if (device) yield* deviceGrant(binding, receipt.delegation, principal, receipt.instruction.operation, sessionID)
          if (!device) yield* delegatedGrant(binding, receipt, principal, payload.targetSessionID)
          return liveAuthorization(checked) && liveAuthorization(live)
        }).pipe(Effect.match({ onFailure: () => false, onSuccess: (allowed) => allowed }))
        if (receipt.instruction.operation === "decision") {
          yield* findDecision(value)
          const published = yield* options.events.publishBatch([
            { definition: SessionEvent.DotsExchangeCreated, data: value, options: { id: recordID(sessionID, payload.exchangeID) } },
          ], { when: guard })
          if (!published.length) return yield* fail("authorization_failed", "The session delegation changed before admission.")
          yield* settleDecision(value, () => guard, device)
          return { value, fresh: false }
        }
        const published = yield* options.events.publishBatch([
          { definition: SessionEvent.DotsExchangeCreated, data: value, options: { id: recordID(sessionID, payload.exchangeID) } },
          { definition: SessionEvent.InputAdmitted, data: { sessionID: payload.targetSessionID, inputID: value.inputID,
            input: SessionPending.Message.make({ type: "user", delivery: payload.delivery, data: { text: receipt.instruction.text, metadata: {
              inputOrigin: "plugin", remoteMcp: remoteSource,
              dotsExchange: Dots.ExchangeMetadata.make({ exchangeID: value.exchangeID, sessionID, targetSessionID: value.targetSessionID,
                attachment: value.expectedAttachment, envelope: taskEnvelope(value), delegated: receipt }),
            } } }) } },
        ], { when: guard })
        if (!published.length) return yield* fail("authorization_failed", "The session delegation changed before admission.")
        return { value, fresh: true }
      })))
      if (committed.fresh) yield* options.execution.wake(committed.value.targetSessionID)
      return yield* project(committed.value)
    })
    return yield* lock.withLock(recordID(sessionID, payload.exchangeID))(
      receipt.instruction.operation === "decision" ? admission : SessionPending.withInboxLock(payload.targetSessionID)(admission),
    )
  })

  return {
    delegationCreate,
    deviceDelegationRead,
    deviceDelegationCreate,
    deviceDelegationRevoke,
    decisionsList,
    promoteRoutine,
    currentRoutine: (sessionID: Session.ID) => activeRecord(sessionID).pipe(Effect.map((active) => active.record.routine), Effect.catch(() => Effect.succeed(undefined))),
    currentDelegated: (sessionID: Session.ID) => activeRecord(sessionID).pipe(Effect.map((active) => active.record.delegated), Effect.catch(() => Effect.succeed(undefined))),
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
      if (input.delegation !== undefined && "instruction" in input && (input.instruction.operation === "task" || input.instruction.operation === "decision")) return yield* createDelegated(input)
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
  const guardrail = yield* SessionGuardrail.Service
  const forms = yield* Form.Service
  const questions = yield* Question.Service
  const reviews = yield* SessionReview.Service
  const orchestration = yield* SessionOrchestration.Service
  const runtimeFor = (sessionID: Session.ID) => Effect.gen(function* () {
    const session = yield* sessions.get(sessionID).pipe(Effect.mapError(() => fail("session_not_found", "The attachment Session does not exist.")))
    if (session.location.directory === currentLocation.directory && session.location.workspaceID === currentLocation.workspaceID) return dots
    return yield* DotsRuntime.Service.pipe(Effect.provide(locations.get(session.location)), Effect.mapError(() => fail("connection_unavailable", "The attachment Location is unavailable.")))
  })
  const servicesFor = (sessionID: Session.ID) => Effect.gen(function* () {
    const session = yield* sessions.get(sessionID).pipe(Effect.mapError(() => fail("session_not_found", "The target Session does not exist.")))
    if (session.location.directory === currentLocation.directory && session.location.workspaceID === currentLocation.workspaceID)
      return { permission, guardrail, forms, questions, reviews, orchestration, sessions }
    const layer = locations.get(session.location)
    return {
      permission: yield* Permission.Service.pipe(Effect.provide(layer)),
      guardrail: yield* SessionGuardrail.Service.pipe(Effect.provide(layer)),
      forms: yield* Form.Service.pipe(Effect.provide(layer)),
      questions: yield* Question.Service.pipe(Effect.provide(layer)),
      reviews,
      orchestration,
      sessions,
    }
  })
  return make({ db: database.db, events, sessions, coordination, execution, attachment: attachmentForSession({ sessions, currentLocation, current: dots,
    runtimeAt: (location) => DotsRuntime.Service.pipe(Effect.provide(locations.get(location)), Effect.mapError(() => fail("connection_unavailable", "The attachment Location is unavailable."))),
  }),
    withBinding: (sessionID, use) => runtimeFor(sessionID).pipe(Effect.flatMap((runtime) => runtime.withBinding(sessionID, use))),
    approve: (input) => permission.assert(input).pipe(Effect.mapError(() => fail("authorization_failed", "An explicit native approval is required to activate delegation."))),
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
    decisions: {
      pending: (sessionID) => servicesFor(sessionID).pipe(Effect.flatMap((services) => decisionServices(services).pending(sessionID))),
      permissionEffect: (sessionID, action, resource) => servicesFor(sessionID).pipe(Effect.flatMap((services) => decisionServices(services).permissionEffect(sessionID, action, resource))),
      settle: (input) => servicesFor(input.pending.sessionID).pipe(Effect.flatMap((services) => decisionServices(services).settle(input))),
    },
  })
})
