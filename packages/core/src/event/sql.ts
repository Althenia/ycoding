import { sqliteTable, text, integer, index, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { versionedType } from "@ycoding-ai/schema/event"
import { SessionEvent } from "@ycoding-ai/schema/session-event"
import type { EventRuntime } from "../event"

export const reviewTypes = [
  SessionEvent.Review.Deferred,
  SessionEvent.Review.Decided,
  SessionEvent.Review.Withdrawn,
  SessionEvent.Review.Consumed,
].map((definition) => versionedType(definition.type, definition.durable.version))

export const isReviewType = (column: AnySQLiteColumn) =>
  sql`${column} IN (${sql.raw(reviewTypes.map((type) => `'${type}'`).join(", "))})`

export const EventSequenceTable = sqliteTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: integer().notNull(),
  owner_id: text(),
})

export const EventTable = sqliteTable(
  "event",
  {
    id: text().$type<EventRuntime.ID>().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    created: integer().notNull(),
    type: text().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    index("event_aggregate_type_seq_idx").on(table.aggregate_id, table.type, table.seq),
    index("event_review_type_aggregate_seq_idx").on(table.type, table.aggregate_id, table.seq).where(isReviewType(table.type)),
  ],
)
