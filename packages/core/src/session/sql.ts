import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
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
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import type { RelativePath } from "../schema"
import type { SessionCompaction } from "@ycoding-ai/schema/session-compaction"

type SessionMessageData = Omit<(typeof SessionMessage.Info)["Encoded"], "type" | "id">

const digest = (column: AnySQLiteColumn) => sql`length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`
const optionalDigest = (column: AnySQLiteColumn) => sql`(${column} IS NULL OR (${digest(column)}))`
const nonnegativeInteger = (column: AnySQLiteColumn) => sql`typeof(${column}) = 'integer' AND ${column} >= 0`
const optionalNonnegativeInteger = (column: AnySQLiteColumn) =>
  sql`(${column} IS NULL OR (${nonnegativeInteger(column)}))`
const nonempty = (column: AnySQLiteColumn) => sql`length(${column}) > 0`
const optionalNonempty = (column: AnySQLiteColumn) => sql`(${column} IS NULL OR length(${column}) > 0)`

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
    autonomy_revision: integer().notNull().default(0),
    orchestration_revision: integer().notNull().default(0),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
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

export const SessionProviderRequestTable = sqliteTable(
  "session_provider_request",
  {
    id: text().$type<ProviderRequest.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    input_id: text().$type<SessionMessage.ID>(),
    source: text().$type<ProviderRequest.Source>().notNull(),
    agent: text().$type<ProviderRequest.Record["agent"]>().notNull(),
    model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
    route_id: text().notNull(),
    prompt_cache_key: text().notNull(),
    system_digest: text().notNull(),
    tool_digest: text().notNull(),
    request: integer().notNull(),
    attempts: integer().notNull(),
    invalidation: text().$type<ProviderRequest.Invalidation>().notNull(),
    continuation: text().$type<ProviderRequest.Continuation>().notNull(),
    cache_read_reported: integer({ mode: "boolean" }),
    cost: real(),
    tokens: text({ mode: "json" }).$type<TokenUsage.Info>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_provider_request_session_request_idx").on(table.session_id, table.request),
    index("session_provider_request_session_source_idx").on(table.session_id, table.source),
  ],
)

export const SessionUsageTable = sqliteTable(
  "session_usage",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    model_key: text().notNull(),
    model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
    logical: integer().notNull(),
    physical: integer().notNull(),
    helpers: integer().notNull(),
    continued: integer().notNull(),
    fallback: integer().notNull(),
    cost: real(),
    input: integer().notNull(),
    output: integer().notNull(),
    reasoning: integer().notNull(),
    cache_read: integer().notNull(),
    cache_write: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.model_key] })],
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

export const SessionFileChangeTable = sqliteTable(
  "session_file_change",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    path: text().$type<RelativePath>().notNull(),
    patch: text().notNull(),
    additions: integer().notNull(),
    deletions: integer().notNull(),
    latest_seq: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.path] }),
    index("session_file_change_path_session_idx").on(table.path, table.session_id),
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
    type: text().$type<SessionPending.LegacyInfo["type"]>().notNull(),
    data: text({ mode: "json" }).$type<UserData | SyntheticData | Record<string, never>>().notNull(),
    delivery: text().$type<SessionPending.Delivery>(),
    admitted_seq: integer().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_pending_session_delivery_seq_idx").on(table.session_id, table.delivery, table.admitted_seq),
    uniqueIndex("session_pending_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
  ],
)

export const CompactionManifestBlobTable = sqliteTable(
  "compaction_manifest_blob",
  {
    digest: text().primaryKey(),
    schema_version: integer().notNull(),
    content: text({ mode: "json" }).$type<Schema.Json>().notNull(),
    input_tokens: integer().notNull(),
    retained_tokens: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    check("compaction_manifest_blob_digest_check", digest(table.digest)),
    check("compaction_manifest_blob_schema_version_check", sql`${table.schema_version} > 0`),
    check("compaction_manifest_blob_content_check", sql`json_valid(${table.content})`),
    check(
      "compaction_manifest_blob_counts_check",
      sql`${nonnegativeInteger(table.input_tokens)} AND ${nonnegativeInteger(table.retained_tokens)}`,
    ),
    check("compaction_manifest_blob_time_check", nonnegativeInteger(table.time_created)),
  ],
)

