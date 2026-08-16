import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { directoryColumn, pathColumn } from "../database/path"
import { ProjectTable } from "../project/sql"
import type { SessionMessage } from "./message"
import type { SessionPending } from "./pending"
import { Permission } from "@ycoding-ai/schema/permission"
import { ProjectV2 } from "../project"
import type { SessionSchema } from "./schema"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { Instruction } from "@ycoding-ai/schema/instruction"
import type { Session } from "@ycoding-ai/schema/session"
import type { SyntheticData, UserData } from "@ycoding-ai/schema/session-pending"
import type { Schema } from "effect"
import type { State as SessionAutonomyState } from "./autonomy"
import type { Model } from "@ycoding-ai/schema/model"
import type { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"

type SessionMessageData = Omit<(typeof SessionMessage.Info)["Encoded"], "type" | "id">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    fork_session_id: text().$type<SessionSchema.ID>(),
    fork_message_id: text().$type<SessionMessage.ID>(),
    fork_seq: integer(),
    directory: directoryColumn().notNull(),
    path: pathColumn(),
    title: text().notNull(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Session.Revert>(),
    permission: text({ mode: "json" }).$type<Permission.Ruleset>(),
    autonomy: text({ mode: "json" }).$type<SessionAutonomyState>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_archived: integer(),
    time_suspended: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
    index("session_time_suspended_idx")
      .on(table.time_suspended)
      .where(sql`${table.time_suspended} is not null`),
  ],
)

export const SessionTodoTable = sqliteTable(
  "session_todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("session_todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionPendingTable = sqliteTable(
  "session_pending",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionPending.Info["type"]>().notNull(),
    data: text({ mode: "json" }).$type<UserData | SyntheticData | Record<string, never>>().notNull(),
    delivery: text().$type<SessionPending.Delivery>(),
    admitted_seq: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_pending_session_delivery_seq_idx").on(table.session_id, table.delivery, table.admitted_seq),
    uniqueIndex("session_pending_session_compaction_idx")
      .on(table.session_id)
      .where(sql`${table.type} = 'compaction'`),
    uniqueIndex("session_pending_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
  ],
)

export const SessionTaskTable = sqliteTable(
  "session_task",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    tool_call_id: text().notNull(),
    input_id: text().$type<SessionMessage.ID>().notNull().unique(),
    description: text().notNull(),
    agent: text().notNull(),
    model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
    prompt_digest: text().notNull(),
    background: integer({ mode: "boolean" }).notNull(),
    delivery: text().$type<SessionPending.Delivery>().notNull(),
    state: text().$type<SessionOrchestration.State>().notNull(),
    progress: text(),
    progress_time: integer(),
    question_id: text().$type<SessionOrchestration.QuestionID>(),
    question: text(),
    question_data: text({ mode: "json" }).$type<Schema.Json>(),
    question_time: integer(),
    attempt_started: integer({ mode: "boolean" }).notNull().default(false),
    revision: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("session_task_launch_identity_idx").on(
      table.parent_id,
      table.parent_assistant_message_id,
      table.tool_call_id,
    ),
    index("session_task_parent_state_updated_idx").on(table.parent_id, table.state, table.time_updated),
  ],
)

export const SessionTaskNotificationTable = sqliteTable(
  "session_task_notification",
  {
    id: text().primaryKey(),
    task_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTaskTable.session_id, { onDelete: "cascade" }),
    parent_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionOrchestration.NotificationType>().notNull(),
    revision: integer().notNull(),
    excerpt: text(),
    delivered: integer({ mode: "boolean" }).notNull().default(false),
    time_created: integer().notNull(),
    time_delivered: integer(),
  },
  (table) => [
    uniqueIndex("session_task_notification_transition_idx").on(table.task_session_id, table.type, table.revision),
    index("session_task_notification_delivery_idx").on(table.delivered, table.time_created, table.id),
  ],
)

export const InstructionEntryTable = sqliteTable(
  "instruction_entry",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    key: text().notNull(),
    value: text({ mode: "json" }).$type<Schema.Json>(),
    removed: integer({ mode: "boolean" }).notNull().default(false),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.session_id, table.key] })],
)

export const InstructionBlobTable = sqliteTable("instruction_blob", {
  hash: text().$type<Instruction.Hash>().primaryKey(),
  value: text({ mode: "json" }).$type<Schema.Json>(),
})

export const InstructionStateTable = sqliteTable("instruction_state", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  epoch_start: integer().notNull(),
  through_seq: integer().notNull(),
  initial_values: text({ mode: "json" }).notNull().$type<Instruction.Values>(),
  current_values: text({ mode: "json" }).notNull().$type<Instruction.Values>(),
})
