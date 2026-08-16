import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Agent } from "@ycoding-ai/schema/agent"
import { Project } from "@ycoding-ai/schema/project"
import { Session } from "@ycoding-ai/schema/session"
import { sql } from "drizzle-orm"
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql"

const prefixedID = (column: AnySQLiteColumn, prefix: string) =>
  sql`length(${column}) BETWEEN 5 AND 64 AND substr(${column}, 1, 4) = ${sql.raw(`'${prefix}_'`)} AND substr(${column}, 5) NOT GLOB '*[^a-z0-9-]*' AND substr(${column}, 5, 1) GLOB '[a-z0-9]' AND substr(${column}, -1, 1) GLOB '[a-z0-9]'`

const artifactID = (column: AnySQLiteColumn) =>
  sql`length(${column}) BETWEEN 1 AND 64 AND ${column} NOT GLOB '*[^a-z0-9-]*' AND substr(${column}, 1, 1) GLOB '[a-z0-9]' AND substr(${column}, -1, 1) GLOB '[a-z0-9]' AND ${column} NOT IN ('aux', 'clock$', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'con', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9', 'nul', 'prn')`

const digest = (column: AnySQLiteColumn) => sql`length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`

const optionalDigest = (column: AnySQLiteColumn) => sql`(${column} IS NULL OR (${digest(column)}))`

const nonnegativeInteger = (column: AnySQLiteColumn) => sql`typeof(${column}) = 'integer' AND ${column} >= 0`

const optionalNonnegativeInteger = (column: AnySQLiteColumn) =>
  sql`(${column} IS NULL OR (${nonnegativeInteger(column)}))`

const booleanInteger = (column: AnySQLiteColumn) => sql`typeof(${column}) = 'integer' AND ${column} IN (0, 1)`

const optionalSessionID = (column: AnySQLiteColumn) =>
  sql`(${column} IS NULL OR (length(${column}) >= 3 AND substr(${column}, 1, 3) = 'ses'))`

const optionalNonEmpty = (column: AnySQLiteColumn) => sql`(${column} IS NULL OR length(${column}) > 0)`

const optionalPrefixedID = (column: AnySQLiteColumn, prefix: string) =>
  sql`(${column} IS NULL OR (${prefixedID(column, prefix)}))`

function projectArtifactOwnerColumns(): [
  AnySQLiteColumn<{ tableName: "project_artifact" }>,
  AnySQLiteColumn<{ tableName: "project_artifact" }>,
  AnySQLiteColumn<{ tableName: "project_artifact" }>,
] {
  return [ProjectArtifactTable.scope_id, ProjectArtifactTable.kind, ProjectArtifactTable.artifact_id]
}

function projectArtifactVersionOwnerColumns(): [
  AnySQLiteColumn<{ tableName: "project_artifact_version" }>,
  AnySQLiteColumn<{ tableName: "project_artifact_version" }>,
  AnySQLiteColumn<{ tableName: "project_artifact_version" }>,
  AnySQLiteColumn<{ tableName: "project_artifact_version" }>,
] {
  return [
    ProjectArtifactVersionTable.id,
    ProjectArtifactVersionTable.scope_id,
    ProjectArtifactVersionTable.kind,
    ProjectArtifactVersionTable.artifact_id,
  ]
}

function projectArtifactVersionDigestOwnerColumns(): [
  AnySQLiteColumn<{ tableName: "project_artifact_version" }>,
  AnySQLiteColumn<{ tableName: "project_artifact_version" }>,
  AnySQLiteColumn<{ tableName: "project_artifact_version" }>,
  AnySQLiteColumn<{ tableName: "project_artifact_version" }>,
  AnySQLiteColumn<{ tableName: "project_artifact_version" }>,
] {
  return [
    ProjectArtifactVersionTable.id,
    ProjectArtifactVersionTable.scope_id,
    ProjectArtifactVersionTable.kind,
    ProjectArtifactVersionTable.artifact_id,
    ProjectArtifactVersionTable.content_digest,
  ]
}

export const ProjectArtifactScopeTable = sqliteTable(
  "project_artifact_scope",
  {
    id: text().$type<ProjectArtifact.ScopeID>().primaryKey(),
    type: text().$type<ProjectArtifact.Scope["type"]>().notNull(),
    storage_id: text().$type<ProjectArtifact.StorageID>().notNull(),
    time_created: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
    time_updated: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
  },
  (table) => [
    unique("project_artifact_scope_id_type_unique").on(table.id, table.type),
    uniqueIndex("project_artifact_scope_storage_id_idx").on(table.storage_id),
    check("project_artifact_scope_type_check", sql`${table.type} IN ('project', 'global')`),
    check(
      "project_artifact_scope_storage_id_check",
      sql`length(${table.storage_id}) = 36 AND ${table.storage_id} = lower(${table.storage_id}) AND ${table.storage_id} NOT GLOB '*[^0-9a-f-]*' AND length(${table.storage_id}) - length(replace(${table.storage_id}, '-', '')) = 4 AND substr(${table.storage_id}, 9, 1) = '-' AND substr(${table.storage_id}, 14, 1) = '-' AND substr(${table.storage_id}, 19, 1) = '-' AND substr(${table.storage_id}, 24, 1) = '-'`,
    ),
    check("project_artifact_scope_id_check", prefixedID(table.id, "pas")),
    check(
      "project_artifact_scope_time_check",
      sql`${nonnegativeInteger(table.time_created)} AND ${nonnegativeInteger(table.time_updated)}`,
    ),
  ],
)