export const SessionContextRevisionTable = sqliteTable(
  "session_context_revision",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    parent_revision: integer(),
    manifest_digest: text().references(() => CompactionManifestBlobTable.digest, { onDelete: "restrict" }),
    covered_through_message_id: text().$type<SessionMessage.ID>(),
    covered_through_seq: integer(),
    activation_event_id: text(),
    activation_sequence: integer(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.revision] }),
    foreignKey({
      name: "session_context_revision_parent_fk",
      columns: [table.session_id, table.parent_revision],
      foreignColumns: [table.session_id, table.revision],
    }).onDelete("cascade"),
    check(
      "session_context_revision_lineage_check",
      sql`(${table.revision} = 0 AND ${table.parent_revision} IS NULL) OR (${table.revision} > 0 AND ${table.parent_revision} = ${table.revision} - 1)`,
    ),
    check("session_context_revision_manifest_check", optionalDigest(table.manifest_digest)),
    check(
      "session_context_revision_boundary_check",
      sql`(${table.covered_through_message_id} IS NULL AND ${table.covered_through_seq} IS NULL) OR (${nonempty(table.covered_through_message_id)} AND ${nonnegativeInteger(table.covered_through_seq)})`,
    ),
    check(
      "session_context_revision_activation_check",
      sql`(${table.activation_event_id} IS NULL AND ${table.activation_sequence} IS NULL) OR (${nonempty(table.activation_event_id)} AND ${nonnegativeInteger(table.activation_sequence)})`,
    ),
    check("session_context_revision_time_check", nonnegativeInteger(table.time_created)),
  ],
)

export const SessionContextStateTable = sqliteTable(
  "session_context_state",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    status: text().$type<"active" | "quarantined">().notNull(),
    revision: integer().notNull(),
    manifest_digest: text().references(() => CompactionManifestBlobTable.digest, { onDelete: "restrict" }),
    covered_through_message_id: text().$type<SessionMessage.ID>(),
    covered_through_seq: integer(),
    activated_event_id: text(),
    time_activated: integer(),
    error_code: text(),
  },
  (table) => [
    foreignKey({
      name: "session_context_state_revision_fk",
      columns: [table.session_id, table.revision],
      foreignColumns: [SessionContextRevisionTable.session_id, SessionContextRevisionTable.revision],
    }).onDelete("cascade"),
    check("session_context_state_status_check", sql`${table.status} IN ('active', 'quarantined')`),
    check("session_context_state_revision_check", nonnegativeInteger(table.revision)),
    check("session_context_state_manifest_check", optionalDigest(table.manifest_digest)),
    check(
      "session_context_state_boundary_check",
      sql`(${table.covered_through_message_id} IS NULL AND ${table.covered_through_seq} IS NULL) OR (${nonempty(table.covered_through_message_id)} AND ${nonnegativeInteger(table.covered_through_seq)})`,
    ),
    check(
      "session_context_state_activation_check",
      sql`(${table.activated_event_id} IS NULL AND ${table.time_activated} IS NULL) OR (${nonempty(table.activated_event_id)} AND ${nonnegativeInteger(table.time_activated)})`,
    ),
    check(
      "session_context_state_error_check",
      sql`(${table.status} = 'active' AND ${table.error_code} IS NULL) OR (${table.status} = 'quarantined' AND ${nonempty(table.error_code)})`,
    ),
  ],
)

