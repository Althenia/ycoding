export * as DotsContext from "./context"

import { Dots } from "@ycoding-ai/schema/dots"
import { and, desc, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { SessionEvent } from "../session/event"
import { SessionHistory } from "../session/history"
import type { SessionSchema } from "../session/schema"
import { Hash } from "../util/hash"

export type State =
  | Omit<Extract<Dots.CoordinationContext, { state: "enabled" }>, "generation">
  | Omit<Extract<Dots.CoordinationContext, { state: "disabled" }>, "generation">

const locks = KeyedMutex.makeUnsafe<string>()

export function render(context: Dots.CoordinationContext) {
  return (context.state === "enabled"
    ? "Dots coordination enabled. Use dots_report for progress, blockers and decision requests; completion requires the native completion receipt. YCoding supplies the return route."
    : "Dots coordination disabled. Earlier enabled observations do not authorize reporting.") + `\n${JSON.stringify(context.state === "enabled"
      ? { state: context.state, generation: context.generation, tool: context.tool, context: Hash.json(context.envelope) }
      : context)}`
}

export function make(options: { readonly db: Database.Interface["db"]; readonly events: EventRuntime.Interface }) {
  return {
    observe: (sessionID: SessionSchema.ID, state: State | undefined) => locks.withLock(sessionID)(Effect.gen(function* () {
      const row = yield* options.db.select({ data: EventTable.data }).from(EventTable).where(and(
        eq(EventTable.aggregate_id, sessionID),
        eq(EventTable.type, EventRuntime.versionedType(SessionEvent.ContextObserved.type, SessionEvent.ContextObserved.durable.version)),
        sql`json_extract(${EventTable.data}, '$.source') = 'dots'`,
      )).orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
      if (!row && (state === undefined || state.state === "disabled")) return
      const previous = row ? Schema.decodeUnknownSync(Dots.CoordinationContext)(row.data.dots) : undefined
      const current = state ?? { state: "disabled" as const, reason: "no_task" as const }
      const priorState = previous === undefined ? undefined : (({ generation: _generation, ...value }) => value)(previous)
      const unchanged = previous !== undefined && Hash.json(priorState) === Hash.json(current)
      const dots = Schema.decodeUnknownSync(Dots.CoordinationContext)({ ...current, generation: previous === undefined ? 1 : unchanged ? previous.generation : previous.generation + 1 })
      const text = render(dots)
      const history = yield* SessionHistory.observationState(options.db, sessionID)
      if (unchanged && history.latest.get("dots") === text) return
      yield* options.events.publish(SessionEvent.ContextObserved, { sessionID, source: "dots", text, dots })
    })),
  }
}