export const ProjectArtifactProjectScopeTable = sqliteTable(
  "project_artifact_project_scope",
  {
    scope_id: text().$type<ProjectArtifact.ScopeID>().primaryKey(),
    scope_type: text()
      .$type<"project">()
      .generatedAlwaysAs(sql`'project'`),
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "restrict" }),
  },
  (table) => [
    foreignKey({
      name: "project_artifact_project_scope_parent_fk",
      columns: [table.scope_id, table.scope_type],
      foreignColumns: [ProjectArtifactScopeTable.id, ProjectArtifactScopeTable.type],
    }).onDelete("cascade"),
    uniqueIndex("project_artifact_project_scope_project_id_idx").on(table.project_id),
  ],
)

export const ProjectArtifactGlobalScopeTable = sqliteTable(
  "project_artifact_global_scope",
  {
    scope_id: text().$type<ProjectArtifact.ScopeID>().primaryKey(),
    scope_type: text()
      .$type<"global">()
      .generatedAlwaysAs(sql`'global'`),
    singleton: integer().notNull(),
  },
  (table) => [
    foreignKey({
      name: "project_artifact_global_scope_parent_fk",
      columns: [table.scope_id, table.scope_type],
      foreignColumns: [ProjectArtifactScopeTable.id, ProjectArtifactScopeTable.type],
    }).onDelete("cascade"),
    uniqueIndex("project_artifact_global_scope_singleton_idx").on(table.singleton),
    check("project_artifact_global_scope_singleton_check", sql`${table.singleton} = 1`),
  ],
)

export const ProjectArtifactTable = sqliteTable(
  "project_artifact",
  {
    scope_id: text()
      .$type<ProjectArtifact.ScopeID>()
      .notNull()
      .references(() => ProjectArtifactScopeTable.id, { onDelete: "cascade" }),
    kind: text().$type<ProjectArtifact.Kind>().notNull(),
    artifact_id: text().$type<ProjectArtifact.ID>().notNull(),
    revision: integer().$type<ProjectArtifact.Revision>().notNull(),
    stage: text().$type<ProjectArtifact.Stage>().notNull(),
    current_version_id: text().$type<ProjectArtifact.VersionID>().notNull(),
    fallback_version_id: text().$type<ProjectArtifact.VersionID>(),
    shadowed_scope_id: text()
      .$type<ProjectArtifact.ScopeID>()
      .references(() => ProjectArtifactScopeTable.id, { onDelete: "restrict" }),
    last_used_at: integer().$type<ProjectArtifact.TimestampMillis>(),
    time_created: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
    time_updated: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.kind, table.artifact_id] }),
    foreignKey({
      name: "project_artifact_current_version_owner_fk",
      columns: [table.current_version_id, table.scope_id, table.kind, table.artifact_id],
      foreignColumns: projectArtifactVersionOwnerColumns(),
    }),
    foreignKey({
      name: "project_artifact_fallback_version_owner_fk",
      columns: [table.fallback_version_id, table.scope_id, table.kind, table.artifact_id],
      foreignColumns: projectArtifactVersionOwnerColumns(),
    }),
    index("project_artifact_scope_stage_kind_updated_idx").on(
      table.scope_id,
      table.stage,
      table.kind,
      table.time_updated,
      table.artifact_id,
    ),
    check("project_artifact_id_check", artifactID(table.artifact_id)),
    check("project_artifact_revision_check", nonnegativeInteger(table.revision)),
    check("project_artifact_kind_check", sql`${table.kind} IN ('skill', 'command', 'agent', 'plugin')`),
    check(
      "project_artifact_stage_check",
      sql`${table.stage} IN ('trial', 'active', 'degraded', 'disabled', 'quarantine')`,
    ),
    check(
      "project_artifact_time_check",
      sql`${optionalNonnegativeInteger(table.last_used_at)} AND ${nonnegativeInteger(table.time_created)} AND ${nonnegativeInteger(table.time_updated)}`,
    ),
  ],
)