export const SessionContextExclusionTable = sqliteTable(
  "session_context_exclusion",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    context_revision: integer().notNull(),
    target_key: text().notNull(),
    target_kind: text().$type<"message" | "part" | "provider_state">().notNull(),
    target_selector: text({ mode: "json" }).$type<Schema.Json>().notNull(),
    dependency_group: text(),
    reason: text()
      .$type<
        "exact_duplicate" | "superseded_authority" | "terminal_intermediate" | "stale_tool_result" | "provider_rebase"
      >()
      .notNull(),
    manifest_digest: text()
      .notNull()
      .references(() => CompactionManifestBlobTable.digest, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.context_revision, table.target_key] }),
    foreignKey({
      name: "session_context_exclusion_revision_fk",
      columns: [table.session_id, table.context_revision],
      foreignColumns: [SessionContextRevisionTable.session_id, SessionContextRevisionTable.revision],
    }).onDelete("cascade"),
    uniqueIndex("session_context_exclusion_current_target_idx").on(table.session_id, table.target_key),
    index("session_context_exclusion_manifest_idx").on(table.manifest_digest),
    check("session_context_exclusion_target_key_check", digest(table.target_key)),
    check(
      "session_context_exclusion_target_kind_check",
      sql`${table.target_kind} IN ('message', 'part', 'provider_state')`,
    ),
    check("session_context_exclusion_selector_check", sql`json_valid(${table.target_selector})`),
    check("session_context_exclusion_dependency_check", optionalNonempty(table.dependency_group)),
    check(
      "session_context_exclusion_reason_check",
      sql`${table.reason} IN ('exact_duplicate', 'superseded_authority', 'terminal_intermediate', 'stale_tool_result', 'provider_rebase')`,
    ),
    check("session_context_exclusion_manifest_check", digest(table.manifest_digest)),
  ],
)

export const SessionCompactionJobTable = sqliteTable(
  "session_compaction_job",
  {
    id: text().$type<SessionCompaction.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    legacy_input_id: text().$type<SessionMessage.ID>(),
    trigger: text().$type<SessionCompaction.Trigger>().notNull(),
    requested_through_message_id: text().$type<SessionMessage.ID>().notNull(),
    requested_through_seq: integer().notNull(),
    base_context_revision: integer().notNull(),
    target_max_input_tokens: integer(),
    config_digest: text(),
    status: text().$type<"pending" | "running" | "ended" | "failed">().notNull(),
    lease_owner: text(),
    lease_expires_at: integer(),
    attempts: integer().notNull(),
    manifest_digest: text().references(() => CompactionManifestBlobTable.digest, { onDelete: "restrict" }),
    error_code: text().$type<SessionCompaction.FailureCode>(),
    error_message: text(),
    time_created: integer().notNull(),
    time_started: integer(),
    time_ended: integer(),
  },
  (table) => [
    foreignKey({
      name: "session_compaction_job_base_revision_fk",
      columns: [table.session_id, table.base_context_revision],
      foreignColumns: [SessionContextRevisionTable.session_id, SessionContextRevisionTable.revision],
    }).onDelete("cascade"),
    uniqueIndex("session_compaction_job_pending_revision_idx")
      .on(table.session_id, table.base_context_revision)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex("session_compaction_job_legacy_input_idx")
      .on(table.legacy_input_id)
      .where(sql`${table.legacy_input_id} IS NOT NULL`),
    index("session_compaction_job_recovery_idx").on(table.status, table.lease_expires_at, table.session_id),
    index("session_compaction_job_manifest_idx").on(table.manifest_digest),
    check("session_compaction_job_id_check", sql`length(${table.id}) > 4 AND substr(${table.id}, 1, 4) = 'cmp_'`),
    check("session_compaction_job_legacy_input_check", optionalNonempty(table.legacy_input_id)),
    check(
      "session_compaction_job_trigger_check",
      sql`${table.trigger} IN ('consider', 'advised', 'mandatory', 'manual')`,
    ),
    check("session_compaction_job_requested_message_check", nonempty(table.requested_through_message_id)),
    check(
      "session_compaction_job_counts_check",
      sql`${nonnegativeInteger(table.requested_through_seq)} AND ${nonnegativeInteger(table.base_context_revision)} AND ${optionalNonnegativeInteger(table.target_max_input_tokens)} AND ${nonnegativeInteger(table.attempts)}`,
    ),
    check("session_compaction_job_config_digest_check", optionalDigest(table.config_digest)),
    check("session_compaction_job_manifest_digest_check", optionalDigest(table.manifest_digest)),
    check(
      "session_compaction_job_current_input_check",
      sql`${table.legacy_input_id} IS NOT NULL OR (${table.target_max_input_tokens} IS NOT NULL AND ${table.config_digest} IS NOT NULL)`,
    ),
    check("session_compaction_job_status_check", sql`${table.status} IN ('pending', 'running', 'ended', 'failed')`),
    check(
      "session_compaction_job_lease_check",
      sql`(${table.lease_owner} IS NULL AND ${table.lease_expires_at} IS NULL) OR (${nonempty(table.lease_owner)} AND ${nonnegativeInteger(table.lease_expires_at)})`,
    ),
    check(
      "session_compaction_job_terminal_check",
      sql`(${table.status} = 'pending' AND ${table.lease_owner} IS NULL AND ${table.time_started} IS NULL AND ${table.time_ended} IS NULL AND ${table.manifest_digest} IS NULL AND ${table.error_code} IS NULL AND ${table.error_message} IS NULL) OR (${table.status} = 'running' AND ${table.lease_owner} IS NOT NULL AND ${table.time_started} IS NOT NULL AND ${table.time_ended} IS NULL AND ${table.manifest_digest} IS NULL AND ${table.error_code} IS NULL AND ${table.error_message} IS NULL) OR (${table.status} = 'ended' AND ${table.lease_owner} IS NULL AND ${table.time_started} IS NOT NULL AND ${table.time_ended} IS NOT NULL AND ${table.manifest_digest} IS NOT NULL AND ${table.error_code} IS NULL AND ${table.error_message} IS NULL) OR (${table.status} = 'failed' AND ${table.lease_owner} IS NULL AND ${table.time_ended} IS NOT NULL AND ${table.manifest_digest} IS NULL AND ${table.error_code} IS NOT NULL)`,
    ),
    check(
      "session_compaction_job_time_check",
      sql`${nonnegativeInteger(table.time_created)} AND ${optionalNonnegativeInteger(table.time_started)} AND ${optionalNonnegativeInteger(table.time_ended)}`,
    ),
  ],
)

