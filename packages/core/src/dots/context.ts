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

type Disabled = Extract<Dots.CoordinationContext, { state: "disabled" }>
export type State = Omit<Disabled, "generation" | "routine" | "delegated">

const locks = KeyedMutex.makeUnsafe<string>()

export function render(context: Disabled) {
  return "Dots coordination disabled. Earlier enabled observations do not authorize reporting." +
    `\n${JSON.stringify({ state: context.state, generation: context.generation, reason: context.reason })}`
}

export function make(options: { readonly db: Database.Interface["db"]; readonly events: EventRuntime.Interface }) {
  return {
    observe: (sessionID: SessionSchema.ID, state: State | undefined) => locks.withLock(sessionID)(Effect.gen(function* () {
      const row = yield* options.db.select({ data: EventTable.data }).from(EventTable).where(and(
        eq(EventTable.aggregate_id, sessionID),
        eq(EventTable.type, EventRuntime.versionedType(SessionEvent.ContextObserved.type, SessionEvent.ContextObserved.durable.version)),
        sql`json_extract(${EventTable.data}, '$.source') = 'dots'`,
      )).orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
      if (!row) return
      const previous = Schema.decodeUnknownSync(Dots.CoordinationContext)(row.data.dots)
      const current = state ?? { state: "disabled" as const, reason: "no_task" as const }
      const unchanged = previous.state === "disabled" && previous.reason === current.reason && !previous.routine && !previous.delegated
      const dots: Disabled = { ...current, generation: unchanged ? previous.generation : previous.generation + 1 }
      const text = render(dots)
      const history = yield* SessionHistory.observationState(options.db, sessionID)
      if (unchanged && history.latest.get("dots") === text) return
      yield* options.events.publish(SessionEvent.ContextObserved, { sessionID, source: "dots", text, dots })
    })),
  }
}