export const ProjectArtifactVersionTable = sqliteTable(
  "project_artifact_version",
  {
    id: text().$type<ProjectArtifact.VersionID>().primaryKey(),
    scope_id: text().$type<ProjectArtifact.ScopeID>().notNull(),
    kind: text().$type<ProjectArtifact.Kind>().notNull(),
    artifact_id: text().$type<ProjectArtifact.ID>().notNull(),
    parent_version_id: text().$type<ProjectArtifact.VersionID>(),
    state: text().$type<ProjectArtifact.VersionState>().notNull(),
    content_digest: text().$type<ProjectArtifact.Digest>().notNull(),
    content_relpath: text().$type<ProjectArtifact.ContentRelpath>().notNull(),
    source: text().$type<ProjectArtifact.Source>().notNull(),
    creator_agent_id: text().$type<Agent.ID>(),
    creator_session_id: text().$type<Session.ID>(),
    insight_digest: text().$type<ProjectArtifact.Digest>(),
    origin_scope_id: text().$type<ProjectArtifact.ScopeID>(),
    origin_version_id: text().$type<ProjectArtifact.VersionID>(),
    origin_evidence_digest: text().$type<ProjectArtifact.Digest>(),
    first_qualified_at: integer().$type<ProjectArtifact.TimestampMillis>(),
    last_evaluated_at: integer().$type<ProjectArtifact.TimestampMillis>(),
    last_restored_at: integer().$type<ProjectArtifact.TimestampMillis>(),
    last_governor_transition_at: integer().$type<ProjectArtifact.TimestampMillis>(),
    time_created: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
    time_state_changed: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
  },
  (table) => [
    unique("project_artifact_version_owner_unique").on(table.id, table.scope_id, table.kind, table.artifact_id),
    unique("project_artifact_version_digest_owner_unique").on(
      table.id,
      table.scope_id,
      table.kind,
      table.artifact_id,
      table.content_digest,
    ),
    unique("project_artifact_version_write_unique").on(table.id, table.scope_id, table.content_digest),
    foreignKey({
      columns: [table.scope_id, table.kind, table.artifact_id],
      foreignColumns: projectArtifactOwnerColumns(),
    }).onDelete("cascade"),
    foreignKey({
      name: "project_artifact_version_parent_owner_fk",
      columns: [table.parent_version_id, table.scope_id, table.kind, table.artifact_id],
      foreignColumns: [table.id, table.scope_id, table.kind, table.artifact_id],
    }),
    foreignKey({
      name: "project_artifact_version_origin_owner_fk",
      columns: [table.origin_version_id, table.origin_scope_id, table.kind, table.artifact_id],
      foreignColumns: [table.id, table.scope_id, table.kind, table.artifact_id],
    }),
    uniqueIndex("project_artifact_version_scope_kind_id_digest_idx").on(
      table.scope_id,
      table.kind,
      table.artifact_id,
      table.content_digest,
    ),
    index("project_artifact_version_scope_kind_id_created_idx").on(
      table.scope_id,
      table.kind,
      table.artifact_id,
      table.time_created,
    ),
    check("project_artifact_version_id_check", prefixedID(table.id, "pav")),
    check(
      "project_artifact_version_state_check",
      sql`${table.state} IN ('trial', 'active', 'degraded', 'disabled', 'quarantine', 'superseded')`,
    ),
    check("project_artifact_version_digest_check", digest(table.content_digest)),
    check(
      "project_artifact_version_optional_digest_check",
      sql`${optionalDigest(table.insight_digest)} AND ${optionalDigest(table.origin_evidence_digest)}`,
    ),
    check(
      "project_artifact_version_relpath_check",
      sql`length(${table.content_relpath}) > 0 AND substr(${table.content_relpath}, 1, 1) GLOB '[A-Za-z0-9]' AND substr(${table.content_relpath}, -1, 1) <> '/' AND ${table.content_relpath} NOT GLOB '*[^A-Za-z0-9._/-]*' AND ${table.content_relpath} NOT GLOB '*//*' AND ${table.content_relpath} NOT GLOB '*/./*' AND ${table.content_relpath} NOT GLOB '*/.' AND ${table.content_relpath} NOT GLOB '*/../*' AND ${table.content_relpath} NOT GLOB '*/..'`,
    ),
    check(
      "project_artifact_version_source_check",
      sql`${table.source} IN ('agent', 'user', 'promotion', 'fork', 'restore')`,
    ),
    check("project_artifact_version_session_check", optionalSessionID(table.creator_session_id)),
    check(
      "project_artifact_version_origin_check",
      sql`(${table.source} IN ('promotion', 'fork') AND ${table.origin_scope_id} IS NOT NULL AND ${table.origin_version_id} IS NOT NULL AND ${table.origin_evidence_digest} IS NOT NULL) OR (${table.source} IN ('agent', 'user', 'restore') AND ${table.origin_scope_id} IS NULL AND ${table.origin_version_id} IS NULL AND ${table.origin_evidence_digest} IS NULL)`,
    ),
    check(
      "project_artifact_version_time_check",
      sql`${optionalNonnegativeInteger(table.first_qualified_at)} AND ${optionalNonnegativeInteger(table.last_evaluated_at)} AND ${optionalNonnegativeInteger(table.last_restored_at)} AND ${optionalNonnegativeInteger(table.last_governor_transition_at)} AND ${nonnegativeInteger(table.time_created)} AND ${nonnegativeInteger(table.time_state_changed)}`,
    ),
  ],
)

