import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Coordination } from "@ycoding-ai/schema/coordination"
import type { Session } from "@ycoding-ai/schema/session"
import { SessionTable } from "../session/sql"

export const CoordinationGroupTable = sqliteTable(
  "coordination_group",
  {
    id: text().$type<Coordination.GroupID>().primaryKey(),
    name: text().notNull(),
    revision: integer().notNull(),
    master_session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    concurrency: integer(),
    delegated_decisions: text({ mode: "json" }).$type<Coordination.DelegatedDecisions>(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    uniqueIndex("coordination_group_master_idx").on(table.master_session_id),
    index("coordination_group_updated_idx").on(table.time_updated, table.id),
  ],
)

export const CoordinationMemberTable = sqliteTable(
  "coordination_member",
  {
    group_id: text()
      .$type<Coordination.GroupID>()
      .notNull()
      .references(() => CoordinationGroupTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.group_id, table.session_id] }),
    uniqueIndex("coordination_member_session_idx").on(table.session_id),
  ],
)
