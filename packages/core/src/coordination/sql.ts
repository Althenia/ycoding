import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import type { Coordination } from "@ycoding-ai/schema/coordination"
import type { Session } from "@ycoding-ai/schema/session"
import type { SessionMessage } from "@ycoding-ai/schema/session-message"
import { SessionTable } from "../session/sql"

export const CoordinationGroupTable = sqliteTable(
  "coordination_group",
  {
    id: text().$type<Coordination.GroupID>().primaryKey(),
    name: text().notNull(),
    status: text().$type<Coordination.GroupStatus>().notNull(),
    revision: integer().notNull(),
    concurrency: integer(),
    queue_capacity: integer().notNull(),
    budget: real(),
    delegated_decisions: text({ mode: "json" }).$type<Coordination.DelegatedDecisions>(),
    fencing_generation: integer().notNull().default(0),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("coordination_group_status_updated_idx").on(table.status, table.time_updated, table.id)],
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
    role: text().$type<Coordination.Role>().notNull(),
    allowed_tools: text({ mode: "json" }).$type<ReadonlyArray<string>>(),
    resource_scopes: text({ mode: "json" }).$type<ReadonlyArray<string>>(),
  },
  (table) => [
    primaryKey({ columns: [table.group_id, table.session_id] }),
    index("coordination_member_session_idx").on(table.session_id),
  ],
)

export const CoordinationClaimTable = sqliteTable(
  "coordination_claim",
  {
    group_id: text()
      .$type<Coordination.GroupID>()
      .notNull()
      .references(() => CoordinationGroupTable.id, { onDelete: "cascade" }),
    target_session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    holder_session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    status: text().$type<"active" | "released" | "revoked">().notNull(),
    lease_expires_at: integer().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.group_id, table.target_session_id] }),
    index("coordination_claim_target_status_idx").on(table.target_session_id, table.status),
  ],
)

export const CoordinationDispatchTable = sqliteTable(
  "coordination_dispatch",
  {
    id: text().$type<Coordination.DispatchID>().primaryKey(),
    group_id: text()
      .$type<Coordination.GroupID>()
      .notNull()
      .references(() => CoordinationGroupTable.id, { onDelete: "cascade" }),
    target_session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    coordinator_session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    status: text().$type<Coordination.DispatchStatus>().notNull(),
    reason: text().$type<Coordination.QueueReason>(),
    text: text().notNull(),
    selection: text({ mode: "json" }).$type<Coordination.DispatchSelection>().notNull(),
    depends_on: text({ mode: "json" }).$type<ReadonlyArray<Coordination.DispatchID>>(),
    resource_scope: text(),
    allowed_tools: text({ mode: "json" }).$type<ReadonlyArray<string>>(),
    message_id: text().$type<SessionMessage.ID>(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("coordination_dispatch_group_status_idx").on(table.group_id, table.status, table.time_created, table.id),
    index("coordination_dispatch_target_status_idx").on(table.target_session_id, table.status),
    uniqueIndex("coordination_dispatch_message_idx")
      .on(table.message_id)
      .where(sql`${table.message_id} IS NOT NULL`),
  ],
)

export const CoordinationWaitTable = sqliteTable(
  "coordination_wait",
  {
    id: text().$type<Coordination.WaitID>().primaryKey(),
    group_id: text()
      .$type<Coordination.GroupID>()
      .notNull()
      .references(() => CoordinationGroupTable.id, { onDelete: "cascade" }),
    coordinator_session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    status: text().$type<Coordination.WaitStatus>().notNull(),
    targets: text({ mode: "json" }).$type<ReadonlyArray<Session.ID>>().notNull(),
    cursors: text({ mode: "json" }).$type<Record<string, number>>().notNull(),
    expires_at: integer().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("coordination_wait_group_status_idx").on(table.group_id, table.status)],
)

export const CoordinationReceiptTable = sqliteTable(
  "coordination_receipt",
  {
    id: text().$type<Coordination.ReceiptID>().primaryKey(),
    group_id: text()
      .$type<Coordination.GroupID>()
      .notNull()
      .references(() => CoordinationGroupTable.id, { onDelete: "cascade" }),
    dispatch_id: text().$type<Coordination.DispatchID>(),
    kind: text().$type<Coordination.Receipt["kind"]>().notNull(),
    session_id: text()
      .$type<Session.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text().$type<SessionMessage.ID>(),
    generation: integer(),
    detail: text(),
    time_created: integer().notNull(),
  },
  (table) => [index("coordination_receipt_group_time_idx").on(table.group_id, table.time_created, table.id)],
)