export const ProjectArtifactTrashTable = sqliteTable(
  "project_artifact_trash",
  {
    deletion_id: text().$type<ProjectArtifact.DeletionID>().primaryKey(),
    scope_id: text().$type<ProjectArtifact.ScopeID>().notNull(),
    kind: text().$type<ProjectArtifact.Kind>().notNull(),
    artifact_id: text().$type<ProjectArtifact.ID>().notNull(),
    prior_stage: text().$type<ProjectArtifact.Stage>().notNull(),
    prior_version_id: text().$type<ProjectArtifact.VersionID>().notNull(),
    deleted_at: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
    purge_after: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.scope_id, table.kind, table.artifact_id],
      foreignColumns: [ProjectArtifactTable.scope_id, ProjectArtifactTable.kind, ProjectArtifactTable.artifact_id],
    }).onDelete("cascade"),
    foreignKey({
      name: "project_artifact_trash_prior_version_owner_fk",
      columns: [table.prior_version_id, table.scope_id, table.kind, table.artifact_id],
      foreignColumns: [
        ProjectArtifactVersionTable.id,
        ProjectArtifactVersionTable.scope_id,
        ProjectArtifactVersionTable.kind,
        ProjectArtifactVersionTable.artifact_id,
      ],
    }),
    uniqueIndex("project_artifact_trash_scope_kind_id_idx").on(table.scope_id, table.kind, table.artifact_id),
    index("project_artifact_trash_purge_after_idx").on(table.purge_after),
    check("project_artifact_trash_id_check", prefixedID(table.deletion_id, "pad")),
    check(
      "project_artifact_trash_stage_check",
      sql`${table.prior_stage} IN ('trial', 'active', 'degraded', 'disabled', 'quarantine')`,
    ),
    check(
      "project_artifact_trash_time_check",
      sql`${nonnegativeInteger(table.deleted_at)} AND ${nonnegativeInteger(table.purge_after)}`,
    ),
    check("project_artifact_trash_expiry_check", sql`${table.purge_after} = ${table.deleted_at} + 2592000000`),
  ],
)

export type ProjectArtifactOperation =
  | "create"
  | "update"
  | "promotion"
  | "fork"
  | "shadow"
  | "remove"
  | "restore"
  | "disable"
  | "enable"
  | "revert"
  | "purge"

export type ProjectArtifactOperationPhase = "preparing" | "available" | "finalized" | "aborted"

