export * as DotsAuthority from "./authority"

import { Dots } from "@ycoding-ai/schema/dots"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { SessionEvent } from "@ycoding-ai/schema/session-event"
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { DotsRuntime } from "../dots"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { EventSequenceTable, EventTable } from "../event/sql"
import type { Location } from "../location"
import type { Session } from "../session"
import { Hash } from "../util/hash"

const locks = KeyedMutex.makeUnsafe<string>()
export const withLock = locks.withLock
const bindingTypes = [Dots.BindingBound, Dots.BindingUnbound, SessionEvent.Deleted].map((event) => EventRuntime.versionedType(event.type, event.durable.version))
const grantTypes = [Dots.DeviceDelegationCreated, Dots.DeviceDelegationRevoked].map((event) => EventRuntime.versionedType(event.type, 1))
export const mutationID = (sessionID: Session.ID, exchangeID: string) => EventRuntime.ID.make(`evt_dots_authority_${Hash.json([sessionID, exchangeID])}`)
export const sameTarget = (a: Dots.Target, b: Dots.Target) =>
  a.profile === b.profile && a.dotID === b.dotID && a.threadID === b.threadID && a.generation === b.generation

export function make(options: { readonly db: Database.Interface["db"]; readonly events: EventRuntime.Interface; readonly location?: Location.Ref }) {
  const binding = Effect.fn("DotsAuthority.binding")(function* (sessionID: Session.ID) {
    const row = yield* options.db.select({ type: EventTable.type, data: EventTable.data }).from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), inArray(EventTable.type, bindingTypes)))
      .orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    return row && row.type === bindingTypes[0] ? Schema.decodeUnknownSync(Dots.BindingBound.data)(row.data).binding : undefined
  })
  const bindings = Effect.fn("DotsAuthority.bindings")(function* (local = false) {
    const result: Array<{ sessionID: Session.ID; binding: Dots.BindingRecord }> = []
    let after = ""
    while (true) {
      const rows = yield* options.db.select({ aggregate: EventSequenceTable.aggregate_id }).from(EventSequenceTable).where(and(
        gte(EventSequenceTable.aggregate_id, "ses"), lt(EventSequenceTable.aggregate_id, "set"),
        gt(EventSequenceTable.aggregate_id, after),
        sql`NOT EXISTS (SELECT 1 FROM session s WHERE s.id = ${EventSequenceTable.aggregate_id} AND s.time_archived IS NOT NULL)`,
        !local || options.location === undefined ? undefined : sql`EXISTS (SELECT 1 FROM session s WHERE s.id = ${EventSequenceTable.aggregate_id} AND s.directory = ${options.location.directory} AND s.workspace_id IS ${options.location.workspaceID ?? null})`,
      )).orderBy(asc(EventSequenceTable.aggregate_id)).limit(128).all().pipe(Effect.orDie)
      for (const row of rows) {
        const sessionID = SessionID.make(row.aggregate)
        const current = yield* binding(sessionID)
        if (current) result.push({ sessionID, binding: current })
      }
      if (rows.length < 128) return result
      after = rows.at(-1)!.aggregate
      yield* Effect.yieldNow
    }
  })
  const unbind = (sessionID: Session.ID, expectedID: string) => withLock("bindings")(Effect.gen(function* () {
    if ((yield* binding(sessionID))?.id !== expectedID) return
    yield* options.events.publish(Dots.BindingUnbound, { sessionID, bindingID: expectedID })
  }))
  const grants = Effect.fn("DotsAuthority.grants")(function* (sessionID: Session.ID) {
    const values = new Map<string, Dots.DeviceDelegationInfo>()
    let after = -1
    while (true) {
      const rows = yield* options.db.select({ type: EventTable.type, data: EventTable.data, seq: EventTable.seq }).from(EventTable)
        .where(and(eq(EventTable.aggregate_id, sessionID), inArray(EventTable.type, grantTypes), gt(EventTable.seq, after)))
        .orderBy(asc(EventTable.seq)).limit(256).all().pipe(Effect.orDie)
      for (const row of rows) {
        if (row.type === grantTypes[0]) {
          const value = Schema.decodeUnknownSync(Dots.DeviceDelegationCreated.data)(row.data)
          values.set(value.grant.id, value.grant)
          continue
        }
        const value = Schema.decodeUnknownSync(Dots.DeviceDelegationRevoked.data)(row.data)
        const prior = values.get(value.delegationID)
        if (prior) values.set(prior.id, { ...prior, revision: value.revision, active: false })
      }
      if (rows.length < 256) return [...values.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      after = rows.at(-1)!.seq
      yield* Effect.yieldNow
    }
  })
  return {
    binding,
    bindings,
    grants,
    mutation: (sessionID: Session.ID, exchangeID: string) => options.db.select({ type: EventTable.type, data: EventTable.data }).from(EventTable)
      .where(eq(EventTable.id, mutationID(sessionID, exchangeID))).get().pipe(Effect.orDie),
    unbind,
    clear: () => bindings(true).pipe(Effect.flatMap((values) => Effect.forEach(values, (value) => unbind(value.sessionID, value.binding.id), { discard: true }))),
    bind: (sessionID: Session.ID, target: Dots.Target, accountDigest: string) => withLock("bindings")(Effect.gen(function* () {
      const prior = yield* binding(sessionID)
      const occupied = (yield* bindings()).find((value) => value.sessionID !== sessionID && value.binding.accountDigest === accountDigest && value.binding.target.threadID === target.threadID)
      if (occupied) return yield* new DotsRuntime.Error({ code: "target_in_use", message: "Another Session is already confirmed for that Dot conversation." })
      const current = { id: prior && prior.accountDigest === accountDigest && sameTarget(prior.target, target) ? prior.id : crypto.randomUUID(), target, accountDigest }
      if (prior && Hash.json(prior) === Hash.json(current)) return current
      yield* options.events.publish(Dots.BindingBound, { sessionID, binding: current })
      return current
    })),
  }
}