export const SessionTodoStateTable = sqliteTable(
  "session_todo_state",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    digest: text().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    check("session_todo_state_revision_check", nonnegativeInteger(table.revision)),
    check("session_todo_state_digest_check", digest(table.digest)),
    check("session_todo_state_time_check", nonnegativeInteger(table.time_updated)),
  ],
)

export const SessionProviderContinuationGenerationTable = sqliteTable(
  "session_provider_continuation_generation",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    context_revision: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    foreignKey({
      name: "session_provider_continuation_generation_revision_fk",
      columns: [table.session_id, table.context_revision],
      foreignColumns: [SessionContextRevisionTable.session_id, SessionContextRevisionTable.revision],
    }).onDelete("cascade"),
    check("session_provider_continuation_generation_counts_check", sql`${nonnegativeInteger(table.generation)}`),
    check(
      "session_provider_continuation_generation_revision_check",
      sql`${nonnegativeInteger(table.context_revision)}`,
    ),
    check("session_provider_continuation_generation_time_check", nonnegativeInteger(table.time_updated)),
  ],
)

export const SessionProviderContinuationTable = sqliteTable(
  "session_provider_continuation",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    response_id: text().notNull(),
    represented_through_message_id: text().$type<SessionMessage.ID>(),
    represented_message_count: integer().notNull(),
    context_revision: integer().notNull(),
    continuation_generation: integer().notNull(),
    provider: text().notNull(),
    route_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    connection_identity_digest: text().notNull(),
    prompt_cache_key: text().notNull(),
    instructions_digest: text().notNull(),
    tools_digest: text().notNull(),
    options_digest: text().notNull(),
    volatile_context_digest: text().notNull(),
    continuation_fingerprint: text().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    foreignKey({
      name: "session_provider_continuation_revision_fk",
      columns: [table.session_id, table.context_revision],
      foreignColumns: [SessionContextRevisionTable.session_id, SessionContextRevisionTable.revision],
    }).onDelete("cascade"),
    check("session_provider_continuation_response_check", nonempty(table.response_id)),
    check(
      "session_provider_continuation_boundary_check",
      sql`(${table.represented_message_count} = 0 AND ${table.represented_through_message_id} IS NULL) OR (${table.represented_message_count} > 0 AND ${nonempty(table.represented_through_message_id)})`,
    ),
    check(
      "session_provider_continuation_counts_check",
      sql`${nonnegativeInteger(table.represented_message_count)} AND ${nonnegativeInteger(table.context_revision)} AND ${nonnegativeInteger(table.continuation_generation)}`,
    ),
    check(
      "session_provider_continuation_identity_check",
      sql`${nonempty(table.provider)} AND ${nonempty(table.route_id)} AND ${nonempty(table.model_id)} AND ${optionalNonempty(table.variant)} AND ${nonempty(table.prompt_cache_key)}`,
    ),
    check(
      "session_provider_continuation_digest_check",
      sql`${digest(table.connection_identity_digest)} AND ${digest(table.instructions_digest)} AND ${digest(table.tools_digest)} AND ${digest(table.options_digest)} AND ${digest(table.volatile_context_digest)} AND ${digest(table.continuation_fingerprint)}`,
    ),
    check("session_provider_continuation_time_check", nonnegativeInteger(table.time_updated)),
  ],
)