export const ProjectArtifactOperationTable = sqliteTable(
  "project_artifact_operation",
  {
    id: text().primaryKey(),
    scope_id: text()
      .$type<ProjectArtifact.ScopeID>()
      .notNull()
      .references(() => ProjectArtifactScopeTable.id, { onDelete: "cascade" }),
    kind: text().$type<ProjectArtifact.Kind>().notNull(),
    artifact_id: text().$type<ProjectArtifact.ID>().notNull(),
    operation: text().$type<ProjectArtifactOperation>().notNull(),
    request_fingerprint: text().$type<ProjectArtifact.Digest>().notNull(),
    expected_revision: integer().$type<ProjectArtifact.Revision>(),
    expected_version_id: text().$type<ProjectArtifact.VersionID>(),
    expected_digest: text().$type<ProjectArtifact.Digest>(),
    source_scope_id: text().$type<ProjectArtifact.ScopeID>(),
    source_version_id: text().$type<ProjectArtifact.VersionID>(),
    source_digest: text().$type<ProjectArtifact.Digest>(),
    target_version_id: text().$type<ProjectArtifact.VersionID>(),
    target_digest: text().$type<ProjectArtifact.Digest>(),
    final_version_id: text().$type<ProjectArtifact.VersionID>(),
    deletion_id: text().$type<ProjectArtifact.DeletionID>(),
    automatic_session_id: text().$type<Session.ID>(),
    automatic_insight_digest: text().$type<ProjectArtifact.Digest>(),
    phase: text().$type<ProjectArtifactOperationPhase>().notNull(),
    time_created: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
    time_updated: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
  },
  (table) => [
    foreignKey({
      name: "project_artifact_operation_expected_owner_fk",
      columns: [table.expected_version_id, table.scope_id, table.kind, table.artifact_id, table.expected_digest],
      foreignColumns: projectArtifactVersionDigestOwnerColumns(),
    }).onDelete("restrict"),
    foreignKey({
      name: "project_artifact_operation_source_owner_fk",
      columns: [table.source_version_id, table.source_scope_id, table.kind, table.artifact_id, table.source_digest],
      foreignColumns: projectArtifactVersionDigestOwnerColumns(),
    }).onDelete("restrict"),
    foreignKey({
      name: "project_artifact_operation_final_owner_fk",
      columns: [table.final_version_id, table.scope_id, table.kind, table.artifact_id, table.target_digest],
      foreignColumns: projectArtifactVersionDigestOwnerColumns(),
    }).onDelete("restrict"),
    uniqueIndex("project_artifact_operation_request_idx").on(table.scope_id, table.request_fingerprint),
    uniqueIndex("project_artifact_operation_automatic_retry_idx")
      .on(table.scope_id, table.automatic_session_id, table.automatic_insight_digest)
      .where(sql`${table.automatic_session_id} IS NOT NULL AND ${table.automatic_insight_digest} IS NOT NULL`),
    uniqueIndex("project_artifact_operation_active_artifact_idx")
      .on(table.scope_id, table.kind, table.artifact_id)
      .where(sql`${table.phase} IN ('preparing', 'available')`),
    index("project_artifact_operation_recovery_idx").on(table.phase, table.time_updated, table.id),
    check("project_artifact_operation_id_check", prefixedID(table.id, "pop")),
    check("project_artifact_operation_artifact_id_check", artifactID(table.artifact_id)),
    check("project_artifact_operation_kind_check", sql`${table.kind} IN ('skill', 'command', 'agent', 'plugin')`),
    check(
      "project_artifact_operation_operation_check",
      sql`${table.operation} IN ('create', 'update', 'promotion', 'fork', 'shadow', 'remove', 'restore', 'disable', 'enable', 'revert', 'purge')`,
    ),
    check(
      "project_artifact_operation_phase_check",
      sql`${table.phase} IN ('preparing', 'available', 'finalized', 'aborted')`,
    ),
    check(
      "project_artifact_operation_digest_check",
      sql`${digest(table.request_fingerprint)} AND ${optionalDigest(table.expected_digest)} AND ${optionalDigest(table.source_digest)} AND ${optionalDigest(table.target_digest)} AND ${optionalDigest(table.automatic_insight_digest)}`,
    ),
    check(
      "project_artifact_operation_version_id_check",
      sql`${optionalPrefixedID(table.expected_version_id, "pav")} AND ${optionalPrefixedID(table.source_version_id, "pav")} AND ${optionalPrefixedID(table.target_version_id, "pav")} AND ${optionalPrefixedID(table.final_version_id, "pav")}`,
    ),
    check("project_artifact_operation_deletion_id_check", optionalPrefixedID(table.deletion_id, "pad")),
    check("project_artifact_operation_session_check", optionalSessionID(table.automatic_session_id)),
    check(
      "project_artifact_operation_expectation_check",
      sql`(${table.expected_revision} IS NULL AND ${table.expected_version_id} IS NULL AND ${table.expected_digest} IS NULL) OR (${table.expected_revision} IS NOT NULL AND ${table.expected_version_id} IS NOT NULL AND ${table.expected_digest} IS NOT NULL)`,
    ),
    check(
      "project_artifact_operation_source_check",
      sql`(${table.operation} IN ('promotion', 'fork', 'shadow') AND ${table.source_scope_id} IS NOT NULL AND ${table.source_version_id} IS NOT NULL AND ${table.source_digest} IS NOT NULL) OR (${table.operation} NOT IN ('promotion', 'fork', 'shadow') AND ${table.source_scope_id} IS NULL AND ${table.source_version_id} IS NULL AND ${table.source_digest} IS NULL)`,
    ),
    check(
      "project_artifact_operation_target_check",
      sql`(${table.target_version_id} IS NULL AND ${table.target_digest} IS NULL) OR (${table.target_version_id} IS NOT NULL AND ${table.target_digest} IS NOT NULL)`,
    ),
    check(
      "project_artifact_operation_automatic_check",
      sql`(${table.automatic_session_id} IS NULL AND ${table.automatic_insight_digest} IS NULL) OR (${table.automatic_session_id} IS NOT NULL AND ${table.automatic_insight_digest} IS NOT NULL)`,
    ),
    check(
      "project_artifact_operation_finalization_check",
      sql`(${table.phase} <> 'finalized' AND ${table.final_version_id} IS NULL) OR (${table.phase} = 'finalized' AND ((${table.operation} IN ('remove', 'purge') AND ${table.final_version_id} IS NULL) OR (${table.operation} NOT IN ('remove', 'purge') AND ${table.final_version_id} IS NOT NULL AND ${table.target_version_id} IS NOT NULL AND ${table.target_digest} IS NOT NULL AND ${table.target_version_id} = ${table.final_version_id})))`,
    ),
    check(
      "project_artifact_operation_final_target_check",
      sql`${table.target_version_id} IS NULL OR ${table.final_version_id} IS NULL OR ${table.target_version_id} = ${table.final_version_id}`,
    ),
    check(
      "project_artifact_operation_deletion_check",
      sql`(${table.operation} IN ('remove', 'restore', 'purge') AND ${table.deletion_id} IS NOT NULL) OR (${table.operation} NOT IN ('remove', 'restore', 'purge') AND ${table.deletion_id} IS NULL)`,
    ),
    check(
      "project_artifact_operation_time_check",
      sql`${optionalNonnegativeInteger(table.expected_revision)} AND ${nonnegativeInteger(table.time_created)} AND ${nonnegativeInteger(table.time_updated)} AND ${table.time_updated} >= ${table.time_created}`,
    ),
  ],
)

