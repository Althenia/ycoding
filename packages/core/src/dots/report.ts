export * as DotsReporting from "./report"

import { Dots } from "@ycoding-ai/schema/dots"
import { DotsReport } from "@ycoding-ai/schema/dots-report"
import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { DotsRuntime } from "../dots"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { Session } from "../session"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { Hash } from "../util/hash"

const lock = KeyedMutex.makeUnsafe<string>()
const recordedType = EventRuntime.versionedType(SessionEvent.DotsReportRecorded.type, SessionEvent.DotsReportRecorded.durable.version)
const allowedKeys = new Set(["sessionID", "messageID", "callID", "kind", "text"])
const kinds = new Set(["progress", "blocker", "decision_request"])
const fail = (code: Dots.ErrorCode, message: string) => new DotsRuntime.Error({ code, message })

export interface Resolved {
  readonly record: Dots.ExchangeRecord
  readonly generation: number
}

export interface Options {
  readonly db: Database.Interface["db"]
  readonly events: EventRuntime.Interface
  readonly resolve: (sessionID: Session.ID, messageID: SessionMessage.ID) => Effect.Effect<Resolved, DotsRuntime.Error>
}

export interface Input {
  readonly sessionID: Session.ID
  readonly messageID: SessionMessage.ID
  readonly callID: string
  readonly kind: "progress" | "blocker" | "decision_request"
  readonly text: string
}

export function make(options: Options) {
  const stored = Effect.fn("DotsReporting.stored")(function* (id: EventRuntime.ID) {
    const row = yield* options.db.select({ data: EventTable.data }).from(EventTable)
      .where(and(eq(EventTable.id, id), eq(EventTable.type, recordedType))).get().pipe(Effect.orDie)
    if (!row) return undefined
    const data = Schema.decodeUnknownSync(SessionEvent.DotsReportRecorded.data)(row.data)
    return { deliveryID: data.deliveryID, messageID: data.messageID, text: data.text, envelope: data.envelope }
  })

  const same = (left: Resolved, right: Resolved) => left.generation === right.generation && Hash.json(left.record) === Hash.json(right.record)

  const revalidate = (input: Input, resolved: Resolved) => options.resolve(input.sessionID, input.messageID).pipe(
    Effect.flatMap((current) => same(current, resolved) ? Effect.void : Effect.fail(fail("target_changed", "The report's exchange context changed."))),
  )

  return {
    report: Effect.fn("DotsReporting.report")(function* (input: Input) {
      if (Object.keys(input).some((key) => !allowedKeys.has(key)) || !kinds.has(input.kind) || typeof input.callID !== "string" || input.callID === "")
        return yield* fail("invalid_input", "Report routing and identity are supplied only by the runtime.")
      const hash = Hash.json([input.sessionID, input.messageID, input.callID])
      const id = EventRuntime.ID.make(`evt_dots_report_${hash}`)
      return yield* lock.withLock(id)(Effect.gen(function* () {
        const resolved = yield* options.resolve(input.sessionID, input.messageID)
        const output: Dots.ExchangeOutput = {
          deliveryID: `dots_report_${hash}`,
          messageID: input.messageID,
          text: input.text,
          envelope: {
            coordinator: resolved.record.source.principal,
            scope: { epoch: resolved.record.source.epoch, grantID: resolved.record.grantID },
            exchangeID: resolved.record.exchangeID,
            messageID: input.messageID,
            replyToMessageID: resolved.record.inputID,
            kind: input.kind,
            origin: "agent",
            sourceSessionID: input.sessionID,
          },
        }
        yield* Effect.try({
          try: () => DotsReport.render(output.envelope, output.text),
          catch: () => fail("invalid_input", "The report body is invalid."),
        })
        const prior = yield* stored(id)
        if (prior) {
          if (Hash.json(prior) !== Hash.json(output)) return yield* fail("exchange_conflict", "The report call is already recorded with different content or route.")
          yield* revalidate(input, resolved)
          return prior
        }
        let gateError: DotsRuntime.Error | undefined
        const committed = yield* options.events.publishBatch([{
          definition: SessionEvent.DotsReportRecorded,
          data: { sessionID: input.sessionID, callID: input.callID, ...output },
          options: { id },
        }], { when: revalidate(input, resolved).pipe(Effect.match({
          onFailure: (error) => { gateError = error; return false },
          onSuccess: () => true,
        })) })
        if (committed.length === 0) return yield* (gateError ?? fail("target_changed", "The report's exchange context changed before recording."))
        yield* revalidate(input, resolved).pipe(Effect.mapError(() =>
          fail("exchange_outcome_unknown", "The report was recorded but its return could not be confirmed; retry the same report call.")))
        return output
      }))
    }),
  }
}
