export * as CoordinationModel from "./coordination-model"

import { Model } from "@ycoding-ai/schema/model"
import { and, desc, eq, gt, inArray } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { EventTable } from "../event/sql"
import { versionedType } from "../event"
import { SessionEvent } from "./event"
import { SessionMessageTable } from "./sql"
import type { SessionSchema } from "./schema"

const terminalTypes = [SessionEvent.Execution.Succeeded, SessionEvent.Execution.Failed, SessionEvent.Execution.Interrupted]
  .map((event) => versionedType(event.type, event.durable.version))
const decodeRef = Schema.decodeUnknownOption(Model.Ref)

export const override = Effect.fn("CoordinationModel.override")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const latest = yield* db
    .select({ id: SessionMessageTable.id, data: SessionMessageTable.data, seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const metadata = (latest?.data as { metadata?: { inputOrigin?: unknown; coordination?: { model?: unknown } } } | undefined)?.metadata
  if (latest === undefined || metadata?.inputOrigin !== "coordination" || metadata.coordination?.model === undefined) return undefined
  const settled = yield* db
    .select({ id: EventTable.id })
    .from(EventTable)
    .where(and(
      eq(EventTable.aggregate_id, sessionID),
      inArray(EventTable.type, terminalTypes),
      gt(EventTable.seq, latest.seq),
    ))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (settled !== undefined) return undefined
  const ref = decodeRef(metadata.coordination.model)
  return Option.getOrUndefined(ref)
})