export const ProjectArtifactActivationTable = sqliteTable(
  "project_artifact_activation",
  {
    id: text().$type<ProjectArtifact.ActivationID>().primaryKey(),
    scope_id: text().$type<ProjectArtifact.ScopeID>().notNull(),
    kind: text().$type<ProjectArtifact.Kind>().notNull(),
    artifact_id: text().$type<ProjectArtifact.ID>().notNull(),
    version_id: text().$type<ProjectArtifact.VersionID>().notNull(),
    project_id: text().$type<Project.ID>(),
    session_id: text().$type<Session.ID>(),
    agent_id: text().$type<Agent.ID>(),
    source: text().$type<ProjectArtifact.ActivationSource>().notNull(),
    message_id: text(),
    call_id: text(),
    boundary_seq: integer().$type<ProjectArtifact.Revision>().notNull(),
    activated_at: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
    deactivated_at: integer().$type<ProjectArtifact.TimestampMillis>(),
  },
  (table) => [
    foreignKey({
      name: "project_artifact_activation_version_owner_fk",
      columns: [table.version_id, table.scope_id, table.kind, table.artifact_id],
      foreignColumns: [
        ProjectArtifactVersionTable.id,
        ProjectArtifactVersionTable.scope_id,
        ProjectArtifactVersionTable.kind,
        ProjectArtifactVersionTable.artifact_id,
      ],
    }).onDelete("cascade"),
    uniqueIndex("project_artifact_activation_identity_idx")
      .on(table.session_id, table.version_id, table.source, table.boundary_seq)
      .where(sql`${table.session_id} IS NOT NULL`),
    uniqueIndex("project_artifact_activation_sessionless_identity_idx")
      .on(table.version_id, table.source, table.boundary_seq)
      .where(sql`${table.session_id} IS NULL`),
    index("project_artifact_activation_session_open_idx").on(table.session_id, table.deactivated_at),
    check("project_artifact_activation_id_check", prefixedID(table.id, "paa")),
    check(
      "project_artifact_activation_source_check",
      sql`${table.source} IN ('skill-tool', 'session-skill', 'command', 'agent-selected', 'subagent-launch', 'manual')`,
    ),
    check("project_artifact_activation_session_check", optionalSessionID(table.session_id)),
    check(
      "project_artifact_activation_optional_id_check",
      sql`${optionalNonEmpty(table.message_id)} AND ${optionalNonEmpty(table.call_id)}`,
    ),
    check(
      "project_artifact_activation_number_check",
      sql`${nonnegativeInteger(table.boundary_seq)} AND ${nonnegativeInteger(table.activated_at)} AND ${optionalNonnegativeInteger(table.deactivated_at)}`,
    ),
  ],
)

export const ProjectArtifactObservationTable = sqliteTable(
  "project_artifact_observation",
  {
    id: text().$type<ProjectArtifact.ObservationID>().primaryKey(),
    scope_id: text().$type<ProjectArtifact.ScopeID>().notNull(),
    kind: text().$type<ProjectArtifact.Kind>().notNull(),
    artifact_id: text().$type<ProjectArtifact.ID>().notNull(),
    version_id: text().$type<ProjectArtifact.VersionID>().notNull(),
    project_id: text().$type<Project.ID>(),
    session_id: text().$type<Session.ID>(),
    activation_set_digest: text().$type<ProjectArtifact.Digest>().notNull(),
    active_artifact_count: integer().$type<ProjectArtifact.Revision>().notNull(),
    external_confounded: integer({ mode: "boolean" }).notNull(),
    eligible: integer({ mode: "boolean" }).notNull(),
    terminal_outcome: text().$type<ProjectArtifact.TerminalOutcome>().notNull(),
    goal_status: text().$type<ProjectArtifact.GoalStatus>().notNull(),
    repeat_fix: integer({ mode: "boolean" }).notNull(),
    latency_ms: integer().$type<ProjectArtifact.TimestampMillis>(),
    input_tokens: integer().$type<ProjectArtifact.Revision>(),
    output_tokens: integer().$type<ProjectArtifact.Revision>(),
    cache_read_tokens: integer().$type<ProjectArtifact.Revision>(),
    completed_tool_count: integer().$type<ProjectArtifact.Revision>(),
    failed_tool_count: integer().$type<ProjectArtifact.Revision>(),
    terminal_message_id: text(),
    observed_at: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
  },
  (table) => [
    foreignKey({
      name: "project_artifact_observation_version_owner_fk",
      columns: [table.version_id, table.scope_id, table.kind, table.artifact_id],
      foreignColumns: [
        ProjectArtifactVersionTable.id,
        ProjectArtifactVersionTable.scope_id,
        ProjectArtifactVersionTable.kind,
        ProjectArtifactVersionTable.artifact_id,
      ],
    }).onDelete("cascade"),
    uniqueIndex("project_artifact_observation_version_terminal_idx")
      .on(table.version_id, table.terminal_message_id)
      .where(sql`${table.terminal_message_id} IS NOT NULL`),
    uniqueIndex("project_artifact_observation_version_session_absent_idx")
      .on(table.version_id, table.session_id)
      .where(sql`${table.terminal_message_id} IS NULL`),
    // SQLite treats NULL as distinct in unique indexes, so sessionless rows need their own key.
    uniqueIndex("project_artifact_observation_sessionless_absent_idx")
      .on(table.version_id)
      .where(sql`${table.terminal_message_id} IS NULL AND ${table.session_id} IS NULL`),
    index("project_artifact_observation_version_eligible_observed_idx").on(
      table.version_id,
      table.eligible,
      table.observed_at,
    ),
    check("project_artifact_observation_id_check", prefixedID(table.id, "pao")),
    check("project_artifact_observation_digest_check", digest(table.activation_set_digest)),
    check(
      "project_artifact_observation_terminal_check",
      sql`${table.terminal_outcome} IN ('succeeded', 'failed', 'interrupted')`,
    ),
    check(
      "project_artifact_observation_goal_check",
      sql`${table.goal_status} IN ('none', 'completed', 'stopped', 'exhausted')`,
    ),
    check("project_artifact_observation_session_check", optionalSessionID(table.session_id)),
    check("project_artifact_observation_message_check", optionalNonEmpty(table.terminal_message_id)),
    check(
      "project_artifact_observation_boolean_check",
      sql`${booleanInteger(table.external_confounded)} AND ${booleanInteger(table.eligible)} AND ${booleanInteger(table.repeat_fix)}`,
    ),
    check(
      "project_artifact_observation_number_check",
      sql`${nonnegativeInteger(table.active_artifact_count)} AND ${optionalNonnegativeInteger(table.latency_ms)} AND ${optionalNonnegativeInteger(table.input_tokens)} AND ${optionalNonnegativeInteger(table.output_tokens)} AND ${optionalNonnegativeInteger(table.cache_read_tokens)} AND ${optionalNonnegativeInteger(table.completed_tool_count)} AND ${optionalNonnegativeInteger(table.failed_tool_count)} AND ${nonnegativeInteger(table.observed_at)}`,
    ),
  ],
)

