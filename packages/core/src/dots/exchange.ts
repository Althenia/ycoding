export * as DotsExchange from "./exchange"

import { Dots } from "@ycoding-ai/schema/dots"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm"
import { Cause, Clock, Effect, Schema } from "effect"
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
import { SessionMessageTable, SessionProviderRequestTable } from "../session/sql"
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
  readonly checkStored: (principal: McpEvents.Principal) => Effect.Effect<void, unknown>
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

  return {
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
      const principal = yield* authorize(input.remoteSource)
      if (["envelope", "grantID", "origin", "coordinator", "scope"].some((key) => key in input))
        return yield* fail("invalid_input", "Routing identity is supplied only by the authenticated adapter.")
      const payload = yield* Schema.decodeUnknownEffect(Dots.ExchangeCreate)(input).pipe(Effect.mapError(() => fail("invalid_input", "Invalid Dots exchange.")))
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
  return make({ db: database.db, events, sessions, coordination, execution, attachment: attachmentForSession({ sessions, currentLocation, current: dots,
    runtimeAt: (location) => DotsRuntime.Service.pipe(Effect.provide(locations.get(location)), Effect.mapError(() => fail("connection_unavailable", "The attachment Location is unavailable."))),
  }),
    checkStored: (principal) => authorization.check(principal).pipe(Effect.flatMap((checked) =>
      checked.expiresAt > Date.now() && checked.signal?.aborted !== true
        ? Effect.void
        : Effect.fail(fail("authorization_failed", "The coordinator grant is unavailable.")))),
    authorize: (source) => Effect.gen(function* () {
      const grant = yield* authorization.resolve(source)
      if (grant.expiresAt <= (yield* Clock.currentTimeMillis)) return yield* fail("authorization_failed", "The remote grant expired.")
      return { ...source.principal, epoch: source.epoch, grantID: grant.grantID }
    }),
  })
})