export const SessionProviderStateBlobTable = sqliteTable(
  "session_provider_state_blob",
  {
    digest: text().primaryKey(),
    provider: text().notNull(),
    model_id: text().notNull(),
    item_type: text().notNull(),
    content: text({ mode: "json" }).$type<Schema.Json>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    check("session_provider_state_blob_digest_check", digest(table.digest)),
    check(
      "session_provider_state_blob_identity_check",
      sql`${nonempty(table.provider)} AND ${nonempty(table.model_id)} AND ${nonempty(table.item_type)}`,
    ),
    check("session_provider_state_blob_content_check", sql`json_valid(${table.content})`),
    check("session_provider_state_blob_time_check", nonnegativeInteger(table.time_created)),
  ],
)

export const SessionProviderStateLinkTable = sqliteTable(
  "session_provider_state_link",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    message_id: text().$type<SessionMessage.ID>().notNull(),
    part_ordinal: integer().notNull(),
    part_kind: text().notNull(),
    provider: text().notNull(),
    model_id: text().notNull(),
    blob_digest: text()
      .notNull()
      .references(() => SessionProviderStateBlobTable.digest, { onDelete: "restrict" }),
    context_revision: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.message_id, table.part_ordinal, table.part_kind] }),
    foreignKey({
      name: "session_provider_state_link_revision_fk",
      columns: [table.session_id, table.context_revision],
      foreignColumns: [SessionContextRevisionTable.session_id, SessionContextRevisionTable.revision],
    }).onDelete("cascade"),
    index("session_provider_state_link_blob_idx").on(table.blob_digest),
    index("session_provider_state_link_revision_idx").on(table.session_id, table.context_revision),
    check("session_provider_state_link_message_check", nonempty(table.message_id)),
    check("session_provider_state_link_ordinal_check", nonnegativeInteger(table.part_ordinal)),
    check(
      "session_provider_state_link_identity_check",
      sql`${nonempty(table.part_kind)} AND ${nonempty(table.provider)} AND ${nonempty(table.model_id)}`,
    ),
    check("session_provider_state_link_blob_check", digest(table.blob_digest)),
    check("session_provider_state_link_revision_check", nonnegativeInteger(table.context_revision)),
    check("session_provider_state_link_time_check", nonnegativeInteger(table.time_created)),
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