export const ProjectArtifactTerminalTable = sqliteTable(
  "project_artifact_terminal",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text().$type<Session.ID>().notNull(),
    terminal_message_id: text(),
    boundary_seq: integer().$type<ProjectArtifact.Revision>().notNull(),
    kind: text().$type<ProjectArtifact.Kind>().notNull(),
    agent_id: text().$type<Agent.ID>(),
    model_id: text().notNull(),
    goal_mode: integer({ mode: "boolean" }).notNull(),
    managed_activation_count: integer().$type<ProjectArtifact.Revision>().notNull(),
    standard_invocation_count: integer().$type<ProjectArtifact.Revision>().notNull(),
    external_confounded: integer({ mode: "boolean" }).notNull(),
    terminal_outcome: text().$type<ProjectArtifact.TerminalOutcome>().notNull(),
    goal_status: text().$type<ProjectArtifact.GoalStatus>().notNull(),
    repeat_fix: integer({ mode: "boolean" }).notNull(),
    observed_at: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
  },
  (table) => [
    uniqueIndex("project_artifact_terminal_message_identity_idx")
      .on(table.session_id, table.terminal_message_id)
      .where(sql`${table.terminal_message_id} IS NOT NULL`),
    uniqueIndex("project_artifact_terminal_boundary_identity_idx")
      .on(table.session_id, table.boundary_seq)
      .where(sql`${table.terminal_message_id} IS NULL`),
    index("project_artifact_terminal_cohort_idx").on(
      table.kind,
      table.agent_id,
      table.model_id,
      table.goal_mode,
      table.observed_at,
    ),
    check("project_artifact_terminal_id_check", prefixedID(table.id, "pat")),
    check("project_artifact_terminal_session_check", optionalSessionID(table.session_id)),
    check("project_artifact_terminal_message_check", optionalNonEmpty(table.terminal_message_id)),
    check("project_artifact_terminal_model_check", sql`length(${table.model_id}) > 0`),
    check("project_artifact_terminal_kind_check", sql`${table.kind} IN ('skill', 'command', 'agent', 'plugin')`),
    check(
      "project_artifact_terminal_outcome_check",
      sql`${table.terminal_outcome} IN ('succeeded', 'failed', 'interrupted')`,
    ),
    check(
      "project_artifact_terminal_goal_check",
      sql`${table.goal_status} IN ('none', 'completed', 'stopped', 'exhausted')`,
    ),
    check(
      "project_artifact_terminal_boolean_check",
      sql`${booleanInteger(table.goal_mode)} AND ${booleanInteger(table.external_confounded)} AND ${booleanInteger(table.repeat_fix)}`,
    ),
    check(
      "project_artifact_terminal_number_check",
      sql`${nonnegativeInteger(table.boundary_seq)} AND ${nonnegativeInteger(table.managed_activation_count)} AND ${nonnegativeInteger(table.standard_invocation_count)} AND ${nonnegativeInteger(table.observed_at)}`,
    ),
  ],
)

export const ProjectArtifactFeedbackTable = sqliteTable(
  "project_artifact_feedback",
  {
    id: text().primaryKey(),
    scope_id: text().$type<ProjectArtifact.ScopeID>().notNull(),
    kind: text().$type<ProjectArtifact.Kind>().notNull(),
    artifact_id: text().$type<ProjectArtifact.ID>().notNull(),
    version_id: text().$type<ProjectArtifact.VersionID>().notNull(),
    action: text().$type<ProjectArtifact.FeedbackAction>().notNull(),
    actor: text().$type<ProjectArtifact.FeedbackActor>().notNull(),
    time_created: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
  },
  (table) => [
    foreignKey({
      name: "project_artifact_feedback_version_owner_fk",
      columns: [table.version_id, table.scope_id, table.kind, table.artifact_id],
      foreignColumns: [
        ProjectArtifactVersionTable.id,
        ProjectArtifactVersionTable.scope_id,
        ProjectArtifactVersionTable.kind,
        ProjectArtifactVersionTable.artifact_id,
      ],
    }).onDelete("cascade"),
    index("project_artifact_feedback_version_created_idx").on(table.version_id, table.time_created),
    check("project_artifact_feedback_id_check", prefixedID(table.id, "paf")),
    check(
      "project_artifact_feedback_action_check",
      sql`${table.action} IN ('disable', 'delete', 'revert', 'restore', 'enable', 'promote')`,
    ),
    check("project_artifact_feedback_actor_check", sql`${table.actor} IN ('user', 'automatic-governor')`),
    check("project_artifact_feedback_time_check", nonnegativeInteger(table.time_created)),
  ],
)

export const ProjectArtifactWriteTable = sqliteTable(
  "project_artifact_write",
  {
    scope_id: text()
      .$type<ProjectArtifact.ScopeID>()
      .notNull()
      .references(() => ProjectArtifactScopeTable.id, { onDelete: "cascade" }),
    session_id: text().$type<Session.ID>().notNull(),
    insight_digest: text().$type<ProjectArtifact.Digest>().notNull(),
    operation: text().$type<ProjectArtifact.AutomaticWriteOperation>().notNull(),
    result: text().$type<ProjectArtifact.AutomaticWriteResult>().notNull(),
    version_id: text().$type<ProjectArtifact.VersionID>().notNull(),
    content_digest: text().$type<ProjectArtifact.Digest>().notNull(),
    time_created: integer().$type<ProjectArtifact.TimestampMillis>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope_id, table.session_id, table.insight_digest] }),
    foreignKey({
      name: "project_artifact_write_version_owner_fk",
      columns: [table.version_id, table.scope_id, table.content_digest],
      foreignColumns: [
        ProjectArtifactVersionTable.id,
        ProjectArtifactVersionTable.scope_id,
        ProjectArtifactVersionTable.content_digest,
      ],
    }).onDelete("cascade"),
    index("project_artifact_write_scope_created_idx").on(table.scope_id, table.time_created),
    index("project_artifact_write_session_created_idx").on(table.session_id, table.time_created),
    check("project_artifact_write_operation_check", sql`${table.operation} IN ('create', 'update', 'reconcile')`),
    check("project_artifact_write_result_check", sql`${table.result} IN ('created', 'updated', 'reconciled')`),
    check(
      "project_artifact_write_session_check",
      sql`length(${table.session_id}) >= 3 AND substr(${table.session_id}, 1, 3) = 'ses'`,
    ),
    check(
      "project_artifact_write_digest_check",
      sql`${digest(table.insight_digest)} AND ${digest(table.content_digest)}`,
    ),
    check("project_artifact_write_time_check", nonnegativeInteger(table.time_created)),
  ],
)

export const ProjectArtifactLegacyCleanupTable = sqliteTable(
  "project_artifact_legacy_cleanup",
  {
    id: integer().primaryKey(),
    status: text().$type<"pending" | "partial" | "complete" | "failed">().notNull(),
    cursor: text(),
    attempts: integer().notNull(),
    removed_count: integer().notNull(),
    skipped_count: integer().notNull(),
    failed_count: integer().notNull(),
    error_code: text(),
    last_attempt_at: integer().$type<ProjectArtifact.TimestampMillis>(),
    completed_at: integer().$type<ProjectArtifact.TimestampMillis>(),
  },
  (table) => [
    check("project_artifact_legacy_cleanup_singleton_check", sql`${table.id} = 1`),
    check(
      "project_artifact_legacy_cleanup_status_check",
      sql`${table.status} IN ('pending', 'partial', 'complete', 'failed')`,
    ),
    check(
      "project_artifact_legacy_cleanup_counts_check",
      sql`${nonnegativeInteger(table.attempts)} AND ${nonnegativeInteger(table.removed_count)} AND ${nonnegativeInteger(table.skipped_count)} AND ${nonnegativeInteger(table.failed_count)}`,
    ),
    check(
      "project_artifact_legacy_cleanup_time_check",
      sql`${optionalNonnegativeInteger(table.last_attempt_at)} AND ${optionalNonnegativeInteger(table.completed_at)}`,
    ),
  ],
)
